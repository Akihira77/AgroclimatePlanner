/**
 * The run lifecycle against real PostgreSQL and the real roles.
 *
 * `app.outlook_cells`-style globals: no RLS, so these cases assert identity,
 * constraint and transaction behaviour rather than tenant isolation. Every
 * write goes through `app_system`; the owner connection only reads back and
 * cleans up.
 *
 * Requires a migrated database and the roles from `pnpm db:bootstrap`.
 * Run: pnpm --filter @agroclimate/database test:integration
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { Client } from "pg";

import {
  beginIngestionExecution,
  createPrismaClient,
  IngestionAlreadyOwnedError,
  IngestionRunMissingError,
  IngestionTerminalError,
  InvariantViolationError,
  LeaseLostError,
  markIngestionStatus,
  upsertForecastRun,
} from "../../dist/index.js";
import { ingestionVersionOf, targetSelectorHashOf } from "@agroclimate/contracts";
import { roleConnectionString } from "../../scripts/lib/connections.mjs";

const owner = new Client({ connectionString: roleConnectionString("migration_owner") });
const system = createPrismaClient({ connectionString: roleConnectionString("app_system") });

/** Unique per run so a parallel suite cannot collide on a natural key. */
const token = randomUUID().slice(0, 8);
const provider = `phase53_${token}`;
const model = `model_${token}`;

const adapterVersion = "test-adapter@1.0.0";
const targetSelectorHash = targetSelectorHashOf({
  cells: [
    { cellKey: "0.00,0.00", variable: "precipitation" },
    { cellKey: "0.00,0.00", variable: "temperature" },
  ],
});

function runInput(offsetHours = 0) {
  const initializedAt = new Date(Date.UTC(2026, 10, 1, offsetHours));
  return {
    provider,
    model,
    product: "seasonal",
    initializedAt,
    horizonEnd: new Date(initializedAt.getTime() + 31 * 24 * 3600 * 1000),
    receivedAt: new Date(),
  };
}

async function createRunningJob({ attempt = 1, maxAttempts = 5, leaseMs = 60_000 } = {}) {
  const rows = await system.$queryRaw`
    INSERT INTO app.jobs (kind, idempotency_key, payload, status, attempt, max_attempts,
                          lease_token, lease_expires_at)
    VALUES ('ingest.climate', ${`job:${randomUUID()}`}, '{}'::jsonb, 'running',
            ${attempt}, ${maxAttempts}, gen_random_uuid(),
            now() + (${leaseMs}::int * interval '1 millisecond'))
    RETURNING id::text AS "id", lease_token::text AS "leaseToken"
  `;
  const row = rows[0];
  assert.ok(row);
  return { id: row.id, leaseToken: row.leaseToken };
}

async function runAttemptOf(forecastRunId) {
  const version = ingestionVersionOf({
    adapterVersion,
    normalizerVersion: "test-normalizer@1.0.0",
    targetSelectorHash,
  });
  const rows = await owner.query(
    "select attempt, status, started_at, finished_at from app.ingestion_runs where forecast_run_id = $1 and ingestion_version = $2",
    [forecastRunId, version],
  );
  return rows.rows[0];
}

async function begin(job, forecastRunId) {
  return beginIngestionExecution(system, {
    jobId: job.id,
    leaseToken: job.leaseToken,
    forecastRunId,
    adapterVersion,
    normalizerVersion: "test-normalizer@1.0.0",
    targetSelectorHash,
  });
}

before(async () => {
  await owner.connect();
});

after(async () => {
  await owner.query("delete from app.jobs where idempotency_key like 'job:%'");
  await owner.query("delete from app.ingestion_runs where target_selector_hash = $1", [
    targetSelectorHash,
  ]);
  await owner.query("delete from app.forecast_runs where provider = $1", [provider]);
  await owner.end();
  await system.$disconnect();
});

describe("upsertForecastRun", () => {
  it("returns one identity for repeated discovery of the same run", async () => {
    const first = await upsertForecastRun(system, runInput());
    const second = await upsertForecastRun(system, { ...runInput(), receivedAt: new Date() });
    assert.equal(second.id, first.id);
    assert.equal(second.receivedAt.getTime(), first.receivedAt.getTime());
  });

  it("keeps one identity when only model_version changes", async () => {
    const first = await upsertForecastRun(system, runInput(24));
    const second = await upsertForecastRun(system, { ...runInput(24), modelVersion: "v2" });
    assert.equal(second.id, first.id);
    assert.equal(second.modelVersion, null);
  });

  it("mints a different identity for a different initialized_at", async () => {
    const first = await upsertForecastRun(system, runInput(48));
    const second = await upsertForecastRun(system, runInput(72));
    assert.notEqual(second.id, first.id);
  });

  it("refuses a horizon that ends before it starts", async () => {
    const input = runInput(96);
    await assert.rejects(
      () => upsertForecastRun(system, { ...input, horizonEnd: input.initializedAt }),
      InvariantViolationError,
    );
  });

  it("never accepts an id from the caller", async () => {
    const run = await upsertForecastRun(system, runInput(120));
    assert.match(run.id, /^[0-9a-f-]{36}$/);
  });
});

describe("beginIngestionExecution", () => {
  it("creates the run on first execution and records attempt 1", async () => {
    const run = await upsertForecastRun(system, runInput(144));
    const job = await createRunningJob();
    const execution = await begin(job, run.id);

    assert.equal(execution.attempt, 1);
    const row = await runAttemptOf(run.id);
    assert.equal(row.attempt, 1);
    assert.equal(row.status, "running");
    assert.equal(row.finished_at, null);

    const linked = await owner.query("select ingestion_run_id from app.jobs where id = $1", [
      job.id,
    ]);
    assert.equal(linked.rows[0].ingestion_run_id, execution.runId);
  });

  it("increments attempt on a retry without touching started_at", async () => {
    const run = await upsertForecastRun(system, runInput(168));
    const firstJob = await createRunningJob();
    const first = await begin(firstJob, run.id);
    const before = await runAttemptOf(run.id);

    // A retry only happens after the previous execution stopped owning the run:
    // two running jobs on one IngestionRun is what jobs_active_ingestion_idx
    // forbids, so the first job must have gone terminal.
    await owner.query(
      "update app.jobs set status = 'dead', finished_at = now(), lease_token = null, lease_expires_at = null where id = $1",
      [firstJob.id],
    );

    const second = await begin(await createRunningJob(), run.id);
    const after = await runAttemptOf(run.id);

    assert.equal(second.runId, first.runId);
    assert.equal(after.attempt, 2);
    assert.equal(after.started_at.toISOString(), before.started_at.toISOString());
  });

  it("rejects a job whose lease token does not match, and rolls back the increment", async () => {
    const run = await upsertForecastRun(system, runInput(192));
    const job = await createRunningJob();
    await assert.rejects(
      () =>
        beginIngestionExecution(system, {
          jobId: job.id,
          leaseToken: randomUUID(),
          forecastRunId: run.id,
          adapterVersion,
          normalizerVersion: "test-normalizer@1.0.0",
          targetSelectorHash,
        }),
      LeaseLostError,
    );
    assert.equal(await runAttemptOf(run.id), undefined);
  });

  it("rejects an expired lease", async () => {
    const run = await upsertForecastRun(system, runInput(216));
    const job = await createRunningJob({ leaseMs: -1000 });
    await assert.rejects(() => begin(job, run.id), LeaseLostError);
    assert.equal(await runAttemptOf(run.id), undefined);
  });

  it("rejects a terminal run instead of restarting it", async () => {
    const run = await upsertForecastRun(system, runInput(240));
    const execution = await begin(await createRunningJob(), run.id);
    await system.$transaction((tx) =>
      markIngestionStatus(tx, { runId: execution.runId, to: "succeeded", recordCount: 3 }),
    );

    await assert.rejects(
      async () => begin(await createRunningJob(), run.id),
      IngestionTerminalError,
    );
    const row = await runAttemptOf(run.id);
    assert.equal(row.attempt, 1);
    assert.equal(row.status, "succeeded");
  });

  it("refuses a second job that tries to own a running IngestionRun", async () => {
    const run = await upsertForecastRun(system, runInput(264));
    const first = await createRunningJob();
    const second = await createRunningJob();

    const execution = await begin(first, run.id);
    await assert.rejects(() => begin(second, run.id), IngestionAlreadyOwnedError);

    const row = await runAttemptOf(run.id);
    assert.equal(row.attempt, 1, "the refused attempt must be rolled back");
    assert.equal(row.status, "running");

    const linked = await owner.query(
      "select count(*)::int as n from app.jobs where ingestion_run_id = $1",
      [execution.runId],
    );
    assert.equal(linked.rows[0].n, 1);
  });

  it("reports a missing run distinctly from a terminal one", async () => {
    const job = await createRunningJob();
    const version = ingestionVersionOf({
      adapterVersion,
      normalizerVersion: "test-normalizer@1.0.0",
      targetSelectorHash,
    });
    // Point at a forecast run that exists (FK) but has no ingestion row of this identity.
    const run = await upsertForecastRun(system, runInput(288));
    await owner.query("delete from app.ingestion_runs where forecast_run_id = $1", [run.id]);
    assert.ok(version);

    // The insert succeeds here, so this case cannot produce IngestionRunMissing;
    // the distinction is asserted through markIngestionStatus instead.
    const execution = await begin(job, run.id);
    await assert.rejects(
      () =>
        system.$transaction((tx) =>
          markIngestionStatus(tx, { runId: randomUUID(), to: "succeeded" }),
        ),
      IngestionRunMissingError,
    );
    assert.ok(execution.runId);
  });
});

describe("markIngestionStatus", () => {
  it("writes a terminal status with finished_at, and partial is terminal too", async () => {
    const run = await upsertForecastRun(system, runInput(312));
    const execution = await begin(await createRunningJob(), run.id);

    await system.$transaction((tx) =>
      markIngestionStatus(tx, {
        runId: execution.runId,
        to: "partial",
        recordCount: 2,
        coveragePercent: 40,
      }),
    );

    const row = await runAttemptOf(run.id);
    assert.equal(row.status, "partial");
    assert.ok(row.finished_at instanceof Date);

    await assert.rejects(
      () =>
        system.$transaction((tx) =>
          markIngestionStatus(tx, { runId: execution.runId, to: "succeeded" }),
        ),
      IngestionTerminalError,
    );
  });

  it("rejects coverage outside 0..100 before the statement runs", async () => {
    const run = await upsertForecastRun(system, runInput(336));
    const execution = await begin(await createRunningJob(), run.id);
    await assert.rejects(
      () =>
        system.$transaction((tx) =>
          markIngestionStatus(tx, {
            runId: execution.runId,
            to: "succeeded",
            coveragePercent: 101,
          }),
        ),
      InvariantViolationError,
    );
  });
});
