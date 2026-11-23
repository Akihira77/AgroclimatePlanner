/**
 * Climatology persistence against real PostgreSQL: a baseline version is
 * append-only, idempotent for identical output, and loud on conflict (Phase 5.5).
 *
 * Writes run as `app_system` — the worker's real role. `migration_owner` seeds
 * and reads back. `app_api` is exercised against the same table to prove the
 * read/write split is a privilege, not a convention.
 *
 * Requires a migrated database and the roles from `pnpm db:bootstrap`.
 * Run: pnpm --filter @agroclimate/database test:integration
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { Client } from "pg";

import {
  ClimatologyConflictError,
  createPrismaClient,
  InvariantViolationError,
  persistClimatologyBaseline,
} from "../../dist/index.js";
import { roleConnectionString } from "../../scripts/lib/connections.mjs";

const owner = new Client({ connectionString: roleConnectionString("migration_owner") });
const api = new Client({ connectionString: roleConnectionString("app_api") });
const system = createPrismaClient({ connectionString: roleConnectionString("app_system") });

const token = randomUUID().slice(0, 8);
const provider = "open-meteo";
const model = `phase55_${token}`;
const CELL_A = `p55-${token}-a`;
const CELL_B = `p55-${token}-b`;
const CELL_C = `p55-${token}-c`;

const PERIOD_FROM = new Date("1991-01-01T00:00:00.000Z");
const PERIOD_TO = new Date("2020-12-31T00:00:00.000Z");
const COMPUTED_AT = new Date("2026-11-23T00:00:00.000Z");

function normals(offset = 0) {
  return Array.from({ length: 12 }, (_unused, index) => ({
    month: new Date(Date.UTC(1991, index, 1)),
    valueMm: 100 + offset + index,
    sampleYears: 30,
  }));
}

function cell(cellKey, offset = 0, overrides = {}) {
  return {
    cellKey,
    servedLat: -6.25,
    servedLon: 106.75,
    spatialResolutionKm: 28,
    normals: normals(offset),
    ...overrides,
  };
}

function input(overrides = {}) {
  return {
    provider,
    model,
    baselineVersion: `ERA5:1991-2020:p55${token}`,
    baselineDataset: "era5",
    periodFrom: PERIOD_FROM,
    periodTo: PERIOD_TO,
    computedAt: COMPUTED_AT,
    cells: [cell(CELL_A)],
    ...overrides,
  };
}

function persist(payload) {
  return system.$transaction((tx) => persistClimatologyBaseline(tx, payload));
}

async function rowsFor(version) {
  const result = await owner.query(
    `SELECT c.cell_key, to_char(n.month, 'YYYY-MM-DD') AS month, n.value_mm,
            n.sample_years, n.baseline_dataset
       FROM app.climatology_normals n
       JOIN app.outlook_cells c ON c.id = n.outlook_cell_id
      WHERE n.baseline_version = $1
      ORDER BY c.cell_key, n.month`,
    [version],
  );
  return result.rows;
}

before(async () => {
  await owner.connect();
  await api.connect();
});

after(async () => {
  // Ordered: normals name a cell, so they go first. Suite-private keys mean this
  // can never touch another suite's rows.
  await owner.query(`DELETE FROM app.climatology_normals WHERE baseline_version LIKE $1`, [
    `ERA5:1991-2020:p55${token}%`,
  ]);
  await owner.query(`DELETE FROM app.outlook_cells WHERE model = $1`, [model]);
  await api.end();
  await owner.end();
  await system.$disconnect();
});

describe("persistClimatologyBaseline — the full baseline", () => {
  it("writes all 12 months for a cell in one call", async () => {
    const payload = input();
    const result = await persist(payload);
    assert.deepEqual(result, { cells: 1, inserted: 12, unchanged: 0 });

    const rows = await rowsFor(payload.baselineVersion);
    assert.equal(rows.length, 12);
    assert.deepEqual(
      rows.map((row) => row.month),
      [
        "1991-01-01",
        "1991-02-01",
        "1991-03-01",
        "1991-04-01",
        "1991-05-01",
        "1991-06-01",
        "1991-07-01",
        "1991-08-01",
        "1991-09-01",
        "1991-10-01",
        "1991-11-01",
        "1991-12-01",
      ],
    );
    assert.equal(rows[0].value_mm, 100);
    assert.equal(rows[11].value_mm, 111);
    assert.equal(rows[0].sample_years, 30);
    assert.equal(rows[0].baseline_dataset, "era5");
    assert.ok(rows.every((row) => row.cell_key === CELL_A));
  });

  it("writes every cell of a multi-cell baseline", async () => {
    const payload = input({
      baselineVersion: `ERA5:1991-2020:p55${token}-multi`,
      cells: [cell(CELL_A), cell(CELL_B, 0.5)],
    });
    const result = await persist(payload);
    assert.deepEqual(result, { cells: 2, inserted: 24, unchanged: 0 });
    assert.equal((await rowsFor(payload.baselineVersion)).length, 24);
  });

  it("is idempotent for the same version and the same values", async () => {
    const payload = input({ baselineVersion: `ERA5:1991-2020:p55${token}-idem` });
    assert.deepEqual(await persist(payload), { cells: 1, inserted: 12, unchanged: 0 });
    assert.deepEqual(await persist(payload), { cells: 1, inserted: 0, unchanged: 12 });
    assert.equal((await rowsFor(payload.baselineVersion)).length, 12);
  });
});

describe("persistClimatologyBaseline — version immutability", () => {
  it("refuses a different value under an existing version and keeps the stored one", async () => {
    const version = `ERA5:1991-2020:p55${token}-conflict`;
    await persist(input({ baselineVersion: version }));

    const drifted = normals();
    drifted[3] = { ...drifted[3], valueMm: 999 };
    await assert.rejects(
      () =>
        persist(
          input({ baselineVersion: version, cells: [cell(CELL_A, 0, { normals: drifted })] }),
        ),
      ClimatologyConflictError,
    );

    const rows = await rowsFor(version);
    assert.equal(rows.length, 12);
    assert.equal(rows.find((row) => row.month === "1991-04-01").value_mm, 103);
  });

  it("refuses a changed sample count under an existing version", async () => {
    const version = `ERA5:1991-2020:p55${token}-samples`;
    await persist(input({ baselineVersion: version }));

    const fewer = normals();
    fewer[0] = { ...fewer[0], sampleYears: 29 };
    await assert.rejects(
      () =>
        persist(input({ baselineVersion: version, cells: [cell(CELL_A, 0, { normals: fewer })] })),
      ClimatologyConflictError,
    );
  });

  it("refuses a different dataset or period under an existing version", async () => {
    const version = `ERA5:1991-2020:p55${token}-identity`;
    await persist(input({ baselineVersion: version }));

    await assert.rejects(
      () => persist(input({ baselineVersion: version, baselineDataset: "nasa_power" })),
      ClimatologyConflictError,
    );
    await assert.rejects(
      () =>
        persist(
          input({
            baselineVersion: version,
            periodTo: new Date("2020-11-30T00:00:00.000Z"),
          }),
        ),
      ClimatologyConflictError,
    );
  });

  it("keeps the previous version intact when a new one is written", async () => {
    const first = input({ baselineVersion: `ERA5:1991-2020:p55${token}-v1` });
    const second = input({
      baselineVersion: `ERA5:1991-2020:p55${token}-v2`,
      cells: [cell(CELL_A, 10)],
    });
    await persist(first);
    await persist(second);

    const v1 = await rowsFor(first.baselineVersion);
    const v2 = await rowsFor(second.baselineVersion);
    assert.equal(v1.length, 12);
    assert.equal(v2.length, 12);
    assert.equal(v1[0].value_mm, 100);
    assert.equal(v2[0].value_mm, 110);
  });

  it("rolls the whole write back when one cell conflicts", async () => {
    const version = `ERA5:1991-2020:p55${token}-rollback`;
    await persist(input({ baselineVersion: version, cells: [cell(CELL_A)] }));

    const drifted = normals();
    drifted[0] = { ...drifted[0], valueMm: 500 };
    await assert.rejects(
      () =>
        persist(
          input({
            baselineVersion: version,
            cells: [cell(CELL_C, 20), cell(CELL_A, 0, { normals: drifted })],
          }),
        ),
      ClimatologyConflictError,
    );

    // CELL_C was inserted before the conflict and must have been rolled back.
    const rows = await rowsFor(version);
    assert.equal(rows.length, 12);
    assert.ok(rows.every((row) => row.cell_key === CELL_A));
  });
});

describe("persistClimatologyBaseline — validation before write", () => {
  it("refuses eleven normals instead of storing a partial baseline", async () => {
    const version = `ERA5:1991-2020:p55${token}-short`;
    await assert.rejects(
      () =>
        persist(
          input({
            baselineVersion: version,
            cells: [cell(CELL_A, 0, { normals: normals().slice(0, 11) })],
          }),
        ),
      InvariantViolationError,
    );
    assert.equal((await rowsFor(version)).length, 0);
  });

  it("refuses a sample count the 30-year period cannot have", async () => {
    for (const sampleYears of [0, 31]) {
      const version = `ERA5:1991-2020:p55${token}-sy${String(sampleYears)}`;
      const bad = normals();
      bad[0] = { ...bad[0], sampleYears };
      await assert.rejects(
        () =>
          persist(input({ baselineVersion: version, cells: [cell(CELL_A, 0, { normals: bad })] })),
        InvariantViolationError,
        `sampleYears ${String(sampleYears)} must be refused`,
      );
      assert.equal((await rowsFor(version)).length, 0);
    }
  });

  it("refuses a month that is not the first of a calendar month", async () => {
    const version = `ERA5:1991-2020:p55${token}-month`;
    const bad = normals();
    bad[0] = { ...bad[0], month: new Date("1991-01-02T00:00:00.000Z") };
    await assert.rejects(
      () =>
        persist(input({ baselineVersion: version, cells: [cell(CELL_A, 0, { normals: bad })] })),
      InvariantViolationError,
    );
    assert.equal((await rowsFor(version)).length, 0);
  });

  it("refuses a negative normal instead of storing a value the CHECK would reject", async () => {
    const version = `ERA5:1991-2020:p55${token}-neg`;
    const bad = normals();
    bad[0] = { ...bad[0], valueMm: -0.1 };
    await assert.rejects(
      () =>
        persist(input({ baselineVersion: version, cells: [cell(CELL_A, 0, { normals: bad })] })),
      InvariantViolationError,
    );
    assert.equal((await rowsFor(version)).length, 0);
  });
});

describe("climatology_normals — the privilege boundary", () => {
  it("lets app_api read the baseline but not write it", async () => {
    const version = `ERA5:1991-2020:p55${token}-grants`;
    await persist(input({ baselineVersion: version }));

    const read = await api.query(
      `SELECT count(*)::int AS n FROM app.climatology_normals WHERE baseline_version = $1`,
      [version],
    );
    assert.equal(read.rows[0].n, 12);

    await assert.rejects(
      () =>
        api.query(
          `INSERT INTO app.climatology_normals (
             baseline_version, baseline_dataset, period_from, period_to,
             outlook_cell_id, month, value_mm, sample_years
           )
           SELECT $1, 'era5', DATE '1991-01-01', DATE '2020-12-31',
                  id, DATE '1991-01-01', 1, 30
             FROM app.outlook_cells LIMIT 1`,
          [version],
        ),
      (error) => error.code === "42501",
    );

    const writePrivileges = await owner.query(
      `SELECT has_table_privilege('app_api', 'app.climatology_normals', 'INSERT') AS insert,
              has_table_privilege('app_api', 'app.climatology_normals', 'UPDATE') AS update,
              has_table_privilege('app_api', 'app.climatology_normals', 'DELETE') AS delete`,
    );
    assert.deepEqual(writePrivileges.rows[0], {
      insert: false,
      update: false,
      delete: false,
    });
  });

  it("stores no tenant column: a global baseline is written without a tenant", async () => {
    const columns = await owner.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'app' AND table_name = 'climatology_normals'
        ORDER BY column_name`,
    );
    assert.ok(!columns.rows.some((row) => row.column_name === "user_id"));
    assert.ok(!columns.rows.some((row) => row.column_name === "field_id"));
  });
});
