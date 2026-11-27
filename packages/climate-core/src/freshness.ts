/**
 * Seasonal freshness — Phase 5.7D.
 *
 * Soft TTL, evaluated **at read time**. Nothing stored is rewritten: a stale
 * month keeps its value and its provenance, and stays servable. The boundary is
 * the next scheduled SEAS5 release after the run's initialisation month:
 * `(initialisation month + 1)-05 12:00 UTC`.
 *
 * The zero grace period is **provisional**, not an operational guarantee. ECMWF
 * publishes at 12Z on the 5th, but Open-Meteo recommends waiting ten minutes for
 * provider consistency and this pipeline's own ingest→materialisation latency is
 * unmeasured, so a month can be labelled stale before a new run could plausibly
 * have been materialised. Adjusting the grace period needs measurement or an owner
 * decision; until then it is one constant in one place.
 *
 * This module is pure and clock-free: every call takes the instant explicitly, so
 * a test can cross month and year boundaries deterministically.
 */

/** The day of the month ECMWF releases SEAS5, in UTC. */
export const SEAS5_RELEASE_DAY_UTC = 5;
/** The release hour, in UTC. */
export const SEAS5_RELEASE_HOUR_UTC = 12;
/** Provider-recommended consistency wait. Recorded, deliberately **not** added. */
export const SEAS5_PROVIDER_CONSISTENCY_MS = 10 * 60 * 1000;

export type OutlookAvailability = "fresh" | "stale";

function instantOf(value: string): number {
  if (!value.endsWith("Z")) throw new RangeError(`"${value}" is not a UTC ISO instant`);
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new RangeError(`"${value}" is not an instant`);
  return parsed;
}

/**
 * The stale boundary of a run, as a UTC ISO instant.
 *
 * The instant is derived from the run's initialisation **month**, not its day: a
 * 1 November run and a 30 November run share the 5 December 12:00 UTC boundary,
 * because SEAS5 is initialised on the 1st and released once per month.
 */
export function seasonalStaleBoundary(initializedAt: string): string {
  instantOf(initializedAt);
  const month = new Date(initializedAt);
  const boundary = new Date(
    Date.UTC(
      month.getUTCFullYear(),
      month.getUTCMonth() + 1,
      SEAS5_RELEASE_DAY_UTC,
      SEAS5_RELEASE_HOUR_UTC,
      0,
      0,
      0,
    ),
  );
  return boundary.toISOString();
}

/**
 * `stale` at or past the boundary; `fresh` before it.
 *
 * A newer usable run clears staleness by replacing the active row, not by editing
 * this calculation: the response always describes the row that is served.
 */
export function seasonalAvailability(initializedAt: string, now: string): OutlookAvailability {
  const current = instantOf(now);
  return current < instantOf(seasonalStaleBoundary(initializedAt)) ? "fresh" : "stale";
}

/**
 * The soft TTL a short-range day is allowed, from the horizon map
 * (`temporal-and-weather-semantics.md` §5):
 *
 * | Lead day | Stale when the run is older than |
 * |---|---|
 * | 0–3 | 6 h |
 * | 4–14 | 12 h |
 * | 15–45 | 48 h |
 *
 * The daily and subseasonal bands differ because the products differ: a 0-day
 * value is superseded by every new cycle, a 30-day one by the next weekly run.
 * This is one constant table in one place; changing it is an owner decision, not
 * a tuning knob.
 */
export function weatherForecastStaleAfterHours(leadDay: number): number {
  if (!Number.isInteger(leadDay) || leadDay < 0 || leadDay > 45) {
    throw new RangeError("leadDay must be an integer between 0 and 45");
  }
  if (leadDay <= 3) return 6;
  if (leadDay <= 14) return 12;
  return 48;
}

/**
 * `stale` at or past the band's TTL; `fresh` before it.
 *
 * Read-time only, like every other availability in this module: the row keeps its
 * value and provenance, and a newer run clears staleness by replacing the row.
 */
export function dailyAvailability(
  initializedAt: string,
  now: string,
  leadDay: number,
): OutlookAvailability {
  const boundary =
    instantOf(initializedAt) + weatherForecastStaleAfterHours(leadDay) * 60 * 60 * 1000;
  return instantOf(now) < boundary ? "fresh" : "stale";
}
