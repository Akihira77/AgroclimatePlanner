import { describe, expect, it } from "vitest";

import { buildFieldWeeklyWeatherAdvisory, detectCriticalStageAlerts } from "./advisory.js";

describe("buildFieldWeeklyWeatherAdvisory", () => {
  it("degrades honestly when no non-null days exist", () => {
    const res = buildFieldWeeklyWeatherAdvisory({
      fieldId: "f-1",
      fieldName: "Petak A1",
      farmName: "Kebun Subang",
      days: [
        { date: "2026-11-28", rainMm: null },
        { date: "2026-11-29", rainMm: null },
      ],
    });
    expect(res.hasData).toBe(false);
    expect(res.totalRainMm).toBeNull();
    expect(res.peakRainDate).toBeNull();
    expect(res.peakRainMm).toBeNull();
    expect(res.advisoryTextId).toContain("belum tersedia");
  });

  it("highlights heavy rain peak >= 20 mm with farmer operational advice", () => {
    const res = buildFieldWeeklyWeatherAdvisory({
      fieldId: "f-1",
      fieldName: "Lembang Utara",
      farmName: "Kebun Lembang",
      days: [
        { date: "2026-12-01", rainMm: 5.2 },
        { date: "2026-12-05", rainMm: 27.4 },
        { date: "2026-12-06", rainMm: null },
      ],
    });
    expect(res.hasData).toBe(true);
    expect(res.totalRainMm).toBe(32.6);
    expect(res.peakRainDate).toBe("2026-12-05");
    expect(res.peakRainMm).toBe(27.4);
    expect(res.advisoryTextId).toContain("5 Des");
    expect(res.advisoryTextId).toContain("27 mm");
  });
});

describe("detectCriticalStageAlerts", () => {
  const stages = [
    { id: "s1", name: "vegetatif", startDayOffset: 0, endDayOffset: 43, isCritical: false, requirementProfile: null },
    { id: "s2", name: "pembungaan", startDayOffset: 44, endDayOffset: 71, isCritical: true, requirementProfile: null },
    { id: "s3", name: "panen", startDayOffset: 72, endDayOffset: 100, isCritical: false, requirementProfile: null },
  ];

  it("detects both active and approaching critical stages within 14 days", () => {
    const alerts = detectCriticalStageAlerts(
      [
        {
          plantingId: "p-active",
          fieldId: "f-1",
          fieldName: "Blok Timur",
          cropNameId: "Cabai",
          cultivarName: "Prima Agrihorti",
          plantedAt: "2026-10-10",
          durationDaysMin: 90,
          durationDaysTypical: 100,
          durationDaysMax: 110,
          stages,
          weeklyRainMm: 42,
          latestTempC: 24,
        },
        {
          plantingId: "p-soon",
          fieldId: "f-2",
          fieldName: "Blok Barat",
          cropNameId: "Cabai",
          cultivarName: "Prima Agrihorti",
          plantedAt: "2026-10-22",
          durationDaysMin: 90,
          durationDaysTypical: 100,
          durationDaysMax: 110,
          stages,
          weeklyRainMm: null,
          latestTempC: null,
        },
        {
          plantingId: "p-far",
          fieldId: "f-3",
          fieldName: "Blok Jauh",
          cropNameId: "Cabai",
          cultivarName: "Prima Agrihorti",
          plantedAt: "2026-11-25",
          durationDaysMin: 90,
          durationDaysTypical: 100,
          durationDaysMax: 110,
          stages,
          weeklyRainMm: null,
          latestTempC: null,
        },
      ],
      "2026-11-28",
    );

    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toMatchObject({
      plantingId: "p-active",
      status: "in_critical",
      stageName: "pembungaan",
    });
    expect(alerts[1]).toMatchObject({
      plantingId: "p-soon",
      status: "approaching_critical",
      daysUntilStart: 7,
    });
  });
});
