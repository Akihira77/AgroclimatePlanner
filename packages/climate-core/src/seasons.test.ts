import { describe, expect, it } from "vitest";

import {
  classifyOldemanMonth,
  classifySeasonalRegimes,
  summariseCurrentMonthSeason,
} from "./seasons.js";

describe("Oldeman agroclimate seasonal classification", () => {
  it("classifies boundary values accurately and never coerces null to dry", () => {
    expect(classifyOldemanMonth(null)).toBe("missing");
    expect(classifyOldemanMonth(Number.NaN)).toBe("missing");
    expect(classifyOldemanMonth(0)).toBe("dry");
    expect(classifyOldemanMonth(99.9)).toBe("dry");
    expect(classifyOldemanMonth(100)).toBe("transition");
    expect(classifyOldemanMonth(200)).toBe("transition");
    expect(classifyOldemanMonth(200.1)).toBe("wet");
  });

  it("merges consecutive months of the same category into regime periods", () => {
    const regimes = classifySeasonalRegimes([
      { month: "2026-11-01", valueMm: 240, dataClass: "seasonal_forecast" },
      { month: "2026-12-01", valueMm: 310, dataClass: "seasonal_forecast" },
      { month: "2027-01-01", valueMm: 150, dataClass: "climatology" },
      { month: "2027-02-01", valueMm: 60, dataClass: "climatology" },
      { month: "2027-03-01", valueMm: null, dataClass: null },
    ]);

    expect(regimes).toHaveLength(4);
    expect(regimes[0]).toMatchObject({
      startMonth: "2026-11-01",
      endMonth: "2026-12-01",
      monthCount: 2,
      category: "wet",
      minMm: 240,
      maxMm: 310,
      avgMm: 275,
    });
    expect(regimes[1]).toMatchObject({
      startMonth: "2027-01-01",
      endMonth: "2027-01-01",
      monthCount: 1,
      category: "transition",
    });
    expect(regimes[2]).toMatchObject({
      startMonth: "2027-02-01",
      endMonth: "2027-02-01",
      monthCount: 1,
      category: "dry",
    });
    expect(regimes[3]).toMatchObject({
      startMonth: "2027-03-01",
      endMonth: "2027-03-01",
      monthCount: 1,
      category: "missing",
      minMm: null,
      maxMm: null,
      avgMm: null,
    });
  });

  it("degrades honestly when all outlook months are null", () => {
    const summary = summariseCurrentMonthSeason(
      [{ month: "2026-11-01", valueMm: null }],
      "2026-11-01",
    );
    expect(summary.category).toBe("missing");
    expect(summary.valueMm).toBeNull();
    expect(summary.summaryId).toContain("belum tersedia");
  });
});
