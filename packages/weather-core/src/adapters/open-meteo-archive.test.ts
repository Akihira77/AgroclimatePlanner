import { describe, expect, it } from "vitest";
import type { Transport, TransportResult } from "../http.js";
import type { AdapterRuntime } from "../runtime.js";
import {
  ARCHIVE_ADAPTER_VERSION,
  ARCHIVE_MODEL,
  ARCHIVE_PERIOD_FROM,
  ARCHIVE_PERIOD_TO,
  ARCHIVE_UNIT,
  archiveDayCount,
  buildArchiveDailyUrl,
  fetchArchiveDaily,
  type ArchiveAdapterConfig,
} from "./open-meteo-archive.js";

/**
 * Every payload below is **synthetic**. The pinned request parameters and the
 * served-coordinate caveat come from the provider documentation and a controlled
 * probe on 2026-11-23; no fixture is a recording of a live response.
 */

const DAYS = ["2020-01-01", "2020-01-02", "2020-01-03"];

const CONFIG: ArchiveAdapterConfig = {
  latitude: -6.25,
  longitude: 106.75,
  startDate: "2020-01-01",
  endDate: "2020-01-03",
  attribution: "Contains modified Copernicus Climate Change Service information (2026)",
};

function runtimeReturning(result: TransportResult): AdapterRuntime {
  const transport: Transport = { get: async () => result };
  return {
    transport,
    now: () => new Date("2026-11-23T00:00:00Z"),
    timeoutMs: 20_000,
    maxBytes: 8 * 1024 * 1024,
  };
}

const ok = (body: unknown, status = 200): TransportResult => ({
  ok: true,
  response: { status, bodyText: JSON.stringify(body) },
});

function body(values: readonly (number | null)[], overrides: Record<string, unknown> = {}) {
  return {
    latitude: -6.25,
    longitude: 106.75,
    timezone: "GMT",
    utc_offset_seconds: 0,
    daily_units: { time: "iso8601", precipitation_sum: ARCHIVE_UNIT },
    daily: { time: DAYS, precipitation_sum: values },
    ...overrides,
  };
}

describe("buildArchiveDailyUrl", () => {
  it("pins ERA5, daily precipitation, mm, UTC and the nearest cell", () => {
    const url = new URL(buildArchiveDailyUrl(CONFIG));
    expect(url.origin).toBe("https://archive-api.open-meteo.com");
    expect(url.pathname).toBe("/v1/archive");
    expect(url.searchParams.get("models")).toBe(ARCHIVE_MODEL);
    expect(url.searchParams.get("daily")).toBe("precipitation_sum");
    expect(url.searchParams.get("precipitation_unit")).toBe(ARCHIVE_UNIT);
    expect(url.searchParams.get("timezone")).toBe("UTC");
    expect(url.searchParams.get("cell_selection")).toBe("nearest");
    expect(url.searchParams.get("start_date")).toBe("2020-01-01");
    expect(url.searchParams.get("end_date")).toBe("2020-01-03");
  });

  it("counts the 1991–2020 window as 10 958 days, in one request", () => {
    expect(ARCHIVE_PERIOD_FROM).toBe("1991-01-01");
    expect(ARCHIVE_PERIOD_TO).toBe("2020-12-31");
    expect(archiveDayCount(ARCHIVE_PERIOD_FROM, ARCHIVE_PERIOD_TO)).toBe(10_958);
  });
});

describe("fetchArchiveDaily", () => {
  it("returns the provider-native daily series for a valid response", async () => {
    const outcome = await fetchArchiveDaily(CONFIG, runtimeReturning(ok(body([1.2, null, 0]))));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.model).toBe(ARCHIVE_MODEL);
    expect(outcome.value.adapterVersion).toBe(ARCHIVE_ADAPTER_VERSION);
    expect(outcome.value.product).toBe("archive");
    expect(outcome.value.unit).toBe("mm");
    expect(outcome.value.servedLatitude).toBe(-6.25);
    expect(outcome.value.servedLongitude).toBe(106.75);
    expect(outcome.value.days).toEqual([
      { date: "2020-01-01", value: 1.2 },
      { date: "2020-01-02", value: null },
      { date: "2020-01-03", value: 0 },
    ]);
  });

  it("keeps a null instead of zero-filling it", async () => {
    const outcome = await fetchArchiveDaily(CONFIG, runtimeReturning(ok(body([null, null, null]))));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.days.map((day) => day.value)).toEqual([null, null, null]);
  });

  it("maps 429 to rate_limited and keeps Retry-After", async () => {
    const outcome = await fetchArchiveDaily(
      CONFIG,
      runtimeReturning({
        ok: true,
        response: {
          status: 429,
          bodyText: "",
          retryAfterSeconds: 120,
        },
      }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("rate_limited");
    expect(outcome.retryAfterSeconds).toBe(120);
  });

  it("maps 4xx to request_invalid and 5xx to transport", async () => {
    for (const [status, kind] of [
      [400, "request_invalid"],
      [404, "request_invalid"],
      [500, "transport"],
      [503, "transport"],
    ] as const) {
      const outcome = await fetchArchiveDaily(
        CONFIG,
        runtimeReturning({ ok: true, response: { status, bodyText: "{}" } }),
      );
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.kind).toBe(kind);
    }
  });

  it("maps a timeout or network failure to transport, including the size cap", async () => {
    for (const message of [
      "network request failed (AbortError)",
      "response exceeded 8388608 bytes",
    ]) {
      const outcome = await fetchArchiveDaily(
        CONFIG,
        runtimeReturning({ ok: false, kind: "transport", message }),
      );
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.kind).toBe("transport");
        expect(outcome.message).toBe(message);
      }
    }
  });

  it("rejects malformed JSON and a missing daily axis", async () => {
    const malformed = await fetchArchiveDaily(
      CONFIG,
      runtimeReturning({
        ok: true,
        response: { status: 200, bodyText: "{not json" },
      }),
    );
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.kind).toBe("provider_changed");

    const missing = await fetchArchiveDaily(
      CONFIG,
      runtimeReturning(ok({ latitude: -6.25, longitude: 106.75 })),
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.kind).toBe("provider_changed");
  });

  it("rejects a duplicate or non-consecutive date even when the count matches", async () => {
    const duplicate = await fetchArchiveDaily(
      CONFIG,
      runtimeReturning(
        ok(
          body([1, 2, 3], {
            daily: {
              time: ["2020-01-01", "2020-01-01", "2020-01-03"],
              precipitation_sum: [1, 2, 3],
            },
          }),
        ),
      ),
    );
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.kind).toBe("provider_changed");

    const skipped = await fetchArchiveDaily(
      CONFIG,
      runtimeReturning(
        ok(
          body([1, 2, 3], {
            daily: {
              time: ["2020-01-01", "2020-01-02", "2020-01-05"],
              precipitation_sum: [1, 2, 3],
            },
          }),
        ),
      ),
    );
    expect(skipped.ok).toBe(false);
    if (!skipped.ok) expect(skipped.kind).toBe("provider_changed");
  });

  it("rejects a short axis as incomplete and a long axis as drift", async () => {
    const short = await fetchArchiveDaily(
      CONFIG,
      runtimeReturning(
        ok(body([1, 2], { daily: { time: DAYS.slice(0, 2), precipitation_sum: [1, 2] } })),
      ),
    );
    expect(short.ok).toBe(false);
    if (!short.ok) expect(short.kind).toBe("incomplete_horizon");

    const long = await fetchArchiveDaily(
      CONFIG,
      runtimeReturning(
        ok(
          body([1, 2, 3, 4], {
            daily: { time: [...DAYS, "2020-01-04"], precipitation_sum: [1, 2, 3, 4] },
          }),
        ),
      ),
    );
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.kind).toBe("provider_changed");
  });

  it("rejects an unexpected unit instead of converting it silently", async () => {
    const outcome = await fetchArchiveDaily(
      CONFIG,
      runtimeReturning(ok(body([1, 2, 3], { daily_units: { precipitation_sum: "inch" } }))),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.kind).toBe("unsupported_unit");
  });

  it("rejects invalid coordinates and an impossible date before requesting", async () => {
    let requested = 0;
    const transport: Transport = {
      get: async () => {
        requested += 1;
        return ok(body([1, 2, 3]));
      },
    };
    const runtime: AdapterRuntime = {
      transport,
      now: () => new Date("2026-11-23T00:00:00Z"),
      timeoutMs: 1_000,
      maxBytes: 1_000,
    };

    for (const patch of [
      { latitude: 91 },
      { longitude: -181 },
      { latitude: Number.NaN },
      { startDate: "2020-02-30" },
      { endDate: "2019-12-31" },
      { startDate: "1939-12-31" },
    ] satisfies Partial<ArchiveAdapterConfig>[]) {
      const outcome = await fetchArchiveDaily({ ...CONFIG, ...patch }, runtime);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.kind).toBe("invalid_config");
    }
    expect(requested).toBe(0);
  });
});
