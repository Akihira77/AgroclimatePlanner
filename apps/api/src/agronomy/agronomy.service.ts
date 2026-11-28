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

      const generated = generatePlantingWindows({
        constraints,
        stages,
        durationDays: cultivar.durationDaysTypical,
        candidates: request.candidates.map((c) => ({
          startDate: c.startDate,
          observations: new Map(Object.entries(c.observations)),
          primaryBasis: c.primaryBasis,
          evidenceSegments: c.evidenceSegments,
          missingRanges: c.missingRanges,
        })),
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
          constraintsEvaluated: w.assessment.evaluations.map((e) => ({
            constraintId: e.constraintId,
            dimension: e.dimension,
            grade: e.grade,
            severity: e.severity,
            outcome: e.outcome,
          })),
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
