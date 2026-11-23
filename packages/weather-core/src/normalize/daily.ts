import { failure, type AdapterOutcome } from "../failures.js";
import type { DailyProviderPayload } from "../adapters/open-meteo-daily.js";

/**
 * Daily precipitation normalizer.
 *
 * It maps one provider payload onto the storage vocabulary and nothing else: no
 * interpolation, no zero-filling, no unit guessing. A null stays null — a
 * missing value is horizon evidence, and `weather_records` keeps it.
 *
 * `aggregation_level` is `daily_sum` because `precipitation_sum` is an
 * accumulation over the provider's day. Temperature is deliberately absent: the
 * OPEN-14 vocabulary has no `daily_max`, and inventing one here would put an
 * unapproved term in a provenance column.
 */

export const DAILY_NORMALIZER_VERSION = "daily-precipitation@1.0.0";
export const SUPPORTED_DAILY_UNIT = "mm";

export interface NormalizedForecastValue {
  readonly cellKey: string;
  readonly variable: "precipitation";
  readonly unit: typeof SUPPORTED_DAILY_UNIT;
  /** The instant the value describes: the provider day's 00:00Z. */
  readonly validAt: string;
  readonly value: number | null;
  readonly temporalResolution: "daily";
  readonly ensembleMember: number | null;
  readonly ensembleSize: number | null;
  readonly aggregationLevel: "daily_sum";
}

export interface NormalizedDailySeries {
  readonly normalizerVersion: string;
  readonly values: readonly NormalizedForecastValue[];
}

export function normalizeDailyPrecipitation(
  payload: DailyProviderPayload,
  cellKey: string,
): AdapterOutcome<NormalizedDailySeries> {
  if (payload.unit !== SUPPORTED_DAILY_UNIT) {
    return failure(
      "unsupported_unit",
      `packages/weather-core has no approved conversion for "${payload.unit}"; expected ${SUPPORTED_DAILY_UNIT}`,
    );
  }
  if (payload.days.length === 0) {
    return failure("invalid_payload", "the payload carries no daily values");
  }

  const values: NormalizedForecastValue[] = [];
  for (const day of payload.days) {
    const parsed = Date.parse(`${day.date}T00:00:00.000Z`);
    if (Number.isNaN(parsed)) {
      return failure("invalid_payload", `daily date "${day.date}" is not a calendar day`);
    }
    values.push({
      cellKey,
      variable: "precipitation",
      unit: SUPPORTED_DAILY_UNIT,
      validAt: new Date(parsed).toISOString(),
      value: day.value,
      temporalResolution: "daily",
      ensembleMember: day.member,
      ensembleSize: day.member === null ? null : payload.ensembleSize,
      aggregationLevel: "daily_sum",
    });
  }

  return {
    ok: true,
    value: Object.freeze({
      normalizerVersion: DAILY_NORMALIZER_VERSION,
      values: Object.freeze(values),
    }),
  };
}
