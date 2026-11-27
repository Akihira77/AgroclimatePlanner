/**
 * `aggregate` — seasonal outlook materialisation end to end, Phase 5.7D.
 *
 * The forecast run, its ingestion run, and the 50-member monthly records are
 * seeded directly; no provider is called. The assertions are about what the
 * handler is allowed to write: a complete population becomes six seasonal months
 * with the run's identity, and an incomplete one writes nothing at all.
 *
 * Run: pnpm --filter @agroclimate/worker test:integration
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { targetSelectorHashOf } from "@agroclimate/contracts";
import { createPrismaClient } from "@agroclimate/database";

import { createOutlookAggregationHandler } from "../../dist/aggregate/outlook.js";
import { createPostgresQueue } from "../../dist/queue/postgres.js";
import { createRunner } from "../../dist/runner.js";
import { roleConnectionString } from "../../../../packages/database/scripts/lib/connections.mjs";

const system = createPrismaClient({ connectionString: roleConnectionString("app_system") });
const owner = createPrismaClient({ connectionString: roleConnectionString("migration_owner") });

const token = randomUUID().slice(0, 8);
const PROVIDER = "open-meteo";
const MODEL = "ecmwf_seas5";
const CELL = `p57d-${token}`;
const INCOMPLETE_CELL = `p57d-partial-${token}`;
const ADAPTER_VERSION = "test-seasonal-adapter@1.0.0";
const NORMALIZER_VERSION = "monthly-member-aggregation@1.0.0";

const INITIALIZED_AT = new Date("2026-11-01T00:00:00.000Z");
const MONTHS = ["2026-12-01", "2027-01-01", "2027-02-01", "2027-03-01", "2027-04-01", "2027-05-01"];
/** member i carries `BASE + i` mm, so every mean is `BASE + 24.5`. */
const BASE = 100;

let cellId;
let incompleteCellId;
let forecastRunId;
let ingestionRunId;

function makeRunner() {
  const queue = createPostgresQueue({ db: system, defaultMaxAttempts: 2 });
  const runner = createRunner({
    db: system,
    queue,
    handlers: [
      createOutlookAggregationHandler({ now: () => new Date("2026-11-24T00:00:00.000Z") }),
    ],
    leaseMs: 60_000,
    heartbeatMs: 60_000,
    reaperIntervalMs: 600_000,
    pollIntervalMs: 60_000,
  });
  return { queue, runner };
}

let jobCounter = 0;

async function enqueue(queue, cellKey) {
  jobCounter += 1;
  const selector = { cells: [{ cellKey, variable: "precipitation" }] };
  return queue.enqueue({
    kind: "aggregate",
    idempotencyKey: `aggregate-seasonal:${token}:${jobCounter}`,
    payload: {
      provider: PROVIDER,
      model: MODEL,
      forecastRunId,
      targetSelector: selector,
      targetSelectorHash: targetSelectorHashOf(selector),
    },
  });
}

async function runOnly(runner, id) {
  await owner.$queryRaw`
    DELETE FROM app.jobs
     WHERE kind = 'aggregate'
       AND status = 'queued'
       AND id <> ${id}::uuid
       AND idempotency_key LIKE ${`aggregate-seasonal:${token}:%`}
  `;
  return runner.runOnce();
}

async function seedMembers(targetCellId, targetCellKey, { skip } = {}) {
  await owner.$queryRaw`
    INSERT INTO app.weather_records (
      forecast_run_id, ingestion_run_id, outlook_cell_id, cell_key, provider, model,
      data_class, variable, value, unit, valid_at, initialized_at,
      requested_lat, requested_lon, served_value_is_interpolated,
      spatial_resolution_km, temporal_resolution, ensemble_member, ensemble_size,
      aggregation_level, normalizer_version
    )
    SELECT ${forecastRunId}::uuid, ${ingestionRunId}::uuid, ${targetCellId}::uuid,
           ${targetCellKey}, ${PROVIDER}, ${MODEL}, 'seasonal_forecast', 'precipitation_sum',
           ${BASE} + series.member, 'mm', month::date, ${INITIALIZED_AT}::timestamptz,
           -6.0, 106.0, false, 36, 'monthly', series.member, 50, 'monthly_sum',
           ${NORMALIZER_VERSION}
      FROM unnest(${MONTHS}::date[]) AS month,
           generate_series(0, 49) AS series(member)
     WHERE NOT (month = ${skip?.month ?? null}::date AND series.member = ${skip?.member ?? -1})
  `;
}

async function seasonalRows(targetCellId) {
  return owner.$queryRaw`
    SELECT to_char(o.month, 'YYYY-MM-DD') AS month,
           o.value_mm AS "valueMm",
           o.data_class AS "dataClass",
           o.evaluation_basis AS "evaluationBasis",
           o.spread_unavailable_reason AS "spreadUnavailableReason",
           o.derivation_version AS "derivationVersion",
           o.forecast_run_id::text AS "forecastRunId",
           o.ingestion_run_id::text AS "ingestionRunId",
           o.status,
           o.input_refs AS "inputRefs"
      FROM app.monthly_outlooks o
     WHERE o.outlook_cell_id = ${targetCellId}::uuid
     ORDER BY o.month, o.created_at
  `;
}

before(async () => {
  const cell = await owner.$queryRaw`
    INSERT INTO app.outlook_cells (provider, model, cell_key)
    VALUES (${PROVIDER}, ${MODEL}, ${CELL}) RETURNING id::text AS id
  `;
  cellId = cell[0].id;
  const incomplete = await owner.$queryRaw`
    INSERT INTO app.outlook_cells (provider, model, cell_key)
    VALUES (${PROVIDER}, ${MODEL}, ${INCOMPLETE_CELL}) RETURNING id::text AS id
  `;
  incompleteCellId = incomplete[0].id;

  const run = await owner.$queryRaw`
    INSERT INTO app.forecast_runs
      (provider, model, product, initialized_at, horizon_end, received_at)
    VALUES (${PROVIDER}, ${MODEL}, 'seasonal', ${INITIALIZED_AT}::timestamptz,
            ${INITIALIZED_AT}::timestamptz + interval '7 months', ${INITIALIZED_AT}::timestamptz)
    RETURNING id::text AS id
  `;
  forecastRunId = run[0].id;

  const ingestion = await owner.$queryRaw`
    INSERT INTO app.ingestion_runs
      (forecast_run_id, adapter_version, normalizer_version, target_selector_hash,
       ingestion_version, status, created_at, finished_at)
    VALUES (${forecastRunId}::uuid, ${ADAPTER_VERSION}, ${NORMALIZER_VERSION},
            ${"a".repeat(64)}, ${"b".repeat(64)}, 'succeeded',
            ${INITIALIZED_AT}::timestamptz, ${INITIALIZED_AT}::timestamptz)
    RETURNING id::text AS id
  `;
  ingestionRunId = ingestion[0].id;

  await seedMembers(cellId, CELL);
  await seedMembers(incompleteCellId, INCOMPLETE_CELL, {
    skip: { month: "2027-02-01", member: 7 },
  });
});

after(async () => {
  await owner.$queryRaw`
    DELETE FROM app.jobs
     WHERE kind = 'aggregate' AND idempotency_key LIKE ${`aggregate-seasonal:${token}:%`}
  `;
  await owner.$queryRaw`
    DELETE FROM app.monthly_outlooks
     WHERE outlook_cell_id IN (${cellId}::uuid, ${incompleteCellId}::uuid)
  `;
  await owner.$queryRaw`
    DELETE FROM app.weather_records
     WHERE outlook_cell_id IN (${cellId}::uuid, ${incompleteCellId}::uuid)
  `;
  await owner.$queryRaw`DELETE FROM app.ingestion_runs WHERE id = ${ingestionRunId}::uuid`;
  await owner.$queryRaw`DELETE FROM app.forecast_runs WHERE id = ${forecastRunId}::uuid`;
  await owner.$queryRaw`
    DELETE FROM app.outlook_cells WHERE id IN (${cellId}::uuid, ${incompleteCellId}::uuid)
  `;
  await system.$disconnect();
  await owner.$disconnect();
});

describe("aggregate — seasonal materialisation", () => {
  it("writes the six months of the run window as seasonal_forecast", async () => {
    const { queue, runner } = makeRunner();
    const { id } = await enqueue(queue, CELL);

    assert.equal(await runOnly(runner, id), "handled");

    const job = await owner.$queryRaw`
      SELECT status, ingestion_run_id AS "ingestionRunId", last_error AS "lastError"
        FROM app.jobs WHERE id = ${id}::uuid
    `;
    assert.equal(job[0].status, "succeeded", JSON.stringify(job[0].lastError));
    assert.equal(job[0].ingestionRunId, null, "a derived artifact invents no IngestionRun");

    const rows = await seasonalRows(cellId);
    assert.deepEqual(
      rows.map((row) => row.month),
      MONTHS,
    );
    for (const row of rows) {
      assert.equal(row.dataClass, "seasonal_forecast");
      assert.equal(row.evaluationBasis, "monthly");
      // sum(BASE + 0..49) / 50 = BASE + 24.5
      assert.equal(row.valueMm, BASE + 24.5);
      assert.equal(row.spreadUnavailableReason, "ensemble_spread_not_derived");
      assert.equal(row.derivationVersion, "seasonal-outlook@1.0.0");
      assert.equal(row.forecastRunId, forecastRunId);
      assert.equal(row.ingestionRunId, ingestionRunId);
      assert.equal(row.status, "active");
      assert.equal(row.inputRefs[0].kind, "forecast");
      assert.equal(row.inputRefs[0].role, "seasonal");
      assert.deepEqual(row.inputRefs[0].forecastRunIds, [forecastRunId]);
      assert.match(row.inputRefs[0].recordSetHash, /^[0-9a-f]{64}$/);
    }
  });

  it("writes nothing for an incomplete population and preserves the older answer", async () => {
    // An older active answer for the first month, written before the job runs.
    await owner.$queryRaw`
      INSERT INTO app.monthly_outlooks (
        outlook_cell_id, variable, month, data_class, evaluation_basis, value_mm,
        missing_reason, spread_unavailable_reason, derivation_version, input_refs,
        input_snapshot_hash, computed_at, status
      ) VALUES (
        ${incompleteCellId}::uuid, 'precipitation', ${MONTHS[0]}::date,
        'seasonal_forecast', 'monthly', 999,
        NULL, 'ensemble_spread_not_derived', 'seasonal-outlook@1.0.0', '[]'::jsonb,
        ${"c".repeat(64)}, ${INITIALIZED_AT}::timestamptz, 'active'
      )
    `;

    const { queue, runner } = makeRunner();
    const { id } = await enqueue(queue, INCOMPLETE_CELL);

    assert.equal(await runOnly(runner, id), "handled");

    const job = await owner.$queryRaw`
      SELECT status, last_error AS "lastError" FROM app.jobs WHERE id = ${id}::uuid
    `;
    assert.equal(job[0].status, "dead");
    assert.equal(job[0].lastError.code, "population_incomplete");

    const rows = await seasonalRows(incompleteCellId);
    assert.equal(rows.length, 1, "no month was written");
    assert.equal(rows[0].status, "active");
    assert.equal(rows[0].valueMm, 999, "the older active answer survives");
  });

  it("refuses a payload that names a run of another model", async () => {
    const { queue, runner } = makeRunner();
    const selector = { cells: [{ cellKey: CELL, variable: "precipitation" }] };
    const { id } = await queue.enqueue({
      kind: "aggregate",
      idempotencyKey: `aggregate-seasonal:${token}:model`,
      payload: {
        provider: PROVIDER,
        model: "ecmwf_ec46",
        forecastRunId,
        targetSelector: selector,
        targetSelectorHash: targetSelectorHashOf(selector),
      },
    });

    // The schema rejects the model literal before any database work.
    assert.equal(await runOnly(runner, id), "handled");
    const job = await owner.$queryRaw`
      SELECT status, last_error AS "lastError" FROM app.jobs WHERE id = ${id}::uuid
    `;
    assert.equal(job[0].status, "dead");
    assert.equal(job[0].lastError.code, "payload_invalid");
  });
});
