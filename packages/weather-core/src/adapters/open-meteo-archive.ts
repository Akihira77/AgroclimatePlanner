import { z } from "zod";
import { failure, type AdapterOutcome } from "../failures.js";
import type { AdapterRuntime } from "../runtime.js";

/**
 * ERA5 daily precipitation from the Open-Meteo Archive API — Phase 5.5.
 *
 * Pinned against the provider's documentation and a controlled probe
 * (`archive-api.open-meteo.com/v1/archive`, 2026-11-23):
 *
 * - `models=era5` selects the 0.25° ERA5 reanalysis. The archive also serves
 *   ERA5-Land and a 9 km IFS blend; neither is requested, because a baseline must
 *   name one dataset and 0.25° ERA5 is what the research route verified.
 * - `daily=precipitation_sum` is the only daily precipitation variable, unit
 *   `mm`. `precipitation_unit=mm` is pinned: the default is already mm, and an
 *   explicit parameter is what makes "unexpected unit" a provider-drift signal
 *   instead of a silently accepted inch.
 * - `timezone=UTC` is required when a daily variable is requested. The provider
 *   answers `timezone: "GMT"` with `utc_offset_seconds: 0`, so a returned date is
 *   a UTC calendar day. No local midnight is ever assumed.
 * - `start_date`/`end_date` are inclusive. The 1991–2020 window is one request
 *   (probed: 10 958 rows, ~200 KB), not a monthly fan-out.
 * - `cell_selection=nearest` is pinned. The response `latitude`/`longitude` are
 *   the **served** coordinate, which is preserved as a provider fact. It is not
 *   evidence of a grid node: the same endpoint has returned an interpolated point
 *   for nearby requests, so this adapter never claims grid identity (OPEN-18).
 *
 * The payload stays **provider-native**: no `climatology_normals` row, no
 * contract variable name, no aggregation. The monthly totals and the 30-year
 * mean are the pure builder's job (`@agroclimate/climate-core`).
 */

export const ARCHIVE_ADAPTER_VERSION = "open-meteo-archive-era5@1.0.0";
export const ARCHIVE_DEFAULT_BASE_URL = "https://archive-api.open-meteo.com";
export const ARCHIVE_MODEL = "era5";
export const ARCHIVE_VARIABLE = "precipitation_sum";
export const ARCHIVE_UNIT = "mm";
/** Earliest day the archive serves for ERA5 (documented and probed). */
export const ARCHIVE_EARLIEST_DATE = "1940-01-01";
export const ARCHIVE_PERIOD_FROM = "1991-01-01";
export const ARCHIVE_PERIOD_TO = "2020-12-31";

export interface ArchiveAdapterConfig {
  readonly latitude: number;
  readonly longitude: number;
  /** Inclusive first day, `YYYY-MM-DD`. */
  readonly startDate: string;
  /** Inclusive last day, `YYYY-MM-DD`. */
  readonly endDate: string;
  /** Attribution/licence string for this dataset. Required, never invented. */
  readonly attribution: string;
  readonly baseUrl?: string | undefined;
}

export interface ProviderArchiveDay {
  /** `YYYY-MM-DD`, a UTC calendar day. */
  readonly date: string;
  /** `null` when the provider published no value. Never zero-filled. */
  readonly value: number | null;
}

export interface ArchiveDailyPayload {
  readonly provider: "open-meteo";
  readonly model: typeof ARCHIVE_MODEL;
  readonly product: "archive";
  readonly variable: typeof ARCHIVE_VARIABLE;
  /** The provider's own unit string, checked to be `mm` before this payload exists. */
  readonly unit: typeof ARCHIVE_UNIT;
  readonly adapterVersion: string;
  readonly attribution: string;
  readonly requestedLatitude: number;
  readonly requestedLongitude: number;
  /** The provider's answered coordinate; not proof of a grid node. */
  readonly servedLatitude: number;
  readonly servedLongitude: number;
  readonly startDate: string;
  readonly endDate: string;
  readonly sourceUrl: string;
  readonly receivedAt: string;
  readonly rawPayloadRef: null;
  readonly days: readonly ProviderArchiveDay[];
}

const payloadSchema = z.looseObject({
  latitude: z.number(),
  longitude: z.number(),
  daily_units: z.looseObject({ precipitation_sum: z.string().min(1) }),
  daily: z.looseObject({
    time: z.array(z.string()),
    precipitation_sum: z.array(z.number().nullable()),
  }),
});

const DAY_MS = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** UTC epoch milliseconds for a real calendar day, or `null`. */
function dayMs(value: string): number | null {
  if (!ISO_DATE.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10) === value ? ms : null;
}

function validateConfig(config: ArchiveAdapterConfig): string | null {
  if (!Number.isFinite(config.latitude) || config.latitude < -90 || config.latitude > 90) {
    return "latitude must be a finite number inside [-90, 90]";
  }
  if (!Number.isFinite(config.longitude) || config.longitude < -180 || config.longitude > 180) {
    return "longitude must be a finite number inside [-180, 180]";
  }
  const start = dayMs(config.startDate);
  const end = dayMs(config.endDate);
  const earliest = dayMs(ARCHIVE_EARLIEST_DATE);
  if (start === null) return "startDate must be a calendar day, YYYY-MM-DD";
  if (end === null) return "endDate must be a calendar day, YYYY-MM-DD";
  if (earliest === null || start < earliest) {
    return `the ERA5 archive starts at ${ARCHIVE_EARLIEST_DATE}`;
  }
  if (end < start) return "endDate must not precede startDate";
  if (config.attribution.trim().length === 0) {
    return "attribution must be the licence string for this dataset";
  }
  const baseUrl = config.baseUrl ?? ARCHIVE_DEFAULT_BASE_URL;
  if (!baseUrl.startsWith("https://")) {
    return "baseUrl must use https; a plaintext provider URL is not acceptable";
  }
  return null;
}

/** Deterministic: fixed parameter order, no defaults from the environment. */
export function buildArchiveDailyUrl(config: ArchiveAdapterConfig): string {
  const baseUrl = config.baseUrl ?? ARCHIVE_DEFAULT_BASE_URL;
  const params = new URLSearchParams();
  params.set("latitude", String(config.latitude));
  params.set("longitude", String(config.longitude));
  params.set("start_date", config.startDate);
  params.set("end_date", config.endDate);
  params.set("daily", ARCHIVE_VARIABLE);
  params.set("models", ARCHIVE_MODEL);
  params.set("precipitation_unit", ARCHIVE_UNIT);
  params.set("cell_selection", "nearest");
  params.set("timezone", "UTC");
  return `${baseUrl.replace(/\/$/, "")}/v1/archive?${params.toString()}`;
}

/** Inclusive day count of a validated window. */
export function archiveDayCount(startDate: string, endDate: string): number {
  const start = dayMs(startDate);
  const end = dayMs(endDate);
  if (start === null || end === null || end < start) {
    throw new RangeError("archiveDayCount needs two ordered calendar days");
  }
  return Math.round((end - start) / DAY_MS) + 1;
}

export async function fetchArchiveDaily(
  config: ArchiveAdapterConfig,
  runtime: AdapterRuntime,
): Promise<AdapterOutcome<ArchiveDailyPayload>> {
  const configError = validateConfig(config);
  if (configError !== null) {
    return failure("invalid_config", configError);
  }

  const url = buildArchiveDailyUrl(config);
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

  if (body.daily_units.precipitation_sum !== ARCHIVE_UNIT) {
    return failure(
      "unsupported_unit",
      `archive returned "${body.daily_units.precipitation_sum}"; expected ${ARCHIVE_UNIT}`,
      { status },
    );
  }
  if (!Number.isFinite(body.latitude) || !Number.isFinite(body.longitude)) {
    return failure("provider_changed", "response carries no finite served coordinate", { status });
  }

  const times = body.daily.time;
  const values = body.daily.precipitation_sum;
  if (times.length !== values.length) {
    return failure(
      "provider_changed",
      `daily arrays disagree: ${times.length} days, ${values.length} values`,
      { status },
    );
  }

  const expectedDays = archiveDayCount(config.startDate, config.endDate);
  if (times.length < expectedDays) {
    return failure(
      "incomplete_horizon",
      `expected ${expectedDays} days for ${config.startDate}..${config.endDate}, received ${times.length}`,
      { status },
    );
  }
  if (times.length > expectedDays) {
    return failure(
      "provider_changed",
      `expected ${expectedDays} days for ${config.startDate}..${config.endDate}, received ${times.length}`,
      { status },
    );
  }

  const startMs = dayMs(config.startDate);
  if (startMs === null) {
    return failure("invalid_config", "startDate is not a calendar day");
  }

  const days: ProviderArchiveDay[] = [];
  for (let index = 0; index < times.length; index += 1) {
    const time = times[index];
    const value = values[index];
    if (time === undefined || value === undefined) {
      return failure("provider_changed", `daily value missing at index ${index}`, { status });
    }
    // Row count is not continuity: a duplicate or a skipped day still fits the
    // count. Every row must be the expected UTC day, in order.
    const ms = dayMs(time);
    if (ms === null || ms !== startMs + index * DAY_MS) {
      const expected = new Date(startMs + index * DAY_MS).toISOString().slice(0, 10);
      return failure(
        "provider_changed",
        `daily.time[${index}] is "${time}", expected "${expected}"`,
        { status },
      );
    }
    days.push({ date: time, value });
  }

  return {
    ok: true,
    value: Object.freeze({
      provider: "open-meteo",
      model: ARCHIVE_MODEL,
      product: "archive",
      variable: ARCHIVE_VARIABLE,
      unit: ARCHIVE_UNIT,
      adapterVersion: ARCHIVE_ADAPTER_VERSION,
      attribution: config.attribution,
      requestedLatitude: config.latitude,
      requestedLongitude: config.longitude,
      servedLatitude: body.latitude,
      servedLongitude: body.longitude,
      startDate: config.startDate,
      endDate: config.endDate,
      sourceUrl: url,
      receivedAt: runtime.now().toISOString(),
      rawPayloadRef: null,
      days: Object.freeze(days),
    }),
  };
}
