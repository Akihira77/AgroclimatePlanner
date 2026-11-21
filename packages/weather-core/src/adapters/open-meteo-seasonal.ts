import { z } from "zod";
import { failure, type AdapterOutcome } from "../failures.js";
import type { AdapterRuntime } from "../runtime.js";

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

const monthKeySchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])(-01)?$/);

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
    const rawMonth = times[index] ?? "";
    if (!monthKeySchema.safeParse(rawMonth).success) {
      return failure("provider_changed", `monthly.time[${index}] is not a month key`, { status });
    }
    const month = rawMonth.length === 7 ? `${rawMonth}-01` : rawMonth;
    if (previous !== null && month <= previous) {
      return failure(
        "provider_changed",
        `monthly.time is not strictly increasing at index ${index}`,
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
