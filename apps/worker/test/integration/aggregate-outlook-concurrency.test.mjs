/**
 * Two aggregate jobs, concurrently, through the real runner and handler —
 * Phase 5.7A corrective follow-up.
 *
 * The database suite proves the lock *primitive* is ordered. This suite proves
 * the *worker* orders it: two runners claim two `aggregate` jobs whose selectors
 * name the same cells in opposite order, and both must finish.
 *
 * Synchronisation is a real third-party transaction holding the advisory locks
 * for both footprints, and it is implementation-agnostic:
 *
 * - corrected handler: both jobs request their first key (the same one, because
 *   `lockForecastFootprint` sorts the complete set) and are blocked before any
 *   work. Releasing the blockers lets one proceed and then the other.
 * - per-cell locking (the regression): job A blocks on its own first key, job B
 *   on its own first key. Releasing both hands each one a key, and each then
 *   asks for the other's → `40P01`.
 *
 * So the same release step produces "two successes" or "a deadlock", which is
 * what makes this a regression test rather than a smoke test.
 *
 * Run: pnpm --filter @agroclimate/worker test:integration
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { targetSelectorHashOf } from "@agroclimate/contracts";
import { createPrismaClient, footprintLockKeyOf } from "@agroclimate/database";

import { createOutlookAggregationHandler } from "../../dist/aggregate/outlook.js";
import { createPostgresQueue } from "../../dist/queue/postgres.js";
import { createRunner } from "../../dist/runner.js";
import { roleConnectionString } from "../../../../packages/database/scripts/lib/connections.mjs";

const owner = createPrismaClient({ connectionString: roleConnectionString("migration_owner") });
const blockerDb = createPrismaClient({ connectionString: roleConnectionString("app_system") });

const token = randomUUID().slice(0, 8);
const PROVIDER = "open-meteo";
const MODEL = `p57ac_${token}`;
const CELL_A = `p57ac-a-${token}`;
const CELL_B = `p57ac-b-${token}`;
const BASELINE_1 = `ERA5:1991-2020:p57ac${token}a`;
const BASELINE_2 = `ERA5:1991-2020:p57ac${token}b`;
const FIRST_MONTH = "2026-08-01";

const clients = [];

function makeRunner(overrides = {}) {
  const db = createPrismaClient({ connectionString: roleConnectionString("app_system") });
  const queue = createPostgresQueue({ db, defaultMaxAttempts: 2 });
  const runner = createRunner({
    db,
    queue,
    handlers: [createOutlookAggregationHandler()],
    leaseMs: 60_000,
    heartbeatMs: 60_000,
    reaperIntervalMs: 600_000,
    pollIntervalMs: 60_000,
    ...overrides,
  });
  clients.push(db);
  return { db, queue, runner };
}

let jobCounter = 0;

async function enqueue(queue, selector, baselineVersion) {
  jobCounter += 1;
  return queue.enqueue({
    kind: "aggregate",
    idempotencyKey: `aggregate:${token}:${jobCounter}`,
    payload: {
      provider: PROVIDER,
      model: MODEL,
      baselineVersion,
      firstMonth: FIRST_MONTH,
      targetSelector: selector,
      targetSelectorHash: targetSelectorHashOf(selector),
    },
  });
}

function selectorFor(a, b) {
  return {
    cells: [
      { cellKey: a, variable: "precipitation" },
      { cellKey: b, variable: "precipitation" },
    ],
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A promise bound, so a lock hang fails instead of stalling the suite. */
function withTimeout(promise, ms, label) {
  let timer;
  const bounded = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms} ms`)), ms);
  });
  return Promise.race([promise, bounded]).finally(() => clearTimeout(timer));
}

/**
 * Hold both footprints on real connections, in transactions of their own.
 *
 * The keys come from `footprintLockKeyOf`, the same derivation the worker uses;
 * the namespace and algorithm are unchanged. Only the ordering is under test.
 */
async function holdFootprintLocks(cellKeys) {
  const held = [];

  for (const cellKey of cellKeys) {
    const [first, second] = footprintLockKeyOf(cellKey, "precipitation");
    let release;
    let locked;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const acquired = new Promise((resolve) => {
      locked = resolve;
    });

    const done = blockerDb.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${first}::int, ${second}::int)`;
        locked();
        await gate;
      },
      { timeout: 60_000, maxWait: 10_000 },
    );

    await acquired;
    held.push({ release, done });
  }

  return held;
}

async function releaseBlockers(held) {
  for (const blocker of held) blocker.release();
  await Promise.all(held.map((blocker) => blocker.done));
}

/** Wait until both handlers are genuinely waiting on an advisory lock. */
async function waitForBlockedHandlers(expected, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let seen = 0;
  while (Date.now() < deadline) {
    const rows = await owner.$queryRaw`
      SELECT count(*)::int AS "waiting"
        FROM pg_locks
       WHERE locktype = 'advisory'
         AND NOT granted
         AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
    `;
    seen = rows[0].waiting;
    if (seen >= expected) return seen;
    await sleep(25);
  }
  throw new Error(`expected ${expected} blocked aggregate handlers, saw ${seen}`);
}

async function jobRows(ids) {
  const rows = [];
  for (const id of ids) {
    const [row] = await owner.$queryRaw`
      SELECT id::text AS "id", status, attempt, last_error AS "lastError"
        FROM app.jobs WHERE id = ${id}::uuid
    `;
    rows.push(row);
  }
  return rows;
}

async function outlookRows() {
  return owner.$queryRaw`
    SELECT c.cell_key                      AS "cellKey",
           to_char(o.month, 'YYYY-MM-DD')  AS "month",
           o.value_mm                      AS "valueMm",
           o.baseline_version              AS "baselineVersion",
           o.input_snapshot_hash           AS "inputSnapshotHash",
           o.status,
           o.superseded_by_id::text        AS "supersededById",
           o.id::text                      AS "id"
      FROM app.monthly_outlooks o
      JOIN app.outlook_cells c ON c.id = o.outlook_cell_id
     WHERE c.provider = ${PROVIDER} AND c.model = ${MODEL}
     ORDER BY c.cell_key, o.month, o.created_at
  `;
}

async function clearOutlooks() {
  await owner.$executeRaw`
    DELETE FROM app.monthly_outlooks
     WHERE outlook_cell_id IN (
       SELECT id FROM app.outlook_cells WHERE provider = ${PROVIDER} AND model = ${MODEL}
     )
  `;
}

/**
 * One derivation per cell.
 *
 * The snapshot hash is per cell by construction — its `DataInputRef` names that
 * cell's `cellKeys` — so the cross-cell invariant is not "one hash for the job",
 * it is "one hash per cell": a mixture would leave two live derivations of the
 * same cell, which the active-unique index would already have refused.
 */
function assertCoherentPerCell(active) {
  const perCell = new Map();
  for (const row of active) {
    const hashes = perCell.get(row.cellKey) ?? new Set();
    hashes.add(row.inputSnapshotHash);
    perCell.set(row.cellKey, hashes);
  }
  assert.equal(perCell.size, 2, "both cells are live");
  for (const [cellKey, hashes] of perCell) {
    assert.equal(hashes.size, 1, `${cellKey} carries a single derivation`);
  }
}

function assertOneActivePerSlot(active) {
  const perSlot = new Map();
  for (const row of active) {
    const key = `${row.cellKey}|${row.month}`;
    perSlot.set(key, (perSlot.get(key) ?? 0) + 1);
  }
  assert.equal(perSlot.size, 10, "every cell-month has a live answer");
  assert.ok(
    [...perSlot.values()].every((count) => count === 1),
    "exactly one active row per cell-month",
  );
}

before(async () => {
  const cellIds = {};
  for (const cellKey of [CELL_A, CELL_B]) {
    const inserted = await owner.$queryRaw`
      INSERT INTO app.outlook_cells (provider, model, cell_key)
      VALUES (${PROVIDER}, ${MODEL}, ${cellKey})
      RETURNING id::text AS "id"
    `;
    cellIds[cellKey] = inserted[0].id;
  }

  for (const [baseline, base] of [
    [BASELINE_1, 100],
    [BASELINE_2, 200],
  ]) {
    await owner.$executeRaw`
      INSERT INTO app.climatology_baselines (
        baseline_version, baseline_dataset, provider, model, adapter_version,
        source_reference, attribution, retrieved_at, period_from, period_to,
        algorithm_version, computed_at
      ) VALUES (
        ${baseline}, 'era5', 'open-meteo', 'era5', 'p57ac-test@1.0.0',
        ${`https://archive-api.open-meteo.com/v1/archive?p57ac=${token}`}, 'test fixture',
        now(), '1991-01-01', '2020-12-31', ${`p57ac${token}`}, now()
      )
    `;

    for (const cellKey of [CELL_A, CELL_B]) {
      const cellId = cellIds[cellKey];
      for (let index = 0; index < 12; index += 1) {
        await owner.$executeRaw`
          INSERT INTO app.climatology_normals (
            baseline_version, baseline_dataset, period_from, period_to,
            outlook_cell_id, month, value_mm, sample_years
          ) VALUES (
            ${baseline}, 'era5', '1991-01-01', '2020-12-31',
            ${cellId}::uuid, ${`1991-${String(index + 1).padStart(2, "0")}-01`}::date,
            ${base + index}, 30
          )
        `;
      }
    }
  }
});

after(async () => {
  await owner.$executeRaw`
    DELETE FROM app.jobs
     WHERE kind = 'aggregate' AND idempotency_key LIKE ${`aggregate:${token}:%`}
  `;
  await clearOutlooks();
  await owner.$executeRaw`
    DELETE FROM app.climatology_normals
     WHERE outlook_cell_id IN (
       SELECT id FROM app.outlook_cells WHERE provider = ${PROVIDER} AND model = ${MODEL}
     )
  `;
  await owner.$executeRaw`
    DELETE FROM app.climatology_baselines
     WHERE baseline_version IN (${BASELINE_1}, ${BASELINE_2})
  `;
  await owner.$executeRaw`
    DELETE FROM app.outlook_cells WHERE provider = ${PROVIDER} AND model = ${MODEL}
  `;

  for (const client of clients) await client.$disconnect();
  await blockerDb.$disconnect();
  await owner.$disconnect();
});

async function runSingle(order, baselineVersion, overrides) {
  const single = makeRunner(overrides);
  const job = await enqueue(single.queue, selectorFor(...order), baselineVersion);

  const run = withTimeout(single.runner.runOnce(), 30_000, "single runner");
  await waitForBlockedHandlers(1);
  return { job, run };
}

async function runPair(leftOrder, rightOrder, leftBaseline, rightBaseline) {
  const blockers = await holdFootprintLocks([CELL_A, CELL_B]);
  const left = makeRunner();
  const right = makeRunner();

  const leftJob = await enqueue(left.queue, selectorFor(...leftOrder), leftBaseline);
  const rightJob = await enqueue(right.queue, selectorFor(...rightOrder), rightBaseline);

  const runs = Promise.all([
    withTimeout(left.runner.runOnce(), 30_000, "left runner"),
    withTimeout(right.runner.runOnce(), 30_000, "right runner"),
  ]);

  await waitForBlockedHandlers(2);
  await releaseBlockers(blockers);

  const results = await runs;
  assert.deepEqual(results, ["handled", "handled"]);

  const jobs = await jobRows([leftJob.id, rightJob.id]);
  for (const job of jobs) {
    assert.equal(job.status, "succeeded", `job ${job.id}: ${JSON.stringify(job.lastError)}`);
    assert.equal(job.attempt, 1, "a deadlock would have forced a retry");
    assert.equal(job.lastError, null);
  }

  return { leftJob, rightJob };
}

describe("aggregate — concurrent jobs through the worker", () => {
  it("completes two reverse-order jobs on one derivation", { timeout: 60_000 }, async () => {
    await clearOutlooks();

    await runPair([CELL_A, CELL_B], [CELL_B, CELL_A], BASELINE_1, BASELINE_1);

    const rows = await outlookRows();
    const active = rows.filter((row) => row.status === "active");

    assertOneActivePerSlot(active);
    assert.equal(active.length, rows.length, "identical derivations superseded nothing");
    assertCoherentPerCell(active);
  });

  it("keeps one coherent winner when the snapshots differ", { timeout: 60_000 }, async () => {
    await clearOutlooks();

    await runPair([CELL_A, CELL_B], [CELL_B, CELL_A], BASELINE_1, BASELINE_2);

    const rows = await outlookRows();
    const active = rows.filter((row) => row.status === "active");
    const superseded = rows.filter((row) => row.status === "superseded");

    assertOneActivePerSlot(active);
    assert.equal(
      new Set(active.map((row) => row.baselineVersion)).size,
      1,
      "one job won both cells, not a mixture of baselines",
    );
    assertCoherentPerCell(active);

    assert.ok(superseded.length > 0, "the losing derivation was retired, not deleted");
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const row of superseded) {
      assert.ok(row.supersededById !== null, "a superseded row names its successor");
      const successor = byId.get(row.supersededById);
      assert.ok(successor !== undefined, "the successor exists");
      assert.equal(successor.cellKey, row.cellKey);
      assert.equal(successor.month, row.month);
      assert.notEqual(successor.status, "failed");
    }
    for (const row of active) {
      assert.equal(row.supersededById, null);
    }
  });

  it("does not report a lease loss when its own settlement unblocks the heartbeat", async () => {
    await clearOutlooks();
    const events = [];

    const blockers = await holdFootprintLocks([CELL_A, CELL_B]);
    const { job, run } = await runSingle([CELL_A, CELL_B], BASELINE_1, {
      heartbeatMs: 100,
      log: (event, fields) => events.push({ event, fields }),
    });

    // Enough ticks for a renewal to have started and to be waiting on the job
    // row that the handler holds `FOR UPDATE`.
    await sleep(400);
    await releaseBlockers(blockers);

    assert.equal(await run, "handled");
    const [row] = await jobRows([job.id]);
    assert.equal(row.status, "succeeded");

    // That renewal reports "no longer running" because the job settled, not
    // because the lease was lost. Logging a loss there would make every long
    // but successful job look like an incident.
    assert.ok(
      !events.some((entry) => entry.event === "lease_lost"),
      "a settled job must not log a lease loss",
    );
    assert.ok(events.some((entry) => entry.event === "job_succeeded"));
  });
});
