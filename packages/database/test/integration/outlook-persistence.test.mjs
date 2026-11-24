/**
 * `app.monthly_outlooks` persistence against real PostgreSQL — Phase 5.7A.
 *
 * Writes run as `app_system` (the worker's real role) inside one transaction; the
 * assertions read back as `migration_owner`. `app_api` is exercised against the
 * same table to prove the write refusal is a privilege, not a convention.
 *
 * Requires a migrated database and the roles from `pnpm db:bootstrap`.
 * Run: pnpm --filter @agroclimate/database test:integration
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { Client } from "pg";

import { createPrismaClient, persistClimatologyOutlook } from "../../dist/index.js";
import { roleConnectionString } from "../../scripts/lib/connections.mjs";

const owner = new Client({ connectionString: roleConnectionString("migration_owner") });
const api = new Client({ connectionString: roleConnectionString("app_api") });
const system = createPrismaClient({ connectionString: roleConnectionString("app_system") });

const token = randomUUID().slice(0, 8);
const PROVIDER = "open-meteo";
const MODEL = `p57a_${token}`;
const CELL_KEY = `p57a-${token}`;
const BASELINE_A = `ERA5:1991-2020:p57a${token}a`;
const BASELINE_B = `ERA5:1991-2020:p57a${token}b`;
const DERIVATION_VERSION = "climatology-outlook@1.0.0";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const SPREAD_REASON = "climatology_has_no_ensemble";
const COMPUTED_AT = new Date("2026-08-01T00:00:00.000Z");

let cellId;

/** The five months lead 8–12 describe when lead 1 is 2026-08. */
const PERSISTED_MONTHS = [
  { month: "2027-03-01", valueMm: 102 },
  { month: "2027-04-01", valueMm: 103 },
  { month: "2027-05-01", valueMm: 104 },
  { month: "2027-06-01", valueMm: 105 },
  { month: "2027-07-01", valueMm: 106 },
];

function sourceReference() {
  return `https://archive-api.open-meteo.com/v1/archive?models=era5&p57a=${token}`;
}

async function insertBaseline(version) {
  await owner.query(
    `INSERT INTO app.climatology_baselines (
       baseline_version, baseline_dataset, provider, model, adapter_version,
       source_reference, attribution, retrieved_at, period_from, period_to,
       algorithm_version, computed_at
     ) VALUES ($1, 'era5', 'open-meteo', 'era5', 'p57a-test@1.0.0', $2, 'test fixture',
               $3::timestamptz, '1991-01-01', '2020-12-31', $4, $3::timestamptz)`,
    [version, sourceReference(), COMPUTED_AT.toISOString(), `p57a${token}`],
  );

  const values = [];
  const params = [version, cellId];
  for (let index = 0; index < 12; index += 1) {
    const offset = params.length;
    values.push(
      `($1, 'era5', '1991-01-01', '2020-12-31', $2::uuid, $${offset + 1}::date, $${offset + 2}, 30)`,
    );
    params.push(`1991-${String(index + 1).padStart(2, "0")}-01`, 100 + index);
  }
  await owner.query(
    `INSERT INTO app.climatology_normals (
       baseline_version, baseline_dataset, period_from, period_to,
       outlook_cell_id, month, value_mm, sample_years
     ) VALUES ${values.join(", ")}`,
    params,
  );
}

function input(overrides = {}) {
  const months = PERSISTED_MONTHS.map((month) => ({
    ...month,
    baselineVersion: BASELINE_A,
    spreadUnavailableReason: SPREAD_REASON,
  }));
  const baselineVersion = overrides.baselineVersion ?? BASELINE_A;
  return {
    provider: PROVIDER,
    model: MODEL,
    cellKey: CELL_KEY,
    variable: "precipitation",
    derivationVersion: DERIVATION_VERSION,
    inputRefs: [
      {
        kind: "baseline",
        role: "climatology",
        purpose: "input",
        baselineVersion,
        baselineHash: HASH_A,
        cellKeys: [CELL_KEY],
      },
    ],
    inputSnapshotHash: HASH_A,
    computedAt: COMPUTED_AT,
    months,
    ...overrides,
  };
}

async function persist(overrides = {}) {
  return system.$transaction((tx) => persistClimatologyOutlook(tx, input(overrides)));
}

async function storedRows() {
  const { rows } = await owner.query(
    `SELECT to_char(month, 'YYYY-MM-DD') AS month,
            value_mm AS "valueMm",
            data_class AS "dataClass",
            evaluation_basis AS "evaluationBasis",
            missing_reason AS "missingReason",
            baseline_version AS "baselineVersion",
            spread_unavailable_reason AS "spreadUnavailableReason",
            derivation_version AS "derivationVersion",
            input_snapshot_hash AS "inputSnapshotHash",
            jsonb_array_length(input_refs) AS "refCount",
            status,
            superseded_by_id::text AS "supersededById"
       FROM app.monthly_outlooks
      WHERE outlook_cell_id = $1::uuid
      ORDER BY month, created_at`,
    [cellId],
  );
  return rows;
}

before(async () => {
  await owner.connect();
  await api.connect();

  const inserted = await owner.query(
    `INSERT INTO app.outlook_cells (provider, model, cell_key)
     VALUES ($1, $2, $3) RETURNING id::text AS id`,
    [PROVIDER, MODEL, CELL_KEY],
  );
  cellId = inserted.rows[0].id;
  await insertBaseline(BASELINE_A);
  await insertBaseline(BASELINE_B);
});

after(async () => {
  // One statement: `superseded_by_id` is a NO ACTION self-reference, so its
  // check is deferred to the end of the statement and the whole history can go
  // without ever leaving a superseded row that points at a deleted successor.
  await owner.query(`DELETE FROM app.monthly_outlooks WHERE outlook_cell_id = $1::uuid`, [cellId]);
  await owner.query(`DELETE FROM app.climatology_normals WHERE outlook_cell_id = $1::uuid`, [
    cellId,
  ]);
  await owner.query(`DELETE FROM app.climatology_baselines WHERE baseline_version IN ($1, $2)`, [
    BASELINE_A,
    BASELINE_B,
  ]);
  await owner.query(`DELETE FROM app.outlook_cells WHERE id = $1::uuid`, [cellId]);

  await api.end();
  await owner.end();
  await system.$disconnect();
});

describe("persistClimatologyOutlook — the derivation row", () => {
  it("writes one active climatology row per month, with real provenance", async () => {
    const result = await persist();
    assert.deepEqual(result, { inserted: 5, superseded: 0, unchanged: 0 });

    const rows = await storedRows();
    assert.equal(rows.length, 5);

    for (const [index, row] of rows.entries()) {
      const expected = PERSISTED_MONTHS[index];
      assert.equal(row.month, expected.month);
      assert.equal(row.valueMm, expected.valueMm);
      assert.equal(row.dataClass, "climatology");
      assert.equal(row.evaluationBasis, "climatology");
      assert.equal(row.missingReason, "beyond_horizon");
      assert.equal(row.baselineVersion, BASELINE_A);
      assert.equal(row.spreadUnavailableReason, SPREAD_REASON);
      assert.equal(row.derivationVersion, DERIVATION_VERSION);
      assert.equal(row.inputSnapshotHash, HASH_A);
      assert.equal(row.refCount, 1, "input_refs names the baseline it consumed");
      assert.equal(row.status, "active");
      assert.equal(row.supersededById, null);
    }
  });

  it("writes no row for a month that has no value", async () => {
    const rows = await storedRows();
    assert.ok(!rows.some((row) => row.month < "2027-03-01"));
    assert.ok(!rows.some((row) => row.valueMm === null));
  });

  it("is idempotent: the same derivation writes nothing new", async () => {
    const result = await persist();
    assert.deepEqual(result, { inserted: 0, superseded: 0, unchanged: 5 });

    const rows = await storedRows();
    assert.equal(rows.length, 5);
    assert.equal(rows.filter((row) => row.status === "active").length, 5);
  });

  it("supersedes the previous answer when the input snapshot changes", async () => {
    const result = await persist({ inputSnapshotHash: HASH_B });
    assert.deepEqual(result, { inserted: 5, superseded: 5, unchanged: 0 });

    const rows = await storedRows();
    const active = rows.filter((row) => row.status === "active");
    const retired = rows.filter((row) => row.status === "superseded");

    assert.equal(active.length, 5);
    assert.equal(retired.length, 5);
    assert.ok(active.every((row) => row.inputSnapshotHash === HASH_B));
    assert.ok(active.every((row) => row.supersededById === null));
    assert.ok(retired.every((row) => row.supersededById !== null));
  });

  it("treats a different baseline version as a different derivation", async () => {
    await persist({
      inputSnapshotHash: HASH_A,
      baselineVersion: BASELINE_B,
      months: PERSISTED_MONTHS.map((month) => ({
        ...month,
        baselineVersion: BASELINE_B,
        spreadUnavailableReason: SPREAD_REASON,
      })),
    });

    const active = (await storedRows()).filter((row) => row.status === "active");
    assert.equal(active.length, 5);
    assert.ok(active.every((row) => row.baselineVersion === BASELINE_B));
  });
});

describe("persistClimatologyOutlook — failure and concurrency", () => {
  it("keeps the valid active row when a recomputation fails", async () => {
    const before = (await storedRows()).filter((row) => row.status === "active");

    await assert.rejects(
      system.$transaction(async (tx) => {
        await persistClimatologyOutlook(tx, input({ inputSnapshotHash: HASH_B }));
        throw new Error("boom");
      }),
      /boom/,
    );

    const after = (await storedRows()).filter((row) => row.status === "active");
    assert.deepEqual(
      after.map((row) => [row.month, row.inputSnapshotHash]),
      before.map((row) => [row.month, row.inputSnapshotHash]),
    );
  });

  it("leaves exactly one active row per month when two writers race", async () => {
    const [left, right] = await Promise.allSettled([
      persist({ inputSnapshotHash: HASH_A }),
      persist({ inputSnapshotHash: HASH_A }),
    ]);

    assert.equal(left.status, "fulfilled");
    assert.equal(right.status, "fulfilled");

    const rows = await storedRows();
    const byMonth = new Map();
    for (const row of rows.filter((entry) => entry.status === "active")) {
      byMonth.set(row.month, (byMonth.get(row.month) ?? 0) + 1);
    }
    assert.equal(byMonth.size, 5);
    assert.ok([...byMonth.values()].every((count) => count === 1));
  });

  it("refuses a cell it cannot resolve instead of creating one", async () => {
    await assert.rejects(persist({ cellKey: `missing-${token}` }), /no outlook cell/);
  });
});

describe("persistClimatologyOutlook — privileges and constraints", () => {
  it("denies app_api a write on the outlook table", async () => {
    await assert.rejects(
      api.query(`UPDATE app.monthly_outlooks SET value_mm = 0 WHERE outlook_cell_id = $1::uuid`, [
        cellId,
      ]),
      (error) => error.code === "42501",
    );
  });

  it("still refuses a climatology row with no baseline version", async () => {
    await assert.rejects(
      owner.query(
        `INSERT INTO app.monthly_outlooks (
           outlook_cell_id, variable, month, data_class, evaluation_basis, value_mm,
           missing_reason, spread_unavailable_reason, derivation_version,
           input_refs, input_snapshot_hash, status
         ) VALUES ($1::uuid, 'precipitation', '2028-01-01', 'climatology', 'climatology', 10,
                   'beyond_horizon', $2, $3, '[]'::jsonb, $4, 'active')`,
        [cellId, SPREAD_REASON, DERIVATION_VERSION, HASH_A],
      ),
      (error) => error.code === "23514",
    );
  });
});
