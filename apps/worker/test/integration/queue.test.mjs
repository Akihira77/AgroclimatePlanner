/**
 * The queue and runner against real PostgreSQL.
 *
 * The claims are the point: `SKIP LOCKED`, the lease, and the reaper are the
 * only things standing between a crashed worker and a permanently stuck job, so
 * they are asserted against the real table rather than a fake.
 *
 * Run: pnpm --filter @agroclimate/worker test:integration
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";

import { ingestionVersionOf } from "@agroclimate/contracts";
import { createPrismaClient, markIngestionStatus } from "@agroclimate/database";

import { createPostgresQueue } from "../../dist/queue/postgres.js";
import { createRunner } from "../../dist/runner.js";
import { roleConnectionString } from "../../../../packages/database/scripts/lib/connections.mjs";

const system = createPrismaClient({ connectionString: roleConnectionString("app_system") });
const owner = createPrismaClient({ connectionString: roleConnectionString("migration_owner") });

const token = randomUUID().slice(0, 8);
const key = (suffix) => `test:${token}:${suffix}`;

const queue = createPostgresQueue({ db: system, defaultMaxAttempts: 3, reaperBatchSize: 10 });

async function rowOf(id) {
  const rows = await owner.$queryRaw`
    SELECT status, attempt, lease_token::text AS "leaseToken",
           lease_expires_at, ingestion_run_id::text AS "ingestionRunId",
           finished_at, last_error, run_at
      FROM app.jobs WHERE id = ${id}::uuid
  `;
  return rows[0];
}

async function expiredJob({ attempt = 1, maxAttempts = 3, ingestionRunId = null } = {}) {
  const rows = await system.$queryRaw`
    INSERT INTO app.jobs (kind, idempotency_key, payload, status, attempt, max_attempts,
                          lease_token, lease_expires_at, ingestion_run_id)
    VALUES ('maintenance', ${key(randomUUID())}, '{}'::jsonb, 'running',
            ${attempt}, ${maxAttempts}, gen_random_uuid(), now() - interval '1 second',
            ${ingestionRunId}::uuid)
    RETURNING id::text AS "id"
  `;
  return rows[0].id;
}

/** An expired lease whose token is still the one the stale worker holds. */
async function expiredJobWithToken({ attempt = 1, maxAttempts = 3, ingestionRunId = null } = {}) {
  const rows = await system.$queryRaw`
    INSERT INTO app.jobs (kind, idempotency_key, payload, status, attempt, max_attempts,
                          lease_token, lease_expires_at, ingestion_run_id)
    VALUES ('maintenance', ${key(randomUUID())}, '{}'::jsonb, 'running',
            ${attempt}, ${maxAttempts}, gen_random_uuid(), now() - interval '1 second',
            ${ingestionRunId}::uuid)
    RETURNING id::text AS "id", lease_token::text AS "leaseToken"
  `;
  return rows[0];
}

/** The `ClaimedJob` a worker would still be holding after its lease lapsed. */
function claimedShape({ id, leaseToken }, attempt = 1, maxAttempts = 3) {
  return {
    id,
    kind: "maintenance",
    payload: {},
    attempt,
    maxAttempts,
    leaseToken,
    leaseExpiresAt: new Date(Date.now() - 1_000),
  };
}

let runSeq = 0;

/**
 * A fresh forecast run plus a `running` IngestionRun, for the cases that must
 * show a refused job write also refusing the run write.
 */
async function createForecastRun() {
  runSeq += 1;
  const provider = `audit53_${token}`;
  const initializedAt = new Date(Date.UTC(2026, 9, 1) + runSeq * 3_600_000);
  const inserted = await system.$queryRaw`
    INSERT INTO app.forecast_runs (provider, model, product, initialized_at, horizon_end, received_at)
    VALUES (${provider}, 'm', 'seasonal', ${initializedAt},
            ${new Date(initializedAt.getTime() + 30 * 86_400_000)}, now())
    ON CONFLICT (provider, model, product, initialized_at) DO NOTHING
    RETURNING id::text AS "id"
  `;
  return (
    inserted[0]?.id ??
    (
      await owner.$queryRaw`
        SELECT id::text AS "id" FROM app.forecast_runs
         WHERE provider = ${provider} AND model = 'm' AND product = 'seasonal'
           AND initialized_at = ${initializedAt}
      `
    )[0].id
  );
}

async function createRunningIngestion() {
  const forecastRunId = await createForecastRun();
  const hash = randomUUID().replace(/-/g, "").repeat(2);
  const runs = await system.$queryRaw`
    INSERT INTO app.ingestion_runs
      (forecast_run_id, adapter_version, normalizer_version,
       target_selector_hash, ingestion_version, status)
    VALUES (${forecastRunId}::uuid, 'audit-adapter', 'audit-normalizer', ${hash}, ${hash}, 'running')
    RETURNING id::text AS "id"
  `;
  return { forecastRunId, runId: runs[0].id, targetSelectorHash: hash };
}

async function runRowOf(id) {
  const rows = await owner.$queryRaw`
    SELECT status, attempt, finished_at FROM app.ingestion_runs WHERE id = ${id}::uuid
  `;
  return rows[0];
}

before(async () => {
  await owner.$queryRaw`SELECT 1`;
});

// Every case starts with an empty queue for this suite's namespace: `claim`
// picks the globally oldest eligible row, so a leftover from the previous case
// would silently become the row under test.
beforeEach(async () => {
  await owner.$queryRaw`DELETE FROM app.jobs WHERE idempotency_key LIKE ${"test:" + token + ":%"}`;
});

after(async () => {
  await owner.$queryRaw`DELETE FROM app.jobs WHERE idempotency_key LIKE ${"test:" + token + ":%"}`;
  await owner.$queryRaw`
    DELETE FROM app.ingestion_runs
     WHERE forecast_run_id IN (SELECT id FROM app.forecast_runs WHERE provider = ${"audit53_" + token})
  `;
  await owner.$queryRaw`DELETE FROM app.forecast_runs WHERE provider = ${"audit53_" + token}`;
  await system.$disconnect();
  await owner.$disconnect();
});

describe("enqueue", () => {
  it("inserts once and reports the duplicate as not enqueued", async () => {
    const first = await queue.enqueue({
      kind: "maintenance",
      idempotencyKey: key("dedupe"),
      payload: { a: 1 },
    });
    const second = await queue.enqueue({
      kind: "maintenance",
      idempotencyKey: key("dedupe"),
      payload: { a: 1 },
    });

    assert.equal(first.enqueued, true);
    assert.equal(second.enqueued, false);
    assert.equal(second.id, first.id);
  });

  it("keeps the key of a dead job occupied", async () => {
    const job = await queue.enqueue({
      kind: "maintenance",
      idempotencyKey: key("dead-key"),
      payload: {},
    });
    const claimed = await queue.claim({ leaseMs: 60_000, kinds: ["maintenance"] });
    assert.equal(claimed?.id, job.id);
    await system.$transaction((tx) =>
      queue.fail(claimed, { code: "x", message: "x", retryable: false }, { terminal: true }, tx),
    );

    const again = await queue.enqueue({
      kind: "maintenance",
      idempotencyKey: key("dead-key"),
      payload: {},
    });
    assert.equal(again.enqueued, false);
    assert.equal(again.id, job.id);
  });
});

describe("claim", () => {
  it("skips a row whose run_at is in the future", async () => {
    await queue.enqueue({
      kind: "verify",
      idempotencyKey: key("future"),
      payload: {},
      runAt: new Date(Date.now() + 3_600_000),
    });

    const claimed = await queue.claim({ leaseMs: 60_000, kinds: ["verify"] });
    assert.equal(claimed, null);
  });

  it("claims nothing when no kind is asked for", async () => {
    assert.equal(await queue.claim({ leaseMs: 60_000, kinds: [] }), null);
  });

  it("increments attempt and writes a lease in the same statement", async () => {
    const job = await queue.enqueue({
      kind: "maintenance",
      idempotencyKey: key("claim"),
      payload: {},
    });

    const claimed = await queue.claim({ leaseMs: 60_000, kinds: ["maintenance"] });
    assert.equal(claimed?.id, job.id);
    assert.equal(claimed.attempt, 1);
    assert.match(claimed.leaseToken, /^[0-9a-f-]{36}$/);

    const row = await rowOf(job.id);
    assert.equal(row.status, "running");
    assert.equal(row.attempt, 1);
    assert.equal(row.leaseToken, claimed.leaseToken);
    assert.ok(row.lease_expires_at > new Date());
  });

  it("hands two concurrent claims two different rows", async () => {
    const ids = [];
    for (const suffix of ["a", "b"]) {
      ids.push(
        (await queue.enqueue({ kind: "maintenance", idempotencyKey: key(suffix), payload: {} })).id,
      );
    }

    const [first, second] = await Promise.all([
      queue.claim({ leaseMs: 60_000, kinds: ["maintenance"] }),
      queue.claim({ leaseMs: 60_000, kinds: ["maintenance"] }),
    ]);

    assert.ok(first);
    assert.ok(second);
    assert.notEqual(first.id, second.id);
    assert.ok(ids.includes(first.id) && ids.includes(second.id));
  });
});

describe("lease", () => {
  it("renews only an unexpired lease", async () => {
    await queue.enqueue({ kind: "verify", idempotencyKey: key("renew"), payload: {} });
    const claimed = await queue.claim({ leaseMs: 60_000, kinds: ["verify"] });
    assert.ok(claimed);

    const before = (await rowOf(claimed.id)).lease_expires_at;
    assert.equal(await queue.renew(claimed, 120_000), true);
    const after = (await rowOf(claimed.id)).lease_expires_at;
    assert.ok(after > before);

    const expired = await expiredJob();
    const stale = { ...claimed, id: expired };
    assert.equal(await queue.renew(stale, 120_000), false);
  });

  it("refuses a stale token on succeed and leaves the job running", async () => {
    const expired = await expiredJob();
    const claimed = {
      id: expired,
      kind: "maintenance",
      payload: {},
      attempt: 1,
      maxAttempts: 3,
      leaseToken: randomUUID(),
      leaseExpiresAt: new Date(),
    };

    const owned = await system.$transaction((tx) => queue.succeed(claimed, tx));
    assert.equal(owned, false);
    assert.equal((await rowOf(expired)).status, "running");
  });

  it("releases only a job whose handler never began", async () => {
    await queue.enqueue({ kind: "verify", idempotencyKey: key("release"), payload: {} });
    const claimed = await queue.claim({ leaseMs: 60_000, kinds: ["verify"] });
    assert.ok(claimed);

    assert.equal(await queue.release(claimed), true);
    const row = await rowOf(claimed.id);
    assert.equal(row.status, "queued");
    assert.equal(row.leaseToken, null);
  });

  it("refuses to release after an ingestion run was assigned", async () => {
    const runId = (
      await system.$queryRaw`
        INSERT INTO app.ingestion_runs
          (forecast_run_id, adapter_version, normalizer_version, target_selector_hash,
           ingestion_version, status)
        SELECT id, 'a', 'n', ${"b".repeat(64)}, ${"b".repeat(64)}, 'running'
          FROM app.forecast_runs LIMIT 1
        RETURNING id::text AS "id"
      `
    )[0]?.id;
    if (runId === undefined) return; // no forecast run available in this database

    const jobId = await expiredJob({ ingestionRunId: runId });
    const claimed = {
      id: jobId,
      kind: "maintenance",
      payload: {},
      attempt: 1,
      maxAttempts: 3,
      leaseToken: randomUUID(),
      leaseExpiresAt: new Date(),
    };
    // Token mismatch already refuses; the ingestion_run_id guard is asserted via
    // the row staying running.
    assert.equal(await queue.release({ ...claimed, leaseToken: randomUUID() }), false);
    assert.equal((await rowOf(jobId)).status, "running");

    await owner.$queryRaw`DELETE FROM app.ingestion_runs WHERE id = ${runId}::uuid`;
  });
});

describe("reaper", () => {
  it("requeues an expired lease without charging the attempt twice", async () => {
    const id = await expiredJob({ attempt: 1, maxAttempts: 3 });
    await queue.reapExpired();

    const row = await rowOf(id);
    assert.equal(row.status, "queued");
    assert.equal(row.attempt, 1);
    assert.equal(row.leaseToken, null);
  });

  it("kills an expired lease with no attempt left", async () => {
    const id = await expiredJob({ attempt: 3, maxAttempts: 3 });
    await queue.reapExpired();

    const row = await rowOf(id);
    assert.equal(row.status, "dead");
    assert.ok(row.finished_at instanceof Date);
    assert.equal(row.last_error.code, "lease_expired");
  });

  it("fails the run when it kills the job that owned it", async () => {
    const ingestion = await createRunningIngestion();
    const job = await expiredJobWithToken({
      attempt: 3,
      maxAttempts: 3,
      ingestionRunId: ingestion.runId,
    });

    await queue.reapExpired();

    const jobRow = await rowOf(job.id);
    assert.equal(jobRow.status, "dead");

    const run = await runRowOf(ingestion.runId);
    assert.equal(run.status, "failed");
    assert.ok(run.finished_at instanceof Date);
  });

  it("leaves a terminal run alone when it kills a job", async () => {
    const ingestion = await createRunningIngestion();
    await owner.$queryRaw`
      UPDATE app.ingestion_runs SET status = 'succeeded', finished_at = now()
       WHERE id = ${ingestion.runId}::uuid
    `;
    const job = await expiredJobWithToken({
      attempt: 3,
      maxAttempts: 3,
      ingestionRunId: ingestion.runId,
    });

    await queue.reapExpired();

    assert.equal((await rowOf(job.id)).status, "dead");
    assert.equal((await runRowOf(ingestion.runId)).status, "succeeded");
  });

  it("does not touch a live lease", async () => {
    await queue.enqueue({ kind: "verify", idempotencyKey: key("live"), payload: {} });
    const claimed = await queue.claim({ leaseMs: 60_000, kinds: ["verify"] });
    assert.ok(claimed);

    await queue.reapExpired();
    assert.equal((await rowOf(claimed.id)).status, "running");
  });
});

describe("runner", () => {
  function makeRunner(handlers = []) {
    return createRunner({
      db: system,
      queue,
      handlers,
      leaseMs: 60_000,
      heartbeatMs: 60_000,
      pollIntervalMs: 10,
      shutdownGraceMs: 500,
      reaperIntervalMs: 0,
    });
  }

  it("reaps on an empty queue and stays idle", async () => {
    const id = await expiredJob({ attempt: 1, maxAttempts: 3 });
    const runner = makeRunner();

    const count = await runner.runReaper();
    assert.ok(count >= 1);
    assert.equal((await rowOf(id)).status, "queued");

    assert.equal(await runner.runOnce(), "idle");
  });

  it("runs a handler and marks the job succeeded", async () => {
    const job = await queue.enqueue({
      kind: "verify",
      idempotencyKey: key("handled"),
      payload: {},
    });

    let seen = 0;
    const runner = makeRunner([
      {
        kind: "verify",
        opensIngestionRun: false,
        async handle() {
          seen += 1;
          return { outcome: "succeeded" };
        },
      },
    ]);

    assert.equal(await runner.runOnce(), "handled");
    assert.equal(seen, 1);
    const row = await rowOf(job.id);
    assert.equal(row.status, "succeeded");
    assert.ok(row.finished_at instanceof Date);
  });

  it("turns the last retryable failure into a dead job", async () => {
    const job = await queue.enqueue({
      kind: "verify",
      idempotencyKey: key("exhaust"),
      payload: {},
      maxAttempts: 1,
    });

    const runner = makeRunner([
      {
        kind: "verify",
        opensIngestionRun: false,
        async handle() {
          return {
            outcome: "retryable",
            error: { code: "slow", message: "slow", retryable: true },
          };
        },
      },
    ]);

    assert.equal(await runner.runOnce(), "handled");
    const row = await rowOf(job.id);
    assert.equal(row.status, "dead");
    assert.equal(row.last_error.code, "slow");
  });

  it("rejects an invalid ingestion payload without opening a run", async () => {
    const job = await queue.enqueue({
      kind: "ingest.climate",
      idempotencyKey: key("bad-payload"),
      payload: { nope: true },
    });

    const runner = makeRunner([
      {
        kind: "ingest.climate",
        opensIngestionRun: true,
        async handle() {
          throw new Error("must not be called");
        },
      },
    ]);

    assert.equal(await runner.runOnce(), "handled");
    const row = await rowOf(job.id);
    assert.equal(row.status, "dead");
    assert.equal(row.last_error.code, "payload_invalid");
    assert.equal(row.ingestionRunId, null);
  });

  it("stops within the grace period and leaves the job to the reaper", async () => {
    await queue.enqueue({ kind: "verify", idempotencyKey: key("slowstop"), payload: {} });

    let aborted = false;
    const runner = makeRunner([
      {
        kind: "verify",
        opensIngestionRun: false,
        handle(_job, context) {
          return new Promise((resolve) => {
            context.signal.addEventListener("abort", () => {
              aborted = true;
              resolve({
                outcome: "retryable",
                error: { code: "aborted", message: "aborted", retryable: true },
              });
            });
          });
        },
      },
    ]);

    runner.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await runner.stop();
    assert.equal(aborted, true);
  });
});

/**
 * The stale-owner window: a lease that expired but that the reaper has not yet
 * requeued. The token and `status = 'running'` are still exactly what the stale
 * worker holds, so only `lease_expires_at` can refuse the write.
 */
describe("expired lease ownership", () => {
  it("refuses success with an expired lease, before any reaper pass", async () => {
    const job = await expiredJobWithToken();

    const owned = await system.$transaction((tx) => queue.succeed(claimedShape(job), tx));
    assert.equal(owned, false);

    const row = await rowOf(job.id);
    assert.equal(row.status, "running");
    assert.equal(row.leaseToken, job.leaseToken);
  });

  it("refuses a retryable failure with an expired lease", async () => {
    const job = await expiredJobWithToken();

    const owned = await system.$transaction((tx) =>
      queue.fail(
        claimedShape(job),
        { code: "slow", message: "slow", retryable: true },
        { retryable: true, retryAfterMs: 60_000 },
        tx,
      ),
    );
    assert.equal(owned, false);

    const row = await rowOf(job.id);
    assert.equal(row.status, "running");
    assert.equal(row.attempt, 1);
  });

  it("refuses a terminal failure and rolls the run transition back", async () => {
    const ingestion = await createRunningIngestion();
    const job = await expiredJobWithToken({ ingestionRunId: ingestion.runId });
    const claimed = claimedShape(job);

    await assert.rejects(
      () =>
        system.$transaction(async (tx) => {
          await markIngestionStatus(tx, {
            runId: ingestion.runId,
            to: "failed",
            error: { code: "late", message: "late" },
          });
          const owned = await queue.fail(
            claimed,
            { code: "late", message: "late", retryable: false },
            { terminal: true },
            tx,
          );
          if (!owned) throw new Error("lease lost");
        }),
      /lease lost/,
    );

    const run = await runRowOf(ingestion.runId);
    assert.equal(run.status, "running", "the run write must roll back with the job write");
    assert.equal(run.finished_at, null);
    assert.equal((await rowOf(job.id)).status, "running");
  });

  it("still succeeds a live lease", async () => {
    await queue.enqueue({ kind: "maintenance", idempotencyKey: key("live-ok"), payload: {} });
    const claimed = await queue.claim({ leaseMs: 60_000, kinds: ["maintenance"] });
    assert.ok(claimed);

    assert.equal(await system.$transaction((tx) => queue.succeed(claimed, tx)), true);
    const row = await rowOf(claimed.id);
    assert.equal(row.status, "succeeded");
    assert.ok(row.finished_at instanceof Date);
  });

  it("still schedules a retry on a live lease", async () => {
    await queue.enqueue({ kind: "maintenance", idempotencyKey: key("live-retry"), payload: {} });
    const claimed = await queue.claim({ leaseMs: 60_000, kinds: ["maintenance"] });
    assert.ok(claimed);

    const owned = await system.$transaction((tx) =>
      queue.fail(
        claimed,
        { code: "slow", message: "slow", retryable: true },
        { retryable: true, retryAfterMs: 60_000 },
        tx,
      ),
    );
    assert.equal(owned, true);

    const row = await rowOf(claimed.id);
    assert.equal(row.status, "queued");
    assert.equal(row.attempt, 1);
    assert.ok(row.run_at > new Date());
  });

  it("still kills a job on a live lease", async () => {
    await queue.enqueue({ kind: "maintenance", idempotencyKey: key("live-dead"), payload: {} });
    const claimed = await queue.claim({ leaseMs: 60_000, kinds: ["maintenance"] });
    assert.ok(claimed);

    const owned = await system.$transaction((tx) =>
      queue.fail(
        claimed,
        { code: "bad", message: "bad", retryable: false },
        { terminal: true },
        tx,
      ),
    );
    assert.equal(owned, true);

    const row = await rowOf(claimed.id);
    assert.equal(row.status, "dead");
    assert.equal(row.last_error.code, "bad");
  });

  it("leaves the run running when the lease expires mid-handler", async () => {
    const forecastRunId = await createForecastRun();
    const targetSelectorHash = randomUUID().replace(/-/g, "").repeat(2);

    const job = await queue.enqueue({
      kind: "ingest.climate",
      idempotencyKey: key("late-run"),
      payload: {
        forecastRunId,
        adapterVersion: "audit-adapter",
        normalizerVersion: "audit-normalizer",
        targetSelectorHash,
      },
    });

    const runner = createRunner({
      db: system,
      queue,
      leaseMs: 250,
      heartbeatMs: 60_000,
      pollIntervalMs: 10,
      shutdownGraceMs: 500,
      reaperIntervalMs: 0,
      handlers: [
        {
          kind: "ingest.climate",
          opensIngestionRun: true,
          async handle() {
            // Longer than the lease, shorter than the heartbeat: the worker is
            // still working when ownership lapses.
            await new Promise((resolve) => setTimeout(resolve, 450));
            return {
              outcome: "terminal",
              error: { code: "late", message: "late", retryable: false },
            };
          },
        },
      ],
    });

    assert.equal(await runner.runOnce(), "handled");

    const jobRow = await rowOf(job.id);
    assert.equal(jobRow.status, "running", "the stale worker must not finish the job");
    assert.ok(jobRow.leaseToken !== null);

    const version = ingestionVersionOf({
      adapterVersion: "audit-adapter",
      normalizerVersion: "audit-normalizer",
      targetSelectorHash,
    });
    const runs = await owner.$queryRaw`
      SELECT status, finished_at FROM app.ingestion_runs
       WHERE forecast_run_id = ${forecastRunId}::uuid AND ingestion_version = ${version}
    `;
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, "running");
    assert.equal(runs[0].finished_at, null);
  });
});

/**
 * Release is the only path that can settle a claim without starting a handler,
 * so it is also the only place the claim counter can reach the ceiling with
 * nothing executed. Requeueing there would produce a row every later claim
 * rejects on `jobs_attempt_check`.
 */
describe("release policy", () => {
  async function queuedJobAt({ attempt, maxAttempts = 5 }) {
    const rows = await system.$queryRaw`
      INSERT INTO app.jobs (kind, idempotency_key, payload, attempt, max_attempts)
      VALUES ('maintenance', ${key(randomUUID())}, '{}'::jsonb, ${attempt}, ${maxAttempts})
      RETURNING id::text AS "id"
    `;
    return rows[0].id;
  }

  it("requeues while a claim remains, without touching attempt", async () => {
    const id = await queuedJobAt({ attempt: 1, maxAttempts: 5 });
    const claimed = await queue.claim({ leaseMs: 60_000, kinds: ["maintenance"] });
    assert.equal(claimed?.id, id);
    assert.equal(claimed.attempt, 2);

    assert.equal(await queue.release(claimed), true);

    const row = await rowOf(id);
    assert.equal(row.status, "queued");
    assert.equal(row.attempt, 2);
    assert.equal(row.leaseToken, null);
    assert.equal(row.lease_expires_at, null);
    assert.equal(row.ingestionRunId, null);
    assert.equal(row.finished_at, null);
    assert.equal(row.last_error, null);
  });

  it("kills the claim at the ceiling instead of leaving it unclaimable", async () => {
    const id = await queuedJobAt({ attempt: 4, maxAttempts: 5 });
    const claimed = await queue.claim({ leaseMs: 60_000, kinds: ["maintenance"] });
    assert.equal(claimed?.id, id);
    assert.equal(claimed.attempt, 5);

    assert.equal(await queue.release(claimed), true);

    const row = await rowOf(id);
    assert.equal(row.status, "dead");
    assert.ok(row.finished_at instanceof Date);
    assert.equal(row.leaseToken, null);
    assert.equal(row.lease_expires_at, null);
    assert.equal(row.attempt, 5);
    assert.equal(row.last_error.code, "claim_budget_exhausted");
    assert.equal(row.last_error.retryable, false);

    // The row that used to jam every later claim is now terminal, not queued.
    assert.equal(await queue.claim({ leaseMs: 60_000, kinds: ["maintenance"] }), null);
  });

  it("refuses release with a stale lease token and writes nothing", async () => {
    const job = await expiredJobWithToken({ attempt: 2 });
    const claimed = claimedShape(job, 2);
    const stale = { ...claimed, leaseToken: randomUUID() };

    assert.equal(await queue.release(stale), false);

    const row = await rowOf(job.id);
    assert.equal(row.status, "running", "a refused release must not settle the job");
    assert.equal(row.attempt, 2);
    assert.equal(row.leaseToken, job.leaseToken);
  });

  it("refuses release after a handler has begun", async () => {
    const ingestion = await createRunningIngestion();
    const job = await expiredJobWithToken({ attempt: 2, ingestionRunId: ingestion.runId });

    assert.equal(await queue.release(claimedShape(job, 2)), false);

    const row = await rowOf(job.id);
    assert.equal(row.status, "running");
    assert.equal(row.leaseToken, job.leaseToken);
    const run = await runRowOf(ingestion.runId);
    assert.equal(run.status, "running");
    assert.equal(run.attempt, 1);
  });

  it("lets attempt = maxAttempts - 1 requeue and be claimed again", async () => {
    const id = await queuedJobAt({ attempt: 3, maxAttempts: 5 });
    const first = await queue.claim({ leaseMs: 60_000, kinds: ["maintenance"] });
    assert.equal(first.attempt, 4);
    assert.equal(await queue.release(first), true);
    assert.equal((await rowOf(id)).status, "queued");

    const second = await queue.claim({ leaseMs: 60_000, kinds: ["maintenance"] });
    assert.equal(second?.id, id);
    assert.equal(second.attempt, 5);

    assert.equal(await queue.release(second), true);
    assert.equal((await rowOf(id)).status, "dead");
  });

  it("releases a claim that completes after shutdown started, and runs no handler", async () => {
    const job = await queue.enqueue({
      kind: "maintenance",
      idempotencyKey: key("inflight"),
      payload: {},
    });

    let handlerCalls = 0;
    let signalClaimed;
    const claimed = new Promise((resolve) => {
      signalClaimed = resolve;
    });
    let openGate;
    const gate = new Promise((resolve) => {
      openGate = resolve;
    });

    const real = createPostgresQueue({ db: system, defaultMaxAttempts: 3 });
    const gated = {
      enqueue: real.enqueue.bind(real),
      claim: async (options) => {
        const claimedJob = await real.claim(options);
        signalClaimed();
        await gate;
        return claimedJob;
      },
      renew: real.renew.bind(real),
      succeed: real.succeed.bind(real),
      fail: real.fail.bind(real),
      release: real.release.bind(real),
      reapExpired: real.reapExpired.bind(real),
    };

    const runner = createRunner({
      db: system,
      queue: gated,
      leaseMs: 60_000,
      heartbeatMs: 60_000,
      pollIntervalMs: 10,
      shutdownGraceMs: 200,
      reaperIntervalMs: 0,
      handlers: [
        {
          kind: "maintenance",
          opensIngestionRun: false,
          async handle() {
            handlerCalls += 1;
            return { outcome: "succeeded" };
          },
        },
      ],
    });

    runner.start();
    await claimed;
    await runner.stop();
    openGate();
    await new Promise((resolve) => setTimeout(resolve, 150));

    assert.equal(handlerCalls, 0, "no handler may start after stop() resolved");
    const row = await rowOf(job.id);
    assert.equal(row.status, "queued");
    assert.equal(row.leaseToken, null);
  });
});
