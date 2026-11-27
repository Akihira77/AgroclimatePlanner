import type {
  DailyHorizonBand,
  DailyMissingReason,
  OutlookAvailability,
  WeatherDataClass,
} from "@agroclimate/contracts";
import {
  addCalendarDays,
  calendarDaysBetween,
  DAILY_BAND,
  DAILY_BAND_DATA_CLASS,
  DAILY_HORIZON_LAST_LEAD_DAY,
  dailyBandOf,
  isoDateSchema,
  SUBSESONAL_BAND,
  SUBSESONAL_BAND_DATA_CLASS,
  weatherDataClassSchema,
} from "@agroclimate/contracts";

import { dailyAvailability, weatherForecastStaleAfterHours } from "./freshness.js";

/**
 * The 0–45 day read model — Priority 2.
 *
 * **Direct read, not materialisation.** `weather_records` already carries a run
 * identity, a live/superseded marker, the data class, the model and the
 * initialisation instant on every row. Copying those rows into a second table
 * would add a second supersession path without adding a fact, so this assembler
 * reads the live rows and refuses to invent anything else. The monthly outlook
 * is materialised because a calendar month is an aggregation; a day is not.
 *
 * Nothing here touches the clock: the caller passes `now`, so freshness is
 * testable across every boundary.
 */

/** Asia/Jakarta is UTC+7 all year; Indonesia has no daylight saving. */
const JAKARTA_OFFSET_MS = 7 * 60 * 60 * 1000;

const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

function readInstant(value: string): number {
  if (!UTC_INSTANT.test(value)) throw new RangeError(`"${value}" is not a UTC ISO instant`);
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new RangeError(`"${value}" is not an instant`);
  return parsed;
}

/** The Asia/Jakarta calendar day an instant falls on, `YYYY-MM-DD`. */
export function jakartaDateOfInstant(instant: string): string {
  return new Date(readInstant(instant) + JAKARTA_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * The `[from, to)` instant window that covers lead days 0–45 of `firstDate`.
 *
 * One definition shared with the database query, so the SQL range and the
 * assembler's horizon cannot drift: a wider query would fetch rows this module
 * silently drops, and a narrower one would miss a day at the edge.
 */
export function dailyHorizonWindow(firstDate: string): {
  readonly from: string;
  readonly to: string;
} {
  if (!isoDateSchema.safeParse(firstDate).success) {
    throw new RangeError("firstDate must be a valid calendar date");
  }
  const start = Date.parse(`${firstDate}T00:00:00.000Z`) - JAKARTA_OFFSET_MS;
  const end = start + (DAILY_HORIZON_LAST_LEAD_DAY + 1) * 86_400_000;
  return { from: new Date(start).toISOString(), to: new Date(end).toISOString() };
}

/** One live `app.weather_records` row, as the read path receives it. */
export interface DailyRecordRow {
  /** The instant the value describes, UTC ISO. */
  readonly validAt: string;
  readonly value: number | null;
  readonly unit: string;
  /** `WeatherDataClass`, as stored text. Validated here, not trusted. */
  readonly dataClass: string;
  readonly provider: string;
  readonly model: string;
  readonly initializedAt: string;
  readonly temporalResolution: string | null;
  readonly aggregationLevel: string | null;
  readonly ensembleMember: number | null;
}

export interface DailyHorizonReadInput {
  /** Lead day 0, `YYYY-MM-DD` in Asia/Jakarta. */
  readonly firstDate: string;
  readonly provider: string;
  readonly model: string;
  readonly rows: readonly DailyRecordRow[];
  /** Read-time clock, UTC ISO. Freshness is never read from the row. */
  readonly now: string;
}

export interface ServedDailyDay {
  readonly date: string;
  readonly leadDay: number;
  readonly dataClass: WeatherDataClass | null;
  readonly model: string | null;
  readonly valueMm: number | null;
  readonly missingReason: DailyMissingReason | null;
  readonly initializedAt: string | null;
  readonly availability: OutlookAvailability | null;
  readonly staleAfterHours: number;
  readonly temporalResolution: "daily";
  readonly aggregationLevel: "daily_sum";
}

export interface ServedDailySegment {
  readonly band: DailyHorizonBand;
  readonly evaluationBasis: "daily";
  readonly dataClass: WeatherDataClass;
  readonly unit: "mm";
  readonly days: readonly ServedDailyDay[];
}

export type DailyReadFailureKind = "invalid_input" | "inconsistent_row";

export type DailyReadOutcome =
  | {
      readonly ok: true;
      readonly value: { readonly segments: readonly ServedDailySegment[] };
    }
  | {
      readonly ok: false;
      readonly kind: DailyReadFailureKind;
      readonly message: string;
    };

function fail(
  kind: DailyReadFailureKind,
  message: string,
): Extract<DailyReadOutcome, { ok: false }> {
  return { ok: false, kind, message };
}

const BAND_CLASS: Readonly<Record<DailyHorizonBand, WeatherDataClass>> = {
  daily: DAILY_BAND_DATA_CLASS,
  subseasonal: SUBSESONAL_BAND_DATA_CLASS,
};

/**
 * Turn live rows into two dense segments.
 *
 * A stored row is served only when it is a deterministic daily measurement in
 * millimetres: an ensemble member is not one value, a monthly or seasonal row is
 * not a day, and a row whose class contradicts its band is a modelling bug. Any
 * of those inside the horizon is `inconsistent_row`, never dropped — a silently
 * dropped day reads as "no data" when the truth is "wrong data".
 *
 * Rows outside the horizon are ignored: the query is bounded, but a provider day
 * that lands on lead day −1 is not a defect, it is yesterday.
 */
export function assembleDailyHorizon(input: DailyHorizonReadInput): DailyReadOutcome {
  if (!isoDateSchema.safeParse(input.firstDate).success) {
    return fail("invalid_input", "firstDate must be a valid calendar date");
  }
  try {
    readInstant(input.now);
  } catch {
    return fail("invalid_input", "now must be a UTC ISO instant");
  }

  // One row per date. A later run wins; a tie keeps the first, so the result is
  // deterministic without claiming which identical run is "really" newer.
  const byDate = new Map<string, DailyRecordRow>();

  for (const row of input.rows) {
    let date: string;
    try {
      date = jakartaDateOfInstant(row.validAt);
      readInstant(row.initializedAt);
    } catch {
      return fail("inconsistent_row", `row at "${row.validAt}" is not a UTC instant`);
    }

    const leadDay = calendarDaysBetween(input.firstDate, date);
    if (leadDay < 0 || leadDay > DAILY_HORIZON_LAST_LEAD_DAY) continue;

    if (row.ensembleMember !== null) {
      return fail(
        "inconsistent_row",
        `ensemble member ${row.ensembleMember} at ${row.validAt} is not a single value`,
      );
    }
    if (row.unit !== "mm") {
      return fail("inconsistent_row", `unit "${row.unit}" at ${row.validAt} is not mm`);
    }
    if (row.temporalResolution !== "daily" || row.aggregationLevel !== "daily_sum") {
      return fail(
        "inconsistent_row",
        `row at ${row.validAt} is not a daily sum (${row.temporalResolution}/${row.aggregationLevel})`,
      );
    }

    const band = dailyBandOf(leadDay);
    if (band === null) continue;
    if (!weatherDataClassSchema.safeParse(row.dataClass).success) {
      return fail("inconsistent_row", `data class "${row.dataClass}" at ${row.validAt} is unknown`);
    }
    if (row.dataClass !== BAND_CLASS[band]) {
      return fail(
        "inconsistent_row",
        `lead day ${leadDay} permits ${BAND_CLASS[band]}, not ${row.dataClass}`,
      );
    }

    const existing = byDate.get(date);
    if (existing === undefined || row.initializedAt > existing.initializedAt) {
      byDate.set(date, row);
    }
  }

  const segments = [DAILY_BAND, SUBSESONAL_BAND].map((range): ServedDailySegment => {
    const band = dailyBandOf(range.fromLeadDay);
    if (band === null) throw new RangeError("band range does not resolve");
    const days: ServedDailyDay[] = [];

    for (let leadDay = range.fromLeadDay; leadDay <= range.toLeadDay; leadDay += 1) {
      const date = addCalendarDays(input.firstDate, leadDay);
      const staleAfterHours = weatherForecastStaleAfterHours(leadDay);
      const row = byDate.get(date);

      if (row === undefined) {
        days.push({
          date,
          leadDay,
          dataClass: null,
          model: null,
          valueMm: null,
          // Nothing is stored for this instant, so "may still arrive" is the true
          // claim.
          missingReason: "pending",
          initializedAt: null,
          availability: null,
          staleAfterHours,
          temporalResolution: "daily",
          aggregationLevel: "daily_sum",
        });
        continue;
      }

      if (row.value === null) {
        // The provider published a null for this instant. That is not a gap: it
        // will not fill, and the row exists — so class, model and run are known and
        // worth serving beside the reason.
        days.push({
          date,
          leadDay,
          dataClass: row.dataClass as WeatherDataClass,
          model: row.model,
          valueMm: null,
          missingReason: "provider_null",
          initializedAt: row.initializedAt,
          // A null from a stale run is still stale: freshness is a property of the
          // run, not of the value it did or did not publish.
          availability: dailyAvailability(row.initializedAt, input.now, leadDay),
          staleAfterHours,
          temporalResolution: "daily",
          aggregationLevel: "daily_sum",
        });
        continue;
      }

      days.push({
        date,
        leadDay,
        dataClass: row.dataClass as WeatherDataClass,
        model: row.model,
        valueMm: row.value,
        missingReason: null,
        initializedAt: row.initializedAt,
        availability: dailyAvailability(row.initializedAt, input.now, leadDay),
        staleAfterHours,
        temporalResolution: "daily",
        aggregationLevel: "daily_sum",
      });
    }

    return {
      band,
      evaluationBasis: "daily",
      dataClass: BAND_CLASS[band],
      unit: "mm",
      days,
    };
  });

  return { ok: true, value: { segments } };
}
