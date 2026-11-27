/**
 * The seeding routine, separate from the CLI that calls it so a test can run it
 * against a real database without spawning a process.
 *
 * One transaction: a half-seeded catalogue is not a state anyone should see.
 */

import { ACCESSED_AT, CATALOGUE, RULE_VERSION } from "./catalog-seed-data.mjs";

/** A row that neither inserted nor existed is a bug, not a condition to guess past. */
function requireId(row, what) {
  const id = row.rows[0]?.id;
  if (id === undefined) throw new Error(`${what} was neither inserted nor found`);
  return id;
}

/**
 * The catalogue and its rule version are parameters because a test seeds a throwaway
 * crop: the shipped rows may already exist in the database under test, and a test
 * that cannot tell "inserted" from "already there" proves nothing about insertion.
 */
export async function seedCatalogue(
  client,
  { catalogue = CATALOGUE, ruleVersion = RULE_VERSION } = {},
) {
  const report = [];
  for (const entry of catalogue) {
    try {
      report.push(...(await seedEntry(client, entry, ruleVersion)));
    } catch (error) {
      // A CHECK violation names a constraint, not which of four crops produced it.
      error.message = `seeding ${entry.crop.slug}: ${error.message}`;
      throw error;
    }
  }
  return report;
}

/** One crop, its cultivar, its rulebook. Returns the one report line for it. */
async function seedEntry(client, entry, ruleVersion) {
  const { crop, cultivar } = entry;
  const cropRow = await client.query(
    `insert into app.crops (slug, name_id, name_en, category)
     values ($1, $2, $3, $4)
     on conflict (slug) do nothing
     returning id`,
    [crop.slug, crop.nameId, crop.nameEn, crop.category],
  );
  const cropId =
    cropRow.rows[0]?.id ??
    requireId(
      await client.query("select id from app.crops where slug = $1", [crop.slug]),
      `crop ${crop.slug}`,
    );

  const cultivarRow = await client.query(
    `insert into app.cultivars
       (crop_id, name, duration_days_min, duration_days_typical, duration_days_max,
        cycle_start, nursery_days, altitude_min_m, altitude_max_m)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (crop_id, name) do nothing
     returning id`,
    [
      cropId,
      cultivar.name,
      cultivar.durationDaysMin,
      cultivar.durationDaysTypical,
      cultivar.durationDaysMax,
      cultivar.cycleStart,
      cultivar.nurseryDays,
      cultivar.altitudeMinM,
      cultivar.altitudeMaxM,
    ],
  );
  const cultivarId =
    cultivarRow.rows[0]?.id ??
    requireId(
      await client.query("select id from app.cultivars where crop_id = $1 and name = $2", [
        cropId,
        cultivar.name,
      ]),
      `cultivar ${crop.slug}/${cultivar.name}`,
    );

  // A second published rulebook for the same cultivar violates
  // `crop_profile_versions_one_published_key`, and the raw unique violation names an
  // index rather than the situation. Say what happened instead: a rule version is a
  // new profile, and the old one is retired, never replaced in place.
  const competing = await client.query(
    `select rule_version from app.crop_profile_versions
      where cultivar_id = $1 and status = 'published' and rule_version <> $2`,
    [cultivarId, ruleVersion],
  );
  if (competing.rows.length > 0) {
    throw new Error(
      `cultivar ${crop.slug}/${cultivar.name} already publishes ${competing.rows[0].rule_version}; retire it before publishing ${ruleVersion}`,
    );
  }

  // Draft first, publish last. The immutability trigger refuses to let anything
  // be appended to a profile that already has `published_at` set — which is the
  // point of it, and the reason a seed cannot insert children after publishing.
  const profileRow = await client.query(
    `insert into app.crop_profile_versions (cultivar_id, rule_version, status)
     values ($1, $2, 'draft')
     on conflict (cultivar_id, rule_version) do nothing
     returning id`,
    [cultivarId, ruleVersion],
  );

  // A committed profile necessarily committed with its children: this routine is one
  // transaction, so a half-written profile cannot survive a crash. The trust is stated
  // rather than re-checked, because re-checking would only guard a row some other
  // writer produced — and `D13` says there is no other writer.
  if (profileRow.rows[0] === undefined) {
    return [`${crop.slug}: profile ${ruleVersion} already present, children not touched`];
  }
  const profileId = profileRow.rows[0].id;

  const stageIds = new Map();
  for (const stage of entry.stages) {
    const row = await client.query(
      `insert into app.growth_stages
         (profile_version_id, name, start_day_offset, end_day_offset, is_critical)
       values ($1, $2, $3, $4, $5)
       returning id`,
      [profileId, stage.name, stage.start, stage.end, stage.critical],
    );
    stageIds.set(stage.name, row.rows[0].id);
  }

  for (const rule of entry.constraints) {
    await client.query(
      `insert into app.constraints
         (profile_version_id, dimension, comparator, threshold_lower, threshold_upper,
          threshold_count, unit, growth_stage_id, grade, severity)
       values ($1, $2, $3, $4, $5, null, $6, $7, $8, $9)`,
      [
        profileId,
        rule.dimension,
        rule.comparator,
        rule.lower ?? null,
        rule.upper ?? null,
        rule.unit ?? null,
        rule.stage === null ? null : stageIds.get(rule.stage),
        rule.grade,
        rule.severity,
      ],
    );
  }

  for (const source of entry.sources) {
    await client.query(
      `insert into app.source_refs
         (profile_version_id, title, authors, publication_year, publisher, url, accessed_at, grade)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        profileId,
        source.title,
        source.authors,
        source.publicationYear,
        source.publisher,
        source.url,
        ACCESSED_AT,
        source.grade,
      ],
    );
  }

  await client.query(
    `update app.crop_profile_versions
        set status = 'published', published_at = now(), updated_at = now()
      where id = $1`,
    [profileId],
  );

  return [
    `${crop.slug}: ${entry.stages.length} stages, ${entry.constraints.length} constraints, ${entry.sources.length} sources`,
  ];
}
