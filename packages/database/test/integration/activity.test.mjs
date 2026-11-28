/**
 * Plantings, harvests, field observations, and OPEN-09 / OPEN-21 DB constraints
 * against real PostgreSQL and `app_api` + RLS.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { Client } from "pg";

import {
  createFarm,
  createField,
  createFieldObservation,
  createHarvest,
  createPlanting,
  createPrismaClient,
  createTenantScope,
  findPlanting,
  HarvestDateError,
  InvalidPlantingTransitionError,
  listFieldObservations,
  listHarvests,
  listPlantings,
  ObservationFutureDateError,
  PlantingReferenceError,
  updatePlantingStatus,
} from "../../dist/index.js";
import { roleConnectionString } from "../../scripts/lib/connections.mjs";

const owner = new Client({ connectionString: roleConnectionString("migration_owner") });
const api = createPrismaClient({
  connectionString: roleConnectionString("app_api"),
  poolMax: 1,
});
const scope = createTenantScope(api);

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

const cleanup = { users: [], farms: [], fields: [], plantings: [], harvests: [], observations: [] };
let cultivarId;
let cropId;
let ownCropCreated = false;

async function createUser(label) {
  const { rows } = await owner.query(
    "INSERT INTO app.users (email, password_hash) VALUES ($1, 'x') RETURNING id::text AS id",
    [`activity-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.test`],
  );
  cleanup.users.push(rows[0].id);
  return rows[0].id;
}

before(async () => {
  await owner.connect();
  const { rows } = await owner.query(
    "SELECT id::text AS id FROM app.cultivars ORDER BY created_at ASC LIMIT 1",
  );
  if (rows.length > 0) {
    cultivarId = rows[0].id;
  } else {
    ownCropCreated = true;
    const cropRes = await owner.query(
      `INSERT INTO app.crops (slug, name_id, name_en, category)
       VALUES ($1, 'Padi Uji', 'Test Rice', 'pangan')
       RETURNING id::text AS id`,
      [`test-rice-${Date.now()}`],
    );
    cropId = cropRes.rows[0].id;
    const cultRes = await owner.query(
      `INSERT INTO app.cultivars (crop_id, name, duration_days_min, duration_days_typical, duration_days_max, cycle_start)
       VALUES ($1::uuid, 'Ciherang Uji', 110, 115, 120, 'transplant')
       RETURNING id::text AS id`,
      [cropId],
    );
    cultivarId = cultRes.rows[0].id;
  }
});

after(async () => {
  try {
    if (cleanup.observations.length > 0) {
      await owner.query("DELETE FROM app.field_observations WHERE id = ANY($1::uuid[])", [
        cleanup.observations,
      ]);
    }
    if (cleanup.harvests.length > 0) {
      await owner.query("DELETE FROM app.harvests WHERE id = ANY($1::uuid[])", [cleanup.harvests]);
    }
    if (cleanup.plantings.length > 0) {
      await owner.query("DELETE FROM app.plantings WHERE id = ANY($1::uuid[])", [
        cleanup.plantings,
      ]);
    }
    if (cleanup.fields.length > 0) {
      await owner.query("DELETE FROM app.fields WHERE id = ANY($1::uuid[])", [cleanup.fields]);
    }
    if (cleanup.farms.length > 0) {
      await owner.query("DELETE FROM app.farms WHERE id = ANY($1::uuid[])", [cleanup.farms]);
    }
    if (cleanup.users.length > 0) {
      await owner.query("DELETE FROM app.users WHERE id = ANY($1::uuid[])", [cleanup.users]);
    }
    if (ownCropCreated) {
      await owner.query("DELETE FROM app.cultivars WHERE id = $1::uuid", [cultivarId]);
      await owner.query("DELETE FROM app.crops WHERE id = $1::uuid", [cropId]);
    }
  } finally {
    await api.$disconnect();
    await owner.end();
  }
});

describe("plantings, harvests, and observations integration", () => {
  it("runs full planting/harvest/observation lifecycle and enforces tenant isolation", async () => {
    const alice = await createUser("alice");
    const bob = await createUser("bob");

    const farm = await scope.withTenant(alice, (tx) => createFarm(tx, { name: "Kebun A" }));
    cleanup.farms.push(farm.id);

    const field = await scope.withTenant(alice, (tx) =>
      createField(tx, farm.id, { name: "Petak 1", geometry: SQUARE }),
    );
    assert.notEqual(field, null);
    cleanup.fields.push(field.id);

    // Bob cannot create a planting on Alice's field
    await assert.rejects(
      () =>
        scope.withTenant(bob, (tx) =>
          createPlanting(tx, {
            fieldId: field.id,
            cultivarId,
            plantedAt: "2026-11-28",
            cycleStartUsed: "transplant",
            areaPlantedHa: 1.0,
          }),
        ),
      (err) => err instanceof PlantingReferenceError && err.code === "field_not_found",
    );

    const planting = await scope.withTenant(alice, (tx) =>
      createPlanting(tx, {
        fieldId: field.id,
        cultivarId,
        plantedAt: "2026-11-28",
        cycleStartUsed: "transplant",
        areaPlantedHa: 1.5,
      }),
    );
    cleanup.plantings.push(planting.id);
    assert.equal(planting.status, "active");
    assert.equal(planting.totalYieldKg, 0);
    assert.ok(planting.expectedHarvestTypical > planting.plantedAt);

    // Harvest before plantedAt is refused
    await assert.rejects(
      () =>
        scope.withTenant(alice, (tx) =>
          createHarvest(tx, planting.id, {
            harvestedAt: "2026-11-20",
            yieldKg: 100,
          }),
        ),
      (err) => err instanceof HarvestDateError,
    );

    // Zero-yield failed picking and positive picking both succeed and sum cleanly
    const h1 = await scope.withTenant(alice, (tx) =>
      createHarvest(tx, planting.id, {
        harvestedAt: "2027-03-01",
        yieldKg: 0,
        notes: "panen gagal sebagian",
      }),
    );
    const h2 = await scope.withTenant(alice, (tx) =>
      createHarvest(tx, planting.id, {
        harvestedAt: "2027-03-10",
        yieldKg: 425.5,
      }),
    );
    assert.notEqual(h1, null);
    assert.notEqual(h2, null);
    cleanup.harvests.push(h1.id, h2.id);

    const listedHarvests = await scope.withTenant(alice, (tx) => listHarvests(tx, planting.id));
    assert.notEqual(listedHarvests, null);
    assert.equal(listedHarvests.items.length, 2);
    assert.equal(listedHarvests.totalYieldKg, 425.5);

    const updated = await scope.withTenant(alice, (tx) =>
      updatePlantingStatus(tx, planting.id, "harvested"),
    );
    assert.equal(updated?.status, "harvested");
    assert.equal(updated?.totalYieldKg, 425.5);

    // Terminal state transition is refused
    await assert.rejects(
      () => scope.withTenant(alice, (tx) => updatePlantingStatus(tx, planting.id, "failed")),
      (err) => err instanceof InvalidPlantingTransitionError,
    );

    // Bob sees nothing across plantings and harvests
    assert.equal(await scope.withTenant(bob, (tx) => findPlanting(tx, planting.id)), null);
    assert.deepEqual(await scope.withTenant(bob, (tx) => listPlantings(tx)), []);
    assert.equal(await scope.withTenant(bob, (tx) => listHarvests(tx, planting.id)), null);

    // Field observations: measurement + note + future check + cross-tenant isolation
    const obsRain = await scope.withTenant(alice, (tx) =>
      createFieldObservation(tx, field.id, {
        kind: "rainfall",
        value: 18.2,
        unit: "mm",
        observedAt: "2026-11-28T05:00:00Z",
        method: "ombrometer",
      }),
    );
    const obsNote = await scope.withTenant(alice, (tx) =>
      createFieldObservation(tx, field.id, {
        kind: "note",
        observedAt: "2026-11-28T06:00:00Z",
        method: "air irigasi lancar",
      }),
    );
    assert.notEqual(obsRain, null);
    assert.notEqual(obsNote, null);
    cleanup.observations.push(obsRain.id, obsNote.id);

    const aliceObs = await scope.withTenant(alice, (tx) => listFieldObservations(tx, field.id));
    assert.equal(aliceObs?.length, 2);
    assert.equal(await scope.withTenant(bob, (tx) => listFieldObservations(tx, field.id)), null);

    const farFuture = new Date(Date.now() + 7 * 86_400_000).toISOString();
    await assert.rejects(
      () =>
        scope.withTenant(alice, (tx) =>
          createFieldObservation(tx, field.id, {
            kind: "rainfall",
            value: 5,
            unit: "mm",
            observedAt: farFuture,
          }),
        ),
      (err) => err instanceof ObservationFutureDateError,
    );
  });

  it("enforces fields_irrigation_availability_check (OPEN-21)", async () => {
    const alice = await createUser("open21");
    const farm = await scope.withTenant(alice, (tx) => createFarm(tx, { name: "Kebun OPEN-21" }));
    cleanup.farms.push(farm.id);
    const field = await scope.withTenant(alice, (tx) =>
      createField(tx, farm.id, { name: "Petak OPEN-21", geometry: SQUARE }),
    );
    cleanup.fields.push(field.id);

    for (const val of ["irrigated", "partial_irrigation", "rainfed", "unknown", null]) {
      await owner.query("UPDATE app.fields SET irrigation_availability = $1 WHERE id = $2::uuid", [
        val,
        field.id,
      ]);
    }

    await assert.rejects(
      () =>
        owner.query(
          "UPDATE app.fields SET irrigation_availability = 'invalid_mode' WHERE id = $1::uuid",
          [field.id],
        ),
      (err) => err.code === "23514",
    );
  });
});
