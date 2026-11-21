import { failure, type NormalizationFailure } from "../failures.js";
import type { ProviderMonth, Seas5MonthlyPayload } from "../adapters/open-meteo-seasonal.js";
import { formatMonthKey, isConsecutiveMonth, parseCalendarMonth } from "../calendar-month.js";

/**
 * Monthly normalizer: provider-native series in, the same series with validated
 * months, values, and units out.
 *
 * It changes **nothing scientific**. `precipitation_mean` keeps its name, its
 * unit, and its value; no monthly total is computed, no anomaly is derived, no
 * climatology is substituted, and no `valueMm` field exists because the domain
 * has not decided what that column means for a `precipitation_mean` row (F-09).
 *
 * The only work it does is the work that can be proven: the month key is a
 * first-of-month date, the axis is continuous (each month the calendar successor
 * of the previous), a null stays null, and a negative precipitation amount is
 * refused rather than clamped to zero.
 */

export const MONTHLY_NORMALIZER_VERSION = "monthly-normalizer@1.0.0";
export const SUPPORTED_PRECIPITATION_UNIT = "mm";

export interface NormalizedMonth {
  readonly month: string;
  /** Unchanged provider value, in `nativeUnit`. */
  readonly nativeValue: number | null;
  /** `provider_null` when the series carried null; never an inferred "0". */
  readonly missingReason: "provider_null" | null;
}

export interface NormalizedMonthlySeries {
  readonly provider: Seas5MonthlyPayload["provider"];
  readonly model: Seas5MonthlyPayload["model"];
  readonly product: Seas5MonthlyPayload["product"];
  /** The provider's variable name, preserved. */
  readonly quantity: Seas5MonthlyPayload["variable"];
  readonly nativeUnit: string;
  readonly months: readonly NormalizedMonth[];
  readonly presentMonths: number;
  readonly nullMonths: number;
  readonly adapterVersion: string;
  readonly normalizerVersion: string;
  readonly initializedAt: string;
  readonly initializedAtSource: Seas5MonthlyPayload["initializedAtSource"];
  readonly attribution: string;
  readonly requestedLatitude: number;
  readonly requestedLongitude: number;
  readonly servedLatitude: number;
  readonly servedLongitude: number;
  readonly sourceUrl: string;
  readonly receivedAt: string;
  readonly rawPayloadRef: null;
  readonly reproducibility: {
    readonly reproducible: false;
    readonly reason: "raw_payload_not_retained";
  };
}

export function normalizeMonthlySeries(
  payload: Seas5MonthlyPayload,
): NormalizedMonthlySeries | NormalizationFailure {
  const unit = payload.unit.trim();
  if (unit !== SUPPORTED_PRECIPITATION_UNIT) {
    const shown = unit.length > 40 ? `${unit.slice(0, 40)}…` : unit;
    return failure(
      "unsupported_unit",
      `precipitation_mean is reported in "${shown}"; only "mm" is accepted and no conversion is defined`,
    );
  }

  if (payload.months.length === 0) {
    return failure("invalid_payload", "monthly series is empty");
  }

  const months: NormalizedMonth[] = [];
  let previous: string | null = null;
  let presentMonths = 0;
  let nullMonths = 0;

  for (let index = 0; index < payload.months.length; index += 1) {
    const entry = payload.months[index] as ProviderMonth;
    const calendarMonth = parseCalendarMonth(entry.month);
    if (calendarMonth === null || formatMonthKey(calendarMonth) !== entry.month) {
      return failure("invalid_payload", `months[${index}] is not a first-of-month key`);
    }
    // Same rule as the adapter, and for the same reason: another source may hand
    // this normalizer a series, and an ordered series is not a continuous one.
    if (previous !== null && !isConsecutiveMonth(previous, entry.month)) {
      return failure(
        "invalid_payload",
        `months[${index}] is ${entry.month}, expected the month after ${previous}`,
      );
    }
    previous = entry.month;

    if (entry.value === null) {
      nullMonths += 1;
      months.push({ month: entry.month, nativeValue: null, missingReason: "provider_null" });
      continue;
    }
    if (!Number.isFinite(entry.value) || entry.value < 0) {
      return failure(
        "invalid_payload",
        `months[${index}] is not a finite non-negative precipitation amount`,
      );
    }
    presentMonths += 1;
    months.push({ month: entry.month, nativeValue: entry.value, missingReason: null });
  }

  // Annotated before freezing: `Object.freeze` widens `reproducible: false` to
  // `boolean`, which no longer satisfies the declared literal type.
  const series: NormalizedMonthlySeries = {
    provider: payload.provider,
    model: payload.model,
    product: payload.product,
    quantity: payload.variable,
    nativeUnit: unit,
    months: Object.freeze(months),
    presentMonths,
    nullMonths,
    adapterVersion: payload.adapterVersion,
    normalizerVersion: MONTHLY_NORMALIZER_VERSION,
    initializedAt: payload.initializedAt,
    initializedAtSource: payload.initializedAtSource,
    attribution: payload.attribution,
    requestedLatitude: payload.requestedLatitude,
    requestedLongitude: payload.requestedLongitude,
    servedLatitude: payload.servedLatitude,
    servedLongitude: payload.servedLongitude,
    sourceUrl: payload.sourceUrl,
    receivedAt: payload.receivedAt,
    rawPayloadRef: null,
    reproducibility: { reproducible: false, reason: "raw_payload_not_retained" },
  };
  return Object.freeze(series);
}
