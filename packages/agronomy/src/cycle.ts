import type { GrowthStage } from "@agroclimate/contracts";

import { addDays } from "./stages.js";

/**
 * Cycle projection — the agronomic half of Phase 7's calendar, and the first thing
 * this repository computes for a user rather than for a test.
 *
 * It aligns a rulebook's stage offsets to calendar dates, which is arithmetic over
 * two stored facts: the offsets and the cultivar's own duration range. Nothing is
 * scored, nothing is ranked, and no climate value is consulted — a projection says
 * *when* a phase falls, never whether the crop suits the place. That distinction is
 * why it can ship while `OPEN-21` and `OPEN-18` still block a suitability verdict.
 *
 * **Day 1 is the cycle-start date**, so the last day of an `n`-day cycle is offset
 * `n - 1`. The seed's own stages end at `duration - 1` (padi 0–114 for a 115-day
 * Ciherang), and `criticalStageWindows` clips to `duration - 1` for the same
 * reason. Using `n` here would put every stage one day late.
 *
 * **The duration is a range, and the answer keeps it one.** Cultivar durations are
 * stored as min/typical/max, so a single harvest date would be the false precision
 * this product forbids. The stages are projected on the typical duration — a
 * reading, stated as such — and the harvest is returned as a window. Only the
 * dates, never a verdict about them.
 */

/** One stage placed on the calendar. */
export interface ProjectedStage {
  readonly stageId: string;
  readonly name: string;
  readonly startDayOffset: number;
  readonly endDayOffset: number;
  readonly startDate: string;
  readonly endDate: string;
  readonly isCritical: boolean;
  /**
   * `true` when the typical cycle ends before the rulebook's stage does. The date
   * is the cycle's last day, not the stage's, and a caller that hides this would
   * present a truncated phase as a complete one.
   */
  readonly clipped: boolean;
}

export interface ProjectedCycle {
  readonly cycleStartDate: string;
  /** The total the stages were clipped to. `null` when the rulebook has no stages. */
  readonly projectedDurationDays: number;
  readonly harvestEarliest: string;
  readonly harvestTypical: string;
  readonly harvestLatest: string;
  /** Offset order, ties by id — the same ordering `stageAtOffset` uses. */
  readonly stages: readonly ProjectedStage[];
}

export interface ProjectCycleInput {
  readonly stages: readonly GrowthStage[];
  readonly cycleStartDate: string;
  readonly durationDays: { readonly min: number; readonly max: number; readonly typical: number };
}

export function projectCycle(input: ProjectCycleInput): ProjectedCycle {
  const { stages, cycleStartDate, durationDays } = input;

  for (const [name, value] of Object.entries(durationDays)) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new RangeError(`durationDays.${name} must be a positive integer: ${value}`);
    }
  }
  if (durationDays.min > durationDays.typical || durationDays.typical > durationDays.max) {
    throw new RangeError(
      `duration range is not ordered: ${durationDays.min}/${durationDays.typical}/${durationDays.max}`,
    );
  }

  // `addDays` refuses an unreal calendar date, so an impossible start fails here
  // rather than producing a plausible-looking timeline from a normalised one.
  const lastDay = durationDays.typical - 1;

  const projected = [...stages]
    .filter((stage) => stage.startDayOffset <= lastDay)
    .sort(
      (a, b) =>
        a.startDayOffset - b.startDayOffset ||
        a.endDayOffset - b.endDayOffset ||
        // Plain comparison, not `localeCompare`: this module promises no locale.
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
    .map((stage) => {
      const endDayOffset = Math.min(stage.endDayOffset, lastDay);
      return {
        stageId: stage.id,
        name: stage.name,
        startDayOffset: stage.startDayOffset,
        endDayOffset,
        startDate: addDays(cycleStartDate, stage.startDayOffset),
        endDate: addDays(cycleStartDate, endDayOffset),
        isCritical: stage.isCritical,
        clipped: endDayOffset < stage.endDayOffset,
      };
    });

  return {
    cycleStartDate,
    projectedDurationDays: durationDays.typical,
    harvestEarliest: addDays(cycleStartDate, durationDays.min - 1),
    harvestTypical: addDays(cycleStartDate, durationDays.typical - 1),
    harvestLatest: addDays(cycleStartDate, durationDays.max - 1),
    stages: projected,
  };
}
