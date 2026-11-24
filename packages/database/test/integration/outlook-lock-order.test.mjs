/**
 * Multi-cell advisory-lock ordering against real PostgreSQL — Phase 5.7A
 * corrective pass.
 *
 * The hazard: `persistClimatologyOutlook` locks one footprint per call, so a
 * worker that loops cell by cell acquires locks in **selector order**. Two jobs
 * holding the same cells in opposite order (`[A,B]` and `[B,A]`) then each hold
 * the key the other needs, which PostgreSQL reports as `40P01`.
 *
 * The fix under test: the whole footprint set is locked in one
 * `lockForecastFootprint` call, which sorts and de-duplicates it, so the order is
 * a property of the lock keys and never of the payload array.
 *
 * The rendezvous between lock acquisition and the writes is deliberate. With the
 * corrected order both transactions hold every key before either writes, so the
 * wait resolves. If per-cell locking came back, both would hold one key, both
 * would reach the rendezvous, and the second key of each would deadlock — which
 * is what makes this a regression test rather than a smoke test.
 *
 * Requires a migrated database and the roles from `pnpm db:bootstrap`.
 * Run: pnpm --filter @agroclimate/database test:integration
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { Client } from "pg";

import {
  configureTransactionTimeouts,
  createPrismaClient,
  lockForecastFootprint,
  persistClimatologyOutlook,
} from "../../dist/index.js";
import { roleConnectionString } from "../../scripts/lib/connections.mjs";

const owner = new Client({ connectionString: roleConnectionString("migration_owner") });
const system = createPrismaClient({ connectionString: roleConnectionString("app_system") });

const token = randomUUID().slice(0, 8);
const PROVIDER = "open-meteo";
const MODEL = `p57al_${token}`;
const CELL_A = `p57al-a-${token}`;
const CELL_B = `p57al-b-${token}`;
const BASELINE = `ERA5:1991-2020:p57al${token}`;
const DERIVATION_VERSION = "climatology-outlook@1.0.0";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const SPREAD_REASON = "climatology_has_no_ensemble";
const COMPUTED_AT = new Date("2026-08-01T00:00:00.000Z");

const MONTHS = ["2027-03-01", "2027-04-01", "2027-05-01", "2027-06-01", "2027-07-01"];

/**
 * A two-party rendezvous that never blocks forever: the second arrival opens the
 * gate, and a party that arrived alone waits at most `timeoutMs`.
 *
 * The timeout is what keeps the corrected path fast (the second transaction is
 * still blocked on the lock) while the broken path still meets at the gate.
 */
function rendezvous(timeoutMs = 400) {
  let arrived = 0;
  let open;
  const gate = new Promise((resolve) => {
    open = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived === 2) open();
    let timer;
    const bounded = new Promise((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    try {
      await Promise.race([gate, bounded]);
    } finally {
      clearTimeout(timer);
    }
  };
}

function inputFor(cellKey, inputSnapshotHash) {
  return {
    provider: PROVIDER,
    model: MODEL,
    cellKey,
    variable: "precipitation",
    derivationVersion: DERIVATION_VERSION,
    inputRefs: [
      {
        kind: "baseline",
        role: "climatology",
        purpose: "input",
        baselineVersion: BASELINE,
        baselineHash: HASH_A,
        cellKeys: [cellKey],
      },
    ],
    inputSnapshotHash,
    computedAt: COMPUTED_AT,
    months: MONTHS.map((month, index) => ({
      month,
      valueMm: 100 + index,
      baselineVersion: BASELINE,
      spreadUnavailableReason: SPREAD_REASON,
    })),
  };
}

/** One job: lock the complete set, then write every cell. */
function materialise(order, inputSnapshotHash, meet) {
  return system.$transaction(
    async (tx) => {
      await configureTransactionTimeouts(tx, {
        lockTimeoutMs: 8_000,
        statementTimeoutMs: 30_000,
      });
      await lockForecastFootprint(
        tx,
        order.map((cellKey) => ({ cellKey, variable: "precipitation" })),
      );
      await meet();
      for (const cellKey of order) {
        await persistClimatologyOutlook(tx, inputFor(cellKey, inputSnapshotHash), {
          footprintLockHeld: true,
        });
      }
    },
    { timeout: 30_000, maxWait: 10_000 },
  );
}

/**
 * Every SQLSTATE candidate a rejection exposes.
 *
 * Prisma wraps a driver error as `P2010` and keeps the real SQLSTATE under
 * `meta.driverAdapterError.cause.originalCode`, so a helper that reads only
 * `error.code` would miss `40P01` and pass a deadlocked run.
 */
function rejectionCodes(result) {
  if (result.status !== "rejected") return [];
  const error = result.reason;
  return [
    error?.code,
    error?.cause?.code,
    error?.meta?.code,
    error?.meta?.driverAdapterError?.cause?.originalCode,
  ].filter((code) => typeof code === "string");
}

async function storedRows() {
  const { rows } = await owner.query(
    `SELECT c.cell_key                       AS "cellKey",
            to_char(o.month, 'YYYY-MM-DD')   AS month,
            o.value_mm                       AS "valueMm",
            o.input_snapshot_hash            AS "inputSnapshotHash",
            o.status,
            o.superseded_by_id::text          AS "supersededById",
            o.id::text                        AS id
       FROM app.monthly_outlooks o
       JOIN app.outlook_cells c ON c.id = o.outlook_cell_id
      WHERE c.provider = $1 AND c.model = $2
      ORDER BY c.cell_key, o.month, o.created_at`,
    [PROVIDER, MODEL],
  );
  return rows;
}

before(async () => {
  await owner.connect();

  await owner.query(
    `INSERT INTO app.climatology_baselines (
       baseline_version, baseline_dataset, provider, model, adapter_version,
       source_reference, attribution, retrieved_at, period_from, period_to,
       algorithm_version, computed_at
     ) VALUES ($1, 'era5', 'open-meteo', 'era5', 'p57al-test@1.0.0', $2, 'test fixture',
               $3::timestamptz, '1991-01-01', '2020-12-31', $4, $3::timestamptz)`,
    [
      BASELINE,
      `https://archive-api.open-meteo.com/v1/archive?p57al=${token}`,
      COMPUTED_AT.toISOString(),
      `p57al${token}`,
    ],
  );

  for (const cellKey of [CELL_A, CELL_B]) {
    const inserted = await owner.query(
      `INSERT INTO app.outlook_cells (provider, model, cell_key)
       VALUES ($1, $2, $3) RETURNING id::text AS id`,
      [PROVIDER, MODEL, cellKey],
    );
    const cellId = inserted.rows[0].id;

    const params = [BASELINE, cellId];
    const values = [];
    for (let index = 0; index < 12; index += 1) {
      const monthParam = params.push(`1991-${String(index + 1).padStart(2, "0")}-01`);
      const valueParam = params.push(100 + index);
      values.push(
        `($1, 'era5', '1991-01-01', '2020-12-31', $2::uuid, $${monthParam}::date, $${valueParam}, 30)`,
      );
    }

    await owner.query(
      `INSERT INTO app.climatology_normals (
         baseline_version, baseline_dataset, period_from, period_to,
         outlook_cell_id, month, value_mm, sample_years
       ) VALUES ${values.join(", ")}`,
      params,
    );
  }
});

after(async () => {
  await owner.query(
    `DELETE FROM app.monthly_outlooks
      WHERE outlook_cell_id IN (
        SELECT id FROM app.outlook_cells WHERE provider = $1 AND model = $2
      )`,
    [PROVIDER, MODEL],
  );
  await owner.query(
    `DELETE FROM app.climatology_normals
      WHERE outlook_cell_id IN (
        SELECT id FROM app.outlook_cells WHERE provider = $1 AND model = $2
      )`,
    [PROVIDER, MODEL],
  );
  await owner.query(`DELETE FROM app.climatology_baselines WHERE baseline_version = $1`, [
    BASELINE,
  ]);
  await owner.query(`DELETE FROM app.outlook_cells WHERE provider = $1 AND model = $2`, [
    PROVIDER,
    MODEL,
  ]);

  await owner.end();
  await system.$disconnect();
});

describe("outlook materialisation — multi-cell lock ordering", () => {
  it("serialises reverse-order selectors without a deadlock", { timeout: 60_000 }, async () => {
    const meet = rendezvous();

    const results = await Promise.allSettled([
      materialise([CELL_A, CELL_B], HASH_A, meet),
      materialise([CELL_B, CELL_A], HASH_A, meet),
    ]);

    for (const result of results) {
      assert.ok(
        !rejectionCodes(result).includes("40P01"),
        `no transaction may deadlock: ${rejectionCodes(result).join(", ")}`,
      );
      assert.equal(result.status, "fulfilled", String(result.reason ?? ""));
    }

    const rows = await storedRows();
    const active = rows.filter((row) => row.status === "active");
    assert.equal(active.length, 10, "five months × two cells");
    assert.ok(
      active.every((row) => row.inputSnapshotHash === HASH_A),
      "both jobs agreed on the snapshot, so nothing is superseded",
    );
    assert.equal(rows.length, 10, "an identical derivation wrote no second row");
  });

  it(
    "keeps one active row per cell-month when the writers disagree",
    { timeout: 60_000 },
    async () => {
      const meet = rendezvous();

      const results = await Promise.allSettled([
        materialise([CELL_A, CELL_B], HASH_B, meet),
        materialise([CELL_B, CELL_A], HASH_A, meet),
      ]);

      for (const result of results) {
        assert.ok(
          !rejectionCodes(result).includes("40P01"),
          `no transaction may deadlock: ${rejectionCodes(result).join(", ")}`,
        );
        assert.equal(result.status, "fulfilled", String(result.reason ?? ""));
      }

      const rows = await storedRows();
      const active = rows.filter((row) => row.status === "active");

      const perSlot = new Map();
      for (const row of active) {
        const key = `${row.cellKey}|${row.month}`;
        perSlot.set(key, (perSlot.get(key) ?? 0) + 1);
      }
      assert.equal(perSlot.size, 10, "every cell-month has a live answer");
      assert.ok(
        [...perSlot.values()].every((count) => count === 1),
        "exactly one active row",
      );

      // Serialisation, not interleaving: the losing job must be retired as a whole,
      // so every live row carries the same snapshot. A partial supersession would
      // show two hashes among the active rows of one job.
      const liveHashes = new Set(active.map((row) => row.inputSnapshotHash));
      assert.equal(liveHashes.size, 1, "one job won every cell, not a mixture");
      const winner = [...liveHashes][0];
      assert.ok(winner === HASH_A || winner === HASH_B);

      // The supersession chain still points at rows that exist, and no superseded
      // row is an orphan or a live row's predecessor with a missing successor.
      const byId = new Map(rows.map((row) => [row.id, row]));
      const superseded = rows.filter((row) => row.status === "superseded");
      assert.ok(superseded.length > 0, "the losing derivation was retired, not deleted");
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
    },
  );
});
