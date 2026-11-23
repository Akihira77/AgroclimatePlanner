import { z } from "zod";
import { failure, type AdapterOutcome } from "../failures.js";
import type { AdapterRuntime } from "../runtime.js";

/**
 * Open-Meteo daily forecast adapters: the deterministic forecast API and the
 * ensemble API.
 *
 * Every pinned parameter below is what
 * `docs/research/forecast-horizon-capabilities.md` observed on 2026-11-18:
 *
 * - Deterministic `forecast_days` is capped at **16** by the server; 400 above.
 * - The ensemble (`models=ecmwf_ifs025`) returns **50 members** plus a mean and
 *   truncates to **14 days**: rows past day 14 exist but every value is null. A
 *   row count is therefore not a horizon, and the member columns are what get
 *   asserted.
 * - Only `precipitation_sum` is pinned here. The API's `temperature_2m_max`
 *   exists, but `aggregation_level` has no approved `daily_max` member (OPEN-14),
 *   so storing it would require inventing vocabulary. One variable is honest;
 *   a second needs the vocabulary decided first.
 * - `timezone=UTC` is requested so a daily row's instant is unambiguous:
 *   `valid_at` is the day's 00:00Z, never a local midnight.
 *
 * The payload stays **provider-native**: no `weather_records` row, no contract
 * variable name, and no unit conversion happens here.
 */

export const DAILY_FORECAST_ADAPTER_VERSION = "open-meteo-forecast-daily@1.0.0";
export const DAILY_ENSEMBLE_ADAPTER_VERSION = "open-meteo-ensemble-daily@1.0.0";
export const DAILY_FORECAST_DAYS = 16;
export const DAILY_ENSEMBLE_MODEL = "ecmwf_ifs025";
export const DAILY_VARIABLE = "precipitation_sum";
export const FORECAST_DEFAULT_BASE_URL = "https://api.open-meteo.com";
export const ENSEMBLE_DEFAULT_BASE_URL = "https://ensemble-api.open-meteo.com";

export interface DailyAdapterConfig {
  readonly latitude: number;
  readonly longitude: number;
  /** Attribution/licence string for this product. Required, never invented. */
  readonly attribution: string;
  readonly baseUrl?: string;
}

/** One value. `member` is `null` for a deterministic product. */
export interface ProviderDay {
  readonly date: string;
  readonly value: number | null;
  readonly member: number | null;
}

export interface DailyProviderPayload {
  readonly provider: "open-meteo";
  readonly model: string;
  readonly product: "forecast" | "ensemble";
  readonly variable: typeof DAILY_VARIABLE;
  readonly unit: string;
  readonly adapterVersion: string;
  readonly attribution: string;
  readonly requestedLatitude: number;
  readonly requestedLongitude: number;
  readonly servedLatitude: number;
  readonly servedLongitude: number;
  readonly sourceUrl: string;
  readonly receivedAt: string;
  readonly rawPayloadRef: null;
  readonly ensembleSize: number | null;
  readonly days: readonly ProviderDay[];
}

function validateConfig(config: DailyAdapterConfig): string | null {
  if (!Number.isFinite(config.latitude) || config.latitude < -90 || config.latitude > 90) {
    return "latitude must be a finite number inside [-90, 90]";
  }
  if (!Number.isFinite(config.longitude) || config.longitude < -180 || config.longitude > 180) {
    return "longitude must be a finite number inside [-180, 180]";
  }
  if (config.attribution.trim().length === 0) {
    return "attribution must be the licence string for this product";
  }
  const baseUrl = config.baseUrl ?? FORECAST_DEFAULT_BASE_URL;
  if (!baseUrl.startsWith("https://")) {
    return "baseUrl must use https; a plaintext provider URL is not acceptable";
  }
  return null;
}

/** Deterministic: fixed parameter order, no defaults from the environment. */
export function buildDailyForecastUrl(config: DailyAdapterConfig): string {
  const baseUrl = config.baseUrl ?? FORECAST_DEFAULT_BASE_URL;
  const params = new URLSearchParams();
  params.set("latitude", String(config.latitude));
  params.set("longitude", String(config.longitude));
  params.set("daily", DAILY_VARIABLE);
  params.set("forecast_days", String(DAILY_FORECAST_DAYS));
  params.set("timezone", "UTC");
  return `${baseUrl.replace(/\/$/, "")}/v1/forecast?${params.toString()}`;
}

export function buildDailyEnsembleUrl(config: DailyAdapterConfig): string {
  const baseUrl = config.baseUrl ?? ENSEMBLE_DEFAULT_BASE_URL;
  const params = new URLSearchParams();
  params.set("latitude", String(config.latitude));
  params.set("longitude", String(config.longitude));
  params.set("daily", DAILY_VARIABLE);
  params.set("models", DAILY_ENSEMBLE_MODEL);
  params.set("forecast_days", String(DAILY_FORECAST_DAYS));
  params.set("timezone", "UTC");
  return `${baseUrl.replace(/\/$/, "")}/v1/ensemble?${params.toString()}`;
}

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const dailyBodySchema = z.looseObject({
  latitude: z.number(),
  longitude: z.number(),
  daily_units: z.record(z.string(), z.string()),
  daily: z.looseObject({ time: z.array(dateSchema) }),
});

interface DailyBody {
  readonly latitude: number;
  readonly longitude: number;
  readonly unit: string;
  readonly time: readonly string[];
  readonly columns: readonly {
    readonly name: string;
    readonly values: readonly (number | null)[];
  }[];
}

async function getDaily(
  label: string,
  url: string,
  config: DailyAdapterConfig,
  runtime: AdapterRuntime,
): Promise<AdapterOutcome<DailyBody>> {
  const configError = validateConfig(config);
  if (configError !== null) return failure("invalid_config", configError);

  const outcome = await runtime.transport.get({
    url,
    timeoutMs: runtime.timeoutMs,
    maxBytes: runtime.maxBytes,
  });
  if (!outcome.ok) return failure("transport", outcome.message);

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

  const parsed = dailyBodySchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue && issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return failure("provider_changed", `${label} response shape changed at ${path}`, { status });
  }

  const time = parsed.data.daily.time;
  const columns: { name: string; values: readonly (number | null)[] }[] = [];
  for (const [key, value] of Object.entries(parsed.data.daily)) {
    if (key === "time") continue;
    const series = z.array(z.number().nullable()).safeParse(value);
    if (!series.success) {
      return failure("provider_changed", `${label} column ${key} is not a numeric array`, {
        status,
      });
    }
    if (series.data.length !== time.length) {
      return failure(
        "provider_changed",
        `${label} column ${key} has ${series.data.length} values for ${time.length} days`,
        { status },
      );
    }
    columns.push({ name: key, values: series.data });
  }
  if (columns.length === 0) {
    return failure("provider_changed", `${label} returned no ${DAILY_VARIABLE}`, { status });
  }

  return {
    ok: true,
    value: {
      latitude: parsed.data.latitude,
      longitude: parsed.data.longitude,
      unit: parsed.data.daily_units[DAILY_VARIABLE] ?? "",
      time,
      columns,
    },
  };
}

function toPayload(
  input: {
    readonly model: string;
    readonly product: "forecast" | "ensemble";
    readonly adapterVersion: string;
    readonly ensembleSize: number | null;
    readonly days: readonly ProviderDay[];
  },
  body: DailyBody,
  config: DailyAdapterConfig,
  url: string,
  runtime: AdapterRuntime,
): DailyProviderPayload {
  return Object.freeze({
    provider: "open-meteo",
    model: input.model,
    product: input.product,
    variable: DAILY_VARIABLE,
    unit: body.unit,
    adapterVersion: input.adapterVersion,
    attribution: config.attribution,
    requestedLatitude: config.latitude,
    requestedLongitude: config.longitude,
    servedLatitude: body.latitude,
    servedLongitude: body.longitude,
    sourceUrl: url,
    receivedAt: runtime.now().toISOString(),
    rawPayloadRef: null,
    ensembleSize: input.ensembleSize,
    days: Object.freeze(input.days),
  });
}

/** Deterministic daily precipitation. Exactly `DAILY_FORECAST_DAYS` rows. */
export async function fetchDailyForecast(
  config: DailyAdapterConfig,
  runtime: AdapterRuntime,
): Promise<AdapterOutcome<DailyProviderPayload>> {
  const url = buildDailyForecastUrl(config);
  const body = await getDaily("forecast", url, config, runtime);
  if (!body.ok) return body;

  const column = body.value.columns.find((entry) => entry.name === DAILY_VARIABLE);
  if (column === undefined || body.value.columns.length !== 1) {
    return failure(
      "provider_changed",
      `forecast returned ${body.value.columns.length} value columns, expected only ${DAILY_VARIABLE}`,
    );
  }
  if (body.value.time.length !== DAILY_FORECAST_DAYS) {
    return failure(
      "incomplete_horizon",
      `expected ${DAILY_FORECAST_DAYS} daily rows, received ${body.value.time.length}`,
    );
  }

  return {
    ok: true,
    value: toPayload(
      {
        model: "best_match",
        product: "forecast",
        adapterVersion: DAILY_FORECAST_ADAPTER_VERSION,
        ensembleSize: null,
        days: body.value.time.map((date, index) => ({
          date,
          value: column.values[index] ?? null,
          member: null,
        })),
      },
      body.value,
      config,
      url,
      runtime,
    ),
  };
}

/**
 * Ensemble daily precipitation: one entry per (day, member).
 *
 * The response carries `precipitation_sum` (the mean), then
 * `precipitation_sum_member01` … `_member50`. The mean is **not** a member and
 * is skipped: storing it as member 0 would publish 51 members where the provider
 * delivered 50.
 */
export async function fetchDailyEnsemble(
  config: DailyAdapterConfig,
  runtime: AdapterRuntime,
): Promise<AdapterOutcome<DailyProviderPayload>> {
  const url = buildDailyEnsembleUrl(config);
  const body = await getDaily("ensemble", url, config, runtime);
  if (!body.ok) return body;

  const memberPattern = new RegExp(`^${DAILY_VARIABLE}_member(\\d{2})$`);
  const members: { member: number; values: readonly (number | null)[] }[] = [];
  for (const column of body.value.columns) {
    const match = memberPattern.exec(column.name);
    if (match?.[1] === undefined) continue;
    members.push({ member: Number(match[1]) - 1, values: column.values });
  }
  members.sort((a, b) => a.member - b.member);

  if (members.length === 0) {
    return failure("provider_changed", "ensemble response carried no member columns");
  }
  if (body.value.time.length <= DAILY_FORECAST_DAYS - 2) {
    return failure(
      "incomplete_horizon",
      `ensemble returned ${body.value.time.length} days; the observed horizon is ${DAILY_FORECAST_DAYS - 2}`,
    );
  }

  const days: ProviderDay[] = [];
  for (const entry of members) {
    for (let index = 0; index < body.value.time.length; index += 1) {
      const date = body.value.time[index];
      if (date === undefined) continue;
      days.push({ date, value: entry.values[index] ?? null, member: entry.member });
    }
  }
  // A member column with no value on any day is a provider change, not a
  // member with a bad day: the ensemble would silently shrink.
  for (const entry of members) {
    if (entry.values.every((value) => value === null)) {
      return failure("provider_changed", `ensemble member ${entry.member} is entirely null`);
    }
  }

  return {
    ok: true,
    value: toPayload(
      {
        model: DAILY_ENSEMBLE_MODEL,
        product: "ensemble",
        adapterVersion: DAILY_ENSEMBLE_ADAPTER_VERSION,
        ensembleSize: members.length,
        days,
      },
      body.value,
      config,
      url,
      runtime,
    ),
  };
}
