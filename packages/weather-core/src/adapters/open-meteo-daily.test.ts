import { describe, expect, it } from "vitest";
import type { Transport, TransportResult } from "../http.js";
import type { AdapterRuntime } from "../runtime.js";
import {
  DAILY_FORECAST_DAYS,
  buildDailyEnsembleUrl,
  buildDailyForecastUrl,
  fetchDailyEnsemble,
  fetchDailyForecast,
  type DailyAdapterConfig,
} from "./open-meteo-daily.js";
import { normalizeDailyPrecipitation } from "../normalize/daily.js";

/**
 * Every payload below is **synthetic**. None is a recording of a live response.
 * The only real observations reproduced are the pinned request parameters and
 * the member-column naming documented in
 * `docs/research/forecast-horizon-capabilities.md`.
 */

const DAYS = Array.from({ length: DAILY_FORECAST_DAYS }, (_, index) => {
  const day = String(index + 1).padStart(2, "0");
  return `2026-11-${day}`;
});

const CONFIG: DailyAdapterConfig = {
  latitude: -6.2,
  longitude: 106.8,
  attribution: "Open-Meteo.com (CC BY 4.0)",
};

function runtimeReturning(result: TransportResult): AdapterRuntime {
  const transport: Transport = { get: async () => result };
  return {
    transport,
    now: () => new Date("2026-11-21T00:00:00Z"),
    timeoutMs: 1_000,
    maxBytes: 1_000_000,
  };
}

const ok = (body: unknown, status = 200): TransportResult => ({
  ok: true,
  response: { status, bodyText: JSON.stringify(body) },
});

function deterministicBody(values: readonly (number | null)[]) {
  return {
    latitude: -6.125,
    longitude: 106.875,
    daily_units: { precipitation_sum: "mm" },
    daily: { time: DAYS, precipitation_sum: values },
  };
}

function ensembleBody() {
  const daily: Record<string, unknown> = {
    time: DAYS,
    precipitation_sum: DAYS.map(() => 1),
  };
  for (let member = 1; member <= 50; member += 1) {
    const key = `precipitation_sum_member${String(member).padStart(2, "0")}`;
    daily[key] = DAYS.map((_, index) => (index === member ? null : member / 10));
  }
  return {
    latitude: -6.125,
    longitude: 106.875,
    daily_units: { precipitation_sum: "mm" },
    daily,
  };
}

describe("buildDailyForecastUrl", () => {
  it("pins the parameters the horizon depends on", () => {
    const url = new URL(buildDailyForecastUrl(CONFIG));
    expect(url.searchParams.get("daily")).toBe("precipitation_sum");
    expect(url.searchParams.get("forecast_days")).toBe("16");
    expect(url.searchParams.get("timezone")).toBe("UTC");
  });

  it("builds a different endpoint for the ensemble", () => {
    expect(buildDailyEnsembleUrl(CONFIG)).toContain("ensemble-api.open-meteo.com");
  });
});

describe("fetchDailyForecast", () => {
  it("returns one value per day with no member", async () => {
    const values = DAYS.map((_, index) => index);
    const outcome = await fetchDailyForecast(
      CONFIG,
      runtimeReturning(ok(deterministicBody(values))),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.product).toBe("forecast");
    expect(outcome.value.days).toHaveLength(DAILY_FORECAST_DAYS);
    expect(outcome.value.days[0]).toEqual({ date: DAYS[0], value: 0, member: null });
    expect(outcome.value.ensembleSize).toBeNull();
  });

  it("keeps a null instead of zero-filling it", async () => {
    const values = DAYS.map(() => 0.5);
    values[2] = null;
    const outcome = await fetchDailyForecast(
      CONFIG,
      runtimeReturning(ok(deterministicBody(values))),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.days[2]?.value).toBeNull();
  });

  it("refuses a short axis instead of calling it a horizon", async () => {
    const body = deterministicBody(DAYS.map(() => 1));
    body.daily.time = DAYS.slice(0, 10);
    body.daily.precipitation_sum = DAYS.slice(0, 10).map(() => 1);
    const outcome = await fetchDailyForecast(CONFIG, runtimeReturning(ok(body)));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("incomplete_horizon");
  });
});

describe("fetchDailyEnsemble", () => {
  it("emits one entry per (day, member) and skips the mean column", async () => {
    const outcome = await fetchDailyEnsemble(CONFIG, runtimeReturning(ok(ensembleBody())));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.ensembleSize).toBe(50);
    expect(outcome.value.days).toHaveLength(50 * DAILY_FORECAST_DAYS);
    expect(new Set(outcome.value.days.map((day) => day.member)).size).toBe(50);
    expect(outcome.value.days.every((day) => day.member !== null)).toBe(true);
  });

  it("classifies a 429 as rate limited and carries Retry-After", async () => {
    const outcome = await fetchDailyEnsemble(CONFIG, {
      ...runtimeReturning({
        ok: true,
        response: { status: 429, bodyText: "", retryAfterSeconds: 30 },
      }),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("rate_limited");
    expect(outcome.retryAfterSeconds).toBe(30);
  });
});

describe("normalizeDailyPrecipitation", () => {
  it("maps a daily value onto the storage vocabulary", async () => {
    const outcome = await fetchDailyForecast(
      CONFIG,
      runtimeReturning(ok(deterministicBody(DAYS.map(() => 2.5)))),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const normalized = normalizeDailyPrecipitation(outcome.value, "-6.25,106.75");
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    expect(normalized.value.values[0]).toEqual({
      cellKey: "-6.25,106.75",
      variable: "precipitation",
      unit: "mm",
      validAt: "2026-11-01T00:00:00.000Z",
      value: 2.5,
      temporalResolution: "daily",
      ensembleMember: null,
      ensembleSize: null,
      aggregationLevel: "daily_sum",
    });
  });

  it("refuses a unit it has no approved conversion for", () => {
    const normalized = normalizeDailyPrecipitation(
      {
        provider: "open-meteo",
        model: "best_match",
        product: "forecast",
        variable: "precipitation_sum",
        unit: "inch",
        adapterVersion: "x",
        attribution: "x",
        requestedLatitude: 0,
        requestedLongitude: 0,
        servedLatitude: 0,
        servedLongitude: 0,
        sourceUrl: "https://example.invalid",
        receivedAt: "2026-11-21T00:00:00.000Z",
        rawPayloadRef: null,
        ensembleSize: null,
        days: [{ date: "2026-11-01", value: 1, member: null }],
      },
      "0,0",
    );
    expect(normalized.ok).toBe(false);
    if (normalized.ok) return;
    expect(normalized.kind).toBe("unsupported_unit");
  });
});
