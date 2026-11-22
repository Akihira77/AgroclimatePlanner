/**
 * `upsertCell` against real PostgreSQL and the real roles.
 *
 * `app.outlook_cells` is global — no `user_id`, no RLS — so these cases do not
 * assert tenant isolation; they assert the identity guarantee and the grant
 * boundary. Every call goes through `app_api`, which is the point: the function
 * must work with `INSERT (provider, model, cell_key)` and no `UPDATE`, and the
 * privileged `migration_owner` connection is used only to read rows back and to
 * clean up.
 *
 * The providers here are database-allowed values, and the models are marked as
 * test identities. Nothing in this file claims a provider grid has been
 * validated, and nothing writes a served coordinate.
 *
 * Requires a migrated database and the roles from `pnpm db:bootstrap`.
 * Run: pnpm --filter @agroclimate/database test:integration
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { Client } from "pg";

import { createPrismaClient, createTenantScope, upsertCell } from "../../dist/index.js";
import { roleConnectionString } from "../../scripts/lib/connections.mjs";

const owner = new Client({ connectionString: roleConnectionString("migration_owner") });

/** Ordinary lane. One connection, so a leaked setting would be visible. */
const api = createPrismaClient({
  connectionString: roleConnectionString("app_api"),
  poolMax: 1,
});

/** Two more, for the concurrent-insert case: one transaction per client. */
const laneA = createPrismaClient({
  connectionString: roleConnectionString("app_api"),
  poolMax: 1,
});
const laneB = createPrismaClient({
  connectionString: roleConnectionString("app_api"),
  poolMax: 1,
});

const scope = createTenantScope(api);
const scopeA = createTenantScope(laneA);
const scopeB = createTenantScope(laneB);

/** Every model this run creates carries it, so cleanup cannot miss a row. */
const REVISION = `test-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const MODEL = `synthetic_${REVISION}`;

const created = { users: [], cells: [] };

async function createUser() {
  const { rows } = await owner.query(
    "INSERT INTO app.users (email, password_hash) VALUES ($1, 'x') RETURNING id::text AS id",
    [`cl-${REVISION}@example.test`],
  );
  created.users.push(rows[0].id);
  return rows[0].id;
}

let userId;

/** Inserts through `app_api` inside a real tenant transaction, and tracks the id. */
async function upsert(provider, model, cellKey) {
  const id = await scope.withTenant(userId, (tx) => upsertCell(tx, { provider, model, cellKey }));
  if (!created.cells.includes(id)) created.cells.push(id);
  return id;
}

/** Reads the row as the owner, so nothing is hidden by a grant. */
async function readCell(id) {
  const { rows } = await owner.query(
    `SELECT provider, model, cell_key, served_lat, served_lon, elevation_m,
            spatial_resolution_km, served_updated_at
       FROM app.outlook_cells WHERE id = $1::uuid`,
    [id],
  );
  return rows[0];
}

async function countCells(provider, model, cellKey) {
  const { rows } = await owner.query(
    `SELECT count(*)::int AS n FROM app.outlook_cells
      WHERE provider = $1 AND model = $2 AND cell_key = $3`,
    [provider, model, cellKey],
  );
  return rows[0].n;
}

async function waitForLockWaiter() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    // `pg_locks` rather than `pg_stat_activity`: an ungranted lock entry is
    // visible to every role, while a backend's wait_event is only partly
    // visible across users.
    const { rows } = await owner.query("SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted");
    if (rows[0].n > 0) return true;
    await sleep(20);
  }
  return false;
}

before(async () => {
  await owner.connect();
  userId = await createUser();
});

after(async () => {
  try {
    if (created.cells.length > 0) {
      await owner.query("DELETE FROM app.outlook_cells WHERE id = ANY($1::uuid[])", [
        created.cells,
      ]);
    }
    await owner.query("DELETE FROM app.outlook_cells WHERE model = $1", [MODEL]);
    if (created.users.length > 0) {
      await owner.query("DELETE FROM app.users WHERE id = ANY($1::uuid[])", [created.users]);
    }
  } finally {
    await Promise.all([api.$disconnect(), laneA.$disconnect(), laneB.$disconnect()]);
    await owner.end();
  }
});

describe("upsertCell — identity persistence", () => {
  it("runs as app_api, the role that holds only the identity-column insert", async () => {
    const role = await scope.withTenant(userId, (tx) => tx.$queryRaw`SELECT current_user AS role`);
    assert.equal(role[0].role, "app_api");
  });

  it("inserts one identity row and returns its UUID", async () => {
    const cellKey = "-6.00,106.75";
    const id = await upsert("open-meteo", MODEL, cellKey);

    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const row = await readCell(id);
    assert.ok(row, "the row exists");
    assert.equal(row.provider, "open-meteo");
    assert.equal(row.model, MODEL);
    assert.equal(row.cell_key, cellKey);
    assert.equal(await countCells("open-meteo", MODEL, cellKey), 1);
  });

  it("returns the same id on a repeat, and does not update the row", async () => {
    const cellKey = "-6.00,106.50";
    const first = await upsert("open-meteo", MODEL, cellKey);
    const before = await readCell(first);
    await sleep(5);
    const second = await upsert("open-meteo", MODEL, cellKey);
    const after = await readCell(second);

    assert.equal(second, first, "the persisted identity is reused");
    assert.equal(await countCells("open-meteo", MODEL, cellKey), 1, "no duplicate row");
    assert.deepEqual(after, before, "the existing row is untouched");
  });

  it("treats the three components as independent", async () => {
    const cellKey = "-6.00,106.25";
    const base = await upsert("open-meteo", MODEL, cellKey);
    const otherCell = await upsert("open-meteo", MODEL, "-6.00,106.00");
    const otherModel = await upsert("open-meteo", `${MODEL}_b`, cellKey);
    const otherProvider = await upsert("ecmwf", MODEL, cellKey);

    assert.equal(
      new Set([base, otherCell, otherModel, otherProvider]).size,
      4,
      "each distinct triple gets its own id",
    );
  });

  it("leaves every served column NULL on a new identity", async () => {
    const id = await upsert("bmkg", MODEL, "-6.00,105.75");
    const row = await readCell(id);

    assert.ok(row, "the row exists");
    assert.equal(row.served_lat, null);
    assert.equal(row.served_lon, null);
    assert.equal(row.elevation_m, null);
    assert.equal(row.spatial_resolution_km, null);
    assert.equal(row.served_updated_at, null);
  });

  it("rejects a provider the database does not allow", async () => {
    // `synthetic` is the registry's development grid identity, and the CHECK
    // deliberately does not admit it: persisting an identity is not admission.
    await assert.rejects(
      () =>
        scope.withTenant(userId, (tx) =>
          upsertCell(tx, { provider: "synthetic", model: MODEL, cellKey: "-6.00,105.50" }),
        ),
      (error) => {
        assert.match(String(error), /23514|outlook_cells_provider_check/);
        return true;
      },
    );
    assert.equal(await countCells("synthetic", MODEL, "-6.00,105.50"), 0);
  });

  it("returns the committed id when two callers insert the same identity at once", async () => {
    const cellKey = "-6.00,105.25";
    const cell = { provider: "ecmwf", model: MODEL, cellKey };

    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });

    // A inserts and then holds its transaction open, so its row is uncommitted.
    const holding = scopeA.withTenant(userId, async (tx) => {
      const id = await upsertCell(tx, cell);
      await gate;
      return id;
    });

    const waiting = waitForLockWaiter();
    const blocked = scopeB.withTenant(userId, (tx) => upsertCell(tx, cell));
    assert.ok(await waiting, "the second insert waited on the first transaction's row");

    release();
    const [committed, blockedId] = await Promise.all([holding, blocked]);

    assert.equal(blockedId, committed, "the blocked caller received the committed id");
    assert.equal(await countCells("ecmwf", MODEL, cellKey), 1, "exactly one row exists");
    created.cells.push(committed);
  });
});
