import { z } from "zod";

import { evidenceGradeSchema } from "./crop.js";
import {
  evaluationBasisSchema,
  isoInstantSchema,
  opaqueIdSchema,
  singleValueEvaluationBasisSchema,
  weatherDataClassSchema,
} from "./enums.js";
import {
  dataInputRefSchema,
  evidenceSegmentSchema,
  fieldSnapshotSchema,
  missingRangeSchema,
  unreproducibleReasonSchema,
} from "./provenance.js";

/**
 * Agronomic engine row contracts — Phase 6.1.
 *
 * These describe the two persisted artifacts, `app.suitability_runs` and
 * `app.planting_windows`, exactly as the migration defines them. They are **row
 * contracts, not evaluation contracts**: no scoring rule, threshold, or window
 * generator is implied, and nothing here may be read as an engine specification.
 *
 * The refinements restate SQL `CHECK`s, because a reader must not be able to serve
 * a row that contradicts its own columns:
 *
 * - `status = 'superseded'` exactly when a successor is named;
 * - a numeric score is absent whenever the verdict is `insufficient_data`;
 * - a `suitable` verdict cannot rest on climatology for its critical stage;
 * - `mixedEvidence` reflects the classes the segments actually carry;
 * - `reproducible = false` always states why.
 *
 * `OPEN-26` remains open: the partition of `evidenceSegments ∪ missingRanges`
 * over `[windowStart, windowEnd]` is **not** validated here. `evidenceSegmentSchema`
 * owns the per-segment shape; the interval algebra belongs to a write-path
 * validator that does not exist, and pretending otherwise in a schema would be the
 * silent failure the decision records.
 */

/** `dimension_coverage[].state` — `tables-derived.md` §1. */
export const dimensionCoverageStateSchema = z.enum(["known", "unknown", "not_applicable"]);
export type DimensionCoverageState = z.infer<typeof dimensionCoverageStateSchema>;

/** One dimension's coverage. `not_applicable` is not `unknown`: the rulebook does not judge it. */
export const dimensionCoverageEntrySchema = z.strictObject({
  dimension: z.enum(["climate", "water", "soil", "timing", "risk"]),
  state: dimensionCoverageStateSchema,
});
export type DimensionCoverageEntry = z.infer<typeof dimensionCoverageEntrySchema>;

/**
 * Shares the `A`–`D` vocabulary with `constraints.grade`, so an achievable level
 * is traceable to the evidence behind it. `null` — never `D` — when nothing is
 * `known`.
 */
export const suitabilityLevelSchema = evidenceGradeSchema;

/** `planting_windows.suitability` — `D25`. `poor` is not a verdict. */
export const suitabilityVerdictSchema = z.enum([
  "suitable",
  "conditional",
  "unsuitable",
  "insufficient_data",
]);
export type SuitabilityVerdict = z.infer<typeof suitabilityVerdictSchema>;

export const runStatusSchema = z.enum(["active", "superseded", "failed"]);
export type RunStatus = z.infer<typeof runStatusSchema>;

/**
 * Engine and derivation versions. `physical-model.md` §6 requires only that the
 * columns say something; the scheme is deliberately not parsed here, because
 * inventing a semver grammar would reject a version the database accepts.
 */
export const engineVersionSchema = z.string().min(1);
export const derivationVersionSchema = z.string().min(1);

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * Reproducibility and supersession, as every artifact row states them. Kept as a
 * plain object because the two are fields here, not a discriminated union: the
 * persisted columns are `reproducible` and `unreproducible_reason`.
 */
const artifactStateSchema = z.strictObject({
  reproducible: z.boolean(),
  unreproducibleReason: unreproducibleReasonSchema.nullable(),
  status: runStatusSchema,
  supersedesId: opaqueIdSchema.nullable(),
  supersededById: opaqueIdSchema.nullable(),
});

/**
 * One persisted suitability run. `fieldSnapshot` is the body the engine saw;
 * `fieldSnapshotHash` is duplicated out of it so the pair can be compared and
 * indexed, and both must agree.
 */
export const suitabilityRunSchema = z
  .strictObject({
    id: opaqueIdSchema,
    userId: opaqueIdSchema,
    fieldId: opaqueIdSchema,
    profileVersionId: opaqueIdSchema,
    computedAt: isoInstantSchema,
    engineVersion: engineVersionSchema,
    derivationVersion: derivationVersionSchema,
    dimensionCoverage: z.array(dimensionCoverageEntrySchema),
    maxAchievableLevel: suitabilityLevelSchema.nullable(),
    inputRefs: z.array(dataInputRefSchema),
    fieldSnapshot: fieldSnapshotSchema,
    fieldSnapshotHash: sha256Schema,
    inputSnapshotHash: sha256Schema,
    ...artifactStateSchema.shape,
  })
  .superRefine((run, ctx) => {
    const fail = (path: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message });

    if (run.status === "superseded" && run.supersededById === null) {
      fail("supersededById", "a superseded run names its successor");
    }
    if (run.status !== "superseded" && run.supersededById !== null) {
      fail("supersededById", "only a superseded run carries a successor");
    }
    if (!run.reproducible && run.unreproducibleReason === null) {
      fail("unreproducibleReason", "an unreproducible run states why");
    }
    if (run.reproducible && run.unreproducibleReason !== null) {
      fail("unreproducibleReason", "a reproducible run has no reason to state");
    }
    if (run.fieldSnapshot.fieldSnapshotHash !== run.fieldSnapshotHash) {
      fail("fieldSnapshot", "the stored snapshot must carry the hash it is indexed by");
    }
  });
export type SuitabilityRun = z.infer<typeof suitabilityRunSchema>;

/**
 * One persisted planting window.
 *
 * `score` is a number or absent, never `0` for "unknown", and the verdict carries
 * the reason it is absent. `evaluationBasis` may be `mixed`; `primaryBasis` may
 * not, because it names the basis over the critical stage alone.
 *
 * `risks`, `explanations`, `constraintsEvaluated` and `missingInputs` stay open
 * documents. The engine that gives them meaning is Phase 6.5–6.6; the table
 * claims only that each is an array.
 */
export const plantingWindowSchema = z
  .strictObject({
    id: opaqueIdSchema,
    userId: opaqueIdSchema,
    suitabilityRunId: opaqueIdSchema,
    fieldId: opaqueIdSchema,
    cropId: opaqueIdSchema,
    cultivarId: opaqueIdSchema,
    profileVersionId: opaqueIdSchema,
    windowStart: z.iso.date(),
    windowEnd: z.iso.date(),
    evaluationBasis: evaluationBasisSchema,
    primaryBasis: singleValueEvaluationBasisSchema,
    mixedEvidence: z.boolean(),
    weakestEvidenceClass: weatherDataClassSchema,
    evidenceSegments: z.array(evidenceSegmentSchema),
    missingRanges: z.array(missingRangeSchema),
    suitability: suitabilityVerdictSchema,
    score: z.number().min(0).max(100).nullable(),
    risks: z.array(z.record(z.string(), z.unknown())),
    explanations: z.array(z.record(z.string(), z.unknown())),
    constraintsEvaluated: z.array(z.record(z.string(), z.unknown())),
    missingInputs: z.array(z.record(z.string(), z.unknown())),
    inputRefs: z.array(dataInputRefSchema),
    fieldSnapshotHash: sha256Schema,
    inputSnapshotHash: sha256Schema,
    computedAt: isoInstantSchema,
    ...artifactStateSchema.shape,
  })
  .superRefine((window, ctx) => {
    const fail = (path: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message });

    if (window.windowEnd < window.windowStart) {
      fail("windowEnd", "the window ends before it starts");
    }
    if (window.suitability === "insufficient_data" && window.score !== null) {
      fail("score", "unknown inputs cannot carry a numeric score");
    }
    if (window.primaryBasis === "climatology" && window.suitability === "suitable") {
      fail("suitability", "a suitable verdict cannot rest on climatology at the critical stage");
    }
    if (window.status === "superseded" && window.supersededById === null) {
      fail("supersededById", "a superseded window names its successor");
    }
    if (window.status !== "superseded" && window.supersededById !== null) {
      fail("supersededById", "only a superseded window carries a successor");
    }
    if (!window.reproducible && window.unreproducibleReason === null) {
      fail("unreproducibleReason", "an unreproducible window states why");
    }
    if (window.reproducible && window.unreproducibleReason !== null) {
      fail("unreproducibleReason", "a reproducible window has no reason to state");
    }

    const classes = new Set(window.evidenceSegments.map((segment) => segment.evidenceClass));
    if (window.mixedEvidence !== classes.size > 1) {
      fail("mixedEvidence", "mixedEvidence must reflect the classes the segments carry");
    }
  });
export type PlantingWindow = z.infer<typeof plantingWindowSchema>;

/** A run with the windows it produced, as a detail read would return them. */
export const suitabilityRunWithWindowsSchema = suitabilityRunSchema.extend({
  plantingWindows: z.array(plantingWindowSchema),
});
export type SuitabilityRunWithWindows = z.infer<typeof suitabilityRunWithWindowsSchema>;
