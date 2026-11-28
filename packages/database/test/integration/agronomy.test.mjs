/**
 * Phase 6 suitability_runs and planting_windows persistence, atomic
 * supersession, and RLS cross-tenant isolation against real PostgreSQL.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { hashDerivationDescriptor, hashFieldSnapshot } from "@agroclimate/contracts";
import { Client } from "pg";

import {
  createFarm,
  createField,
  createPrismaClient,
  createTenantScope,
  findLatestSuitabilityRun,
  listActivePlantingWindows,
  loadFieldSnapshotSource,
  persistSuitabilityRunWithWindows,
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

const cleanup = { users: [], farms: [], fields: [] };
let cropId;
let cultivarId;
let profileVersionId;
let ownCatalog = false;

async function createUser(label) {
  const { rows } = await owner.query(
    "INSERT INTO app.users (email, password_hash) VALUES ($1, 'x') RETURNING id::text AS id",
    [`agronomy-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.test`],
  );
  cleanup.users.push(rows[0].id);
  return rows[0].id;
}

before(async () => {
  await owner.connect();
  const { rows } = await owner.query(
    `SELECT cpv.id::text AS profile_version_id, c.id::text AS cultivar_id, c.crop_id::text AS crop_id
       FROM app.crop_profile_versions cpv
       JOIN app.cultivars c ON c.id = cpv.cultivar_id
      WHERE cpv.status = 'published'
      ORDER BY cpv.created_at ASC
      LIMIT 1`,
  );
  if (rows.length > 0) {
    profileVersionId = rows[0].profile_version_id;
    cultivarId = rows[0].cultivar_id;
    cropId = rows[0].crop_id;
  } else {
    ownCatalog = true;
    const cropRes = await owner.query(
      `INSERT INTO app.crops (slug, name_id, name_en, category)
       VALUES ($1, 'Padi Test', 'Test Rice', 'pangan')
       RETURNING id::text AS id`,
      [`agro-rice-${Date.now()}`],
    );
    cropId = cropRes.rows[0].id;
    const cultRes = await owner.query(
      `INSERT INTO app.cultivars (crop_id, name, duration_days_min, duration_days_typical, duration_days_max, cycle_start)
       VALUES ($1::uuid, 'Ciherang Test', 110, 115, 120, 'transplant')
       RETURNING id::text AS id`,
      [cropId],
    );
    cultivarId = cultRes.rows[0].id;
    const profRes = await owner.query(
      `INSERT INTO app.crop_profile_versions (cultivar_id, rule_version, status, published_at)
       VALUES ($1::uuid, 'test-v1', 'published', now())
       RETURNING id::text AS id`,
      [cultivarId],
    );
    profileVersionId = profRes.rows[0].id;
  }
});

after(async () => {
  try {
    if (cleanup.users.length > 0) {
      await owner.query("DELETE FROM app.planting_windows WHERE user_id = ANY($1::uuid[])", [
        cleanup.users,
      ]);
      await owner.query("DELETE FROM app.suitability_runs WHERE user_id = ANY($1::uuid[])", [
        cleanup.users,
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
    if (ownCatalog) {
      await owner.query("DELETE FROM app.crop_profile_versions WHERE id = $1::uuid", [
        profileVersionId,
      ]);
      await owner.query("DELETE FROM app.cultivars WHERE id = $1::uuid", [cultivarId]);
      await owner.query("DELETE FROM app.crops WHERE id = $1::uuid", [cropId]);
    }
  } finally {
    await api.$disconnect();
    await owner.end();
  }
});

describe("agronomy persistence and supersession", () => {
  it("persists suitability run + windows, supersedes atomically on re-run, and isolates tenants", async () => {
    const alice = await createUser("alice");
    const bob = await createUser("bob");

    const farm = await scope.withTenant(alice, (tx) => createFarm(tx, { name: "Kebun Agro" }));
    cleanup.farms.push(farm.id);
    const field = await scope.withTenant(alice, (tx) =>
      createField(tx, farm.id, { name: "Petak Agro", geometry: SQUARE }),
    );
    cleanup.fields.push(field.id);

    const source = await scope.withTenant(alice, (tx) => loadFieldSnapshotSource(tx, field.id));
    assert.notEqual(source, null);
    assert.equal(await scope.withTenant(bob, (tx) => loadFieldSnapshotSource(tx, field.id)), null);

    const snapshotPayload = {
      fieldId: source.fieldId,
      geometryHash: source.geometryHash,
      areaHa: source.areaHa,
      elevationM: source.elevationM,
      soilType: source.soilType,
      soilPh: source.soilPh,
      drainageClass: source.drainageClass,
      irrigationAvailability: "partial_irrigation",
      irrigationSource: source.irrigationSource,
      extractionPolicy: "centroid",
      resolvedCells: source.resolvedCells,
      observationsUsed: source.observationsUsed,
    };
    const fieldSnapshotHash = hashFieldSnapshot(snapshotPayload);
    const fieldSnapshot = { ...snapshotPayload, fieldSnapshotHash };

    const inputRefs = [
      {
        kind: "baseline",
        role: "climatology",
        purpose: "input",
        baselineVersion: "ERA5:1991-2020:v1",
        baselineHash: "b".repeat(64),
        cellKeys: ["cell-1"],
      },
    ];
    const runHash1 = hashDerivationDescriptor({
      artifact: "suitability_run",
      inputRefs,
      fieldSnapshotHash,
      profileVersionId,
      engineVersion: "0.1.0",
      derivationVersion: "1",
    });
    const winHash1 = hashDerivationDescriptor({
      artifact: "planting_window",
      inputRefs,
      fieldSnapshotHash,
      profileVersionId,
      engineVersion: "0.1.0",
      derivationVersion: "1",
    });

    const seg = {
      startDate: "2026-12-01",
      endDate: "2027-03-25",
      evaluationBasis: "monthly",
      evidenceClass: "seasonal_forecast",
      coveragePercent: 100,
      provenance: {
        kind: "forecast",
        forecastRunIds: ["0192f0aa-0000-7000-8000-000000000001"],
        ingestionRunIds: ["0192f0aa-0000-7000-8000-000000000002"],
        initializedAt: "2026-11-28T00:00:00Z",
      },
    };

    const run1 = await scope.withTenant(alice, (tx) =>
      persistSuitabilityRunWithWindows(tx, {
        fieldId: field.id,
        profileVersionId,
        engineVersion: "0.1.0",
        derivationVersion: "1",
        dimensionCoverage: [{ dimension: "water", state: "known" }],
        maxAchievableLevel: "A",
        inputRefs,
        fieldSnapshot,
        fieldSnapshotHash,
        inputSnapshotHash: runHash1,
        reproducible: false,
        unreproducibleReason: "raw_payload_not_retained",
        windows: [
          {
            cropId,
            cultivarId,
            profileVersionId,
            windowStart: "2026-12-01",
            windowEnd: "2027-03-25",
            evaluationBasis: "monthly",
            primaryBasis: "monthly",
            mixedEvidence: false,
            weakestEvidenceClass: "seasonal_forecast",
            evidenceSegments: [seg],
            missingRanges: [],
            suitability: "suitable",
            score: null,
            risks: [],
            explanations: [],
            constraintsEvaluated: [],
            missingInputs: [],
            inputRefs,
            fieldSnapshotHash,
            inputSnapshotHash: winHash1,
            reproducible: false,
            unreproducibleReason: "raw_payload_not_retained",
          },
        ],
      }),
    );

    assert.equal(run1.status, "active");
    assert.equal(run1.plantingWindows.length, 1);

    // Second run supersedes the first cleanly
    const run2 = await scope.withTenant(alice, (tx) =>
      persistSuitabilityRunWithWindows(tx, {
        fieldId: field.id,
        profileVersionId,
        engineVersion: "0.1.0",
        derivationVersion: "1",
        dimensionCoverage: [{ dimension: "water", state: "known" }],
        maxAchievableLevel: "A",
        inputRefs,
        fieldSnapshot,
        fieldSnapshotHash,
        inputSnapshotHash: runHash1,
        reproducible: false,
        unreproducibleReason: "raw_payload_not_retained",
        windows: [
          {
            cropId,
            cultivarId,
            profileVersionId,
            windowStart: "2026-12-15",
            windowEnd: "2027-04-08",
            evaluationBasis: "monthly",
            primaryBasis: "monthly",
            mixedEvidence: false,
            weakestEvidenceClass: "seasonal_forecast",
            evidenceSegments: [{ ...seg, startDate: "2026-12-15", endDate: "2027-04-08" }],
            missingRanges: [],
            suitability: "conditional",
            score: null,
            risks: [],
            explanations: [],
            constraintsEvaluated: [],
            missingInputs: [],
            inputRefs,
            fieldSnapshotHash,
            inputSnapshotHash: winHash1,
            reproducible: false,
            unreproducibleReason: "raw_payload_not_retained",
          },
        ],
      }),
    );

    assert.equal(run2.supersedesId, run1.id);
    assert.equal(run2.plantingWindows[0]?.windowStart, "2026-12-15");

    const { rows: oldRunRows } = await owner.query(
      "SELECT status, superseded_by_id::text AS superseded_by_id FROM app.suitability_runs WHERE id = $1::uuid",
      [run1.id],
    );
    assert.equal(oldRunRows[0].status, "superseded");
    assert.equal(oldRunRows[0].superseded_by_id, run2.id);

    const activeWindows = await scope.withTenant(alice, (tx) =>
      listActivePlantingWindows(tx, { fieldId: field.id }),
    );
    assert.equal(activeWindows.length, 1);
    assert.equal(activeWindows[0]?.id, run2.plantingWindows[0]?.id);

    // Bob cannot see Alice's run or windows
    assert.equal(await scope.withTenant(bob, (tx) => findLatestSuitabilityRun(tx, field.id)), null);
    assert.deepEqual(
      await scope.withTenant(bob, (tx) => listActivePlantingWindows(tx, { fieldId: field.id })),
      [],
    );
  });
});
