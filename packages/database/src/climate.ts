/**
 * The climate data plane's one write from the request path (`tables-climate.md`
 * §1, `climate-data-foundation.md` §8.2 step 5.2.6).
 *
 * `app.outlook_cells` is global — no `user_id`, no RLS — but it is still reached
 * through the caller's `TenantTransaction`, because a second way into a Prisma
 * transaction is how a pool acquires two connections and a scope leaks. The
 * tenant is not read here and never reaches the statement.
 *
 * Identity is exactly `(provider, model, cell_key)`, the triple
 * `outlook_cells_grid_key` already enforces. Nothing else identifies a cell:
 * not the model alone, not a `gridId`, not a hash, and not a concatenation.
 *
 * **The three identity columns and nothing more.** `app_api` holds `INSERT
 * (provider, model, cell_key)` (`migration.sql:737`) and no `UPDATE`, so
 * `ON CONFLICT … DO UPDATE` is not an option — it would need both a grant the
 * request path must not have and a served coordinate this function is not
 * allowed to invent. `served_lat`, `served_lon`, `elevation_m`,
 * `spatial_resolution_km` and `served_updated_at` stay NULL until `app_system`
 * observes a real payload. An identity row is not proof that a provider served
 * anything.
 *
 * Persisting a triple is not admission: `synthetic` is rejected by
 * `outlook_cells_provider_check`, and a row that the CHECK accepts says nothing
 * about `GridEvidence`. Provider-grid validation stays in the registry.
 */
import { ingestionVersionOf } from "@agroclimate/contracts";
import type { ForecastProduct } from "@agroclimate/contracts";

import type { PrismaClient } from "./generated/prisma/client.js";
import {
  IngestionAlreadyOwnedError,
  IngestionRunMissingError,
  IngestionTerminalError,
  InvariantViolationError,
  isUniqueViolationOn,
  LeaseLostError,
} from "./run-errors.js";
import type { TenantTransaction } from "./tenant.js";

export interface OutlookCellIdentity {
  readonly provider: string;
  readonly model: string;
  readonly cellKey: string;
}

/**
 * The insert reported a conflict and the lookup could not see the row. That is a
 * contradiction, not a retryable condition: it means the two statements disagree
 * about the triple, so the caller must hear about it instead of receiving a
 * fabricated id.
 */
export class OutlookCellIdentityError extends Error {
  override readonly name = "OutlookCellIdentityError";
}

/**
 * The persisted id of one grid node, created on first reference.
 *
 * `DO NOTHING` inserts nothing when the triple exists, and `RETURNING` therefore
 * yields no row — so the follow-up `SELECT` is the only way to learn the id, and
 * it must name all three columns. Under READ COMMITTED (Prisma's default, and
 * what `withTenant` opens) a concurrent inserter blocks this statement until it
 * commits, and the `SELECT` then takes a fresh snapshot that sees the row. If it
 * still returns nothing the pair of statements is broken, so this throws rather
 * than inventing an id or handing back `undefined`.
 */
export async function upsertCell(
  tx: TenantTransaction,
  cell: OutlookCellIdentity,
): Promise<string> {
  const inserted = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO app.outlook_cells (provider, model, cell_key)
    VALUES (${cell.provider}, ${cell.model}, ${cell.cellKey})
    ON CONFLICT (provider, model, cell_key) DO NOTHING
    RETURNING id::text AS id
  `;

  if (inserted[0] !== undefined) return inserted[0].id;

  const existing = await tx.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id
      FROM app.outlook_cells
     WHERE provider = ${cell.provider}
       AND model = ${cell.model}
       AND cell_key = ${cell.cellKey}
  `;

  const row = existing[0];
  if (row === undefined) {
    throw new OutlookCellIdentityError(
      `outlook cell ${cell.provider}/${cell.model}/${cell.cellKey} conflicted but could not be read back`,
    );
  }
  return row.id;
}

/* ------------------------------------------------------------------ *
 * Run lifecycle — §5.3 / §8.3
 * ------------------------------------------------------------------ */

/**
 * The subset of a Prisma client one statement needs.
 *
 * `Pick<PrismaClient, "$queryRaw">` rather than a hand-written signature so an
 * interactive transaction client — which is an `Omit` of the client, not a
 * different type — is assignable without a cast. The same alias is what the
 * queue accepts, which is how `succeed(job, tx)` can run a statement on the
 * caller's transaction instead of opening a second connection.
 */
export type SqlExecutor = Pick<PrismaClient, "$queryRaw">;

/** One persisted forecast run, camel-cased out of the row. */
export interface ForecastRunRecord {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly modelVersion: string | null;
  readonly product: string;
  readonly initializedAt: Date;
  readonly horizonEnd: Date;
  readonly receivedAt: Date;
  readonly createdAt: Date;
}

export interface NewForecastRun {
  readonly provider: string;
  readonly model: string;
  readonly product: ForecastProduct;
  /** Absent or null when the provider publishes none. Not part of identity. */
  readonly modelVersion?: string | null;
  readonly initializedAt: Date;
  /**
   * Derived by the adapter from the provider's declared coverage and truncated
   * to the last instant that actually returned a value (§5.7.1). This function
   * validates the relation to `initializedAt`; it never infers the horizon from
   * a product rule, because a second copy of that rule would drift.
   */
  readonly horizonEnd: Date;
  readonly receivedAt: Date;
}

/**
 * Natural-key upsert of one forecast run.
 *
 * `DO NOTHING` + `SELECT`, not `DO UPDATE`: `received_at` is the instant *we*
 * first received these bytes, and rewriting it on every re-discovery would
 * destroy the only column that answers "when did we see this". `id` is never
 * sent from application code — the column default mints it, so a caller cannot
 * fabricate an identity.
 */
export async function upsertForecastRun(
  db: SqlExecutor,
  input: NewForecastRun,
): Promise<ForecastRunRecord> {
  if (input.horizonEnd.getTime() <= input.initializedAt.getTime()) {
    throw new InvariantViolationError(
      `horizon_end (${input.horizonEnd.toISOString()}) must be after initialized_at (${input.initializedAt.toISOString()})`,
    );
  }

  const inserted = await db.$queryRaw<ForecastRunRecord[]>`
    INSERT INTO app.forecast_runs
      (provider, model, model_version, product, initialized_at, horizon_end, received_at)
    VALUES (
      ${input.provider}, ${input.model}, ${input.modelVersion ?? null}, ${input.product},
      ${input.initializedAt}, ${input.horizonEnd}, ${input.receivedAt})
    ON CONFLICT (provider, model, product, initialized_at) DO NOTHING
    RETURNING
      id::text AS "id",
      provider,
      model,
      model_version AS "modelVersion",
      product,
      initialized_at AS "initializedAt",
      horizon_end AS "horizonEnd",
      received_at AS "receivedAt",
      created_at AS "createdAt"
  `;

  const fresh = inserted[0];
  if (fresh !== undefined) return fresh;

  const existing = await db.$queryRaw<ForecastRunRecord[]>`
    SELECT
      id::text AS "id",
      provider,
      model,
      model_version AS "modelVersion",
      product,
      initialized_at AS "initializedAt",
      horizon_end AS "horizonEnd",
      received_at AS "receivedAt",
      created_at AS "createdAt"
      FROM app.forecast_runs
     WHERE provider = ${input.provider}
       AND model = ${input.model}
       AND product = ${input.product}
       AND initialized_at = ${input.initializedAt}
  `;

  const found = existing[0];
  if (found === undefined) {
    throw new InvariantViolationError(
      `forecast run ${input.provider}/${input.model}/${input.product}/${input.initializedAt.toISOString()} conflicted but could not be read back`,
    );
  }
  return found;
}

export interface BeginIngestionExecutionInput {
  readonly jobId: string;
  readonly leaseToken: string;
  readonly forecastRunId: string;
  readonly adapterVersion: string;
  readonly normalizerVersion: string;
  readonly targetSelectorHash: string;
}

export interface IngestionExecution {
  readonly runId: string;
  /** Handler starts recorded so far, including this one. */
  readonly attempt: number;
}

/**
 * Record that a handler is starting, and hand the job its IngestionRun.
 *
 * One transaction, two statements, because both halves are one fact: a run that
 * exists without a job owning it is a run nothing will ever finish, and a job
 * pointing at nothing is the state the reaper cannot act on.
 *
 * The run row is created **here**, not at enqueue (`climate-data-foundation.md`
 * §8.3). That is what makes `attempt` a handler-start count and `started_at` a
 * real start time: the table's own defaults become true the moment they are
 * written, instead of promising a start that may never happen.
 *
 * Every failure path throws; Prisma rolls the transaction back, which is what
 * undoes an attempt increment when the job guard below fails.
 */
export async function beginIngestionExecution(
  db: PrismaClient,
  input: BeginIngestionExecutionInput,
): Promise<IngestionExecution> {
  const ingestionVersion = ingestionVersionOf({
    adapterVersion: input.adapterVersion,
    normalizerVersion: input.normalizerVersion,
    targetSelectorHash: input.targetSelectorHash,
  });

  return db.$transaction(async (tx) => {
    // Job first, always (D21). The lock order is not a preference: a
    // transaction that locks the run and then waits for the job deadlocks
    // against every settlement, which locks the job and then the run.
    const jobRows = await tx.$queryRaw<{ ingestionRunId: string | null }[]>`
      SELECT ingestion_run_id::text AS "ingestionRunId"
        FROM app.jobs
       WHERE id = ${input.jobId}::uuid
         AND lease_token = ${input.leaseToken}::uuid
         AND status = 'running'
         AND lease_expires_at > now()
         FOR UPDATE
    `;
    const lockedJob = jobRows[0];
    if (lockedJob === undefined) {
      throw new LeaseLostError();
    }

    const started = await tx.$queryRaw<{ id: string; attempt: number }[]>`
      INSERT INTO app.ingestion_runs
        (forecast_run_id, adapter_version, normalizer_version,
         target_selector_hash, ingestion_version, status)
      VALUES (
        ${input.forecastRunId}::uuid, ${input.adapterVersion}, ${input.normalizerVersion},
        ${input.targetSelectorHash}, ${ingestionVersion}, 'running')
      ON CONFLICT (forecast_run_id, ingestion_version) DO UPDATE
         SET attempt = app.ingestion_runs.attempt + 1,
             status  = 'running'
       WHERE app.ingestion_runs.status IN ('queued', 'running')
      RETURNING id::text AS "id", attempt
    `;

    const run = started[0];
    if (run === undefined) {
      // No row means the conflict was refused — which is either "already
      // terminal" or "the identity points at nothing". Collapsing those two
      // into one error would make a bug indistinguishable from a no-op.
      const existing = await tx.$queryRaw<{ status: string }[]>`
        SELECT status
          FROM app.ingestion_runs
         WHERE forecast_run_id = ${input.forecastRunId}::uuid
           AND ingestion_version = ${ingestionVersion}
      `;
      const row = existing[0];
      if (row === undefined) {
        throw new IngestionRunMissingError(
          `ingestion run ${input.forecastRunId}/${ingestionVersion} was neither created nor found`,
        );
      }
      throw new IngestionTerminalError(row.status);
    }

    if (lockedJob.ingestionRunId !== null && lockedJob.ingestionRunId !== run.id) {
      // The job already owns a different run; it is not this worker's to
      // re-point, and the partial unique index agrees.
      throw new IngestionAlreadyOwnedError(
        `job ${input.jobId} already owns ingestion run ${lockedJob.ingestionRunId}`,
      );
    }

    try {
      const owned = await tx.$queryRaw<{ id: string }[]>`
        UPDATE app.jobs
           SET ingestion_run_id = ${run.id}::uuid,
               updated_at = now()
         WHERE id = ${input.jobId}::uuid
           AND lease_token = ${input.leaseToken}::uuid
           AND status = 'running'
           AND lease_expires_at > now()
           AND (ingestion_run_id IS NULL OR ingestion_run_id = ${run.id}::uuid)
        RETURNING id::text AS "id"
      `;
      if (owned[0] === undefined) {
        throw new LeaseLostError();
      }
    } catch (error) {
      if (isUniqueViolationOn(error, "jobs_active_ingestion_idx")) {
        throw new IngestionAlreadyOwnedError(
          `ingestion run ${run.id} is already owned by another running job`,
        );
      }
      throw error;
    }

    return { runId: run.id, attempt: run.attempt };
  });
}

/** The three statuses that end a run. `partial` is one of them (§4.4). */
export type TerminalIngestionStatus = "partial" | "succeeded" | "failed";

export interface IngestionOutcome {
  readonly runId: string;
  readonly to: TerminalIngestionStatus;
  readonly recordCount?: number;
  readonly coveragePercent?: number;
  readonly error?: { readonly code: string; readonly message: string } | null;
}

/**
 * Move a run to a terminal status, on the caller's transaction.
 *
 * Only `running` may be the source. `partial`, `succeeded` and `failed` have no
 * outgoing transition: an incomplete result is a result, and improving it means
 * a new `ingestionVersion`, never a rewritten history.
 *
 * `finished_at` is written with the status in one statement because
 * `ingestion_runs_finished_check` requires exactly that pairing.
 */
export async function markIngestionStatus(
  tx: SqlExecutor,
  outcome: IngestionOutcome,
): Promise<void> {
  const recordCount = outcome.recordCount ?? 0;
  if (recordCount < 0) {
    throw new InvariantViolationError("recordCount cannot be negative");
  }
  const coveragePercent = outcome.coveragePercent ?? 0;
  if (!(coveragePercent >= 0 && coveragePercent <= 100)) {
    throw new InvariantViolationError("coveragePercent must be between 0 and 100");
  }
  const errorJson =
    outcome.error === undefined || outcome.error === null ? null : JSON.stringify(outcome.error);

  const updated = await tx.$queryRaw<{ id: string }[]>`
    UPDATE app.ingestion_runs
       SET status            = ${outcome.to},
           finished_at       = now(),
           record_count      = ${recordCount},
           coverage_percent  = ${coveragePercent},
           error             = ${errorJson}::jsonb
     WHERE id = ${outcome.runId}::uuid
       AND status = 'running'
    RETURNING id::text AS "id"
  `;

  if (updated[0] !== undefined) return;

  const existing = await tx.$queryRaw<{ status: string }[]>`
    SELECT status FROM app.ingestion_runs WHERE id = ${outcome.runId}::uuid
  `;
  const row = existing[0];
  if (row === undefined) {
    throw new IngestionRunMissingError(`ingestion run ${outcome.runId} does not exist`);
  }
  throw new IngestionTerminalError(row.status);
}
