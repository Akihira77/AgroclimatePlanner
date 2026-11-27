import type { EvidenceSegment, MissingRange } from "@agroclimate/contracts";

import { addDays, daysBetween } from "./stages.js";

/**
 * The `evidenceSegments ∪ missingRanges` partition validator — `OPEN-26`.
 *
 * The database cannot express this invariant (`provenance-storage.md` §4), so
 * nothing enforces it today: a window whose segments overlap, leave a day
 * uncovered, or claim more coverage than they carry is storable. A dashboard
 * rendering such a window paints a gap as evidence.
 *
 * The six checks are the ones `provenance-contract.md` §4 states, and each one
 * reports itself separately so a failed write names every defect it can see instead
 * of only the first.
 *
 * **One limit, stated rather than hidden:** an interval whose own dates are invalid,
 * or a segment with no evidence at all, is reported and then left out of the
 * interval walk. Its relationship with the other intervals is therefore not
 * reported in the same pass — an operator who fixes the dates may meet a second
 * finding. Keeping a malformed interval in the walk would mean sorting by a date
 * that does not exist, which reports a defect that is not real.
 *
 * Pure: no clock, no I/O, no locale. Dates are compared as fixed-width strings,
 * which is chronologically correct for `YYYY-MM-DD`, and their arithmetic is
 * validated first, so `2026-02-30` is refused rather than normalised into March.
 */

export type PartitionViolationCode =
  | "invalid_range"
  | "overlap"
  | "gap"
  | "span"
  | "no_evidence_segment"
  | "missing_reason"
  | "coverage_mismatch";

export interface PartitionViolation {
  readonly code: PartitionViolationCode;
  /** Which interval, or where the gap sits. Absent for window-wide checks. */
  readonly startDate?: string;
  readonly endDate?: string;
  /** One sentence an operator can log without reading this module. */
  readonly detail: string;
}

export interface PartitionInput {
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly segments: readonly EvidenceSegment[];
  readonly missingRanges: readonly MissingRange[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Slack allowed when reconciling coverage, as a **percentage of the window**.
 *
 * A fixed number of days would be a different rule on a 10-day window than on a
 * 30-day one: half a day of slack is 5 % of ten days and 1.7 % of thirty, so the
 * short window would tolerate the error the check exists to catch.
 */
const COVERAGE_EPSILON_PERCENT = 0.5;

function isCalendarDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  try {
    // `daysBetween` round-trips through `Date`, which is what rejects 2026-02-30.
    daysBetween(value, value);
    return true;
  } catch {
    return false;
  }
}

/** Inclusive length in days. */
function lengthInDays(startDate: string, endDate: string): number {
  return daysBetween(startDate, endDate) + 1;
}

interface Interval {
  readonly kind: "segment" | "missing";
  readonly startDate: string;
  readonly endDate: string;
  readonly coveragePercent?: number;
}

/**
 * Every violation, or an empty array for a valid partition.
 *
 * A caller persisting a window must refuse to write when this is non-empty; there
 * is deliberately no `isValid` shortcut, because the violations are the useful part
 * and a boolean invites `console.warn` instead of refusal.
 */
export function validatePartition(input: PartitionInput): readonly PartitionViolation[] {
  const violations: PartitionViolation[] = [];
  const { windowStart, windowEnd, segments, missingRanges } = input;

  // --- shape, before any arithmetic ---
  let windowValid = isCalendarDate(windowStart) && isCalendarDate(windowEnd);
  if (!windowValid) {
    violations.push({
      code: "invalid_range",
      startDate: windowStart,
      endDate: windowEnd,
      detail: "the window is not a pair of real calendar dates",
    });
  } else if (daysBetween(windowStart, windowEnd) < 0) {
    // A reversed window has a negative length: every later check would divide by it.
    windowValid = false;
    violations.push({
      code: "invalid_range",
      startDate: windowStart,
      endDate: windowEnd,
      detail: "windowStart is after windowEnd",
    });
  }

  const usable: Interval[] = [];
  let dropped = 0;

  for (const segment of segments) {
    if (!isCalendarDate(segment.startDate) || !isCalendarDate(segment.endDate)) {
      dropped += 1;
      violations.push({
        code: "invalid_range",
        startDate: segment.startDate,
        endDate: segment.endDate,
        detail: "the segment is not a pair of real calendar dates",
      });
      continue;
    }
    if (daysBetween(segment.startDate, segment.endDate) < 0) {
      dropped += 1;
      violations.push({
        code: "invalid_range",
        startDate: segment.startDate,
        endDate: segment.endDate,
        detail: "the segment starts after it ends",
      });
      continue;
    }
    // A segment carrying no evidence at all is a missing range. `coveragePercent`
    // is the only signal the row has, and 0 means "every day in here is a hole".
    if (segment.coveragePercent === 0) {
      dropped += 1;
      violations.push({
        code: "no_evidence_segment",
        startDate: segment.startDate,
        endDate: segment.endDate,
        detail: "a segment with 0% coverage reports evidence it does not have",
      });
      continue;
    }
    usable.push({
      kind: "segment",
      startDate: segment.startDate,
      endDate: segment.endDate,
      coveragePercent: segment.coveragePercent,
    });
  }

  for (const range of missingRanges) {
    if (!isCalendarDate(range.startDate) || !isCalendarDate(range.endDate)) {
      dropped += 1;
      violations.push({
        code: "invalid_range",
        startDate: range.startDate,
        endDate: range.endDate,
        detail: "the missing range is not a pair of real calendar dates",
      });
      continue;
    }
    if (daysBetween(range.startDate, range.endDate) < 0) {
      dropped += 1;
      violations.push({
        code: "invalid_range",
        startDate: range.startDate,
        endDate: range.endDate,
        detail: "the missing range starts after it ends",
      });
      continue;
    }
    // Check 5: a missing day without its reason is a silent hole, which is exactly
    // what the partition is meant to make impossible.
    const reason: unknown = range.reason;
    if (typeof reason !== "string" || reason === "") {
      violations.push({
        code: "missing_reason",
        startDate: range.startDate,
        endDate: range.endDate,
        detail: "a missing range carries no reason",
      });
    }
    usable.push({ kind: "missing", startDate: range.startDate, endDate: range.endDate });
  }

  // Fixed-width ISO dates sort chronologically as strings, so this needs no locale.
  const ordered = [...usable].sort(
    (a, b) =>
      (a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : 0) ||
      (a.endDate < b.endDate ? -1 : a.endDate > b.endDate ? 1 : 0),
  );

  let overlapping = false;
  let gapped = false;
  // The furthest day covered so far, not the previous interval's end: an interval
  // can be contained by one that is not its immediate predecessor, and a gap has to
  // be measured from the real edge of coverage or it names days that are covered.
  let maxEnd: string | null = null;

  for (const current of ordered) {
    if (maxEnd !== null) {
      // Check 1: adjacency is legal, sharing a day is not.
      if (current.startDate <= maxEnd) {
        overlapping = true;
        violations.push({
          code: "overlap",
          startDate: current.startDate,
          endDate: current.endDate,
          detail: `overlaps the interval ending ${maxEnd}`,
        });
      } else if (windowValid && daysBetween(maxEnd, current.startDate) > 1) {
        // Check 2: a gap is any day that no interval covers — the days between the
        // farthest edge so far and this interval's start.
        gapped = true;
        violations.push({
          code: "gap",
          startDate: addDays(maxEnd, 1),
          endDate: addDays(current.startDate, -1),
          detail: "no interval covers these days",
        });
      }
    }
    if (maxEnd === null || current.endDate > maxEnd) maxEnd = current.endDate;
  }

  // Check 3: the union must touch both ends of the window. This reads the extremes,
  // so it stands independently of an overlap or a gap in the middle — a partition
  // can end short *and* overlap, and a caller fixing one must see the other.
  let spanBroken = false;

  if (windowValid && maxEnd === null) {
    spanBroken = true;
    violations.push({
      code: "span",
      startDate: windowStart,
      endDate: windowEnd,
      detail:
        dropped === 0
          ? "the window has no segments and no missing ranges"
          : `the window has no usable interval: ${dropped} refused before the walk`,
    });
  } else if (windowValid && maxEnd !== null) {
    const first = ordered[0] as Interval;

    if (first.startDate !== windowStart) {
      spanBroken = true;
      violations.push({
        code: "span",
        startDate: windowStart,
        endDate: first.startDate,
        detail: `the partition starts at ${first.startDate}, not at the window start`,
      });
    }
    if (maxEnd !== windowEnd) {
      spanBroken = true;
      violations.push({
        code: "span",
        startDate: maxEnd,
        endDate: windowEnd,
        detail: `the partition ends at ${maxEnd}, not at the window end`,
      });
    }
  }

  // Check 6: coverage reconciles with the days under it.
  //
  // `Σ coveragePercent × length / window + missing share = 100 %` is an equality in
  // both directions, and it is consistent with a partially covered segment: the
  // weight is what makes a 90 % segment lower its own share. So a shortfall is the
  // defect this check exists for — days inside an "evidence" segment that are
  // neither covered nor declared missing. Only computed when the intervals tile the
  // window exactly, because otherwise the sum is measuring two defects at once; the
  // same reasoning skips it when the partition does not reach the window's ends.
  if (windowValid && !overlapping && !gapped && !spanBroken) {
    const windowDays = lengthInDays(windowStart, windowEnd);
    let accounted = 0;

    for (const interval of ordered) {
      const days = lengthInDays(interval.startDate, interval.endDate);
      accounted +=
        interval.kind === "missing" ? days : ((interval.coveragePercent as number) / 100) * days;
    }

    const slack = (windowDays * COVERAGE_EPSILON_PERCENT) / 100;

    if (Math.abs(accounted - windowDays) > slack) {
      violations.push({
        code: "coverage_mismatch",
        detail: `coverage accounts for ${accounted.toFixed(2)} of ${windowDays} days`,
      });
    }
  }

  return violations;
}
