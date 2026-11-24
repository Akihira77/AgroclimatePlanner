/**
 * A lease cannot be renewed while the job row is locked — Phase 5.7A corrective
 * follow-up.
 *
 * `lockJobForSettlement` takes `SELECT ... FOR UPDATE` on `app.jobs`, and the
 * aggregate handler holds it from the top of its single transaction to commit.
 * `renew()` is a plain `UPDATE app.jobs` on that same row, so a separate pooled
 * connection buys nothing: PostgreSQL row locks are per row, not per session.
 *
 * These two cases pin down what that means, because the earlier lease analysis
 * claimed the opposite ("renewals run on their own connection while the
 * transaction is open"):
 *
 * 1. the renewal waits for the transaction;
 * 2. when it finally runs, its own guard is evaluated at *that* moment, so a
 *    lease that lapsed during the wait is refused rather than resurrected.
 *
 * Together they say a long transaction is bounded by the lease it was handed,
 * not by a renewable one. `OUTLOOK_LEASE_HEADROOM_MS` is the consequence.
 *
 * Run: pnpm --filter @agroclimate/worker test:integration
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, it } from "node:test";

import { createPrismaClient, lockJobForSettlement } from "@agroclimate/database";

import { createPostgresQueue } from "../../dist/queue/postgres.js";
import { roleConnectionString } from "../../../../packages/database/scripts/lib/connections.mjs";

const system = createPrismaClient({ connectionString: roleConnectionString("app_system") });
const queue = createPostgresQueue({ db: system, defaultMaxAttempts: 1 });

const token = randomUUID().slice(0, 8);

let jobCounter = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Leave exactly one runnable job of ours, so `claim` cannot pick a stray one. */
async function enqueueOnly() {
  jobCounter += 1;
  const job = await queue.enqueue({
    kind: "aggregate",
    idempotencyKey: `lease:${token}:${jobCounter}`,
    payload: { probe: token },
  });
  await system.$executeRaw`
    DELETE FROM app.jobs
     WHERE kind = 'aggregate'
       AND status = 'queued'
       AND id <> ${job.id}::uuid
       AND idempotency_key LIKE ${`lease:${token}:%`}
  `;
  return job;
}

/**
 * Lock the job row in a transaction and keep it locked until released.
 *
 * `locked` resolves once the row is genuinely held, so the caller never races
 * the lock acquisition.
 */
async function holdJobRow(jobId) {
  let markLocked;
  let release;
  const locked = new Promise((resolve) => {
    markLocked = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });

  const done = system.$transaction(
    async (tx) => {
      await lockJobForSettlement(tx, jobId);
      markLocked();
      await gate;
    },
    { timeout: 30_000, maxWait: 10_000 },
  );

  await locked;
  return {
    release: async () => {
      release();
      await done;
    },
  };
}

async function leaseExpiresAt(jobId) {
  const [row] = await system.$queryRaw`
    SELECT lease_expires_at AS "leaseExpiresAt" FROM app.jobs WHERE id = ${jobId}::uuid
  `;
  return row.leaseExpiresAt;
}

/** `true` when the promise settled within the window. */
function settlesWithin(promise, ms) {
  return Promise.race([promise.then(() => true), sleep(ms).then(() => false)]);
}

after(async () => {
  await system.$executeRaw`
    DELETE FROM app.jobs WHERE kind = 'aggregate' AND idempotency_key LIKE ${`lease:${token}:%`}
  `;
  await system.$disconnect();
});

describe("job lease — renewal against a locked job row", () => {
  it("cannot renew while the row is locked, and does not extend it meanwhile", async () => {
    const enqueued = await enqueueOnly();
    const claimed = await queue.claim({ leaseMs: 5_000, kinds: ["aggregate"] });
    assert.equal(claimed?.id, enqueued.id);
    assert.ok(claimed !== null);

    const held = await holdJobRow(claimed.id);

    const renewal = queue.renew(claimed, 5_000);
    assert.equal(
      await settlesWithin(renewal, 300),
      false,
      "the renewal must wait for the row lock, not run beside it",
    );

    // MVCC reads the committed version, so these see the pre-renewal value even
    // though the transaction is open.
    const before = await leaseExpiresAt(claimed.id);
    await sleep(100);
    assert.deepEqual(await leaseExpiresAt(claimed.id), before, "no extension while blocked");

    await held.release();
    assert.equal(await renewal, true, "the renewal runs once the lock is released");
    assert.ok(
      (await leaseExpiresAt(claimed.id)) > before,
      "the extension only lands after the transaction ends",
    );
  });

  it("cannot extend a lease from inside a blocked transaction", async () => {
    const enqueued = await enqueueOnly();
    const claimed = await queue.claim({ leaseMs: 1_500, kinds: ["aggregate"] });
    assert.equal(claimed?.id, enqueued.id);
    assert.ok(claimed !== null);

    const held = await holdJobRow(claimed.id);

    // Started while the lease is still live, so the row matches the renewal's
    // guard and the UPDATE must lock it — i.e. it waits, as it does in the
    // handler. The wait then outlives both the old lease and the new term.
    const startedAt = Date.now();
    const renewal = queue.renew(claimed, 1_000);
    assert.equal(await settlesWithin(renewal, 300), false, "still waiting on the lock");
    await sleep(1_800);
    await held.release();

    assert.equal(await renewal, true, "the row still matched the guard when the recheck ran");

    // The bound that makes `OUTLOOK_LEASE_HEADROOM_MS` necessary: an UPDATE
    // projects its target list before it waits, so the term is `start + leaseMs`
    // however long the wait was — never `grant + leaseMs`. Here that term ended
    // before it could be used, which is exactly why a long transaction must fit
    // inside the lease it was handed.
    const [row] = await system.$queryRaw`
      SELECT lease_expires_at AS "leaseExpiresAt" FROM app.jobs WHERE id = ${claimed.id}::uuid
    `;
    assert.ok(
      row.leaseExpiresAt.getTime() <= startedAt + 1_000 + 250,
      `renewal extended past start + leaseMs: ${row.leaseExpiresAt.toISOString()}`,
    );
  });
});
