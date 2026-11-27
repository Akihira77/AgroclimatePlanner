/**
 * `aggregate` — climatology outlook materialisation end to end, Phase 5.7A.
 *
 * No provider, no transport, no registry: the handler reads stored
 * `climatology_normals` and writes `monthly_outlooks`. The seed rows are written
 * by `migration_owner`, the handler runs as `app_system` through the real queue
 * and runner.
 *
 * Run: pnpm --filter @agroclimate/worker test:integration
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { targetSelectorHashOf } from "@agroclimate/contracts";
import { createPrismaClient } from "@agroclimate/database";

import {
  MAX_OUTLOOK_CELLS_PER_JOB,
  OUTLOOK_LEASE_HEADROOM_MS,
  createOutlookAggregationHandler,
} from "../../dist/aggregate/outlook.js";
import { createPostgresQueue } from "../../dist/queue/postgres.js";
import { createRunner } from "../../dist/runner.js";
import { roleConnectionString } from "../../../../packages/database/scripts/lib/connections.mjs";

const system = createPrismaClient({ connectionString: roleConnectionString("app_system") });
const owner = createPrismaClient({ connectionString: roleConnectionString("migration_owner") });

const token = randomUUID().slice(0, 8);
const PROVIDER = "open-meteo";
const MODEL = `p57aw_${token}`;
const CELL = `p57aw-${token}`;
const MISSING_CELL = `p57aw-missing-${token}`;
const CELL_TWO = `p57aw-two-${token}`;
const BASELINE = `ERA5:1991-2020:p57aw${token}`;
const UNKNOWN_BASELINE = `ERA5:1991-2020:p57aw${token}unknown`;
const FIRST_MONTH = "2026-08-01";

/** Lead 7–12 of 2026-08-01, i.e. the six months a climatology may fill. */
const EXPECTED_MONTHS = [
  "2027-02-01",
  "2027-03-01",
  "2027-04-01",
  "2027-05-01",
  "2027-06-01",
  "2027-07-01",
];

const NOW = new Date("2026-08-01T00:00:00.000Z");

function makeRunner() {
  const queue = createPostgresQueue({ db: system, defaultMaxAttempts: 2 });
  const handler = createOutlookAggregationHandler({ now: () => NOW });
  const runner = createRunner({
    db: system,
    queue,
    handlers: [handler],
    leaseMs: 60_000,
    heartbeatMs: 60_000,
    reaperIntervalMs: 600_000,
    pollIntervalMs: 60_000,
  });
  return { queue, runner };
}

function selectorFor(cellKey = CELL) {
  return { cells: [{ cellKey, variable: "precipitation" }] };
}

function payloadFor(overrides = {}) {
  const selector = overrides.targetSelector ?? selectorFor();
  return {
    provider: PROVIDER,
    model: MODEL,
    baselineVersion: BASELINE,
    firstMonth: FIRST_MONTH,
    targetSelector: selector,
    targetSelectorHash: targetSelectorHashOf(selector),
    ...overrides,
    ...(overrides.targetSelector === undefined
      ? {}
      : { targetSelectorHash: targetSelectorHashOf(overrides.targetSelector) }),
  };
}

let jobCounter = 0;

async function enqueue(queue, payload) {
  jobCounter += 1;
  return queue.enqueue({
    kind: "aggregate",
    idempotencyKey: `aggregate:${token}:${jobCounter}`,
    payload,
  });
}

/** Leave exactly one runnable aggregate job, so `claim` cannot pick a leftover. */
async function runOnly(runner, id) {
  await owner.$queryRaw`
    DELETE FROM app.jobs
     WHERE kind = 'aggregate'
       AND status = 'queued'
       AND id <> ${id}::uuid
       AND idempotency_key LIKE ${`aggregate:${token}:%`}
  `;
  return runner.runOnce();
}

async function jobRow(id) {
  const rows = await owner.$queryRaw`
    SELECT status, attempt,
           last_error AS "lastError",
           ingestion_run_id AS "ingestionRunId"
      FROM app.jobs WHERE id = ${id}::uuid
  `;
  return rows[0];
}

async function outlookRows(cellKey = CELL) {
  return owner.$queryRaw`
    SELECT c.cell_key AS "cellKey",
           to_char(o.month, 'YYYY-MM-DD') AS month,
           o.value_mm AS "valueMm",
           o.data_class AS "dataClass",
           o.evaluation_basis AS "evaluationBasis",
           o.missing_reason AS "missingReason",
           o.baseline_version AS "baselineVersion",
           o.spread_unavailable_reason AS "spreadUnavailableReason",
           o.derivation_version AS "derivationVersion",
           o.input_snapshot_hash AS "inputSnapshotHash",
           jsonb_array_length(o.input_refs) AS "refCount",
           o.status
      FROM app.monthly_outlooks o
      JOIN app.outlook_cells c ON c.id = o.outlook_cell_id
     WHERE c.provider = ${PROVIDER}
       AND c.model = ${MODEL}
       AND c.cell_key = ${cellKey}
     ORDER BY o.month, o.created_at
  `;
}

before(async () => {
  await owner.$queryRaw`
    DELETE FROM app.jobs
     WHERE kind = 'aggregate' AND idempotency_key LIKE ${`aggregate:${token}:%`}
  `;

  const cells = [
    { cellKey: CELL, ratio: 1 },
    { cellKey: CELL_TWO, ratio: 1 },
    // A cell whose baseline exists but holds no normal for this month-of-year.
    { cellKey: MISSING_CELL, ratio: 0 },
  ];

  for (const cell of cells) {
    const inserted = await owner.$queryRaw`
      INSERT INTO app.outlook_cells (provider, model, cell_key)
      VALUES (${PROVIDER}, ${MODEL}, ${cell.cellKey})
      RETURNING id::text AS "id"
    `;
    const cellId = inserted[0].id;
    if (cell.ratio === 0) continue;

    for (let index = 0; index < 12; index += 1) {
      await owner.$queryRaw`
        INSERT INTO app.climatology_normals (
          baseline_version, baseline_dataset, period_from, period_to,
          outlook_cell_id, month, value_mm, sample_years
        ) VALUES (
          ${BASELINE}, 'era5', '1991-01-01', '2020-12-31',
          ${cellId}::uuid, ${`1991-${String(index + 1).padStart(2, "0")}-01`}::date,
          ${100 + index}, 30
        )
      `;
    }
  }

  await owner.$queryRaw`
    INSERT INTO app.climatology_baselines (
      baseline_version, baseline_dataset, provider, model, adapter_version,
      source_reference, attribution, retrieved_at, period_from, period_to,
      algorithm_version, computed_at
    ) VALUES (
      ${BASELINE}, 'era5', 'open-meteo', 'era5', 'p57aw@1.0.0',
      ${`https://archive-api.open-meteo.com/v1/archive?p57aw=${token}`},
      'test fixture', ${NOW}::timestamptz, '1991-01-01', '2020-12-31',
      ${`p57aw${token}`}, ${NOW}::timestamptz
    )
  `;
});

after(async () => {
  await owner.$queryRaw`
    DELETE FROM app.jobs
     WHERE kind = 'aggregate' AND idempotency_key LIKE ${`aggregate:${token}:%`}
  `;
  await owner.$queryRaw`
    DELETE FROM app.monthly_outlooks
     WHERE outlook_cell_id IN (
       SELECT id FROM app.outlook_cells WHERE provider = ${PROVIDER} AND model = ${MODEL}
     )
  `;
  await owner.$queryRaw`
    DELETE FROM app.climatology_normals
     WHERE outlook_cell_id IN (
       SELECT id FROM app.outlook_cells WHERE provider = ${PROVIDER} AND model = ${MODEL}
     )
  `;
  await owner.$queryRaw`DELETE FROM app.climatology_baselines WHERE baseline_version = ${BASELINE}`;
  await owner.$queryRaw`
    DELETE FROM app.outlook_cells WHERE provider = ${PROVIDER} AND model = ${MODEL}
  `;
  await system.$disconnect();
  await owner.$disconnect();
});

describe("aggregate — climatology materialisation", () => {
  it("writes lead months 7–12 and settles a job that opens no ingestion run", async () => {
    const { queue, runner } = makeRunner();
    const { id } = await enqueue(queue, payloadFor());

    assert.equal(await runOnly(runner, id), "handled");

    const job = await jobRow(id);
    assert.equal(job.status, "succeeded");
    assert.equal(job.ingestionRunId, null, "a derived artifact invents no IngestionRun");

    const rows = await outlookRows();
    assert.equal(rows.length, 6, "lead months 1–6 are not rows");
    assert.deepEqual(
      rows.map((row) => row.month),
      EXPECTED_MONTHS,
    );
    for (const row of rows) {
      assert.equal(row.cellKey, CELL);
      assert.equal(row.dataClass, "climatology");
      assert.equal(row.evaluationBasis, "climatology");
      assert.equal(row.missingReason, "beyond_horizon");
      assert.equal(row.baselineVersion, BASELINE);
      assert.equal(row.spreadUnavailableReason, "climatology_has_no_ensemble");
      assert.equal(row.refCount, 1);
      assert.equal(row.status, "active");
      assert.match(row.inputSnapshotHash, /^[0-9a-f]{64}$/);
      assert.equal(row.derivationVersion, "climatology-outlook@1.0.0");
    }
    // Lead 7 of 2026-08 is 2027-02, so the February normal is used.
    assert.equal(rows[0].valueMm, 101);
    assert.equal(rows[5].valueMm, 106);
  });

  it("is idempotent: the same derivation leaves one active row per month", async () => {
    const { queue, runner } = makeRunner();
    const { id } = await enqueue(queue, payloadFor());

    assert.equal(await runOnly(runner, id), "handled");
    assert.equal((await jobRow(id)).status, "succeeded");

    const rows = await outlookRows();
    assert.equal(rows.length, 6, "no second row is written for an identical derivation");
    assert.ok(rows.every((row) => row.status === "active"));
  });

  it("materialises every cell of a multi-cell selector in one job", async () => {
    const { queue, runner } = makeRunner();
    const selector = {
      cells: [
        { cellKey: CELL, variable: "precipitation" },
        { cellKey: CELL_TWO, variable: "precipitation" },
      ],
    };
    const { id } = await enqueue(queue, payloadFor({ targetSelector: selector }));

    assert.equal(await runOnly(runner, id), "handled");
    assert.equal((await jobRow(id)).status, "succeeded");

    for (const cellKey of [CELL, CELL_TWO]) {
      const rows = await outlookRows(cellKey);
      assert.equal(rows.length, 6, `${cellKey} has six climatology months`);
      assert.ok(rows.every((row) => row.status === "active"));
    }
  });

  it("hands back a lease too short to cover its own transaction", async () => {
    // Both values are compared against the real clock, so this handler must not
    // be given the fixed one.
    const queue = createPostgresQueue({ db: system, defaultMaxAttempts: 1 });
    const runner = createRunner({
      db: system,
      queue,
      handlers: [createOutlookAggregationHandler()],
      leaseMs: OUTLOOK_LEASE_HEADROOM_MS - 1,
      heartbeatMs: 60_000,
      reaperIntervalMs: 600_000,
      pollIntervalMs: 60_000,
    });
    const { id } = await enqueue(queue, payloadFor());
    const before = await outlookRows(CELL);

    assert.equal(await runOnly(runner, id), "handled");

    const job = await jobRow(id);
    assert.equal(job.status, "dead");
    assert.equal(job.lastError.code, "lease_headroom_insufficient");
    assert.deepEqual(await outlookRows(CELL), before, "nothing was written under that lease");
  });

  it("refuses a selector above the per-job cell ceiling instead of timing out", async () => {
    const { queue, runner } = makeRunner();
    const cells = Array.from({ length: MAX_OUTLOOK_CELLS_PER_JOB + 1 }, (_unused, index) => ({
      cellKey: `${CELL}-${index}`,
      variable: "precipitation",
    }));
    const { id } = await enqueue(queue, payloadFor({ targetSelector: { cells } }));

    assert.equal(await runOnly(runner, id), "handled");

    const job = await jobRow(id);
    assert.equal(job.status, "dead");
    assert.equal(job.lastError.code, "selector_too_large");
  });

  it("persists nothing for a cell whose baseline holds no normal", async () => {
    const { queue, runner } = makeRunner();
    const { id } = await enqueue(queue, payloadFor({ targetSelector: selectorFor(MISSING_CELL) }));

    assert.equal(await runOnly(runner, id), "handled");

    const job = await jobRow(id);
    assert.equal(job.status, "succeeded");

    const rows = await outlookRows(MISSING_CELL);
    assert.equal(rows.length, 0);
  });
});

describe("aggregate — refusals", () => {
  it("dies terminal on an unknown baseline version instead of picking one", async () => {
    const { queue, runner } = makeRunner();
    const { id } = await enqueue(queue, payloadFor({ baselineVersion: UNKNOWN_BASELINE }));

    assert.equal(await runOnly(runner, id), "handled");

    const job = await jobRow(id);
    assert.equal(job.status, "dead");
    assert.equal(job.lastError.code, "baseline_unknown");
  });

  it("dies terminal on a cell the grid does not contain, creating none", async () => {
    const { queue, runner } = makeRunner();
    const { id } = await enqueue(
      queue,
      payloadFor({ targetSelector: selectorFor(`nope-${token}`) }),
    );

    assert.equal(await runOnly(runner, id), "handled");

    const job = await jobRow(id);
    assert.equal(job.status, "dead");
    assert.equal(job.lastError.code, "outlook_cell_not_found");
  });

  it("refuses a selector whose digest does not match it", async () => {
    const { queue, runner } = makeRunner();
    const { id } = await enqueue(queue, payloadFor({ targetSelectorHash: "0".repeat(64) }));

    assert.equal(await runOnly(runner, id), "handled");

    const job = await jobRow(id);
    assert.equal(job.status, "dead");
    assert.equal(job.lastError.code, "selector_digest_mismatch");
  });

  it("refuses a variable the outlook cannot carry", async () => {
    const { queue, runner } = makeRunner();
    const selector = { cells: [{ cellKey: CELL, variable: "temperature" }] };
    const { id } = await enqueue(queue, payloadFor({ targetSelector: selector }));

    assert.equal(await runOnly(runner, id), "handled");

    const job = await jobRow(id);
    assert.equal(job.status, "dead");
    assert.equal(job.lastError.code, "unsupported_variable");
  });
});
