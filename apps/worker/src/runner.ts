import type { JobError, JobKind } from "@agroclimate/contracts";
import { ingestionJobPayloadSchema } from "@agroclimate/contracts";
import type { IngestionExecution, PrismaClient } from "@agroclimate/database";
import {
  beginIngestionExecution,
  IngestionAlreadyOwnedError,
  IngestionTerminalError,
  InvariantViolationError,
  isCheckViolation,
  LeaseLostError,
  markIngestionStatus,
} from "@agroclimate/database";

import { retryDelayMsFor } from "./queue/postgres.js";
import type { ClaimedJob, JobQueue } from "./queue/types.js";

/**
 * The worker runtime — `climate-data-foundation.md` §8.3,
 * `background-processing.md` §2.1.
 *
 * One job at a time per process, and that is a choice rather than a shortcut:
 * the six queues exist to isolate concurrency ceilings, and a single control
 * loop makes the lease, heartbeat and shutdown semantics provable. Scale by
 * running more processes — the claim is already safe across them.
 *
 * The lease — not a lock — is what protects the job. A claim commits before the
 * handler runs, so nothing is held while a provider is slow; if this process
 * dies, `lease_expires_at` lapses and the reaper recovers the row.
 */

export type LogFn = (event: string, fields?: Record<string, unknown>) => void;

export const jsonLogger: LogFn = (event, fields) => {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), event, ...fields })}\n`);
};

export interface HandlerContext {
  readonly db: PrismaClient;
  readonly signal: AbortSignal;
  readonly log: LogFn;
  /**
   * The run this handler owns, already recorded. `null` for kinds that do not
   * map to an IngestionRun.
   */
  readonly execution: IngestionExecution | null;
}

export type HandlerResult =
  | {
      readonly outcome: "succeeded";
      /** `partial` is a terminal success (§4.4); it is not a failure. */
      readonly ingestionStatus?: "succeeded" | "partial" | undefined;
      readonly recordCount?: number | undefined;
      readonly coveragePercent?: number | undefined;
    }
  | { readonly outcome: "retryable"; readonly error: JobError }
  | { readonly outcome: "terminal"; readonly error: JobError };

export interface JobHandler {
  readonly kind: JobKind;
  /**
   * `true` = the job executes one logical ingestion, so the runner opens the
   * IngestionRun before calling `handle`. `false` for maintenance-style kinds.
   */
  readonly opensIngestionRun: boolean;
  handle(job: ClaimedJob, context: HandlerContext): Promise<HandlerResult>;
}

export interface RunnerOptions {
  readonly db: PrismaClient;
  readonly queue: JobQueue;
  readonly handlers: readonly JobHandler[];
  readonly leaseMs?: number | undefined;
  readonly heartbeatMs?: number | undefined;
  readonly pollIntervalMs?: number | undefined;
  readonly shutdownGraceMs?: number | undefined;
  readonly reaperIntervalMs?: number | undefined;
  readonly log?: LogFn | undefined;
}

export interface Runner {
  start(): void;
  stop(): Promise<void>;
  /** One reap-if-due plus one claim. Deterministic for tests. */
  runOnce(): Promise<"idle" | "handled">;
  runReaper(): Promise<number>;
}

export interface RunnerDefaults {
  readonly leaseMs: number;
  readonly heartbeatMs: number;
  readonly pollIntervalMs: number;
  readonly shutdownGraceMs: number;
  readonly reaperIntervalMs: number;
}

/** The approved defaults (`climate-data-foundation.md` §8.3). */
export const RUNNER_DEFAULTS: RunnerDefaults = {
  leaseMs: 60_000,
  heartbeatMs: 20_000,
  pollIntervalMs: 1_000,
  shutdownGraceMs: 20_000,
  reaperIntervalMs: 30_000,
};

export function createRunner(options: RunnerOptions): Runner {
  const {
    db,
    queue,
    handlers,
    leaseMs = RUNNER_DEFAULTS.leaseMs,
    heartbeatMs = RUNNER_DEFAULTS.heartbeatMs,
    pollIntervalMs = RUNNER_DEFAULTS.pollIntervalMs,
    shutdownGraceMs = RUNNER_DEFAULTS.shutdownGraceMs,
    reaperIntervalMs = RUNNER_DEFAULTS.reaperIntervalMs,
    log = jsonLogger,
  } = options;

  const byKind = new Map<JobKind, JobHandler>(handlers.map((handler) => [handler.kind, handler]));
  const kinds = [...byKind.keys()];

  let stopped = false;
  let loopRunning = false;
  let lastReapAt = 0;
  let currentJobId: string | null = null;
  const controllers = new Map<string, AbortController>();
  const wakeups: Array<() => void> = [];

  function pause(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      wakeups.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  function wakeAll(): void {
    while (wakeups.length > 0) wakeups.pop()?.();
  }

  function toJobError(error: unknown, code = "handler_error"): JobError {
    const message = error instanceof Error ? error.message : String(error);
    return { code, message, retryable: true };
  }

  async function failTerminal(
    job: ClaimedJob,
    error: JobError,
    execution: IngestionExecution | null,
  ): Promise<void> {
    await db.$transaction(async (tx) => {
      if (execution !== null) {
        await markIngestionStatus(tx, {
          runId: execution.runId,
          to: "failed",
          error: { code: error.code, message: error.message },
        });
      }
      const owned = await queue.fail(job, error, { terminal: true }, tx);
      if (!owned) throw new LeaseLostError();
    });
  }

  async function settle(
    job: ClaimedJob,
    result: HandlerResult,
    execution: IngestionExecution | null,
  ): Promise<void> {
    if (result.outcome === "succeeded") {
      const to = result.ingestionStatus ?? "succeeded";
      await db.$transaction(async (tx) => {
        if (execution !== null) {
          await markIngestionStatus(tx, {
            runId: execution.runId,
            to,
            recordCount: result.recordCount ?? 0,
            coveragePercent: result.coveragePercent ?? 0,
          });
        }
        const owned = await queue.succeed(job, tx);
        if (!owned) throw new LeaseLostError();
      });
      log("job_succeeded", { jobId: job.id, kind: job.kind, ingestionStatus: to });
      return;
    }

    if (result.outcome === "terminal") {
      await failTerminal(job, result.error, execution);
      log("job_dead", { jobId: job.id, kind: job.kind, code: result.error.code });
      return;
    }

    if (job.attempt >= job.maxAttempts) {
      // The retry budget is spent. This is the *only* path that turns a
      // retryable failure into a dead job, and it does so together with failing
      // the run — the alternative leaves a `running` IngestionRun that nothing
      // will ever finish.
      log("retry_exhausted", { jobId: job.id, attempt: job.attempt });
      await failTerminal(job, result.error, execution);
      log("job_dead", { jobId: job.id, kind: job.kind, code: result.error.code });
      return;
    }

    const retryAfterMs = retryDelayMsFor(job.attempt);
    await db.$transaction(async (tx) => {
      const owned = await queue.fail(job, result.error, { retryable: true, retryAfterMs }, tx);
      if (!owned) throw new LeaseLostError();
    });
    log("job_retry_scheduled", {
      jobId: job.id,
      attempt: job.attempt,
      retryAfterMs,
      code: result.error.code,
    });
  }

  async function execute(job: ClaimedJob): Promise<void> {
    const handler = byKind.get(job.kind);
    if (handler === undefined) {
      log("job_unhandled", { jobId: job.id, kind: job.kind });
      return;
    }

    const controller = new AbortController();
    controllers.set(job.id, controller);
    currentJobId = job.id;

    // The heartbeat renews while the handler works. A failed renewal means the
    // lease is gone: abort, and let the settle path discover the loss rather
    // than writing a result nobody owns.
    const beat = setInterval(() => {
      void queue
        .renew(job, leaseMs)
        .then((owned) => {
          if (!owned) {
            log("lease_lost", { jobId: job.id });
            controller.abort();
          }
        })
        .catch((error: unknown) => {
          log("heartbeat_error", { jobId: job.id, message: toJobError(error).message });
        });
    }, heartbeatMs);

    let execution: IngestionExecution | null = null;

    try {
      if (handler.opensIngestionRun) {
        const parsed = ingestionJobPayloadSchema.safeParse(job.payload);
        if (!parsed.success) {
          await failTerminal(
            job,
            {
              code: "payload_invalid",
              message: "the job payload does not satisfy ingestionJobPayloadSchema",
              retryable: false,
            },
            null,
          );
          log("job_dead", { jobId: job.id, kind: job.kind, code: "payload_invalid" });
          return;
        }
        execution = await beginIngestionExecution(db, {
          jobId: job.id,
          leaseToken: job.leaseToken,
          ...parsed.data,
        });
      }

      const result = await handler.handle(job, {
        db,
        signal: controller.signal,
        log,
        execution,
      });
      await settle(job, result, execution);
    } catch (error) {
      if (error instanceof LeaseLostError) {
        log("lease_lost", { jobId: job.id });
        return;
      }
      if (error instanceof IngestionAlreadyOwnedError) {
        // Another running job owns this run. Neither job is ours to finish now:
        // leave both alone and let the reaper settle the abandoned lease.
        log("ingestion_already_owned", { jobId: job.id });
        return;
      }
      if (error instanceof IngestionTerminalError) {
        log("ingestion_terminal", { jobId: job.id, status: error.status });
        return;
      }
      if (error instanceof InvariantViolationError || isCheckViolation(error)) {
        await failTerminal(
          job,
          { ...toJobError(error, "invariant_violation"), retryable: false },
          execution,
        );
        log("job_dead", { jobId: job.id, kind: job.kind, code: "invariant_violation" });
        return;
      }
      // Unknown failure: retryable, but never beyond the attempt budget — the
      // settle path turns the last attempt into a dead job and a failed run.
      log("handler_error", { jobId: job.id, message: toJobError(error).message });
      await settle(job, { outcome: "retryable", error: toJobError(error) }, execution);
    } finally {
      clearInterval(beat);
      controllers.delete(job.id);
      if (currentJobId === job.id) currentJobId = null;
    }
  }

  async function runReaper(): Promise<number> {
    lastReapAt = Date.now();
    const reaped = await queue.reapExpired();
    if (reaped.length > 0) {
      log("reaper_pass", {
        count: reaped.length,
        dead: reaped.filter((row) => row.status === "dead").length,
      });
    }
    return reaped.length;
  }

  async function runOnce(): Promise<"idle" | "handled"> {
    if (stopped) return "idle";

    // Reaping is time-driven, not claim-driven: an empty queue still needs old
    // leases recovered, and a quiet worker is exactly when nobody notices.
    if (Date.now() - lastReapAt >= reaperIntervalMs) {
      await runReaper();
    }

    if (kinds.length === 0) return "idle";

    const job = await queue.claim({ leaseMs, kinds });
    if (job === null) return "idle";

    // SIGTERM can land while the claim is in flight. The handler has not begun,
    // so releasing is safe and correct; executing here would start work that the
    // shutdown path is no longer waiting for.
    if (stopped) {
      await queue.release(job);
      log("claim_abandoned", { jobId: job.id, kind: job.kind });
      return "idle";
    }

    log("job_claimed", { jobId: job.id, kind: job.kind, attempt: job.attempt });
    await execute(job);
    return "handled";
  }

  async function loop(): Promise<void> {
    loopRunning = true;
    try {
      while (!stopped) {
        try {
          const outcome = await runOnce();
          if (outcome === "idle") await pause(pollIntervalMs);
        } catch (error) {
          log("loop_error", { message: toJobError(error).message });
          await pause(pollIntervalMs);
        }
      }
    } finally {
      loopRunning = false;
    }
  }

  async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;
    wakeAll();
    log("shutdown_started", { inFlight: controllers.size });

    // Cancellation is cooperative, so the wait is bounded rather than
    // guaranteed. After the grace period the job is deliberately *not*
    // released: the handler may still be writing, and handing the row to
    // another worker would make the duplicate work real instead of merely
    // possible. The lease expires and the reaper recovers it.
    for (const controller of controllers.values()) controller.abort();

    const deadline = Date.now() + shutdownGraceMs;
    while (controllers.size > 0 && Date.now() < deadline) {
      await pause(50);
    }

    if (controllers.size > 0) {
      log("shutdown_forced", { inFlight: controllers.size, currentJobId });
    } else {
      log("shutdown_complete", {});
    }
  }

  return {
    start(): void {
      if (loopRunning) return;
      stopped = false;
      void loop();
    },
    stop,
    runOnce,
    runReaper,
  };
}
