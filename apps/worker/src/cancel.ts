import { createPrismaClient } from "@agroclimate/database";

import { createPostgresQueue } from "./queue/postgres.js";
import { jsonLogger } from "./runner.js";

/**
 * Operator cancellation — `background-processing.md` §11.
 *
 * A job that has not started can be withdrawn; one that is running is refused.
 * The refusal is the design, not a missing feature: the handler may be
 * mid-transaction, and a second process has no way to interrupt it safely. That
 * job is bounded by its attempt budget, and a job whose process died is recovered
 * when its lease expires.
 *
 * Usage: `node dist/cancel.js <jobId>` with `APP_SYSTEM_DATABASE_URL` set.
 * Exit 0 = cancelled, 1 = refused or misconfigured, so a script can tell the two
 * apart without parsing the log line.
 */

const jobId = process.argv[2];
if (jobId === undefined || jobId.length === 0) {
  jsonLogger("usage_error", { message: "usage: node dist/cancel.js <jobId>" });
  process.exit(1);
}

const connectionString = process.env["APP_SYSTEM_DATABASE_URL"];
if (connectionString === undefined || connectionString.length === 0) {
  jsonLogger("config_error", { message: "APP_SYSTEM_DATABASE_URL is required" });
  process.exit(1);
}

const db = createPrismaClient({ connectionString });
const queue = createPostgresQueue({ db, defaultMaxAttempts: 5 });

try {
  const cancelled = await queue.cancel(jobId);

  if (cancelled) {
    jsonLogger("job_cancelled", { jobId });
    process.exitCode = 0;
  } else {
    // A refusal has three different remedies, so the log line names which one:
    // a typo is fixed by re-reading the id, a running job by waiting for the
    // budget or the reaper, and an already-cancelled row means the earlier run
    // did commit — re-running is not needed. The exit code stays 1 for all
    // three, because it answers one question: did this command stop the job?
    const row = await db.$queryRaw<{ status: string; hasRun: boolean }[]>`
      SELECT status, ingestion_run_id IS NOT NULL AS "hasRun"
        FROM app.jobs
       WHERE id = ${jobId}::uuid
    `;
    const current = row[0];
    // Status first: a settled row that once held a run is not a held run, and
    // saying so would send the operator to wait for a budget that is spent.
    const event =
      current === undefined
        ? "job_not_found"
        : current.status === "cancelled"
          ? "job_already_cancelled"
          : current.status !== "queued"
            ? "job_not_cancellable"
            : "job_holds_ingestion_run";
    jsonLogger(event, {
      jobId,
      status: current?.status,
      note:
        current === undefined
          ? "no job with that id"
          : current.status === "cancelled"
            ? "an earlier run did commit; nothing left to cancel"
            : current.status !== "queued"
              ? "already settled, or a handler owns the row"
              : "a retry is holding the IngestionRun its first attempt opened; cancelling would orphan it as running",
    });
    process.exitCode = 1;
  }
} catch (error) {
  // A malformed id reaches PostgreSQL as a cast failure. Reporting it as a usage
  // error is more useful than a stack trace, and it is not a database outage.
  jsonLogger("cancel_error", {
    jobId,
    message: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
