import { z } from "zod";

import { isoInstantSchema } from "./enums.js";
import { targetSelectorSchema } from "./climate.js";

/**
 * Queue contracts — `docs/architecture/background-processing.md` §2.1 / §3 and
 * `docs/architecture/climate-data-foundation.md` §8.3.
 *
 * These describe a job, not a PostgreSQL row. `JobQueue` is the boundary that
 * keeps a future backing store from changing job semantics; nothing here names
 * `SKIP LOCKED`, `jsonb`, or a lease table.
 */

/**
 * One of the six queues of `background-processing.md` §2. A queue name, not a
 * job type: the isolation requirement (concurrency ceiling, timeout, rate
 * bucket, blast radius) is what earns a `kind`, and it must match the database
 * CHECK exactly.
 */
export const jobKindSchema = z.enum([
  "ingest.forecast",
  "ingest.climate",
  "aggregate",
  "recompute.windows",
  "verify",
  "maintenance",
]);
export type JobKind = z.infer<typeof jobKindSchema>;

/**
 * Four states, no `failed`.
 *
 * `dead` is terminal failure *and* the dead-letter record — the same row, not a
 * second table. A retryable failure is not a state: the job returns to
 * `queued`, because between two attempts there is nothing to observe except the
 * wait.
 */
export const jobStatusSchema = z.enum(["queued", "running", "succeeded", "dead"]);
export type JobStatus = z.infer<typeof jobStatusSchema>;

export const jobErrorSchema = z.strictObject({
  code: z.string().min(1),
  message: z.string().min(1),
  /** Whether the failure was retryable. Recorded so a `dead` row says why. */
  retryable: z.boolean(),
});
export type JobError = z.infer<typeof jobErrorSchema>;

/**
 * The payload of an ingestion job. Kept minimal on purpose: `ingestionVersion`
 * is not stored, because the handler-start transaction recomputes it from these
 * three fields through `ingestionVersionOf`. A stored copy could disagree with
 * the row it is supposed to identify.
 */
export const ingestionJobPayloadSchema = z.strictObject({
  forecastRunId: z.uuid({ version: "v7" }),
  adapterVersion: z.string().min(1),
  normalizerVersion: z.string().min(1),
  targetSelectorHash: z.string().regex(/^[0-9a-f]{64}$/),
  /**
   * The selector itself, not just its hash. Optional in the contract because
   * not every ingestion kind needs one, but an `ingest.forecast` job without it
   * is refused by its handler — the handler cannot fetch a cell it cannot name.
   * When present the handler verifies
   * `targetSelectorHashOf(targetSelector) === targetSelectorHash`; the
   * redundancy is deliberate, so a payload edited in the queue is caught before
   * anything is fetched.
   */
  targetSelector: targetSelectorSchema.optional(),
});
export type IngestionJobPayload = z.infer<typeof ingestionJobPayloadSchema>;

/**
 * The payload of an `ingest.climate` climatology job — Phase 5.5.
 *
 * Climatology is a baseline, not a forecast: there is no `ForecastRun` and no
 * `IngestionRun`, so the forecast payload's run fields are absent rather than
 * fabricated. The baseline version is **derived** from the dataset and the
 * algorithm version by the builder, not carried in the payload — a stored copy
 * could disagree with the rows it names.
 *
 * The selector still names cells and variables, so the approval digest works
 * exactly as it does for a forecast ingest: the queue row is not a trusted
 * authority for which cells were approved.
 */
export const climatologyJobPayloadSchema = z.strictObject({
  provider: z.literal("open-meteo"),
  model: z.literal("era5"),
  baselineDataset: z.literal("era5"),
  algorithmVersion: z.string().regex(/^[A-Za-z0-9._-]+$/),
  targetSelectorHash: z.string().regex(/^[0-9a-f]{64}$/),
  targetSelector: targetSelectorSchema,
});
export type ClimatologyJobPayload = z.infer<typeof climatologyJobPayloadSchema>;

/**
 * One persisted job.
 *
 * The two refinements restate database CHECKs (`jobs_lease_check`,
 * `jobs_finished_check`) so a value that cannot exist in storage cannot exist
 * as a contract either: a lease only while running, a finish time exactly at a
 * terminal state.
 */
export const jobSchema = z
  .strictObject({
    id: z.uuid(),
    kind: jobKindSchema,
    idempotencyKey: z.string().min(1),
    payload: z.unknown(),
    status: jobStatusSchema,
    /** Claims that succeeded. `0` = never claimed. */
    attempt: z.number().int().nonnegative(),
    maxAttempts: z.number().int().positive(),
    runAt: isoInstantSchema,
    leaseToken: z.uuid().nullable(),
    leaseExpiresAt: isoInstantSchema.nullable(),
    ingestionRunId: z.uuid().nullable(),
    lastError: jobErrorSchema.nullable(),
    finishedAt: isoInstantSchema.nullable(),
    createdAt: isoInstantSchema,
    updatedAt: isoInstantSchema,
  })
  .superRefine((job, ctx) => {
    if ((job.status === "running") !== (job.leaseToken !== null)) {
      ctx.addIssue({
        code: "custom",
        path: ["leaseToken"],
        message: "a lease exists exactly while the job is running",
      });
    }
    const finished = job.status === "succeeded" || job.status === "dead";
    if (finished !== (job.finishedAt !== null)) {
      ctx.addIssue({
        code: "custom",
        path: ["finishedAt"],
        message: `finishedAt must be ${finished ? "set" : "null"} for status "${job.status}"`,
      });
    }
    if (job.attempt > job.maxAttempts) {
      ctx.addIssue({
        code: "custom",
        path: ["attempt"],
        message: "attempt cannot exceed maxAttempts",
      });
    }
  });
export type Job = z.infer<typeof jobSchema>;
