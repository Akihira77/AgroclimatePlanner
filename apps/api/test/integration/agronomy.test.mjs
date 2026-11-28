/**
 * Phase 6 agronomic suitability evaluation and planting-window persistence
 * through the real HTTP pipeline, over real PostgreSQL and `app_api` + RLS.
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

const EMAIL_PREFIX = "agronomy-api-";

let harness;
let call;
let base;
let alice;
let bob;
let profileVersionId;
let constraintId;
let cropId;
let cultivarId;
let ownCatalog = false;

const seedUser = (label) => seedFixture(harness.owner, EMAIL_PREFIX, label);

before(async () => {
  harness = await startHarness();
  base = harness.base;
  call = apiFor(base).call;
  alice = await seedUser("alice");
  bob = await seedUser("bob");

  const rows = await harness.owner.$queryRawUnsafe(
    `SELECT cpv.id::text AS profile_version_id,
            c.id::text AS cultivar_id,
            c.crop_id::text AS crop_id,
            con.id::text AS constraint_id
       FROM app.crop_profile_versions cpv
       JOIN app.cultivars c ON c.id = cpv.cultivar_id
       JOIN app.constraints con ON con.profile_version_id = cpv.id
      WHERE cpv.status = 'published'
        AND con.severity = 'hard'
      ORDER BY cpv.created_at ASC
      LIMIT 1`,
  );

  if (rows.length > 0) {
    profileVersionId = rows[0].profile_version_id;
    cultivarId = rows[0].cultivar_id;
    cropId = rows[0].crop_id;
    constraintId = rows[0].constraint_id;
  } else {
    ownCatalog = true;
    const cropRows = await harness.owner.$queryRawUnsafe(
      `INSERT INTO app.crops (slug, name_id, name_en, category)
       VALUES ($1, 'Padi Agro API', 'Agro API Rice', 'pangan')
       RETURNING id::text AS id`,
      [`agro-api-rice-${Date.now()}`],
    );
    cropId = cropRows[0].id;
    const cultRows = await harness.owner.$queryRawUnsafe(
      `INSERT INTO app.cultivars (crop_id, name, duration_days_min, duration_days_typical, duration_days_max, cycle_start)
       VALUES ($1::uuid, 'Ciherang Agro', 110, 115, 120, 'transplant')
       RETURNING id::text AS id`,
      [cropId],
    );
    cultivarId = cultRows[0].id;
    const profRows = await harness.owner.$queryRawUnsafe(
      `INSERT INTO app.crop_profile_versions (cultivar_id, rule_version, status)
       VALUES ($1::uuid, 'agro-api-v1', 'draft')
       RETURNING id::text AS id`,
      [cultivarId],
    );
    profileVersionId = profRows[0].id;
    await harness.owner.$executeRawUnsafe(
      `INSERT INTO app.growth_stages (profile_version_id, name, start_day_offset, end_day_offset, is_critical)
       VALUES ($1::uuid, 'reproduktif', 50, 84, true)`,
      profileVersionId,
    );
    const conRows = await harness.owner.$queryRawUnsafe(
      `INSERT INTO app.constraints (profile_version_id, dimension, comparator, threshold_lower, threshold_upper, unit, grade, severity)
       VALUES ($1::uuid, 'water', 'range', 5, 10, 'cm', 'A', 'hard')
       RETURNING id::text AS id`,
      profileVersionId,
    );
    constraintId = conRows[0].id;
    await harness.owner.$executeRawUnsafe(
      `UPDATE app.crop_profile_versions SET status = 'published', published_at = now() WHERE id = $1::uuid`,
      profileVersionId,
    );
  }
});

after(async () => {
  if (harness !== undefined) {
    await cleanupUsers(harness.owner, EMAIL_PREFIX);
    if (ownCatalog) {
      await harness.owner.$executeRawUnsafe(
        "DELETE FROM app.constraints WHERE profile_version_id = $1::uuid",
        profileVersionId,
      );
      await harness.owner.$executeRawUnsafe(
        "DELETE FROM app.growth_stages WHERE profile_version_id = $1::uuid",
        profileVersionId,
      );
      await harness.owner.$executeRawUnsafe(
        "DELETE FROM app.crop_profile_versions WHERE id = $1::uuid",
        profileVersionId,
      );
      await harness.owner.$executeRawUnsafe(
        "DELETE FROM app.cultivars WHERE id = $1::uuid",
        cultivarId,
      );
      await harness.owner.$executeRawUnsafe("DELETE FROM app.crops WHERE id = $1::uuid", cropId);
    }
    await stopHarness(harness);
  }
});

const inputRefs = [
  {
    kind: "forecast",
    role: "seasonal",
    purpose: "input",
    forecastRunIds: ["0192f0aa-0000-7000-8000-000000000001"],
    ingestionRunIds: ["0192f0aa-0000-7000-8000-000000000002"],
    recordSetHash: "a".repeat(64),
  },
];

function segment(startDate, endDate) {
  return {
    startDate,
    endDate,
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
}

describe("agronomy evaluation & planting-window HTTP lifecycle", () => {
  it("evaluates, persists, supersedes, rejects invalid partitions without losing prior run, and isolates tenants", async () => {
    const farmRes = await call(alice, "POST", "/v1/farms", { body: { name: "Kebun Evaluasi" } });
    assert.equal(farmRes.response.status, 201);

    const fieldRes = await call(alice, "POST", "/v1/fields", {
      body: {
        farmId: farmRes.body.data.id,
        name: "Petak Evaluasi",
        geometry: JSON.parse(SQUARE_JSON),
      },
    });
    assert.equal(fieldRes.response.status, 201);
    const fieldId = fieldRes.body.data.id;

    // CSRF required on POST /v1/fields/:fieldId/evaluate
    const noCsrf = await fetch(`${base}/v1/fields/${fieldId}/evaluate`, {
      method: "POST",
      headers: headers(alice, { csrf: false }),
      body: JSON.stringify({
        profileVersionId,
        inputRefs,
        candidates: [
          {
            startDate: "2026-12-01",
            observations: { [constraintId]: 7 },
            primaryBasis: "monthly",
            evidenceSegments: [segment("2026-12-01", "2027-03-25")],
            missingRanges: [],
          },
        ],
      }),
    });
    assert.equal(noCsrf.status, 403);

    // Evaluate 1st time
    const eval1 = await call(alice, "POST", `/v1/fields/${fieldId}/evaluate`, {
      body: {
        profileVersionId,
        irrigationAvailability: "partial_irrigation",
        inputRefs,
        candidates: [
          {
            startDate: "2026-12-01",
            observations: { [constraintId]: 7 },
            primaryBasis: "monthly",
            evidenceSegments: [segment("2026-12-01", "2027-03-25")],
            missingRanges: [],
          },
        ],
      },
    });
    assert.equal(eval1.response.status, 201);
    assert.equal(eval1.body.data.fieldSnapshot.irrigationAvailability, "partial_irrigation");
    assert.equal(eval1.body.data.plantingWindows.length, 1);

    // Invalid EvidenceSegment partition (OPEN-26) -> 400 and leaves run1 active!
    const badPartition = await call(alice, "POST", `/v1/fields/${fieldId}/evaluate`, {
      body: {
        profileVersionId,
        inputRefs,
        candidates: [
          {
            startDate: "2026-12-10",
            observations: { [constraintId]: 7 },
            primaryBasis: "monthly",
            // Ends short: gap/span violation
            evidenceSegments: [segment("2026-12-10", "2027-03-01")],
            missingRanges: [],
          },
        ],
      },
    });
    assert.equal(badPartition.response.status, 400);

    const latestAfterBad = await call(alice, "GET", `/v1/fields/${fieldId}/suitability`);
    assert.equal(latestAfterBad.response.status, 200);
    assert.equal(latestAfterBad.body.data.id, eval1.body.data.id);

    // Re-evaluate -> supersedes run1
    const eval2 = await call(alice, "POST", `/v1/fields/${fieldId}/evaluate`, {
      body: {
        profileVersionId,
        irrigationAvailability: "irrigated",
        inputRefs,
        candidates: [
          {
            startDate: "2026-12-15",
            observations: { [constraintId]: 7 },
            primaryBasis: "monthly",
            evidenceSegments: [segment("2026-12-15", "2027-04-08")],
            missingRanges: [],
          },
        ],
      },
    });
    assert.equal(eval2.response.status, 201);
    assert.equal(eval2.body.data.supersedesId, eval1.body.data.id);

    const windowsList = await call(
      alice,
      "GET",
      `/v1/planting-windows?fieldId=${fieldId}&cropId=${cropId}`,
    );
    assert.equal(windowsList.response.status, 200);
    assert.equal(windowsList.body.data.length, 1);
    assert.equal(windowsList.body.data[0].windowStart, "2026-12-15");

    // Cross-tenant isolation: Bob sees 404 on evaluate/suitability and empty list on planting-windows
    assert.equal(
      (
        await call(bob, "POST", `/v1/fields/${fieldId}/evaluate`, {
          body: {
            profileVersionId,
            inputRefs,
            candidates: [
              {
                startDate: "2026-12-01",
                observations: { [constraintId]: 7 },
                primaryBasis: "monthly",
                evidenceSegments: [segment("2026-12-01", "2027-03-25")],
                missingRanges: [],
              },
            ],
          },
        })
      ).response.status,
      404,
    );
    assert.equal(
      (await call(bob, "GET", `/v1/fields/${fieldId}/suitability`)).response.status,
      404,
    );
    const bobWindows = await call(bob, "GET", `/v1/planting-windows?fieldId=${fieldId}`);
    assert.equal(bobWindows.response.status, 200);
    assert.deepEqual(bobWindows.body.data, []);
  });
});
