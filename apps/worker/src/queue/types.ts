import type { JobError, JobKind } from "@agroclimate/contracts";
import type { SqlExecutor } from "@agroclimate/database";

/**
 * The queue boundary — `background-processing.md` §2.1, §10.
 *
 * Seven methods, all in job terms. Nothing here names PostgreSQL, a table, or
 * `SKIP LOCKED`, so replacing the backing store is a module swap rather than a
 * rewrite of every handler. The two transaction-taking methods are the only
 * place the abstraction admits that a caller may own a transaction; that is
 * deliberate, and required by §4.9 (a terminal job write and a terminal run
 * write are one fact).
 */

export interface EnqueueInput {
  readonly kind: JobKind;
  /** Deterministic over the job's logical identity. See `ingestionJobIdentityOf`. */
  readonly idempotencyKey: string;
  readonly payload: unknown;
  readonly runAt?: Date | undefined;
  readonly maxAttempts?: number | undefined;
}

export interface EnqueueResult {
  readonly id: string;
  /** `false` means the key already existed: the same job, not a new one. */
  readonly enqueued: boolean;
}

export interface ClaimedJob {
  readonly id: string;
  readonly kind: JobKind;
  readonly payload: unknown;
  /** Claims that succeeded, including this one. */
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly leaseToken: string;
  readonly leaseExpiresAt: Date;
}

export interface ClaimOptions {
  readonly leaseMs: number;
  /** Only these queues are claimed. An empty list claims nothing. */
  readonly kinds: readonly JobKind[];
}

export type FailOutcome =
  { readonly retryable: true; readonly retryAfterMs: number } | { readonly terminal: true };

export interface ReapedJob {
  readonly id: string;
  /** `succeeded` only when the run had already completed successfully. */
  readonly status: "queued" | "dead" | "succeeded";
}

export interface JobQueue {
  enqueue(input: EnqueueInput): Promise<EnqueueResult>;
  claim(options: ClaimOptions): Promise<ClaimedJob | null>;
  renew(job: ClaimedJob, leaseMs: number): Promise<boolean>;
  succeed(job: ClaimedJob, tx: SqlExecutor): Promise<boolean>;
  fail(job: ClaimedJob, error: JobError, outcome: FailOutcome, tx: SqlExecutor): Promise<boolean>;
  /**
   * Settle a claim before a handler begins: requeue while a claim remains, go
   * `dead` when the attempt budget is spent. Reachable only while
   * `ingestion_run_id IS NULL`, so no IngestionRun exists and none is created.
   * `false` means ownership was lost and nothing was written.
   */
  release(job: ClaimedJob): Promise<boolean>;
  /**
   * Withdraw a job that has not started: `queued` → `cancelled`, terminal, with
   * `finished_at` set and no error. `false` when the row cannot be withdrawn —
   * running, settled, not there, or a retry still holding the `IngestionRun` its
   * first attempt opened (cancelling that row would orphan a `running` run).
   *
   * A `running` job is refused rather than aborted from here: the handler may be
   * mid-transaction, and the queue has no channel to interrupt another process.
   */
  cancel(jobId: string): Promise<boolean>;
  reapExpired(): Promise<readonly ReapedJob[]>;
}
