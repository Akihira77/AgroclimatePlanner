import { describe, expect, it } from "vitest";
import type { Transport, TransportResult } from "../http.js";
import type { AdapterRuntime } from "../runtime.js";
import {
  DAILY_ENSEMBLE_MEMBERS,
  DAILY_FORECAST_DAYS,
  DAILY_LAST_LEAD_DAY,
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

function ensembleBody(mutate?: (daily: Record<string, unknown>) => void) {
  const daily: Record<string, unknown> = {
    time: DAYS,
    // The mean is a real column, and it is not a member: it is set to a value no
    // member column carries, so a test can prove it was excluded.
    precipitation_sum: DAYS.map(() => 999),
  };
  for (let member = 1; member <= DAILY_ENSEMBLE_MEMBERS; member += 1) {
    const key = `precipitation_sum_member${String(member).padStart(2, "0")}`;
    daily[key] = DAYS.map(() => member / 10);
  }
  mutate?.(daily);
  return {
    latitude: -6.125,
    longitude: 106.875,
    daily_units: { precipitation_sum: "mm" },
    daily,
  };
}

describe("buildDailyForecastUrl", () => {
  it("requests the 15-day product horizon, not the server's 16-day ceiling", () => {
    const url = new URL(buildDailyForecastUrl(CONFIG));
    expect(url.searchParams.get("daily")).toBe("precipitation_sum");
    expect(url.searchParams.get("forecast_days")).toBe("15");
    expect(DAILY_FORECAST_DAYS).toBe(15);
    expect(DAILY_LAST_LEAD_DAY).toBe(14);
    expect(url.searchParams.get("timezone")).toBe("UTC");
  });

  it("builds a different endpoint for the ensemble", () => {
    expect(buildDailyEnsembleUrl(CONFIG)).toContain("ensemble-api.open-meteo.com");
  });
});

describe("fetchDailyForecast", () => {
  it("accepts exactly 15 daily values and ends on lead day 14", async () => {
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
    expect(outcome.value.days[DAILY_LAST_LEAD_DAY]?.date).toBe(DAYS[DAILY_LAST_LEAD_DAY]);
    expect(outcome.value.ensembleSize).toBeNull();
  });

  it("keeps a null instead of zero-filling it", async () => {
    const values: (number | null)[] = DAYS.map(() => 0.5);
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

  it("refuses a longer axis: the server's ceiling is not the contract", async () => {
    const body = deterministicBody(DAYS.map(() => 1));
    body.daily.time = [...DAYS, "2026-11-16"];
    body.daily.precipitation_sum = Array.from({ length: DAYS.length + 1 }, () => 1);
    const outcome = await fetchDailyForecast(CONFIG, runtimeReturning(ok(body)));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("incomplete_horizon");
  });
});

describe("fetchDailyEnsemble", () => {
  it("accepts exactly 50 members and excludes the mean column", async () => {
    const outcome = await fetchDailyEnsemble(CONFIG, runtimeReturning(ok(ensembleBody())));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.ensembleSize).toBe(DAILY_ENSEMBLE_MEMBERS);
    expect(outcome.value.days).toHaveLength(DAILY_ENSEMBLE_MEMBERS * DAILY_FORECAST_DAYS);
    expect(new Set(outcome.value.days.map((day) => day.member)).size).toBe(DAILY_ENSEMBLE_MEMBERS);
    const members = [...new Set(outcome.value.days.map((day) => day.member))]
      .filter((member): member is number => member !== null)
      .sort((a, b) => a - b);
    expect(members).toEqual(Array.from({ length: DAILY_ENSEMBLE_MEMBERS }, (_, index) => index));
    // The mean is 999; no member value may be 999.
    expect(outcome.value.days.some((day) => day.value === 999)).toBe(false);
  });

  it("rejects a missing member", async () => {
    const outcome = await fetchDailyEnsemble(
      CONFIG,
      runtimeReturning(
        ok(
          ensembleBody((daily) => {
            delete daily["precipitation_sum_member07"];
          }),
        ),
      ),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("provider_changed");
    expect(outcome.message).toContain("missing 7");
  });

  it("rejects a duplicate member identifier", async () => {
    const outcome = await fetchDailyEnsemble(
      CONFIG,
      runtimeReturning(
        ok(
          ensembleBody((daily) => {
            // `member7` and `member07` are the same identifier.
            daily["precipitation_sum_member7"] = DAYS.map(() => 0.7);
          }),
        ),
      ),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("provider_changed");
    expect(outcome.message).toContain("duplicated");
  });

  it("rejects an identifier outside the provider's numbering", async () => {
    const outcome = await fetchDailyEnsemble(
      CONFIG,
      runtimeReturning(
        ok(
          ensembleBody((daily) => {
            daily["precipitation_sum_member51"] = DAYS.map(() => 0.5);
          }),
        ),
      ),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("provider_changed");
    expect(outcome.message).toContain("outside 1..50");
  });

  it("rejects a malformed member column", async () => {
    const outcome = await fetchDailyEnsemble(
      CONFIG,
      runtimeReturning(
        ok(
          ensembleBody((daily) => {
            delete daily["precipitation_sum_member05"];
            daily["precipitation_sum_member"] = DAYS.map(() => 0.5);
          }),
        ),
      ),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("provider_changed");
    expect(outcome.message).toContain("no numeric identifier");
  });

  it("rejects an unexpected non-member column", async () => {
    const outcome = await fetchDailyEnsemble(
      CONFIG,
      runtimeReturning(
        ok(
          ensembleBody((daily) => {
            daily["temperature_2m_max"] = DAYS.map(() => 30);
          }),
        ),
      ),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("provider_changed");
    expect(outcome.message).toContain("unexpected column");
  });

  it("retains an individual null member-day", async () => {
    const outcome = await fetchDailyEnsemble(
      CONFIG,
      runtimeReturning(
        ok(
          ensembleBody((daily) => {
            const series = daily["precipitation_sum_member03"];
            if (Array.isArray(series)) series[4] = null;
          }),
        ),
      ),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const entry = outcome.value.days.find((day) => day.member === 2 && day.date === DAYS[4]);
    expect(entry?.value).toBeNull();
    expect(outcome.value.ensembleSize).toBe(DAILY_ENSEMBLE_MEMBERS);
  });

  it("refuses an ensemble axis that is not the 15-day horizon", async () => {
    const outcome = await fetchDailyEnsemble(
      CONFIG,
      runtimeReturning(
        ok(
          ensembleBody((daily) => {
            daily["time"] = DAYS.slice(0, 14);
            for (const [key, value] of Object.entries(daily)) {
              if (key === "time") continue;
              if (Array.isArray(value)) daily[key] = value.slice(0, 14);
            }
          }),
        ),
      ),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("incomplete_horizon");
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
