import type { JobKind } from "@agroclimate/contracts";
import type { JobError } from "@agroclimate/contracts";
import type { PrismaClient, SqlExecutor } from "@agroclimate/database";
import { InvariantViolationError, JobRetryExhaustedError, settlePair } from "@agroclimate/database";

import type {
  ClaimedJob,
  ClaimOptions,
  EnqueueInput,
  EnqueueResult,
  FailOutcome,
  JobQueue,
  ReapedJob,
} from "./types.js";

/**
 * The PostgreSQL queue — `background-processing.md` §2.1.
 *
 * Every statement here is one statement, or one interactive transaction. That
 * is the whole design: `SKIP LOCKED` prevents two workers from *choosing* the
 * same row at the same moment, and `lease_expires_at` (plus the reaper) is what
 * recovers a row whose worker died. `SKIP LOCKED` alone recovers nothing, and
 * a worker that believes it does will leak stuck jobs forever.
 *
 * The claim commits before the handler runs. Holding the row lock across the
 * work would serialise every worker on earth behind one slow provider call.
 */

export interface PostgresQueueOptions {
  readonly db: PrismaClient;
  readonly defaultMaxAttempts: number;
  /** Rows per reaper pass. Bounded so one pass cannot hold a transaction for minutes. */
  readonly reaperBatchSize?: number | undefined;
}

interface ClaimedRow {
  readonly id: string;
  readonly kind: string;
  readonly payload: unknown;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly leaseToken: string;
  readonly leaseExpiresAt: Date;
}

const LEASE_EXPIRED_ERROR = {
  code: "lease_expired",
  message: "execution lease expired; attempt budget exhausted",
  retryable: true,
} as const;

/**
 * The claim was released before a handler began and no claim remained. Nothing
 * was ingested, so there is no run to fail — the job is dead with this reason
 * and nothing else is written.
 */
const CLAIM_BUDGET_EXHAUSTED_ERROR = {
  code: "claim_budget_exhausted",
  message: "attempt budget exhausted before handler execution; no ingestion run was created",
  retryable: false,
} as const;

export function createPostgresQueue(options: PostgresQueueOptions): JobQueue {
  const { db, defaultMaxAttempts } = options;
  const reaperBatchSize = options.reaperBatchSize ?? 20;

  return {
    async enqueue(input: EnqueueInput): Promise<EnqueueResult> {
      const maxAttempts = input.maxAttempts ?? defaultMaxAttempts;
      const payload = JSON.stringify(input.payload ?? {});

      const inserted = await db.$queryRaw<{ id: string }[]>`
        INSERT INTO app.jobs (kind, idempotency_key, payload, run_at, max_attempts)
        VALUES (
          ${input.kind}, ${input.idempotencyKey}, ${payload}::jsonb,
          ${input.runAt ?? new Date()}, ${maxAttempts})
        ON CONFLICT (kind, idempotency_key) DO NOTHING
        RETURNING id::text AS "id"
      `;

      const fresh = inserted[0];
      if (fresh !== undefined) return { id: fresh.id, enqueued: true };

      // `DO NOTHING` returns nothing on conflict, and the row is never deleted,
      // so this SELECT is guaranteed to see it. If it does not, the key and the
      // row disagree and the caller must hear about it.
      const existing = await db.$queryRaw<{ id: string }[]>`
        SELECT id::text AS "id"
          FROM app.jobs
         WHERE kind = ${input.kind}
           AND idempotency_key = ${input.idempotencyKey}
      `;
      const row = existing[0];
      if (row === undefined) {
        throw new InvariantViolationError(
          `job ${input.kind}/${input.idempotencyKey} conflicted but could not be read back`,
        );
      }
      return { id: row.id, enqueued: false };
    },

    async claim(claimOptions: ClaimOptions): Promise<ClaimedJob | null> {
      if (claimOptions.kinds.length === 0) return null;

      // One statement: the CTE locks the candidate, the UPDATE writes the same
      // row. A SELECT followed by an UPDATE is the classic double-claim bug —
      // both workers see the same row, both then claim it.
      const rows = await db.$queryRaw<ClaimedRow[]>`
        WITH candidate AS (
          SELECT id
            FROM app.jobs
           WHERE status = 'queued'
             AND run_at <= now()
             AND kind = ANY(${claimOptions.kinds}::text[])
           ORDER BY run_at, id
           FOR UPDATE SKIP LOCKED
           LIMIT 1
        )
        UPDATE app.jobs AS j
           SET status           = 'running',
               attempt          = j.attempt + 1,
               lease_token      = gen_random_uuid(),
               lease_expires_at = now() + (${claimOptions.leaseMs}::int * interval '1 millisecond'),
               updated_at       = now()
          FROM candidate AS c
         WHERE j.id = c.id
        RETURNING j.id::text AS "id",
                  j.kind,
                  j.payload,
                  j.attempt,
                  j.max_attempts AS "maxAttempts",
                  j.lease_token::text AS "leaseToken",
                  j.lease_expires_at AS "leaseExpiresAt"
      `;

      const row = rows[0];
      if (row === undefined) return null;
      return {
        id: row.id,
        kind: row.kind as JobKind,
        payload: row.payload,
        attempt: row.attempt,
        maxAttempts: row.maxAttempts,
        leaseToken: row.leaseToken,
        leaseExpiresAt: row.leaseExpiresAt,
      };
    },

    async renew(job: ClaimedJob, leaseMs: number): Promise<boolean> {
      // `lease_expires_at > now()` is part of the guard: a worker that has
      // already let its lease lapse must not extend it, or a stuck handler
      // could keep a job alive forever while the reaper is supposed to recover it.
      //
      // Both the guard and the new term are evaluated when the statement starts,
      // *before* the row lock is waited on: an UPDATE projects its target list in
      // the scan node, so `now()` and `clock_timestamp()` agree here even if the
      // statement then waits for a handler that holds the row `FOR UPDATE`. A
      // renewal therefore can never extend a lease by more than `leaseMs` from
      // the moment it began, which is what bounds a long transaction
      // (`OUTLOOK_LEASE_HEADROOM_MS`).
      const rows = await db.$queryRaw<{ id: string }[]>`
        UPDATE app.jobs
           SET lease_expires_at = now() + (${leaseMs}::int * interval '1 millisecond'),
               updated_at       = now()
         WHERE id = ${job.id}::uuid
           AND lease_token = ${job.leaseToken}::uuid
           AND status = 'running'
           AND lease_expires_at > now()
        RETURNING id::text AS "id"
      `;
      return rows[0] !== undefined;
    },

    async succeed(job: ClaimedJob, tx: SqlExecutor): Promise<boolean> {
      // Settlement is one primitive (D15c). This method is the queue-shaped
      // name for it; it no longer carries its own UPDATE, because two
      // implementations of "the job is done" drift apart under contention.
      const outcome = await settlePair(tx, {
        jobId: job.id,
        authority: { kind: "lease", leaseToken: job.leaseToken },
        mode: { mode: "succeed", to: "succeeded", recordCount: 0, coveragePercent: 0 },
      });
      return outcome.settled;
    },

    async fail(
      job: ClaimedJob,
      error: JobError,
      outcome: FailOutcome,
      tx: SqlExecutor,
    ): Promise<boolean> {
      if ("terminal" in outcome) {
        // Retired as an independent write: a terminal job write and a terminal
        // run write are one fact, so the run is read from the locked job row.
        const settled = await settlePair(tx, {
          jobId: job.id,
          authority: { kind: "lease", leaseToken: job.leaseToken },
          mode: { mode: "failed", error: { code: error.code, message: error.message } },
        });
        return settled.settled;
      }

      if (job.attempt >= job.maxAttempts) {
        // Silent conversion would leave the IngestionRun `running` forever,
        // because the terminal path — the only place that fails the run — is
        // not reached. Loud is correct here.
        throw new JobRetryExhaustedError(job.attempt);
      }
      const errorJson = JSON.stringify(error);
      const rows = await tx.$queryRaw<{ id: string }[]>`
        UPDATE app.jobs
           SET status           = 'queued',
               run_at           = now() + (${outcome.retryAfterMs}::int * interval '1 millisecond'),
               lease_token      = NULL,
               lease_expires_at = NULL,
               last_error       = ${errorJson}::jsonb,
               updated_at       = now()
         WHERE id = ${job.id}::uuid
           AND lease_token = ${job.leaseToken}::uuid
           AND status = 'running'
           AND lease_expires_at > now()
        RETURNING id::text AS "id"
      `;
      return rows[0] !== undefined;
    },

    async release(job: ClaimedJob): Promise<boolean> {
      // Only before the handler began. Releasing a job whose handler is still
      // running would hand the same work to a second worker while the first is
      // still writing; the lease is what makes that impossible, so it must be
      // allowed to expire instead.
      //
      // The claim already charged `attempt`, and `jobs_attempt_check` allows at
      // most `max_attempts`. Requeueing at the ceiling would leave a row every
      // future claim rejects with a check violation, so the requeue-or-dead
      // decision is part of this one statement: a read followed by an update
      // would put a race between them, and a caller-side branch would have to
      // re-check ownership to stay correct.
      //
      // No IngestionRun is created or touched. This path is reachable only while
      // `ingestion_run_id IS NULL` — the state before a handler starts — so a
      // claim that dies here has nothing to ingest, and inventing a run would
      // fabricate provenance.
      const rows = await db.$queryRaw<{ status: string }[]>`
        UPDATE app.jobs
           SET status           = CASE WHEN attempt >= max_attempts THEN 'dead' ELSE 'queued' END,
               run_at           = now(),
               finished_at      = CASE WHEN attempt >= max_attempts THEN now() ELSE NULL END,
               last_error       = CASE WHEN attempt >= max_attempts
                                       THEN ${CLAIM_BUDGET_EXHAUSTED_ERROR}::jsonb
                                       ELSE last_error END,
               lease_token      = NULL,
               lease_expires_at = NULL,
               updated_at       = now()
         WHERE id = ${job.id}::uuid
           AND lease_token = ${job.leaseToken}::uuid
           AND status = 'running'
           AND ingestion_run_id IS NULL
         RETURNING status
      `;
      return rows[0] !== undefined;
    },

    async reapExpired(): Promise<readonly ReapedJob[]> {
      // Candidate selection is not authority: two reapers may pick the same row.
      // Each candidate is settled in its own transaction, and both the requeue
      // and the settlement re-check the observed lease token against the locked
      // row — a claim that replaced the lease between the two statements fences
      // the pass. Re-entrant locking confers nothing (D15a).
      const candidates = await db.$queryRaw<
        { id: string; attempt: number; maxAttempts: number; leaseToken: string | null }[]
      >`
        SELECT id::text        AS "id",
               attempt,
               max_attempts    AS "maxAttempts",
               lease_token::text AS "leaseToken"
          FROM app.jobs
         WHERE status = 'running'
           AND lease_expires_at <= now()
         ORDER BY lease_expires_at
         LIMIT ${reaperBatchSize}
      `;

      const reaped: ReapedJob[] = [];

      for (const candidate of candidates) {
        const settled = await db.$transaction(
          async (tx): Promise<ReapedJob | null> => {
            if (candidate.attempt < candidate.maxAttempts) {
              // `attempt` is untouched: the crashed execution already counted
              // itself when it was claimed. Counting it again would charge one
              // crash to the retry budget twice.
              const rows = await tx.$queryRaw<{ id: string }[]>`
                UPDATE app.jobs
                   SET status           = 'queued',
                       run_at           = now(),
                       lease_token      = NULL,
                       lease_expires_at = NULL,
                       updated_at       = now()
                 WHERE id = ${candidate.id}::uuid
                   AND status = 'running'
                   AND lease_expires_at <= now()
                   AND lease_token IS NOT DISTINCT FROM ${candidate.leaseToken}::uuid
                RETURNING id::text AS "id"
              `;
              return rows[0] === undefined ? null : { id: candidate.id, status: "queued" };
            }

            // Budget spent. A NULL run reference means the handler never began,
            // so there is no run to fail and none is invented. When the run is
            // already terminal, the settlement adopts it: a failed job over a
            // successful run would contradict data that was written.
            const outcome = await settlePair(tx, {
              jobId: candidate.id,
              authority: { kind: "reaper", observedLeaseToken: candidate.leaseToken },
              mode: { mode: "failed", error: LEASE_EXPIRED_ERROR },
            });
            if (!outcome.settled) return null;
            return {
              id: candidate.id,
              status: outcome.jobStatus === "succeeded" ? "succeeded" : "dead",
            };
          },
          { timeout: 10_000, maxWait: 2_000 },
        );

        if (settled !== null) reaped.push(settled);
      }

      return reaped;
    },
  };
}

/**
 * The established retry policy (`background-processing.md` §4): 1, 5, 20
 * minutes, five attempts. Written as a function rather than inlined at the call
 * site so a test can assert it and a change has one place to happen.
 */
export function retryDelayMsFor(attempt: number): number {
  const minutes = attempt <= 1 ? 1 : attempt === 2 ? 5 : 20;
  return minutes * 60_000;
}
