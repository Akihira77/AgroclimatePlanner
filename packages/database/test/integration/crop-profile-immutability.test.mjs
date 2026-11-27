/**
 * `crop_profile_versions` and its children are frozen at publication.
 *
 * The grants already stop `app_api` from writing the catalog at all, so this file
 * exercises `migration_owner` — the only role that can. The trigger is the second
 * half of the guarantee: a seed script correcting a threshold in place would
 * change what an already-stored planting window was evaluated against while the
 * window still names this version id.
 *
 * Requires a migrated database (`pnpm db:migrate`).
 * Run: pnpm --filter @agroclimate/database test:integration
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { Client } from "pg";

import { roleConnectionString } from "../../scripts/lib/connections.mjs";

const owner = new Client({ connectionString: roleConnectionString("migration_owner") });

const CROP_SLUG = `immutability-test-${Date.now()}`;

let cropId;
let cultivarId;
let profileId;
let stageId;

const expectRefused = async (sql, params, pattern) => {
  await assert.rejects(
    () => owner.query(sql, params),
    (error) => {
      assert.match(error.message, pattern);
      return true;
    },
  );
};

before(async () => {
  await owner.connect();

  const crop = await owner.query(
    "INSERT INTO app.crops (slug, name_id, name_en, category) VALUES ($1, 'Uji', 'Test', 'test') RETURNING id",
    [CROP_SLUG],
  );
  cropId = crop.rows[0].id;

  const cultivar = await owner.query(
    `INSERT INTO app.cultivars
       (crop_id, name, duration_days_min, duration_days_typical, duration_days_max, cycle_start)
     VALUES ($1, 'Test', 90, 100, 110, 'sowing')
     RETURNING id`,
    [cropId],
  );
  cultivarId = cultivar.rows[0].id;

  const profile = await owner.query(
    "INSERT INTO app.crop_profile_versions (cultivar_id, rule_version) VALUES ($1, 'test.1') RETURNING id",
    [cultivarId],
  );
  profileId = profile.rows[0].id;

  const stage = await owner.query(
    `INSERT INTO app.growth_stages
       (profile_version_id, name, start_day_offset, end_day_offset, is_critical)
     VALUES ($1, 'vegetative', 0, 30, true)
     RETURNING id`,
    [profileId],
  );
  stageId = stage.rows[0].id;

  await owner.query(
    `INSERT INTO app.constraints
       (profile_version_id, growth_stage_id, dimension, comparator, threshold_lower, unit, grade, severity)
     VALUES ($1, $2, 'water', 'min', 25, 'mm', 'A', 'hard')`,
    [profileId, stageId],
  );

  await owner.query(
    `INSERT INTO app.source_refs
       (profile_version_id, title, publication_year, publisher, url, accessed_at, grade)
     VALUES ($1, 'Test source', 2026, 'Test', 'https://example.test', '2026-11-27', 'A')`,
    [profileId],
  );
});

after(async () => {
  // Deleting the crop cascades nothing: the children go first while the profile is
  // still a draft is impossible now, so the trigger is dropped for cleanup only.
  await owner.query(
    "ALTER TABLE app.crop_profile_versions DISABLE TRIGGER crop_profile_versions_immutable",
  );
  for (const table of ["growth_stages", "constraints", "source_refs"]) {
    await owner.query(`ALTER TABLE app.${table} DISABLE TRIGGER ${table}_immutable`);
  }
  // `retired` is still frozen, so cleanup rewinds the row to draft first.
  await owner.query(
    "UPDATE app.crop_profile_versions SET status = 'draft', published_at = NULL WHERE id = $1",
    [profileId],
  );
  await owner.query("DELETE FROM app.source_refs WHERE profile_version_id = $1", [profileId]);
  await owner.query("DELETE FROM app.constraints WHERE profile_version_id = $1", [profileId]);
  await owner.query("DELETE FROM app.growth_stages WHERE profile_version_id = $1", [profileId]);
  await owner.query("DELETE FROM app.crop_profile_versions WHERE id = $1", [profileId]);
  await owner.query("DELETE FROM app.cultivars WHERE id = $1", [cultivarId]);
  await owner.query("DELETE FROM app.crops WHERE id = $1", [cropId]);
  for (const table of ["growth_stages", "constraints", "source_refs"]) {
    await owner.query(`ALTER TABLE app.${table} ENABLE TRIGGER ${table}_immutable`);
  }
  await owner.query(
    "ALTER TABLE app.crop_profile_versions ENABLE TRIGGER crop_profile_versions_immutable",
  );
  await owner.end();
});

describe("crop profile immutability", () => {
  it("allows edits while the version is a draft", async () => {
    await owner.query(
      "UPDATE app.crop_profile_versions SET rule_version = 'test.1-draft' WHERE id = $1",
      [profileId],
    );
    await owner.query("UPDATE app.growth_stages SET name = 'vegetative-draft' WHERE id = $1", [
      stageId,
    ]);
  });

  it("freezes content once published", async () => {
    await owner.query(
      "UPDATE app.crop_profile_versions SET status = 'published', published_at = now() WHERE id = $1",
      [profileId],
    );

    await expectRefused(
      "UPDATE app.crop_profile_versions SET rule_version = 'test.2' WHERE id = $1",
      [profileId],
      /immutable after publication/,
    );
    await expectRefused(
      "UPDATE app.crop_profile_versions SET published_at = now() WHERE id = $1",
      [profileId],
      /immutable after publication/,
    );
    await expectRefused(
      "UPDATE app.crop_profile_versions SET status = 'draft', published_at = NULL WHERE id = $1",
      [profileId],
      /only published -> retired/,
    );
  });

  it("freezes the rulebook's own rows, including inserts", async () => {
    await expectRefused(
      "UPDATE app.growth_stages SET end_day_offset = 40 WHERE id = $1",
      [stageId],
      /rows of published profile .* are immutable/,
    );
    await expectRefused(
      `INSERT INTO app.growth_stages
         (profile_version_id, name, start_day_offset, end_day_offset, is_critical)
       VALUES ($1, 'late', 31, 60, false)`,
      [profileId],
      /are immutable/,
    );
    await expectRefused(
      "DELETE FROM app.constraints WHERE profile_version_id = $1",
      [profileId],
      /are immutable/,
    );
    await expectRefused(
      "DELETE FROM app.source_refs WHERE profile_version_id = $1",
      [profileId],
      /are immutable/,
    );
  });

  it("allows retirement and keeps the row frozen", async () => {
    await owner.query("UPDATE app.crop_profile_versions SET status = 'retired' WHERE id = $1", [
      profileId,
    ]);
    await expectRefused(
      "UPDATE app.crop_profile_versions SET status = 'published' WHERE id = $1",
      [profileId],
      /only published -> retired/,
    );
  });
});
