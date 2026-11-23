/**
 * Runner heartbeat vs settlement (F-04) against real PostgreSQL.
 *
 * The claim is a fake so renewal timing is controllable; the settlement writes
 * are real, because the defect being guarded against is a write that lands after
 * a terminal one. Every case asserts an ordering, not just an outcome.
 *
 * Run: pnpm --filter @agroclimate/worker test:integration
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { createPrismaClient } from "@agroclimate/database";

import { createRunner } from "../../dist/runner.js";
import { roleConnectionString } from "../../../../packages/database/scripts/lib/connections.mjs";

const system = createPrismaClient({ connectionString: roleConnectionString("app_system") });
const owner = createPrismaClient({ connectionString: roleConnectionString("migration_owner") });

const token = randomUUID().slice(0, 8);
const keyPrefix = `test:hb:${token}`;

let keyCounter = 0;

async function seedJob({ attempt = 1, maxAttempts = 3 } = {}) {
  keyCounter += 1;
  const rows = await owner.$queryRaw`
    INSERT INTO app.jobs (kind, idempotency_key, payload, status, attempt, max_attempts,
                          lease_token, lease_expires_at)
    VALUES ('maintenance', ${`${keyPrefix}:${keyCounter}`}, '{}'::jsonb, 'running',
            ${attempt}, ${maxAttempts}, gen_random_uuid(),
            now() + interval '60 seconds')
    RETURNING id::text AS "id", lease_token::text AS "leaseToken",
              lease_expires_at AS "leaseExpiresAt"
  `;
  const row = rows[0];
  return {
    id: row.id,
    kind: "maintenance",
    payload: {},
    attempt,
    maxAttempts,
    leaseToken: row.leaseToken,
    leaseExpiresAt: row.leaseExpiresAt,
  };
}

async function jobRow(job) {
  const rows = await owner.$queryRaw`
    SELECT status, attempt, last_error FROM app.jobs WHERE id = ${job.id}::uuid
  `;
  return rows[0];
}

/**
 * A queue whose claim is a fixture and whose renew is observable.
 *
 * `renew` defaults to `true`; a case can make it slow, or make it return
 * `false` after expiring the real lease.
 */
function fakeQueue(job, options = {}) {
  const timeline = options.timeline ?? [];
  const state = {
    events: [],
    renews: 0,
    inFlight: 0,
    claimCount: 0,
    fails: [],
    renewedAfterSettle: 0,
    settled: false,
  };

  function record(type, extra = {}) {
    timeline.push({ type, renews: state.renews, ...extra });
  }

  return {
    state,
    async enqueue() {
      throw new Error("the runner never enqueues");
    },
    async claim() {
      state.claimCount += 1;
      return state.claimCount === 1 ? job : null;
    },
    async renew() {
      state.renews += 1;
      if (state.settled) state.renewedAfterSettle += 1;
      state.inFlight += 1;
      record("renew_start");
      try {
        if (options.renewDelayMs !== undefined) await sleep(options.renewDelayMs);
        if (options.renewImpl !== undefined) return await options.renewImpl();
        return true;
      } finally {
        state.inFlight -= 1;
        record("renew_done");
      }
    },
    async succeed() {
      return true;
    },
    async fail(claimed, error, outcome) {
      state.fails.push({ jobId: claimed.id, error, outcome });
      return true;
    },
    async release() {
      return true;
    },
    async reapExpired() {
      return [];
    },
  };
}

function makeRunner({ queue, handle, heartbeatMs = 10, timeline = [] }) {
  const events = [];
  const runner = createRunner({
    db: system,
    queue,
    handlers: [{ kind: "maintenance", opensIngestionRun: false, handle }],
    leaseMs: 60_000,
    heartbeatMs,
    reaperIntervalMs: 600_000,
    pollIntervalMs: 60_000,
    log: (event, fields) => {
      events.push({ event, fields: fields ?? {} });
      timeline.push({ type: "log", event });
    },
  });
  return { runner, events };
}

before(async () => {
  await owner.$queryRaw`DELETE FROM app.jobs WHERE idempotency_key LIKE ${`${keyPrefix}%`}`;
});

after(async () => {
  await owner.$queryRaw`DELETE FROM app.jobs WHERE idempotency_key LIKE ${`${keyPrefix}%`}`;
  await Promise.all([system.$disconnect(), owner.$disconnect()]);
});

describe("heartbeat stops before settlement (F-04)", () => {
  it("does not renew after a successful commit and never reports a false lease loss", async () => {
    const job = await seedJob();
    const queue = fakeQueue(job);
    const { runner, events } = makeRunner({
      queue,
      handle: async () => {
        await sleep(60);
        return { outcome: "succeeded", recordCount: 1, coveragePercent: 100 };
      },
    });

    assert.equal(await runner.runOnce(), "handled");
    const renewsAtSettle = queue.state.renews;
    await sleep(120);

    assert.equal(queue.state.renews, renewsAtSettle, "no renewal may start after settlement");
    assert.equal(queue.state.renewedAfterSettle, 0);
    assert.equal(queue.state.inFlight, 0, "the in-flight renewal was awaited");
    assert.equal((await jobRow(job)).status, "succeeded");
    assert.equal(
      events.some((entry) => entry.event === "lease_lost"),
      false,
    );
  });

  it("awaits an in-flight renewal before writing the terminal state", async () => {
    const job = await seedJob();
    const timeline = [];
    const queue = fakeQueue(job, { renewDelayMs: 90, timeline });
    const { runner } = makeRunner({
      queue,
      timeline,
      heartbeatMs: 5,
      handle: async () => {
        await sleep(25); // a renewal is guaranteed to be in flight here
        return { outcome: "succeeded", recordCount: 1, coveragePercent: 100 };
      },
    });

    assert.equal(await runner.runOnce(), "handled");

    const settleIndex = timeline.findIndex(
      (entry) => entry.type === "log" && entry.event === "job_succeeded",
    );
    assert.ok(settleIndex >= 0);
    const renewDoneBefore = timeline
      .slice(0, settleIndex)
      .filter((entry) => entry.type === "renew_done").length;
    assert.ok(renewDoneBefore >= 1, "the pending renewal resolved before settlement");
    assert.equal(queue.state.renewedAfterSettle, 0);
  });

  it("stops the heartbeat on a terminal result", async () => {
    const job = await seedJob();
    const queue = fakeQueue(job);
    const { runner } = makeRunner({
      queue,
      handle: async () => {
        await sleep(30);
        return {
          outcome: "terminal",
          error: { code: "provider_changed", message: "drift", retryable: false },
        };
      },
    });

    assert.equal(await runner.runOnce(), "handled");
    const renewsAtSettle = queue.state.renews;
    await sleep(120);

    assert.equal(queue.state.renews, renewsAtSettle);
    assert.equal((await jobRow(job)).status, "dead");
  });

  it("stops the heartbeat on the retryable exception path", async () => {
    const job = await seedJob();
    const queue = fakeQueue(job);
    const { runner } = makeRunner({
      queue,
      handle: async () => {
        await sleep(30);
        throw new Error("upstream reset");
      },
    });

    assert.equal(await runner.runOnce(), "handled");
    const renewsAtSettle = queue.state.renews;
    await sleep(120);

    assert.equal(queue.state.renews, renewsAtSettle);
    assert.equal(queue.state.fails.length, 1);
    assert.equal(queue.state.fails[0].outcome.retryable, true);
    assert.equal((await jobRow(job)).status, "running", "the fake fail owns the write");
  });

  it("stops the heartbeat on a handler-owned settlement", async () => {
    const job = await seedJob();
    const queue = fakeQueue(job);
    const { runner, events } = makeRunner({
      queue,
      handle: async () => {
        await sleep(30);
        return { outcome: "settled", to: "partial", recordCount: 3, coveragePercent: 50 };
      },
    });

    assert.equal(await runner.runOnce(), "handled");
    const renewsAtSettle = queue.state.renews;
    await sleep(120);

    assert.equal(queue.state.renews, renewsAtSettle);
    assert.equal(queue.state.fails.length, 0, "a settled handler already wrote its own state");
    assert.equal(events.filter((entry) => entry.event === "job_succeeded").length, 1);
    assert.equal((await jobRow(job)).status, "running", "the runner must not settle twice");
  });

  it("aborts on lease loss and never settles a terminal success over it", async () => {
    const job = await seedJob();
    const queue = fakeQueue(job, {
      renewImpl: async () => {
        await owner.$queryRaw`
          UPDATE app.jobs SET lease_expires_at = now() - interval '1 second'
           WHERE id = ${job.id}::uuid
        `;
        return false;
      },
    });

    const { runner, events } = makeRunner({
      queue,
      handle: async (_claimed, context) => {
        await new Promise((resolve) => {
          context.signal.addEventListener("abort", resolve, { once: true });
        });
        return { outcome: "succeeded", recordCount: 1, coveragePercent: 100 };
      },
    });

    assert.equal(await runner.runOnce(), "handled");
    const renewsAtSettle = queue.state.renews;
    await sleep(120);

    const row = await jobRow(job);
    assert.equal(queue.state.renews, renewsAtSettle, "the heartbeat stopped after the loss");
    assert.notEqual(row.status, "succeeded", "a lost lease cannot be settled as success");
    assert.equal(
      events.filter((entry) => entry.event === "lease_lost").length,
      1,
      "lease loss is reported exactly once",
    );
    assert.equal(
      events.some((entry) => entry.event === "job_succeeded"),
      false,
    );
    assert.equal(queue.state.renewedAfterSettle, 0);
  });
});
