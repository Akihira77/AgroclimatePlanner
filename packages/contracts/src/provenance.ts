import { z } from "zod";
import {
  isoDateSchema,
  isoInstantSchema,
  missingReasonSchema,
  opaqueIdSchema,
  singleValueEvaluationBasisSchema,
  weatherDataClassSchema,
} from "./enums.js";

/**
 * A segment may span two runs and a partial re-ingest, so run ids are arrays.
 * `[string, ...string[]]` forbids the empty array that used to mean
 * "climatology" — climatology has its own variant instead.
 */
const nonEmptyIdArraySchema = z.tuple([opaqueIdSchema]).rest(opaqueIdSchema);

export const inputPurposeSchema = z.enum(["input", "verification_truth"]);
export type InputPurpose = z.infer<typeof inputPurposeSchema>;

/**
 * `kind` says what the input is, `role` says where it sits in the horizon,
 * `purpose` says why it was consumed. Three questions, three fields.
 */
export const dataInputRefSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("forecast"),
    role: z.enum(["short_range", "subseasonal", "seasonal", "annual_outlook"]),
    purpose: inputPurposeSchema,
    forecastRunIds: nonEmptyIdArraySchema,
    ingestionRunIds: nonEmptyIdArraySchema,
    recordSetHash: opaqueIdSchema,
  }),
  z.strictObject({
    kind: z.literal("baseline"),
    role: z.literal("climatology"),
    purpose: inputPurposeSchema,
    baselineVersion: z.string().min(1),
    baselineHash: opaqueIdSchema,
    cellKeys: nonEmptyIdArraySchema,
  }),
  z.strictObject({
    kind: z.literal("observation"),
    role: z.literal("field_observation"),
    purpose: inputPurposeSchema,
    observationIds: nonEmptyIdArraySchema,
    recordSetHash: opaqueIdSchema,
  }),
  z.strictObject({
    kind: z.literal("dataset"),
    role: z.enum(["reanalysis", "satellite_estimate"]),
    purpose: inputPurposeSchema,
    datasetVersion: z.string().min(1),
    recordSetHash: opaqueIdSchema,
  }),
]);
export type DataInputRef = z.infer<typeof dataInputRefSchema>;

/**
 * `kind` is the storage shape, `evidenceClass` is what the evidence is. They
 * are separate because reanalysis and satellite estimates share a shape while
 * being different classes.
 */
export const segmentProvenanceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("forecast"),
    forecastRunIds: nonEmptyIdArraySchema,
    ingestionRunIds: nonEmptyIdArraySchema,
    initializedAt: isoInstantSchema,
  }),
  z.strictObject({
    kind: z.literal("climatology"),
    baselineVersion: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal("observation"),
    observationIds: nonEmptyIdArraySchema,
  }),
  z.strictObject({
    kind: z.literal("dataset"),
    datasetVersion: z.string().min(1),
    ingestionRunIds: nonEmptyIdArraySchema,
  }),
]);
export type SegmentProvenance = z.infer<typeof segmentProvenanceSchema>;

export const evidenceSegmentSchema = z.strictObject({
  startDate: isoDateSchema,
  endDate: isoDateSchema,
  evaluationBasis: singleValueEvaluationBasisSchema,
  evidenceClass: weatherDataClassSchema,
  coveragePercent: z.number().min(0).max(100),
  provenance: segmentProvenanceSchema,
});
export type EvidenceSegment = z.infer<typeof evidenceSegmentSchema>;

export const missingRangeSchema = z.strictObject({
  startDate: isoDateSchema,
  endDate: isoDateSchema,
  reason: missingReasonSchema,
});
export type MissingRange = z.infer<typeof missingRangeSchema>;

export const resolvedCellSchema = z.strictObject({
  provider: z.string().min(1),
  model: z.string().min(1),
  cellKey: z.string().min(1),
  servedLat: z.number(),
  servedLon: z.number(),
  distanceKm: z.number().nonnegative(),
});
export type ResolvedCell = z.infer<typeof resolvedCellSchema>;

export const usedObservationSchema = z.strictObject({
  observationId: opaqueIdSchema,
  kind: z.string().min(1),
  value: z.number(),
  unit: z.string().min(1),
  observedAt: isoInstantSchema,
});
export type UsedObservation = z.infer<typeof usedObservationSchema>;

/**
 * The agronomic inputs that are not weather. `null` is preserved as `null`:
 * "unknown" and "known to be neutral" drive different agronomy outcomes.
 *
 * This is the hash PREIMAGE. `fieldSnapshotHash` is the output of hashing it,
 * so it must not appear here — a strict object rejects it at runtime, and the
 * `FieldSnapshot` type below adds it back only for the persisted row.
 */
export const fieldSnapshotPayloadSchema = z.strictObject({
  fieldId: opaqueIdSchema,
  geometryHash: opaqueIdSchema,
  areaHa: z.number().positive(),
  elevationM: z.number().nullable(),
  soilType: z.string().nullable(),
  soilPh: z.number().nullable(),
  drainageClass: z.string().nullable(),
  irrigationAvailable: z.boolean(),
  irrigationSource: z.string().nullable(),
  extractionPolicy: z.enum(["centroid", "area_weighted"]),
  resolvedCells: z.array(resolvedCellSchema),
  observationsUsed: z.array(usedObservationSchema),
});
export type FieldSnapshotPayload = z.infer<typeof fieldSnapshotPayloadSchema>;

export const fieldSnapshotSchema = fieldSnapshotPayloadSchema.extend({
  fieldSnapshotHash: opaqueIdSchema,
});
export type FieldSnapshot = z.infer<typeof fieldSnapshotSchema>;

/**
 * Four artifacts, four descriptors, four `artifact` literals. `artifact` is
 * inside the hash, so a shared literal would let two artifact types collide
 * silently — nothing compares `artifact` outside the hash.
 */
export const derivationDescriptorSchema = z.discriminatedUnion("artifact", [
  z.strictObject({
    artifact: z.literal("monthly_outlook"),
    inputRefs: z.array(dataInputRefSchema),
    derivationVersion: z.string().min(1),
  }),
  z.strictObject({
    artifact: z.literal("suitability_run"),
    inputRefs: z.array(dataInputRefSchema),
    fieldSnapshotHash: opaqueIdSchema,
    profileVersionId: opaqueIdSchema,
    engineVersion: z.string().min(1),
    derivationVersion: z.string().min(1),
  }),
  z.strictObject({
    artifact: z.literal("planting_window"),
    inputRefs: z.array(dataInputRefSchema),
    fieldSnapshotHash: opaqueIdSchema,
    profileVersionId: opaqueIdSchema,
    engineVersion: z.string().min(1),
    derivationVersion: z.string().min(1),
  }),
  z.strictObject({
    artifact: z.literal("ai_briefing"),
    inputRefs: z.array(dataInputRefSchema),
    fieldSnapshotHash: opaqueIdSchema,
    /** Sorted hashes of the artifacts summarised, not their versions: versions
     * can stay equal while output changes, hashes cannot. */
    sourceArtifactHashes: z.array(opaqueIdSchema),
    promptVersion: z.string().min(1),
    modelId: z.string().min(1),
    derivationVersion: z.string().min(1),
  }),
]);
export type DerivationDescriptor = z.infer<typeof derivationDescriptorSchema>;
