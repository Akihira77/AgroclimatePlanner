/**
 * Forecast persistence against real PostgreSQL: the horizon is made of values
 * (F-01) and overlapping writers from different forecast runs serialise (F-03).
 *
 * Every case uses `app_system` for the write and `migration_owner` only to seed
 * and read back, which mirrors the worker's real role. The concurrency cases
 * are two live transactions on two connections — never a simulation.
 *
 * Requires a migrated database and the roles from `pnpm db:bootstrap`.
 * Run: pnpm --filter @agroclimate/database test:integration
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { Client } from "pg";

import {
  createPrismaClient,
  lockForecastWriteScope,
  persistForecastRun,
  upsertForecastRun,
} from "../../dist/index.js";
import { roleConnectionString } from "../../scripts/lib/connections.mjs";

const owner = new Client({ connectionString: roleConnectionString("migration_owner") });
const system = createPrismaClient({ connectionString: roleConnectionString("app_system") });
/** One connection each, so two transactions are genuinely concurrent. */
const laneA = createPrismaClient({
  connectionString: roleConnectionString("app_system"),
  poolMax: 1,
});
const laneB = createPrismaClient({
  connectionString: roleConnectionString("app_system"),
  poolMax: 1,
});

const token = randomUUID().slice(0, 8);
const provider = "open-meteo";
const model = `phase54_persist_${token}`;
/** Two more suite-private runs for the cross-product key regression (finding 3). */
const EC46_MODEL = `phase56_persist_ec46_${token}`;
const SEAS5_MODEL = `phase56_persist_seas5_${token}`;
const CLEANUP_MODELS = [model, EC46_MODEL, SEAS5_MODEL];
/** Suite-private coordinates and instants: no other suite can share a slot. */
const CELL = `p54-${token}-a`;
const OTHER_CELL = `p54-${token}-b`;
const TODAY = new Date("2027-01-01T00:00:00.000Z");
const DAY_MS = 86_400_000;

function recordsFor(values, { cellKey = CELL, member = null, startIndex = 0 } = {}) {
  return values.map((value, offset) => {
    const index = startIndex + offset;
    return {
      cellKey,
      variable: "precipitation",
      unit: "mm",
      validAt: new Date(TODAY.getTime() + index * DAY_MS),
      value,
      temporalResolution: "daily",
      ensembleMember: member,
      ensembleSize: member === null ? null : 50,
      aggregationLevel: "daily_sum",
      requestedLat: -6.25,
      requestedLon: 106.75,
      servedLat: -6.27,
      servedLon: 106.77,
      servedValueIsInterpolated: false,
      spatialResolutionKm: 28,
      sourceUrl: null,
      attribution: "test fixture",
    };
  });
}

let runCounter = 0;

/** A forecast run plus one running ingestion row, ready for `persistForecastRun`. */
async function seedIngestion({
  initializedAt,
  runModel = model,
  product = "forecast",
  ingestionCreatedAt,
  normalizerVersion = "test-normalizer@1",
}) {
  const run = await upsertForecastRun(system, {
    provider,
    model: runModel,
    product,
    initializedAt,
    horizonEnd: new Date(initializedAt.getTime() + 3_600_000),
    receivedAt: new Date(initializedAt.getTime() + 60_000),
  });
  runCounter += 1;
  const hash = (label) =>
    createHash("sha256").update(`${label}:${token}:${runCounter}`).digest("hex");
  const rows = await system.$queryRaw`
    INSERT INTO app.ingestion_runs (
      forecast_run_id, adapter_version, normalizer_version, target_selector_hash,
      ingestion_version, status, created_at
    )
    VALUES (${run.id}::uuid, 'test-adapter@1', ${normalizerVersion},
            ${hash("selector")}, ${hash("version")}, 'running',
            COALESCE(${ingestionCreatedAt ?? null}::timestamptz, now()))
    RETURNING id::text AS "id", created_at AS "createdAt"
  `;
  assert.ok(rows[0]);
  return { run, ingestionRunId: rows[0].id, ingestionCreatedAt: rows[0].createdAt };
}

function persistInput(seed, records, overrides = {}) {
  return {
    forecastRunId: seed.run.id,
    ingestionRunId: seed.ingestionRunId,
    provider,
    model,
    product: "forecast",
    dataClass: "weather_forecast",
    initializedAt: seed.run.initializedAt,
    ingestionCreatedAt: seed.ingestionCreatedAt,
    normalizerVersion: "test-normalizer@1",
    records,
    ...overrides,
  };
}

async function horizonOf(runId) {
  const rows = await owner.query("SELECT horizon_end FROM app.forecast_runs WHERE id = $1::uuid", [
    runId,
  ]);
  return rows.rows[0].horizon_end;
}

async function liveRows(runId) {
  const rows = await owner.query(
    `SELECT cell_key, valid_at, value, superseded_by_id
       FROM app.weather_records
      WHERE forecast_run_id = $1::uuid AND superseded_at IS NULL
      ORDER BY cell_key, valid_at`,
    [runId],
  );
  return rows.rows;
}

async function countRecords(runId) {
  const rows = await owner.query(
    "SELECT count(*)::int AS n FROM app.weather_records WHERE forecast_run_id = $1::uuid",
    [runId],
  );
  return rows.rows[0].n;
}

/** Poll `pg_locks` for an ungranted advisory lock inside this database. */
async function advisoryWaiterCount() {
  const rows = await owner.query(
    `SELECT count(*)::int AS n FROM pg_locks l
      JOIN pg_database d ON d.oid = l.database
     WHERE l.locktype = 'advisory' AND NOT l.granted AND d.datname = current_database()`,
  );
  return rows.rows[0].n;
}

async function waitForAdvisoryWaiter() {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await advisoryWaiterCount()) > 0) return true;
    await sleep(20);
  }
  return false;
}

before(async () => {
  await owner.connect();
});

after(async () => {
  for (const runModel of CLEANUP_MODELS) {
    await owner.query("DELETE FROM app.weather_records WHERE model = $1", [runModel]);
    await owner.query(
      "DELETE FROM app.ingestion_runs WHERE forecast_run_id IN (SELECT id FROM app.forecast_runs WHERE provider = $1 AND model = $2)",
      [provider, runModel],
    );
    await owner.query("DELETE FROM app.forecast_runs WHERE provider = $1 AND model = $2", [
      provider,
      runModel,
    ]);
    await owner.query("DELETE FROM app.outlook_cells WHERE provider = $1 AND model = $2", [
      provider,
      runModel,
    ]);
  }
  await owner.end();
  await Promise.all([system.$disconnect(), laneA.$disconnect(), laneB.$disconnect()]);
});

describe("persistForecastRun — the horizon is made of values (F-01)", () => {
  it("ends the horizon on the last valued instant, not on the last row", async () => {
    const seed = await seedIngestion({ initializedAt: new Date(TODAY.getTime() + 0) });
    const values = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, null, null, null, null, null];

    const result = await system.$transaction((tx) =>
      persistForecastRun(tx, persistInput(seed, recordsFor(values))),
    );

    const expected = new Date(TODAY.getTime() + 9 * DAY_MS);
    assert.equal(result.inserted, 15, "every row is persisted, null days included");
    assert.equal(result.horizonEnd.toISOString(), expected.toISOString());
    assert.equal((await horizonOf(seed.run.id)).toISOString(), expected.toISOString());
  });

  it("preserves a null day inside the horizon and still counts it as a row", async () => {
    const seed = await seedIngestion({ initializedAt: new Date(TODAY.getTime() + DAY_MS) });
    const values = Array.from({ length: 15 }, (_, index) => (index === 5 ? null : 0.4));

    const result = await system.$transaction((tx) =>
      persistForecastRun(tx, persistInput(seed, recordsFor(values))),
    );

    assert.equal(result.inserted, 15);
    assert.equal(await countRecords(seed.run.id), 15);
    const nullDay = await owner.query(
      `SELECT value FROM app.weather_records
        WHERE forecast_run_id = $1::uuid AND valid_at = $2`,
      [seed.run.id, new Date(TODAY.getTime() + 5 * DAY_MS)],
    );
    assert.equal(nullDay.rows[0].value, null);
    assert.equal(
      (await horizonOf(seed.run.id)).toISOString(),
      new Date(TODAY.getTime() + 14 * DAY_MS).toISOString(),
    );
  });

  it("persists an all-null ingestion without moving the horizon", async () => {
    const initializedAt = new Date(TODAY.getTime() + 2 * DAY_MS);
    const seed = await seedIngestion({ initializedAt });
    const initial = await horizonOf(seed.run.id);

    const result = await system.$transaction((tx) =>
      persistForecastRun(
        tx,
        persistInput(seed, recordsFor(Array.from({ length: 15 }, () => null))),
      ),
    );

    assert.equal(result.inserted, 15, "null evidence is still stored");
    assert.equal(result.horizonEnd.toISOString(), initial.toISOString());
    assert.equal((await horizonOf(seed.run.id)).toISOString(), initial.toISOString());
  });

  it("never shrinks: a later all-null ingestion leaves a valued horizon alone", async () => {
    const seed = await seedIngestion({ initializedAt: new Date(TODAY.getTime() + 3 * DAY_MS) });
    const valued = Array.from({ length: 15 }, (_, index) => (index < 15 ? index / 10 : null));
    await system.$transaction((tx) =>
      persistForecastRun(tx, persistInput(seed, recordsFor(valued))),
    );
    const afterValued = await horizonOf(seed.run.id);

    // A second ingestion in the same run may move to the last *valued* instant.
    const tailNull = Array.from({ length: 15 }, (_, index) => (index < 3 ? 0.1 : null));
    await system.$transaction((tx) =>
      persistForecastRun(tx, persistInput(seed, recordsFor(tailNull))),
    );

    assert.equal((await horizonOf(seed.run.id)).toISOString(), afterValued.toISOString());
  });

  it("keeps each run's horizon on its own valued tail", async () => {
    const older = await seedIngestion({ initializedAt: new Date(TODAY.getTime() + 4 * DAY_MS) });
    const newer = await seedIngestion({ initializedAt: new Date(TODAY.getTime() + 5 * DAY_MS) });
    const olderValues = Array.from({ length: 15 }, () => 0.2);
    const newerValues = Array.from({ length: 15 }, (_, index) => (index <= 10 ? 0.3 : null));

    await system.$transaction((tx) =>
      persistForecastRun(tx, persistInput(newer, recordsFor(newerValues))),
    );
    const newerHorizon = await horizonOf(newer.run.id);
    assert.equal(newerHorizon.toISOString(), new Date(TODAY.getTime() + 10 * DAY_MS).toISOString());

    await system.$transaction((tx) =>
      persistForecastRun(tx, persistInput(older, recordsFor(olderValues))),
    );

    assert.equal(
      (await horizonOf(older.run.id)).toISOString(),
      new Date(TODAY.getTime() + 14 * DAY_MS).toISOString(),
    );
    assert.equal(
      (await horizonOf(newer.run.id)).toISOString(),
      newerHorizon.toISOString(),
      "the newer run's horizon is not written by the older run",
    );
  });
});

describe("lockForecastWriteScope — overlapping footprints serialise (F-03)", () => {
  it("keeps only the newer run live when the newer writer commits first", async () => {
    const older = await seedIngestion({ initializedAt: new Date(TODAY.getTime() + 6 * DAY_MS) });
    const newer = await seedIngestion({ initializedAt: new Date(TODAY.getTime() + 7 * DAY_MS) });
    const values = Array.from({ length: 15 }, () => 0.5);
    const footprints = [{ cellKey: CELL, variable: "precipitation" }];

    let releaseNewer;
    const newerHolds = new Promise((resolve) => {
      releaseNewer = resolve;
    });
    let newerLocked;
    const newerHasLock = new Promise((resolve) => {
      newerLocked = resolve;
    });

    const newerTx = laneA.$transaction(async (tx) => {
      await lockForecastWriteScope(tx, { forecastRunId: newer.run.id, footprints });
      newerLocked();
      await newerHolds;
      await persistForecastRun(tx, persistInput(newer, recordsFor(values)));
    });

    await newerHasLock;

    const olderTx = laneB.$transaction(async (tx) => {
      await lockForecastWriteScope(tx, { forecastRunId: older.run.id, footprints });
      await persistForecastRun(tx, persistInput(older, recordsFor(values)));
    });

    // The older transaction must be waiting on the footprint, not proceeding in
    // parallel — that is the whole point of the lock.
    assert.equal(await waitForAdvisoryWaiter(), true, "the older writer must block");
    const blockedEarly = await Promise.race([
      olderTx.then(() => "finished"),
      sleep(150).then(() => "blocked"),
    ]);
    assert.equal(blockedEarly, "blocked");

    releaseNewer();
    await Promise.all([newerTx, olderTx]);

    assert.equal((await liveRows(newer.run.id)).length, 15);
    assert.equal((await liveRows(older.run.id)).length, 0, "the older run must not stay live");
  });

  it("keeps only the newer run live when the older writer commits first", async () => {
    const older = await seedIngestion({ initializedAt: new Date(TODAY.getTime() + 8 * DAY_MS) });
    const newer = await seedIngestion({ initializedAt: new Date(TODAY.getTime() + 9 * DAY_MS) });
    const values = Array.from({ length: 15 }, () => 0.6);
    const footprints = [{ cellKey: CELL, variable: "precipitation" }];

    await system.$transaction(async (tx) => {
      await lockForecastWriteScope(tx, { forecastRunId: older.run.id, footprints });
      await persistForecastRun(tx, persistInput(older, recordsFor(values)));
    });
    await system.$transaction(async (tx) => {
      await lockForecastWriteScope(tx, { forecastRunId: newer.run.id, footprints });
      await persistForecastRun(tx, persistInput(newer, recordsFor(values)));
    });

    assert.equal((await liveRows(newer.run.id)).length, 15);
    assert.equal((await liveRows(older.run.id)).length, 0);
  });

  it("does not block writers of disjoint cells", async () => {
    const a = await seedIngestion({ initializedAt: new Date(TODAY.getTime() + 10 * DAY_MS) });
    const b = await seedIngestion({ initializedAt: new Date(TODAY.getTime() + 11 * DAY_MS) });
    const values = Array.from({ length: 15 }, () => 0.7);

    let releaseA;
    const aHolds = new Promise((resolve) => {
      releaseA = resolve;
    });

    const txA = laneA.$transaction(async (tx) => {
      await lockForecastWriteScope(tx, {
        forecastRunId: a.run.id,
        footprints: [{ cellKey: CELL, variable: "precipitation" }],
      });
      await aHolds;
      await persistForecastRun(tx, persistInput(a, recordsFor(values, { cellKey: CELL })));
    });

    await sleep(100);

    // B writes another cell and must finish while A is still uncommitted.
    const txB = laneB.$transaction(async (tx) => {
      await lockForecastWriteScope(tx, {
        forecastRunId: b.run.id,
        footprints: [{ cellKey: OTHER_CELL, variable: "precipitation" }],
      });
      await persistForecastRun(tx, persistInput(b, recordsFor(values, { cellKey: OTHER_CELL })));
    });

    const finished = await Promise.race([
      txB.then(() => "finished"),
      sleep(2_000).then(() => "blocked"),
    ]);
    assert.equal(finished, "finished", "disjoint cells must not serialise");

    releaseA();
    await txA;
    assert.equal((await liveRows(a.run.id)).length, 15);
    assert.equal((await liveRows(b.run.id)).length, 15);
  });

  it("takes multiple footprints in one sorted order, so reversed writers do not deadlock", async () => {
    const a = await seedIngestion({ initializedAt: new Date(TODAY.getTime() + 12 * DAY_MS) });
    const b = await seedIngestion({ initializedAt: new Date(TODAY.getTime() + 13 * DAY_MS) });
    const values = Array.from({ length: 15 }, () => 0.8);
    const records = [
      ...recordsFor(values, { cellKey: CELL }),
      ...recordsFor(values, { cellKey: OTHER_CELL }),
    ];
    const forward = [
      { cellKey: CELL, variable: "precipitation" },
      { cellKey: OTHER_CELL, variable: "precipitation" },
    ];
    const reversed = [...forward].reverse();

    // Two transactions, opposite declaration order, overlapping set. Sorted
    // acquisition is the only reason this cannot deadlock.
    const results = await Promise.allSettled([
      laneA.$transaction(async (tx) => {
        await lockForecastWriteScope(tx, { forecastRunId: a.run.id, footprints: forward });
        await persistForecastRun(tx, persistInput(a, records));
      }),
      laneB.$transaction(async (tx) => {
        await lockForecastWriteScope(tx, { forecastRunId: b.run.id, footprints: reversed });
        await persistForecastRun(tx, persistInput(b, records));
      }),
    ]);

    for (const result of results) {
      assert.equal(result.status, "fulfilled", String(result.reason ?? ""));
    }

    const liveA = await liveRows(a.run.id);
    const liveB = await liveRows(b.run.id);
    assert.equal(liveA.length + liveB.length, 30, "one live set of 30 rows, never two");
    assert.equal(liveB.length, 30, "the newer run owns every slot");
    assert.equal(liveA.length, 0);
  });

  it("leaves no supersession cycle and no dangling superseded_by reference", async () => {
    const seed = await seedIngestion({ initializedAt: new Date(TODAY.getTime() + 14 * DAY_MS) });
    const values = Array.from({ length: 15 }, () => 0.9);
    await system.$transaction((tx) =>
      persistForecastRun(tx, persistInput(seed, recordsFor(values))),
    );
    await system.$transaction((tx) =>
      persistForecastRun(tx, persistInput(seed, recordsFor(values))),
    );

    const cycles = await owner.query(
      `WITH RECURSIVE walk(id, start_id, depth) AS (
         SELECT supersedes_id, id, 1
           FROM app.weather_records
          WHERE forecast_run_id = $1::uuid AND supersedes_id IS NOT NULL
         UNION ALL
         SELECT w.supersedes_id, walk.start_id, walk.depth + 1
           FROM walk JOIN app.weather_records w ON w.id = walk.id
          WHERE w.supersedes_id IS NOT NULL AND walk.depth < 10
       )
       SELECT count(*)::int AS n FROM walk WHERE id = start_id`,
      [seed.run.id],
    );
    assert.equal(cycles.rows[0].n, 0, "supersedes_id must be acyclic");

    const dangling = await owner.query(
      `SELECT count(*)::int AS n
         FROM app.weather_records w
        WHERE w.forecast_run_id = $1::uuid
          AND w.superseded_by_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM app.weather_records n
             WHERE n.id = w.superseded_by_id AND n.superseded_at IS NULL
          )`,
      [seed.run.id],
    );
    assert.equal(dangling.rows[0].n, 0, "every superseded row points at a live row");
  });
});

/**
 * The live natural key is `(forecast_run_id, cell_key, variable, valid_at,
 * ensemble_member)` and supersession matches on `(cell_key, variable, valid_at,
 * ensemble_member)` across runs, models and products. EC46 stores a daily member
 * value as `precipitation`; the SEAS5 aggregate stores its monthly total as
 * `precipitation_sum`. This block pins that the two coexist on the same instant
 * and member index, and that a re-normalisation of one never touches the other.
 */
describe("cross-product member identity — the variable is part of the key", () => {
  const CELL_A = `p56-${token}-a`;
  const CELL_B = `p56-${token}-b`;
  const AT = new Date("2027-03-01T00:00:00.000Z");

  function ec46MemberRecord(cellKey, validAt, overrides = {}) {
    return {
      cellKey,
      variable: "precipitation",
      unit: "mm",
      validAt,
      value: 3.2,
      temporalResolution: "daily",
      ensembleMember: 7,
      ensembleSize: 50,
      aggregationLevel: "daily_sum",
      requestedLat: -6.25,
      requestedLon: 106.75,
      servedLat: -6.27,
      servedLon: 106.77,
      servedValueIsInterpolated: false,
      spatialResolutionKm: 36,
      sourceUrl: "https://seasonal-api.open-meteo.com/v1/seasonal?models=ecmwf_ec46",
      attribution: "ECMWF / Open-Meteo, CC BY 4.0",
      normalizerVersion: "daily-precipitation@1.0.0",
      ...overrides,
    };
  }

  function seas5AggregateRecord(cellKey, validAt, overrides = {}) {
    return {
      cellKey,
      variable: "precipitation_sum",
      unit: "mm",
      validAt,
      value: 21.7,
      temporalResolution: "monthly",
      ensembleMember: 7,
      ensembleSize: 50,
      aggregationLevel: "monthly_sum",
      requestedLat: -6.25,
      requestedLon: 106.75,
      servedLat: -6.125,
      servedLon: 106.875,
      servedValueIsInterpolated: false,
      spatialResolutionKm: 36,
      sourceUrl: "https://seasonal-api.open-meteo.com/v1/seasonal?models=ecmwf_seas5",
      attribution: "ECMWF / Open-Meteo, CC BY 4.0",
      normalizerVersion: "monthly-member-aggregation@1.0.0",
      ...overrides,
    };
  }

  async function provenanceOf(runId) {
    const rows = await owner.query(
      `SELECT id::text AS id, variable, model, data_class, temporal_resolution,
              aggregation_level, ensemble_member, value, normalizer_version,
              superseded_at IS NULL AS live, superseded_by_id::text AS "supersededById"
         FROM app.weather_records
        WHERE forecast_run_id = $1::uuid
        ORDER BY created_at, id`,
      [runId],
    );
    return rows.rows;
  }

  async function persistInto(seed, records, overrides) {
    return system.$transaction(async (tx) => {
      // `persistForecastRun` requires the caller to hold the write scope. One
      // footprint per `(cellKey, variable)` is the same derivation the worker
      // uses; `lockForecastFootprint` de-duplicates and sorts the keys.
      await lockForecastWriteScope(tx, {
        forecastRunId: seed.run.id,
        footprints: records.map(({ cellKey, variable }) => ({ cellKey, variable })),
      });
      return persistForecastRun(tx, persistInput(seed, records, overrides));
    });
  }

  it("keeps an EC46 member row and a SEAS5 aggregate live on the same instant", async () => {
    const ec46 = await seedIngestion({
      initializedAt: new Date(AT.getTime() - 2 * DAY_MS),
      runModel: EC46_MODEL,
      product: "seasonal",
      normalizerVersion: "daily-precipitation@1.0.0",
    });
    const seas5 = await seedIngestion({
      initializedAt: new Date(AT.getTime() - DAY_MS),
      runModel: SEAS5_MODEL,
      product: "seasonal",
      normalizerVersion: "monthly-normalizer@1.0.0",
    });

    await persistInto(ec46, [ec46MemberRecord(CELL_A, AT)], {
      model: EC46_MODEL,
      product: "seasonal",
      dataClass: "subseasonal_forecast",
    });
    await persistInto(seas5, [seas5AggregateRecord(CELL_A, AT)], {
      model: SEAS5_MODEL,
      product: "seasonal",
      dataClass: "seasonal_forecast",
    });

    const ec46Rows = await provenanceOf(ec46.run.id);
    const seas5Rows = await provenanceOf(seas5.run.id);
    assert.equal(ec46Rows.length, 1);
    assert.equal(seas5Rows.length, 1);

    // Neither row was superseded by the other: the variables differ, so the key
    // does not collide even though cell, instant and member index are identical.
    assert.equal(ec46Rows[0].live, true, "EC46 row must stay live");
    assert.equal(seas5Rows[0].live, true, "SEAS5 aggregate must stay live");

    // Every provenance field survived the write.
    assert.deepEqual(
      {
        variable: ec46Rows[0].variable,
        model: ec46Rows[0].model,
        dataClass: ec46Rows[0].data_class,
        temporalResolution: ec46Rows[0].temporal_resolution,
        aggregationLevel: ec46Rows[0].aggregation_level,
        member: ec46Rows[0].ensemble_member,
        normalizerVersion: ec46Rows[0].normalizer_version,
      },
      {
        variable: "precipitation",
        model: EC46_MODEL,
        dataClass: "subseasonal_forecast",
        temporalResolution: "daily",
        aggregationLevel: "daily_sum",
        member: 7,
        normalizerVersion: "daily-precipitation@1.0.0",
      },
    );
    assert.deepEqual(
      {
        variable: seas5Rows[0].variable,
        model: seas5Rows[0].model,
        dataClass: seas5Rows[0].data_class,
        temporalResolution: seas5Rows[0].temporal_resolution,
        aggregationLevel: seas5Rows[0].aggregation_level,
        member: seas5Rows[0].ensemble_member,
        normalizerVersion: seas5Rows[0].normalizer_version,
      },
      {
        variable: "precipitation_sum",
        model: SEAS5_MODEL,
        dataClass: "seasonal_forecast",
        temporalResolution: "monthly",
        aggregationLevel: "monthly_sum",
        member: 7,
        normalizerVersion: "monthly-member-aggregation@1.0.0",
      },
    );
    // The row-level version overrides the ingestion's default for that row only.
    const runs = await owner.query(
      "SELECT normalizer_version FROM app.ingestion_runs WHERE id = $1::uuid",
      [seas5.ingestionRunId],
    );
    assert.equal(runs.rows[0].normalizer_version, "monthly-normalizer@1.0.0");
  });

  it("re-normalises each product without touching the other's live row", async () => {
    const ec46 = await seedIngestion({
      initializedAt: new Date(AT.getTime() - 4 * DAY_MS),
      runModel: EC46_MODEL,
      product: "seasonal",
      normalizerVersion: "daily-precipitation@1.0.0",
    });
    const seas5 = await seedIngestion({
      initializedAt: new Date(AT.getTime() - 3 * DAY_MS),
      runModel: SEAS5_MODEL,
      product: "seasonal",
      normalizerVersion: "monthly-normalizer@1.0.0",
    });

    await persistInto(ec46, [ec46MemberRecord(CELL_B, AT, { value: 1.1 })], {
      model: EC46_MODEL,
      product: "seasonal",
      dataClass: "subseasonal_forecast",
    });
    await persistInto(seas5, [seas5AggregateRecord(CELL_B, AT, { value: 10.5 })], {
      model: SEAS5_MODEL,
      product: "seasonal",
      dataClass: "seasonal_forecast",
    });

    const ec46First = (await provenanceOf(ec46.run.id))[0];
    const seas5First = (await provenanceOf(seas5.run.id))[0];
    assert.ok(ec46First.id);
    assert.ok(seas5First.id);

    // Same forecast run, new ingestion run: this is how a normalizer bump
    // arrives. The newer ingestion outranks the older one of *its own* variable.
    const seas5Renorm = await seedIngestion({
      initializedAt: seas5.run.initializedAt,
      runModel: SEAS5_MODEL,
      product: "seasonal",
      normalizerVersion: "monthly-normalizer@1.0.1",
      ingestionCreatedAt: new Date(seas5.ingestionCreatedAt.getTime() + 60_000),
    });
    await persistInto(seas5Renorm, [seas5AggregateRecord(CELL_B, AT, { value: 11.5 })], {
      model: SEAS5_MODEL,
      product: "seasonal",
      dataClass: "seasonal_forecast",
    });

    const seas5After = await provenanceOf(seas5.run.id);
    assert.equal(seas5After.length, 2, "the predecessor is kept, not deleted");
    assert.equal(seas5After.filter((row) => row.live).length, 1);
    const seas5Live = seas5After.find((row) => row.live);
    assert.equal(seas5Live.value, 11.5);
    // The row names the aggregation algorithm, not the ingestion's normalizer.
    assert.equal(seas5Live.normalizer_version, "monthly-member-aggregation@1.0.0");
    assert.equal(seas5After.find((row) => !row.live).id, seas5First.id);
    assert.equal(
      seas5After.find((row) => !row.live).supersededById,
      seas5Live.id,
      "the old aggregate points at the new one",
    );

    const ec46Untouched = await provenanceOf(ec46.run.id);
    assert.equal(ec46Untouched.length, 1, "SEAS5 re-normalisation wrote no EC46 row");
    assert.equal(ec46Untouched[0].id, ec46First.id);
    assert.equal(ec46Untouched[0].live, true);
    assert.equal(ec46Untouched[0].value, 1.1);

    // And the reverse direction: re-normalising EC46 leaves the SEAS5 row alone.
    const ec46Renorm = await seedIngestion({
      initializedAt: ec46.run.initializedAt,
      runModel: EC46_MODEL,
      product: "seasonal",
      normalizerVersion: "daily-precipitation@1.0.1",
      ingestionCreatedAt: new Date(ec46.ingestionCreatedAt.getTime() + 60_000),
    });
    await persistInto(ec46Renorm, [ec46MemberRecord(CELL_B, AT, { value: 1.3 })], {
      model: EC46_MODEL,
      product: "seasonal",
      dataClass: "subseasonal_forecast",
    });

    const ec46After = await provenanceOf(ec46.run.id);
    assert.equal(ec46After.length, 2);
    assert.equal(ec46After.filter((row) => row.live).length, 1);
    assert.equal(ec46After.find((row) => row.live).value, 1.3);
    assert.equal(ec46After.find((row) => !row.live).id, ec46First.id);

    const seas5Still = await provenanceOf(seas5.run.id);
    assert.equal(seas5Still.filter((row) => row.live).length, 1);
    assert.equal(seas5Still.find((row) => row.live).id, seas5Live.id);
    assert.equal(seas5Still.find((row) => row.live).value, 11.5);
  });
});
