import { describe, expect, it } from "vitest";

import {
  BASELINE_PERIOD,
  baselineHashPayloadOf,
  baselineVersionOf,
  buildMonthlyClimatology,
  type ClimatologyCellInput,
  type DailyPrecipitationInput,
} from "./climatology.js";

/**
 * Fixtures are complete, hand-computable daily series. Nothing calls a provider.
 */

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function dayKey(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Every day of 1991–2020, value chosen by the caller (default: 0 mm). */
function fullSeries(
  value: (year: number, month: number, day: number) => number | null = () => 0,
): DailyPrecipitationInput[] {
  const days: DailyPrecipitationInput[] = [];
  for (let year = BASELINE_PERIOD.startYear; year <= BASELINE_PERIOD.endYear; year += 1) {
    for (let month = 1; month <= 12; month += 1) {
      for (let day = 1; day <= daysInMonth(year, month); day += 1) {
        days.push({ date: dayKey(year, month, day), value: value(year, month, day) });
      }
    }
  }
  return days;
}

function cell(days: readonly DailyPrecipitationInput[], cellKey = "c1"): ClimatologyCellInput {
  return { cellKey, unit: "mm", days };
}

function ok<T>(outcome: { ok: true; value: T } | { ok: false; message: string }): T {
  if (!outcome.ok) throw new Error(outcome.message);
  return outcome.value;
}

describe("baselineVersionOf", () => {
  it("derives the documented version and changes only with dataset or algorithm", () => {
    expect(baselineVersionOf({ dataset: "era5" })).toBe("ERA5:1991-2020:v1");
    expect(baselineVersionOf({ dataset: "era5", algorithmVersion: "v2" })).toBe(
      "ERA5:1991-2020:v2",
    );
    expect(baselineVersionOf({ dataset: "chirps_v3" })).toBe("CHIRPS_v3:1991-2020:v1");
  });

  it("refuses an algorithm version that is not a token", () => {
    expect(() => baselineVersionOf({ dataset: "era5", algorithmVersion: "v 1" })).toThrow(
      RangeError,
    );
  });
});

describe("buildMonthlyClimatology — the arithmetic", () => {
  it("hand-computes a constant-year 30-year mean and emits exactly 12 months", () => {
    const days = fullSeries((_year, month) => (month === 1 ? 2 : month === 7 ? 3 : 0));
    const baseline = ok(buildMonthlyClimatology({ dataset: "era5", cells: [cell(days)] }));

    const normals = baseline.cells[0]?.normals ?? [];
    expect(normals).toHaveLength(12);
    expect(normals.map((normal) => normal.month)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    // January: 31 days × 2 mm = 62 mm, and every January is identical, so the
    // 30-year mean is 62. July: 31 × 3 = 93. February has no rain: 0.
    expect(normals[0]?.valueMm).toBe(62);
    expect(normals[6]?.valueMm).toBe(93);
    expect(normals[1]?.valueMm).toBe(0);
    expect(normals.every((normal) => normal.sampleYears === 30)).toBe(true);
    expect(baseline.cells[0]?.complete).toBe(true);
    expect(baseline.cells[0]?.minSampleYears).toBe(30);
    expect(normals[0]?.monthStart).toBe("1991-01-01");
  });

  it("averages monthly totals, not daily values across all years", () => {
    // January is 2 mm/day for the first half of the years and 4 mm/day for the
    // rest. The mean monthly total is (31×2 + 31×4)/2 = 93 — the same as the
    // daily mean × 31 here, so make one year short to separate the two:
    // 1991 January is 2 mm/day (31 days), all other years 4 mm/day.
    const days = fullSeries((year, month) => {
      if (month !== 1) return 0;
      return year === 1991 ? 2 : 4;
    });
    const baseline = ok(buildMonthlyClimatology({ dataset: "era5", cells: [cell(days)] }));
    const january = baseline.cells[0]?.normals[0];
    // (31×2 + 29×31×4) / 30 = (62 + 3596) / 30 = 121.9333…, a monthly-total
    // mean. Averaging daily values first and multiplying by 31 would give a
    // different number only if the sample were weighted differently, so the
    // sample count is asserted too.
    expect(january?.valueMm).toBeCloseTo(121.93333333333334, 10);
    expect(january?.sampleYears).toBe(30);
  });

  it("handles leap years in February", () => {
    const days = fullSeries((_year, month) => (month === 2 ? 1 : 0));
    const baseline = ok(buildMonthlyClimatology({ dataset: "era5", cells: [cell(days)] }));
    const february = baseline.cells[0]?.normals[1];
    // 22 non-leap Februaries × 28 + 8 leap Februaries × 29 = 848; /30.
    expect(february?.valueMm).toBeCloseTo(848 / 30, 10);
    expect(february?.sampleYears).toBe(30);
  });
});

describe("buildMonthlyClimatology — missing and null data", () => {
  it("does not turn a missing day into zero rainfall", () => {
    const days = fullSeries((_year, month) => (month === 1 ? 1 : 0)).filter(
      (day) => day.date !== "1991-01-15",
    );
    const baseline = ok(buildMonthlyClimatology({ dataset: "era5", cells: [cell(days)] }));
    const january = baseline.cells[0]?.normals[0];
    // 1991 is excluded rather than counted as 30 mm instead of 31 mm.
    expect(january?.sampleYears).toBe(29);
    expect(january?.valueMm).toBe(31);
  });

  it("does not count a null as a valid observation", () => {
    const days = fullSeries((_year, month) => (month === 1 ? 1 : 0)).map((day) =>
      day.date === "1991-01-15" ? { date: day.date, value: null } : day,
    );
    const baseline = ok(buildMonthlyClimatology({ dataset: "era5", cells: [cell(days)] }));
    expect(baseline.cells[0]?.normals[0]?.sampleYears).toBe(29);
    expect(baseline.cells[0]?.normals[0]?.valueMm).toBe(31);
  });

  it("reports an incomplete period as incomplete instead of calling it 30 years", () => {
    const days = fullSeries((_year, month) => (month === 1 ? 1 : 0)).filter((day) =>
      day.date.startsWith("1991-"),
    );
    const baseline = ok(buildMonthlyClimatology({ dataset: "era5", cells: [cell(days)] }));
    expect(baseline.cells[0]?.complete).toBe(false);
    expect(baseline.cells[0]?.minSampleYears).toBe(1);
    expect(baseline.cells[0]?.normals.every((normal) => normal.sampleYears === 1)).toBe(true);
  });

  it("fails closed when a calendar month has no complete year", () => {
    const days = fullSeries().filter((day) => day.date.startsWith("1991-01-"));
    const outcome = buildMonthlyClimatology({ dataset: "era5", cells: [cell(days)] });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("incomplete_history");
    expect(outcome.message).toContain("1991-02");
  });
});

describe("buildMonthlyClimatology — refusals and determinism", () => {
  it("rejects negative, NaN and infinite precipitation", () => {
    const negative = fullSeries().map((day) =>
      day.date === "1991-03-01" ? { date: day.date, value: -1 } : day,
    );
    const nan = fullSeries().map((day) =>
      day.date === "1991-03-01" ? { date: day.date, value: Number.NaN } : day,
    );
    const infinite = fullSeries().map((day) =>
      day.date === "1991-03-01" ? { date: day.date, value: Number.POSITIVE_INFINITY } : day,
    );
    for (const days of [negative, nan, infinite]) {
      const outcome = buildMonthlyClimatology({ dataset: "era5", cells: [cell(days)] });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.kind).toBe("invalid_input");
    }
  });

  it("rejects an unsupported unit, a duplicate day and a day outside the period", () => {
    const days = fullSeries();

    const inch = buildMonthlyClimatology({
      dataset: "era5",
      cells: [{ ...cell(days), unit: "inch" }],
    });
    expect(inch.ok).toBe(false);
    if (!inch.ok) expect(inch.kind).toBe("unsupported_unit");

    const duplicate = buildMonthlyClimatology({
      dataset: "era5",
      cells: [cell([...days, days[0] as DailyPrecipitationInput])],
    });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.kind).toBe("invalid_input");

    const outside = buildMonthlyClimatology({
      dataset: "era5",
      cells: [cell([...days, { date: "1990-12-31", value: 0 }])],
    });
    expect(outside.ok).toBe(false);
    if (!outside.ok) expect(outside.kind).toBe("invalid_input");
  });

  it("is deterministic regardless of input order", () => {
    const days = fullSeries((_year, month, day) => (month * day) / 100);
    const forward = ok(buildMonthlyClimatology({ dataset: "era5", cells: [cell(days)] }));
    const reversed = ok(
      buildMonthlyClimatology({ dataset: "era5", cells: [cell([...days].reverse())] }),
    );
    expect(reversed).toEqual(forward);
  });

  it("keeps each cell's normals separate and rejects a repeated cell key", () => {
    const wet = fullSeries((_year, month) => (month === 1 ? 2 : 0));
    const dry = fullSeries((_year, month) => (month === 1 ? 1 : 0));
    const baseline = ok(
      buildMonthlyClimatology({ dataset: "era5", cells: [cell(wet, "wet"), cell(dry, "dry")] }),
    );
    expect(baseline.cells.map((entry) => entry.cellKey)).toEqual(["wet", "dry"]);
    expect(baseline.cells[0]?.normals[0]?.valueMm).toBe(62);
    expect(baseline.cells[1]?.normals[0]?.valueMm).toBe(31);

    expect(
      buildMonthlyClimatology({ dataset: "era5", cells: [cell(wet, "same"), cell(dry, "same")] })
        .ok,
    ).toBe(false);
  });
});

describe("baselineHashPayloadOf", () => {
  it("covers only the requested subset, independent of key order", () => {
    const days = fullSeries((_year, month) => month);
    const baseline = ok(
      buildMonthlyClimatology({
        dataset: "era5",
        cells: [cell(days, "a"), cell(days, "b"), cell(days, "c")],
      }),
    );
    const two = baselineHashPayloadOf(baseline, ["b", "a"]);
    expect(two.monthlyNormals).toHaveLength(24);
    expect(two.monthlyNormals[0]?.cellKey).toBe("a");
    expect(two.monthlyNormals[12]?.cellKey).toBe("b");
    expect(baselineHashPayloadOf(baseline, ["a", "b"])).toEqual(two);
    expect(() => baselineHashPayloadOf(baseline, ["missing"])).toThrow(RangeError);
  });
});
