/**
 * Field CRUD through the real HTTP pipeline, over real PostgreSQL and the real
 * `app_api` / `app_auth` roles.
 *
 * Same harness as the Farm suite (`support.mjs`): no doubles, fixtures and physical
 * assertions as `migration_owner`, every request as `app_api` behind a real session,
 * `Origin` validation, and `X-CSRF-Token`.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import {
  SQUARE,
  SQUARE_JSON,
  UUID,
  apiFor,
  cleanupUsers,
  headers,
  ownerRow as readOwnerRow,
  seedUser as seedFixture,
  startHarness,
  stopHarness,
} from "./support.mjs";

const EMAIL_PREFIX = "field-api-";

/** A ring that crosses itself: valid GeoJSON, invalid polygon, only PostGIS can tell. */
const BOWTIE = {
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

let harness;
let call;
let alice;
let bob;
let lister;
let corrupt;

const ownerRow = (table, id) => readOwnerRow(harness.owner, table, id);
const seedUser = (label) => seedFixture(harness.owner, EMAIL_PREFIX, label);

async function createFarm(user, name = "Farm") {
  const { response, body } = await call(user, "POST", "/v1/farms", { body: { name } });
  assert.equal(response.status, 201, JSON.stringify(body));
  return body.data;
}

async function createField(user, farmId, name = "Plot", geometry = SQUARE) {
  const { response, body } = await call(user, "POST", "/v1/fields", {
    body: { farmId, name, geometry },
  });
  assert.equal(response.status, 201, JSON.stringify(body));
  return body.data;
}

async function fieldCount(user) {
  const rows = await harness.owner.$queryRawUnsafe(
    "SELECT count(*)::int AS total FROM app.fields WHERE user_id = $1::uuid",
    user.id,
  );
  return rows[0].total;
}

/** The generated area, read as the owner: the response must not invent one. */
async function storedArea(fieldId) {
  const rows = await harness.owner.$queryRawUnsafe(
    "SELECT area_ha FROM app.fields WHERE id = $1::uuid",
    fieldId,
  );
  return rows[0].area_ha;
}

/** PostGIS re-serialises coordinates, so compare numerically rather than as text. */
function assertSamePolygon(actual, expected = SQUARE) {
  assert.equal(actual.type, "Polygon");
  assert.equal(actual.coordinates.length, expected.coordinates.length);
  for (const [ringIndex, ring] of expected.coordinates.entries()) {
    const actualRing = actual.coordinates[ringIndex];
    assert.equal(actualRing.length, ring.length);
    for (const [positionIndex, [longitude, latitude]] of ring.entries()) {
      const position = actualRing[positionIndex];
      assert.ok(Math.abs(position[0] - longitude) < 1e-9, `ring ${ringIndex} lon ${position[0]}`);
      assert.ok(Math.abs(position[1] - latitude) < 1e-9, `ring ${ringIndex} lat ${position[1]}`);
    }
  }
}

before(async () => {
  harness = await startHarness();
  call = apiFor(harness.base).call;

  alice = await seedUser("alice");
  bob = await seedUser("bob");
  lister = await seedUser("lister");
  corrupt = await seedUser("corrupt");
});

after(async () => {
  await cleanupUsers(harness.owner, EMAIL_PREFIX);
  await stopHarness(harness);
});

describe("POST /v1/fields", () => {
  it("creates a field under the caller's farm and returns the stored polygon", async () => {
    const farm = await createFarm(alice, "Create farm");
    const { response, body } = await call(alice, "POST", "/v1/fields", {
      body: { farmId: farm.id, name: "  North plot ", geometry: SQUARE },
    });

    assert.equal(response.status, 201);
    assert.equal(response.headers.get("location"), `/v1/fields/${body.data.id}`);
    assert.match(body.data.id, UUID);
    assert.equal(body.data.farmId, farm.id);
    assert.equal(body.data.name, "North plot");
    assert.deepEqual(Object.keys(body.data).sort(), [
      "areaHa",
      "createdAt",
      "farmId",
      "geometry",
      "id",
      "name",
      "updatedAt",
    ]);
    assertSamePolygon(body.data.geometry);

    const row = await ownerRow("fields", body.data.id);
    assert.equal(row.user_id, alice.id);
    assert.equal(row.farm_id, farm.id);
    assert.equal(row.deleted_at, null);
  });

  it("takes areaHa from the generated column, not from the request", async () => {
    const farm = await createFarm(alice, "Area farm");
    const field = await createField(alice, farm.id);

    assert.ok(field.areaHa > 0);
    assert.equal(field.areaHa, await storedArea(field.id));

    const refused = await call(alice, "POST", "/v1/fields", {
      body: { farmId: farm.id, name: "Injected", geometry: SQUARE, areaHa: 1 },
    });
    assert.equal(refused.response.status, 400);
    assert.equal(refused.body.error.code, "VALIDATION_FAILED");
  });

  it("answers FARM_NOT_FOUND for a foreign, missing or deleted parent and writes nothing", async () => {
    const foreign = await createFarm(bob, "Bob's farm");
    const deleted = await createFarm(alice, "Deleted farm");
    assert.equal((await call(alice, "DELETE", `/v1/farms/${deleted.id}`)).response.status, 204);

    const before = await fieldCount(alice);
    for (const farmId of [foreign.id, randomUUID(), deleted.id]) {
      const { response, body } = await call(alice, "POST", "/v1/fields", {
        body: { farmId, name: "Orphan", geometry: SQUARE },
      });
      assert.equal(response.status, 404, farmId);
      assert.equal(body.error.code, "FARM_NOT_FOUND");
    }
    assert.equal(await fieldCount(alice), before, "a refused create leaves no row");
  });

  it("refuses every geometry the contract owns", async () => {
    const farm = await createFarm(alice, "Geometry farm");
    const before = await fieldCount(alice);

    const ring = SQUARE.coordinates[0];
    const cases = {
      point: { type: "Point", coordinates: [106.8, -6.2] },
      multipolygon: { type: "MultiPolygon", coordinates: [SQUARE.coordinates] },
      line: { type: "LineString", coordinates: ring },
      collection: { type: "GeometryCollection", geometries: [] },
      three_dimensional: {
        type: "Polygon",
        coordinates: [ring.map(([x, y]) => [x, y, 0])],
      },
      empty: { type: "Polygon", coordinates: [] },
      short_ring: { type: "Polygon", coordinates: [ring.slice(0, 3)] },
      unclosed_ring: { type: "Polygon", coordinates: [ring.slice(0, -1)] },
      crs: { ...SQUARE, crs: { type: "name", properties: { name: "EPSG:3857" } } },
      bbox: { ...SQUARE, bbox: [106.8, -6.2, 106.9, -6.1] },
      string_ordinates: {
        type: "Polygon",
        coordinates: [ring.map(([x, y]) => [String(x), y])],
      },
      out_of_bounds: {
        type: "Polygon",
        coordinates: [ring.map(([x, y]) => [x + 100, y])],
      },
    };

    for (const [label, geometry] of Object.entries(cases)) {
      const { response, body } = await call(alice, "POST", "/v1/fields", {
        body: { farmId: farm.id, name: "Bad", geometry },
      });
      assert.equal(response.status, 400, label);
      assert.equal(body.error.code, "VALIDATION_FAILED", label);
      assert.ok(
        Array.isArray(body.error.details) && body.error.details.length > 0,
        `${label} carries details`,
      );
    }

    assert.equal(await fieldCount(alice), before, "no invalid shape created a row");
  });

  it("refuses server-managed, tenant and agronomic properties in the body", async () => {
    const farm = await createFarm(alice, "Strict body farm");
    const before = await fieldCount(alice);

    for (const extra of [
      { userId: bob.id },
      { farm_id: farm.id },
      { deletedAt: null },
      { createdAt: "2026-11-21T00:00:00.000Z" },
      { soilType: "clay" },
      { soil_ph: 6.5 },
      { elevationM: 12 },
    ]) {
      const { response, body } = await call(alice, "POST", "/v1/fields", {
        body: { farmId: farm.id, name: "Injected", geometry: SQUARE, ...extra },
      });
      assert.equal(response.status, 400, JSON.stringify(extra));
      assert.equal(body.error.code, "VALIDATION_FAILED", JSON.stringify(extra));
    }

    assert.equal(await fieldCount(alice), before, "no refused body created a row");
  });

  it("refuses a self-intersecting polygon with 400, not a database error", async () => {
    const farm = await createFarm(alice, "Topology farm");
    const before = await fieldCount(alice);

    const { response, body } = await call(alice, "POST", "/v1/fields", {
      body: { farmId: farm.id, name: "Bowtie", geometry: BOWTIE },
    });

    assert.equal(response.status, 400);
    assert.equal(body.error.code, "VALIDATION_FAILED");
    assert.deepEqual(body.error.details, [{ path: "geometry", issue: "invalid_geometry" }]);
    assert.equal(await fieldCount(alice), before, "the failed insert left no row");
  });

  it("requires a session, a trusted Origin and a CSRF token", async () => {
    const farm = await createFarm(alice, "Guarded farm");

    assert.equal(
      (
        await call(alice, "POST", "/v1/fields", {
          body: { farmId: farm.id, name: "x", geometry: SQUARE },
          anonymous: true,
        })
      ).response.status,
      401,
    );

    const payload = JSON.stringify({ farmId: farm.id, name: "x", geometry: SQUARE });

    const wrongOrigin = await fetch(`${harness.base}/v1/fields`, {
      method: "POST",
      headers: headers(alice, { origin: "http://evil.test" }),
      body: payload,
    });
    assert.equal(wrongOrigin.status, 403);

    const noCsrf = await fetch(`${harness.base}/v1/fields`, {
      method: "POST",
      headers: headers(alice, { csrf: false }),
      body: payload,
    });
    assert.equal(noCsrf.status, 403);
  });
});

describe("GET /v1/fields", () => {
  let firstFarm;
  let secondFarm;
  let first;
  let second;
  let third;

  before(async () => {
    firstFarm = await createFarm(lister, "List farm one");
    secondFarm = await createFarm(lister, "List farm two");
    first = await createField(lister, firstFarm.id, "Alpha");
    second = await createField(lister, firstFarm.id, "Beta");
    third = await createField(lister, secondFarm.id, "Gamma");
    await createField(bob, (await createFarm(bob, "Bob's list farm")).id, "Bob only");
  });

  it("lists the tenant's fields with the documented meta", async () => {
    const { response, body } = await call(lister, "GET", "/v1/fields");

    assert.equal(response.status, 200);
    assert.deepEqual(body.meta, { page: 1, pageSize: 20, total: 3 });
    assert.deepEqual(
      body.data.map((field) => field.id).sort(),
      [first.id, second.id, third.id].sort(),
    );
  });

  it("filters by farmId and scopes the total to that farm", async () => {
    const { body } = await call(lister, "GET", `/v1/fields?farmId=${firstFarm.id}&sort=name`);

    assert.deepEqual(
      body.data.map((field) => field.name),
      ["Alpha", "Beta"],
    );
    assert.deepEqual(body.meta, { page: 1, pageSize: 20, total: 2 });
  });

  it("pages, sorts by area and carries stable metadata", async () => {
    const paged = await call(lister, "GET", "/v1/fields?page=2&pageSize=2&sort=-areaHa");
    assert.equal(paged.body.data.length, 1);
    assert.deepEqual(paged.body.meta, { page: 2, pageSize: 2, total: 3 });

    const all = await call(lister, "GET", "/v1/fields?sort=areaHa");
    const areas = all.body.data.map((field) => field.areaHa);
    assert.deepEqual(
      areas,
      [...areas].sort((left, right) => left - right),
    );
  });

  it("rejects an unknown parameter, a bad farmId and out-of-range paging", async () => {
    for (const query of ["?filter=x", "?farmId=nope", "?page=0", "?pageSize=101", "?page=1.5"]) {
      const { response, body } = await call(lister, "GET", `/v1/fields${query}`);
      assert.equal(response.status, 400, query);
      assert.equal(body.error.code, "VALIDATION_FAILED");
    }
  });

  it("answers FARM_NOT_FOUND for a foreign or deleted farm filter", async () => {
    const foreign = await createFarm(bob, "Bob's filter farm");
    const deleted = await createFarm(lister, "Deleted filter farm");
    await call(lister, "DELETE", `/v1/farms/${deleted.id}`);

    for (const farmId of [foreign.id, deleted.id, randomUUID()]) {
      const { response, body } = await call(lister, "GET", `/v1/fields?farmId=${farmId}`);
      assert.equal(response.status, 404, farmId);
      assert.equal(body.error.code, "FARM_NOT_FOUND");
    }
  });

  it("hides a soft-deleted field and does not require CSRF", async () => {
    const doomed = await createField(lister, firstFarm.id, "Doomed");
    assert.equal((await call(lister, "DELETE", `/v1/fields/${doomed.id}`)).response.status, 204);

    const { response, body } = await call(lister, "GET", `/v1/fields?farmId=${firstFarm.id}`, {
      csrf: false,
    });
    assert.equal(response.status, 200);
    assert.equal(
      body.data.some((field) => field.id === doomed.id),
      false,
    );
    assert.equal(body.meta.total, 2);
  });

  it("requires a session", async () => {
    assert.equal(
      (await call(lister, "GET", "/v1/fields", { anonymous: true })).response.status,
      401,
    );
  });
});

describe("GET /v1/fields/:fieldId", () => {
  it("returns the caller's own field with the stored geometry", async () => {
    const farm = await createFarm(alice, "Detail farm");
    const field = await createField(alice, farm.id, "Detail");
    const { response, body } = await call(alice, "GET", `/v1/fields/${field.id}`);

    assert.equal(response.status, 200);
    assert.equal(body.data.id, field.id);
    assert.equal(body.data.farmId, farm.id);
    assertSamePolygon(body.data.geometry);
    assert.equal(body.data.areaHa, await storedArea(field.id));
  });

  it("answers the same FIELD_NOT_FOUND for missing, foreign and deleted fields", async () => {
    const foreign = await createField(bob, (await createFarm(bob, "Bob's detail farm")).id);
    const deleted = await createField(alice, (await createFarm(alice, "Gone farm")).id);
    await call(alice, "DELETE", `/v1/fields/${deleted.id}`);

    for (const id of [randomUUID(), foreign.id, deleted.id]) {
      const { response, body } = await call(alice, "GET", `/v1/fields/${id}`);
      assert.equal(response.status, 404, id);
      assert.equal(body.error.code, "FIELD_NOT_FOUND");
    }
  });

  it("rejects a non-UUID path and requires a session", async () => {
    assert.equal((await call(alice, "GET", "/v1/fields/nope")).response.status, 400);
    assert.equal(
      (await call(alice, "GET", `/v1/fields/${randomUUID()}`, { anonymous: true })).response.status,
      401,
    );
  });
});

describe("PATCH /v1/fields/:fieldId", () => {
  it("updates the name and leaves the shape untouched", async () => {
    const farm = await createFarm(alice, "Patch farm");
    const field = await createField(alice, farm.id, "Old");
    const { response, body } = await call(alice, "PATCH", `/v1/fields/${field.id}`, {
      body: { name: "  New  " },
    });

    assert.equal(response.status, 200);
    assert.equal(body.data.name, "New");
    assert.equal(body.data.areaHa, field.areaHa, "omitted geometry is unchanged");
    assertSamePolygon(body.data.geometry);
  });

  it("replacing the geometry recomputes the generated area", async () => {
    const farm = await createFarm(alice, "Reshape farm");
    const field = await createField(alice, farm.id);

    const smaller = {
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
    const { body } = await call(alice, "PATCH", `/v1/fields/${field.id}`, {
      body: { geometry: smaller },
    });

    assert.ok(body.data.areaHa < field.areaHa);
    assert.equal(body.data.areaHa, await storedArea(field.id));
    assertSamePolygon(body.data.geometry, smaller);
  });

  it("rejects an empty update, unknown keys, areaHa, farmId and a null name", async () => {
    const farm = await createFarm(alice, "Strict patch farm");
    const field = await createField(alice, farm.id, "Strict");

    for (const body of [
      {},
      { extra: 1 },
      { areaHa: 1 },
      { farmId: farm.id },
      { name: null },
      { geometry: BOWTIE },
    ]) {
      const { response, body: payload } = await call(alice, "PATCH", `/v1/fields/${field.id}`, {
        body,
      });
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(payload.error.code, "VALIDATION_FAILED");
    }

    const unchanged = await call(alice, "GET", `/v1/fields/${field.id}`);
    assert.equal(unchanged.body.data.name, "Strict");
  });

  it("rolls back a rejected geometry and mutates nothing", async () => {
    const farm = await createFarm(alice, "Rollback farm");
    const field = await createField(alice, farm.id, "Before");
    const rowBefore = await ownerRow("fields", field.id);

    const { response, body } = await call(alice, "PATCH", `/v1/fields/${field.id}`, {
      body: { name: "After", geometry: BOWTIE },
    });
    assert.equal(response.status, 400);
    assert.deepEqual(body.error.details, [{ path: "geometry", issue: "invalid_geometry" }]);

    const rowAfter = await ownerRow("fields", field.id);
    assert.equal(rowAfter.name, "Before", "the UPDATE statement never committed");
    assert.equal(rowAfter.geometry, rowBefore.geometry);
    assert.equal(rowAfter.area_ha, rowBefore.area_ha);
    assert.equal(rowAfter.updated_at.getTime(), rowBefore.updated_at.getTime());
  });

  it("answers FIELD_NOT_FOUND for a foreign or deleted field", async () => {
    const foreign = await createField(bob, (await createFarm(bob, "Bob's patch farm")).id);
    const deleted = await createField(alice, (await createFarm(alice, "Deleted patch farm")).id);
    await call(alice, "DELETE", `/v1/fields/${deleted.id}`);

    for (const id of [foreign.id, deleted.id]) {
      const { response, body } = await call(alice, "PATCH", `/v1/fields/${id}`, {
        body: { name: "nope" },
      });
      assert.equal(response.status, 404);
      assert.equal(body.error.code, "FIELD_NOT_FOUND");
    }
  });

  it("requires a session, Origin and CSRF", async () => {
    const farm = await createFarm(alice, "Guarded patch farm");
    const field = await createField(alice, farm.id);

    assert.equal(
      (
        await call(alice, "PATCH", `/v1/fields/${field.id}`, {
          body: { name: "x" },
          anonymous: true,
        })
      ).response.status,
      401,
    );
    assert.equal(
      (
        await call(alice, "PATCH", `/v1/fields/${field.id}`, {
          body: { name: "x" },
          csrf: false,
        })
      ).response.status,
      403,
    );
    assert.equal(
      (
        await call(alice, "PATCH", `/v1/fields/${field.id}`, {
          body: { name: "x" },
          origin: "http://evil.test",
        })
      ).response.status,
      403,
    );
  });
});

describe("DELETE /v1/fields/:fieldId", () => {
  it("soft-deletes the field and keeps the row", async () => {
    const farm = await createFarm(alice, "Delete farm");
    const field = await createField(alice, farm.id, "Disposable");

    const { response, body } = await call(alice, "DELETE", `/v1/fields/${field.id}`);
    assert.equal(response.status, 204);
    assert.equal(body, undefined);

    const row = await ownerRow("fields", field.id);
    assert.notEqual(row.deleted_at, null, "the row is soft-deleted, not removed");

    assert.equal((await call(alice, "GET", `/v1/fields/${field.id}`)).response.status, 404);
    assert.equal((await call(alice, "DELETE", `/v1/fields/${field.id}`)).response.status, 404);
  });

  it("answers FIELD_NOT_FOUND for a foreign or missing field", async () => {
    const foreign = await createField(bob, (await createFarm(bob, "Bob's delete farm")).id);

    for (const id of [foreign.id, randomUUID()]) {
      const { response, body } = await call(alice, "DELETE", `/v1/fields/${id}`);
      assert.equal(response.status, 404);
      assert.equal(body.error.code, "FIELD_NOT_FOUND");
    }
    assert.equal((await ownerRow("fields", foreign.id)).deleted_at, null);
  });

  it("requires a session, Origin and CSRF", async () => {
    const farm = await createFarm(alice, "Guarded delete farm");
    const field = await createField(alice, farm.id);

    assert.equal(
      (await call(alice, "DELETE", `/v1/fields/${field.id}`, { anonymous: true })).response.status,
      401,
    );
    assert.equal(
      (await call(alice, "DELETE", `/v1/fields/${field.id}`, { csrf: false })).response.status,
      403,
    );
    assert.equal(
      (await call(alice, "DELETE", `/v1/fields/${field.id}`, { origin: "http://evil.test" }))
        .response.status,
      403,
    );
  });
});

describe("stored geometry outside the public contract", () => {
  /**
   * Writes a row as the owner. `app.fields.geom` is a generic
   * `geometry(Geometry, 4326)`: its CHECKs cover type, SRID, validity, and
   * emptiness, and the column's typmod pins two dimensions — but nothing bounds
   * the coordinates, so an off-grid polygon is storable and only the API can
   * refuse it.
   */
  async function seedStored(user, label, geojson) {
    const farm = await createFarm(user, `${label} farm`);
    const rows = await harness.owner.$queryRawUnsafe(
      `INSERT INTO app.fields (farm_id, user_id, name, geom)
       VALUES ($1::uuid, $2::uuid, $3, ST_GeomFromGeoJSON($4::text))
       RETURNING id::text AS id`,
      farm.id,
      user.id,
      label,
      JSON.stringify(geojson),
    );
    return { farmId: farm.id, fieldId: rows[0].id };
  }

  const OFF_GRID = {
    type: "Polygon",
    coordinates: [
      [
        [206.8, -6.2],
        [206.9, -6.2],
        [206.9, -6.1],
        [206.8, -6.2],
      ],
    ],
  };

  it("returns a stored 2D polygon unchanged", async () => {
    const seeded = await seedStored(corrupt, "plain", SQUARE);
    const { response, body } = await call(corrupt, "GET", `/v1/fields/${seeded.fieldId}`);

    assert.equal(response.status, 200);
    assertSamePolygon(body.data.geometry);
    assert.equal(body.data.areaHa, await storedArea(seeded.fieldId));
    assert.equal(
      (
        await harness.owner.$queryRawUnsafe(
          "SELECT ST_NDims(geom) AS dims FROM app.fields WHERE id = $1::uuid",
          seeded.fieldId,
        )
      )[0].dims,
      2,
    );
  });

  it("refuses stored coordinates outside WGS 84 instead of echoing them", async () => {
    const seeded = await seedStored(corrupt, "off grid", OFF_GRID);

    // Storable: a 4326 SRID does not bound the ordinates, and the shape is valid.
    assert.equal(
      (
        await harness.owner.$queryRawUnsafe(
          "SELECT ST_IsValid(geom) AS valid FROM app.fields WHERE id = $1::uuid",
          seeded.fieldId,
        )
      )[0].valid,
      true,
    );

    const { response, body } = await call(corrupt, "GET", `/v1/fields/${seeded.fieldId}`);
    assert.equal(response.status, 500);
    assert.equal(body.error.code, "INTERNAL_ERROR");
    assert.equal(JSON.stringify(body).includes("206.8"), false, "no geometry is echoed");
  });

  it("rolls back a PATCH whose stored geometry cannot be mapped", async () => {
    const seeded = await seedStored(corrupt, "unmappable", OFF_GRID);
    const readRow = () =>
      harness.owner
        .$queryRawUnsafe(
          "SELECT name, updated_at, geom::text AS geom, area_ha, deleted_at FROM app.fields WHERE id = $1::uuid",
          seeded.fieldId,
        )
        .then((rows) => rows[0]);

    const before = await readRow();
    const { response, body } = await call(corrupt, "PATCH", `/v1/fields/${seeded.fieldId}`, {
      body: { name: "Renamed" },
    });

    assert.equal(response.status, 500);
    assert.equal(body.error.code, "INTERNAL_ERROR");

    // Mapping happens inside `withTenant`, so the UPDATE never commits.
    const after = await readRow();
    assert.equal(after.name, before.name, "the name was not changed");
    assert.equal(
      after.updated_at.getTime(),
      before.updated_at.getTime(),
      "updated_at did not move",
    );
    assert.equal(after.geom, before.geom, "the stored geometry is untouched");
    assert.equal(after.area_ha, before.area_ha);
    assert.equal(after.deleted_at, null);
  });

  it("cannot store a 3D polygon, so no response can drop an ordinate", async () => {
    // The column is `geometry(Geometry, 4326)` — two dimensions — so PostGIS
    // refuses a Z write with `22023`. That is why the truncation this task fixes
    // was latent rather than observed: there was no reachable 3D row. The rule
    // that a 3D polygon is unacceptable is still enforced by the contract
    // (`packages/contracts/src/field.test.ts`) and applied to every stored row by
    // the resource mapper.
    const z = {
      type: "Polygon",
      coordinates: [
        [
          [106.8, -6.2, 100],
          [106.9, -6.2, 110],
          [106.9, -6.1, 120],
          [106.8, -6.2, 100],
        ],
      ],
    };
    const farm = await createFarm(corrupt, "three dimensional farm");
    const before = await fieldCount(corrupt);

    await assert.rejects(
      harness.owner.$queryRawUnsafe(
        `INSERT INTO app.fields (farm_id, user_id, name, geom)
         VALUES ($1::uuid, $2::uuid, 'z', ST_GeomFromGeoJSON($3::text))`,
        farm.id,
        corrupt.id,
        JSON.stringify(z),
      ),
      (error) => String(error.message).includes("22023"),
      "the column's typmod refuses a Z geometry",
    );

    assert.equal(await fieldCount(corrupt), before, "nothing was written");
  });

  it("refuses a POINT at the database CHECK (OPEN-17) and refuses a stored MULTIPOLYGON", async () => {
    const pointFarm = await createFarm(corrupt, "point check farm");
    await assert.rejects(
      harness.owner.$queryRawUnsafe(
        `INSERT INTO app.fields (farm_id, user_id, name, geom)
         VALUES ($1::uuid, $2::uuid, 'point', ST_GeomFromGeoJSON($3::text))`,
        pointFarm.id,
        corrupt.id,
        JSON.stringify({ type: "Point", coordinates: [106.8, -6.2] }),
      ),
      (error) => String(error.message).includes("fields_geom_type_check"),
    );

    const seeded = await seedStored(corrupt, "multipolygon", {
      type: "MultiPolygon",
      coordinates: [SQUARE.coordinates],
    });
    const { response, body } = await call(corrupt, "GET", `/v1/fields/${seeded.fieldId}`);
    assert.equal(response.status, 500, "multipolygon");
    assert.equal(body.error.code, "INTERNAL_ERROR", "multipolygon");
  });

  it("fails the collection rather than omitting or rewriting a bad row", async () => {
    // Same tenant as the shapes above: the page holds good and unrepresentable
    // rows. Omitting them would be silent data loss; a partial rewrite would be
    // the bug this task removes.
    const { response, body } = await call(corrupt, "GET", "/v1/fields");

    assert.equal(response.status, 500);
    assert.equal(body.error.code, "INTERNAL_ERROR");
  });
});

describe("tenant isolation and the Farm deletion rule", () => {
  it("conflicts with a live field, then allows the farm once the field is deleted", async () => {
    const farm = await createFarm(alice, "Occupied farm");
    const field = await createField(alice, farm.id);

    const refused = await call(alice, "DELETE", `/v1/farms/${farm.id}`);
    assert.equal(refused.response.status, 409);
    assert.equal(refused.body.error.code, "CONFLICT");
    assert.equal((await ownerRow("farms", farm.id)).deleted_at, null);

    assert.equal((await call(alice, "DELETE", `/v1/fields/${field.id}`)).response.status, 204);
    assert.equal((await call(alice, "DELETE", `/v1/farms/${farm.id}`)).response.status, 204);
  });

  it("cannot read, update or delete another tenant's field", async () => {
    const farm = await createFarm(alice, "Alice's private farm");
    const field = await createField(alice, farm.id, "Alice's private field");

    for (const [method, body] of [
      ["GET", undefined],
      ["PATCH", { name: "stolen" }],
      ["DELETE", undefined],
    ]) {
      const { response, body: payload } = await call(bob, method, `/v1/fields/${field.id}`, {
        body,
      });
      assert.equal(response.status, 404, method);
      assert.equal(payload.error.code, "FIELD_NOT_FOUND");
    }

    const stillThere = await ownerRow("fields", field.id);
    assert.equal(stillThere.name, "Alice's private field");
    assert.equal(stillThere.deleted_at, null);
  });

  it("cannot create a field under another tenant's farm", async () => {
    const farm = await createFarm(alice, "Alice's farm for bob");
    const { response, body } = await call(bob, "POST", "/v1/fields", {
      body: { farmId: farm.id, name: "Squatter", geometry: SQUARE },
    });

    assert.equal(response.status, 404);
    assert.equal(body.error.code, "FARM_NOT_FOUND");
  });

  it("does not list another tenant's fields", async () => {
    await createField(alice, (await createFarm(alice, "Alice's listing farm")).id, "Alice only");
    const { body } = await call(bob, "GET", "/v1/fields?sort=name");

    assert.equal(
      body.data.some((field) => field.name === "Alice only"),
      false,
    );
  });

  it("reads and updates closed-vocabulary agronomy profile (OPEN-21) with RLS isolation", async () => {
    const farm = await createFarm(alice, "Agronomy farm");
    const field = await createField(alice, farm.id, "Agronomy field");

    const initial = await call(alice, "GET", `/v1/fields/${field.id}/agronomy`);
    assert.equal(initial.response.status, 200);
    assert.equal(initial.body.data.soilType, null);

    const bad = await call(alice, "PATCH", `/v1/fields/${field.id}/agronomy`, {
      body: { soilType: "moon_dust" },
    });
    assert.equal(bad.response.status, 400);

    const updated = await call(alice, "PATCH", `/v1/fields/${field.id}/agronomy`, {
      body: {
        soilType: "volcanic",
        drainageClass: "well",
        soilPh: 6.3,
        elevationM: 420,
        irrigationAvailability: "partial_irrigation",
        waterSource: "Irigasi teknis desa",
      },
    });
    assert.equal(updated.response.status, 200);
    assert.equal(updated.body.data.soilType, "volcanic");
    assert.equal(updated.body.data.drainageClass, "well");
    assert.equal(updated.body.data.irrigationAvailability, "partial_irrigation");

    const bobGet = await call(bob, "GET", `/v1/fields/${field.id}/agronomy`);
    assert.equal(bobGet.response.status, 404);
  });
});
