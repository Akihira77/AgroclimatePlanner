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
 * The six checks are the ones `provenance-contract.md` §4 states, in its order, and
 * each one reports itself separately so a failed write names every defect at once
 * instead of the first.
 *
 * Pure: no clock, no I/O, no locale. Dates are calendar days, compared as strings
 * only after their arithmetic has been validated, so `2026-02-30` is refused rather
 * than normalised into March.
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

/** Percentage points of slack allowed when reconciling coverage. */
const COVERAGE_EPSILON = 0.5;

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

  for (const segment of segments) {
    if (!isCalendarDate(segment.startDate) || !isCalendarDate(segment.endDate)) {
      violations.push({
        code: "invalid_range",
        startDate: segment.startDate,
        endDate: segment.endDate,
        detail: "the segment is not a pair of real calendar dates",
      });
      continue;
    }
    if (daysBetween(segment.startDate, segment.endDate) < 0) {
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
      violations.push({
        code: "invalid_range",
        startDate: range.startDate,
        endDate: range.endDate,
        detail: "the missing range is not a pair of real calendar dates",
      });
      continue;
    }
    if (daysBetween(range.startDate, range.endDate) < 0) {
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

  // Checks 1–3 need sorted intervals; ties are broken by end so that a contained
  // interval sorts before the one that contains it and the overlap is reported once.
  const ordered = [...usable].sort(
    (a, b) => a.startDate.localeCompare(b.startDate) || a.endDate.localeCompare(b.endDate),
  );

  let overlapping = false;
  let gapped = false;

  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1] as Interval;
    const current = ordered[index] as Interval;

    // Check 1: adjacency is legal, sharing a day is not.
    if (current.startDate <= previous.endDate) {
      overlapping = true;
      violations.push({
        code: "overlap",
        startDate: current.startDate,
        endDate: current.endDate,
        detail: `overlaps the ${previous.kind} ending ${previous.endDate}`,
      });
      continue;
    }

    // Check 2: a gap is any day that no interval covers.
    if (windowValid && daysBetween(previous.endDate, current.startDate) > 1) {
      gapped = true;
      violations.push({
        code: "gap",
        startDate: addDays(previous.endDate, 1),
        endDate: addDays(current.startDate, -1),
        detail: "no interval covers these days",
      });
    }
  }

  // Check 3: the union must touch both ends of the window. This reads the extremes,
  // so it stands independently of an overlap or a gap in the middle — a partition
  // can end short *and* overlap, and a caller fixing one must see the other.
  if (windowValid && ordered.length === 0) {
    violations.push({
      code: "span",
      startDate: windowStart,
      endDate: windowEnd,
      detail: "the window has no segments and no missing ranges",
    });
  } else if (windowValid) {
    const first = ordered[0] as Interval;
    const last = ordered[ordered.length - 1] as Interval;

    if (first.startDate !== windowStart) {
      violations.push({
        code: "span",
        startDate: windowStart,
        endDate: first.startDate,
        detail: `the partition starts at ${first.startDate}, not at the window start`,
      });
    }
    if (last.endDate !== windowEnd) {
      violations.push({
        code: "span",
        startDate: last.endDate,
        endDate: windowEnd,
        detail: `the partition ends at ${last.endDate}, not at the window end`,
      });
    }
  }

  // Check 6: the reported coverage must not claim more days than the window has.
  //
  // The contract's formula is `Σ coveragePercent × length / window + missing share
  // = 100 %`. Read literally it forbids any segment below 100 %, contradicting its
  // own construction rule 3, where a segment may report partial coverage. The
  // enforceable half is the one direction the row can actually contradict itself
  // in: evidence plus declared missing days cannot exceed the window.
  //
  // The other sentence — "a reported 100 % coverage alongside missing ranges is a
  // defect" — cannot be checked from these fields once overlap and span have
  // passed: segments' spans plus the missing days already tile the window, so a
  // segment claiming 100 % over missing days *inside itself* is the overlap case.
  // Inventing a second test for it would be coverage theatre, so it is not here.
  if (windowValid && !overlapping && !gapped) {
    const windowDays = lengthInDays(windowStart, windowEnd);
    let accounted = 0;

    for (const interval of ordered) {
      const days = lengthInDays(interval.startDate, interval.endDate);
      accounted +=
        interval.kind === "missing" ? days : ((interval.coveragePercent as number) / 100) * days;
    }

    if (accounted > windowDays + COVERAGE_EPSILON) {
      violations.push({
        code: "coverage_mismatch",
        detail: `segments plus missing days account for ${accounted.toFixed(
          2,
        )} of ${windowDays} days`,
      });
    }
  }

  return violations;
}
