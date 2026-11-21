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
});
