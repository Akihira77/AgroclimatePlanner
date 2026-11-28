import { z } from "zod";

/**
 * The four axes are independent (docs/architecture/provenance-contract.md §1).
 * They are separate fields here for the same reason they are separate there:
 * one number can be monthly, seasonal, stale, and reproducible at once.
 */

/** ADR-001 D9. `temporalClass` is deprecated and must not appear. */
export const weatherDataClassSchema = z.enum([
  "field_observation",
  "station_observation",
  "satellite_estimate",
  "reanalysis",
  "weather_forecast",
  "subseasonal_forecast",
  "seasonal_forecast",
  "annual_outlook",
  "climatology",
]);
export type WeatherDataClass = z.infer<typeof weatherDataClassSchema>;

/**
 * `mixed` is only legal at container level — a window or an outlook. A single
 * value carrying `mixed` is a modelling bug, which is why segments use the
 * narrower enum below.
 */
export const evaluationBasisSchema = z.enum(["daily", "weekly", "monthly", "climatology", "mixed"]);
export type EvaluationBasis = z.infer<typeof evaluationBasisSchema>;

export const singleValueEvaluationBasisSchema = z.enum([
  "daily",
  "weekly",
  "monthly",
  "climatology",
]);
export type SingleValueEvaluationBasis = z.infer<typeof singleValueEvaluationBasisSchema>;

/** `stale` is usable; `unavailable` is not. Never collapse them. */
export const dataAvailabilitySchema = z.enum([
  "available",
  "stale",
  "pending",
  "unavailable",
  "not_applicable",
]);
export type DataAvailability = z.infer<typeof dataAvailabilitySchema>;

/** `beyond_horizon` is structural. `ingest_failed` is a failure. Not interchangeable. */
export const missingReasonSchema = z.enum([
  "beyond_horizon",
  "not_requested",
  "pending",
  "ingest_failed",
  "provider_unavailable",
  "insufficient_history",
  "below_coverage_threshold",
]);
export type MissingReason = z.infer<typeof missingReasonSchema>;

/**
 * Explicit irrigation availability vocabulary (`OPEN-21`). Preserves partial
 * and unknown states instead of collapsing to a lossy boolean.
 */
export const irrigationAvailabilitySchema = z.enum([
  "irrigated",
  "partial_irrigation",
  "rainfed",
  "unknown",
]);
export type IrrigationAvailability = z.infer<typeof irrigationAvailabilitySchema>;

/**
 * Closed soil-type vocabulary (`OPEN-21`). `null` means unknown/not yet supplied;
 * `"unknown"` means explicitly recorded as unknown.
 */
export const soilTypeSchema = z.enum([
  "clay",
  "loam",
  "sandy",
  "clay_loam",
  "sandy_loam",
  "silt_loam",
  "peat",
  "alluvial",
  "volcanic",
  "unknown",
]);
export type SoilType = z.infer<typeof soilTypeSchema>;

/**
 * Closed drainage-class vocabulary (`OPEN-21`).
 */
export const drainageClassSchema = z.enum(["poor", "moderate", "well", "excessive", "unknown"]);
export type DrainageClass = z.infer<typeof drainageClassSchema>;

/**
 * ISO 8601 calendar date, interpreted in Asia/Jakarta wherever a date appears.
 * Calendar validity is checked, not just shape: `2026-02-31` and `2026-13-01`
 * are rejected, `2024-02-29` is accepted.
 */
export const isoDateSchema = z.iso.date();
export type IsoDate = z.infer<typeof isoDateSchema>;

/**
 * ISO 8601 instant, **UTC only**. `z.iso.datetime()` without `offset: true`
 * requires the `Z` suffix and rejects `+07:00`, so the contract has exactly one
 * representation. Values are rejected rather than normalised: silent conversion
 * would store a different string from the one the provider published.
 */
export const isoInstantSchema = z.iso.datetime();
export type IsoInstant = z.infer<typeof isoInstantSchema>;

/**
 * Identity strings are opaque here. Ids are UUIDv7 and hashes are sha256 hex,
 * but the contract does not re-validate their format: an id minted by another
 * layer must not be rejected by a regex that drifts from its producer.
 */
export const opaqueIdSchema = z.string().min(1);
