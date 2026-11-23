import { describe, expect, it, vi } from "vitest";

import type { AdapterRuntime } from "../runtime.js";
import type { Transport, TransportResult } from "../http.js";
import {
  SEAS5_ENSEMBLE_MEMBERS,
  buildSeas5MemberDailyUrl,
  fetchSeas5MemberDaily,
  seas5MemberWindow,
} from "./open-meteo-seasonal.js";

/**
 * The SEAS5 member request, against a synthetic provider. Every fixture is
 * labelled as such: these tests prove the adapter's contract, not the provider's
 * behaviour. The live evidence is recorded in
 * `docs/research/forecast-horizon-capabilities.md` (2026-11-23).
 */

const CONFIG = {
  latitude: -6.2,
  longitude: 106.8,
  initializedAt: "2026-11-01T00:00:00Z",
  attribution: "ECMWF / Open-Meteo, CC BY 4.0",
};

const START = Date.UTC(2026, 10, 1);
const DAY_MS = 86_400_000;

function dates(count: number): string[] {
  return Array.from({ length: count }, (_, index) =>
    new Date(START + index * DAY_MS).toISOString().slice(0, 10),
  );
}

const D212 = dates(212);
const MEMBER_NAMES = Array.from(
  { length: SEAS5_ENSEMBLE_MEMBERS },
  (_, index) => `precipitation_sum_member${String(index + 1).padStart(2, "0")}`,
);

const ok = (body: string, status = 200): TransportResult => ({
  ok: true,
  response: { status, bodyText: body },
});

function runtime(result: TransportResult): AdapterRuntime {
  const transport: Transport = { get: async () => result };
  return {
    transport,
    now: () => new Date("2026-11-23T06:00:00Z"),
    timeoutMs: 1_000,
    maxBytes: 4_000_000,
  };
}

function body(
  options: {
    axis?: readonly string[];
    members?: readonly string[];
    value?: (member: number, day: number) => number | null;
    meanValues?: readonly (number | null)[];
    omitMean?: boolean;
    unit?: string;
    extraColumn?: string;
  } = {},
): string {
  const axis = options.axis ?? D212;
  const daily: Record<string, unknown> = { time: axis };
  if (options.omitMean !== true) {
    daily["precipitation_sum"] = options.meanValues ?? axis.map((_, index) => index / 100);
  }
  for (const [offset, name] of (options.members ?? MEMBER_NAMES).entries()) {
    daily[name] = axis.map((_, index) => (options.value ? options.value(offset, index) : offset));
  }
  if (options.extraColumn !== undefined) daily[options.extraColumn] = axis.map(() => 1);
  return JSON.stringify({
    latitude: -6.323185,
    longitude: 106.68874,
    daily_units: { precipitation_sum: options.unit ?? "mm" },
    daily,
  });
}

describe("SEAS5 member window", () => {
  it("spans the seven calendar months of the run, not seven 30-day blocks", () => {
    const window = seas5MemberWindow("2026-11-01T00:00:00Z");
    expect(window?.startDate).toBe("2026-11-01");
    expect(window?.endDate).toBe("2027-05-31");
    expect(window?.months).toEqual([
      "2026-11-01",
      "2026-12-01",
      "2027-01-01",
      "2027-02-01",
      "2027-03-01",
      "2027-04-01",
      "2027-05-01",
    ]);
    // 30 + 31 + 31 + 28 + 31 + 30 + 31
    expect(window?.days).toBe(212);
  });

  it("uses the initialization month even when the run started mid-month", () => {
    expect(seas5MemberWindow("2026-11-23T06:00:00Z")?.startDate).toBe("2026-11-01");
    expect(seas5MemberWindow("2026-11-30T23:59:59Z")?.endDate).toBe("2027-05-31");
  });

  it("counts a leap February", () => {
    const window = seas5MemberWindow("2023-12-05T00:00:00Z");
    // Dec + Jan + Feb 2024 + Mar + Apr + May + Jun
    expect(window?.endDate).toBe("2024-06-30");
    expect(window?.days).toBe(31 + 31 + 29 + 31 + 30 + 31 + 30);
  });

  it("refuses an instant that is not a date", () => {
    expect(seas5MemberWindow("not-a-date")).toBeNull();
  });
});

describe("SEAS5 member request", () => {
  it("pins the calendar range, the model, and no timezone override", () => {
    const url = new URL(buildSeas5MemberDailyUrl(CONFIG) as string);
    expect(url.origin).toBe("https://seasonal-api.open-meteo.com");
    expect(url.pathname).toBe("/v1/seasonal");
    expect(url.searchParams.get("models")).toBe("ecmwf_seas5");
    expect(url.searchParams.get("daily")).toBe("precipitation_sum");
    expect(url.searchParams.get("start_date")).toBe("2026-11-01");
    expect(url.searchParams.get("end_date")).toBe("2027-05-31");
    // `forecast_days` would anchor the axis on the request day instead of the run.
    expect(url.searchParams.get("forecast_days")).toBeNull();
    expect(url.searchParams.get("timezone")).toBeNull();
  });

  it("builds the same URL twice from the same config", () => {
    expect(buildSeas5MemberDailyUrl(CONFIG)).toBe(buildSeas5MemberDailyUrl(CONFIG));
  });

  it("makes no request when the configuration is invalid", async () => {
    const get = vi.fn<Transport["get"]>();
    const adapter: AdapterRuntime = {
      transport: { get },
      now: () => new Date("2026-11-23T00:00:00Z"),
      timeoutMs: 1_000,
      maxBytes: 1_000,
    };

    const http = await fetchSeas5MemberDaily(
      { ...CONFIG, baseUrl: "http://example.test" },
      adapter,
    );
    expect(http.ok).toBe(false);
    if (!http.ok) expect(http.kind).toBe("invalid_config");

    const bad = await fetchSeas5MemberDaily({ ...CONFIG, initializedAt: "yesterday" }, adapter);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.kind).toBe("invalid_config");

    expect(get).not.toHaveBeenCalled();
  });
});

describe("SEAS5 member response", () => {
  it("returns 50 members × 212 days and never the mean as a member", async () => {
    const outcome = await fetchSeas5MemberDaily(CONFIG, runtime(ok(body({ value: () => 1 }))));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.value.model).toBe("ecmwf_seas5");
    expect(outcome.value.product).toBe("seasonal");
    expect(outcome.value.unit).toBe("mm");
    expect(outcome.value.ensembleSize).toBe(50);
    expect(outcome.value.days).toHaveLength(212 * 50);

    const members = new Set(outcome.value.days.map((day) => day.member));
    expect(members.size).toBe(50);
    expect(Math.min(...[...members].map((member) => member ?? -1))).toBe(0);
    expect(Math.max(...[...members].map((member) => member ?? -1))).toBe(49);
    // The mean column carries `index / 100`; every member is 1 here.
    expect(outcome.value.days.every((day) => day.value === 1)).toBe(true);
    expect(outcome.value.days[0]?.date).toBe("2026-11-01");
    expect(outcome.value.days.at(-1)?.date).toBe("2027-05-31");
  });

  it("keeps a member null as null", async () => {
    const outcome = await fetchSeas5MemberDaily(
      CONFIG,
      runtime(ok(body({ value: (member, day) => (member === 3 && day === 40 ? null : 0.5) }))),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const target = outcome.value.days.filter(
      (day) => day.member === 3 && day.date === "2026-12-11",
    );
    expect(target).toHaveLength(1);
    expect(target[0]?.value).toBeNull();
  });

  it("rejects a short axis, a long axis, a gap and a shifted start", async () => {
    const short = await fetchSeas5MemberDaily(
      CONFIG,
      runtime(ok(body({ axis: D212.slice(0, 211) }))),
    );
    expect(short.ok).toBe(false);
    if (!short.ok) expect(short.kind).toBe("incomplete_horizon");

    const long = await fetchSeas5MemberDaily(
      CONFIG,
      runtime(ok(body({ axis: [...D212, "2027-06-01"] }))),
    );
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.kind).toBe("provider_changed");

    const gapAxis = [...D212.slice(0, 10), ...D212.slice(11), "2027-06-01"];
    const gap = await fetchSeas5MemberDaily(CONFIG, runtime(ok(body({ axis: gapAxis }))));
    expect(gap.ok).toBe(false);
    if (!gap.ok) expect(gap.message).toContain("not the day after");

    const shifted = await fetchSeas5MemberDaily(
      CONFIG,
      runtime(
        ok(
          body({
            axis: Array.from({ length: 212 }, (_, index) =>
              new Date(START + DAY_MS + index * DAY_MS).toISOString().slice(0, 10),
            ),
          }),
        ),
      ),
    );
    expect(shifted.ok).toBe(false);
    if (!shifted.ok) {
      expect(shifted.kind).toBe("provider_changed");
      expect(shifted.message).toContain("starts at");
    }
  });

  it("rejects a duplicated, missing, 51st and unexpected member", async () => {
    const duplicated = MEMBER_NAMES.map((name, index) =>
      index === 10 ? "precipitation_sum_member9" : name,
    );
    const duplicate = await fetchSeas5MemberDaily(
      CONFIG,
      runtime(ok(body({ members: duplicated }))),
    );
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.message).toContain("duplicated");

    const missing = await fetchSeas5MemberDaily(
      CONFIG,
      runtime(ok(body({ members: MEMBER_NAMES.slice(0, 49) }))),
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.message).toContain("missing 50");

    const extra = await fetchSeas5MemberDaily(
      CONFIG,
      runtime(ok(body({ members: [...MEMBER_NAMES, "precipitation_sum_member51"] }))),
    );
    expect(extra.ok).toBe(false);
    if (!extra.ok) expect(extra.message).toContain("outside 1..50");

    const unexpected = await fetchSeas5MemberDaily(
      CONFIG,
      runtime(ok(body({ extraColumn: "temperature_2m" }))),
    );
    expect(unexpected.ok).toBe(false);
    if (!unexpected.ok) expect(unexpected.message).toContain("unexpected column");
  });

  it("rejects a response without the mean column", async () => {
    const outcome = await fetchSeas5MemberDaily(CONFIG, runtime(ok(body({ omitMean: true }))));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain("mean column");
  });

  it("maps 429, 4xx, 5xx and a transport error", async () => {
    const limited = await fetchSeas5MemberDaily(CONFIG, runtime(ok("", 429)));
    expect(limited.ok).toBe(false);
    if (!limited.ok) expect(limited.kind).toBe("rate_limited");

    const bad = await fetchSeas5MemberDaily(CONFIG, runtime(ok("", 400)));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.kind).toBe("request_invalid");

    const down = await fetchSeas5MemberDaily(CONFIG, runtime(ok("", 503)));
    expect(down.ok).toBe(false);
    if (!down.ok) expect(down.kind).toBe("transport");

    const network = await fetchSeas5MemberDaily(CONFIG, {
      ...runtime({ ok: false, kind: "transport", message: "network request failed (TypeError)" }),
    });
    expect(network.ok).toBe(false);
    if (!network.ok) expect(network.kind).toBe("transport");
  });
});
