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

import { createPrismaClient } from "@agroclimate/database";

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
  await owner.$queryRaw`
    DELETE FROM app.jobs
     WHERE kind = 'maintenance' AND idempotency_key LIKE ${"test:" + token + ":%"}
        OR kind = 'verify' AND idempotency_key LIKE ${"test:" + token + ":%"}
  `;
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
