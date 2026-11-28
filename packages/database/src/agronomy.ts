import { createHash } from "node:crypto";

import type {
  DataInputRef,
  DimensionCoverageEntry,
  DrainageClass,
  EvaluationBasis,
  EvidenceGrade,
  EvidenceSegment,
  FieldSnapshot,
  IrrigationAvailability,
  MissingRange,
  PlantingWindow,
  ResolvedCell,
  SingleValueEvaluationBasis,
  SoilType,
  SuitabilityRunWithWindows,
  SuitabilityVerdict,
  UnreproducibleReason,
  UsedObservation,
  WeatherDataClass,
} from "@agroclimate/contracts";

import { Prisma } from "./generated/prisma/client.js";
import type { TenantTransaction } from "./tenant.js";

/**
 * Phase 6 agronomic evaluation persistence (`suitability_runs` & `planting_windows`).
 *
 * Uses atomic stage-failed → retire-old → promote-new supersession so live unique
 * indexes (`suitability_runs_live_key`) and `superseded_by_id` foreign keys are
 * satisfied without deleting or mutating historical runs.
 */

export interface FieldSnapshotSource {
  readonly fieldId: string;
  readonly geometryHash: string;
  readonly areaHa: number;
  readonly elevationM: number | null;
  readonly soilType: SoilType | null;
  readonly soilPh: number | null;
  readonly drainageClass: DrainageClass | null;
  readonly irrigationAvailability: IrrigationAvailability | null;
  readonly irrigationSource: string | null;
  readonly resolvedCells: readonly ResolvedCell[];
  readonly observationsUsed: readonly UsedObservation[];
}

export interface PersistWindowInput {
  readonly cropId: string;
  readonly cultivarId: string;
  readonly profileVersionId: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly evaluationBasis: EvaluationBasis;
  readonly primaryBasis: SingleValueEvaluationBasis;
  readonly mixedEvidence: boolean;
  readonly weakestEvidenceClass: WeatherDataClass;
  readonly evidenceSegments: readonly EvidenceSegment[];
  readonly missingRanges: readonly MissingRange[];
  readonly suitability: SuitabilityVerdict;
  readonly score: number | null;
  readonly risks: readonly Record<string, unknown>[];
  readonly explanations: readonly Record<string, unknown>[];
  readonly constraintsEvaluated: readonly Record<string, unknown>[];
  readonly missingInputs: readonly Record<string, unknown>[];
  readonly inputRefs: readonly DataInputRef[];
  readonly fieldSnapshotHash: string;
  readonly inputSnapshotHash: string;
  readonly reproducible: boolean;
  readonly unreproducibleReason: UnreproducibleReason | null;
}

export interface PersistSuitabilityInput {
  readonly fieldId: string;
  readonly profileVersionId: string;
  readonly engineVersion: string;
  readonly derivationVersion: string;
  readonly dimensionCoverage: readonly DimensionCoverageEntry[];
  readonly maxAchievableLevel: EvidenceGrade | null;
  readonly inputRefs: readonly DataInputRef[];
  readonly fieldSnapshot: FieldSnapshot;
  readonly fieldSnapshotHash: string;
  readonly inputSnapshotHash: string;
  readonly reproducible: boolean;
  readonly unreproducibleReason: UnreproducibleReason | null;
  readonly windows: readonly PersistWindowInput[];
}

export interface PlantingWindowListFilters {
  readonly fieldId?: string;
  readonly cropId?: string;
  readonly suitability?: SuitabilityVerdict;
  readonly from?: string;
  readonly to?: string;
}

interface RawFieldSource {
  readonly id: string;
  readonly ewkb: Uint8Array;
  readonly area_ha: number;
  readonly elevation_m: string | number | null;
  readonly soil_type: SoilType | null;
  readonly soil_ph: string | number | null;
  readonly drainage_class: DrainageClass | null;
  readonly irrigation_availability: IrrigationAvailability | null;
  readonly water_source: string | null;
}

interface RawResolvedCell {
  readonly provider: string;
  readonly model: string;
  readonly cell_key: string;
  readonly served_lat: number | null;
  readonly served_lon: number | null;
  readonly distance_km: number;
}

interface RawUsedObservation {
  readonly id: string;
  readonly kind: string;
  readonly value: number;
  readonly unit: string;
  readonly observed_at: Date;
}

interface RawSuitabilityRun {
  readonly id: string;
  readonly user_id: string;
  readonly field_id: string;
  readonly profile_version_id: string;
  readonly computed_at: Date;
  readonly engine_version: string;
  readonly derivation_version: string;
  readonly dimension_coverage: DimensionCoverageEntry[];
  readonly max_achievable_level: EvidenceGrade | null;
  readonly input_refs: DataInputRef[];
  readonly field_snapshot: FieldSnapshot;
  readonly field_snapshot_hash: string;
  readonly input_snapshot_hash: string;
  readonly reproducible: boolean;
  readonly unreproducible_reason: UnreproducibleReason | null;
  readonly status: "active" | "superseded" | "failed";
  readonly supersedes_id: string | null;
  readonly superseded_by_id: string | null;
}

interface RawPlantingWindow {
  readonly id: string;
  readonly user_id: string;
  readonly suitability_run_id: string;
  readonly field_id: string;
  readonly crop_id: string;
  readonly cultivar_id: string;
  readonly profile_version_id: string;
  readonly window_start: string;
  readonly window_end: string;
  readonly evaluation_basis: EvaluationBasis;
  readonly primary_basis: SingleValueEvaluationBasis;
  readonly mixed_evidence: boolean;
  readonly weakest_evidence_class: WeatherDataClass;
  readonly evidence_segments: EvidenceSegment[];
  readonly missing_ranges: MissingRange[];
  readonly suitability: SuitabilityVerdict;
  readonly score: string | number | null;
  readonly risks: Record<string, unknown>[];
  readonly explanations: Record<string, unknown>[];
  readonly constraints_evaluated: Record<string, unknown>[];
  readonly missing_inputs: Record<string, unknown>[];
  readonly input_refs: DataInputRef[];
  readonly field_snapshot_hash: string;
  readonly input_snapshot_hash: string;
  readonly computed_at: Date;
  readonly reproducible: boolean;
  readonly unreproducible_reason: UnreproducibleReason | null;
  readonly status: "active" | "superseded" | "failed";
  readonly superseded_by_id: string | null;
}

function toWindow(row: RawPlantingWindow): PlantingWindow {
  return {
    id: row.id,
    userId: row.user_id,
    suitabilityRunId: row.suitability_run_id,
    fieldId: row.field_id,
    cropId: row.crop_id,
    cultivarId: row.cultivar_id,
    profileVersionId: row.profile_version_id,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    evaluationBasis: row.evaluation_basis,
    primaryBasis: row.primary_basis,
    mixedEvidence: row.mixed_evidence,
    weakestEvidenceClass: row.weakest_evidence_class,
    evidenceSegments: row.evidence_segments,
    missingRanges: row.missing_ranges,
    suitability: row.suitability,
    score: row.score === null ? null : Number(row.score),
    risks: row.risks,
    explanations: row.explanations,
    constraintsEvaluated: row.constraints_evaluated,
    missingInputs: row.missing_inputs,
    inputRefs: row.input_refs,
    fieldSnapshotHash: row.field_snapshot_hash,
    inputSnapshotHash: row.input_snapshot_hash,
    computedAt: row.computed_at.toISOString(),
    reproducible: row.reproducible,
    unreproducibleReason: row.unreproducible_reason,
    status: row.status,
    supersedesId: null,
    supersededById: row.superseded_by_id,
  };
}

export async function loadFieldSnapshotSource(
  tx: TenantTransaction,
  fieldId: string,
): Promise<FieldSnapshotSource | null> {
  const fieldRows = await tx.$queryRaw<RawFieldSource[]>`
    SELECT id::text AS id,
           ST_AsEWKB(geom) AS ewkb,
           area_ha,
           elevation_m,
           soil_type,
           soil_ph,
           drainage_class,
           irrigation_availability,
           water_source
      FROM app.fields
     WHERE id = ${fieldId}::uuid
       AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
       AND deleted_at IS NULL
  `;
  const field = fieldRows[0];
  if (field === undefined) return null;

  const geometryHash = createHash("sha256").update(field.ewkb).digest("hex");

  const cellRows = await tx.$queryRaw<RawResolvedCell[]>`
    SELECT foc.provider,
           foc.model,
           oc.cell_key,
           oc.served_lat,
           oc.served_lon,
           foc.distance_km
      FROM app.field_outlook_cells foc
      JOIN app.outlook_cells oc ON oc.id = foc.outlook_cell_id
     WHERE foc.field_id = ${fieldId}::uuid
       AND foc.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
       AND foc.superseded_at IS NULL
     ORDER BY foc.provider ASC, foc.model ASC
  `;

  const resolvedCells: ResolvedCell[] = cellRows
    .filter((c) => c.served_lat !== null && c.served_lon !== null)
    .map((c) => ({
      provider: c.provider,
      model: c.model,
      cellKey: c.cell_key,
      servedLat: c.served_lat as number,
      servedLon: c.served_lon as number,
      distanceKm: c.distance_km,
    }));

  const obsRows = await tx.$queryRaw<RawUsedObservation[]>`
    SELECT id::text AS id,
           kind,
           value,
           unit,
           observed_at
      FROM app.field_observations
     WHERE field_id = ${fieldId}::uuid
       AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
       AND value IS NOT NULL
       AND unit IS NOT NULL
     ORDER BY observed_at DESC, id DESC
     LIMIT 50
  `;

  const observationsUsed: UsedObservation[] = obsRows.map((o) => ({
    observationId: o.id,
    kind: o.kind,
    value: o.value,
    unit: o.unit,
    observedAt: o.observed_at.toISOString(),
  }));

  return {
    fieldId: field.id,
    geometryHash,
    areaHa: field.area_ha,
    elevationM: field.elevation_m === null ? null : Number(field.elevation_m),
    soilType: field.soil_type,
    soilPh: field.soil_ph === null ? null : Number(field.soil_ph),
    drainageClass: field.drainage_class,
    irrigationAvailability: field.irrigation_availability,
    irrigationSource: field.water_source,
    resolvedCells,
    observationsUsed,
  };
}

export async function persistSuitabilityRunWithWindows(
  tx: TenantTransaction,
  input: PersistSuitabilityInput,
): Promise<SuitabilityRunWithWindows> {
  if (input.windows.length === 0) {
    throw new Error("persistSuitabilityRunWithWindows requires at least one window");
  }

  const fieldLock = await tx.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id
      FROM app.fields
     WHERE id = ${input.fieldId}::uuid
       AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
       AND deleted_at IS NULL
     FOR UPDATE
  `;
  if (fieldLock.length === 0) {
    throw new Error(`field not found for suitability persistence: ${input.fieldId}`);
  }

  const priorRunRows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id
      FROM app.suitability_runs
     WHERE field_id = ${input.fieldId}::uuid
       AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
       AND status = 'active'
     FOR UPDATE
  `;
  const priorRunId = priorRunRows[0]?.id ?? null;

  // Stage-failed -> retire-old -> promote-new avoids live-key conflicts.
  const insertedRunRows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO app.suitability_runs (
      user_id,
      field_id,
      profile_version_id,
      engine_version,
      derivation_version,
      dimension_coverage,
      max_achievable_level,
      input_refs,
      field_snapshot,
      field_snapshot_hash,
      input_snapshot_hash,
      reproducible,
      unreproducible_reason,
      status,
      supersedes_id
    )
    VALUES (
      NULLIF(current_setting('app.user_id', true), '')::uuid,
      ${input.fieldId}::uuid,
      ${input.profileVersionId}::uuid,
      ${input.engineVersion},
      ${input.derivationVersion},
      ${JSON.stringify(input.dimensionCoverage)}::jsonb,
      ${input.maxAchievableLevel},
      ${JSON.stringify(input.inputRefs)}::jsonb,
      ${JSON.stringify(input.fieldSnapshot)}::jsonb,
      ${input.fieldSnapshotHash},
      ${input.inputSnapshotHash},
      ${input.reproducible},
      ${input.unreproducibleReason},
      'failed',
      ${priorRunId}::uuid
    )
    RETURNING id::text AS id
  `;
  const newRunId = insertedRunRows[0]?.id;
  if (newRunId === undefined) throw new Error("suitability_runs insert returned no id");

  if (priorRunId !== null) {
    await tx.$queryRaw`
      UPDATE app.suitability_runs
         SET status = 'superseded',
             superseded_by_id = ${newRunId}::uuid
       WHERE id = ${priorRunId}::uuid
         AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    `;
  }

  await tx.$queryRaw`
    UPDATE app.suitability_runs
       SET status = 'active'
     WHERE id = ${newRunId}::uuid
       AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  `;

  let firstNewWindowId: string | null = null;
  for (const w of input.windows) {
    const insertedWindow = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO app.planting_windows (
        user_id,
        suitability_run_id,
        field_id,
        crop_id,
        cultivar_id,
        profile_version_id,
        window_start,
        window_end,
        evaluation_basis,
        primary_basis,
        mixed_evidence,
        weakest_evidence_class,
        evidence_segments,
        missing_ranges,
        suitability,
        score,
        risks,
        explanations,
        constraints_evaluated,
        missing_inputs,
        input_refs,
        field_snapshot_hash,
        input_snapshot_hash,
        reproducible,
        unreproducible_reason,
        status
      )
      VALUES (
        NULLIF(current_setting('app.user_id', true), '')::uuid,
        ${newRunId}::uuid,
        ${input.fieldId}::uuid,
        ${w.cropId}::uuid,
        ${w.cultivarId}::uuid,
        ${w.profileVersionId}::uuid,
        ${w.windowStart}::date,
        ${w.windowEnd}::date,
        ${w.evaluationBasis},
        ${w.primaryBasis},
        ${w.mixedEvidence},
        ${w.weakestEvidenceClass},
        ${JSON.stringify(w.evidenceSegments)}::jsonb,
        ${JSON.stringify(w.missingRanges)}::jsonb,
        ${w.suitability},
        ${w.score},
        ${JSON.stringify(w.risks)}::jsonb,
        ${JSON.stringify(w.explanations)}::jsonb,
        ${JSON.stringify(w.constraintsEvaluated)}::jsonb,
        ${JSON.stringify(w.missingInputs)}::jsonb,
        ${JSON.stringify(w.inputRefs)}::jsonb,
        ${w.fieldSnapshotHash},
        ${w.inputSnapshotHash},
        ${w.reproducible},
        ${w.unreproducibleReason},
        'active'
      )
      RETURNING id::text AS id
    `;
    if (firstNewWindowId === null && insertedWindow[0] !== undefined) {
      firstNewWindowId = insertedWindow[0].id;
    }
  }

  if (firstNewWindowId !== null) {
    await tx.$queryRaw`
      UPDATE app.planting_windows
         SET status = 'superseded',
             superseded_by_id = ${firstNewWindowId}::uuid
       WHERE field_id = ${input.fieldId}::uuid
         AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
         AND status = 'active'
         AND suitability_run_id <> ${newRunId}::uuid
    `;
  }

  const loaded = await findLatestSuitabilityRun(tx, input.fieldId);
  if (loaded === null) throw new Error("persisted suitability run could not be reloaded");
  return loaded;
}

export async function findLatestSuitabilityRun(
  tx: TenantTransaction,
  fieldId: string,
): Promise<SuitabilityRunWithWindows | null> {
  const runRows = await tx.$queryRaw<RawSuitabilityRun[]>`
    SELECT r.id::text AS id,
           r.user_id::text AS user_id,
           r.field_id::text AS field_id,
           r.profile_version_id::text AS profile_version_id,
           r.computed_at,
           r.engine_version,
           r.derivation_version,
           r.dimension_coverage,
           r.max_achievable_level,
           r.input_refs,
           r.field_snapshot,
           r.field_snapshot_hash,
           r.input_snapshot_hash,
           r.reproducible,
           r.unreproducible_reason,
           r.status,
           r.supersedes_id::text AS supersedes_id,
           r.superseded_by_id::text AS superseded_by_id
      FROM app.suitability_runs r
      JOIN app.fields f ON f.id = r.field_id AND f.user_id = r.user_id
     WHERE r.field_id = ${fieldId}::uuid
       AND r.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
       AND r.status = 'active'
       AND f.deleted_at IS NULL
  `;
  const run = runRows[0];
  if (run === undefined) return null;

  const windowRows = await tx.$queryRaw<RawPlantingWindow[]>`
    SELECT id::text AS id,
           user_id::text AS user_id,
           suitability_run_id::text AS suitability_run_id,
           field_id::text AS field_id,
           crop_id::text AS crop_id,
           cultivar_id::text AS cultivar_id,
           profile_version_id::text AS profile_version_id,
           window_start::text AS window_start,
           window_end::text AS window_end,
           evaluation_basis,
           primary_basis,
           mixed_evidence,
           weakest_evidence_class,
           evidence_segments,
           missing_ranges,
           suitability,
           score,
           risks,
           explanations,
           constraints_evaluated,
           missing_inputs,
           input_refs,
           field_snapshot_hash,
           input_snapshot_hash,
           computed_at,
           reproducible,
           unreproducible_reason,
           status,
           superseded_by_id::text AS superseded_by_id
      FROM app.planting_windows
     WHERE suitability_run_id = ${run.id}::uuid
       AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
       AND status = 'active'
     ORDER BY window_start ASC, id ASC
  `;

  return {
    id: run.id,
    userId: run.user_id,
    fieldId: run.field_id,
    profileVersionId: run.profile_version_id,
    computedAt: run.computed_at.toISOString(),
    engineVersion: run.engine_version,
    derivationVersion: run.derivation_version,
    dimensionCoverage: run.dimension_coverage,
    maxAchievableLevel: run.max_achievable_level,
    inputRefs: run.input_refs,
    fieldSnapshot: run.field_snapshot,
    fieldSnapshotHash: run.field_snapshot_hash,
    inputSnapshotHash: run.input_snapshot_hash,
    reproducible: run.reproducible,
    unreproducibleReason: run.unreproducible_reason,
    status: run.status,
    supersedesId: run.supersedes_id,
    supersededById: run.superseded_by_id,
    plantingWindows: windowRows.map(toWindow),
  };
}

export async function listActivePlantingWindows(
  tx: TenantTransaction,
  filters: PlantingWindowListFilters = {},
): Promise<readonly PlantingWindow[]> {
  const conditions: Prisma.Sql[] = [
    Prisma.sql`w.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid`,
    Prisma.sql`w.status = 'active'`,
    Prisma.sql`f.deleted_at IS NULL`,
  ];

  if (filters.fieldId !== undefined) {
    conditions.push(Prisma.sql`w.field_id = ${filters.fieldId}::uuid`);
  }
  if (filters.cropId !== undefined) {
    conditions.push(Prisma.sql`w.crop_id = ${filters.cropId}::uuid`);
  }
  if (filters.suitability !== undefined) {
    conditions.push(Prisma.sql`w.suitability = ${filters.suitability}`);
  }
  if (filters.from !== undefined) {
    conditions.push(Prisma.sql`w.window_end >= ${filters.from}::date`);
  }
  if (filters.to !== undefined) {
    conditions.push(Prisma.sql`w.window_start <= ${filters.to}::date`);
  }

  const rows = await tx.$queryRaw<RawPlantingWindow[]>`
    SELECT w.id::text AS id,
           w.user_id::text AS user_id,
           w.suitability_run_id::text AS suitability_run_id,
           w.field_id::text AS field_id,
           w.crop_id::text AS crop_id,
           w.cultivar_id::text AS cultivar_id,
           w.profile_version_id::text AS profile_version_id,
           w.window_start::text AS window_start,
           w.window_end::text AS window_end,
           w.evaluation_basis,
           w.primary_basis,
           w.mixed_evidence,
           w.weakest_evidence_class,
           w.evidence_segments,
           w.missing_ranges,
           w.suitability,
           w.score,
           w.risks,
           w.explanations,
           w.constraints_evaluated,
           w.missing_inputs,
           w.input_refs,
           w.field_snapshot_hash,
           w.input_snapshot_hash,
           w.computed_at,
           w.reproducible,
           w.unreproducible_reason,
           w.status,
           w.superseded_by_id::text AS superseded_by_id
      FROM app.planting_windows w
      JOIN app.fields f ON f.id = w.field_id AND f.user_id = w.user_id
     WHERE ${Prisma.join(conditions, " AND ")}
     ORDER BY w.window_start ASC, w.id ASC
  `;

  return rows.map(toWindow);
}
