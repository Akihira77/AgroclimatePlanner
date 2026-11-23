/**
 * The single authoritative settlement primitive — D15c, D21, D15a.
 *
 * One job, one run, one transaction, one lock order: **Job → IngestionRun**.
 * Every terminal transition in the system goes through here: the handler's
 * success path, the runner's failure path, the reaper's recovery pass, and the
 * witness. There is no second way to write `jobs.status` terminal or
 * `ingestion_runs.status` terminal, and `queue.fail({terminal:true})` no longer
 * exists to offer one.
 *
 * Two authorities share the primitive because they share the transition, not
 * because they share permission:
 *
 *   lease   a worker may settle a job it owns *now*: token match, `running`,
 *           lease still live. Losing any of those means the result must be
 *           discarded — the caller turns `authority_lost` into a rollback.
 *
 *   reaper  recovery may settle a job whose lease is *already* expired; that
 *           expiry is its authority, not its disqualification. The observed
 *           token is a fence against a claim that replaced the lease between
 *           candidate selection and settlement.
 *
 * A row lock answers "nobody else is writing"; it does not answer "may I
 * write". Both checks live here, and the authority predicate is evaluated
 * against the locked row rather than a caller-held snapshot.
 */
import { InvariantViolationError, LeaseLostError } from "./run-errors.js";
import { markIngestionStatus, type SqlExecutor } from "./climate.js";

/** How the caller proves it may settle. */
export type SettlementAuthority =
  | { readonly kind: "lease"; readonly leaseToken: string }
  | { readonly kind: "reaper"; readonly observedLeaseToken: string | null };

export type SettlementMode =
  | {
      readonly mode: "succeed";
      /** `partial` is a terminal success; it is never `failed`. */
      readonly to: "succeeded" | "partial";
      readonly recordCount: number;
      readonly coveragePercent: number;
    }
  | {
      readonly mode: "failed";
      readonly error: { readonly code: string; readonly message: string };
    }
  /** Adopt whatever terminal state the run already reached. Never guesses. */
  | { readonly mode: "adopt" };

export interface SettlementRequest {
  readonly jobId: string;
  readonly authority: SettlementAuthority;
  readonly mode: SettlementMode;
}

export type SettlementOutcome =
  | {
      readonly settled: true;
      readonly jobId: string;
      readonly jobStatus: "succeeded" | "dead";
      readonly runId: string | null;
      readonly runStatus: string | null;
      /** The job adopted a state the run already had; nothing was inferred. */
      readonly adopted: boolean;
    }
  | { readonly settled: false; readonly reason: "authority_lost" };

/**
 * A job and a run disagree about a state the design declares impossible:
 * a successful run with a failed settlement, or a `dead` job over a live run.
 * Never resolved automatically — guessing here turns a bug into wrong data.
 */
export class InconsistentSettlementError extends Error {
  override readonly name = "InconsistentSettlementError";

  constructor(
    readonly jobStatus: string,
    readonly runStatus: string | null,
  ) {
    super(
      `job is "${jobStatus}" and its ingestion run is "${runStatus ?? "(none)"}"; ` +
        "the pair cannot be settled without inventing a state",
    );
  }
}

export class JobMissingError extends Error {
  override readonly name = "JobMissingError";
}

interface LockedJob {
  readonly id: string;
  readonly status: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly leaseToken: string | null;
  readonly leaseLive: boolean;
  readonly ingestionRunId: string | null;
}

interface LockedRun {
  readonly id: string;
  readonly status: string;
}

/**
 * Lock the job row and read the facts the settlement decision needs.
 *
 * `FOR UPDATE` is the first statement of any settlement transaction, which is
 * what makes the lock order observable: a caller that has not gone through this
 * function cannot have locked a run first.
 */
export async function lockJobForSettlement(tx: SqlExecutor, jobId: string): Promise<LockedJob> {
  const rows = await tx.$queryRaw<
    {
      id: string;
      status: string;
      attempt: number;
      maxAttempts: number;
      leaseToken: string | null;
      leaseLive: boolean;
      ingestionRunId: string | null;
    }[]
  >`
    SELECT id::text                      AS "id",
           status,
           attempt,
           max_attempts                  AS "maxAttempts",
           lease_token::text             AS "leaseToken",
           (lease_expires_at > now())    AS "leaseLive",
           ingestion_run_id::text        AS "ingestionRunId"
      FROM app.jobs
     WHERE id = ${jobId}::uuid
       FOR UPDATE
  `;
  const row = rows[0];
  if (row === undefined) {
    throw new JobMissingError(`job ${jobId} does not exist`);
  }
  return row;
}

function authorityHolds(job: LockedJob, authority: SettlementAuthority): boolean {
  if (job.status !== "running") return false;
  if (authority.kind === "lease") {
    return job.leaseToken === authority.leaseToken && job.leaseLive;
  }
  // Reaper: the lease must actually be expired, and the token must still be the
  // one that was observed. A new claim changes the token, which fences the pass.
  return !job.leaseLive && job.leaseToken === authority.observedLeaseToken;
}

async function lockRun(tx: SqlExecutor, runId: string): Promise<LockedRun> {
  // Run lock comes strictly after the job lock. There is exactly one call site,
  // and it is downstream of `lockJobForSettlement` by construction.
  const rows = await tx.$queryRaw<{ id: string; status: string }[]>`
    SELECT id::text AS "id", status
      FROM app.ingestion_runs
     WHERE id = ${runId}::uuid
       FOR UPDATE
  `;
  const row = rows[0];
  if (row === undefined) {
    throw new InvariantViolationError(
      `job references ingestion run ${runId}, which does not exist`,
    );
  }
  return row;
}

function terminalJobStatus(runStatus: string): "succeeded" | "dead" {
  switch (runStatus) {
    case "succeeded":
    case "partial":
      return "succeeded";
    case "failed":
      return "dead";
    default:
      throw new InvariantViolationError(
        `ingestion run status "${runStatus}" is not terminal and cannot be adopted`,
      );
  }
}

/**
 * Settle one job (and its run, when it has one) atomically.
 *
 * Returns `settled: false` rather than throwing when the caller's authority no
 * longer holds: the reaper iterates candidates and must be able to skip one,
 * while a worker turns the same value into `LeaseLostError` so the surrounding
 * transaction rolls back every write made under the lost lease.
 */
export async function settlePair(
  tx: SqlExecutor,
  request: SettlementRequest,
): Promise<SettlementOutcome> {
  const job = await lockJobForSettlement(tx, request.jobId);
  if (!authorityHolds(job, request.authority)) {
    return { settled: false, reason: "authority_lost" };
  }

  const run = job.ingestionRunId === null ? null : await lockRun(tx, job.ingestionRunId);
  let runStatus = run?.status ?? null;

  let jobStatus: "succeeded" | "dead";
  let adopted = false;

  switch (request.mode.mode) {
    case "succeed": {
      if (run === null) {
        // A job kind that never opens an IngestionRun. No run is invented.
        jobStatus = "succeeded";
        break;
      }
      if (runStatus === "running") {
        await markIngestionStatus(tx, {
          runId: run.id,
          to: request.mode.to,
          recordCount: request.mode.recordCount,
          coveragePercent: request.mode.coveragePercent,
        });
        runStatus = request.mode.to;
        jobStatus = "succeeded";
        break;
      }
      if (runStatus === "succeeded" || runStatus === "partial") {
        // The run already reached a compatible terminal state — the retry of a
        // T3 whose COMMIT was ambiguous lands here. Adopt it; do not rewrite.
        jobStatus = "succeeded";
        adopted = true;
        break;
      }
      throw new InconsistentSettlementError(job.status, runStatus);
    }

    case "failed": {
      if (run === null) {
        jobStatus = "dead";
        break;
      }
      if (runStatus === "running") {
        await markIngestionStatus(tx, {
          runId: run.id,
          to: "failed",
          error: request.mode.error,
        });
        runStatus = "failed";
        jobStatus = "dead";
        break;
      }
      // R7: a failed job must not be written over a successful run. The run is
      // the stronger fact — the data is already persisted.
      jobStatus = terminalJobStatus(runStatus ?? "");
      adopted = true;
      break;
    }

    case "adopt": {
      if (run === null) {
        throw new InconsistentSettlementError(job.status, null);
      }
      if (runStatus === "running") {
        throw new InconsistentSettlementError(job.status, runStatus);
      }
      jobStatus = terminalJobStatus(runStatus ?? "");
      adopted = true;
      break;
    }
  }

  // A job that adopted a successful run is not a failure, whatever the caller
  // asked for; recording the error would contradict the data that was written.
  const errorJson =
    request.mode.mode === "failed" && jobStatus === "dead"
      ? JSON.stringify(request.mode.error)
      : null;

  const updated = await tx.$queryRaw<{ id: string }[]>`
    UPDATE app.jobs
       SET status           = ${jobStatus},
           finished_at      = now(),
           lease_token      = NULL,
           lease_expires_at = NULL,
           last_error       = ${errorJson}::jsonb,
           updated_at       = now()
     WHERE id = ${job.id}::uuid
       AND status = 'running'
    RETURNING id::text AS "id"
  `;
  if (updated[0] === undefined) {
    // The row was locked and verified above, so zero rows here is a bug, not
    // contention. Failing loudly is the only option that stays honest.
    throw new InvariantViolationError(
      `settlement of job ${job.id} updated no row despite holding its lock`,
    );
  }

  return {
    settled: true,
    jobId: job.id,
    jobStatus,
    runId: run?.id ?? null,
    runStatus,
    adopted,
  };
}

/** Worker-side wrapper: an authority loss is a rollback, not a value to log. */
export async function settlePairAsWorker(
  tx: SqlExecutor,
  request: Omit<SettlementRequest, "authority"> & { readonly leaseToken: string },
): Promise<Extract<SettlementOutcome, { settled: true }>> {
  const outcome = await settlePair(tx, {
    jobId: request.jobId,
    authority: { kind: "lease", leaseToken: request.leaseToken },
    mode: request.mode,
  });
  if (!outcome.settled) {
    throw new LeaseLostError();
  }
  return outcome;
}
