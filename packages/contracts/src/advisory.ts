import { z } from "zod";

import { suitabilityVerdictSchema } from "./agronomy.js";
import { cropSlugSchema } from "./crop.js";
import { isoDateSchema, isoInstantSchema, opaqueIdSchema } from "./enums.js";

export const seasonCategorySchema = z.enum(["wet", "transition", "dry", "missing"]);
export type SeasonCategoryDto = z.infer<typeof seasonCategorySchema>;

export const dashboardCurrentMonthSeasonSchema = z.strictObject({
  category: seasonCategorySchema,
  month: isoDateSchema,
  valueMm: z.number().nonnegative().nullable(),
  summaryId: z.string().min(1),
});
export type DashboardCurrentMonthSeason = z.infer<typeof dashboardCurrentMonthSeasonSchema>;

export const dashboardFieldWeatherSchema = z.strictObject({
  fieldId: opaqueIdSchema,
  fieldName: z.string().min(1),
  farmName: z.string().min(1),
  hasData: z.boolean(),
  horizonDays: z.number().int().nonnegative(),
  totalRainMm: z.number().nonnegative().nullable(),
  peakRainDate: isoDateSchema.nullable(),
  peakRainMm: z.number().nonnegative().nullable(),
  advisoryTextId: z.string().min(1),
  dataSourceLabel: z.string().min(1),
});
export type DashboardFieldWeather = z.infer<typeof dashboardFieldWeatherSchema>;

export const dashboardCriticalStageAlertSchema = z.strictObject({
  plantingId: opaqueIdSchema,
  fieldId: opaqueIdSchema,
  fieldName: z.string().min(1),
  cropNameId: z.string().min(1),
  cultivarName: z.string().min(1),
  stageName: z.string().min(1),
  status: z.enum(["in_critical", "approaching_critical"]),
  daysUntilStart: z.number().int(),
  stageStartDate: isoDateSchema,
  stageEndDate: isoDateSchema,
  weatherSummaryId: z.string().min(1),
});
export type DashboardCriticalStageAlert = z.infer<typeof dashboardCriticalStageAlertSchema>;

export const dashboardAdvisorySchema = z.strictObject({
  generatedAt: isoInstantSchema,
  indicativeLabel: z.string().min(1),
  currentMonthSeason: dashboardCurrentMonthSeasonSchema,
  fieldWeather: z.array(dashboardFieldWeatherSchema),
  criticalStageAlerts: z.array(dashboardCriticalStageAlertSchema),
});
export type DashboardAdvisory = z.infer<typeof dashboardAdvisorySchema>;

export const fieldRecommendationsQuerySchema = z.strictObject({
  horizonMonths: z.coerce
    .number()
    .int()
    .refine((v) => v === 3 || v === 6 || v === 12, {
      message: "horizonMonths must be 3, 6, or 12",
    })
    .default(6),
});
export type FieldRecommendationsQuery = z.infer<typeof fieldRecommendationsQuerySchema>;

export const cropRecommendationMatrixCellSchema = z.strictObject({
  month: isoDateSchema,
  verdict: suitabilityVerdictSchema,
  evidenceClass: z.string().min(1).nullable(),
  rainfallMm: z.number().nonnegative().nullable(),
  noteId: z.string().min(1),
});
export type CropRecommendationMatrixCell = z.infer<typeof cropRecommendationMatrixCellSchema>;

export const cropRecommendationRankingSchema = z.strictObject({
  cropId: opaqueIdSchema,
  cropSlug: cropSlugSchema,
  cropNameId: z.string().min(1),
  category: z.string().min(1),
  cultivarId: opaqueIdSchema,
  cultivarName: z.string().min(1),
  profileVersionId: opaqueIdSchema,
  durationDaysTypical: z.number().int().positive(),
  verdict: suitabilityVerdictSchema,
  bestStartMonth: isoDateSchema.nullable(),
  evidenceBadge: z.string().min(1),
  summaryId: z.string().min(1),
  keyFactorId: z.string().min(1),
});
export type CropRecommendationRanking = z.infer<typeof cropRecommendationRankingSchema>;

export const cropRecommendationMatrixRowSchema = z.strictObject({
  cropId: opaqueIdSchema,
  cropSlug: cropSlugSchema,
  cropNameId: z.string().min(1),
  cultivarName: z.string().min(1),
  profileVersionId: opaqueIdSchema,
  cells: z.array(cropRecommendationMatrixCellSchema).length(12),
});
export type CropRecommendationMatrixRow = z.infer<typeof cropRecommendationMatrixRowSchema>;

export const fieldRecommendationsSchema = z.strictObject({
  fieldId: opaqueIdSchema,
  fieldName: z.string().min(1),
  horizonMonths: z.union([z.literal(3), z.literal(6), z.literal(12)]),
  indicativeNotice: z.string().min(1),
  months: z.array(isoDateSchema).length(12),
  rankings: z.array(cropRecommendationRankingSchema),
  matrix: z.array(cropRecommendationMatrixRowSchema),
});
export type FieldRecommendations = z.infer<typeof fieldRecommendationsSchema>;
