import { describe, expect, it } from "vitest";
import { isoDateSchema, isoInstantSchema } from "../src/enums.js";
import { evidenceSegmentSchema, missingRangeSchema } from "../src/provenance.js";

describe("isoDateSchema", () => {
  it.each(["2026-11-18", "1991-01-01", "2020-12-31"])("accepts the calendar date %s", (value) => {
    expect(isoDateSchema.safeParse(value).success).toBe(true);
  });

  it.each(["2024-02-29", "2000-02-29"])("accepts the leap day %s", (value) => {
    expect(isoDateSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    ["day 31 in a 30-day month", "2026-04-31"],
    ["day 31 in February", "2026-02-31"],
    ["month 13", "2026-13-01"],
    ["month 00", "2026-00-10"],
    ["day 00", "2026-11-00"],
    ["non-leap February 29", "2026-02-29"],
    ["century non-leap February 29", "1900-02-29"],
  ])("rejects %s (%s)", (_label, value) => {
    expect(isoDateSchema.safeParse(value).success).toBe(false);
  });

  it.each(["18-11-2026", "2026-11-18T00:00:00Z", "2026-1-8", "2026/11/18"])(
    "rejects the non-conforming shape %s",
    (value) => {
      expect(isoDateSchema.safeParse(value).success).toBe(false);
    },
  );
});

describe("isoInstantSchema", () => {
  it("accepts a UTC instant with the Z suffix", () => {
    expect(isoInstantSchema.safeParse("2026-11-18T00:00:00Z").success).toBe(true);
  });

  it("accepts fractional seconds in UTC", () => {
    expect(isoInstantSchema.safeParse("2026-11-18T00:00:00.123Z").success).toBe(true);
  });

  it.each([
    ["a positive offset", "2026-11-18T00:00:00+07:00"],
    ["a negative offset", "2026-11-18T00:00:00-05:00"],
    ["no zone designator", "2026-11-18T00:00:00"],
    ["a date without a time", "2026-11-18"],
  ])("rejects %s", (_label, value) => {
    expect(isoInstantSchema.safeParse(value).success).toBe(false);
  });

  it("does not normalise an offset into UTC", () => {
    const result = isoInstantSchema.safeParse("2026-11-18T07:00:00+07:00");
    expect(result.success).toBe(false);
  });
});

describe("contracts built on the temporal schemas", () => {
  it("accepts an evidence segment starting on a leap day", () => {
    const segment = {
      startDate: "2024-02-29",
      endDate: "2024-03-31",
      evaluationBasis: "monthly",
      evidenceClass: "seasonal_forecast",
      coveragePercent: 100,
      provenance: {
        kind: "forecast",
        forecastRunIds: ["0192f0aa-0000-7000-8000-000000000001"],
        ingestionRunIds: ["0192f0aa-0000-7000-8000-000000000002"],
        initializedAt: "2024-03-01T00:00:00Z",
      },
    };
    expect(evidenceSegmentSchema.safeParse(segment).success).toBe(true);
  });

  it("rejects an evidence segment on an impossible date", () => {
    expect(
      evidenceSegmentSchema.safeParse({
        startDate: "2026-02-31",
        endDate: "2026-03-31",
        evaluationBasis: "monthly",
        evidenceClass: "seasonal_forecast",
        coveragePercent: 100,
        provenance: {
          kind: "climatology",
          baselineVersion: "ERA5:1991-2020:v1",
        },
      }).success,
    ).toBe(false);
  });

  it("rejects a missing range whose instant carries an offset", () => {
    expect(
      missingRangeSchema.safeParse({
        startDate: "2027-01-01",
        endDate: "2027-01-31",
        reason: "pending",
      }).success,
    ).toBe(true);

    expect(
      evidenceSegmentSchema.safeParse({
        startDate: "2026-12-01",
        endDate: "2026-12-31",
        evaluationBasis: "weekly",
        evidenceClass: "weather_forecast",
        coveragePercent: 80,
        provenance: {
          kind: "forecast",
          forecastRunIds: ["run-1"],
          ingestionRunIds: ["ingest-1"],
          initializedAt: "2026-12-01T00:00:00+07:00",
        },
      }).success,
    ).toBe(false);
  });
});
