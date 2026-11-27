import { z } from "zod";

import { isoDateSchema, isoInstantSchema } from "./enums.js";

/**
 * Crop catalog contracts — Phase 6.1 read models.
 *
 * The catalog is **global reference data**: no `user_id`, no tenant dimension, no
 * RLS. One published rulebook describes the same crop for every tenant, which is
 * why these schemas carry no farm or field identifier.
 *
 * The only mutation path is a seed run as `migration_owner`. `app_api` holds
 * `SELECT` and nothing else, and a published profile is frozen by a trigger, so
 * these contracts are read-only by construction rather than by convention.
 *
 * Every value below is stored text. The enums repeat the SQL `CHECK`s because a
 * response that cannot be evaluated is worse than a refused row: the reader
 * validates, it does not trust.
 */

/** `constraints.dimension` — closed by `constraints_dimension_check`. */
export const constraintDimensionSchema = z.enum(["climate", "water", "soil", "timing", "risk"]);
export type ConstraintDimension = z.infer<typeof constraintDimensionSchema>;

/**
 * `constraints.comparator` — `window` is in the CHECK vocabulary but rejected by
 * `constraints_window_not_supported_check`, so it never appears in a stored row
 * and never appears here (`OPEN-07`).
 */
export const constraintComparatorSchema = z.enum(["min", "max", "range", "count"]);
export type ConstraintComparator = z.infer<typeof constraintComparatorSchema>;

/** `constraints.grade` and `source_refs.grade` — the evidence scale of the research matrix. */
export const evidenceGradeSchema = z.enum(["A", "B", "C", "D"]);
export type EvidenceGrade = z.infer<typeof evidenceGradeSchema>;

/** `constraints.severity` — hard gate, soft score, or recorded risk. */
export const constraintSeveritySchema = z.enum(["hard", "soft", "risk"]);
export type ConstraintSeverity = z.infer<typeof constraintSeveritySchema>;

export const profileStatusSchema = z.enum(["draft", "published", "retired"]);
export type ProfileStatus = z.infer<typeof profileStatusSchema>;

/** `cultivars.cycle_start` — sowing and transplant are different day-zero events. */
export const cycleStartSchema = z.enum(["sowing", "transplant"]);
export type CycleStart = z.infer<typeof cycleStartSchema>;

/** `crops.slug` — permanent, URL-safe, and never renamed. */
export const cropSlugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/, "slug must be lower-case letters, digits, and hyphens");
export type CropSlug = z.infer<typeof cropSlugSchema>;

export const cropSchema = z.strictObject({
  id: z.uuid(),
  slug: cropSlugSchema,
  nameId: z.string().min(1),
  nameEn: z.string().min(1),
  /** `OPEN-10`: the vocabulary is unsettled, so this is free text, not an enum. */
  category: z.string().min(1),
});
export type Crop = z.infer<typeof cropSchema>;

export const cultivarSchema = z
  .strictObject({
    id: z.uuid(),
    cropId: z.uuid(),
    name: z.string().min(1),
    durationDaysMin: z.number().int().positive(),
    durationDaysTypical: z.number().int().positive(),
    durationDaysMax: z.number().int().positive(),
    cycleStart: cycleStartSchema,
    /** `null` for a direct-sown variety: not `0`, which would claim a stage of no length. */
    nurseryDays: z.number().int().positive().nullable(),
    /** `OPEN-06`: a real property with no settled representation. */
    photoperiodSensitivity: z.string().min(1).nullable(),
    altitudeMinM: z.number().int().nonnegative().nullable(),
    altitudeMaxM: z.number().int().nonnegative().nullable(),
  })
  .superRefine((cultivar, ctx) => {
    if (cultivar.durationDaysMin > cultivar.durationDaysTypical) {
      ctx.addIssue({
        code: "custom",
        path: ["durationDaysMin"],
        message: "durationDaysMin cannot exceed durationDaysTypical",
      });
    }
    if (cultivar.durationDaysTypical > cultivar.durationDaysMax) {
      ctx.addIssue({
        code: "custom",
        path: ["durationDaysTypical"],
        message: "durationDaysTypical cannot exceed durationDaysMax",
      });
    }
    if (
      cultivar.altitudeMinM !== null &&
      cultivar.altitudeMaxM !== null &&
      cultivar.altitudeMinM > cultivar.altitudeMaxM
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["altitudeMinM"],
        message: "altitudeMinM cannot exceed altitudeMaxM",
      });
    }
  });
export type Cultivar = z.infer<typeof cultivarSchema>;

/** One version's identity and lifecycle. The content is fetched separately. */
export const cropProfileVersionSummarySchema = z
  .strictObject({
    id: z.uuid(),
    cultivarId: z.uuid(),
    ruleVersion: z.string().min(1),
    status: profileStatusSchema,
    /** Set exactly once, when the version becomes `published`. */
    publishedAt: isoInstantSchema.nullable(),
    supersedesId: z.uuid().nullable(),
  })
  .superRefine((version, ctx) => {
    if ((version.status === "draft") !== (version.publishedAt === null)) {
      ctx.addIssue({
        code: "custom",
        path: ["publishedAt"],
        message: "a draft carries no publication instant; a published or retired version does",
      });
    }
  });
export type CropProfileVersionSummary = z.infer<typeof cropProfileVersionSummarySchema>;

/** Inclusive day offsets from the cultivar's cycle start. */
export const growthStageSchema = z
  .strictObject({
    id: z.uuid(),
    name: z.string().min(1),
    startDayOffset: z.number().int().nonnegative(),
    endDayOffset: z.number().int().nonnegative(),
    isCritical: z.boolean(),
    /** `OPEN-08`: no type decided, so unconstrained text and unread by the engine. */
    requirementProfile: z.string().min(1).nullable(),
  })
  .superRefine((stage, ctx) => {
    if (stage.startDayOffset > stage.endDayOffset) {
      ctx.addIssue({
        code: "custom",
        path: ["startDayOffset"],
        message: "startDayOffset cannot exceed endDayOffset",
      });
    }
  });
export type GrowthStage = z.infer<typeof growthStageSchema>;

/**
 * One threshold row. Exactly one of the three typed thresholds is populated, and
 * which one is decided by `comparator` — the same shape rule the SQL `CHECK`
 * enforces, restated so a reader cannot serve an unevaluable predicate.
 */
export const constraintSchema = z
  .strictObject({
    id: z.uuid(),
    dimension: constraintDimensionSchema,
    comparator: constraintComparatorSchema,
    thresholdLower: z.number().nullable(),
    thresholdUpper: z.number().nullable(),
    thresholdCount: z.number().int().nonnegative().nullable(),
    unit: z.string().min(1).nullable(),
    /** `null` = the rule applies to the whole cycle. */
    growthStageId: z.uuid().nullable(),
    grade: evidenceGradeSchema,
    severity: constraintSeveritySchema,
  })
  .superRefine((constraint, ctx) => {
    const fail = (path: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message });

    switch (constraint.comparator) {
      case "min":
        if (constraint.thresholdLower === null)
          fail("thresholdLower", "min requires a lower bound");
        if (constraint.thresholdUpper !== null) fail("thresholdUpper", "min has no upper bound");
        if (constraint.thresholdCount !== null) fail("thresholdCount", "min has no count");
        if (constraint.unit === null) fail("unit", "min requires a unit");
        break;
      case "max":
        if (constraint.thresholdUpper === null)
          fail("thresholdUpper", "max requires an upper bound");
        if (constraint.thresholdLower !== null) fail("thresholdLower", "max has no lower bound");
        if (constraint.thresholdCount !== null) fail("thresholdCount", "max has no count");
        if (constraint.unit === null) fail("unit", "max requires a unit");
        break;
      case "range":
        if (constraint.thresholdLower === null)
          fail("thresholdLower", "range requires a lower bound");
        if (constraint.thresholdUpper === null)
          fail("thresholdUpper", "range requires an upper bound");
        if (
          constraint.thresholdLower !== null &&
          constraint.thresholdUpper !== null &&
          constraint.thresholdLower > constraint.thresholdUpper
        ) {
          fail("thresholdLower", "thresholdLower cannot exceed thresholdUpper");
        }
        if (constraint.thresholdCount !== null) fail("thresholdCount", "range has no count");
        if (constraint.unit === null) fail("unit", "range requires a unit");
        break;
      case "count":
        if (constraint.thresholdCount === null) fail("thresholdCount", "count requires a count");
        if (constraint.thresholdLower !== null) fail("thresholdLower", "count has no lower bound");
        if (constraint.thresholdUpper !== null) fail("thresholdUpper", "count has no upper bound");
        if (constraint.unit !== null) fail("unit", "count has no unit");
        break;
    }
  });
export type Constraint = z.infer<typeof constraintSchema>;

/** A resolved citation. An unresolved one cannot be stored: the columns are non-blank. */
export const sourceRefSchema = z.strictObject({
  id: z.uuid(),
  title: z.string().min(1),
  authors: z.string().min(1).nullable(),
  publicationYear: z.number().int().min(1900).max(2100),
  publisher: z.string().min(1),
  url: z.url(),
  accessedAt: isoDateSchema,
  grade: evidenceGradeSchema,
});
export type SourceRef = z.infer<typeof sourceRefSchema>;

/**
 * A complete rulebook: identity, stages, thresholds, and the sources that justify
 * them. Stages and constraints are separate arrays; a constraint names a stage by
 * id when it is stage-scoped.
 */
export const cropProfileVersionSchema = cropProfileVersionSummarySchema.extend({
  growthStages: z.array(growthStageSchema),
  constraints: z.array(constraintSchema),
  sourceRefs: z.array(sourceRefSchema),
});
export type CropProfileVersion = z.infer<typeof cropProfileVersionSchema>;

/** A cultivar and the versions that ever existed for it, newest first. */
export const cultivarWithProfilesSchema = cultivarSchema.extend({
  profileVersions: z.array(cropProfileVersionSummarySchema),
});
export type CultivarWithProfiles = z.infer<typeof cultivarWithProfilesSchema>;

export const cropDetailSchema = cropSchema.extend({
  cultivars: z.array(cultivarWithProfilesSchema),
});
export type CropDetail = z.infer<typeof cropDetailSchema>;

export const cropListSchema = z.strictObject({
  crops: z.array(cropSchema),
});
export type CropList = z.infer<typeof cropListSchema>;
