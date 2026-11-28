/**
 * Plantings, harvests, and local field observations through the real HTTP
 * pipeline, over real PostgreSQL and `app_api` + RLS.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import {
  SQUARE_JSON,
  apiFor,
  cleanupUsers,
  headers,
  seedUser as seedFixture,
  startHarness,
  stopHarness,
} from "./support.mjs";

const EMAIL_PREFIX = "activity-api-";

let harness;
let call;
let base;
let alice;
let bob;
let cultivarId;
let cropId;
let ownCropCreated = false;

const seedUser = (label) => seedFixture(harness.owner, EMAIL_PREFIX, label);

before(async () => {
  harness = await startHarness();
  base = harness.base;
  call = apiFor(base).call;
  alice = await seedUser("alice");
  bob = await seedUser("bob");

  const cultivars = await harness.owner.$queryRawUnsafe(
    "SELECT id::text AS id FROM app.cultivars ORDER BY created_at ASC LIMIT 1",
  );
  if (cultivars.length > 0) {
    cultivarId = cultivars[0].id;
  } else {
    ownCropCreated = true;
    const cropRows = await harness.owner.$queryRawUnsafe(
      `INSERT INTO app.crops (slug, name_id, name_en, category)
       VALUES ($1, 'Padi API', 'API Rice', 'pangan')
       RETURNING id::text AS id`,
      [`api-rice-${Date.now()}`],
    );
    cropId = cropRows[0].id;
    const cultRows = await harness.owner.$queryRawUnsafe(
      `INSERT INTO app.cultivars (crop_id, name, duration_days_min, duration_days_typical, duration_days_max, cycle_start)
       VALUES ($1::uuid, 'Ciherang API', 110, 115, 120, 'transplant')
       RETURNING id::text AS id`,
      [cropId],
    );
    cultivarId = cultRows[0].id;
  }
});

after(async () => {
  if (harness !== undefined) {
    await cleanupUsers(harness.owner, EMAIL_PREFIX);
    if (ownCropCreated) {
      await harness.owner.$executeRawUnsafe(
        "DELETE FROM app.cultivars WHERE id = $1::uuid",
        cultivarId,
      );
      await harness.owner.$executeRawUnsafe("DELETE FROM app.crops WHERE id = $1::uuid", cropId);
    }
    await stopHarness(harness);
  }
});

describe("activity HTTP lifecycle", () => {
  it("supports plantings, harvests, observations, validation errors, CSRF, and tenant isolation", async () => {
    const farmRes = await call(alice, "POST", "/v1/farms", { body: { name: "Kebun Aktivitas" } });
    assert.equal(farmRes.response.status, 201);
    const farmId = farmRes.body.data.id;

    const fieldRes = await call(alice, "POST", "/v1/fields", {
      body: {
        farmId,
        name: "Petak Aktivitas",
        geometry: JSON.parse(SQUARE_JSON),
      },
    });
    assert.equal(fieldRes.response.status, 201);
    const fieldId = fieldRes.body.data.id;

    // CSRF protection on POST /v1/plantings
    const noCsrf = await fetch(`${base}/v1/plantings`, {
      method: "POST",
      headers: headers(alice, { csrf: false }),
      body: JSON.stringify({
        fieldId,
        cultivarId,
        plantedAt: "2026-11-28",
        cycleStartUsed: "transplant",
        areaPlantedHa: 1,
      }),
    });
    assert.equal(noCsrf.status, 403);

    // Create planting
    const createRes = await call(alice, "POST", "/v1/plantings", {
      body: {
        fieldId,
        cultivarId,
        plantedAt: "2026-11-28",
        cycleStartUsed: "transplant",
        areaPlantedHa: 1.25,
      },
    });
    assert.equal(createRes.response.status, 201);
    assert.equal(createRes.body.data.status, "active");
    assert.equal(createRes.body.data.totalYieldKg, 0);
    const plantingId = createRes.body.data.id;

    // Harvest before planting date -> 400
    const badHarvest = await call(alice, "POST", `/v1/plantings/${plantingId}/harvests`, {
      body: { harvestedAt: "2026-11-20", yieldKg: 50 },
    });
    assert.equal(badHarvest.response.status, 400);

    // Two valid harvests -> summed totalYieldKg
    const h1 = await call(alice, "POST", `/v1/plantings/${plantingId}/harvests`, {
      body: { harvestedAt: "2027-03-01", yieldKg: 120.5, notes: "panen pertama" },
    });
    const h2 = await call(alice, "POST", `/v1/plantings/${plantingId}/harvests`, {
      body: { harvestedAt: "2027-03-08", yieldKg: 80.25 },
    });
    assert.equal(h1.response.status, 201);
    assert.equal(h2.response.status, 201);

    const listHarvestsRes = await call(alice, "GET", `/v1/plantings/${plantingId}/harvests`);
    assert.equal(listHarvestsRes.response.status, 200);
    assert.equal(listHarvestsRes.body.data.length, 2);
    assert.equal(listHarvestsRes.body.meta.totalYieldKg, 200.75);

    // Status transition active -> harvested, then second transition -> 409 CONFLICT
    const patchOk = await call(alice, "PATCH", `/v1/plantings/${plantingId}`, {
      body: { status: "harvested" },
    });
    assert.equal(patchOk.response.status, 200);
    assert.equal(patchOk.body.data.status, "harvested");

    const patchConflict = await call(alice, "PATCH", `/v1/plantings/${plantingId}`, {
      body: { status: "failed" },
    });
    assert.equal(patchConflict.response.status, 409);

    // Observations: valid rainfall + note, future timestamp -> 400
    const obs1 = await call(alice, "POST", `/v1/fields/${fieldId}/observations`, {
      body: {
        kind: "rainfall",
        value: 22.4,
        unit: "mm",
        observedAt: "2026-11-28T04:00:00Z",
        method: "manual gauge",
      },
    });
    const obs2 = await call(alice, "POST", `/v1/fields/${fieldId}/observations`, {
      body: {
        kind: "note",
        observedAt: "2026-11-28T05:00:00Z",
        method: "tanah lembab",
      },
    });
    assert.equal(obs1.response.status, 201);
    assert.equal(obs2.response.status, 201);

    const obsList = await call(alice, "GET", `/v1/fields/${fieldId}/observations`);
    assert.equal(obsList.response.status, 200);
    assert.equal(obsList.body.data.length, 2);

    const farFuture = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const badObs = await call(alice, "POST", `/v1/fields/${fieldId}/observations`, {
      body: {
        kind: "rainfall",
        value: 10,
        unit: "mm",
        observedAt: farFuture,
      },
    });
    assert.equal(badObs.response.status, 400);

    // Cross-tenant isolation: Bob receives 404 on Alice's resources
    assert.equal((await call(bob, "GET", `/v1/plantings/${plantingId}`)).response.status, 404);
    assert.equal(
      (
        await call(bob, "PATCH", `/v1/plantings/${plantingId}`, {
          body: { status: "abandoned" },
        })
      ).response.status,
      404,
    );
    assert.equal(
      (
        await call(bob, "POST", `/v1/plantings/${plantingId}/harvests`, {
          body: { harvestedAt: "2027-03-01", yieldKg: 10 },
        })
      ).response.status,
      404,
    );
    assert.equal(
      (await call(bob, "GET", `/v1/plantings/${plantingId}/harvests`)).response.status,
      404,
    );
    assert.equal(
      (
        await call(bob, "POST", `/v1/fields/${fieldId}/observations`, {
          body: { kind: "note", observedAt: "2026-11-28T05:00:00Z" },
        })
      ).response.status,
      404,
    );
    assert.equal(
      (await call(bob, "GET", `/v1/fields/${fieldId}/observations`)).response.status,
      404,
    );
  });
});
