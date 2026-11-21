import { describe, expect, it, vi } from "vitest";
import type { Transport, TransportResult } from "../http.js";
import type { AdapterRuntime } from "../runtime.js";
import {
  SEAS5_MONTHLY_FORECAST_DAYS,
  buildSeas5MonthlyUrl,
  fetchSeas5Monthly,
  type Seas5MonthlyConfig,
} from "./open-meteo-seasonal.js";

/**
 * Every payload below is **synthetic**. None is a recording of a live provider
 * response; the only real observations being reproduced are the pinned request
 * parameters and the 6-vs-7 row behaviour documented in
 * `docs/research/forecast-horizon-capabilities.md`.
 */
function syntheticBody(options: {
  months: readonly string[];
  values: readonly (number | null)[];
  unit?: string;
}): string {
  return JSON.stringify({
    latitude: -6.125,
    longitude: 106.875,
    monthly_units: { precipitation_mean: options.unit ?? "mm" },
    monthly: { time: options.months, precipitation_mean: options.values },
  });
}

const SEVEN_MONTHS = [
  "2026-11-01",
  "2026-12-01",
  "2027-01-01",
  "2027-02-01",
  "2027-03-01",
  "2027-04-01",
  "2027-05-01",
];
const SEVEN_VALUES = [247.6, 336.4, 367.6, 335.7, 340.3, 332.8, 225.1];

const CONFIG: Seas5MonthlyConfig = {
  latitude: -6.2,
  longitude: 106.8,
  initializedAt: "2026-11-01T00:00:00Z",
  attribution: "ECMWF / Open-Meteo, CC BY 4.0",
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

const ok = (body: string, status = 200): TransportResult => ({
  ok: true,
  response: { status, bodyText: body },
});

describe("SEAS5 monthly request", () => {
  it("pins the parameters that decide the horizon", () => {
    const url = new URL(buildSeas5MonthlyUrl(CONFIG));
    expect(url.origin).toBe("https://seasonal-api.open-meteo.com");
    expect(url.pathname).toBe("/v1/seasonal");
    expect(url.searchParams.get("models")).toBe("ecmwf_seas5");
    expect(url.searchParams.get("monthly")).toBe("precipitation_mean");
    expect(url.searchParams.get("forecast_days")).toBe(String(SEAS5_MONTHLY_FORECAST_DAYS));
    expect(url.searchParams.get("latitude")).toBe("-6.2");
    expect(url.searchParams.get("longitude")).toBe("106.8");
    // The default 6-row horizon is never requested.
    expect(SEAS5_MONTHLY_FORECAST_DAYS).toBe(217);
  });

  it("builds the same URL twice from the same config", () => {
    expect(buildSeas5MonthlyUrl(CONFIG)).toBe(buildSeas5MonthlyUrl(CONFIG));
  });

  it("makes no request when the configuration is invalid", async () => {
    const get = vi.fn<Transport["get"]>();
    const runtime: AdapterRuntime = {
      transport: { get },
      now: () => new Date("2026-11-21T00:00:00Z"),
      timeoutMs: 1_000,
      maxBytes: 1_000,
    };
    const missingInit = await fetchSeas5Monthly({ ...CONFIG, initializedAt: "" }, runtime);
    expect(missingInit.ok).toBe(false);
    if (!missingInit.ok) expect(missingInit.kind).toBe("invalid_config");

    const http = await fetchSeas5Monthly({ ...CONFIG, baseUrl: "http://example.test" }, runtime);
    expect(http.ok).toBe(false);
    if (!http.ok) expect(http.kind).toBe("invalid_config");

    const latitude = await fetchSeas5Monthly({ ...CONFIG, latitude: -91 }, runtime);
    expect(latitude.ok).toBe(false);
    if (!latitude.ok) expect(latitude.kind).toBe("invalid_config");

    expect(get).not.toHaveBeenCalled();
  });
});

describe("SEAS5 monthly response", () => {
  it("returns the provider-native series without claiming a monthly total", async () => {
    const outcome = await fetchSeas5Monthly(
      CONFIG,
      runtimeReturning(ok(syntheticBody({ months: SEVEN_MONTHS, values: SEVEN_VALUES }))),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.provider).toBe("open-meteo");
    expect(outcome.value.model).toBe("ecmwf_seas5");
    expect(outcome.value.variable).toBe("precipitation_mean");
    expect(outcome.value.unit).toBe("mm");
    expect(outcome.value.months).toHaveLength(7);
    expect(outcome.value.months[0]).toEqual({ month: "2026-11-01", value: 247.6 });
    expect(outcome.value.requestedLatitude).toBe(-6.2);
    expect(outcome.value.servedLatitude).toBe(-6.125);
    expect(outcome.value.initializedAtSource).toBe("request_configuration");
    expect(outcome.value.rawPayloadRef).toBeNull();
    expect(Object.isFrozen(outcome.value.months)).toBe(true);
    expect("valueMm" in outcome.value).toBe(false);
  });

  it("accepts the abbreviated month key and normalizes it", async () => {
    const months = ["2026-11", "2026-12", "2027-01", "2027-02", "2027-03", "2027-04", "2027-05"];
    const outcome = await fetchSeas5Monthly(
      CONFIG,
      runtimeReturning(ok(syntheticBody({ months, values: SEVEN_VALUES }))),
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.value.months[0]?.month).toBe("2026-11-01");
  });

  it("treats six rows as an incomplete horizon, not a six-month outlook", async () => {
    const outcome = await fetchSeas5Monthly(
      CONFIG,
      runtimeReturning(
        ok(syntheticBody({ months: SEVEN_MONTHS.slice(0, 6), values: SEVEN_VALUES.slice(0, 6) })),
      ),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.kind).toBe("incomplete_horizon");
  });

  it("rejects a duplicate or out-of-order month", async () => {
    const duplicate = [...SEVEN_MONTHS.slice(0, 6), "2027-04-01"];
    const dupOutcome = await fetchSeas5Monthly(
      CONFIG,
      runtimeReturning(ok(syntheticBody({ months: duplicate, values: SEVEN_VALUES }))),
    );
    expect(dupOutcome.ok).toBe(false);
    if (!dupOutcome.ok) expect(dupOutcome.kind).toBe("provider_changed");

    const reversed = [...SEVEN_MONTHS].reverse();
    const revOutcome = await fetchSeas5Monthly(
      CONFIG,
      runtimeReturning(ok(syntheticBody({ months: reversed, values: SEVEN_VALUES }))),
    );
    expect(revOutcome.ok).toBe(false);
    if (!revOutcome.ok) expect(revOutcome.kind).toBe("provider_changed");
  });

  it("accepts a seven-month axis that crosses a year boundary", async () => {
    const months = [
      "2026-12-01",
      "2027-01-01",
      "2027-02-01",
      "2027-03-01",
      "2027-04-01",
      "2027-05-01",
      "2027-06-01",
    ];
    const outcome = await fetchSeas5Monthly(
      CONFIG,
      runtimeReturning(ok(syntheticBody({ months, values: SEVEN_VALUES }))),
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.months.map((month) => month.month)).toEqual(months);
    }
  });

  it("rejects seven rows with a missing calendar month", async () => {
    // Seven rows, strictly increasing — and January is simply absent. Row count
    // alone accepted this before F-10.
    const months = [
      "2026-11-01",
      "2026-12-01",
      "2027-02-01",
      "2027-03-01",
      "2027-04-01",
      "2027-05-01",
      "2027-06-01",
    ];
    const outcome = await fetchSeas5Monthly(
      CONFIG,
      runtimeReturning(ok(syntheticBody({ months, values: SEVEN_VALUES }))),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.kind).toBe("provider_changed");
      // Index 2 is the first key that is not the successor of the previous one.
      expect(outcome.message).toContain("monthly.time[2]");
      expect(outcome.message).toContain("2027-02-01");
      expect(outcome.message).toContain("2026-12-01");
    }
  });

  it("rejects a gap across the December to January rollover", async () => {
    // December is present and the next key is February: the year arithmetic must
    // see the jump, not treat a new year as a new sequence.
    const months = [
      "2026-09-01",
      "2026-10-01",
      "2026-11-01",
      "2026-12-01",
      "2027-02-01",
      "2027-03-01",
      "2027-04-01",
    ];
    const outcome = await fetchSeas5Monthly(
      CONFIG,
      runtimeReturning(ok(syntheticBody({ months, values: SEVEN_VALUES }))),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.kind).toBe("provider_changed");
  });

  it("rejects seven rows whose tail replaces a missing month", async () => {
    // February is dropped and May is appended in its place: seven rows, one span,
    // and a hole the count cannot reveal.
    const months = [
      "2026-12-01",
      "2027-01-01",
      "2027-03-01",
      "2027-04-01",
      "2027-05-01",
      "2027-06-01",
      "2027-07-01",
    ];
    const outcome = await fetchSeas5Monthly(
      CONFIG,
      runtimeReturning(ok(syntheticBody({ months, values: SEVEN_VALUES }))),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.kind).toBe("provider_changed");
  });

  it("checks continuity on the abbreviated month key too", async () => {
    const continuous = [
      "2026-12",
      "2027-01",
      "2027-02",
      "2027-03",
      "2027-04",
      "2027-05",
      "2027-06",
    ];
    const good = await fetchSeas5Monthly(
      CONFIG,
      runtimeReturning(ok(syntheticBody({ months: continuous, values: SEVEN_VALUES }))),
    );
    expect(good.ok).toBe(true);

    const hole = ["2026-12", "2027-02", "2027-03", "2027-04", "2027-05", "2027-06", "2027-07"];
    const bad = await fetchSeas5Monthly(
      CONFIG,
      runtimeReturning(ok(syntheticBody({ months: hole, values: SEVEN_VALUES }))),
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.kind).toBe("provider_changed");
  });

  it("rejects a month key that is not the first of a month", async () => {
    const months = ["2026-11-15", ...SEVEN_MONTHS.slice(1)];
    const outcome = await fetchSeas5Monthly(
      CONFIG,
      runtimeReturning(ok(syntheticBody({ months, values: SEVEN_VALUES }))),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.kind).toBe("provider_changed");
  });

  it("rejects arrays of different lengths", async () => {
    const outcome = await fetchSeas5Monthly(
      CONFIG,
      runtimeReturning(ok(syntheticBody({ months: SEVEN_MONTHS, values: SEVEN_VALUES.slice(1) }))),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.kind).toBe("provider_changed");
  });

  it("rejects a response whose shape changed", async () => {
    const outcome = await fetchSeas5Monthly(
      CONFIG,
      runtimeReturning(ok(JSON.stringify({ latitude: -6.1, longitude: 106.8 }))),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.kind).toBe("provider_changed");
  });

  it("rejects a body that is not JSON", async () => {
    const outcome = await fetchSeas5Monthly(CONFIG, runtimeReturning(ok("<html>oops</html>")));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.kind).toBe("provider_changed");
  });

  it("keeps nulls as nulls instead of substituting zero", async () => {
    const values = [247.6, null, 367.6, 335.7, 340.3, 332.8, 225.1];
    const outcome = await fetchSeas5Monthly(
      CONFIG,
      runtimeReturning(ok(syntheticBody({ months: SEVEN_MONTHS, values }))),
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.value.months[1]?.value).toBeNull();
  });
});

describe("SEAS5 failure classification", () => {
  it("maps 429 to rate_limited with Retry-After", async () => {
    const outcome = await fetchSeas5Monthly(CONFIG, {
      ...runtimeReturning({
        ok: true,
        response: { status: 429, bodyText: "", retryAfterSeconds: 30 },
      }),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.kind).toBe("rate_limited");
      expect(outcome.retryAfterSeconds).toBe(30);
    }
  });

  it("maps 400 to request_invalid and 500 to transport", async () => {
    const bad = await fetchSeas5Monthly(CONFIG, runtimeReturning(ok("", 400)));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.kind).toBe("request_invalid");

    const down = await fetchSeas5Monthly(CONFIG, runtimeReturning(ok("", 503)));
    expect(down.ok).toBe(false);
    if (!down.ok) expect(down.kind).toBe("transport");
  });

  it("maps an unexpected status to provider_changed", async () => {
    const outcome = await fetchSeas5Monthly(CONFIG, runtimeReturning(ok("", 302)));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.kind).toBe("provider_changed");
  });

  it("maps a transport error to transport", async () => {
    const outcome = await fetchSeas5Monthly(
      CONFIG,
      runtimeReturning({
        ok: false,
        kind: "transport",
        message: "network request failed (TypeError)",
      }),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.kind).toBe("transport");
  });
});
