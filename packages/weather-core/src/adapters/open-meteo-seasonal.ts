import { z } from "zod";
import { failure, type AdapterOutcome } from "../failures.js";
import type { AdapterRuntime } from "../runtime.js";
import {
  addMonths,
  daysInMonth,
  formatMonthKey,
  isConsecutiveMonth,
  parseCalendarMonth,
  type CalendarMonth,
} from "../calendar-month.js";
import {
  collectMembers,
  fetchDailyBlock,
  type DailyAdapterConfig,
  type DailyProviderPayload,
  type ProviderDay,
} from "./open-meteo-daily.js";

/**
 * SEAS5 monthly adapter, via the Open-Meteo seasonal API.
 *
 * Every parameter and field below is pinned to what
 * `docs/research/forecast-horizon-capabilities.md` observed on 2026-11-18:
 *
 * - `models=ecmwf_seas5` with `monthly=` returns 6 rows by default and **7 rows**
 *   with `forecast_days` at the server cap of 217. The default is therefore not
 *   a usable horizon and is never used.
 * - The only monthly precipitation variable verified is `precipitation_mean`.
 *   `precipitation_spread` and friends return 400, so no spread is requested.
 * - Seven rows must also be **seven consecutive calendar months**. A provider
 *   that skips one returns seven ordered keys and no longer describes a
 *   seven-month horizon, so the axis is checked for adjacency, not just order.
 * - The payload exposes no initialisation time. It is supplied by the run that
 *   calls this adapter and marked as configured, never inferred from the clock.
 *
 * The response is returned as a **provider-native** series. It is not a
 * `MonthlyOutlook` and its value is not `valueMm`: `precipitation_mean` may be a
 * monthly mean, and no approved definition says otherwise (F-09).
 */

export const SEAS5_ADAPTER_VERSION = "open-meteo-seasonal-seas5@1.0.0";
export const SEAS5_MONTHLY_FORECAST_DAYS = 217;
export const SEAS5_EXPECTED_MONTHS = 7;
export const SEAS5_MONTHLY_VARIABLE = "precipitation_mean";
export const SEAS5_DEFAULT_BASE_URL = "https://seasonal-api.open-meteo.com";

/**
 * EC46 daily, via the same seasonal endpoint — Phase 5.6.
 *
 * Verified live on 2026-11-23 at `-6.2,106.8`:
 *
 * - `models=ecmwf_ec46&daily=precipitation_sum&forecast_days=46` → `200`, **46
 *   daily rows** (`2026-11-23 … 2027-01-07`), unit `mm`.
 * - The payload carries `precipitation_sum` (the ensemble mean) plus
 *   `precipitation_sum_member01 … _member50`: **50 members**, not 51. The mean
 *   is never a member.
 * - The last row (`lead day 45`) can be null in every column; 45 valued days
 *   were observed. A null stays null.
 * - Without a `timezone` parameter the endpoint answers in GMT
 *   (`utc_offset_seconds: 0`), which is what the pinned request relies on: the
 *   daily axis starts at the request's UTC day, so index == lead day.
 * - `monthly=` for this model returns **0 rows**; there is no EC46 monthly
 *   product and none is requested.
 */
export const EC46_ADAPTER_VERSION = "open-meteo-seasonal-ec46@1.0.0";
export const EC46_MODEL = "ecmwf_ec46";
/** `forecast_days=46` → lead day 0 … 45. The provider's daily EC46 horizon. */
export const EC46_FORECAST_DAYS = 46;
export const EC46_LAST_LEAD_DAY = EC46_FORECAST_DAYS - 1;
/** The payload delivers exactly 50 members (doc claims 51 including the mean). */
export const EC46_ENSEMBLE_MEMBERS = 50;
export const EC46_DAILY_VARIABLE = "precipitation_sum";

/**
 * SEAS5 daily members — the basis of ADR-001 D8b.
 *
 * The monthly axis of SEAS5 exposes no spread variable, so a monthly spread can
 * only come from the members themselves, and members are ephemeral: they are
 * aggregated at ingest or never. Verified live on 2026-11-23 at `-6.2,106.8`:
 *
 * - `models=ecmwf_seas5&daily=precipitation_sum&start_date=2026-11-01&end_date=2027-05-31`
 *   → `200`, **212 rows** (the seven calendar months of the run window), unit
 *   `mm`, columns `precipitation_sum` + `precipitation_sum_member01..50`.
 * - The range form is what makes the aggregation honest. `forecast_days` anchors
 *   the daily axis on the request day, which is not the first day of the
 *   initialization month; a calendar range anchored on the run's own months is.
 * - Reconciled against the provider's own monthly product: the mean of the 50
 *   per-member monthly sums reproduced `precipitation_mean` for all seven months
 *   (ratios 0.989–1.011, i.e. the provider's 0.1 mm rounding). That is the
 *   evidence that the daily members and the monthly quantity describe one thing.
 * - The `precipitation_sum` column of the **daily** payload is *not* the mean of
 *   the 50 members (191 of 193 days disagreed by more than 0.06 mm). It is never
 *   read as a member or as the monthly mean; only the members are aggregated.
 */
export const SEAS5_MEMBER_ADAPTER_VERSION = "open-meteo-seasonal-seas5-member@1.0.0";
export const SEAS5_MEMBER_DAILY_VARIABLE = "precipitation_sum";
export const SEAS5_ENSEMBLE_MEMBERS = 50;

export interface Seas5MonthlyConfig {
  readonly latitude: number;
  readonly longitude: number;
  /**
   * The reference time of the run being ingested, supplied by the caller. The
   * provider does not return it, so it is recorded as configured.
   */
  readonly initializedAt: string;
  readonly attribution: string;
  readonly baseUrl?: string;
}

export interface ProviderMonth {
  /** `YYYY-MM-01`, the first day of the calendar month. */
  readonly month: string;
  /** `null` when the provider returned null. Never substituted with zero. */
  readonly value: number | null;
}

export interface Seas5MonthlyPayload {
  readonly provider: "open-meteo";
  readonly model: "ecmwf_seas5";
  readonly product: "seasonal";
  readonly variable: typeof SEAS5_MONTHLY_VARIABLE;
  /** The provider's own unit string, unconverted. */
  readonly unit: string;
  readonly adapterVersion: string;
  readonly initializedAt: string;
  readonly initializedAtSource: "request_configuration";
  readonly attribution: string;
  readonly requestedLatitude: number;
  readonly requestedLongitude: number;
  /** What the provider says it answered with, which may differ from the request. */
  readonly servedLatitude: number;
  readonly servedLongitude: number;
  readonly sourceUrl: string;
  readonly receivedAt: string;
  readonly rawPayloadRef: null;
  readonly months: readonly ProviderMonth[];
}

const payloadSchema = z.looseObject({
  latitude: z.number(),
  longitude: z.number(),
  monthly_units: z.looseObject({ precipitation_mean: z.string().min(1) }),
  monthly: z.looseObject({
    time: z.array(z.string()),
    precipitation_mean: z.array(z.number().nullable()),
  }),
});

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function validateConfig(config: Seas5MonthlyConfig): string | null {
  if (!Number.isFinite(config.latitude) || config.latitude < -90 || config.latitude > 90) {
    return "latitude must be a finite number inside [-90, 90]";
  }
  if (!Number.isFinite(config.longitude) || config.longitude < -180 || config.longitude > 180) {
    return "longitude must be a finite number inside [-180, 180]";
  }
  if (!ISO_INSTANT.test(config.initializedAt) || Number.isNaN(Date.parse(config.initializedAt))) {
    return "initializedAt must be an ISO 8601 instant; the provider does not report one";
  }
  if (config.attribution.trim().length === 0) {
    return "attribution must be the licence string for this product";
  }
  const baseUrl = config.baseUrl ?? SEAS5_DEFAULT_BASE_URL;
  if (!baseUrl.startsWith("https://")) {
    return "baseUrl must use https; a plaintext provider URL is not acceptable";
  }
  return null;
}

/** Deterministic: fixed parameter order, no defaults from the environment. */
export function buildSeas5MonthlyUrl(config: Seas5MonthlyConfig): string {
  const baseUrl = config.baseUrl ?? SEAS5_DEFAULT_BASE_URL;
  const params = new URLSearchParams();
  params.set("latitude", String(config.latitude));
  params.set("longitude", String(config.longitude));
  params.set("models", "ecmwf_seas5");
  params.set("monthly", SEAS5_MONTHLY_VARIABLE);
  params.set("forecast_days", String(SEAS5_MONTHLY_FORECAST_DAYS));
  return `${baseUrl.replace(/\/$/, "")}/v1/seasonal?${params.toString()}`;
}

export async function fetchSeas5Monthly(
  config: Seas5MonthlyConfig,
  runtime: AdapterRuntime,
): Promise<AdapterOutcome<Seas5MonthlyPayload>> {
  const configError = validateConfig(config);
  if (configError !== null) {
    return failure("invalid_config", configError);
  }

  const url = buildSeas5MonthlyUrl(config);
  const outcome = await runtime.transport.get({
    url,
    timeoutMs: runtime.timeoutMs,
    maxBytes: runtime.maxBytes,
  });
  if (!outcome.ok) {
    return failure("transport", outcome.message);
  }

  const { status, bodyText, retryAfterSeconds } = outcome.response;
  if (status === 429) {
    return failure("rate_limited", "provider returned 429", {
      status,
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    });
  }
  if (status >= 400 && status < 500) {
    return failure("request_invalid", `provider returned ${status}`, { status });
  }
  if (status !== 200) {
    // 5xx is retryable infrastructure; anything else is a response we do not know.
    return status >= 500
      ? failure("transport", `provider returned ${status}`, { status })
      : failure("provider_changed", `unexpected status ${status}`, { status });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(bodyText);
  } catch {
    return failure("provider_changed", "response body is not JSON", { status });
  }

  const parsed = payloadSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue && issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return failure("provider_changed", `response shape changed at ${path}`, { status });
  }
  const body = parsed.data;

  const times = body.monthly.time;
  const values = body.monthly.precipitation_mean;
  if (times.length !== values.length) {
    return failure(
      "provider_changed",
      `monthly arrays disagree: ${times.length} timestamps, ${values.length} values`,
      { status },
    );
  }

  // Not configurable: a shorter horizon accepted by the caller is exactly how a
  // six-month answer becomes a "six-month seasonal forecast".
  if (times.length < SEAS5_EXPECTED_MONTHS) {
    return failure(
      "incomplete_horizon",
      `expected ${SEAS5_EXPECTED_MONTHS} monthly rows, received ${times.length}`,
      { status },
    );
  }
  if (times.length > SEAS5_EXPECTED_MONTHS) {
    return failure(
      "provider_changed",
      `expected ${SEAS5_EXPECTED_MONTHS} monthly rows, received ${times.length}`,
      { status },
    );
  }

  const months: ProviderMonth[] = [];
  let previous: string | null = null;
  for (let index = 0; index < times.length; index += 1) {
    const calendarMonth = parseCalendarMonth(times[index] ?? "");
    if (calendarMonth === null) {
      return failure("provider_changed", `monthly.time[${index}] is not a month key`, { status });
    }
    const month = formatMonthKey(calendarMonth);
    // Row count is not continuity: seven ordered keys can still skip January. Each
    // key must be the calendar month after the previous one (F-10).
    if (previous !== null && !isConsecutiveMonth(previous, month)) {
      return failure(
        "provider_changed",
        `monthly.time[${index}] is ${month}, expected the month after ${previous}`,
        { status },
      );
    }
    previous = month;
    const value = values[index];
    if (value === undefined) {
      return failure("provider_changed", `monthly value missing at index ${index}`, { status });
    }
    months.push({ month, value });
  }

  return {
    ok: true,
    value: Object.freeze({
      provider: "open-meteo",
      model: "ecmwf_seas5",
      product: "seasonal",
      variable: SEAS5_MONTHLY_VARIABLE,
      unit: body.monthly_units.precipitation_mean,
      adapterVersion: SEAS5_ADAPTER_VERSION,
      initializedAt: config.initializedAt,
      initializedAtSource: "request_configuration",
      attribution: config.attribution,
      requestedLatitude: config.latitude,
      requestedLongitude: config.longitude,
      servedLatitude: body.latitude,
      servedLongitude: body.longitude,
      sourceUrl: url,
      receivedAt: runtime.now().toISOString(),
      rawPayloadRef: null,
      months: Object.freeze(months),
    }),
  };
}

/* ------------------------------------------------------------------ *
 * EC46 — subseasonal daily (§5.6)
 * ------------------------------------------------------------------ */

/** Deterministic: fixed parameter order, no environment defaults, no timezone override. */
export function buildEc46DailyUrl(config: DailyAdapterConfig): string {
  const baseUrl = config.baseUrl ?? SEAS5_DEFAULT_BASE_URL;
  const params = new URLSearchParams();
  params.set("latitude", String(config.latitude));
  params.set("longitude", String(config.longitude));
  params.set("models", EC46_MODEL);
  params.set("daily", EC46_DAILY_VARIABLE);
  params.set("forecast_days", String(EC46_FORECAST_DAYS));
  return `${baseUrl.replace(/\/$/, "")}/v1/seasonal?${params.toString()}`;
}

const DAY_MS = 86_400_000;

/**
 * EC46 daily precipitation: one entry per (lead day, member), provider-native.
 *
 * Three things are refused rather than repaired:
 *
 * 1. A row count other than 46 — a truncated answer is not a 45-day horizon.
 * 2. An axis that does not start at the request's UTC day. The handler trims
 *    lead days 0–14, and that trim is only correct while index == lead day; a
 *    shifted axis would silently mislabel every stored day.
 * 3. A non-consecutive axis. 46 ordered dates can still skip one.
 *
 * The ensemble mean (`precipitation_sum`) is withheld from `days` on purpose:
 * it is not a member, and persisting it beside members would make a derived
 * statistic look like an observation.
 */
export async function fetchEc46Daily(
  config: DailyAdapterConfig,
  runtime: AdapterRuntime,
): Promise<AdapterOutcome<DailyProviderPayload>> {
  const url = buildEc46DailyUrl(config);
  const body = await fetchDailyBlock("ec46", url, config, runtime);
  if (!body.ok) return body;

  const time = body.value.time;
  if (time.length !== EC46_FORECAST_DAYS) {
    return failure(
      "incomplete_horizon",
      `expected ${EC46_FORECAST_DAYS} daily rows (lead day 0-${EC46_LAST_LEAD_DAY}), received ${time.length}`,
    );
  }

  const requestDay = runtime.now().toISOString().slice(0, 10);
  const first = time[0];
  if (first !== requestDay) {
    return failure(
      "provider_changed",
      `ec46 daily axis starts at ${String(first)}, expected the request day ${requestDay}; lead-day indexing would be off`,
    );
  }

  let previous: number | null = null;
  for (const [index, date] of time.entries()) {
    const parsed = Date.parse(`${date}T00:00:00.000Z`);
    if (Number.isNaN(parsed)) {
      return failure("provider_changed", `ec46 daily.time[${index}] is not a calendar day`);
    }
    if (previous !== null && parsed - previous !== DAY_MS) {
      return failure(
        "provider_changed",
        `ec46 daily.time[${index}] is ${date}, not the day after ${String(time[index - 1])}`,
      );
    }
    previous = parsed;
  }

  if (!body.value.columns.some((column) => column.name === EC46_DAILY_VARIABLE)) {
    return failure("provider_changed", `ec46 returned no ${EC46_DAILY_VARIABLE} mean column`);
  }

  const collected = collectMembers(
    "ec46",
    EC46_DAILY_VARIABLE,
    body.value.columns,
    EC46_ENSEMBLE_MEMBERS,
  );
  if (!collected.ok) return collected;
  const members = collected.value;

  const days: ProviderDay[] = [];
  for (const [index, values] of [...members.entries()].sort((a, b) => a[0] - b[0])) {
    for (let day = 0; day < time.length; day += 1) {
      const date = time[day];
      if (date === undefined) continue;
      days.push({ date, value: values[day] ?? null, member: index });
    }
  }

  return {
    ok: true,
    value: Object.freeze({
      provider: "open-meteo",
      model: EC46_MODEL,
      product: "seasonal",
      variable: EC46_DAILY_VARIABLE,
      unit: body.value.unit,
      adapterVersion: EC46_ADAPTER_VERSION,
      attribution: config.attribution,
      requestedLatitude: config.latitude,
      requestedLongitude: config.longitude,
      servedLatitude: body.value.latitude,
      servedLongitude: body.value.longitude,
      sourceUrl: url,
      receivedAt: runtime.now().toISOString(),
      rawPayloadRef: null,
      ensembleSize: members.size,
      days: Object.freeze(days),
    }),
  };
}

/* ------------------------------------------------------------------ *
 * SEAS5 daily members — monthly aggregation basis (ADR-001 D8b)
 * ------------------------------------------------------------------ */

export interface Seas5MemberWindow {
  /** `YYYY-MM-01` of the initialization month: the first day requested. */
  readonly startDate: string;
  /** `YYYY-MM-DD` of the last day of the seventh month. */
  readonly endDate: string;
  /** The seven months, in order. */
  readonly months: readonly string[];
  /** `endDate - startDate + 1`, computed from the calendar, not from a response. */
  readonly days: number;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/**
 * The daily range that covers the run's seven monthly rows.
 *
 * The window is derived from `initializedAt` — the same configured instant the
 * monthly request already uses — so the daily members and the monthly means are
 * asked about the same months. It is not derived from the clock: re-ingesting an
 * old run must request that run's window, not today's.
 */
export function seas5MemberWindow(initializedAt: string): Seas5MemberWindow | null {
  const instant = Date.parse(initializedAt);
  if (Number.isNaN(instant)) return null;
  const first = parseCalendarMonth(new Date(instant).toISOString().slice(0, 7));
  if (first === null) return null;

  const months: string[] = [];
  let days = 0;
  let last: CalendarMonth = first;
  for (let offset = 0; offset < SEAS5_EXPECTED_MONTHS; offset += 1) {
    const month = addMonths(first, offset);
    months.push(formatMonthKey(month));
    days += daysInMonth(month);
    last = month;
  }

  return Object.freeze({
    startDate: formatMonthKey(first),
    endDate: `${pad(last.year, 4)}-${pad(last.month, 2)}-${pad(daysInMonth(last), 2)}`,
    months: Object.freeze(months),
    days,
  });
}

/** Deterministic: fixed parameter order, the run's own calendar range. */
export function buildSeas5MemberDailyUrl(config: Seas5MonthlyConfig): string | null {
  const window = seas5MemberWindow(config.initializedAt);
  if (window === null) return null;
  const baseUrl = config.baseUrl ?? SEAS5_DEFAULT_BASE_URL;
  const params = new URLSearchParams();
  params.set("latitude", String(config.latitude));
  params.set("longitude", String(config.longitude));
  params.set("models", "ecmwf_seas5");
  params.set("daily", SEAS5_MEMBER_DAILY_VARIABLE);
  params.set("start_date", window.startDate);
  params.set("end_date", window.endDate);
  return `${baseUrl.replace(/\/$/, "")}/v1/seasonal?${params.toString()}`;
}

/**
 * SEAS5 daily precipitation per member, over the run's seven-month window.
 *
 * Four things are refused rather than repaired:
 *
 * 1. A day count other than the calendar count of the window — a short answer
 *    would silently shorten the last month and turn an incomplete mean into an
 *    apparent one.
 * 2. An axis that does not begin exactly on `startDate`, or that skips a day.
 * 3. A member set other than exactly 50 unique identifiers in `1..50`.
 * 4. Any column that is neither the mean nor a member identifier.
 *
 * The mean column is excluded here as it is for EC46: the monthly
 * `precipitation_mean` is already stored as its own row, and a daily mean that is
 * not the member mean (see the module note) must never be summed as one.
 */
export async function fetchSeas5MemberDaily(
  config: Seas5MonthlyConfig,
  runtime: AdapterRuntime,
): Promise<AdapterOutcome<DailyProviderPayload>> {
  const configError = validateConfig(config);
  if (configError !== null) return failure("invalid_config", configError);

  const window = seas5MemberWindow(config.initializedAt);
  const url = buildSeas5MemberDailyUrl(config);
  if (window === null || url === null) {
    return failure("invalid_config", "initializedAt does not name a calendar month");
  }

  const body = await fetchDailyBlock("seas5-member", url, config, runtime);
  if (!body.ok) return body;

  const time = body.value.time;
  if (time.length !== window.days) {
    return failure(
      time.length < window.days ? "incomplete_horizon" : "provider_changed",
      `expected ${window.days} daily rows for ${window.startDate}…${window.endDate}, received ${time.length}`,
    );
  }

  let previous: number | null = null;
  for (const [index, date] of time.entries()) {
    const parsed = Date.parse(`${date}T00:00:00.000Z`);
    if (Number.isNaN(parsed)) {
      return failure("provider_changed", `seas5 daily.time[${index}] is not a calendar day`);
    }
    if (previous !== null && parsed - previous !== DAY_MS) {
      return failure(
        "provider_changed",
        `seas5 daily.time[${index}] is ${date}, not the day after ${String(time[index - 1])}`,
      );
    }
    previous = parsed;
  }

  if (time[0] !== window.startDate) {
    return failure(
      "provider_changed",
      `seas5 daily axis starts at ${String(time[0])}, expected ${window.startDate}`,
    );
  }

  if (!body.value.columns.some((column) => column.name === SEAS5_MEMBER_DAILY_VARIABLE)) {
    return failure(
      "provider_changed",
      `seas5 returned no ${SEAS5_MEMBER_DAILY_VARIABLE} mean column`,
    );
  }

  const collected = collectMembers(
    "seas5",
    SEAS5_MEMBER_DAILY_VARIABLE,
    body.value.columns,
    SEAS5_ENSEMBLE_MEMBERS,
  );
  if (!collected.ok) return collected;
  const members = collected.value;

  const days: ProviderDay[] = [];
  for (const [index, values] of [...members.entries()].sort((a, b) => a[0] - b[0])) {
    for (let day = 0; day < time.length; day += 1) {
      const date = time[day];
      if (date === undefined) continue;
      days.push({ date, value: values[day] ?? null, member: index });
    }
  }

  return {
    ok: true,
    value: Object.freeze({
      provider: "open-meteo",
      model: "ecmwf_seas5",
      product: "seasonal",
      variable: SEAS5_MEMBER_DAILY_VARIABLE,
      unit: body.value.unit,
      adapterVersion: SEAS5_MEMBER_ADAPTER_VERSION,
      attribution: config.attribution,
      requestedLatitude: config.latitude,
      requestedLongitude: config.longitude,
      servedLatitude: body.value.latitude,
      servedLongitude: body.value.longitude,
      sourceUrl: url,
      receivedAt: runtime.now().toISOString(),
      rawPayloadRef: null,
      ensembleSize: members.size,
      days: Object.freeze(days),
    }),
  };
}
