import { describe, expect, it } from "vitest";

import {
  SEAS5_PROVIDER_CONSISTENCY_MS,
  SEAS5_RELEASE_DAY_UTC,
  SEAS5_RELEASE_HOUR_UTC,
  seasonalAvailability,
  seasonalStaleBoundary,
} from "./freshness.js";

describe("seasonalStaleBoundary — the next scheduled SEAS5 release", () => {
  it("is the 5th at 12:00 UTC of the month after initialisation", () => {
    expect(seasonalStaleBoundary("2026-11-01T00:00:00.000Z")).toBe("2026-12-05T12:00:00.000Z");
    expect(SEAS5_RELEASE_DAY_UTC).toBe(5);
    expect(SEAS5_RELEASE_HOUR_UTC).toBe(12);
  });

  it("is a property of the initialisation month, not the day", () => {
    const first = seasonalStaleBoundary("2026-11-01T00:00:00.000Z");
    const last = seasonalStaleBoundary("2026-11-30T23:59:59.000Z");
    expect(last).toBe(first);
  });

  it("rolls December into January", () => {
    expect(seasonalStaleBoundary("2026-12-01T00:00:00.000Z")).toBe("2027-01-05T12:00:00.000Z");
  });

  it("refuses an instant that is not UTC", () => {
    expect(() => seasonalStaleBoundary("2026-11-01T00:00:00+07:00")).toThrow(RangeError);
    expect(() => seasonalStaleBoundary("not-a-date")).toThrow(RangeError);
  });
});

describe("seasonalAvailability — read-time, never stored", () => {
  const INIT = "2026-11-01T00:00:00.000Z";

  it("is fresh before the boundary and stale at it", () => {
    expect(seasonalAvailability(INIT, "2026-12-05T11:59:59.999Z")).toBe("fresh");
    expect(seasonalAvailability(INIT, "2026-12-05T12:00:00.000Z")).toBe("stale");
    expect(seasonalAvailability(INIT, "2027-03-01T00:00:00.000Z")).toBe("stale");
  });

  it("records the provider consistency wait without adding it", () => {
    // A provisional zero grace period: the token exists so the omission is
    // deliberate and greppable, not so it can be silently applied.
    expect(SEAS5_PROVIDER_CONSISTENCY_MS).toBe(600_000);
    expect(seasonalStaleBoundary(INIT)).toBe("2026-12-05T12:00:00.000Z");
  });
});
