import { describe, expect, it } from "vitest";

import type { GrowthStage } from "@agroclimate/contracts";

import { addDays, criticalStageWindows, daysBetween, stageAtOffset } from "./stages.js";

const stage = (overrides: Partial<GrowthStage> = {}): GrowthStage => ({
  id: "0192f0aa-0000-7000-8000-000000000001",
  name: "panicle initiation",
  startDayOffset: 40,
  endDayOffset: 55,
  isCritical: true,
  requirementProfile: null,
  ...overrides,
});

describe("daysBetween and addDays — UTC calendar days, refused when unreal", () => {
  it("counts across a month boundary and signs a reversed pair", () => {
    expect(daysBetween("2026-11-27", "2026-12-01")).toBe(4);
    expect(daysBetween("2026-12-01", "2026-11-27")).toBe(-4);
  });

  it("rolls over months and years, leap day included", () => {
    expect(addDays("2026-02-27", 2)).toBe("2026-03-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2028-12-31", 1)).toBe("2029-01-01");
  });

  it("refuses an impossible day instead of normalising it into the next month", () => {
    expect(() => daysBetween("2026-02-30", "2026-03-01")).toThrow(RangeError);
    expect(() => addDays("2026-13-01", 0)).toThrow(RangeError);
    expect(() => addDays("2026-11-27", 1.5)).toThrow(RangeError);
  });
});

describe("stageAtOffset — both bounds are inclusive", () => {
  it("answers a stage at its first, last and interior day", () => {
    const stages = [stage()];
    expect(stageAtOffset(stages, 40)?.name).toBe("panicle initiation");
    expect(stageAtOffset(stages, 55)?.name).toBe("panicle initiation");
    expect(stageAtOffset(stages, 41)?.name).toBe("panicle initiation");
  });

  it("answers null in a gap rather than continuing the previous stage", () => {
    expect(stageAtOffset([stage({ startDayOffset: 40, endDayOffset: 55 })], 56)).toBeNull();
    expect(stageAtOffset([], 0)).toBeNull();
  });

  it("breaks a tie by earliest start, then earliest end, then id", () => {
    const wide = stage({
      id: "0192f0aa-0000-7000-8000-00000000000b",
      startDayOffset: 10,
      endDayOffset: 20,
    });
    const narrow = stage({
      id: "0192f0aa-0000-7000-8000-00000000000a",
      startDayOffset: 10,
      endDayOffset: 15,
    });
    // Same start: the earlier end wins, so the answer does not depend on input order.
    expect(stageAtOffset([wide, narrow], 12)?.id).toBe(narrow.id);
    expect(stageAtOffset([narrow, wide], 12)?.id).toBe(narrow.id);
  });
});

describe("criticalStageWindows — clipped to the cycle, dropped when wholly past it", () => {
  it("clips a stage that runs past the cycle and keeps a leap-year date right", () => {
    const windows = criticalStageWindows(
      [stage({ startDayOffset: 88, endDayOffset: 120 })],
      "2028-01-01",
      90,
    );

    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({
      startDayOffset: 88,
      endDayOffset: 89,
      startDate: "2028-03-29",
      endDate: "2028-03-30",
    });
  });

  it("drops a critical stage that starts after the last day of the cycle", () => {
    // Day 89 is the last day of a 90-day cycle; 95 is past it, so the window does
    // not exist. Clamping it into the cycle would invent an exposure.
    expect(
      criticalStageWindows([stage({ startDayOffset: 95, endDayOffset: 100 })], "2028-01-01", 90),
    ).toEqual([]);
  });

  it("returns the stated offsets when no cycle length is given", () => {
    const windows = criticalStageWindows([stage()], "2026-11-01");

    expect(windows[0]).toMatchObject({ startDayOffset: 40, endDayOffset: 55 });
    expect(windows[0]?.startDate).toBe("2026-12-11");
  });

  it("ignores stages the rulebook does not mark critical", () => {
    expect(criticalStageWindows([stage({ isCritical: false })], "2026-11-01")).toEqual([]);
  });

  it("refuses a cycle length that cannot describe a cycle", () => {
    expect(() => criticalStageWindows([stage()], "2026-11-01", 0)).toThrow(RangeError);
  });
});
