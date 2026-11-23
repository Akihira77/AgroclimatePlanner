import type { BaselineDataset, BaselineNormalsPayload } from "@agroclimate/contracts";

/**
 * The 1991–2020 monthly precipitation normals — Phase 5.5.
 *
 * Pure arithmetic only: no `Date`, no timezone, no provider, no I/O. A calendar
 * day is `(year, month, day)` and "is this a leap day" is the four-line rule, not
 * a host clock. That is what makes the result identical on every machine.
 *
 * The normal for a calendar month is the arithmetic mean of the **monthly
 * totals** of the years that contributed a complete month. A daily mean across
 * all years is a different (and wrong) quantity: November 1991 with two dry weeks
 * must weigh the same as any other November, not less because a caller averaged
 * day rows.
 *
 * Two rules are deliberately fail-closed rather than invented:
 *
 * - A calendar month contributes a sample only when **every one of its days** is
 *   present and non-null. A missing day is not zero rainfall, and a `null` is an
 *   absent observation, so neither can be added as `0`.
 * - A month with **no** complete year has no arithmetic mean at all. The build
 *   fails instead of emitting a fabricated normal; there is no minimum years
 *   threshold invented here. `sampleYears` is reported per month so a caller can
 *   see 27 vs 30 without the builder pretending they are the same.
 */

export const BASELINE_PERIOD = {
  from: "1991-01-01",
  to: "2020-12-31",
  startYear: 1991,
  endYear: 2020,
  /** WMO normal period length; also the ceiling of `sampleYears`. */
  years: 30,
} as const;

/** The stored unit of `climatology_normals.value_mm`. */
export const BASELINE_UNIT = "mm";

/**
 * Calculation version. A change to the aggregation rule, the missing-data rule,
 * or the month identity must bump this: the version, not a timestamp, is what
 * distinguishes two materially different baselines.
 */
export const CLIMATOLOGY_ALGORITHM_VERSION = "v1";

const DATASET_LABEL: Readonly<Record<BaselineDataset, string>> = {
  era5: "ERA5",
  chirps_v3: "CHIRPS_v3",
  nasa_power: "NASA_POWER",
};

const ALGORITHM_VERSION = /^[A-Za-z0-9._-]+$/;
const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface DailyPrecipitationInput {
  /** `YYYY-MM-DD`, the UTC calendar day the provider reported. */
  readonly date: string;
  /** `null` is a published absence; it is never treated as `0`. */
  readonly value: number | null;
}

export interface ClimatologyCellInput {
  readonly cellKey: string;
  /** Provider unit, unconverted. Only `mm` is accepted. */
  readonly unit: string;
  readonly days: readonly DailyPrecipitationInput[];
}

export interface BaselineNormal {
  /** 1–12, January first. */
  readonly month: number;
  /** `1991-MM-01`: the stored `year` is the baseline start year, not a guess. */
  readonly monthStart: string;
  /** Arithmetic mean of the valid monthly totals, in `mm`. */
  readonly valueMm: number;
  /** Complete years that contributed; 1–30. */
  readonly sampleYears: number;
}

export interface CellBaseline {
  readonly cellKey: string;
  /** Exactly 12 entries, January through December. */
  readonly normals: readonly BaselineNormal[];
  /** True only when all 12 months used all 30 years. */
  readonly complete: boolean;
  readonly minSampleYears: number;
}

export interface Baseline {
  readonly baselineVersion: string;
  readonly baselineDataset: BaselineDataset;
  readonly periodFrom: string;
  readonly periodTo: string;
  readonly algorithmVersion: string;
  readonly unit: typeof BASELINE_UNIT;
  readonly cells: readonly CellBaseline[];
}

export type ClimatologyFailureKind = "invalid_input" | "unsupported_unit" | "incomplete_history";

export type ClimatologyOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly kind: ClimatologyFailureKind; readonly message: string };

export interface BuildBaselineInput {
  readonly dataset: BaselineDataset;
  readonly cells: readonly ClimatologyCellInput[];
  /** Defaults to `CLIMATOLOGY_ALGORITHM_VERSION`; a different rule needs a different value. */
  readonly algorithmVersion?: string | undefined;
}

/**
 * `ERA5:1991-2020:v1` — the string every artifact repeats.
 *
 * Deterministic over dataset, period and algorithm version; nothing else. A
 * timestamp or UUID would make a retry of the same calculation a different
 * baseline, which is the reproducibility failure the version exists to prevent.
 */
export function baselineVersionOf(input: {
  readonly dataset: BaselineDataset;
  readonly algorithmVersion?: string | undefined;
}): string {
  const algorithmVersion = input.algorithmVersion ?? CLIMATOLOGY_ALGORITHM_VERSION;
  if (!ALGORITHM_VERSION.test(algorithmVersion)) {
    throw new RangeError(
      `algorithmVersion "${algorithmVersion}" must match ${ALGORITHM_VERSION.source}`,
    );
  }
  return `${DATASET_LABEL[input.dataset]}:${BASELINE_PERIOD.startYear}-${BASELINE_PERIOD.endYear}:${algorithmVersion}`;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 2:
      return isLeapYear(year) ? 29 : 28;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    default:
      return 31;
  }
}

interface CalendarDay {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

function parseDayKey(value: string): CalendarDay | null {
  const match = DATE_KEY.exec(value);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function fail<T>(kind: ClimatologyFailureKind, message: string): ClimatologyOutcome<T> {
  return { ok: false, kind, message };
}

/** Every value the cell supplied, keyed by its exact calendar day. */
function indexDays(
  cell: ClimatologyCellInput,
): ClimatologyOutcome<ReadonlyMap<string, number | null>> {
  const byDate = new Map<string, number | null>();
  for (const day of cell.days) {
    const parsed = parseDayKey(day.date);
    if (parsed === null) {
      return fail("invalid_input", `cell "${cell.cellKey}": "${day.date}" is not a calendar day`);
    }
    if (parsed.year < BASELINE_PERIOD.startYear || parsed.year > BASELINE_PERIOD.endYear) {
      return fail(
        "invalid_input",
        `cell "${cell.cellKey}": "${day.date}" is outside the ${BASELINE_PERIOD.from}..${BASELINE_PERIOD.to} baseline period`,
      );
    }
    if (byDate.has(day.date)) {
      // A duplicate is ambiguous, not a value to overwrite: two rows for one day
      // could disagree, and the later one is not more true.
      return fail("invalid_input", `cell "${cell.cellKey}": duplicate day "${day.date}"`);
    }
    if (day.value !== null && (!Number.isFinite(day.value) || day.value < 0)) {
      return fail(
        "invalid_input",
        `cell "${cell.cellKey}": ${day.date} carries ${String(day.value)}, which is not a finite non-negative precipitation amount`,
      );
    }
    byDate.set(day.date, day.value);
  }
  return { ok: true, value: byDate };
}

function buildCell(
  cell: ClimatologyCellInput,
  byDate: ReadonlyMap<string, number | null>,
): ClimatologyOutcome<CellBaseline> {
  const normals: BaselineNormal[] = [];
  let complete = true;
  let minSampleYears: number = BASELINE_PERIOD.years;

  for (let month = 1; month <= 12; month += 1) {
    let sum = 0;
    let sampleYears = 0;

    for (let year = BASELINE_PERIOD.startYear; year <= BASELINE_PERIOD.endYear; year += 1) {
      let total = 0;
      let monthIsComplete = true;
      const lastDay = daysInMonth(year, month);
      for (let day = 1; day <= lastDay; day += 1) {
        const key = `${String(year)}-${pad2(month)}-${pad2(day)}`;
        const value = byDate.get(key);
        if (value === undefined || value === null) {
          // Missing and null are different evidence and the same answer here:
          // the monthly total is unknown, so the year cannot contribute.
          monthIsComplete = false;
          break;
        }
        total += value;
      }
      if (monthIsComplete) {
        sum += total;
        sampleYears += 1;
      }
    }

    if (sampleYears === 0) {
      return fail(
        "incomplete_history",
        `cell "${cell.cellKey}" has no complete ${BASELINE_PERIOD.startYear}-${pad2(month)}..${BASELINE_PERIOD.endYear}-${pad2(month)} sample; a monthly normal cannot be computed`,
      );
    }

    normals.push({
      month,
      monthStart: `${BASELINE_PERIOD.startYear}-${pad2(month)}-01`,
      valueMm: sum / sampleYears,
      sampleYears,
    });
    if (sampleYears < BASELINE_PERIOD.years) complete = false;
    if (sampleYears < minSampleYears) minSampleYears = sampleYears;
  }

  return { ok: true, value: { cellKey: cell.cellKey, normals, complete, minSampleYears } };
}

/**
 * Build 12 normals per cell from daily precipitation.
 *
 * Deterministic in the input, not in its order: cells are hashed by key and the
 * monthly totals are accumulated year-ascending from a map, so re-emitting the
 * same days in another order cannot change a byte.
 */
export function buildMonthlyClimatology(input: BuildBaselineInput): ClimatologyOutcome<Baseline> {
  const algorithmVersion = input.algorithmVersion ?? CLIMATOLOGY_ALGORITHM_VERSION;
  if (!ALGORITHM_VERSION.test(algorithmVersion)) {
    return fail(
      "invalid_input",
      `algorithmVersion "${algorithmVersion}" must match ${ALGORITHM_VERSION.source}`,
    );
  }
  if (input.cells.length === 0) {
    return fail("invalid_input", "a baseline needs at least one cell");
  }

  const seen = new Set<string>();
  const cells: CellBaseline[] = [];

  for (const cell of input.cells) {
    if (cell.unit !== BASELINE_UNIT) {
      return fail(
        "unsupported_unit",
        `cell "${cell.cellKey}" carries "${cell.unit}"; this builder has no approved conversion to ${BASELINE_UNIT}`,
      );
    }
    if (seen.has(cell.cellKey)) {
      return fail("invalid_input", `cell "${cell.cellKey}" appears more than once`);
    }
    seen.add(cell.cellKey);

    const indexed = indexDays(cell);
    if (!indexed.ok) return indexed;

    const built = buildCell(cell, indexed.value);
    if (!built.ok) return built;
    cells.push(built.value);
  }

  return {
    ok: true,
    value: {
      baselineVersion: baselineVersionOf({ dataset: input.dataset, algorithmVersion }),
      baselineDataset: input.dataset,
      periodFrom: BASELINE_PERIOD.from,
      periodTo: BASELINE_PERIOD.to,
      algorithmVersion,
      unit: BASELINE_UNIT,
      cells,
    },
  };
}

/**
 * The `baselineHash` preimage for the cells a derivation actually consumed.
 *
 * It is the only supported way to go from a built baseline to the provenance
 * contract's `kind: "baseline"` input ref, and it hashes the stored rows of that
 * subset — not the whole build, and not a second JSON canonicaliser.
 */
export function baselineHashPayloadOf(
  baseline: Baseline,
  cellKeys: readonly string[],
): BaselineNormalsPayload {
  const unique = [...new Set(cellKeys)].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  if (unique.length === 0) {
    throw new RangeError("a baseline hash covers at least one cell");
  }

  const byKey = new Map(baseline.cells.map((cell) => [cell.cellKey, cell]));
  const monthlyNormals: BaselineNormalsPayload["monthlyNormals"] = [];
  for (const cellKey of unique) {
    const cell = byKey.get(cellKey);
    if (cell === undefined) {
      throw new RangeError(`cell "${cellKey}" is not in baseline "${baseline.baselineVersion}"`);
    }
    for (const normal of cell.normals) {
      monthlyNormals.push({
        cellKey,
        month: normal.monthStart,
        valueMm: normal.valueMm,
        sampleYears: normal.sampleYears,
      });
    }
  }

  return {
    baselineVersion: baseline.baselineVersion,
    baselineDataset: baseline.baselineDataset,
    monthlyNormals,
  };
}
