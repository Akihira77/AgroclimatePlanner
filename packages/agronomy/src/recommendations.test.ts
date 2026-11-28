import { describe, expect, it } from "vitest";

import { recommendCropsForField } from "./recommendations.js";

const MONTHS_12 = Array.from({ length: 12 }, (_, idx) => {
  const m = ((10 + idx) % 12) + 1;
  const y = 2026 + Math.floor((10 + idx) / 12);
  return {
    month: `${y}-${String(m).padStart(2, "0")}-01`,
    valueMm: idx < 5 ? 240 : 130,
    dataClass: idx < 2 ? "seasonal_forecast" : "climatology",
  };
});

const CROPS = [
  {
    cropId: "c1",
    cropSlug: "jagung",
    cropNameId: "Jagung",
    category: "pangan",
    cultivarId: "v1",
    cultivarName: "Lamuru",
    profileVersionId: "p1",
    durationDaysTypical: 93,
    altitudeMinM: 0,
    altitudeMaxM: 1200,
    constraints: [
      {
        id: "r1",
        dimension: "soil" as const,
        comparator: "range" as const,
        thresholdLower: 5,
        thresholdUpper: 7.5,
        thresholdCount: null,
        unit: "pH",
        growthStageId: null,
        grade: "C" as const,
        severity: "soft" as const,
      },
      {
        id: "r2",
        dimension: "water" as const,
        comparator: "range" as const,
        thresholdLower: 500,
        thresholdUpper: 800,
        thresholdCount: null,
        unit: "mm",
        growthStageId: null,
        grade: "A" as const,
        severity: "soft" as const,
      },
    ],
  },
  {
    cropId: "c2",
    cropSlug: "kentang",
    cropNameId: "Kentang",
    category: "hortikultura",
    cultivarId: "v2",
    cultivarName: "Granola L",
    profileVersionId: "p2",
    durationDaysTypical: 100,
    altitudeMinM: 1000,
    altitudeMaxM: 2000,
    constraints: [
      {
        id: "r3",
        dimension: "soil" as const,
        comparator: "range" as const,
        thresholdLower: 5,
        thresholdUpper: 6.2,
        thresholdCount: null,
        unit: "pH",
        growthStageId: null,
        grade: "A" as const,
        severity: "soft" as const,
      },
      {
        id: "r4",
        dimension: "water" as const,
        comparator: "range" as const,
        thresholdLower: 500,
        thresholdUpper: 700,
        thresholdCount: null,
        unit: "mm",
        growthStageId: null,
        grade: "A" as const,
        severity: "soft" as const,
      },
    ],
  },
];

describe("recommendCropsForField", () => {
  it("ranks suitable/conditional crops ahead of unsuitable lowland kentang and caps climatology at conditional", () => {
    const result = recommendCropsForField({
      field: {
        fieldId: "f1",
        fieldName: "Petak Subang",
        elevationM: 120,
        soilPh: 6.2,
        drainageClass: "moderate",
        irrigationAvailability: "partial_irrigation",
        latestTempC: 28,
      },
      outlookMonths: MONTHS_12,
      crops: CROPS,
      horizonMonths: 6,
    });

    expect(result.months).toHaveLength(12);
    expect(result.matrix).toHaveLength(2);
    expect(result.rankings[0]!.cropSlug).toBe("jagung");
    expect(result.rankings[0]!.verdict).toBe("conditional"); // never 'suitable' on climatology
    expect(result.rankings[1]!.cropSlug).toBe("kentang");
    expect(result.rankings[1]!.verdict).toBe("unsuitable"); // elevation 120m < 1000m
  });

  it("returns insufficient_data without coercing missing outlook to 0", () => {
    const nullMonths = MONTHS_12.map((m) => ({ ...m, valueMm: null, dataClass: null }));
    const result = recommendCropsForField({
      field: {
        fieldId: "f1",
        fieldName: "Petak Kosong",
        elevationM: null,
        soilPh: null,
        drainageClass: null,
        irrigationAvailability: "unknown",
        latestTempC: null,
      },
      outlookMonths: nullMonths,
      crops: CROPS,
      horizonMonths: 3,
    });

    expect(result.rankings.every((r) => r.verdict === "insufficient_data")).toBe(true);
    expect(result.matrix[0]!.cells.every((c) => c.rainfallMm === null)).toBe(true);
  });

  it("changes bestStartMonth across horizonMonths=3 vs 6 when a later month matches ideal rainfall", () => {
    // First 5 months are very wet (350 mm/mo -> >950 mm for starts 0..2, above Jagung's 500-800 mm),
    // while months 5..8 are 200 mm/mo (~620 mm cycle, inside Jagung's ideal 500-800 mm).
    const shapedMonths = MONTHS_12.map((m, idx) => ({
      ...m,
      valueMm: idx < 5 ? 350 : 200,
      dataClass: "seasonal_forecast",
    }));

    const r3 = recommendCropsForField({
      field: {
        fieldId: "f1",
        fieldName: "Petak Uji",
        elevationM: 200,
        soilPh: 6.2,
        drainageClass: "moderate",
        irrigationAvailability: "rainfed",
        latestTempC: 26,
      },
      outlookMonths: shapedMonths,
      crops: [CROPS[0]!],
      horizonMonths: 3,
    });

    const r6 = recommendCropsForField({
      field: {
        fieldId: "f1",
        fieldName: "Petak Uji",
        elevationM: 200,
        soilPh: 6.2,
        drainageClass: "moderate",
        irrigationAvailability: "rainfed",
        latestTempC: 26,
      },
      outlookMonths: shapedMonths,
      crops: [CROPS[0]!],
      horizonMonths: 6,
    });

    expect(r3.rankings[0]!.verdict).toBe("conditional");
    expect(r6.rankings[0]!.verdict).toBe("suitable");
    expect(r6.rankings[0]!.bestStartMonth).toBe(shapedMonths[5]!.month);
    expect(r3.rankings[0]!.bestStartMonth).not.toBe(r6.rankings[0]!.bestStartMonth);
  });
});
