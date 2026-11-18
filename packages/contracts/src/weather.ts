import { z } from "zod";
import {
  dataAvailabilitySchema,
  evaluationBasisSchema,
  isoInstantSchema,
  missingReasonSchema,
  opaqueIdSchema,
  type DataAvailability,
  type EvaluationBasis,
  type MissingReason,
} from "./enums.js";

/**
 * Freshness of one source. Computed at read time; nothing writes it except
 * `reason: "recompute_failed"`, which is an event drawn from stored state
 * (provenance-contract.md §5).
 */
export const sourceFreshnessSchema = z.strictObject({
  kind: z.literal("source"),
  dataAvailability: dataAvailabilitySchema,
  initializedAt: isoInstantSchema.optional(),
  validAt: isoInstantSchema.optional(),
  ageSeconds: z.number().nonnegative().optional(),
  ttlSeconds: z.number().nonnegative().optional(),
  reason: missingReasonSchema.optional(),
});
export type SourceFreshness = z.infer<typeof sourceFreshnessSchema>;

export interface SourceFreshnessType {
  kind: "source";
  dataAvailability: DataAvailability;
  initializedAt?: string;
  validAt?: string;
  ageSeconds?: number;
  ttlSeconds?: number;
  reason?: MissingReason;
}

/** Fields every variant carries. `dataClass` is added per variant as a literal. */
const valueBase = {
  evaluationBasis: evaluationBasisSchema,
  dataAvailability: dataAvailabilitySchema,
  amount: z.number().optional(),
  unit: z.string().min(1),
  spatialResolutionKm: z.number().positive(),
  servedValueIsInterpolated: z.boolean(),
  freshness: sourceFreshnessSchema,
  attribution: z.string().min(1),
};

const forecastSourceSchema = z.strictObject({
  provider: z.string().min(1),
  model: z.string().min(1),
  modelVersion: z.string().min(1).optional(),
  forecastRunId: opaqueIdSchema,
  ingestionRunId: opaqueIdSchema,
  initializedAt: isoInstantSchema,
});

/** weather_forecast | subseasonal_forecast | seasonal_forecast | annual_outlook */
const forecastValueSchema = z.strictObject({
  ...valueBase,
  dataClass: z.literal([
    "weather_forecast",
    "subseasonal_forecast",
    "seasonal_forecast",
    "annual_outlook",
  ]),
  source: forecastSourceSchema,
});

const baselineSchema = z.strictObject({
  baselineVersion: z.string().min(1),
  periodFrom: z.string().min(1),
  periodTo: z.string().min(1),
});

/**
 * Climatology carries no forecast provenance. `source?: never` and
 * `initializedAt?: never` turn a mislabelled climatology into a validation
 * failure instead of a display bug.
 */
const baselineValueSchema = z.strictObject({
  ...valueBase,
  dataClass: z.literal("climatology"),
  baseline: baselineSchema,
  source: z.never().optional(),
  initializedAt: z.never().optional(),
});

const datasetSchema = z.strictObject({
  provider: z.string().min(1),
  name: z.string().min(1),
  datasetVersion: z.string().min(1),
  validAt: isoInstantSchema,
});

/** reanalysis | satellite_estimate */
const datasetValueSchema = z.strictObject({
  ...valueBase,
  dataClass: z.literal(["reanalysis", "satellite_estimate"]),
  dataset: datasetSchema,
  initializedAt: z.never().optional(),
});

const observationSchema = z.strictObject({
  observationId: opaqueIdSchema,
  observedAt: isoInstantSchema,
  method: z.string().min(1),
});

/** field_observation — the only class allowed to say "observed". */
const observationValueSchema = z.strictObject({
  ...valueBase,
  dataClass: z.literal("field_observation"),
  observation: observationSchema,
  source: z.never().optional(),
  initializedAt: z.never().optional(),
});

/**
 * The union is discriminated on `dataClass`, and that is the only place the
 * class is stated. There is no `displayedClass` escape hatch.
 */
export const weatherValueSchema = z
  .discriminatedUnion("dataClass", [
    forecastValueSchema,
    baselineValueSchema,
    datasetValueSchema,
    observationValueSchema,
  ])
  .superRefine((value, ctx) => {
    // Absent, not zero. A 0 here would be a fabricated measurement.
    const nonUsable: ReadonlyArray<DataAvailability> = ["pending", "unavailable", "not_applicable"];
    if (value.amount !== undefined && nonUsable.includes(value.dataAvailability)) {
      ctx.addIssue({
        code: "custom",
        path: ["amount"],
        message: `amount must be absent when dataAvailability is "${value.dataAvailability}"`,
      });
    }
  });

export type WeatherValue = z.infer<typeof weatherValueSchema>;
export type ForecastValue = z.infer<typeof forecastValueSchema>;
export type BaselineValue = z.infer<typeof baselineValueSchema>;
export type DatasetValue = z.infer<typeof datasetValueSchema>;
export type ObservationValue = z.infer<typeof observationValueSchema>;

export type { EvaluationBasis };
