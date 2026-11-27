/**
 * `GET /v1/crops`, `GET /v1/crops/:slug`, `GET /v1/crop-profiles/:id` through the
 * real HTTP pipeline, over real PostgreSQL.
 *
 * The catalog is global reference data: one row set, no tenant dimension. The
 * suite therefore seeds as `migration_owner` and asserts that two different
 * sessions read the same bytes — and that the runtime role cannot write, which is
 * proved by the absence of a route rather than by a refused request.
 *
 * Published profiles are frozen by trigger, so cleanup rewinds the parent to
 * `draft` after disabling the triggers. Nothing here asserts a threshold is
 * agronomically correct: it asserts the API transports the stored rulebook
 * without reshaping it.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import {
  apiFor,
  cleanupUsers,
  seedUser as seedFixture,
  startHarness,
  stopHarness,
} from "./support.mjs";

const EMAIL_PREFIX = "crop-catalog-";
const SLUG = `test-crop-${Date.now()}`;

let harness;
let call;
let alice;
let bob;

const seedUser = (label) => seedFixture(harness.owner, EMAIL_PREFIX, label);

async function seedCatalog() {
  const crop = await harness.owner.$queryRawUnsafe(
    `INSERT INTO app.crops (slug, name_id, name_en, category)
     VALUES ($1, 'Padi Uji', 'Test Rice', 'cereal')
     RETURNING id::text AS id`,
    SLUG,
  );
  const cropId = crop[0].id;

  const cultivar = await harness.owner.$queryRawUnsafe(
    `INSERT INTO app.cultivars
       (crop_id, name, duration_days_min, duration_days_typical, duration_days_max,
        cycle_start, nursery_days, altitude_min_m, altitude_max_m)
     VALUES ($1::uuid, 'Uji-1', 100, 110, 120, 'transplant', 21, 0, 1200)
     RETURNING id::text AS id`,
    cropId,
  );
  const cultivarId = cultivar[0].id;

  // Draft first: the rulebook's own rows can only be written before publication.
  const published = await harness.owner.$queryRawUnsafe(
    `INSERT INTO app.crop_profile_versions (cultivar_id, rule_version)
     VALUES ($1::uuid, 'test.2')
     RETURNING id::text AS id`,
    cultivarId,
  );
  const publishedId = published[0].id;

  const older = await harness.owner.$queryRawUnsafe(
    `INSERT INTO app.crop_profile_versions (cultivar_id, rule_version, supersedes_id)
     VALUES ($1::uuid, 'test.1', $2::uuid)
     RETURNING id::text AS id`,
    cultivarId,
    publishedId,
  );
  const olderId = older[0].id;

  await harness.owner.$queryRawUnsafe(
    `INSERT INTO app.growth_stages
       (profile_version_id, name, start_day_offset, end_day_offset, is_critical, requirement_profile)
     VALUES ($1::uuid, 'vegetative', 0, 30, true, 'test-profile')`,
    publishedId,
  );
  const stage = await harness.owner.$queryRawUnsafe(
    `SELECT id::text AS id FROM app.growth_stages WHERE profile_version_id = $1::uuid`,
    publishedId,
  );

  await harness.owner.$queryRawUnsafe(
    `INSERT INTO app.constraints
       (profile_version_id, growth_stage_id, dimension, comparator, threshold_lower,
        unit, grade, severity)
     VALUES ($1::uuid, $2::uuid, 'water', 'min', 25, 'mm', 'A', 'hard')`,
    publishedId,
    stage[0].id,
  );
  await harness.owner.$queryRawUnsafe(
    `INSERT INTO app.constraints
       (profile_version_id, dimension, comparator, threshold_count, grade, severity)
     VALUES ($1::uuid, 'timing', 'count', 3, 'B', 'soft')`,
    publishedId,
  );
  await harness.owner.$queryRawUnsafe(
    `INSERT INTO app.source_refs
       (profile_version_id, title, authors, publication_year, publisher, url, accessed_at, grade)
     VALUES ($1::uuid, 'Test source', 'Test Author', 2026, 'Test Press',
             'https://example.test/source', '2026-11-27', 'A')`,
    publishedId,
  );

  await harness.owner.$queryRawUnsafe(
    "UPDATE app.crop_profile_versions SET status = 'published', published_at = now() WHERE id = $1::uuid",
    publishedId,
  );

  return { cropId, cultivarId, publishedId, olderId };
}

async function deleteCatalog() {
  const profiles = `SELECT id FROM app.crop_profile_versions
                     WHERE cultivar_id IN (SELECT id FROM app.cultivars
                                            WHERE crop_id IN (SELECT id FROM app.crops WHERE slug = $1))`;
  await harness.owner.$executeRawUnsafe(
    "ALTER TABLE app.crop_profile_versions DISABLE TRIGGER crop_profile_versions_immutable",
  );
  for (const table of ["growth_stages", "constraints", "source_refs"]) {
    await harness.owner.$executeRawUnsafe(
      `ALTER TABLE app.${table} DISABLE TRIGGER ${table}_immutable`,
    );
  }
  await harness.owner.$executeRawUnsafe(
    `UPDATE app.crop_profile_versions SET status = 'draft', published_at = NULL
      WHERE id IN (${profiles})`,
    SLUG,
  );
  for (const table of ["source_refs", "constraints", "growth_stages"]) {
    await harness.owner.$executeRawUnsafe(
      `DELETE FROM app.${table} WHERE profile_version_id IN (${profiles})`,
      SLUG,
    );
  }
  await harness.owner.$executeRawUnsafe(
    `DELETE FROM app.crop_profile_versions
      WHERE cultivar_id IN (SELECT id FROM app.cultivars
                             WHERE crop_id IN (SELECT id FROM app.crops WHERE slug = $1))`,
    SLUG,
  );
  await harness.owner.$executeRawUnsafe(
    `DELETE FROM app.cultivars
      WHERE crop_id IN (SELECT id FROM app.crops WHERE slug = $1)`,
    SLUG,
  );
  await harness.owner.$executeRawUnsafe("DELETE FROM app.crops WHERE slug = $1", SLUG);
  for (const table of ["growth_stages", "constraints", "source_refs"]) {
    await harness.owner.$executeRawUnsafe(
      `ALTER TABLE app.${table} ENABLE TRIGGER ${table}_immutable`,
    );
  }
  await harness.owner.$executeRawUnsafe(
    "ALTER TABLE app.crop_profile_versions ENABLE TRIGGER crop_profile_versions_immutable",
  );
}

before(async () => {
  harness = await startHarness();
  call = apiFor(harness.base).call;
  await cleanupUsers(harness.owner, EMAIL_PREFIX);
  await deleteCatalog();
  alice = await seedUser("alice");
  bob = await seedUser("bob");
  await seedCatalog();
});

after(async () => {
  await cleanupUsers(harness.owner, EMAIL_PREFIX);
  await deleteCatalog();
  await stopHarness(harness);
});

describe("crop catalog", () => {
  it("requires a session", async () => {
    const { response, body } = await call(alice, "GET", "/v1/crops", { anonymous: true });
    assert.equal(response.status, 401);
    assert.equal(body.error.code, "UNAUTHENTICATED");
  });

  it("lists crops for any authenticated tenant, identically", async () => {
    const first = await call(alice, "GET", "/v1/crops");
    const second = await call(bob, "GET", "/v1/crops");

    assert.equal(first.response.status, 200, JSON.stringify(first.body));
    assert.deepEqual(second.body, first.body);

    const crop = first.body.data.crops.find((entry) => entry.slug === SLUG);
    assert.ok(crop, "seeded crop is listed");
    assert.deepEqual(Object.keys(crop).sort(), ["category", "id", "nameEn", "nameId", "slug"]);
  });

  it("returns cultivars with their versions, newest first", async () => {
    const { response, body } = await call(alice, "GET", `/v1/crops/${SLUG}`);
    assert.equal(response.status, 200, JSON.stringify(body));

    const [cultivar] = body.data.cultivars;
    assert.equal(cultivar.name, "Uji-1");
    assert.equal(cultivar.cycleStart, "transplant");
    assert.equal(cultivar.nurseryDays, 21);
    // Newest first by creation instant, which is why the draft correction leads.
    assert.deepEqual(
      cultivar.profileVersions.map((version) => version.ruleVersion),
      ["test.1", "test.2"],
    );
    const [draft, published] = cultivar.profileVersions;
    assert.equal(draft.status, "draft");
    assert.equal(draft.publishedAt, null);
    assert.equal(draft.supersedesId, published.id);
    assert.equal(published.status, "published");
    assert.match(published.publishedAt, /Z$/);
  });

  it("serves one version's stages, thresholds and citations", async () => {
    const detail = await call(alice, "GET", `/v1/crops/${SLUG}`);
    const version = detail.body.data.cultivars[0].profileVersions.find(
      (entry) => entry.status === "published",
    );

    const { response, body } = await call(alice, "GET", `/v1/crop-profiles/${version.id}`);
    assert.equal(response.status, 200, JSON.stringify(body));

    const profile = body.data;
    assert.equal(profile.id, version.id);
    assert.equal(profile.growthStages.length, 1);
    assert.deepEqual(profile.growthStages[0], {
      id: profile.growthStages[0].id,
      name: "vegetative",
      startDayOffset: 0,
      endDayOffset: 30,
      isCritical: true,
      requirementProfile: "test-profile",
    });

    assert.equal(profile.constraints.length, 2);
    const water = profile.constraints.find((constraint) => constraint.dimension === "water");
    assert.equal(water.comparator, "min");
    assert.equal(water.thresholdLower, 25);
    assert.equal(water.thresholdUpper, null);
    assert.equal(water.thresholdCount, null);
    assert.equal(water.growthStageId, profile.growthStages[0].id);
    assert.equal(water.grade, "A");
    assert.equal(water.severity, "hard");

    const timing = profile.constraints.find((constraint) => constraint.dimension === "timing");
    assert.equal(timing.comparator, "count");
    assert.equal(timing.thresholdCount, 3);
    assert.equal(timing.unit, null);

    assert.equal(profile.sourceRefs.length, 1);
    assert.equal(profile.sourceRefs[0].publicationYear, 2026);
    assert.equal(profile.sourceRefs[0].accessedAt, "2026-11-27");
  });

  it("answers not-found without disclosing whether the row exists", async () => {
    const missingCrop = await call(alice, "GET", "/v1/crops/no-such-crop");
    assert.equal(missingCrop.response.status, 404);
    assert.equal(missingCrop.body.error.code, "CROP_NOT_FOUND");

    const missingProfile = await call(
      alice,
      "GET",
      "/v1/crop-profiles/00000000-0000-4000-8000-000000000000",
    );
    assert.equal(missingProfile.response.status, 404);
    assert.equal(missingProfile.body.error.code, "PROFILE_NOT_FOUND");
  });

  it("refuses a malformed slug and version id before touching the database", async () => {
    for (const path of ["/v1/crops/Not_A_Slug", "/v1/crop-profiles/not-a-uuid"]) {
      const { response, body } = await call(alice, "GET", path);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(body.error.code, "VALIDATION_FAILED");
    }
  });

  it("has no write surface", async () => {
    // The catalog has no mutating route because `app_api` holds `SELECT` only and
    // a published profile refuses UPDATE at the trigger. A POST is a 404, not a
    // 405: no handler is registered for it.
    const { response } = await call(alice, "POST", `/v1/crops/${SLUG}`, { body: {} });
    assert.equal(response.status, 404);
  });
});
