/**
 * Integration tests for `scripts/seed-dev-climate.mjs`:
 * 1. Environment guard refuses `production`, unset `NODE_ENV`, and `test` without `allowTest`.
 * 2. Runs strictly as `app_system` (never `migration_owner`) and is idempotent.
 * 3. Preserves foreign provider/ingestion `monthly_outlooks` and `weather_records` untouched.
 * 4. Executes atomically inside one transaction and rolls back all writes on failure.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { createPrismaClient } from "../../dist/index.js";
import { roleConnectionString } from "../../scripts/lib/connections.mjs";
import {
  assertDevClimateSeedEnvironment,
  SEED_METADATA,
  seedDevClimate,
} from "../../../../scripts/seed-dev-climate.mjs";

const FOREIGN_HASH = createHash("sha256").update("foreign-ingestion-v9").digest("hex");
const TEST_COORD = [{ lat: -7.5, lon: 108.5 }]; // cellKey: "-7.50,108.50"
const TEST_CELL_KEY = "-7.50,108.50";
const ATOMIC_COORD = [{ lat: -7.75, lon: 108.75 }]; // cellKey: "-7.75,108.75"
const ATOMIC_CELL_KEY = "-7.75,108.75";

let owner;

async function cleanupTestCells() {
  const keys = [TEST_CELL_KEY, ATOMIC_CELL_KEY];
  await owner.$executeRawUnsafe(
    `DELETE FROM app.weather_records WHERE cell_key = ANY($1::text[])`,
    keys,
  );
  await owner.$executeRawUnsafe(
    `DELETE FROM app.monthly_outlooks
      WHERE outlook_cell_id IN (
        SELECT id FROM app.outlook_cells WHERE cell_key = ANY($1::text[])
      )`,
    keys,
  );
  await owner.$executeRawUnsafe(
    `DELETE FROM app.outlook_cells WHERE cell_key = ANY($1::text[])`,
    keys,
  );
  await owner.$executeRawUnsafe(
    `DELETE FROM app.ingestion_runs WHERE adapter_version = 'external-provider@9.9.9'`,
  );
  await owner.$executeRawUnsafe(
    `DELETE FROM app.forecast_runs
      WHERE model = 'ecmwf_ifs025'
        AND initialized_at = '2026-11-29T00:00:00.000Z'::timestamptz`,
  );
}

before(async () => {
  owner = createPrismaClient({ connectionString: roleConnectionString("migration_owner") });
  await cleanupTestCells();
});

after(async () => {
  if (owner !== undefined) {
    await cleanupTestCells();
    await owner.$disconnect();
  }
});

describe("seed-dev-climate — guards, isolation & atomicity", () => {
  it("refuses production, unset NODE_ENV, and test without explicit allowTest", () => {
    assert.throws(() => assertDevClimateSeedEnvironment({ NODE_ENV: "production" }), /production/);
    assert.throws(() => assertDevClimateSeedEnvironment({}), /NODE_ENV=development/);
    assert.throws(
      () => assertDevClimateSeedEnvironment({ NODE_ENV: "test" }),
      /NODE_ENV=development/,
    );
    assert.doesNotThrow(() =>
      assertDevClimateSeedEnvironment({ NODE_ENV: "test" }, { allowTest: true }),
    );
  });

  it("connects as app_system, is idempotent, and preserves foreign ingestion rows untouched", async () => {
    // Seed a foreign outlook cell + foreign monthly_outlook + foreign weather_record on TEST_CELL_KEY
    const cellRows = await owner.$queryRawUnsafe(
      `INSERT INTO app.outlook_cells (provider, model, cell_key, served_lat, served_lon)
       VALUES ($1, $2, $3, -7.5, 108.5)
       RETURNING id::text AS id`,
      SEED_METADATA.provider,
      SEED_METADATA.model,
      TEST_CELL_KEY,
    );
    const cellId = cellRows[0].id;

    // Foreign active monthly_outlook on 2026-12-01 with different hash & value 999
    await owner.$executeRawUnsafe(
      `INSERT INTO app.monthly_outlooks
         (outlook_cell_id, variable, month, data_class, evaluation_basis, value_mm,
          baseline_version, anomaly_kind, anomaly_mm, anomaly_percent,
          model_climate_offset_mm, data_coverage_percent, spread_unavailable_reason,
          derivation_version, input_refs, input_snapshot_hash, status)
       VALUES ($1::uuid, 'precipitation', '2026-12-01'::date, 'seasonal_forecast', 'monthly', 999,
               'era5-1991-2020-v3', 'baseline_difference', 709, 244.5,
               0, 100, 'provider_omitted_spread',
               'external-model@9.9.9', '[]'::jsonb, $2, 'active')`,
      cellId,
      FOREIGN_HASH,
    );

    // Foreign weather_record on a separate forecast_run_id with external adapter_version
    const foreignRunRows = await owner.$queryRawUnsafe(
      `INSERT INTO app.forecast_runs
         (provider, model, product, initialized_at, horizon_end, received_at)
       VALUES ($1, $2, 'forecast', '2026-11-29T00:00:00.000Z'::timestamptz,
               '2026-12-15T00:00:00.000Z'::timestamptz, '2026-11-29T00:00:00.000Z'::timestamptz)
       RETURNING id::text AS id`,
      SEED_METADATA.provider,
      SEED_METADATA.model,
    );
    const foreignRunId = foreignRunRows[0].id;

    const foreignIngRows = await owner.$queryRawUnsafe(
      `INSERT INTO app.ingestion_runs
         (forecast_run_id, adapter_version, normalizer_version, target_selector_hash,
          ingestion_version, status, finished_at, coverage_percent)
       VALUES ($1::uuid, 'external-provider@9.9.9', 'external-daily@1', $2, $2, 'succeeded', now(), 100)
       RETURNING id::text AS id`,
      foreignRunId,
      FOREIGN_HASH,
    );
    const foreignIngId = foreignIngRows[0].id;

    await owner.$executeRawUnsafe(
      `INSERT INTO app.weather_records
         (forecast_run_id, ingestion_run_id, outlook_cell_id, cell_key, provider, model,
          data_class, variable, value, unit, valid_at, initialized_at, requested_lat,
          requested_lon, served_value_is_interpolated, temporal_resolution,
          ensemble_member, ensemble_size, aggregation_level, normalizer_version)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6,
               'weather_forecast', 'precipitation', 777, 'mm',
               '2026-11-28T00:00:00.000Z'::timestamptz, '2026-11-29T00:00:00.000Z'::timestamptz,
               -7.5, 108.5, false, 'daily', NULL, NULL, 'daily_sum', 'external-daily@1')`,
      foreignRunId,
      foreignIngId,
      cellId,
      TEST_CELL_KEY,
      SEED_METADATA.provider,
      SEED_METADATA.model,
    );

    // Run seeder twice as app_system
    const first = await seedDevClimate({
      env: { NODE_ENV: "test" },
      allowTest: true,
      coords: TEST_COORD,
    });
    assert.equal(first.roleName, "app_system");
    assert.equal(first.monthlySkippedForeign, 1);
    assert.equal(first.monthlyInserted, 11);
    assert.equal(first.dailyInserted, 45);

    const second = await seedDevClimate({
      env: { NODE_ENV: "test" },
      allowTest: true,
      coords: TEST_COORD,
    });
    assert.equal(second.roleName, "app_system");
    assert.equal(second.monthlySkippedForeign, 1);
    assert.equal(second.monthlyInserted, 0);
    assert.equal(second.monthlyUpdated, 11);
    assert.equal(second.dailyInserted, 0);
    assert.equal(second.dailyUpdated, 45);

    // Foreign monthly_outlook remains 999 untouched
    const foreignMonth = await owner.$queryRawUnsafe(
      `SELECT value_mm, input_snapshot_hash
         FROM app.monthly_outlooks
        WHERE outlook_cell_id = $1::uuid AND month = '2026-12-01'::date AND status = 'active'`,
      cellId,
    );
    assert.equal(foreignMonth[0]?.value_mm, 999);
    assert.equal(foreignMonth[0]?.input_snapshot_hash, FOREIGN_HASH);

    // Foreign weather_record remains 777 untouched alongside the 45 seeder rows
    const foreignDaily = await owner.$queryRawUnsafe(
      `SELECT value FROM app.weather_records
        WHERE forecast_run_id = $1::uuid AND cell_key = $2`,
      foreignRunId,
      TEST_CELL_KEY,
    );
    assert.equal(foreignDaily.length, 1);
    assert.equal(foreignDaily[0]?.value, 777);
  });

  it("rolls back the entire transaction atomically on failure", async () => {
    await assert.rejects(
      () =>
        seedDevClimate({
          env: { NODE_ENV: "test" },
          allowTest: true,
          coords: ATOMIC_COORD,
          _onAfterMonthlyForTest: async () => {
            throw new Error("simulated mid-transaction failure");
          },
        }),
      /simulated mid-transaction failure/,
    );

    const cells = await owner.$queryRawUnsafe(
      `SELECT count(*)::int AS cnt FROM app.outlook_cells WHERE cell_key = $1`,
      ATOMIC_CELL_KEY,
    );
    const weather = await owner.$queryRawUnsafe(
      `SELECT count(*)::int AS cnt FROM app.weather_records WHERE cell_key = $1`,
      ATOMIC_CELL_KEY,
    );
    assert.equal(cells[0]?.cnt, 0);
    assert.equal(weather[0]?.cnt, 0);
  });
});
