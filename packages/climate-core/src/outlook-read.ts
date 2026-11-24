import type {
  ClimateOutlookMonth,
  MonthlyOutlookEstimator,
  OutlookEvaluationBasis,
  WeatherDataClass,
  MissingReason,
} from "@agroclimate/contracts";
import {
  calendarMonthOf,
  climateOutlookMonthSchema,
  estimatorForDataClass,
  LEAD_MONTHS,
} from "@agroclimate/contracts";

import { NO_FORECAST_SOURCE_REASON, SPREAD_REASON_NO_VALUE } from "./aggregate.js";

/**
 * The served month for a month that has **no** `monthly_outlooks` row.
 *
 * `pending` is the weakest true claim, and it is chosen deliberately over the two
 * more specific reasons the derivation knows:
 *
 * - `insufficient_history` would mean "the baseline holds no normal for this
 *   month". The read path never consults a baseline, so it cannot know that.
 * - `ingest_failed` would mean "a run failed". `monthly_outlooks` keeps no failed
 *   row (a failed derivation rolls back) and `opensIngestionRun: false` means no
 *   `ingestion_runs` row exists either, so nothing records the cause. A failed
 *   ingest must not be presented as pending *or* as a failure it cannot prove.
 *
 * Lead months 1–7 without a row are different, and the contract knows why: no
 * product materialises them in this phase (`MONTHLY_OUTLOOK_BANDS` permits only
 * `seasonal_forecast` there, and no seasonal writer exists), so `not_requested`
 * is a fact rather than a guess.
 */
export const PENDING_OUTLOOK_REASON = "pending";

/** One stored `app.monthly_outlooks` row, as the read path receives it. */
export interface StoredOutlookMonth {
  /** First day of the calendar month, `YYYY-MM-01`. */
  readonly month: string;
  /** `WeatherDataClass`, as stored text. Validated here, not trusted. */
  readonly dataClass: string | null;
  readonly evaluationBasis: string;
  /** `null` for a row that records an absence; the column permits it, so the read does. */
  readonly valueMm: number | null;
  readonly missingReason: string | null;
  readonly baselineVersion: string | null;
  readonly anomalyKind: string | null;
  readonly anomalyMm: number | null;
  readonly ensembleSpreadMm: number | null;
  readonly spreadUnavailableReason: string | null;
  readonly derivationVersion: string;
}

export interface OutlookHorizonReadInput {
  /** The calendar month lead month 1 describes, first-of-month. */
  readonly firstMonth: string;
  readonly rows: readonly StoredOutlookMonth[];
}

export type OutlookReadFailureKind = "invalid_input" | "inconsistent_row";

export type OutlookReadOutcome =
  | { readonly ok: true; readonly value: { readonly months: readonly ClimateOutlookMonth[] } }
  | {
      readonly ok: false;
      readonly kind: OutlookReadFailureKind;
      readonly message: string;
    };

const FIRST_OF_MONTH = /^\d{4}-\d{2}-01$/;

function fail(
  kind: OutlookReadFailureKind,
  message: string,
): Extract<OutlookReadOutcome, { ok: false }> {
  return { ok: false, kind, message };
}

/**
 * Turn stored rows into the twelve served months.
 *
 * Presenting is all this does. A row is passed through unchanged — value, class,
 * reason, baseline, derivation — and a month with no row becomes a no-value entry.
 * Nothing is converted, interpolated, filled from a neighbouring month, or
 * defaulted to zero: a zero is a measurement this layer never has.
 *
 * The stored text is parsed through the same contract enums the writer used,
 * because the database CHECKs accept values the *response* contract may reject
 * (nine data classes are legal in the column; only two have an approved monthly
 * estimator). A row that cannot be presented is `inconsistent_row`, not a silently
 * dropped month: dropping it would serve a horizon that is missing a month it
 * actually has, which is worse than an error nobody can act on.
 */
export function assembleOutlookHorizon(input: OutlookHorizonReadInput): OutlookReadOutcome {
  if (!FIRST_OF_MONTH.test(input.firstMonth)) {
    return fail("invalid_input", "firstMonth must be the first day of a calendar month");
  }

  const byMonth = new Map<string, StoredOutlookMonth>();
  for (const row of input.rows) {
    if (byMonth.has(row.month)) {
      return fail("inconsistent_row", `month "${row.month}" has more than one active row`);
    }
    byMonth.set(row.month, row);
  }

  const horizon: string[] = [];
  for (const leadMonth of LEAD_MONTHS) {
    horizon.push(calendarMonthOf(input.firstMonth, leadMonth));
  }

  const horizonSet = new Set(horizon);
  for (const month of byMonth.keys()) {
    if (!horizonSet.has(month)) {
      return fail("inconsistent_row", `month "${month}" is outside the requested horizon`);
    }
  }

  const months: ClimateOutlookMonth[] = [];
  for (const [index, month] of horizon.entries()) {
    const leadMonth = index + 1;
    const row = byMonth.get(month);

    if (row === undefined) {
      months.push(noValueMonth(leadMonth, month));
      continue;
    }

    const mapped = storedMonth(leadMonth, row);
    if ("kind" in mapped) return mapped;
    months.push(mapped);
  }

  return { ok: true, value: { months } };
}

/**
 * Lead months 1–7 have no approved source in this phase; 8–12 have a source and
 * simply no materialised answer for this cell.
 */
function noValueMonth(leadMonth: number, month: string): ClimateOutlookMonth {
  return {
    leadMonth,
    month,
    dataClass: null,
    evaluationBasis: "monthly",
    valueMm: null,
    missingReason: leadMonth <= 7 ? NO_FORECAST_SOURCE_REASON : PENDING_OUTLOOK_REASON,
    baselineVersion: null,
    anomalyKind: null,
    ensembleSpreadMm: null,
    spreadUnavailableReason: SPREAD_REASON_NO_VALUE,
    unit: "mm",
    estimator: null,
    derivationVersion: null,
  };
}

function storedMonth(
  leadMonth: number,
  row: StoredOutlookMonth,
): ClimateOutlookMonth | Extract<OutlookReadOutcome, { ok: false }> {
  // Value and class are present or absent together (`monthly_outlooks_value_state_check`,
  // `outlookMonthSchema`). A row with only one of them is contradictory stored state:
  // it is refused here rather than coerced, because coercing it would either invent a
  // class for a number or turn a labelled month into an unlabelled absence — both
  // serve a month the row does not describe.
  const hasClass = row.dataClass !== null;
  const hasValue = row.valueMm !== null;
  if (hasClass !== hasValue) {
    return fail(
      "inconsistent_row",
      `month "${row.month}" has ${hasClass ? "a data class and no value" : "a value and no data class"}; value and class are present or absent together`,
    );
  }

  // A row may record an absence rather than a number — the column permits it, and a
  // future writer may use it for a state this phase synthesises instead. Serve the
  // absence it describes, with no estimator and no derivation: the row's
  // `derivation_version` records the decision to store nothing, and attributing a
  // formula to that absence is what the response contract refuses.
  if (!hasValue) {
    if (row.missingReason === null) {
      return fail(
        "inconsistent_row",
        `month "${row.month}" has no value and no reason, so nothing can be said about it`,
      );
    }
    const absent = {
      leadMonth,
      month: row.month,
      dataClass: null,
      evaluationBasis: row.evaluationBasis as OutlookEvaluationBasis,
      valueMm: null,
      missingReason: row.missingReason as MissingReason,
      baselineVersion: row.baselineVersion,
      // Passed through, not dropped: a stored anomaly on a valueless month is a
      // contradiction the response contract refuses, and nulling it here would erase
      // the evidence of that contradiction.
      anomalyKind: row.anomalyKind as ClimateOutlookMonth["anomalyKind"],
      ensembleSpreadMm: row.ensembleSpreadMm,
      spreadUnavailableReason: row.spreadUnavailableReason,
      unit: "mm" as const,
      estimator: null,
      derivationVersion: null,
    };
    const parsedAbsent = climateOutlookMonthSchema.safeParse(absent);
    if (!parsedAbsent.success) {
      return fail(
        "inconsistent_row",
        `month "${row.month}" cannot be served as absent: ${parsedAbsent.error.issues[0]?.message ?? "contract"}`,
      );
    }
    return parsedAbsent.data;
  }

  const dataClass = row.dataClass as WeatherDataClass;
  const estimator: MonthlyOutlookEstimator | null = estimatorForDataClass(dataClass);
  if (estimator === null) {
    return fail(
      "inconsistent_row",
      `month "${row.month}" is labelled "${row.dataClass}", which has no approved monthly estimator`,
    );
  }

  const candidate = {
    leadMonth,
    month: row.month,
    dataClass,
    evaluationBasis: row.evaluationBasis as OutlookEvaluationBasis,
    valueMm: row.valueMm,
    missingReason: row.missingReason as MissingReason | null,
    baselineVersion: row.baselineVersion,
    anomalyKind: row.anomalyKind as ClimateOutlookMonth["anomalyKind"],
    ensembleSpreadMm: row.ensembleSpreadMm,
    spreadUnavailableReason: row.spreadUnavailableReason,
    unit: "mm" as const,
    estimator,
    derivationVersion: row.derivationVersion,
  };

  // The response contract is the last gate: value/class/reason coherence, the
  // climatology-vs-forecast basis rule, the spread rule, and the estimator
  // mapping are all one parse away, and a stored row that contradicts them has
  // no honest rendering.
  const parsed = climateOutlookMonthSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return fail(
      "inconsistent_row",
      `month "${row.month}" cannot be served: ${issue?.path.join(".") ?? "contract"} ${issue?.message ?? "is invalid"}`,
    );
  }

  return parsed.data;
}
