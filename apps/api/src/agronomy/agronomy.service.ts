import { generatePlantingWindows, recommendCropsForField } from "@agroclimate/agronomy";
import { assembleOutlookHorizon } from "@agroclimate/climate-core";
import type {
  Constraint,
  FieldEvaluateRequest,
  FieldRecommendations,
  FieldSnapshotPayload,
  GridRegistry,
  GridRegistryEntry,
  GrowthStage,
  IrrigationAvailability,
  PlantingWindow,
  PlantingWindowListQuery,
  SuitabilityRunWithWindows,
} from "@agroclimate/contracts";
import {
  calendarMonthOf,
  createSpatialResolution,
  fieldRecommendationsSchema,
  fieldSnapshotPayloadSchema,
  hashDerivationDescriptor,
  hashFieldSnapshot,
  suitabilityRunWithWindowsSchema,
} from "@agroclimate/contracts";
import {
  createTenantScope,
  findCultivar,
  findField,
  findLatestSuitabilityRun,
  findProfileVersion,
  listActivePlantingWindows,
  listCrops,
  listCultivars,
  listProfileVersionsForCrop,
  loadActiveOutlookMonths,
  loadFieldSnapshotSource,
  persistSuitabilityRunWithWindows,
  selectFieldAnchor,
} from "@agroclimate/database";
import type { PrismaClient, TenantScope } from "@agroclimate/database";
import { unvalidatedGridRegistry } from "@agroclimate/weather-core";
import { Inject, Injectable, Optional } from "@nestjs/common";

import { jakartaMonthOf } from "../climate/calendar.js";
import { DATABASE_CLIENT, GRID_REGISTRY } from "../tokens.js";

export const AGRONOMY_ENGINE_VERSION = "0.1.0";
export const AGRONOMY_DERIVATION_VERSION = "1";

type ObservationSourceKind = "request" | "field_profile" | "field_observation" | "climate_outlook";

interface ResolvedConstraintObservations {
  readonly observations: ReadonlyMap<string, number | null>;
  readonly sources: ReadonlyMap<string, ObservationSourceKind>;
  readonly singlePointClimateProxy: boolean;
}

function addUtcDaysIso(isoDate: string, days: number): string {
  const dt = new Date(Date.parse(`${isoDate}T00:00:00.000Z`));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function daysInUtcMonth(year: number, monthIndex0: number): number {
  return new Date(Date.UTC(year, monthIndex0 + 1, 0)).getUTCDate();
}

/**
 * Sums prorated monthly precipitation (mm) across `[windowStart, windowEnd]`.
 * Returns `null` if any covered calendar month has missing/null data so
 * missing climate data is never silently treated as zero.
 */
export function prorateOutlookRainfallMm(
  months: readonly { readonly month: string; readonly valueMm: number | null }[],
  windowStart: string,
  windowEnd: string,
): number | null {
  if (windowEnd < windowStart) return null;
  const byMonth = new Map(months.map((m) => [m.month.slice(0, 7), m.valueMm]));

  const [sy, sm, sd] = windowStart.split("-").map(Number);
  const [ey, em, ed] = windowEnd.split("-").map(Number);
  if (sy === undefined || sm === undefined || sd === undefined) return null;
  if (ey === undefined || em === undefined || ed === undefined) return null;

  let year = sy;
  let month = sm; // 1..12
  let total = 0;

  while (year < ey || (year === ey && month <= em)) {
    const ym = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
    const mm = byMonth.get(ym);
    if (mm === undefined || mm === null || !Number.isFinite(mm)) return null;

    const totalDays = daysInUtcMonth(year, month - 1);
    const startDay = year === sy && month === sm ? sd : 1;
    const endDay = year === ey && month === em ? ed : totalDays;
    const coveredDays = Math.max(0, endDay - startDay + 1);
    total += mm * (coveredDays / totalDays);

    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }

  return Number(total.toFixed(1));
}

/**
 * Resolves constraint observations per candidate without overriding explicit
 * caller inputs (including explicit `null`). Fills omitted constraints from
 * verified field agronomy profile (`soilPh`), seasonal/climatology outlook
 * (`water` in `mm`), or latest field observation (`temperature` in °C).
 * Tracks `singlePointClimateProxy` whenever climate uses a single field reading.
 */
export function resolveConstraintObservations(
  constraints: readonly Constraint[],
  explicitObservations: Readonly<Record<string, number | null>>,
  source: {
    readonly soilPh: number | null;
    readonly observationsUsed: readonly {
      readonly kind: string;
      readonly value: number;
      readonly unit: string;
    }[];
  },
  outlookRainfallMm: number | null = null,
): ResolvedConstraintObservations {
  const observations = new Map<string, number | null>();
  const sources = new Map<string, ObservationSourceKind>();
  let singlePointClimateProxy = false;

  const latestTemp = source.observationsUsed.find((obs) => {
    if (obs.kind !== "temperature") return false;
    const unit = obs.unit.trim().toLowerCase();
    return unit === "°c" || unit === "c" || unit === "celsius";
  });

  for (const constraint of constraints) {
    if (Object.prototype.hasOwnProperty.call(explicitObservations, constraint.id)) {
      observations.set(constraint.id, explicitObservations[constraint.id] ?? null);
      sources.set(constraint.id, "request");
      continue;
    }

    const unit = (constraint.unit ?? "").trim().toLowerCase();
    if (constraint.dimension === "soil" && unit === "ph" && source.soilPh !== null) {
      observations.set(constraint.id, source.soilPh);
      sources.set(constraint.id, "field_profile");
      continue;
    }

    if (constraint.dimension === "water" && unit === "mm" && outlookRainfallMm !== null) {
      observations.set(constraint.id, outlookRainfallMm);
      sources.set(constraint.id, "climate_outlook");
      continue;
    }

    if (
      constraint.dimension === "climate" &&
      (unit === "°c" || unit === "c" || unit === "celsius") &&
      latestTemp !== undefined
    ) {
      observations.set(constraint.id, latestTemp.value);
      sources.set(constraint.id, "field_observation");
      singlePointClimateProxy = true;
      continue;
    }

    observations.set(constraint.id, null);
  }

  return { observations, sources, singlePointClimateProxy };
}

export class AgronomyResourceNotFoundError extends Error {
  readonly code: "field_not_found" | "profile_not_found" | "profile_not_published";

  constructor(code: AgronomyResourceNotFoundError["code"], message: string) {
    super(message);
    this.name = "AgronomyResourceNotFoundError";
    this.code = code;
  }
}

@Injectable()
export class AgronomyService {
  private readonly tenants: TenantScope;

  constructor(
    @Inject(DATABASE_CLIENT) prisma: PrismaClient,
    @Optional() @Inject(GRID_REGISTRY) private readonly grids?: GridRegistry,
  ) {
    this.tenants = createTenantScope(prisma);
  }

  async evaluateField(
    userId: string,
    fieldId: string,
    request: FieldEvaluateRequest,
  ): Promise<SuitabilityRunWithWindows> {
    return this.tenants.withTenant(userId, async (tx) => {
      const source = await loadFieldSnapshotSource(tx, fieldId);
      if (source === null) {
        throw new AgronomyResourceNotFoundError("field_not_found", `field not found: ${fieldId}`);
      }

      const profile = await findProfileVersion(tx, request.profileVersionId);
      if (profile === null) {
        throw new AgronomyResourceNotFoundError(
          "profile_not_found",
          `profile version not found: ${request.profileVersionId}`,
        );
      }
      if (profile.status !== "published") {
        throw new AgronomyResourceNotFoundError(
          "profile_not_published",
          `profile version ${request.profileVersionId} is ${profile.status}`,
        );
      }

      const cultivar = await findCultivar(tx, profile.cultivarId);
      if (cultivar === null) {
        throw new AgronomyResourceNotFoundError(
          "profile_not_found",
          `cultivar not found: ${profile.cultivarId}`,
        );
      }

      const irrigationAvailability: IrrigationAvailability =
        request.irrigationAvailability ?? source.irrigationAvailability ?? "unknown";

      const snapshotPayload: FieldSnapshotPayload = fieldSnapshotPayloadSchema.parse({
        fieldId: source.fieldId,
        geometryHash: source.geometryHash,
        areaHa: source.areaHa,
        elevationM: source.elevationM,
        soilType: source.soilType,
        soilPh: source.soilPh,
        drainageClass: source.drainageClass,
        irrigationAvailability,
        irrigationSource: source.irrigationSource,
        extractionPolicy: "centroid",
        resolvedCells: [...source.resolvedCells],
        observationsUsed: [...source.observationsUsed],
      });
      const fieldSnapshotHash = hashFieldSnapshot(snapshotPayload);
      const fieldSnapshot = { ...snapshotPayload, fieldSnapshotHash };

      const constraints = profile.constraints as unknown as readonly Constraint[];
      const stages = profile.growthStages as unknown as readonly GrowthStage[];
      const constraintById = new Map(constraints.map((c) => [c.id, c]));

      const needsWaterMm = constraints.some(
        (c) => c.dimension === "water" && (c.unit ?? "").trim().toLowerCase() === "mm",
      );
      let storedOutlookMonths: readonly { readonly month: string; readonly valueMm: number | null }[] =
        [];
      if (needsWaterMm && request.candidates.length > 0) {
        const anchor = await selectFieldAnchor(tx, fieldId);
        if (anchor !== null) {
          try {
            const resolution = unvalidatedGridRegistry.resolve(
              { provider: "open-meteo", model: "ecmwf_ifs025" },
              { lat: anchor.lat, lon: anchor.lon },
            );
            const sortedStarts = [...request.candidates]
              .map((c) => c.startDate)
              .sort();
            const minMonth = `${sortedStarts[0]!.slice(0, 7)}-01`;
            const maxEnd = addUtcDaysIso(
              sortedStarts[sortedStarts.length - 1]!,
              cultivar.durationDaysTypical - 1,
            );
            const maxMonth = `${maxEnd.slice(0, 7)}-01`;
            const active = await loadActiveOutlookMonths(tx, {
              provider: "open-meteo",
              model: "ecmwf_ifs025",
              cellKey: resolution.cellKey,
              fromMonth: minMonth,
              toMonth: maxMonth,
            });
            storedOutlookMonths = active.months;
          } catch {
            storedOutlookMonths = [];
          }
        }
      }

      const candidateSourceMaps = new Map<string, ReadonlyMap<string, ObservationSourceKind>>();
      const generated = generatePlantingWindows({
        constraints,
        stages,
        durationDays: cultivar.durationDaysTypical,
        candidates: request.candidates.map((c) => {
          const endIso = addUtcDaysIso(c.startDate, cultivar.durationDaysTypical - 1);
          const outlookRainfallMm =
            storedOutlookMonths.length > 0
              ? prorateOutlookRainfallMm(storedOutlookMonths, c.startDate, endIso)
              : null;
          const resolved = resolveConstraintObservations(
            constraints,
            c.observations,
            source,
            outlookRainfallMm,
          );
          candidateSourceMaps.set(c.startDate, resolved.sources);
          return {
            startDate: c.startDate,
            observations: resolved.observations,
            primaryBasis: c.primaryBasis,
            evidenceSegments: c.evidenceSegments,
            missingRanges: c.missingRanges,
            singlePointClimateProxy: resolved.singlePointClimateProxy,
          };
        }),
      });

      const top = generated[0];
      if (top === undefined) {
        throw new Error("generatePlantingWindows returned no windows");
      }

      const unreproducibleReason = request.reproducible
        ? null
        : (request.unreproducibleReason ?? "raw_payload_not_retained");

      const runInputHash = hashDerivationDescriptor({
        artifact: "suitability_run",
        inputRefs: [...request.inputRefs],
        fieldSnapshotHash,
        profileVersionId: profile.id,
        engineVersion: AGRONOMY_ENGINE_VERSION,
        derivationVersion: AGRONOMY_DERIVATION_VERSION,
      });

      const windowInputHash = hashDerivationDescriptor({
        artifact: "planting_window",
        inputRefs: [...request.inputRefs],
        fieldSnapshotHash,
        profileVersionId: profile.id,
        engineVersion: AGRONOMY_ENGINE_VERSION,
        derivationVersion: AGRONOMY_DERIVATION_VERSION,
      });

      const persisted = await persistSuitabilityRunWithWindows(tx, {
        fieldId: source.fieldId,
        profileVersionId: profile.id,
        engineVersion: AGRONOMY_ENGINE_VERSION,
        derivationVersion: AGRONOMY_DERIVATION_VERSION,
        dimensionCoverage: top.assessment.dimensionCoverage,
        maxAchievableLevel: top.assessment.maxAchievableLevel,
        inputRefs: request.inputRefs,
        fieldSnapshot,
        fieldSnapshotHash,
        inputSnapshotHash: runInputHash,
        reproducible: request.reproducible,
        unreproducibleReason,
        windows: generated.map((w) => ({
          cropId: cultivar.cropId,
          cultivarId: cultivar.id,
          profileVersionId: profile.id,
          windowStart: w.windowStart,
          windowEnd: w.windowEnd,
          evaluationBasis: w.evaluationBasis,
          primaryBasis: w.primaryBasis,
          mixedEvidence: w.mixedEvidence,
          weakestEvidenceClass: w.weakestEvidenceClass,
          evidenceSegments: w.evidenceSegments,
          missingRanges: w.missingRanges,
          suitability: w.assessment.verdict,
          score: null,
          risks: [],
          explanations: w.assessment.reasons.map((r) => ({
            code: r.code,
            ...(r.dimension === undefined ? {} : { dimension: r.dimension }),
            detail: r.detail,
          })),
          constraintsEvaluated: w.assessment.evaluations.map((e) => {
            const c = constraintById.get(e.constraintId);
            const sourceMap = candidateSourceMaps.get(w.windowStart);
            return {
              constraintId: e.constraintId,
              dimension: e.dimension,
              grade: e.grade,
              severity: e.severity,
              outcome: e.outcome,
              observed: e.observed,
              unit: c?.unit ?? null,
              comparator: c?.comparator ?? null,
              thresholdLower: c?.thresholdLower ?? null,
              thresholdUpper: c?.thresholdUpper ?? null,
              thresholdCount: c?.thresholdCount ?? null,
              source: sourceMap?.get(e.constraintId) ?? null,
            };
          }),
          missingInputs: w.assessment.dimensionCoverage
            .filter((d) => d.state === "unknown")
            .map((d) => ({ dimension: d.dimension })),
          inputRefs: request.inputRefs,
          fieldSnapshotHash,
          inputSnapshotHash: windowInputHash,
          reproducible: request.reproducible,
          unreproducibleReason,
        })),
      });

      return suitabilityRunWithWindowsSchema.parse(persisted);
    });
  }

  async getLatestSuitability(
    userId: string,
    fieldId: string,
  ): Promise<SuitabilityRunWithWindows | null> {
    const run = await this.tenants.withTenant(userId, (tx) =>
      findLatestSuitabilityRun(tx, fieldId),
    );
    return run === null ? null : suitabilityRunWithWindowsSchema.parse(run);
  }

  async listPlantingWindows(
    userId: string,
    query: PlantingWindowListQuery,
  ): Promise<readonly PlantingWindow[]> {
    return this.tenants.withTenant(userId, (tx) =>
      listActivePlantingWindows(tx, {
        ...(query.fieldId === undefined ? {} : { fieldId: query.fieldId }),
        ...(query.cropId === undefined ? {} : { cropId: query.cropId }),
        ...(query.suitability === undefined ? {} : { suitability: query.suitability }),
        ...(query.from === undefined ? {} : { from: query.from }),
        ...(query.to === undefined ? {} : { to: query.to }),
      }),
    );
  }

  private tryRegistryEntry(provider: string, model: string): GridRegistryEntry | null {
    if (this.grids === undefined) return null;
    try {
      const spec = this.grids.specFor({ provider, model });
      const evidence = this.grids.evidenceFor({ provider, model });
      return { provider, model, spec, evidence };
    } catch {
      return null;
    }
  }

  async recommendForField(
    userId: string,
    fieldId: string,
    horizonMonths: 3 | 6 | 12,
  ): Promise<FieldRecommendations> {
    const now = new Date();
    const nowIso = now.toISOString();
    const firstMonth = jakartaMonthOf(now);
    const toMonth = calendarMonthOf(firstMonth, 12);

    return this.tenants.withTenant(userId, async (tx) => {
      const fieldRow = await findField(tx, fieldId);
      const source = await loadFieldSnapshotSource(tx, fieldId);
      if (fieldRow === null || source === null) {
        throw new AgronomyResourceNotFoundError("field_not_found", `field not found: ${fieldId}`);
      }

      const anchor = await selectFieldAnchor(tx, fieldId);
      const mergedMonths = new Map<
        string,
        { readonly month: string; readonly valueMm: number | null; readonly dataClass: string | null }
      >();
      for (let i = 1; i <= 12; i += 1) {
        const m = calendarMonthOf(firstMonth, i);
        mergedMonths.set(m, { month: m, valueMm: null, dataClass: null });
      }

      if (anchor !== null) {
        const fcEntry = this.tryRegistryEntry("open-meteo", "ecmwf_ifs025");
        const eraEntry = this.tryRegistryEntry("open-meteo", "era5");
        let cellKey: string | null = null;
        if (fcEntry !== null) {
          try {
            cellKey = createSpatialResolution(fcEntry, { lat: anchor.lat, lon: anchor.lon }).cellKey;
          } catch {
            cellKey = null;
          }
        } else {
          try {
            cellKey = unvalidatedGridRegistry.resolve(
              { provider: "open-meteo", model: "ecmwf_ifs025" },
              { lat: anchor.lat, lon: anchor.lon },
            ).cellKey;
          } catch {
            cellKey = null;
          }
        }

        if (cellKey !== null) {
          if (eraEntry !== null) {
            const eraStored = await loadActiveOutlookMonths(tx, {
              provider: "open-meteo",
              model: "era5",
              cellKey,
              fromMonth: firstMonth,
              toMonth,
            });
            if (eraStored !== null) {
              const assembled = assembleOutlookHorizon({
                firstMonth,
                rows: eraStored.months,
                now: nowIso,
              });
              if (assembled.ok) {
                for (const m of assembled.value.months) {
                  if (m.valueMm !== null) {
                    mergedMonths.set(m.month, {
                      month: m.month,
                      valueMm: m.valueMm,
                      dataClass: m.dataClass,
                    });
                  }
                }
              }
            }
          }

          const fcStored = await loadActiveOutlookMonths(tx, {
            provider: "open-meteo",
            model: "ecmwf_ifs025",
            cellKey,
            fromMonth: firstMonth,
            toMonth,
          });
          if (fcStored !== null) {
            const assembled = assembleOutlookHorizon({
              firstMonth,
              rows: fcStored.months,
              now: nowIso,
            });
            if (assembled.ok) {
              for (const m of assembled.value.months) {
                if (m.valueMm !== null) {
                  mergedMonths.set(m.month, {
                    month: m.month,
                    valueMm: m.valueMm,
                    dataClass: m.dataClass,
                  });
                }
              }
            }
          }
        }
      }

      const crops = await listCrops(tx);
      const candidates = [];
      for (const crop of crops) {
        const cultivars = await listCultivars(tx, crop.id);
        const versions = await listProfileVersionsForCrop(tx, crop.id);
        for (const cultivar of cultivars) {
          const publishedSummary = versions.find(
            (v) => v.cultivarId === cultivar.id && v.status === "published",
          );
          if (publishedSummary === undefined) continue;
          const profile = await findProfileVersion(tx, publishedSummary.id);
          if (profile === null) continue;
          candidates.push({
            cropId: crop.id,
            cropSlug: crop.slug,
            cropNameId: crop.nameId,
            category: crop.category,
            cultivarId: cultivar.id,
            cultivarName: cultivar.name,
            profileVersionId: profile.id,
            durationDaysTypical: cultivar.durationDaysTypical,
            altitudeMinM: cultivar.altitudeMinM,
            altitudeMaxM: cultivar.altitudeMaxM,
            constraints: profile.constraints as unknown as readonly Constraint[],
          });
        }
      }

      const latestTempObs = source.observationsUsed.find(
        (obs) =>
          obs.kind === "temperature" &&
          ["°c", "c", "celsius"].includes(obs.unit.trim().toLowerCase()),
      );

      const computed = recommendCropsForField({
        field: {
          fieldId,
          fieldName: fieldRow.name,
          elevationM: source.elevationM,
          soilPh: source.soilPh,
          drainageClass: source.drainageClass,
          irrigationAvailability: source.irrigationAvailability ?? "unknown",
          latestTempC: latestTempObs?.value ?? null,
        },
        outlookMonths: [...mergedMonths.values()],
        crops: candidates,
        horizonMonths,
      });

      return fieldRecommendationsSchema.parse(computed);
    });
  }
}
