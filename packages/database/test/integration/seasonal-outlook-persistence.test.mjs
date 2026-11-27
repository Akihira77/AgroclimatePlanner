/**
 * `app.monthly_outlooks` seasonal persistence against real PostgreSQL — 5.7D.
 *
 * Writes run as `app_system` (the worker's real role) inside one transaction;
 * assertions read back as `migration_owner`. The point of these cases is
 * authority: which run may replace which active answer, and which may not.
 *
 * Requires a migrated database and the roles from `pnpm db:bootstrap`.
 * Run: pnpm --filter @agroclimate/database test:integration
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";

import { Client } from "pg";

import {
  createPrismaClient,
  persistClimatologyOutlook,
  persistSeasonalOutlook,
} from "../../dist/index.js";
import { roleConnectionString } from "../../scripts/lib/connections.mjs";

const owner = new Client({ connectionString: roleConnectionString("migration_owner") });
const system = createPrismaClient({ connectionString: roleConnectionString("app_system") });

const token = randomUUID().slice(0, 8);
const PROVIDER = "open-meteo";
const MODEL = `p57d_${token}`;
const CELL_KEY = `p57d-${token}`;
const BASELINE_A = `ERA5:1991-2020:p57d${token}a`;

const MONTHS = ["2027-01-01", "2027-02-01", "2027-03-01", "2027-04-01", "2027-05-01", "2027-06-01"];

const hash = (letter) => letter.repeat(64);
const ref = (forecastRunId, ingestionRunId) => [
  {
    kind: "forecast",
    role: "seasonal",
    purpose: "input",
    forecastRunIds: [forecastRunId],
    ingestionRunIds: [ingestionRunId],
    recordSetHash: hash("e"),
  },
];

let cellId;
let oldRun;
let newRun;
let olderIngestion;
let newerIngestion;
let newRunIngestion;

async function insertRun(initializedAt) {
  const rows = await owner.query(
    `INSERT INTO app.forecast_runs
       (provider, model, product, initialized_at, horizon_end, received_at)
     VALUES ($1, $2, 'seasonal', $3::timestamptz, $3::timestamptz + interval '7 months',
             $3::timestamptz)
     RETURNING id::text AS id`,
    [PROVIDER, MODEL, initializedAt],
  );
  return rows.rows[0].id;
}

async function insertIngestion(forecastRunId, createdAt, version) {
  const rows = await owner.query(
    `INSERT INTO app.ingestion_runs
       (forecast_run_id, adapter_version, normalizer_version, target_selector_hash,
        ingestion_version, status, created_at, finished_at)
     VALUES ($1::uuid, 'adapter@1', 'normalizer@1', $2, $3, 'succeeded', $4::timestamptz,
             $4::timestamptz)
     RETURNING id::text AS id`,
    [forecastRunId, hash("a"), version, createdAt],
  );
  return rows.rows[0].id;
}

function seasonalInput({ forecastRunId, ingestionRunId, valueMm = 120, snapshot = hash("c") }) {
  return {
    provider: PROVIDER,
    model: MODEL,
    cellKey: CELL_KEY,
    variable: "precipitation",
    forecastRunId,
    ingestionRunId,
    derivationVersion: "seasonal-outlook@1.0.0",
    inputRefs: ref(forecastRunId, ingestionRunId),
    inputSnapshotHash: snapshot,
    computedAt: new Date("2026-11-24T00:00:00.000Z"),
    months: MONTHS.map((month) => ({
      month,
      valueMm,
      spreadUnavailableReason: "ensemble_spread_not_derived",
    })),
  };
}

const persistSeasonal = (tx, input) => persistSeasonalOutlook(tx, input);
const runInTx = (fn) => system.$transaction(fn);

async function activeRows() {
  const result = await owner.query(
    `SELECT month::text AS month, data_class AS "dataClass", value_mm AS "valueMm",
            forecast_run_id::text AS "forecastRunId",
            ingestion_run_id::text AS "ingestionRunId",
            status
       FROM app.monthly_outlooks
      WHERE outlook_cell_id = $1::uuid AND status = 'active'
      ORDER BY month`,
    [cellId],
  );
  return result.rows;
}

before(async () => {
  await owner.connect();
  const cell = await owner.query(
    `INSERT INTO app.outlook_cells (provider, model, cell_key)
     VALUES ($1, $2, $3) RETURNING id::text AS id`,
    [PROVIDER, MODEL, CELL_KEY],
  );
  cellId = cell.rows[0].id;

  oldRun = await insertRun("2026-09-01T00:00:00.000Z");
  newRun = await insertRun("2026-11-01T00:00:00.000Z");
  olderIngestion = await insertIngestion(oldRun, "2026-09-02T00:00:00.000Z", hash("b"));
  newerIngestion = await insertIngestion(oldRun, "2026-11-20T00:00:00.000Z", hash("d"));
  newRunIngestion = await insertIngestion(newRun, "2026-11-05T00:00:00.000Z", hash("9"));
});

beforeEach(async () => {
  await owner.query(`DELETE FROM app.monthly_outlooks WHERE outlook_cell_id = $1::uuid`, [cellId]);
});

after(async () => {
  await owner.query(`DELETE FROM app.monthly_outlooks WHERE outlook_cell_id = $1::uuid`, [cellId]);
  await owner.query(
    `DELETE FROM app.ingestion_runs WHERE forecast_run_id IN ($1::uuid, $2::uuid)`,
    [oldRun, newRun],
  );
  await owner.query(`DELETE FROM app.forecast_runs WHERE id IN ($1::uuid, $2::uuid)`, [
    oldRun,
    newRun,
  ]);
  await owner.query(`DELETE FROM app.climatology_normals WHERE baseline_version = $1`, [
    BASELINE_A,
  ]);
  await owner.query(`DELETE FROM app.climatology_baselines WHERE baseline_version = $1`, [
    BASELINE_A,
  ]);
  await owner.query(`DELETE FROM app.outlook_cells WHERE id = $1::uuid`, [cellId]);
  await system.$disconnect();
  await owner.end();
});

describe("persistSeasonalOutlook — what a seasonal month is stored as", () => {
  it("writes the six months with their run identity and no spread", async () => {
    const result = await runInTx((tx) =>
      persistSeasonal(
        tx,
        seasonalInput({ forecastRunId: newRun, ingestionRunId: newRunIngestion }),
      ),
    );

    assert.deepEqual(result, { inserted: 6, superseded: 0, unchanged: 0, skipped: 0 });

    const stored = await owner.query(
      `SELECT month::text AS month, data_class AS "dataClass",
              evaluation_basis AS "evaluationBasis", missing_reason AS "missingReason",
              baseline_version AS "baselineVersion", ensemble_spread_mm AS "spreadMm",
              spread_unavailable_reason AS "spreadReason",
              forecast_run_id::text AS "forecastRunId",
              ingestion_run_id::text AS "ingestionRunId",
              derivation_version AS "derivationVersion"
         FROM app.monthly_outlooks
        WHERE outlook_cell_id = $1::uuid AND status = 'active'
        ORDER BY month`,
      [cellId],
    );

    assert.deepEqual(
      stored.rows.map((row) => row.month),
      MONTHS,
    );
    for (const row of stored.rows) {
      assert.equal(row.dataClass, "seasonal_forecast");
      assert.equal(row.evaluationBasis, "monthly");
      assert.equal(row.missingReason, null);
      assert.equal(row.baselineVersion, null);
      assert.equal(row.spreadMm, null);
      assert.equal(row.spreadReason, "ensemble_spread_not_derived");
      assert.equal(row.forecastRunId, newRun);
      assert.equal(row.ingestionRunId, newRunIngestion);
      assert.equal(row.derivationVersion, "seasonal-outlook@1.0.0");
    }
  });

  it("is idempotent: the same derivation writes nothing twice", async () => {
    const input = seasonalInput({ forecastRunId: newRun, ingestionRunId: newRunIngestion });
    await runInTx((tx) => persistSeasonal(tx, input));

    const second = await runInTx((tx) => persistSeasonal(tx, input));

    assert.deepEqual(second, { inserted: 0, superseded: 0, unchanged: 6, skipped: 0 });
    assert.equal((await activeRows()).length, 6);
  });
});

describe("persistSeasonalOutlook — who may replace whom", () => {
  it("does not let an older run retire a newer active answer", async () => {
    await runInTx((tx) =>
      persistSeasonal(
        tx,
        seasonalInput({ forecastRunId: newRun, ingestionRunId: newRunIngestion, valueMm: 200 }),
      ),
    );

    const stale = await runInTx((tx) =>
      persistSeasonal(
        tx,
        seasonalInput({
          forecastRunId: oldRun,
          ingestionRunId: olderIngestion,
          valueMm: 50,
          snapshot: hash("d"),
        }),
      ),
    );

    assert.deepEqual(stale, { inserted: 0, superseded: 0, unchanged: 0, skipped: 6 });
    const active = await activeRows();
    assert.ok(active.every((row) => row.forecastRunId === newRun));
    assert.ok(active.every((row) => row.valueMm === 200));
  });

  it("lets a newer run replace an older active answer", async () => {
    await runInTx((tx) =>
      persistSeasonal(tx, seasonalInput({ forecastRunId: oldRun, ingestionRunId: olderIngestion })),
    );

    const replaced = await runInTx((tx) =>
      persistSeasonal(
        tx,
        seasonalInput({ forecastRunId: newRun, ingestionRunId: newRunIngestion, valueMm: 175 }),
      ),
    );

    assert.equal(replaced.inserted, 6);
    assert.equal(replaced.superseded, 6);
    const active = await activeRows();
    assert.ok(active.every((row) => row.forecastRunId === newRun));
    assert.ok(active.every((row) => row.valueMm === 175));
  });

  it("breaks a same-run tie by ingestion time, never by write order", async () => {
    await runInTx((tx) =>
      persistSeasonal(tx, seasonalInput({ forecastRunId: oldRun, ingestionRunId: newerIngestion })),
    );

    // The older conversion of the *same* run arrives last: it has no authority.
    const late = await runInTx((tx) =>
      persistSeasonal(
        tx,
        seasonalInput({
          forecastRunId: oldRun,
          ingestionRunId: olderIngestion,
          valueMm: 42,
          snapshot: hash("e"),
        }),
      ),
    );

    assert.deepEqual(late, { inserted: 0, superseded: 0, unchanged: 0, skipped: 6 });
    assert.ok((await activeRows()).every((row) => row.ingestionRunId === newerIngestion));
  });

  it("may replace a climatology month", async () => {
    const climatology = await runInTx((tx) =>
      persistClimatologyOutlook(tx, {
        provider: PROVIDER,
        model: MODEL,
        cellKey: CELL_KEY,
        variable: "precipitation",
        derivationVersion: "climatology-outlook@1.0.0",
        inputRefs: [
          {
            kind: "baseline",
            role: "climatology",
            purpose: "input",
            baselineVersion: BASELINE_A,
            cellKeys: [CELL_KEY],
            baselineHash: hash("f"),
          },
        ],
        inputSnapshotHash: hash("1"),
        computedAt: new Date("2026-11-24T00:00:00.000Z"),
        months: [
          {
            month: MONTHS[0],
            valueMm: 99,
            baselineVersion: BASELINE_A,
            spreadUnavailableReason: "climatology_has_no_ensemble",
          },
        ],
      }),
    );
    assert.equal(climatology.inserted, 1);

    const promoted = await runInTx((tx) =>
      persistSeasonal(
        tx,
        seasonalInput({ forecastRunId: newRun, ingestionRunId: newRunIngestion }),
      ),
    );

    assert.equal(promoted.inserted, 6);
    assert.equal(promoted.superseded, 1);
    const active = await activeRows();
    assert.equal(active.length, 6);
    assert.ok(active.every((row) => row.dataClass === "seasonal_forecast"));
  });
});

describe("persistClimatologyOutlook — a normal never replaces a forecast", () => {
  it("writes nothing for a month whose active answer is seasonal", async () => {
    await runInTx((tx) =>
      persistSeasonal(
        tx,
        seasonalInput({ forecastRunId: newRun, ingestionRunId: newRunIngestion, valueMm: 210 }),
      ),
    );

    const refused = await runInTx((tx) =>
      persistClimatologyOutlook(tx, {
        provider: PROVIDER,
        model: MODEL,
        cellKey: CELL_KEY,
        variable: "precipitation",
        derivationVersion: "climatology-outlook@1.0.0",
        inputRefs: [
          {
            kind: "baseline",
            role: "climatology",
            purpose: "input",
            baselineVersion: BASELINE_A,
            cellKeys: [CELL_KEY],
            baselineHash: hash("f"),
          },
        ],
        inputSnapshotHash: hash("2"),
        computedAt: new Date("2026-11-24T00:00:00.000Z"),
        months: [
          {
            month: MONTHS[0],
            valueMm: 11,
            baselineVersion: BASELINE_A,
            spreadUnavailableReason: "climatology_has_no_ensemble",
          },
        ],
      }),
    );

    assert.deepEqual(refused, { inserted: 0, superseded: 0, unchanged: 0, skipped: 1 });
    const active = await activeRows();
    assert.equal(active[0].dataClass, "seasonal_forecast");
    assert.equal(active[0].valueMm, 210);
  });
});
