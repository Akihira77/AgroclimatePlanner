/**
 * The seed routine against a real database.
 *
 * `test/unit/catalog-seed-data.test.mjs` checks the shipped content's shape; nothing
 * there runs the routine. This file runs it — on a throwaway crop, inside a
 * transaction that is rolled back, so the database comes out exactly as it went in
 * whether or not the real catalogue was already seeded.
 *
 * A throwaway crop rather than the shipped four, because a database that has already
 * been seeded would report "already present" for every row, and a test that cannot
 * distinguish an insert from a skip proves nothing about the insert path — which is
 * the path that failed the first time this script was written.
 *
 * What it pins:
 *
 * - the draft → children → publish order survives the immutability triggers;
 * - a second run inserts nothing and says so, per crop;
 * - a cultivar that already publishes one rule version refuses a second;
 * - a published profile refuses an edit, which is what makes the second run safe.
 *
 * Requires a migrated database (`pnpm db:migrate`).
 * Run: pnpm --filter @agroclimate/database test:integration
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { Client } from "pg";

import { seedCatalogue } from "../../scripts/lib/catalog-seed.mjs";
import { roleConnectionString } from "../../scripts/lib/connections.mjs";

const owner = new Client({ connectionString: roleConnectionString("migration_owner") });

const SLUG = `seed-test-${Date.now()}`;
const RULE_VERSION = "seed-test.1";

/** Shaped like an entry of `CATALOGUE`; one of everything the routine writes. */
const THROWAWAY = [
  {
    crop: { slug: SLUG, nameId: "Uji", nameEn: "Test crop", category: "pangan" },
    cultivar: {
      name: "Uji-1",
      durationDaysMin: 90,
      durationDaysTypical: 95,
      durationDaysMax: 100,
      cycleStart: "sowing",
      nurseryDays: null,
      altitudeMinM: null,
      altitudeMaxM: null,
    },
    stages: [
      { name: "vegetatif", start: 0, end: 59, critical: false },
      { name: "generatif", start: 60, end: 94, critical: true },
    ],
    constraints: [
      {
        dimension: "water",
        comparator: "min",
        lower: 25,
        unit: "mm",
        stage: "generatif",
        grade: "A",
        severity: "hard",
      },
    ],
    sources: [
      {
        title: "Seed test source",
        authors: null,
        publicationYear: 2026,
        publisher: "Agroclimate test suite",
        url: "https://example.test/seed-test",
        grade: "A",
      },
    ],
  },
];

const seed = (options = {}) =>
  seedCatalogue(owner, { catalogue: THROWAWAY, ruleVersion: RULE_VERSION, ...options });

async function counts() {
  const { rows } = await owner.query(
    `select
       (select count(*) from app.crops where slug = $1) as crops,
       (select count(*) from app.cultivars c join app.crops p on p.id = c.crop_id
         where p.slug = $1) as cultivars,
       (select count(*) from app.crop_profile_versions v
          join app.cultivars c on c.id = v.cultivar_id
          join app.crops p on p.id = c.crop_id
         where p.slug = $1 and v.rule_version = $2 and v.status = 'published') as published,
       (select count(*) from app.growth_stages s
          join app.crop_profile_versions v on v.id = s.profile_version_id
          join app.cultivars c on c.id = v.cultivar_id
          join app.crops p on p.id = c.crop_id
         where p.slug = $1 and v.rule_version = $2) as stages,
       (select count(*) from app.constraints k
          join app.crop_profile_versions v on v.id = k.profile_version_id
          join app.cultivars c on c.id = v.cultivar_id
          join app.crops p on p.id = c.crop_id
         where p.slug = $1 and v.rule_version = $2) as constraints,
       (select count(*) from app.source_refs r
          join app.crop_profile_versions v on v.id = r.profile_version_id
          join app.cultivars c on c.id = v.cultivar_id
          join app.crops p on p.id = c.crop_id
         where p.slug = $1 and v.rule_version = $2) as sources`,
    [SLUG, RULE_VERSION],
  );
  return Object.fromEntries(Object.entries(rows[0]).map(([key, value]) => [key, Number(value)]));
}

let firstRun;

before(async () => {
  await owner.connect();
  await owner.query("begin");
  firstRun = await seed();
});

after(async () => {
  try {
    // Rolled back, not cleaned up: the routine's writes are the test's subject, and
    // the triggers refuse to delete a published profile anyway.
    await owner.query("rollback");
  } finally {
    await owner.end();
  }
});

describe("catalogue seed", () => {
  it("inserts, publishes, and reports what it inserted", async () => {
    assert.equal(firstRun.length, 1);
    assert.match(
      firstRun[0],
      new RegExp(`^${SLUG}: 2 stages, 1 constraints, 1 sources$`),
      `first run reported ${firstRun[0]}`,
    );
    assert.deepEqual(await counts(), {
      crops: 1,
      cultivars: 1,
      published: 1,
      stages: 2,
      constraints: 1,
      sources: 1,
    });
  });

  it("is idempotent: a second run inserts nothing and says so", async () => {
    const before = await counts();
    const secondRun = await seed();
    assert.deepEqual(await counts(), before);
    assert.deepEqual(secondRun, [
      `${SLUG}: profile ${RULE_VERSION} already present, children not touched`,
    ]);
  });

  it("refuses a second rule version while one is published", async () => {
    await owner.query("savepoint fs");
    await assert.rejects(
      () => seed({ ruleVersion: "seed-test.2" }),
      new RegExp(`already publishes ${RULE_VERSION}`),
    );
    await owner.query("rollback to savepoint fs");
    assert.equal((await counts()).published, 1);
  });

  it("leaves the published profile frozen, which is what the second run relies on", async () => {
    const { rows } = await owner.query(
      `select v.id from app.crop_profile_versions v
         join app.cultivars c on c.id = v.cultivar_id
         join app.crops p on p.id = c.crop_id
        where p.slug = $1 and v.rule_version = $2`,
      [SLUG, RULE_VERSION],
    );
    assert.equal(rows.length, 1);

    await owner.query("savepoint fs_immutable");
    await assert.rejects(
      () =>
        owner.query("update app.crop_profile_versions set rule_version = 'x' where id = $1", [
          rows[0].id,
        ]),
      /immutable/,
    );
    await owner.query("rollback to savepoint fs_immutable");
  });
});
