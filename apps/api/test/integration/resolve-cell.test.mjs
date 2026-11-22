/**
 * `POST /v1/fields/:fieldId/resolve-cell` through the real HTTP pipeline, over real
 * PostgreSQL and the real `app_api` / `app_auth` roles.
 *
 * The registry is the one substitution. Production binds `syntheticGridRegistry`
 * (provider `synthetic`), which the database CHECK refuses — deliberately, and this
 * suite does not weaken that. So the harness is given an isolated registry with one
 * entry: provider `ecmwf` (database-allowed), a model string that exists only in
 * this file, a bounded one-degree lattice over the fixture's coordinates, and
 * `evidence: "synthetic"`. It is a test grid, not a provider grid, and nothing here
 * claims a provider has been validated or has served a cell.
 *
 * Every assertion that matters runs as `app_api` behind a real session, CSRF token,
 * and `Origin` check. `migration_owner` is used only to seed and to read physical
 * state.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { createGridRegistry, defineGridSpec } from "@agroclimate/contracts";

import {
  SQUARE,
  UUID,
  apiFor,
  cleanupUsers,
  seedUser as seedFixture,
  startHarness,
  stopHarness,
} from "./support.mjs";

const EMAIL_PREFIX = "resolve-cell-";
const MODEL = `test_sumatra_1deg_${Date.now()}`;
const PROVIDER = "ecmwf";

/**
 * One degree, bounded `-10..10` lat and `100..120` lon: aligned with its own origin
 * and step, so `defineGridSpec` accepts it. The `SQUARE` centroid `(-6.15, 106.85)`
 * falls in row 3, column 6, whose node is `(-7.00, 106.00)` — deliberately *not* the
 * centroid, so "anchor ≠ requested" is measurable rather than incidental.
 */
const GRID = defineGridSpec({
  gridId: "test-sumatra-1deg",
  originLat: "-10",
  originLon: "100",
  stepLat: "1",
  stepLon: "1",
  latRange: ["-10", "10"],
  lonDomain: "bounded",
  lonRange: ["100", "120"],
  orientation: "south-west",
  spatialResolutionKm: 111,
});

/** Test-only. Never registered in `syntheticGridRegistry`, never `validated`. */
const TEST_REGISTRY = createGridRegistry([
  { provider: PROVIDER, model: MODEL, spec: GRID, evidence: "synthetic" },
]);

/** Same shape as `SQUARE`, ~11 degrees east of the grid's longitude domain. */
const OUTSIDE = {
  type: "Polygon",
  coordinates: [
    [
      [130, -6.2],
      [130.1, -6.2],
      [130.1, -6.1],
      [130, -6.1],
      [130, -6.2],
    ],
  ],
};

let harness;
let call;
let alice;
let bob;

const seedUser = (label) => seedFixture(harness.owner, EMAIL_PREFIX, label);

async function createFarm(user, name = "Farm") {
  const { response, body } = await call(user, "POST", "/v1/farms", { body: { name } });
  assert.equal(response.status, 201, JSON.stringify(body));
  return body.data;
}

async function createField(user, farmId, geometry = SQUARE) {
  const { response, body } = await call(user, "POST", "/v1/fields", {
    body: { farmId, name: "Plot", geometry },
  });
  assert.equal(response.status, 201, JSON.stringify(body));
  return body.data;
}

const resolve = (user, fieldId, body = { provider: PROVIDER, model: MODEL }) =>
  call(user, "POST", `/v1/fields/${fieldId}/resolve-cell`, { body });

/** Cell rows for the test identity, as the owner — nothing is hidden by a grant. */
async function cellRows() {
  return harness.owner.$queryRawUnsafe(
    `SELECT id::text AS id, provider, model, cell_key, served_lat, served_lon,
            elevation_m, spatial_resolution_km, served_updated_at
       FROM app.outlook_cells
      WHERE model = $1`,
    MODEL,
  );
}

/**
 * How many cells this suite's test identity has. Negative cases compare against a
 * baseline rather than asserting zero, so their order inside the file cannot make
 * them pass or fail for the wrong reason.
 */
async function cellCount() {
  const rows = await cellRows();
  return rows.length;
}

/**
 * Runs a call that must mint nothing. Comparing counts around the call keeps the
 * assertion true regardless of what earlier cases in the file have persisted.
 */
async function mintsNothing(attempt) {
  const before = await cellCount();
  const result = await attempt();
  assert.equal(await cellCount(), before, "the failed call wrote no cell row");
  return result;
}

before(async () => {
  harness = await startHarness({ gridRegistry: TEST_REGISTRY });
  call = apiFor(harness.base).call;
  await cleanupUsers(harness.owner, EMAIL_PREFIX);
  await harness.owner.$executeRawUnsafe("DELETE FROM app.outlook_cells WHERE model = $1", MODEL);
  alice = await seedUser("alice");
  bob = await seedUser("bob");
});

after(async () => {
  await cleanupUsers(harness.owner, EMAIL_PREFIX);
  await harness.owner.$executeRawUnsafe("DELETE FROM app.outlook_cells WHERE model = $1", MODEL);
  await stopHarness(harness);
});

describe("resolve-cell — request and authentication", () => {
  it("rejects a request with no session", async () => {
    const field = await createField(alice, (await createFarm(alice)).id);
    const { response, body } = await call(alice, "POST", `/v1/fields/${field.id}/resolve-cell`, {
      body: { provider: PROVIDER, model: MODEL },
      anonymous: true,
    });
    assert.equal(response.status, 401);
    assert.equal(body.error.code, "UNAUTHENTICATED");
  });

  it("keeps the mutation behind CSRF", async () => {
    const field = await createField(alice, (await createFarm(alice)).id);
    const { response, body } = await call(alice, "POST", `/v1/fields/${field.id}/resolve-cell`, {
      body: { provider: PROVIDER, model: MODEL },
      csrf: false,
    });
    assert.equal(response.status, 403);
    assert.equal(body.error.code, "FORBIDDEN");
    assert.equal(await cellCount(), 0);
  });

  it("rejects a fieldId that is not a UUID before any lookup", async () => {
    const { response, body } = await mintsNothing(() => resolve(alice, "not-a-uuid"));
    assert.equal(response.status, 400);
    assert.equal(body.error.code, "VALIDATION_FAILED");
  });

  it("rejects unknown body properties, including a client-supplied coordinate", async () => {
    const field = await createField(alice, (await createFarm(alice)).id);
    const before = await cellCount();

    const base = { provider: PROVIDER, model: MODEL };
    const bodies = [
      { ...base, lat: "-6.15", lon: "106.85" },
      { ...base, cellKey: "-7.00,106.00" },
      { ...base, gridId: "test-sumatra-1deg" },
      { ...base, evidence: "validated" },
      { ...base, resolutionAlgorithmVersion: "grid-resolve/1" },
      { ...base, gridSpecHash: GRID.gridSpecHash },
      // A model alone names no grid: the pair is the key, and there is no
      // model-only lookup to fall back to.
      { model: MODEL },
      { provider: PROVIDER },
    ];

    for (const body of bodies) {
      const { response, body: error } = await resolve(alice, field.id, body);
      assert.equal(response.status, 400, JSON.stringify(error));
      assert.equal(error.error.code, "VALIDATION_FAILED");
    }
    assert.equal(await cellCount(), before, "a rejected body mints nothing");
  });
});

describe("resolve-cell — field visibility", () => {
  it("answers 200 for the tenant's own field", async () => {
    const field = await createField(alice, (await createFarm(alice)).id);
    const { response, body } = await resolve(alice, field.id);
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.match(body.data.cellId, UUID);
  });

  it("cannot tell another tenant's field from a field that never existed", async () => {
    const field = await createField(alice, (await createFarm(alice)).id);
    const before = await cellCount();
    const foreign = await resolve(bob, field.id);
    const missing = await resolve(bob, "00000000-0000-4000-8000-000000000000");

    assert.equal(await cellCount(), before, "a foreign field creates no cell");
    for (const attempt of [foreign, missing]) {
      assert.equal(attempt.response.status, 404);
      assert.equal(attempt.body.error.code, "FIELD_NOT_FOUND");
    }
    assert.equal(foreign.body.error.message, missing.body.error.message);
  });

  it("answers FIELD_NOT_FOUND once the field is soft-deleted", async () => {
    const field = await createField(alice, (await createFarm(alice)).id);
    const removed = await call(alice, "DELETE", `/v1/fields/${field.id}`);
    assert.equal(removed.response.status, 204);

    const { response, body } = await mintsNothing(() => resolve(alice, field.id));
    assert.equal(response.status, 404);
    assert.equal(body.error.code, "FIELD_NOT_FOUND");
  });
});

describe("resolve-cell — grid selection", () => {
  it("returns the resolver's own result, not a re-derived one", async () => {
    const field = await createField(alice, (await createFarm(alice)).id);
    const rows = await harness.owner.$queryRawUnsafe(
      `SELECT round(public.ST_Y(public.ST_Centroid(geom))::numeric, 6)::text AS lat,
              round(public.ST_X(public.ST_Centroid(geom))::numeric, 6)::text AS lon
         FROM app.fields WHERE id = $1::uuid`,
      field.id,
    );

    const { body } = await resolve(alice, field.id);
    const resolution = body.data.resolution;

    assert.deepEqual(resolution.requested, { lat: rows[0].lat, lon: rows[0].lon });
    assert.deepEqual(resolution.requested, { lat: "-6.150000", lon: "106.850000" });
    assert.deepEqual(resolution.anchor, { lat: "-7.00", lon: "106.00" });
    assert.notDeepEqual(resolution.anchor, resolution.requested);
    assert.equal(resolution.i, 3);
    assert.equal(resolution.j, 6);
    assert.equal(resolution.cellKey, "-7.00,106.00");
    assert.equal(resolution.provider, PROVIDER);
    assert.equal(resolution.model, MODEL);
    assert.equal(resolution.gridId, "test-sumatra-1deg");
    assert.equal(resolution.gridSpecHash, GRID.gridSpecHash);
    assert.equal(resolution.resolutionAlgorithmVersion, "grid-resolve/1");
    assert.equal(resolution.evidence, "synthetic");
    assert.equal(body.data.servedCoordinate, null);
    assert.equal("distanceKm" in body.data, false);
    assert.equal("extractionPolicy" in body.data, false);
  });

  it("answers GRID_NOT_FOUND for an unregistered pair, and mints nothing", async () => {
    const field = await createField(alice, (await createFarm(alice)).id);
    const before = await cellCount();
    for (const body of [
      { provider: PROVIDER, model: `${MODEL}_nope` },
      { provider: "open-meteo", model: MODEL },
      { provider: "synthetic", model: "synthetic_1deg_20x20" },
    ]) {
      const attempt = await resolve(alice, field.id, body);
      assert.equal(attempt.response.status, 404, JSON.stringify(attempt.body));
      assert.equal(attempt.body.error.code, "GRID_NOT_FOUND");
      // A 404 must not answer with the internal-error copy: the resource is
      // absent, the server is fine.
      assert.equal(attempt.body.error.message, "Sumber daya tidak ditemukan.");
    }
    assert.equal(await cellCount(), before, "an unknown pair mints nothing");
  });

  it("answers CELL_NOT_FOUND when the position is outside the grid", async () => {
    const field = await createField(alice, (await createFarm(alice, "Luar grid")).id, OUTSIDE);
    const { response, body } = await mintsNothing(() => resolve(alice, field.id));

    assert.equal(response.status, 404);
    assert.equal(body.error.code, "CELL_NOT_FOUND");
    assert.equal(body.error.message, "Sumber daya tidak ditemukan.");
    assert.equal(body.data, undefined);
  });
});

describe("resolve-cell — persistence", () => {
  it("returns the id of the row it wrote, and leaves the served columns NULL", async () => {
    const field = await createField(alice, (await createFarm(alice)).id);
    const { body } = await resolve(alice, field.id);

    const rows = await cellRows();
    assert.equal(rows.length, 1, "one identity row for this grid node");
    assert.equal(rows[0].id, body.data.cellId);
    assert.equal(rows[0].provider, PROVIDER);
    assert.equal(rows[0].model, MODEL);
    assert.equal(rows[0].cell_key, body.data.resolution.cellKey);
    assert.equal(rows[0].served_lat, null);
    assert.equal(rows[0].served_lon, null);
    assert.equal(rows[0].elevation_m, null);
    assert.equal(rows[0].spatial_resolution_km, null);
    assert.equal(rows[0].served_updated_at, null);
  });

  it("returns the same cellId on a repeat and keeps one row", async () => {
    const field = await createField(alice, (await createFarm(alice)).id);
    const first = await resolve(alice, field.id);
    const second = await resolve(alice, field.id);

    assert.equal(second.response.status, first.response.status);
    assert.equal(second.body.data.cellId, first.body.data.cellId);
    assert.deepEqual(second.body.data.resolution, first.body.data.resolution);
    assert.equal(await cellCount(), 1);
  });

  it("writes no field_outlook_cells row", async () => {
    const rows = await harness.owner.$queryRawUnsafe(
      "SELECT count(*)::int AS total FROM app.field_outlook_cells WHERE user_id = $1::uuid",
      alice.id,
    );
    assert.equal(rows[0].total, 0);
  });
});
