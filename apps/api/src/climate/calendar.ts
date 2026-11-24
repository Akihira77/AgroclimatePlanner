/**
 * The current month in Asia/Jakarta, as a first-of-month key.
 *
 * Kept here, pure and clock-injected, because the read path needs a horizon and
 * the database stores none: `monthly_outlooks` is keyed by calendar month, not by
 * "the answer that is current". The alternative — reading the clock inside the
 * handler — would make the unit untestable and the behaviour undocumented.
 *
 * Asia/Jakarta is UTC+7 all year; Indonesia has no daylight saving, so the offset
 * is a constant and no timezone database is consulted. That is the same calendar
 * `monthly_outlooks.month` is documented in (`temporal-and-weather-semantics.md`
 * §1–2), which is why this is not a general timezone utility.
 */
const JAKARTA_OFFSET_MS = 7 * 60 * 60 * 1000;

export function jakartaMonthOf(now: Date): string {
  if (Number.isNaN(now.getTime())) {
    throw new RangeError("jakartaMonthOf requires a valid instant");
  }

  const shifted = new Date(now.getTime() + JAKARTA_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}-01`;
}
