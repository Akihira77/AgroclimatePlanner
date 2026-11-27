import type { GrowthStage } from "@agroclimate/contracts";

/**
 * Growth-stage alignment — Phase 6.3.
 *
 * Pure date arithmetic in UTC on `YYYY-MM-DD` values. No clock, no time zone, no
 * locale: a stage boundary is a calendar day, and turning that into an instant
 * would make the answer depend on the machine.
 *
 * Day 0 is whatever the caller says it is. For rice and chili that is not
 * ambiguous in the catalogue (`cycleStart` is `sowing` or `transplant`), but this
 * module does not guess: it aligns offsets to the date it is given, and the caller
 * names the event (`agronomic-reference-matrix.md` §6.1d).
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const MS_PER_DAY = 86_400_000;

/** Epoch milliseconds at UTC midnight, refusing anything that is not a calendar date. */
function utcMidnight(isoDate: string): number {
  if (!ISO_DATE.test(isoDate)) {
    throw new RangeError(`not an ISO calendar date: ${isoDate}`);
  }
  const parts = isoDate.split("-").map(Number);
  const [year, month, day] = parts as [number, number, number];
  const ms = Date.UTC(year, month - 1, day);
  const roundTrip = new Date(ms).toISOString().slice(0, 10);
  if (roundTrip !== isoDate) {
    throw new RangeError(`not a real calendar day: ${isoDate}`);
  }
  return ms;
}

/** `2026-11-27` → `2026-11-30` = 3. Negative when `to` precedes `from`. */
export function daysBetween(from: string, to: string): number {
  return Math.round((utcMidnight(to) - utcMidnight(from)) / MS_PER_DAY);
}

/** Calendar-day addition. `addDays("2026-02-27", 2) === "2026-03-01"` in a common year. */
export function addDays(isoDate: string, days: number): string {
  if (!Number.isInteger(days)) throw new RangeError(`days must be an integer: ${days}`);
  return new Date(utcMidnight(isoDate) + days * MS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * The stage a day offset falls in, or `null` when it falls in none.
 *
 * Bounds are inclusive. The DDL does not forbid overlapping stages, so ties are
 * resolved deterministically: earliest `startDayOffset`, then earliest
 * `endDayOffset`, then id. A `null` is a real answer — a gap between stages is not
 * "the previous stage continues".
 */
export function stageAtOffset(
  stages: readonly GrowthStage[],
  dayOffset: number,
): GrowthStage | null {
  if (!Number.isInteger(dayOffset))
    throw new RangeError(`dayOffset must be an integer: ${dayOffset}`);

  const candidates = stages
    .filter((stage) => dayOffset >= stage.startDayOffset && dayOffset <= stage.endDayOffset)
    .sort(
      (a, b) =>
        a.startDayOffset - b.startDayOffset ||
        a.endDayOffset - b.endDayOffset ||
        // Plain comparison, not `localeCompare`: the header promises no locale, and
        // ICU collation is a runtime dependency the reproducibility claim cannot take.
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );

  return candidates[0] ?? null;
}

export interface CriticalStageWindow {
  readonly stage: GrowthStage;
  /** Inclusive, and clipped to the cycle when one is given. */
  readonly startDayOffset: number;
  readonly endDayOffset: number;
  readonly startDate: string;
  readonly endDate: string;
}

/**
 * Every critical stage, as calendar dates, in offset order.
 *
 * `durationDays` clips a stage that runs past the end of the cycle: the last day
 * of a cycle of `n` days is offset `n - 1`, so a critical window that starts
 * after that day does not exist and is dropped. Without `durationDays` the
 * rulebook's offsets are returned as stated.
 */
export function criticalStageWindows(
  stages: readonly GrowthStage[],
  cycleStartDate: string,
  durationDays?: number,
): readonly CriticalStageWindow[] {
  if (durationDays !== undefined && (!Number.isInteger(durationDays) || durationDays <= 0)) {
    throw new RangeError(`durationDays must be a positive integer: ${durationDays}`);
  }

  const lastDay = durationDays === undefined ? null : durationDays - 1;

  return stages
    .filter((stage) => stage.isCritical)
    .sort((a, b) => a.startDayOffset - b.startDayOffset || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .flatMap((stage) => {
      const startDayOffset = stage.startDayOffset;
      const endDayOffset =
        lastDay === null ? stage.endDayOffset : Math.min(stage.endDayOffset, lastDay);

      if (endDayOffset < startDayOffset) return [];

      return [
        {
          stage,
          startDayOffset,
          endDayOffset,
          startDate: addDays(cycleStartDate, startDayOffset),
          endDate: addDays(cycleStartDate, endDayOffset),
        },
      ];
    });
}
