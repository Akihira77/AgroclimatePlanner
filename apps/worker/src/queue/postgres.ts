import type { JobKind } from "@agroclimate/contracts";
import type { JobError } from "@agroclimate/contracts";
import type { PrismaClient, SqlExecutor } from "@agroclimate/database";
import { InvariantViolationError, JobRetryExhaustedError } from "@agroclimate/database";

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

interface ExpiredRow {
  readonly id: string;
  readonly ingestionRunId: string | null;
  readonly attempt: number;
  readonly maxAttempts: number;
}

const LEASE_EXPIRED_ERROR = {
  code: "lease_expired",
  message: "execution lease expired; attempt budget exhausted",
  retryable: true,
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
      // `lease_expires_at > now()` belongs in the same guard as the token: the
      // reaper runs on a timer, so an expired lease keeps its token and
      // `status = 'running'` for up to one interval. Without the expiry check a
      // worker whose lease lapsed could finish work it no longer owns, and race
      // the reaper to the terminal write.
      const rows = await tx.$queryRaw<{ id: string }[]>`
        UPDATE app.jobs
           SET status           = 'succeeded',
               finished_at      = now(),
               lease_token      = NULL,
               lease_expires_at = NULL,
               last_error       = NULL,
               updated_at       = now()
         WHERE id = ${job.id}::uuid
           AND lease_token = ${job.leaseToken}::uuid
           AND status = 'running'
           AND lease_expires_at > now()
        RETURNING id::text AS "id"
      `;
      return rows[0] !== undefined;
    },

    async fail(
      job: ClaimedJob,
      error: JobError,
      outcome: FailOutcome,
      tx: SqlExecutor,
    ): Promise<boolean> {
      const errorJson = JSON.stringify(error);

      if ("retryable" in outcome) {
        if (job.attempt >= job.maxAttempts) {
          // Silent conversion would leave the IngestionRun `running` forever,
          // because the terminal path — the only place that fails the run — is
          // not reached. Loud is correct here.
          throw new JobRetryExhaustedError(job.attempt);
        }
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
      }

      const rows = await tx.$queryRaw<{ id: string }[]>`
        UPDATE app.jobs
           SET status           = 'dead',
               finished_at      = now(),
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
      const rows = await db.$queryRaw<{ id: string }[]>`
        UPDATE app.jobs
           SET status           = 'queued',
               run_at           = now(),
               lease_token      = NULL,
               lease_expires_at = NULL,
               updated_at       = now()
         WHERE id = ${job.id}::uuid
           AND lease_token = ${job.leaseToken}::uuid
           AND status = 'running'
           AND ingestion_run_id IS NULL
        RETURNING id::text AS "id"
      `;
      return rows[0] !== undefined;
    },

    async reapExpired(): Promise<readonly ReapedJob[]> {
      return db.$transaction(
        async (tx) => {
          const expired = await tx.$queryRaw<ExpiredRow[]>`
            SELECT id::text AS "id",
                   ingestion_run_id::text AS "ingestionRunId",
                   attempt,
                   max_attempts AS "maxAttempts"
              FROM app.jobs
             WHERE status = 'running'
               AND lease_expires_at < now()
             ORDER BY lease_expires_at
             FOR UPDATE SKIP LOCKED
             LIMIT ${reaperBatchSize}
          `;

          const reaped: ReapedJob[] = [];

          for (const row of expired) {
            if (row.attempt < row.maxAttempts) {
              // `attempt` is untouched: the crashed execution already counted
              // itself when it was claimed. Counting it again would charge one
              // crash to the retry budget twice.
              await tx.$queryRaw`
                UPDATE app.jobs
                   SET status           = 'queued',
                       run_at           = now(),
                       lease_token      = NULL,
                       lease_expires_at = NULL,
                       updated_at       = now()
                 WHERE id = ${row.id}::uuid
              `;
              reaped.push({ id: row.id, status: "queued" });
              continue;
            }

            await tx.$queryRaw`
              UPDATE app.jobs
                 SET status           = 'dead',
                     finished_at      = now(),
                     lease_token      = NULL,
                     lease_expires_at = NULL,
                     last_error       = COALESCE(last_error, ${JSON.stringify(LEASE_EXPIRED_ERROR)}::jsonb),
                     updated_at       = now()
               WHERE id = ${row.id}::uuid
            `;

            // A NULL reference means the handler never began, so there is no
            // run to fail — and inventing one here would fabricate provenance.
            if (row.ingestionRunId !== null) {
              await tx.$queryRaw`
                UPDATE app.ingestion_runs
                   SET status      = 'failed',
                       finished_at = now(),
                       error       = ${JSON.stringify(LEASE_EXPIRED_ERROR)}::jsonb
                 WHERE id = ${row.ingestionRunId}::uuid
                   AND status IN ('queued', 'running')
              `;
            }

            reaped.push({ id: row.id, status: "dead" });
          }

          return reaped;
        },
        { timeout: 10_000 },
      );
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
