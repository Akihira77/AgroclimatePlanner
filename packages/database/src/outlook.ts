import {
  baselineDatasetSchema,
  type BaselineDataset,
  type DataInputRef,
} from "@agroclimate/contracts";

import type { OutlookCellIdentity } from "./climate.js";
import { InvariantViolationError } from "./run-errors.js";
import type { TenantTransaction } from "./tenant.js";
import { lockForecastFootprint } from "./weather.js";

/**
 * `app.monthly_outlooks` persistence — Phase 5.7A.
 *
 * Only climatology months exist in this phase, and only when a real baseline
 * normal is behind them. `not_requested` / `insufficient_history` months are
 * **not rows**: `input_refs` is `NOT NULL` with an array shape and the contract
 * requires at least one ref, so a month with no inputs has no honest row. The read
 * path synthesises those entries from the same assembled horizon.
 *
 * Two database invariants shape the write order:
 *
 * - `monthly_outlooks_active_key` is a **partial unique index** on
 *   `(outlook_cell_id, variable, month) WHERE status = 'active'`. A new active row
 *   cannot be inserted while the old active row exists.
 * - `monthly_outlooks_superseded_fkey` makes `superseded_by_id` point at a row
 *   that must already exist, so the old row cannot be marked superseded first.
 *
 * The only order that satisfies both inside one transaction is: stage the new row
 * as `failed` (a status that requires no successor), point the old active row at
 * it, then promote the staged row to `active`. Every intermediate state is legal
 * under the CHECKs, and none of it is visible outside the transaction.
 *
 * The whole call is inside the caller's transaction. A failure rolls back to the
 * previous active row — a failed recomputation never destroys a valid answer.
 */

export class OutlookCellNotFoundError extends Error {
  override readonly name = "OutlookCellNotFoundError";
}

export class OutlookBaselineNotFoundError extends Error {
  override readonly name = "OutlookBaselineNotFoundError";
}

export interface ClimatologyOutlookSource {
  readonly baselineDataset: BaselineDataset;
  readonly normals: readonly {
    readonly month: string;
    readonly valueMm: number;
    readonly sampleYears: number | null;
  }[];
}

export interface ClimatologyOutlookMonthRow {
  readonly month: string;
  readonly valueMm: number;
  readonly baselineVersion: string;
  readonly spreadUnavailableReason: string;
}

export interface PersistClimatologyOutlookInput extends OutlookCellIdentity {
  readonly variable: "precipitation";
  readonly derivationVersion: string;
  readonly inputRefs: readonly DataInputRef[];
  readonly inputSnapshotHash: string;
  readonly computedAt: Date;
  /** Only the months that carry a real value. May be empty (nothing to write). */
  readonly months: readonly ClimatologyOutlookMonthRow[];
}

export interface PersistClimatologyOutlookResult {
  /** Rows inserted, including a replacement that superseded a previous answer. */
  readonly inserted: number;
  /** Previous active rows retired by this call. */
  readonly superseded: number;
  /** Rows already identical: no write, and the job is still idempotent. */
  readonly unchanged: number;
}

interface ActiveRow {
  readonly id: string;
  readonly derivationVersion: string;
  readonly inputSnapshotHash: string;
  readonly baselineVersion: string | null;
  readonly valueMm: number | null;
  readonly dataClass: string | null;
  readonly evaluationBasis: string;
  readonly missingReason: string | null;
  readonly spreadUnavailableReason: string | null;
  readonly dataCoveragePercent: number | null;
  readonly anomalyKind: string | null;
}

const MONTH_KEY = /^\d{4}-\d{2}-01$/;

function isSameDerivation(
  row: ActiveRow,
  desired: ClimatologyOutlookMonthRow,
  input: PersistClimatologyOutlookInput,
): boolean {
  return (
    row.derivationVersion === input.derivationVersion &&
    row.inputSnapshotHash === input.inputSnapshotHash &&
    row.baselineVersion === desired.baselineVersion &&
    row.valueMm === desired.valueMm &&
    row.dataClass === "climatology" &&
    row.evaluationBasis === "climatology" &&
    row.missingReason === "beyond_horizon" &&
    row.spreadUnavailableReason === desired.spreadUnavailableReason &&
    row.dataCoveragePercent === null &&
    row.anomalyKind === null
  );
}

/** Resolve the cell identity to an id. Never creates one: aggregation reads. */
export async function findOutlookCellId(
  tx: TenantTransaction,
  cell: OutlookCellIdentity,
): Promise<string> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id::text AS "id"
      FROM app.outlook_cells
     WHERE provider = ${cell.provider}
       AND model = ${cell.model}
       AND cell_key = ${cell.cellKey}
  `;
  const row = rows[0];
  if (row === undefined) {
    throw new OutlookCellNotFoundError(
      `no outlook cell for (${cell.provider}, ${cell.model}, ${cell.cellKey})`,
    );
  }
  return row.id;
}

/**
 * The stored normals and dataset a derivation may consume.
 *
 * `baselineVersion` is supplied by the caller, never selected here: there is no
 * "latest baseline" query in this codebase, and an implicit one would silently
 * move every stored outlook to a different baseline. A missing version row is a
 * caller error, not an empty result.
 */
export async function loadClimatologyOutlookSource(
  tx: TenantTransaction,
  input: { readonly baselineVersion: string; readonly outlookCellId: string },
): Promise<ClimatologyOutlookSource> {
  const versions = await tx.$queryRaw<{ baselineDataset: string }[]>`
    SELECT baseline_dataset AS "baselineDataset"
      FROM app.climatology_baselines
     WHERE baseline_version = ${input.baselineVersion}
  `;
  const version = versions[0];
  if (version === undefined) {
    throw new OutlookBaselineNotFoundError(
      `baseline "${input.baselineVersion}" has no source metadata row`,
    );
  }

  const normals = await tx.$queryRaw<ClimatologyOutlookSource["normals"][number][]>`
    SELECT to_char(month, 'YYYY-MM-DD') AS "month",
           value_mm                     AS "valueMm",
           sample_years                 AS "sampleYears"
      FROM app.climatology_normals
     WHERE baseline_version = ${input.baselineVersion}
       AND outlook_cell_id = ${input.outlookCellId}::uuid
     ORDER BY month
  `;

  const dataset = baselineDatasetSchema.safeParse(version.baselineDataset);
  if (!dataset.success) {
    throw new InvariantViolationError(
      `baseline "${input.baselineVersion}" names an unknown dataset "${version.baselineDataset}"`,
    );
  }

  return { baselineDataset: dataset.data, normals };
}

/** One active `monthly_outlooks` row, as the read path consumes it. */
export interface ActiveOutlookMonthRow {
  /** First day of the calendar month, `YYYY-MM-01`. */
  readonly month: string;
  /** `null` when the row records an absence; the column permits it, so the type does. */
  readonly dataClass: string | null;
  readonly evaluationBasis: string;
  readonly valueMm: number | null;
  readonly missingReason: string | null;
  readonly baselineVersion: string | null;
  readonly anomalyKind: string | null;
  readonly anomalyMm: number | null;
  readonly ensembleSpreadMm: number | null;
  readonly spreadUnavailableReason: string | null;
  readonly derivationVersion: string;
}

export interface ActiveOutlookMonths {
  /** `null` when no cell row exists for the identity: nothing was ever resolved. */
  readonly outlookCellId: string | null;
  /** Ordered by month. At most one row per month, because a month may not repeat. */
  readonly months: readonly ActiveOutlookMonthRow[];
}

/**
 * The materialised answer for one cell over a closed month range.
 *
 * **Read-only.** It never mints a cell: resolution is the caller's business, and a
 * read that writes would turn a `GET` into a migration.
 *
 * `status = 'active'` is the whole of the selection, and the partial unique index
 * `monthly_outlooks_active_key` is what makes it sufficient — at most one active
 * row exists per `(cell, variable, month)`, so a superseded answer can never be
 * served beside its replacement.
 *
 * A range rather than a month list: the caller's horizon is twelve consecutive
 * calendar months, so `month BETWEEN $a AND $b` is the same set and lets
 * `monthly_outlooks_cell_month_idx` do the work. A `text[]` of keys would need a
 * cast that Postgres does not define between `text[]` and `date[]`.
 */
export async function loadActiveOutlookMonths(
  tx: TenantTransaction,
  input: {
    readonly provider: string;
    readonly model: string;
    readonly cellKey: string;
    /** First month of the horizon, first-of-month. */
    readonly fromMonth: string;
    /** Last month of the horizon, first-of-month, inclusive. */
    readonly toMonth: string;
  },
): Promise<ActiveOutlookMonths> {
  const rows = await tx.$queryRaw<(ActiveOutlookMonthRow & { outlookCellId: string })[]>`
    SELECT c.id::text                        AS "outlookCellId",
           to_char(o.month, 'YYYY-MM-DD')    AS "month",
           o.data_class                      AS "dataClass",
           o.evaluation_basis                AS "evaluationBasis",
           o.value_mm                        AS "valueMm",
           o.missing_reason                  AS "missingReason",
           o.baseline_version                AS "baselineVersion",
           o.anomaly_kind                    AS "anomalyKind",
           o.anomaly_mm                      AS "anomalyMm",
           o.ensemble_spread_mm              AS "ensembleSpreadMm",
           o.spread_unavailable_reason       AS "spreadUnavailableReason",
           o.derivation_version              AS "derivationVersion"
      FROM app.outlook_cells c
      JOIN app.monthly_outlooks o ON o.outlook_cell_id = c.id
     WHERE c.provider = ${input.provider}
       AND c.model = ${input.model}
       AND c.cell_key = ${input.cellKey}
       AND o.variable = 'precipitation'
       AND o.status = 'active'
       AND o.month BETWEEN ${input.fromMonth}::date AND ${input.toMonth}::date
     ORDER BY o.month
  `;

  const first = rows[0];
  if (first === undefined) return { outlookCellId: null, months: [] };

  const months = rows.map(({ outlookCellId: _cell, ...month }) => month);
  return { outlookCellId: first.outlookCellId, months };
}

export interface PersistClimatologyOutlookOptions {
  /**
   * `true` when the caller already holds this cell's footprint lock for the
   * current transaction.
   *
   * A multi-cell job must take the **whole** footprint set in one
   * `lockForecastFootprint` call *before* any cell is written: that function
   * sorts and de-duplicates what it is given, so one call is a global ordering,
   * while one call per cell is an ordering decided by the selector array — two
   * jobs with the same cells in opposite order would then wait on each other.
   * Set this only after that acquisition, or the write is unprotected.
   */
  readonly footprintLockHeld?: boolean | undefined;
}

/**
 * Write the climatology months of one derivation.
 *
 * **Precondition:** the caller owns a transaction that also holds the job row
 * lock. This function never opens one.
 */
export async function persistClimatologyOutlook(
  tx: TenantTransaction,
  input: PersistClimatologyOutlookInput,
  options: PersistClimatologyOutlookOptions = {},
): Promise<PersistClimatologyOutlookResult> {
  if (input.inputRefs.length === 0) {
    throw new InvariantViolationError("a persisted outlook month needs at least one input ref");
  }
  if (!/^[0-9a-f]{64}$/.test(input.inputSnapshotHash)) {
    throw new InvariantViolationError("inputSnapshotHash must be a lowercase sha256 hex digest");
  }

  const seen = new Set<string>();
  for (const month of input.months) {
    if (!MONTH_KEY.test(month.month)) {
      throw new InvariantViolationError(`"${month.month}" is not a first-of-month key`);
    }
    if (!Number.isFinite(month.valueMm) || month.valueMm < 0) {
      throw new InvariantViolationError(`month "${month.month}" is not a non-negative amount`);
    }
    if (seen.has(month.month)) {
      throw new InvariantViolationError(`month "${month.month}" appears more than once`);
    }
    seen.add(month.month);
  }

  const cellId = await findOutlookCellId(tx, input);

  // The same slot `weather_records` writes serialise on. Over-serialising two
  // writers of one cell costs a wait; under-serialising costs two live rows.
  // A multi-cell caller passes `footprintLockHeld` instead, having taken the
  // complete set in its own globally ordered call.
  if (options.footprintLockHeld !== true) {
    await lockForecastFootprint(tx, [{ cellKey: input.cellKey, variable: input.variable }]);
  }

  let inserted = 0;
  let superseded = 0;
  let unchanged = 0;

  for (const month of [...input.months].sort((left, right) =>
    left.month < right.month ? -1 : left.month > right.month ? 1 : 0,
  )) {
    const active = await tx.$queryRaw<ActiveRow[]>`
      SELECT id::text                     AS "id",
             derivation_version           AS "derivationVersion",
             input_snapshot_hash          AS "inputSnapshotHash",
             baseline_version             AS "baselineVersion",
             value_mm                     AS "valueMm",
             data_class                   AS "dataClass",
             evaluation_basis             AS "evaluationBasis",
             missing_reason               AS "missingReason",
             spread_unavailable_reason    AS "spreadUnavailableReason",
             data_coverage_percent        AS "dataCoveragePercent",
             anomaly_kind                 AS "anomalyKind"
        FROM app.monthly_outlooks
       WHERE outlook_cell_id = ${cellId}::uuid
         AND variable = ${input.variable}
         AND month = ${month.month}::date
         AND status = 'active'
       FOR UPDATE
    `;

    const current = active[0];
    if (current !== undefined && isSameDerivation(current, month, input)) {
      unchanged += 1;
      continue;
    }

    const staged = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO app.monthly_outlooks (
        outlook_cell_id, variable, month, data_class, evaluation_basis, value_mm,
        missing_reason, anomaly_kind, anomaly_mm, anomaly_percent, baseline_version,
        model_climate_offset_mm, data_coverage_percent, ensemble_spread_mm,
        spread_unavailable_reason, derivation_version, input_refs, input_snapshot_hash,
        computed_at, status
      ) VALUES (
        ${cellId}::uuid, ${input.variable}, ${month.month}::date,
        'climatology', 'climatology', ${month.valueMm},
        'beyond_horizon', NULL, NULL, NULL, ${month.baselineVersion},
        NULL, NULL, NULL,
        ${month.spreadUnavailableReason}, ${input.derivationVersion},
        ${JSON.stringify(input.inputRefs)}::jsonb, ${input.inputSnapshotHash},
        ${input.computedAt}::timestamptz, 'failed'
      )
      RETURNING id::text AS "id"
    `;
    const stagedId = staged[0]?.id;
    if (stagedId === undefined) {
      throw new InvariantViolationError("the staged outlook row was not returned");
    }

    if (current !== undefined) {
      await tx.$executeRaw`
        UPDATE app.monthly_outlooks
           SET status = 'superseded',
               superseded_by_id = ${stagedId}::uuid
         WHERE id = ${current.id}::uuid
           AND status = 'active'
      `;
      superseded += 1;
    }

    await tx.$executeRaw`
      UPDATE app.monthly_outlooks
         SET status = 'active'
       WHERE id = ${stagedId}::uuid
         AND status = 'failed'
    `;
    inserted += 1;
  }

  return { inserted, superseded, unchanged };
}
