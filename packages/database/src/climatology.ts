/**
 * Climatology persistence — Phase 5.5.
 *
 * `app.climatology_normals` is an **append-only, versioned baseline**. Three
 * properties are load-bearing:
 *
 * 1. **A version is immutable.** There is no `UPDATE` in this module. A changed
 *    dataset, period or calculation is a new `baseline_version`; the previous
 *    version's rows are untouched and remain explainable.
 * 2. **Idempotent for identical output.** The unique key
 *    `(baseline_version, outlook_cell_id, month)` is the identity. A repeated
 *    build inserts nothing and verifies that every existing row is byte-for-byte
 *    the same value and sample count. A retry is therefore safe.
 * 3. **Conflict is loud.** The same version presented with a different value
 *    throws. Silently keeping either number would make an anomaly unexplainable,
 *    and overwriting would change a baseline that stored artifacts already name.
 *
 * The caller owns the transaction: one job settles all cells and all 12 months
 * in a single transaction, so a partial baseline cannot be mistaken for a
 * complete one.
 */
import type { BaselineDataset } from "@agroclimate/contracts";

import { InvariantViolationError } from "./run-errors.js";
import type { TenantTransaction } from "./tenant.js";
import { resolveForecastCells } from "./weather.js";

/** The number of calendar months a baseline has. */
const MONTHS_PER_BASELINE = 12;
/** The 1991–2020 WMO normal period. `sample_years` cannot exceed it. */
const MAX_SAMPLE_YEARS = 30;

export interface ClimatologyNormalInput {
  /** First day of a calendar month, at 00:00 UTC. */
  readonly month: Date;
  /** Monthly normal in millimetres. Non-negative and finite. */
  readonly valueMm: number;
  /** Complete years that contributed; 1–30. */
  readonly sampleYears: number;
}

export interface ClimatologyCellInput {
  readonly cellKey: string;
  readonly servedLat: number;
  readonly servedLon: number;
  readonly spatialResolutionKm: number | null;
  /** Exactly 12 entries, one per calendar month. */
  readonly normals: readonly ClimatologyNormalInput[];
}

export interface PersistClimatologyBaselineInput {
  readonly provider: string;
  readonly model: string;
  /** `ERA5:1991-2020:v1` — the string every artifact repeats. */
  readonly baselineVersion: string;
  readonly baselineDataset: BaselineDataset;
  readonly periodFrom: Date;
  readonly periodTo: Date;
  readonly computedAt: Date;
  readonly cells: readonly ClimatologyCellInput[];
}

export interface PersistClimatologyBaselineResult {
  readonly cells: number;
  readonly inserted: number;
  readonly unchanged: number;
}

/**
 * The same `baseline_version` was presented with content that differs from the
 * stored rows. Not retryable by re-running the same build, and never resolved by
 * a write.
 */
export class ClimatologyConflictError extends Error {
  override readonly name = "ClimatologyConflictError";

  constructor(
    readonly baselineVersion: string,
    readonly cellKey: string,
    readonly month: string,
  ) {
    super(
      `baseline "${baselineVersion}" already stores a different normal for cell "${cellKey}" month ${month}; a changed baseline needs a new baseline_version`,
    );
  }
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** `YYYY-MM-DD` in UTC; a `date` column has no time and no zone. */
function dateKeyOf(value: Date): string {
  if (!Number.isFinite(value.getTime())) {
    throw new InvariantViolationError("a baseline date is not a valid instant");
  }
  return `${String(value.getUTCFullYear()).padStart(4, "0")}-${pad2(value.getUTCMonth() + 1)}-${pad2(value.getUTCDate())}`;
}

function monthKeyOf(value: Date): string {
  if (!Number.isFinite(value.getTime())) {
    throw new InvariantViolationError("a baseline month is not a valid instant");
  }
  if (value.getUTCDate() !== 1) {
    throw new InvariantViolationError(
      `month ${value.toISOString()} is not the first day of a calendar month`,
    );
  }
  return `${String(value.getUTCFullYear()).padStart(4, "0")}-${pad2(value.getUTCMonth() + 1)}-01`;
}

/**
 * Validate the whole output before the first write.
 *
 * A partially constructed baseline is the one failure mode this module must not
 * let through: 11 rows would look like a baseline to a `SELECT` that does not
 * count. Every cell must carry exactly the twelve calendar months, and every
 * number must be storable as `climatology_normals.value_mm`.
 */
function assertBaselineInput(input: PersistClimatologyBaselineInput): void {
  if (input.provider.trim().length === 0 || input.model.trim().length === 0) {
    throw new InvariantViolationError("a baseline needs a provider and a model");
  }
  if (input.baselineVersion.trim().length === 0) {
    throw new InvariantViolationError("baselineVersion must not be blank");
  }
  const periodFrom = dateKeyOf(input.periodFrom);
  const periodTo = dateKeyOf(input.periodTo);
  if (periodTo <= periodFrom) {
    throw new InvariantViolationError(
      `baseline period ${periodFrom}..${periodTo} is not an ordered window`,
    );
  }
  if (input.cells.length === 0) {
    throw new InvariantViolationError("a baseline needs at least one cell");
  }
  dateKeyOf(input.computedAt);

  const seenCells = new Set<string>();
  for (const cell of input.cells) {
    if (cell.cellKey.trim().length === 0) {
      throw new InvariantViolationError("a baseline cell needs a cellKey");
    }
    if (seenCells.has(cell.cellKey)) {
      throw new InvariantViolationError(`cell "${cell.cellKey}" appears more than once`);
    }
    seenCells.add(cell.cellKey);
    if (
      !Number.isFinite(cell.servedLat) ||
      cell.servedLat < -90 ||
      cell.servedLat > 90 ||
      !Number.isFinite(cell.servedLon) ||
      cell.servedLon < -180 ||
      cell.servedLon > 180
    ) {
      throw new InvariantViolationError(`cell "${cell.cellKey}" has an invalid served coordinate`);
    }
    if (cell.normals.length !== MONTHS_PER_BASELINE) {
      throw new InvariantViolationError(
        `cell "${cell.cellKey}" carries ${cell.normals.length} normals; a baseline needs ${MONTHS_PER_BASELINE}`,
      );
    }

    const seenMonths = new Set<number>();
    for (const normal of cell.normals) {
      const monthKey = monthKeyOf(normal.month);
      const month = normal.month.getUTCMonth() + 1;
      if (seenMonths.has(month)) {
        throw new InvariantViolationError(
          `cell "${cell.cellKey}" has more than one normal for month ${monthKey.slice(0, 7)}`,
        );
      }
      seenMonths.add(month);
      if (!Number.isFinite(normal.valueMm) || normal.valueMm < 0) {
        throw new InvariantViolationError(
          `cell "${cell.cellKey}" month ${monthKey} carries ${String(normal.valueMm)}, which is not a finite non-negative normal`,
        );
      }
      if (
        !Number.isInteger(normal.sampleYears) ||
        normal.sampleYears < 1 ||
        normal.sampleYears > MAX_SAMPLE_YEARS
      ) {
        throw new InvariantViolationError(
          `cell "${cell.cellKey}" month ${monthKey} carries sampleYears ${String(normal.sampleYears)}; expected 1..${MAX_SAMPLE_YEARS}`,
        );
      }
    }
    for (let month = 1; month <= MONTHS_PER_BASELINE; month += 1) {
      if (!seenMonths.has(month)) {
        throw new InvariantViolationError(
          `cell "${cell.cellKey}" has no normal for month ${pad2(month)}`,
        );
      }
    }
  }
}

interface StoredNormal {
  readonly month: string;
  readonly baselineDataset: string;
  readonly periodFrom: string;
  readonly periodTo: string;
  readonly valueMm: number | null;
  readonly sampleYears: number | null;
}

/**
 * Persist one complete baseline for the given cells.
 *
 * **Precondition:** the caller owns a transaction that also holds the job row
 * lock. This function never opens one, and a conflict rolls back every cell.
 */
export async function persistClimatologyBaseline(
  tx: TenantTransaction,
  input: PersistClimatologyBaselineInput,
): Promise<PersistClimatologyBaselineResult> {
  assertBaselineInput(input);

  const periodFrom = dateKeyOf(input.periodFrom);
  const periodTo = dateKeyOf(input.periodTo);

  const cellIds = await resolveForecastCells(tx, {
    provider: input.provider,
    model: input.model,
    cells: input.cells.map((cell) => ({
      cellKey: cell.cellKey,
      servedLat: cell.servedLat,
      servedLon: cell.servedLon,
      spatialResolutionKm: cell.spatialResolutionKm,
    })),
  });

  let inserted = 0;
  let unchanged = 0;

  for (const cell of input.cells) {
    const cellId = cellIds.get(cell.cellKey);
    if (cellId === undefined) {
      throw new InvariantViolationError(`cell "${cell.cellKey}" was not resolved to an id`);
    }

    const rows = cell.normals.map((normal) => ({
      month: monthKeyOf(normal.month),
      value_mm: normal.valueMm,
      sample_years: normal.sampleYears,
    }));

    const written = await tx.$queryRaw<{ month: string }[]>`
      INSERT INTO app.climatology_normals (
        baseline_version, baseline_dataset, period_from, period_to,
        outlook_cell_id, month, value_mm, sample_years, computed_at
      )
      SELECT ${input.baselineVersion},
             ${input.baselineDataset},
             ${periodFrom}::date,
             ${periodTo}::date,
             ${cellId}::uuid,
             v.month::date,
             v.value_mm,
             v.sample_years,
             ${input.computedAt}::timestamptz
        FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
          AS v(month text, value_mm double precision, sample_years integer)
      ON CONFLICT (baseline_version, outlook_cell_id, month) DO NOTHING
      RETURNING to_char(month, 'YYYY-MM-DD') AS "month"
    `;

    inserted += written.length;

    // Read every month back, inserted or not, and compare it with the build.
    // A row that already existed is "unchanged" only if the whole content the
    // version implies — dataset, period, value, sample count — is identical.
    const stored = await tx.$queryRaw<StoredNormal[]>`
      SELECT to_char(month, 'YYYY-MM-DD') AS "month",
             baseline_dataset             AS "baselineDataset",
             to_char(period_from, 'YYYY-MM-DD') AS "periodFrom",
             to_char(period_to, 'YYYY-MM-DD')   AS "periodTo",
             value_mm                     AS "valueMm",
             sample_years                 AS "sampleYears"
        FROM app.climatology_normals
       WHERE baseline_version = ${input.baselineVersion}
         AND outlook_cell_id = ${cellId}::uuid
    `;
    if (stored.length !== MONTHS_PER_BASELINE) {
      throw new InvariantViolationError(
        `baseline "${input.baselineVersion}" stored ${stored.length} months for cell "${cell.cellKey}"; expected ${MONTHS_PER_BASELINE}`,
      );
    }

    const byMonth = new Map(stored.map((row) => [row.month, row]));
    let matched = 0;
    for (const normal of cell.normals) {
      const month = monthKeyOf(normal.month);
      const row = byMonth.get(month);
      if (row === undefined) {
        throw new InvariantViolationError(
          `baseline "${input.baselineVersion}" has no row for cell "${cell.cellKey}" month ${month}`,
        );
      }
      if (
        row.valueMm === null ||
        row.sampleYears === null ||
        row.baselineDataset !== input.baselineDataset ||
        row.periodFrom !== periodFrom ||
        row.periodTo !== periodTo ||
        row.valueMm !== normal.valueMm ||
        row.sampleYears !== normal.sampleYears
      ) {
        throw new ClimatologyConflictError(input.baselineVersion, cell.cellKey, month);
      }
      matched += 1;
    }
    unchanged += matched - written.length;
  }

  return { cells: input.cells.length, inserted, unchanged };
}
