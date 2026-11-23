import { describe, expect, it, vi } from "vitest";
import type { Transport, TransportResult } from "../http.js";
import type { AdapterRuntime } from "../runtime.js";
import {
  SEAS5_MONTHLY_FORECAST_DAYS,
  buildEc46DailyUrl,
  buildSeas5MonthlyUrl,
  fetchEc46Daily,
  fetchSeas5Monthly,
  type Seas5MonthlyConfig,
} from "./open-meteo-seasonal.js";
import type { DailyAdapterConfig } from "./open-meteo-daily.js";

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

function runtimeReturning(
  result: TransportResult,
  nowIso = "2026-11-21T00:00:00Z",
): AdapterRuntime {
  const transport: Transport = { get: async () => result };
  return {
    transport,
    now: () => new Date(nowIso),
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

/* ------------------------------------------------------------------ *
 * EC46 daily — Phase 5.6
 * ------------------------------------------------------------------ */

const EC46_START = Date.UTC(2026, 10, 23);
const EC46_DATES = Array.from({ length: 46 }, (_, index) =>
  new Date(EC46_START + index * 86_400_000).toISOString().slice(0, 10),
);
const EC46_MEMBER_NAMES = Array.from(
  { length: 50 },
  (_, index) => `precipitation_sum_member${String(index + 1).padStart(2, "0")}`,
);

const EC46_CONFIG: DailyAdapterConfig = {
  latitude: -6.2,
  longitude: 106.8,
  attribution: "ECMWF / Open-Meteo, CC BY 4.0",
};

/** `now` is pinned to the request date the pinned `time[0]` anchor requires. */
function ec46Runtime(result: TransportResult): AdapterRuntime {
  return runtimeReturning(result, "2026-11-23T06:00:00Z");
}

function ec46Body(
  options: {
    dates?: readonly string[];
    members?: readonly string[];
    memberValues?: readonly (number | null)[];
    mean?: readonly (number | null)[];
    unit?: string;
    omitMean?: boolean;
    extraColumn?: string;
  } = {},
): string {
  const dates = options.dates ?? EC46_DATES;
  const daily: Record<string, unknown> = { time: dates };
  if (options.omitMean !== true) {
    daily["precipitation_sum"] = options.mean ?? dates.map((_, index) => index / 2);
  }
  for (const name of options.members ?? EC46_MEMBER_NAMES) {
    daily[name] = options.memberValues ?? dates.map((_, index) => index / 10);
  }
  if (options.extraColumn !== undefined) daily[options.extraColumn] = dates.map(() => 1);
  return JSON.stringify({
    latitude: -6.323185,
    longitude: 106.68874,
    daily_units: { precipitation_sum: options.unit ?? "mm" },
    daily,
  });
}

describe("EC46 daily request", () => {
  it("pins the parameters that decide the horizon", () => {
    const url = new URL(buildEc46DailyUrl(EC46_CONFIG));
    expect(url.origin).toBe("https://seasonal-api.open-meteo.com");
    expect(url.pathname).toBe("/v1/seasonal");
    expect(url.searchParams.get("models")).toBe("ecmwf_ec46");
    expect(url.searchParams.get("daily")).toBe("precipitation_sum");
    expect(url.searchParams.get("forecast_days")).toBe("46");
    // The probed request carried no timezone parameter; the default is GMT.
    expect(url.searchParams.get("timezone")).toBeNull();
  });

  it("builds the same URL twice from the same config", () => {
    expect(buildEc46DailyUrl(EC46_CONFIG)).toBe(buildEc46DailyUrl(EC46_CONFIG));
  });

  it("makes no request when the configuration is invalid", async () => {
    const get = vi.fn<Transport["get"]>();
    const runtime: AdapterRuntime = {
      transport: { get },
      now: () => new Date("2026-11-23T06:00:00Z"),
      timeoutMs: 1_000,
      maxBytes: 1_000,
    };
    const http = await fetchEc46Daily({ ...EC46_CONFIG, baseUrl: "http://example.test" }, runtime);
    expect(http.ok).toBe(false);
    if (!http.ok) expect(http.kind).toBe("invalid_config");

    const latitude = await fetchEc46Daily({ ...EC46_CONFIG, latitude: Number.NaN }, runtime);
    expect(latitude.ok).toBe(false);
    if (!latitude.ok) expect(latitude.kind).toBe("invalid_config");

    expect(get).not.toHaveBeenCalled();
  });
});

describe("EC46 daily response", () => {
  it("returns 50 members × 46 days and never the mean as a member", async () => {
    const outcome = await fetchEc46Daily(
      EC46_CONFIG,
      ec46Runtime(ok(ec46Body({ memberValues: EC46_DATES.map(() => 1) }))),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.value.model).toBe("ecmwf_ec46");
    expect(outcome.value.product).toBe("seasonal");
    expect(outcome.value.variable).toBe("precipitation_sum");
    expect(outcome.value.unit).toBe("mm");
    expect(outcome.value.ensembleSize).toBe(50);
    expect(outcome.value.days).toHaveLength(46 * 50);

    // `member` is null for a deterministic product; EC46 is never one.
    const members = new Set(outcome.value.days.map((day) => day.member));
    expect(members.has(null)).toBe(false);
    const ids = [...members].map((member) => member ?? -1);
    expect(ids.length).toBe(50);
    expect(Math.min(...ids)).toBe(0);
    expect(Math.max(...ids)).toBe(49);

    // The mean column equals `index / 2`; every member here is 1, so a mean
    // leaking in as a member would show up as a value that is not 1.
    expect(outcome.value.days.every((day) => day.value === 1)).toBe(true);
    expect(outcome.value.days[0]?.date).toBe("2026-11-23");
    expect(outcome.value.days.at(-1)?.date).toBe("2027-01-07");
  });

  it("keeps member nulls as nulls", async () => {
    const memberValues = EC46_DATES.map((_, index) => (index === 45 ? null : 0.5));
    const outcome = await fetchEc46Daily(EC46_CONFIG, ec46Runtime(ok(ec46Body({ memberValues }))));
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      const lastDay = outcome.value.days.filter((day) => day.date === "2027-01-07");
      expect(lastDay).toHaveLength(50);
      expect(lastDay.every((day) => day.value === null)).toBe(true);
    }
  });

  it("rejects an axis that does not start at the request day", async () => {
    const shifted = EC46_DATES.map((_, index) =>
      new Date(EC46_START + (index + 1) * 86_400_000).toISOString().slice(0, 10),
    );
    const outcome = await fetchEc46Daily(
      EC46_CONFIG,
      ec46Runtime(ok(ec46Body({ dates: shifted }))),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.kind).toBe("provider_changed");
      expect(outcome.message).toContain("lead-day indexing");
    }
  });

  it("rejects a short and a long axis", async () => {
    const short = await fetchEc46Daily(
      EC46_CONFIG,
      ec46Runtime(ok(ec46Body({ dates: EC46_DATES.slice(0, 45) }))),
    );
    expect(short.ok).toBe(false);
    if (!short.ok) expect(short.kind).toBe("incomplete_horizon");

    const long = await fetchEc46Daily(
      EC46_CONFIG,
      ec46Runtime(
        ok(
          ec46Body({
            dates: [...EC46_DATES, "2027-01-08"],
          }),
        ),
      ),
    );
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.kind).toBe("incomplete_horizon");
  });

  it("rejects an axis with a skipped day", async () => {
    const dates = [...EC46_DATES.slice(0, 20), ...EC46_DATES.slice(21), "2027-01-08"];
    const outcome = await fetchEc46Daily(EC46_CONFIG, ec46Runtime(ok(ec46Body({ dates }))));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.kind).toBe("provider_changed");
      expect(outcome.message).toContain("not the day after");
    }
  });

  it("rejects a duplicated member identifier", async () => {
    // `_member9` and `_member09` are the same member with two spellings.
    const members = EC46_MEMBER_NAMES.map((name, index) =>
      index === 10 ? "precipitation_sum_member9" : name,
    );
    const outcome = await fetchEc46Daily(EC46_CONFIG, ec46Runtime(ok(ec46Body({ members }))));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain("duplicated");
  });

  it("rejects a missing member", async () => {
    const outcome = await fetchEc46Daily(
      EC46_CONFIG,
      ec46Runtime(ok(ec46Body({ members: EC46_MEMBER_NAMES.slice(0, 49) }))),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.kind).toBe("provider_changed");
      expect(outcome.message).toContain("missing 50");
    }
  });

  it("rejects a 51st member column", async () => {
    const outcome = await fetchEc46Daily(
      EC46_CONFIG,
      ec46Runtime(
        ok(
          ec46Body({
            members: [...EC46_MEMBER_NAMES, "precipitation_sum_member51"],
          }),
        ),
      ),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain("outside 1..50");
  });

  it("rejects an unexpected column", async () => {
    const outcome = await fetchEc46Daily(
      EC46_CONFIG,
      ec46Runtime(ok(ec46Body({ extraColumn: "temperature_2m" }))),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain("unexpected column");
  });

  it("rejects a response without the mean column", async () => {
    const outcome = await fetchEc46Daily(
      EC46_CONFIG,
      ec46Runtime(ok(ec46Body({ omitMean: true }))),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain("mean column");
  });

  it("rejects a changed shape, a non-JSON body, and a non-numeric column", async () => {
    const shape = await fetchEc46Daily(
      EC46_CONFIG,
      ec46Runtime(ok(JSON.stringify({ latitude: -6.3, longitude: 106.7 }))),
    );
    expect(shape.ok).toBe(false);
    if (!shape.ok) expect(shape.kind).toBe("provider_changed");

    const html = await fetchEc46Daily(EC46_CONFIG, ec46Runtime(ok("<html>oops</html>")));
    expect(html.ok).toBe(false);
    if (!html.ok) expect(html.kind).toBe("provider_changed");

    const body = JSON.parse(ec46Body()) as { daily: Record<string, unknown> };
    body.daily["precipitation_sum_member01"] = ["a"];
    const nonNumeric = await fetchEc46Daily(EC46_CONFIG, ec46Runtime(ok(JSON.stringify(body))));
    expect(nonNumeric.ok).toBe(false);
    if (!nonNumeric.ok) expect(nonNumeric.kind).toBe("provider_changed");
  });

  it("maps 429, 4xx, 5xx, an unexpected status and a transport error", async () => {
    const limited = await fetchEc46Daily(EC46_CONFIG, {
      ...ec46Runtime(ok("", 429)),
    });
    expect(limited.ok).toBe(false);
    if (!limited.ok) expect(limited.kind).toBe("rate_limited");

    const bad = await fetchEc46Daily(EC46_CONFIG, ec46Runtime(ok("", 400)));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.kind).toBe("request_invalid");

    const down = await fetchEc46Daily(EC46_CONFIG, ec46Runtime(ok("", 503)));
    expect(down.ok).toBe(false);
    if (!down.ok) expect(down.kind).toBe("transport");

    const redirect = await fetchEc46Daily(EC46_CONFIG, ec46Runtime(ok("", 302)));
    expect(redirect.ok).toBe(false);
    if (!redirect.ok) expect(redirect.kind).toBe("provider_changed");

    const network = await fetchEc46Daily(EC46_CONFIG, {
      ...ec46Runtime({
        ok: false,
        kind: "transport",
        message: "network request failed (TypeError)",
      }),
    });
    expect(network.ok).toBe(false);
    if (!network.ok) expect(network.kind).toBe("transport");
  });
});
