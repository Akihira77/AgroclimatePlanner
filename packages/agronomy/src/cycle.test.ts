import { describe, expect, it } from "vitest";

import type { GrowthStage } from "@agroclimate/contracts";

import { projectCycle } from "./cycle.js";

const stage = (overrides: Partial<GrowthStage> = {}): GrowthStage => ({
  id: "0192f0aa-0000-7000-8000-000000000001",
  name: "vegetatif",
  startDayOffset: 0,
  endDayOffset: 49,
  isCritical: false,
  requirementProfile: null,
  ...overrides,
});

/** Ciherang's shipped stages: 0–49, 50–84 (critical), 85–114, 110–120 days. */
const PADI_STAGES: readonly GrowthStage[] = [
  stage({ id: "0192f0aa-0000-7000-8000-000000000001", startDayOffset: 0, endDayOffset: 49 }),
  stage({
    id: "0192f0aa-0000-7000-8000-000000000002",
    name: "reproduktif",
    startDayOffset: 50,
    endDayOffset: 84,
    isCritical: true,
  }),
  stage({
    id: "0192f0aa-0000-7000-8000-000000000003",
    name: "pemasakan",
    startDayOffset: 85,
    endDayOffset: 114,
  }),
];

const PADI_DURATION = { min: 110, typical: 115, max: 120 };

describe("projectCycle — day 1 is the cycle-start date", () => {
  it("places stage one on day zero and the last stage's final day at duration - 1", () => {
    const cycle = projectCycle({
      stages: PADI_STAGES,
      cycleStartDate: "2026-12-01",
      durationDays: PADI_DURATION,
    });

    expect(cycle.projectedDurationDays).toBe(115);
    expect(cycle.stages.map((entry) => entry.startDate)).toEqual([
      "2026-12-01",
      "2027-01-20",
      "2027-02-24",
    ]);
    // 114 days after 1 Dec, not 115: the cycle has 115 days, and the 115th is
    // offset 114.
    expect(cycle.stages.at(-1)?.endDate).toBe("2027-03-25");
    expect(cycle.stages.every((entry) => !entry.clipped)).toBe(true);
  });

  it("returns the harvest as a window, not a date", () => {
    const cycle = projectCycle({
      stages: PADI_STAGES,
      cycleStartDate: "2026-12-01",
      durationDays: PADI_DURATION,
    });

    expect(cycle.harvestEarliest).toBe("2027-03-20");
    expect(cycle.harvestTypical).toBe("2027-03-25");
    expect(cycle.harvestLatest).toBe("2027-03-30");
  });

  it("carries the critical flag through, so a caller need not re-read the rulebook", () => {
    const cycle = projectCycle({
      stages: PADI_STAGES,
      cycleStartDate: "2026-12-01",
      durationDays: PADI_DURATION,
    });

    expect(cycle.stages.filter((entry) => entry.isCritical)).toHaveLength(1);
    expect(cycle.stages.find((entry) => entry.isCritical)?.name).toBe("reproduktif");
  });
});

describe("projectCycle — clipping is reported, not hidden", () => {
  it("clips a stage that runs past the typical cycle and says so", () => {
    const cycle = projectCycle({
      stages: [
        stage({ startDayOffset: 0, endDayOffset: 89 }),
        stage({
          id: "0192f0aa-0000-7000-8000-000000000002",
          name: "panen",
          startDayOffset: 90,
          endDayOffset: 120,
        }),
      ],
      cycleStartDate: "2026-01-01",
      durationDays: { min: 85, typical: 100, max: 130 },
    });

    const harvest = cycle.stages.at(-1);
    expect(harvest?.endDayOffset).toBe(99);
    expect(harvest?.clipped).toBe(true);
    expect(harvest?.endDate).toBe("2026-04-10");
  });

  it("drops a stage that starts after the typical cycle ends", () => {
    const cycle = projectCycle({
      stages: [
        stage({ startDayOffset: 0, endDayOffset: 59 }),
        stage({
          id: "0192f0aa-0000-7000-8000-000000000002",
          name: "panen",
          startDayOffset: 90,
          endDayOffset: 120,
        }),
      ],
      cycleStartDate: "2026-01-01",
      durationDays: { min: 60, typical: 70, max: 130 },
    });

    expect(cycle.stages.map((entry) => entry.name)).toEqual(["vegetatif"]);
  });

  it("keeps the harvest window wide when the duration range is wide", () => {
    const cycle = projectCycle({
      stages: [stage()],
      cycleStartDate: "2026-01-01",
      durationDays: { min: 90, typical: 100, max: 130 },
    });

    expect([cycle.harvestEarliest, cycle.harvestTypical, cycle.harvestLatest]).toEqual([
      "2026-03-31",
      "2026-04-10",
      "2026-05-10",
    ]);
  });
});

describe("projectCycle — refusals", () => {
  it("refuses an impossible start date instead of normalising it", () => {
    expect(() =>
      projectCycle({
        stages: [stage()],
        cycleStartDate: "2026-02-30",
        durationDays: PADI_DURATION,
      }),
    ).toThrow(/not a real calendar day/);
  });

  it("refuses an unordered duration range", () => {
    expect(() =>
      projectCycle({
        stages: [stage()],
        cycleStartDate: "2026-01-01",
        durationDays: { min: 120, typical: 115, max: 110 },
      }),
    ).toThrow(/not ordered/);
  });

  it("refuses a non-integer duration", () => {
    expect(() =>
      projectCycle({
        stages: [stage()],
        cycleStartDate: "2026-01-01",
        durationDays: { min: 110, typical: 115.5, max: 120 },
      }),
    ).toThrow(/positive integer/);
  });

  it("projects an empty rulebook without inventing a stage", () => {
    const cycle = projectCycle({
      stages: [],
      cycleStartDate: "2026-01-01",
      durationDays: PADI_DURATION,
    });

    expect(cycle.stages).toEqual([]);
    expect(cycle.harvestTypical).toBe("2026-04-25");
  });
});
