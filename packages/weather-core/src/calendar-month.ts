/**
 * Calendar-month arithmetic for a provider's monthly axis.
 *
 * No `Date`, no elapsed milliseconds, no timezone: a month is `year * 12 + month`
 * and adjacency is a difference of exactly 1. `Date` arithmetic would drag in
 * DST and the local timezone for a question that has neither — "is this the month
 * after that one" is integer arithmetic.
 *
 * Shared by the adapter and the normalizer on purpose: the normalizer is a
 * separate boundary and may receive a monthly series from somewhere other than
 * this adapter, so both must enforce the same rule with the same code.
 */

export interface CalendarMonth {
  readonly year: number;
  /** 1–12, never 0-based. */
  readonly month: number;
}

const MONTH_KEY = /^(\d{4})-(0[1-9]|1[0-2])(-01)?$/;

/**
 * `YYYY-MM` or `YYYY-MM-01` → `{year, month}`, anything else → `null`.
 * A key like `2026-11-15` is not a month and is not accepted.
 */
export function parseCalendarMonth(key: string): CalendarMonth | null {
  const match = MONTH_KEY.exec(key);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (year < 1000 || year > 9999) return null;
  return { year, month };
}

/** `{year, month}` → `YYYY-MM-01`, the first day of that calendar month. */
export function formatMonthKey(month: CalendarMonth): string {
  return `${String(month.year).padStart(4, "0")}-${String(month.month).padStart(2, "0")}-01`;
}

/**
 * True only when `current` is exactly the calendar month after `previous`.
 * False covers every bad case at once: a gap, a duplicate, a reversal, and an
 * unparseable key.
 */
export function isConsecutiveMonth(previous: string, current: string): boolean {
  const before = parseCalendarMonth(previous);
  const after = parseCalendarMonth(current);
  if (before === null || after === null) return false;
  return after.year * 12 + after.month - (before.year * 12 + before.month) === 1;
}

/** Days in a calendar month: 28–31, with the Gregorian leap-year rule. */
export function daysInMonth(month: CalendarMonth): number {
  if (month.month === 2) {
    const leap = month.year % 4 === 0 && (month.year % 100 !== 0 || month.year % 400 === 0);
    return leap ? 29 : 28;
  }
  return month.month === 4 || month.month === 6 || month.month === 9 || month.month === 11
    ? 30
    : 31;
}

/** `{year, month}` shifted by `offset` months, normalised across year boundaries. */
export function addMonths(month: CalendarMonth, offset: number): CalendarMonth {
  const ordinal = month.year * 12 + (month.month - 1) + offset;
  return { year: Math.floor(ordinal / 12), month: (ordinal % 12) + 1 };
}

/** `YYYY-MM-DD` → `YYYY-MM-01`. A non-day string yields `null`. */
export function monthKeyOfDay(day: string): string | null {
  const calendarMonth = parseCalendarMonth(day.slice(0, 7));
  return calendarMonth === null ? null : formatMonthKey(calendarMonth);
}
