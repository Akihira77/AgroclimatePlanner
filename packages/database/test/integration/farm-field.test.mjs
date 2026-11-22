/**
 * The Farm and Field database layer, against real PostgreSQL and the real roles.
 *
 * Nothing here is a double. Fixtures are created by `migration_owner` (the schema
 * owner, allowed for setup and for reading a row back without RLS), and every
 * assertion that matters runs as `app_api` through
 * `createTenantScope().withTenant()`. A negative result is accepted only at a
 * specific SQLSTATE, so a missing table or a syntax error cannot pass as a working
 * boundary.
 *
 * Two lanes with `poolMax: 1` each exist for the concurrency scenarios: one
 * transaction per client, so holding a transaction open is deterministic instead of
 * hopeful.
 *
 * Requires a migrated database and the roles from `pnpm db:bootstrap`.
 * Run: pnpm --filter @agroclimate/database test:integration
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { Client } from "pg";

import {
  createFarm,
  createField,
  FieldGeometryError,
  createPrismaClient,
  createTenantScope,
  findFarm,
  findField,
  listFarms,
  listFields,
  selectFieldAnchor,
  softDeleteFarm,
  softDeleteField,
  updateFarm,
  updateField,
} from "../../dist/index.js";
import { roleConnectionString } from "../../scripts/lib/connections.mjs";

const owner = new Client({ connectionString: roleConnectionString("migration_owner") });

/** Ordinary lane. One connection, so a leaked `app.user_id` would be visible. */
const api = createPrismaClient({
  connectionString: roleConnectionString("app_api"),
  poolMax: 1,
});

/** Concurrency lanes: one transaction each, and no pool to hide a second connection. */
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

const created = { users: [], farms: [], fields: [] };

/** 106.8°E–106.9°E, 6.2°S–6.1°S: about 123 hectares. */
const SQUARE = {
  type: "Polygon",
  coordinates: [
    [
      [106.8, -6.2],
      [106.9, -6.2],
      [106.9, -6.1],
      [106.8, -6.1],
      [106.8, -6.2],
    ],
  ],
};

/** Half the size of `SQUARE`, for the update-recomputes-area case. */
const SMALLER_SQUARE = {
  type: "Polygon",
  coordinates: [
    [
      [106.8, -6.2],
      [106.85, -6.2],
      [106.85, -6.15],
      [106.8, -6.15],
      [106.8, -6.2],
    ],
  ],
};

async function createUser(label) {
  const { rows } = await owner.query(
    "INSERT INTO app.users (email, password_hash) VALUES ($1, 'x') RETURNING id::text AS id",
    [`ff-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.test`],
  );
  created.users.push(rows[0].id);
  return rows[0].id;
}

async function farmFor(userId, name, prisma = api) {
  const farm = await createTenantScope(prisma).withTenant(userId, (tx) => createFarm(tx, { name }));
  created.farms.push(farm.id);
  return farm;
}

async function fieldFor(userId, farmId, name, geometry = SQUARE, prisma = api) {
  const field = await createTenantScope(prisma).withTenant(userId, (tx) =>
    createField(tx, farmId, { name, geometry }),
  );
  assert.notEqual(field, null, "fixture field must be created");
  created.fields.push(field.id);
  return field;
}

/** Reads a row as the owner, so nothing is hidden by a grant or a policy. */
async function readField(fieldId) {
  const { rows } = await owner.query(
    `SELECT name, deleted_at, area_ha,
            public.ST_SRID(geom) AS srid,
            public.GeometryType(geom) AS geom_type,
            public.ST_AsGeoJSON(geom) AS geojson
       FROM app.fields WHERE id = $1::uuid`,
    [fieldId],
  );
  return rows[0];
}

async function readFarm(farmId) {
  const { rows } = await owner.query(
    "SELECT name, region, notes, deleted_at FROM app.farms WHERE id = $1::uuid",
    [farmId],
  );
  return rows[0];
}

/** The SQLSTATE, wherever Prisma or `pg` nested it. */
function sqlState(error, depth = 0) {
  if (depth > 6 || typeof error !== "object" || error === null) return undefined;
  for (const key of ["code", "originalCode", "sqlState"]) {
    const value = error[key];
    // Prisma's own `P2010` is five characters and would otherwise mask the
    // PostgreSQL SQLSTATE nested beneath it.
    if (typeof value === "string" && /^[0-9A-Z]{5}$/.test(value) && !/^P\d{4}$/.test(value)) {
      return value;
    }
  }
  for (const value of Object.values(error)) {
    const found = sqlState(value, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Waits until some backend is blocked on a lock. `migration_owner` is not a superuser
 * and cannot read another session's `wait_event_type`, so the evidence is the lock
 * queue itself.
 */
async function waitForLockWaiter(timeoutMs = 5_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const { rows } = await owner.query(
      `SELECT count(*)::int AS n
         FROM pg_locks l
         JOIN pg_stat_activity a USING (pid)
        WHERE NOT l.granted
          AND a.datname = current_database()`,
    );
    if (rows[0].n > 0) return true;
    await sleep(20);
  }
  return false;
}

async function rejectsWithSqlState(fn, expected) {
  await assert.rejects(fn, (error) => {
    assert.equal(sqlState(error), expected);
    return true;
  });
}

before(async () => {
  await owner.connect();
});

after(async () => {
  try {
    if (created.fields.length > 0) {
      await owner.query("DELETE FROM app.fields WHERE farm_id = ANY($1::uuid[])", [created.farms]);
    }
    if (created.farms.length > 0) {
      await owner.query("DELETE FROM app.farms WHERE id = ANY($1::uuid[])", [created.farms]);
    }
    if (created.users.length > 0) {
      await owner.query("DELETE FROM app.users WHERE id = ANY($1::uuid[])", [created.users]);
    }
  } finally {
    await owner.end();
    await api.$disconnect();
    await laneA.$disconnect();
    await laneB.$disconnect();
  }
});

describe("tenant isolation", () => {
  it("creates a farm and reads it back inside its own tenant", async () => {
    const userId = await createUser("own");
    const farm = await farmFor(userId, "Kebun Utara");

    const found = await scope.withTenant(userId, (tx) => findFarm(tx, farm.id));
    assert.deepEqual(found?.id, farm.id);
    assert.equal(found?.name, "Kebun Utara");
    assert.equal(found?.region, null);
    assert.ok(found?.createdAt instanceof Date);
  });

  it("keeps another tenant's farm indistinguishable from a missing one", async () => {
    const tenantA = await createUser("read-a");
    const tenantB = await createUser("read-b");
    const farm = await farmFor(tenantA, "Rahasia A");

    const found = await scope.withTenant(tenantB, (tx) => findFarm(tx, farm.id));
    assert.equal(found, null);

    // The same answer as an id that never existed.
    const ghost = await scope.withTenant(tenantB, (tx) =>
      findFarm(tx, "00000000-0000-7000-8000-000000000000"),
    );
    assert.equal(ghost, null);
  });

  it("refuses another tenant's update and delete without changing the row", async () => {
    const tenantA = await createUser("write-a");
    const tenantB = await createUser("write-b");
    const farm = await farmFor(tenantA, "Milik A");

    const updated = await scope.withTenant(tenantB, (tx) =>
      updateFarm(tx, farm.id, { name: "Dibajak" }),
    );
    assert.equal(updated, null);

    const deleted = await scope.withTenant(tenantB, (tx) => softDeleteFarm(tx, farm.id));
    assert.equal(deleted, "not_found");

    const row = await readFarm(farm.id);
    assert.equal(row.name, "Milik A");
    assert.equal(row.deleted_at, null);
  });

  it("lists only the caller's farms", async () => {
    const tenantA = await createUser("list-a");
    const tenantB = await createUser("list-b");
    const farmA = await farmFor(tenantA, "List A");
    const farmB = await farmFor(tenantB, "List B");

    const pageB = await scope.withTenant(tenantB, (tx) =>
      listFarms(tx, { limit: 100, offset: 0, sort: "-createdAt" }),
    );

    const ids = pageB.items.map((farm) => farm.id);
    assert.ok(ids.includes(farmB.id));
    assert.ok(!ids.includes(farmA.id));
    assert.equal(pageB.total, pageB.items.length);
  });

  it("cannot create a field under another tenant's farm", async () => {
    const tenantA = await createUser("parent-a");
    const tenantB = await createUser("parent-b");
    const farm = await farmFor(tenantA, "Induk A");

    const field = await scope.withTenant(tenantB, (tx) =>
      createField(tx, farm.id, { name: "Penyusup", geometry: SQUARE }),
    );
    assert.equal(field, null);

    const { rows } = await owner.query(
      "SELECT count(*)::int AS n FROM app.fields WHERE farm_id = $1::uuid",
      [farm.id],
    );
    assert.equal(rows[0].n, 0);
  });

  it("cannot read, update, or delete another tenant's field", async () => {
    const tenantA = await createUser("field-a");
    const tenantB = await createUser("field-b");
    const farm = await farmFor(tenantA, "Ladang A");
    const field = await fieldFor(tenantA, farm.id, "Petak A");

    const found = await scope.withTenant(tenantB, (tx) => findField(tx, field.id));
    assert.equal(found, null);

    const updated = await scope.withTenant(tenantB, (tx) =>
      updateField(tx, field.id, { name: "Dibajak" }),
    );
    assert.equal(updated, null);

    const deleted = await scope.withTenant(tenantB, (tx) => softDeleteField(tx, field.id));
    assert.equal(deleted, false);

    const row = await readField(field.id);
    assert.equal(row.name, "Petak A");
    assert.equal(row.deleted_at, null);
  });

  it("does not expose one farm's fields through another farm of the same tenant", async () => {
    const userId = await createUser("sibling");
    const first = await farmFor(userId, "Farm Satu");
    const second = await farmFor(userId, "Farm Dua");
    const field = await fieldFor(userId, first.id, "Petak Satu");

    const page = await scope.withTenant(userId, (tx) =>
      listFields(tx, second.id, { limit: 100, offset: 0, sort: "-createdAt" }),
    );
    assert.deepEqual(page.items, []);
    assert.equal(page.total, 0);

    const ids = (
      await scope.withTenant(userId, (tx) =>
        listFields(tx, first.id, { limit: 100, offset: 0, sort: "-createdAt" }),
      )
    ).items.map((row) => row.id);
    assert.deepEqual(ids, [field.id]);
  });

  it("answers a foreign parent for the field list, not an empty list", async () => {
    const tenantA = await createUser("paged-a");
    const tenantB = await createUser("paged-b");
    const farm = await farmFor(tenantA, "Punya A");

    const page = await scope.withTenant(tenantB, (tx) =>
      listFields(tx, farm.id, { limit: 100, offset: 0, sort: "-createdAt" }),
    );
    assert.equal(page, null);
  });
});

describe("soft deletion", () => {
  it("hides a deleted farm from reads and lists but keeps the row", async () => {
    const userId = await createUser("del-farm");
    const farm = await farmFor(userId, "Akan dihapus");

    const outcome = await scope.withTenant(userId, (tx) => softDeleteFarm(tx, farm.id));
    assert.equal(outcome, "deleted");

    assert.equal(await scope.withTenant(userId, (tx) => findFarm(tx, farm.id)), null);

    const page = await scope.withTenant(userId, (tx) =>
      listFarms(tx, { limit: 100, offset: 0, sort: "-createdAt" }),
    );
    assert.ok(!page.items.some((row) => row.id === farm.id));

    const row = await readFarm(farm.id);
    assert.notEqual(row.deleted_at, null, "soft delete never removes the row");
  });

  it("refuses a second delete and reports not_found", async () => {
    const userId = await createUser("del-twice");
    const farm = await farmFor(userId, "Sekali saja");

    assert.equal(await scope.withTenant(userId, (tx) => softDeleteFarm(tx, farm.id)), "deleted");
    assert.equal(await scope.withTenant(userId, (tx) => softDeleteFarm(tx, farm.id)), "not_found");
  });

  it("refuses to delete a farm that still has a live field", async () => {
    const userId = await createUser("del-busy");
    const farm = await farmFor(userId, "Masih ada petak");
    const field = await fieldFor(userId, farm.id, "Petak hidup");

    assert.equal(
      await scope.withTenant(userId, (tx) => softDeleteFarm(tx, farm.id)),
      "has_live_fields",
    );

    const row = await readFarm(farm.id);
    assert.equal(row.deleted_at, null, "the farm is still live");
    assert.equal((await readField(field.id)).deleted_at, null);
  });

  it("allows the delete once the field is soft-deleted", async () => {
    const userId = await createUser("del-after");
    const farm = await farmFor(userId, "Setelah petak pergi");
    const field = await fieldFor(userId, farm.id, "Petak pergi");

    assert.equal(await scope.withTenant(userId, (tx) => softDeleteField(tx, field.id)), true);
    assert.equal(await scope.withTenant(userId, (tx) => softDeleteFarm(tx, farm.id)), "deleted");
  });

  it("will not create a field under a deleted farm", async () => {
    const userId = await createUser("del-new");
    const farm = await farmFor(userId, "Sudah dihapus");
    assert.equal(await scope.withTenant(userId, (tx) => softDeleteFarm(tx, farm.id)), "deleted");

    const field = await scope.withTenant(userId, (tx) =>
      createField(tx, farm.id, { name: "Terlambat", geometry: SQUARE }),
    );
    assert.equal(field, null);
  });

  it("hides a deleted field from reads, lists, and updates", async () => {
    const userId = await createUser("del-field");
    const farm = await farmFor(userId, "Ladang");
    const field = await fieldFor(userId, farm.id, "Petak");

    assert.equal(await scope.withTenant(userId, (tx) => softDeleteField(tx, field.id)), true);
    assert.equal(await scope.withTenant(userId, (tx) => findField(tx, field.id)), null);
    assert.equal(
      await scope.withTenant(userId, (tx) => updateField(tx, field.id, { name: "Ubah" })),
      null,
    );

    const page = await scope.withTenant(userId, (tx) =>
      listFields(tx, farm.id, { limit: 100, offset: 0, sort: "-createdAt" }),
    );
    assert.deepEqual(page.items, []);
    assert.equal(page.total, 0);

    const row = await readField(field.id);
    assert.equal(row.name, "Petak", "no write reached the deleted row");
    assert.notEqual(row.deleted_at, null);
  });
});

describe("geometry and generated area", () => {
  it("stores the polygon as EPSG:4326 and returns it as GeoJSON", async () => {
    const userId = await createUser("geom");
    const farm = await farmFor(userId, "Geometri");
    const field = await fieldFor(userId, farm.id, "Petak persegi");

    assert.equal(field.geometry.type, "Polygon");
    const ring = field.geometry.coordinates[0];
    assert.equal(ring.length, 5);
    assert.deepEqual(ring[0], [106.8, -6.2]);

    const row = await readField(field.id);
    assert.equal(row.srid, 4326);
    assert.equal(row.geom_type, "POLYGON");
  });

  it("returns the database's area, not one the caller supplied", async () => {
    const userId = await createUser("area");
    const farm = await farmFor(userId, "Luas");
    const field = await fieldFor(userId, farm.id, "Petak luas");

    const row = await readField(field.id);
    assert.equal(field.areaHa, row.area_ha);
    assert.ok(field.areaHa > 0);

    // The generated expression, evaluated independently.
    const { rows } = await owner.query(
      `SELECT (public.ST_Area(
                 public.ST_SetSRID(public.ST_GeomFromGeoJSON($1::text), 4326)::public.geography
               ) / 10000.0)::double precision AS expected`,
      [JSON.stringify(SQUARE)],
    );
    assert.equal(field.areaHa, rows[0].expected);

    // Nothing in the request could carry an area: the module's input type has no
    // such field, and the column is not writable.
    await rejectsWithSqlState(
      () =>
        owner.query(
          "INSERT INTO app.fields (user_id, farm_id, name, geom, area_ha) VALUES ($1, $2, 'x', public.ST_SetSRID(public.ST_MakePoint(1, 1), 4326), 1)",
          [userId, farm.id],
        ),
      "428C9",
    );
  });

  it("recomputes the area when the geometry is replaced", async () => {
    const userId = await createUser("area-update");
    const farm = await farmFor(userId, "Luas berubah");
    const field = await fieldFor(userId, farm.id, "Petak");

    const updated = await scope.withTenant(userId, (tx) =>
      updateField(tx, field.id, { geometry: SMALLER_SQUARE }),
    );

    assert.notEqual(updated, null);
    assert.ok(updated.areaHa < field.areaHa);
    assert.equal(updated.areaHa, (await readField(field.id)).area_ha);
  });

  it("lets the database reject an unclosed ring, which the parser does not close", async () => {
    const userId = await createUser("geom-open");
    const farm = await farmFor(userId, "Ring");
    const open = {
      type: "Polygon",
      coordinates: [
        [
          [106.8, -6.2],
          [106.9, -6.2],
          [106.9, -6.1],
          [106.8, -6.1],
        ],
      ],
    };

    // Measured: `ST_GeomFromGeoJSON` stores the ring as given, `ST_IsValid` is false,
    // and `fields_geom_valid_check` refuses it. A contract check is still cheaper than
    // mapping `23514`, but the database is not silent about it.
    await rejectsWithSqlState(
      () =>
        scope.withTenant(userId, (tx) =>
          createField(tx, farm.id, { name: "Terbuka", geometry: open }),
        ),
      "23514",
    );
  });

  it("lets the database reject a self-intersecting polygon", async () => {
    const userId = await createUser("geom-bowtie");
    const farm = await farmFor(userId, "Silang");
    const bowtie = {
      type: "Polygon",
      coordinates: [
        [
          [106.8, -6.2],
          [106.9, -6.1],
          [106.9, -6.2],
          [106.8, -6.1],
          [106.8, -6.2],
        ],
      ],
    };

    await rejectsWithSqlState(
      () =>
        scope.withTenant(userId, (tx) =>
          createField(tx, farm.id, { name: "Silang", geometry: bowtie }),
        ),
      "23514",
    );
  });

  it("refuses a non-polygon before it reaches SQL", async () => {
    const userId = await createUser("geom-point");
    const farm = await farmFor(userId, "Titik");
    const point = { type: "Point", coordinates: [106.8, -6.2] };

    // The column accepts `POINT` (`OPEN-17`), so a database error would not arrive at
    // all: the layer has to refuse it, and with an error the API can turn into a `400`.
    await assert.rejects(
      () =>
        scope.withTenant(userId, (tx) =>
          createField(tx, farm.id, { name: "Titik", geometry: point }),
        ),
      (error) => {
        assert.ok(error instanceof FieldGeometryError, "a typed failure, not a raw 23514");
        return true;
      },
    );

    const { rows } = await owner.query(
      "SELECT count(*)::int AS n FROM app.fields WHERE farm_id = $1::uuid",
      [farm.id],
    );
    assert.equal(rows[0].n, 0);
  });

  it("refuses a crs member, which would otherwise be stored under the wrong SRID", async () => {
    const userId = await createUser("geom-crs");
    const farm = await farmFor(userId, "CRS");
    const webMercator = {
      type: "Polygon",
      crs: { type: "name", properties: { name: "EPSG:3857" } },
      coordinates: SQUARE.coordinates,
    };

    // Measured: `ST_GeomFromGeoJSON` honours the member and yields SRID 3857. Had the
    // insert used `ST_SetSRID(…, 4326)`, the coordinates would be stored mislabelled
    // and the area would be wrong instead of refused.
    await assert.rejects(
      () =>
        scope.withTenant(userId, (tx) =>
          createField(tx, farm.id, { name: "Mercator", geometry: webMercator }),
        ),
      (error) => {
        assert.ok(error instanceof FieldGeometryError);
        return true;
      },
    );
  });

  it("refuses to serve a point row written outside this layer", async () => {
    const userId = await createUser("geom-raw-point");
    const farm = await farmFor(userId, "Titik mentah");
    const { rows } = await owner.query(
      `INSERT INTO app.fields (user_id, farm_id, name, geom)
       VALUES ($1::uuid, $2::uuid, 'Titik', public.ST_SetSRID(public.ST_MakePoint(106.8, -6.2), 4326))
       RETURNING id::text AS id`,
      [userId, farm.id],
    );

    // `OPEN-17` made visible: the column stores it, the API cannot represent it, and
    // returning it as a `PolygonGeometry` would be a lie the type system cannot catch.
    await assert.rejects(
      () => scope.withTenant(userId, (tx) => findField(tx, rows[0].id)),
      /not a GeoJSON Polygon/,
    );
  });
});

describe("constraints and transactions", () => {
  it("refuses a field whose farm belongs to another tenant, at the composite FK", async () => {
    const tenantA = await createUser("fk-a");
    const tenantB = await createUser("fk-b");
    const farm = await farmFor(tenantA, "Induk A");

    await rejectsWithSqlState(
      () =>
        scope.withTenant(tenantB, (tx) =>
          tx.$executeRawUnsafe(
            `INSERT INTO app.fields (user_id, farm_id, name, geom)
             VALUES (NULLIF(current_setting('app.user_id', true), '')::uuid, $1::uuid, 'x',
                     public.ST_SetSRID(public.ST_GeomFromGeoJSON($2::text), 4326))`,
            farm.id,
            JSON.stringify(SQUARE),
          ),
        ),
      "23503",
    );
  });

  it("leaves nothing behind when the caller's transaction fails", async () => {
    const userId = await createUser("rollback");

    await assert.rejects(() =>
      scope.withTenant(userId, async (tx) => {
        await createFarm(tx, { name: "Tidak jadi" });
        throw new Error("caller failed");
      }),
    );

    const { rows } = await owner.query(
      "SELECT count(*)::int AS n FROM app.farms WHERE user_id = $1::uuid",
      [userId],
    );
    assert.equal(rows[0].n, 0);
  });

  it("refuses a field that arrives while the farm delete is in flight", async () => {
    const userId = await createUser("race-delete");
    const farm = await farmFor(userId, "Balapan hapus");

    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });

    // The delete runs to completion inside its transaction, which is then held open:
    // the row lock stays held until `release()` and the commit.
    const deleting = scopeA.withTenant(userId, async (tx) => {
      const outcome = await softDeleteFarm(tx, farm.id);
      await gate;
      return outcome;
    });

    await sleep(150);
    const creating = scopeB.withTenant(userId, (tx) =>
      createField(tx, farm.id, { name: "Terlambat", geometry: SQUARE }),
    );
    assert.ok(await waitForLockWaiter(), "the create waited for the delete's row lock");
    release();

    assert.equal(await deleting, "deleted");
    assert.equal(await creating, null, "the create waited, then found no live parent");
  });

  it("refuses the farm delete when a field insert is still holding the parent", async () => {
    const userId = await createUser("race-create");
    const farm = await farmFor(userId, "Balapan buat");

    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });

    // `createField` takes `FOR SHARE` on the parent and the transaction keeps it
    // until `release()`, which is exactly the window a delete must not slip through.
    const creating = scopeA.withTenant(userId, async (tx) => {
      const field = await createField(tx, farm.id, { name: "Petak", geometry: SQUARE });
      await gate;
      return field;
    });

    await sleep(150);
    const deleting = scopeB.withTenant(userId, (tx) => softDeleteFarm(tx, farm.id));
    assert.ok(await waitForLockWaiter(), "the delete waited for the create's lock");
    release();

    const field = await creating;
    assert.notEqual(field, null);
    created.fields.push(field.id);
    assert.equal(await deleting, "has_live_fields");
    assert.equal((await readFarm(farm.id)).deleted_at, null);
  });
});

describe("field anchor", () => {
  const SIX_DECIMALS = /^-?\d+\.\d{6}$/;

  it("returns the centroid of a known square at six decimals", async () => {
    const userId = await createUser("anchor-square");
    const farm = await farmFor(userId, "Petak anchor");
    const field = await fieldFor(userId, farm.id, "Kotak", SQUARE);

    const anchor = await scope.withTenant(userId, (tx) => selectFieldAnchor(tx, field.id));

    assert.notEqual(anchor, null, "the owning tenant sees its own anchor");
    assert.equal(anchor.lat, "-6.150000");
    assert.equal(anchor.lon, "106.850000");
    assert.match(anchor.lat, SIX_DECIMALS);
    assert.match(anchor.lon, SIX_DECIMALS);
    // Axes in order: latitude is the small negative, longitude the large positive.
    // A swapped result would be `lon = -6.15`, which both assertions below reject.
    assert.ok(Number(anchor.lat) < 0, "latitude is the negative component");
    assert.ok(Number(anchor.lon) > 100, "longitude is the positive component");
  });

  it("returns null for another tenant's field instead of its coordinates", async () => {
    const ownerId = await createUser("anchor-owner");
    const strangerId = await createUser("anchor-stranger");
    const farm = await farmFor(ownerId, "Milik A");
    const field = await fieldFor(ownerId, farm.id, "Rahasia", SQUARE);

    assert.notEqual(
      await scope.withTenant(ownerId, (tx) => selectFieldAnchor(tx, field.id)),
      null,
      "the owner can read it",
    );
    assert.equal(await scope.withTenant(strangerId, (tx) => selectFieldAnchor(tx, field.id)), null);
  });

  it("returns null once the field is soft-deleted", async () => {
    const userId = await createUser("anchor-deleted");
    const farm = await farmFor(userId, "Petak dihapus");
    const field = await fieldFor(userId, farm.id, "Sementara", SQUARE);

    assert.notEqual(await scope.withTenant(userId, (tx) => selectFieldAnchor(tx, field.id)), null);
    assert.equal(await scope.withTenant(userId, (tx) => softDeleteField(tx, field.id)), true);
    assert.equal(await scope.withTenant(userId, (tx) => selectFieldAnchor(tx, field.id)), null);
  });

  it("returns null for a field that never existed", async () => {
    const userId = await createUser("anchor-missing");
    assert.equal(
      await scope.withTenant(userId, (tx) =>
        selectFieldAnchor(tx, "00000000-0000-4000-8000-000000000000"),
      ),
      null,
    );
  });
});
