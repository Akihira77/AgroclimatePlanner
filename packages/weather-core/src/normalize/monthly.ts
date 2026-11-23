import { failure, type AdapterOutcome, type NormalizationFailure } from "../failures.js";
import type { ProviderMonth, Seas5MonthlyPayload } from "../adapters/open-meteo-seasonal.js";
import type { DailyProviderPayload } from "../adapters/open-meteo-daily.js";
import {
  daysInMonth,
  formatMonthKey,
  isConsecutiveMonth,
  parseCalendarMonth,
} from "../calendar-month.js";

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

/* ------------------------------------------------------------------ *
 * SEAS5 per-member monthly aggregation — ADR-001 D8b
 * ------------------------------------------------------------------ */

/**
 * The monthly aggregate of one member's daily sums.
 *
 * D8b says members are ephemeral and aggregates are the system of record, so the
 * aggregation happens here, at ingest, and the daily members are not stored.
 *
 * The rule is deliberately the strict one:
 *
 * - a member-month is a **sum of that member's daily `precipitation_sum` values**
 *   over the calendar month, which is what the provider's own
 *   `precipitation_mean` is the ensemble mean of (verified 2026-11-23);
 * - it is stored only when the axis covers **every** day of the month and every
 *   one of those days carries a value for that member. A missing day is not `0`:
 *   an incomplete month is `null` with a reason, never a partial sum presented as
 *   a monthly total;
 * - nothing is divided, converted or bias-corrected. `unit` stays `mm` and no
 *   monthly-mean-to-accumulation conversion is attempted.
 */
export const MONTHLY_MEMBER_AGGREGATION_VERSION = "monthly-member-aggregation@1.0.0";
/** `monthly_sum` is already in the OPEN-14 vocabulary: a sum over a calendar month. */
export const MONTHLY_MEMBER_AGGREGATION_LEVEL = "monthly_sum";

/**
 * Why a member-month has no total. This is a **normalizer-level** result, the
 * same shape `NormalizedMonth.missingReason` already uses: `weather_records`
 * has no reason column, so the reason is carried in memory and the stored row
 * keeps `value = null`. It is never `0`, and it never stands in for a partial
 * sum.
 *
 * - `axis_incomplete` — the daily axis itself lacks a calendar day of the
 *   month, so no member can be complete. The SEAS5 member adapter refuses this
 *   before aggregation; the reason exists for any other caller of this function.
 * - `member_incomplete` — the axis covers the month but this member has no entry
 *   for one or more of its days.
 * - `provider_null` — every day of the month is present for this member and at
 *   least one of those days is a provider null.
 */
export type MonthlyMemberMissingReason = "axis_incomplete" | "member_incomplete" | "provider_null";

export interface NormalizedMonthlyMemberValue {
  readonly cellKey: string;
  /**
   * The provider's own daily quantity, kept as the monthly aggregate's variable.
   * It is deliberately **not** `precipitation` and **not** `precipitation_mean`:
   * supersession matches on `(cell, variable, valid_at, member)` across runs and
   * products, so a seasonal monthly total must not share a key with a daily
   * subseasonal value on the first of the month.
   */
  readonly variable: "precipitation_sum";
  readonly unit: typeof SUPPORTED_PRECIPITATION_UNIT;
  /** First day of the month, `00:00Z`. */
  readonly validAt: string;
  /** The member's monthly total in `mm`, or `null` when the month is incomplete. */
  readonly value: number | null;
  /** Why `value` is null; `null` exactly when the total is present. */
  readonly missingReason: MonthlyMemberMissingReason | null;
  readonly temporalResolution: "monthly";
  readonly ensembleMember: number;
  readonly ensembleSize: number;
  readonly aggregationLevel: typeof MONTHLY_MEMBER_AGGREGATION_LEVEL;
}

export interface NormalizedMonthlyMemberSeries {
  readonly aggregationVersion: string;
  readonly months: readonly string[];
  readonly ensembleSize: number;
  readonly values: readonly NormalizedMonthlyMemberValue[];
}

export function aggregateMonthlyMemberTotals(
  payload: DailyProviderPayload,
  cellKey: string,
): AdapterOutcome<NormalizedMonthlyMemberSeries> {
  if (payload.unit !== SUPPORTED_PRECIPITATION_UNIT) {
    return failure(
      "unsupported_unit",
      `member precipitation is reported in "${payload.unit}"; only "mm" is accepted and no conversion is defined`,
    );
  }
  if (payload.days.length === 0) {
    return failure("invalid_payload", "the payload carries no daily member values");
  }

  const memberIds = new Set<number>();
  /** `month` → `member` → `day` → value. A duplicate day is refused, not summed twice. */
  const byMonth = new Map<string, Map<number, Map<string, number | null>>>();
  /** The union of every member's days, per month: the axis the payload actually covers. */
  const axisDays = new Map<string, Set<string>>();
  const months: string[] = [];

  for (const day of payload.days) {
    if (day.member === null) {
      return failure("invalid_payload", "a deterministic value cannot be aggregated as a member");
    }
    const monthKey = `${day.date.slice(0, 7)}-01`;
    const parsedMonth = parseCalendarMonth(monthKey);
    if (parsedMonth === null || formatMonthKey(parsedMonth) !== monthKey) {
      return failure("invalid_payload", `daily date "${day.date}" is not a calendar day`);
    }
    // `2026-02-30` has a valid month prefix but is not a day; without this the
    // calendar-day count could be reached by an impossible date.
    const instant = Date.parse(`${day.date}T00:00:00.000Z`);
    if (Number.isNaN(instant) || new Date(instant).toISOString().slice(0, 10) !== day.date) {
      return failure("invalid_payload", `daily date "${day.date}" is not a calendar day`);
    }
    if (day.value !== null && (!Number.isFinite(day.value) || day.value < 0)) {
      return failure(
        "invalid_payload",
        `member ${day.member + 1} on ${day.date} is not a finite non-negative amount`,
      );
    }
    memberIds.add(day.member);

    let month = byMonth.get(monthKey);
    if (month === undefined) {
      month = new Map();
      byMonth.set(monthKey, month);
      axisDays.set(monthKey, new Set());
      months.push(monthKey);
    }
    (axisDays.get(monthKey) as Set<string>).add(day.date);
    let member = month.get(day.member);
    if (member === undefined) {
      member = new Map();
      month.set(day.member, member);
    }
    if (member.has(day.date)) {
      return failure("invalid_payload", `member ${day.member + 1} repeats ${day.date}`);
    }
    member.set(day.date, day.value);
  }

  months.sort();
  const ensembleSize = memberIds.size;
  const values: NormalizedMonthlyMemberValue[] = [];

  for (const monthKey of months) {
    const calendarMonth = parseCalendarMonth(monthKey);
    if (calendarMonth === null) {
      return failure("invalid_payload", `"${monthKey}" is not a calendar month`);
    }
    const expectedDays = daysInMonth(calendarMonth);
    const month = byMonth.get(monthKey) as Map<number, Map<string, number | null>>;
    const axisCoversMonth = (axisDays.get(monthKey) as Set<string>).size === expectedDays;

    for (const memberId of [...memberIds].sort((a, b) => a - b)) {
      const days = month.get(memberId);
      // A month the axis never reached is incomplete, not dry.
      const memberCoversMonth = days !== undefined && days.size === expectedDays;
      let total: number | null = null;
      let missingReason: MonthlyMemberMissingReason | null = null;
      if (!axisCoversMonth) {
        missingReason = "axis_incomplete";
      } else if (!memberCoversMonth) {
        missingReason = "member_incomplete";
      } else {
        let sum = 0;
        let allValued = true;
        for (const value of (days as Map<string, number | null>).values()) {
          if (value === null) {
            allValued = false;
            break;
          }
          sum += value;
        }
        if (allValued) {
          total = sum;
        } else {
          missingReason = "provider_null";
        }
      }
      values.push({
        cellKey,
        variable: "precipitation_sum",
        unit: SUPPORTED_PRECIPITATION_UNIT,
        validAt: `${monthKey}T00:00:00.000Z`,
        value: total,
        missingReason,
        temporalResolution: "monthly",
        ensembleMember: memberId,
        ensembleSize,
        aggregationLevel: MONTHLY_MEMBER_AGGREGATION_LEVEL,
      });
    }
  }

  return {
    ok: true,
    value: Object.freeze({
      aggregationVersion: MONTHLY_MEMBER_AGGREGATION_VERSION,
      months: Object.freeze(months),
      ensembleSize,
      values: Object.freeze(values),
    }),
  };
}
