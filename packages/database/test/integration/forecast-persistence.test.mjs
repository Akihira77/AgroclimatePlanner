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
async function seedIngestion({ initializedAt }) {
  const run = await upsertForecastRun(system, {
    provider,
    model,
    product: "forecast",
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
      ingestion_version, status
    )
    VALUES (${run.id}::uuid, 'test-adapter@1', 'test-normalizer@1',
            ${hash("selector")}, ${hash("version")}, 'running')
    RETURNING id::text AS "id", created_at AS "createdAt"
  `;
  assert.ok(rows[0]);
  return { run, ingestionRunId: rows[0].id, ingestionCreatedAt: rows[0].createdAt };
}

function persistInput(seed, records) {
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
  await owner.query("DELETE FROM app.weather_records WHERE model = $1", [model]);
  await owner.query(
    "DELETE FROM app.ingestion_runs WHERE forecast_run_id IN (SELECT id FROM app.forecast_runs WHERE provider = $1 AND model = $2)",
    [provider, model],
  );
  await owner.query("DELETE FROM app.forecast_runs WHERE provider = $1 AND model = $2", [
    provider,
    model,
  ]);
  await owner.query("DELETE FROM app.outlook_cells WHERE provider = $1 AND model = $2", [
    provider,
    model,
  ]);
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
