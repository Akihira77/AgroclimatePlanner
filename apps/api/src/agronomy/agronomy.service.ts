import { generatePlantingWindows } from "@agroclimate/agronomy";
import type {
  Constraint,
  FieldEvaluateRequest,
  FieldSnapshotPayload,
  GrowthStage,
  IrrigationAvailability,
  PlantingWindow,
  PlantingWindowListQuery,
  SuitabilityRunWithWindows,
} from "@agroclimate/contracts";
import {
  fieldSnapshotPayloadSchema,
  hashDerivationDescriptor,
  hashFieldSnapshot,
  suitabilityRunWithWindowsSchema,
} from "@agroclimate/contracts";
import {
  createTenantScope,
  findCultivar,
  findLatestSuitabilityRun,
  findProfileVersion,
  listActivePlantingWindows,
  loadFieldSnapshotSource,
  persistSuitabilityRunWithWindows,
} from "@agroclimate/database";
import type { PrismaClient, TenantScope } from "@agroclimate/database";
import { Inject, Injectable } from "@nestjs/common";

import { DATABASE_CLIENT } from "../tokens.js";

export const AGRONOMY_ENGINE_VERSION = "0.1.0";
export const AGRONOMY_DERIVATION_VERSION = "1";

type ObservationSourceKind = "request" | "field_profile" | "field_observation";

interface ResolvedConstraintObservations {
  readonly observations: ReadonlyMap<string, number | null>;
  readonly sources: ReadonlyMap<string, ObservationSourceKind>;
}

/**
 * Resolves constraint observations per candidate without overriding explicit
 * caller inputs (including explicit `null`). Only fills omitted constraints
 * from verified field agronomy profile (`soilPh`) or latest matching field
 * observations (`temperature` in °C). Leaves water/rainfall constraints `null`
 * rather than fabricating totals from single-day readings.
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
): ResolvedConstraintObservations {
  const observations = new Map<string, number | null>();
  const sources = new Map<string, ObservationSourceKind>();

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

    if (
      constraint.dimension === "climate" &&
      (unit === "°c" || unit === "c" || unit === "celsius") &&
      latestTemp !== undefined
    ) {
      observations.set(constraint.id, latestTemp.value);
      sources.set(constraint.id, "field_observation");
      continue;
    }

    observations.set(constraint.id, null);
  }

  return { observations, sources };
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

  constructor(@Inject(DATABASE_CLIENT) prisma: PrismaClient) {
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

      const candidateSourceMaps = new Map<string, ReadonlyMap<string, ObservationSourceKind>>();
      const generated = generatePlantingWindows({
        constraints,
        stages,
        durationDays: cultivar.durationDaysTypical,
        candidates: request.candidates.map((c) => {
          const resolved = resolveConstraintObservations(constraints, c.observations, source);
          candidateSourceMaps.set(c.startDate, resolved.sources);
          return {
            startDate: c.startDate,
            observations: resolved.observations,
            primaryBasis: c.primaryBasis,
            evidenceSegments: c.evidenceSegments,
            missingRanges: c.missingRanges,
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
}
