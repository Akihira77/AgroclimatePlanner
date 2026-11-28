/**
 * Tenant isolation, against the real roles and a real connection pool.
 *
 * Nothing here is mocked. Fixtures are created by `migration_owner` (the schema
 * owner, allowed for setup), and every assertion that matters runs as `app_api`
 * or `app_system`. A negative result is only accepted at a specific SQLSTATE, so
 * a missing table or a syntax error cannot pass as a working boundary.
 *
 * The Prisma client is configured with `poolMax: 1` for the lifecycle scenarios:
 * every transaction then runs on the same physical connection, which is the only
 * configuration in which a leaked `app.user_id` would actually cross tenants.
 *
 * Requires a migrated database and the roles from `pnpm db:bootstrap`.
 * Run: pnpm --filter @agroclimate/database test:rls
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { Client } from "pg";

import { createPrismaClient, createTenantScope } from "../../dist/index.js";
import { roleConnectionString } from "../../scripts/lib/connections.mjs";

const owner = new Client({ connectionString: roleConnectionString("migration_owner") });
const apiPg = new Client({ connectionString: roleConnectionString("app_api") });
const systemPg = new Client({ connectionString: roleConnectionString("app_system") });

const single = createPrismaClient({
  connectionString: roleConnectionString("app_api"),
  poolMax: 1,
});
const wide = createPrismaClient({ connectionString: roleConnectionString("app_api"), poolMax: 4 });
const singleScope = createTenantScope(single);
const wideScope = createTenantScope(wide);

/** @type {{ tenantA: string, tenantB: string, farmA: string, farmB: string, fieldA: string, fieldB: string }} */
const fixtures = {};

/** Reference catalogue rows every Phase 3 derived table needs. Created once, by migration_owner. */
const reference = {};

/** Tenant-B rows targeted by the negative assertions, keyed by table. Deleted by id in `after`. */
const derived = {};

/** Create a tenant with one farm and one field. Ids come from the database (uuidv7). */
async function createTenant(label) {
  const { rows: user } = await owner.query(
    "insert into app.users (email, password_hash) values ($1, 'x') returning id",
    [`rls-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.test`],
  );
  const userId = user[0].id;

  const { rows: farm } = await owner.query(
    "insert into app.farms (user_id, name) values ($1, $2) returning id",
    [userId, `farm ${label}`],
  );

  const { rows: field } = await owner.query(
    `insert into app.fields (user_id, farm_id, name, geom)
     values ($1, $2, $3, public.ST_SetSRID(public.ST_GeomFromText('POLYGON((106.7 -6.2, 106.8 -6.2, 106.8 -6.1, 106.7 -6.1, 106.7 -6.2))'), 4326))
     returning id`,
    [userId, farm[0].id, `field ${label}`],
  );

  return { userId, farmId: farm[0].id, fieldId: field[0].id };
}

/** Assert the operation fails with a specific SQLSTATE, and report what happened if not. */
async function rejected(client, label, sql, parameters, expected) {
  try {
    const result = await client.query(sql, parameters);
    assert.fail(
      `${label}: expected SQLSTATE ${expected}, query succeeded (${result.rowCount} rows)`,
    );
  } catch (error) {
    if (error.code === undefined) throw error;
    assert.equal(
      error.code,
      expected,
      `${label}: expected ${expected}, got ${error.code}: ${error.message}`,
    );
  }
}

before(async () => {
  await Promise.all([owner.connect(), apiPg.connect(), systemPg.connect()]);

  const a = await createTenant("a");
  const b = await createTenant("b");
  fixtures.tenantA = a.userId;
  fixtures.farmA = a.farmId;
  fixtures.fieldA = a.fieldId;
  fixtures.tenantB = b.userId;
  fixtures.farmB = b.farmId;
  fixtures.fieldB = b.fieldId;

  // Reference catalogue. Unique markers keep two runs against the same database
  // from colliding on crops_slug_key / outlook_cells_grid_key / the profile key.
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}`;

  const { rows: crop } = await owner.query(
    `insert into app.crops (slug, name_id, name_en, category)
     values ($1, 'Padi', 'Rice', 'cereal') returning id`,
    [`rls-crop-${suffix}`],
  );
  reference.crop = crop[0].id;

  const { rows: cultivar } = await owner.query(
    `insert into app.cultivars
       (crop_id, name, duration_days_min, duration_days_typical, duration_days_max, cycle_start)
     values ($1, $2, 90, 110, 130, 'sowing') returning id`,
    [reference.crop, `rls cultivar ${suffix}`],
  );
  reference.cultivar = cultivar[0].id;

  const { rows: profile } = await owner.query(
    `insert into app.crop_profile_versions (cultivar_id, rule_version)
     values ($1, $2) returning id`,
    [reference.cultivar, `rls-${suffix}`],
  );
  reference.profileVersion = profile[0].id;

  const { rows: cell } = await owner.query(
    `insert into app.outlook_cells (provider, model, cell_key)
     values ('bmkg', 'rls-model', $1) returning id`,
    [`rls-cell-${suffix}`],
  );
  reference.outlookCell = cell[0].id;

  // Tenant B's rows: the objects every "A must not touch B" assertion aims at.
  const { rows: fieldOutlookCell } = await owner.query(
    `insert into app.field_outlook_cells
       (user_id, field_id, outlook_cell_id, provider, model, extraction_policy, distance_km)
     values ($1, $2, $3, 'bmkg', 'rls-model', 'centroid', 1.5) returning id`,
    [fixtures.tenantB, fixtures.fieldB, reference.outlookCell],
  );
  derived.field_outlook_cells = fieldOutlookCell[0].id;

  const { rows: observation } = await owner.query(
    `insert into app.field_observations (user_id, field_id, kind, observed_at, entered_by)
     values ($1, $2, 'note', now(), $1) returning id`,
    [fixtures.tenantB, fixtures.fieldB],
  );
  derived.field_observations = observation[0].id;

  const { rows: planting } = await owner.query(
    `insert into app.plantings
       (user_id, field_id, cultivar_id, planted_at, cycle_start_used, area_planted_ha, status)
     values ($1, $2, $3, current_date, 'sowing', 1.0, 'active') returning id`,
    [fixtures.tenantB, fixtures.fieldB, reference.cultivar],
  );
  derived.plantings = planting[0].id;

  const { rows: harvest } = await owner.query(
    `insert into app.harvests (user_id, planting_id, harvested_at, yield_kg)
     values ($1, $2, current_date, 12.5) returning id`,
    [fixtures.tenantB, derived.plantings],
  );
  derived.harvests = harvest[0].id;

  const { rows: run } = await owner.query(
    `insert into app.suitability_runs
       (user_id, field_id, profile_version_id, engine_version, derivation_version,
        dimension_coverage, input_refs, field_snapshot, field_snapshot_hash, input_snapshot_hash)
     values ($1, $2, $3, 'rls-engine', 'rls-derivation',
             '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, repeat('a', 64), repeat('b', 64))
     returning id`,
    [fixtures.tenantB, fixtures.fieldB, reference.profileVersion],
  );
  derived.suitability_runs = run[0].id;

  const { rows: window } = await owner.query(
    `insert into app.planting_windows
       (user_id, suitability_run_id, field_id, crop_id, cultivar_id, profile_version_id,
        window_start, window_end, evaluation_basis, primary_basis, mixed_evidence,
        weakest_evidence_class, evidence_segments, missing_ranges, suitability,
        input_refs, field_snapshot_hash, input_snapshot_hash)
     values ($1, $2, $3, $4, $5, $6,
             current_date, current_date + 7, 'daily', 'daily', false,
             'weather_forecast', '[]'::jsonb, '[]'::jsonb, 'suitable',
             '[]'::jsonb, repeat('c', 64), repeat('d', 64))
     returning id`,
    [
      fixtures.tenantB,
      derived.suitability_runs,
      fixtures.fieldB,
      reference.crop,
      reference.cultivar,
      reference.profileVersion,
    ],
  );
  derived.planting_windows = window[0].id;

  const { rows: briefing } = await owner.query(
    `insert into app.ai_briefings
       (user_id, field_id, suitability_run_id, body, model_id, prompt_version,
        derivation_version, input_refs, field_snapshot_hash, source_artifact_hashes,
        input_snapshot_hash, unreproducible_reason)
     values ($1, $2, $3, '{}'::jsonb, 'rls-model', 'rls-prompt',
             'rls-derivation', '[]'::jsonb, repeat('e', 64), array[repeat('f', 64)],
             repeat('9', 64), 'model call is not replayable')
     returning id`,
    [fixtures.tenantB, fixtures.fieldB, derived.suitability_runs],
  );
  derived.ai_briefings = briefing[0].id;
});

after(async () => {
  // Reverse dependency order, keyed on ids this run generated. `before` may have
  // failed part-way, so only defined ids are filtered in; nothing is truncated.
  const ids = (list) => list.filter((id) => typeof id === "string");
  const remove = async (table, list) => {
    const present = ids(list);
    if (present.length === 0) return;
    await owner
      .query(`delete from app.${table} where id = any($1::uuid[])`, [present])
      .catch(() => {});
  };

  await remove("ai_briefings", [derived.ai_briefings]);
  await remove("planting_windows", [derived.planting_windows]);
  await remove("harvests", [derived.harvests]);
  await remove("suitability_runs", [derived.suitability_runs]);
  await remove("plantings", [derived.plantings]);
  await remove("field_observations", [derived.field_observations]);
  await remove("field_outlook_cells", [derived.field_outlook_cells]);
  await remove("crop_profile_versions", [reference.profileVersion]);
  await remove("cultivars", [reference.cultivar]);
  await remove("crops", [reference.crop]);
  await remove("outlook_cells", [reference.outlookCell]);

  await owner
    .query("delete from app.fields where user_id = any($1)", [[fixtures.tenantA, fixtures.tenantB]])
    .catch(() => {});
  await owner
    .query("delete from app.farms where user_id = any($1)", [[fixtures.tenantA, fixtures.tenantB]])
    .catch(() => {});
  await owner
    .query("delete from app.users where id = any($1)", [[fixtures.tenantA, fixtures.tenantB]])
    .catch(() => {});
  await Promise.all([
    owner.end().catch(() => {}),
    apiPg.end().catch(() => {}),
    systemPg.end().catch(() => {}),
    single.$disconnect().catch(() => {}),
    wide.$disconnect().catch(() => {}),
  ]);
});

describe("tenant scope", () => {
  test("scenario 1 — tenant A sees only its own rows", async () => {
    const farms = await singleScope.withTenant(fixtures.tenantA, (tx) => tx.farm.findMany());
    const fields = await singleScope.withTenant(fixtures.tenantA, (tx) => tx.field.findMany());

    assert.deepEqual(
      farms.map((farm) => farm.name),
      ["farm a"],
    );
    assert.equal(fields.length, 1);
    assert.equal(fields[0].userId, fixtures.tenantA);
  });

  test("scenario 2 — tenant B sees only its own rows", async () => {
    const farms = await singleScope.withTenant(fixtures.tenantB, (tx) => tx.farm.findMany());
    assert.deepEqual(
      farms.map((farm) => farm.name),
      ["farm b"],
    );
    assert.equal(farms[0].userId, fixtures.tenantB);
  });

  test("scenario 3 — no context: reads are empty, writes are refused", async () => {
    const { rows } = await apiPg.query("select count(*)::int as n from app.farms");
    assert.equal(rows[0].n, 0, "a pooled connection outside withTenant must see no tenant rows");

    // Not even a row that would belong to the tenant inserting it: without a
    // context the WITH CHECK clause has nothing to compare against.
    await rejected(
      apiPg,
      "insert without context",
      "insert into app.farms (user_id, name) values ($1, 'no context')",
      [fixtures.tenantA],
      "42501",
    );

    const update = await apiPg.query("update app.farms set name = 'hijacked'");
    assert.equal(update.rowCount, 0, "UPDATE without context must match no rows");

    // DELETE is refused before a policy is consulted: no runtime role holds the
    // privilege, so there is no row count to observe. 42501, not 0.
    await rejected(apiPg, "delete without context", "delete from app.fields", [], "42501");
  });

  test("scenario 4 — context does not survive the commit", async () => {
    await singleScope.withTenant(fixtures.tenantA, (tx) => tx.farm.findMany());

    // Same single pooled connection, no new transaction.
    const rows = await single.$queryRaw`select current_setting('app.user_id', true) as tenant`;
    assert.ok(
      rows[0].tenant === null || rows[0].tenant === "",
      `leaked context: ${rows[0].tenant}`,
    );

    const visible = await single.farm.findMany();
    assert.deepEqual(visible, [], "a reused connection must not retain the previous tenant");
  });

  test("scenario 5 — context and writes do not survive a rollback", async () => {
    const marker = `rolled back ${Date.now()}`;

    await assert.rejects(
      singleScope.withTenant(fixtures.tenantA, async (tx) => {
        await tx.farm.create({ data: { userId: fixtures.tenantA, name: marker } });
        throw new Error("intentional failure");
      }),
      /intentional failure/,
    );

    const { rows: written } = await owner.query(
      "select count(*)::int as n from app.farms where name = $1",
      [marker],
    );
    assert.equal(written[0].n, 0, "the write must be rolled back");

    const context = await single.$queryRaw`select current_setting('app.user_id', true) as tenant`;
    assert.ok(
      context[0].tenant === null || context[0].tenant === "",
      `leaked context: ${context[0].tenant}`,
    );

    const count = await single.$queryRaw`select count(*)::int as n from app.farms`;
    assert.equal(count[0].n, 0, "no tenant rows visible after rollback");
  });

  test("scenario 6 — concurrent tenants do not cross", async () => {
    const [a, b] = await Promise.all([
      wideScope.withTenant(fixtures.tenantA, async (tx) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return (await tx.farm.findMany()).map((farm) => farm.name);
      }),
      wideScope.withTenant(fixtures.tenantB, async (tx) =>
        (await tx.farm.findMany()).map((farm) => farm.name),
      ),
    ]);

    assert.deepEqual(a, ["farm a"]);
    assert.deepEqual(b, ["farm b"]);
  });

  test("scenario 7 — writing a row for another tenant is refused by the policy", async () => {
    // Through the transaction client too, so this is the path the application
    // would actually take.
    await assert.rejects(
      singleScope.withTenant(
        fixtures.tenantA,
        (tx) =>
          tx.$executeRaw`insert into app.farms (user_id, name) values (${fixtures.tenantB}::uuid, 'smuggled')`,
      ),
      (error) => /row-level security|violates/i.test(String(error)),
    );

    const { rows } = await owner.query(
      "select count(*)::int as n from app.farms where name = 'smuggled'",
    );
    assert.equal(rows[0].n, 0, "no row may be persisted");
  });

  test("scenario 8 — a field cannot reference another tenant's farm", async () => {
    await apiPg.query("begin");
    try {
      await apiPg.query("select set_config('app.user_id', $1, true)", [fixtures.tenantA]);

      // A's own user_id with B's farm: allowed by the policy's WITH CHECK, and
      // stopped by the composite foreign key instead. The distinction matters —
      // this is a referential-integrity denial (23503), not an RLS denial.
      await rejected(
        apiPg,
        "cross-tenant farm reference",
        `insert into app.fields (user_id, farm_id, name, geom)
         values ($1, $2, 'cross tenant',
                 public.ST_SetSRID(public.ST_GeomFromText('POLYGON((106.7 -6.2, 106.8 -6.2, 106.8 -6.1, 106.7 -6.1, 106.7 -6.2))'), 4326))`,
        [fixtures.tenantA, fixtures.farmB],
        "23503",
      );
    } finally {
      await apiPg.query("rollback");
    }

    const { rows } = await owner.query(
      "select count(*)::int as n from app.fields where name = 'cross tenant'",
    );
    assert.equal(rows[0].n, 0, "no cross-tenant relationship may be persisted");
  });

  test("app_system has no tenant-table privilege, with BYPASSRLS or without", async () => {
    for (const sql of [
      "select * from app.farms",
      "select * from app.fields",
      "insert into app.farms (user_id, name) values (gen_random_uuid(), 'system')",
      "update app.farms set name = 'system'",
      "delete from app.farms",
    ]) {
      await rejected(systemPg, `app_system: ${sql}`, sql, [], "42501");
    }
  });

  test("app_api cannot reach DDL or the migration ledger", async () => {
    await rejected(apiPg, "create table", "create table app.api_made (id int)", [], "42501");
    await rejected(
      apiPg,
      "alter tenant table",
      "alter table app.farms add column x int",
      [],
      "42501",
    );
    await rejected(apiPg, "drop tenant table", "drop table app.fields", [], "42501");
    await rejected(apiPg, "write ledger", "delete from app._prisma_migrations", [], "42501");
  });
});

/**
 * SQLSTATEs a Prisma raw-query error might carry, outermost first. The driver
 * adapter wraps the original `pg` error; the code is read from whichever layer
 * kept it, never from the message text.
 */
function sqlStates(error) {
  return [
    // Prisma 7's driver adapter reports the original PostgreSQL code here.
    error?.meta?.driverAdapterError?.cause?.originalCode,
    error?.meta?.code,
    error?.cause?.code,
    error?.meta?.cause?.code,
    error?.code,
  ].filter((value) => typeof value === "string");
}

function assertSqlState(label, error, expected) {
  const seen = sqlStates(error);
  assert.ok(
    seen.includes(expected),
    `${label}: expected SQLSTATE ${expected}, saw ${JSON.stringify({ code: error?.code, meta: error?.meta })}`,
  );
}

/** Resolve a `withTenant` mutation to an outcome instead of throwing, so the code can be inspected. */
async function attempt(scope, tenantId, sql, parameters = []) {
  return scope
    .withTenant(tenantId, (tx) => tx.$executeRawUnsafe(sql, ...parameters))
    .then(
      (rows) => ({ ok: true, rows }),
      (error) => ({ ok: false, error }),
    );
}

const phaseThreeTables = [
  {
    table: "field_outlook_cells",
    rowId: () => derived.field_outlook_cells,
    crossInsert: () => ({
      sql: `insert into app.field_outlook_cells
              (user_id, field_id, outlook_cell_id, provider, model, extraction_policy, distance_km)
            values ($1::uuid, $2::uuid, $3::uuid, 'ecmwf', 'cross-model', 'centroid', 1.0)`,
      parameters: [fixtures.tenantA, fixtures.fieldB, reference.outlookCell],
    }),
  },
  {
    table: "field_observations",
    rowId: () => derived.field_observations,
    crossInsert: () => ({
      sql: `insert into app.field_observations (user_id, field_id, kind, observed_at, entered_by)
            values ($1::uuid, $2::uuid, 'note', now(), $1::uuid)`,
      parameters: [fixtures.tenantA, fixtures.fieldB],
    }),
  },
  {
    table: "plantings",
    rowId: () => derived.plantings,
    crossInsert: () => ({
      sql: `insert into app.plantings
              (user_id, field_id, cultivar_id, planted_at, cycle_start_used, area_planted_ha, status)
            values ($1::uuid, $2::uuid, $3::uuid, current_date, 'sowing', 1.0, 'active')`,
      parameters: [fixtures.tenantA, fixtures.fieldB, reference.cultivar],
    }),
  },
  {
    table: "harvests",
    rowId: () => derived.harvests,
    crossInsert: () => ({
      sql: `insert into app.harvests (user_id, planting_id, harvested_at, yield_kg)
            values ($1::uuid, $2::uuid, current_date, 1.0)`,
      parameters: [fixtures.tenantA, derived.plantings],
    }),
  },
  {
    table: "suitability_runs",
    rowId: () => derived.suitability_runs,
    crossInsert: () => ({
      sql: `insert into app.suitability_runs
              (user_id, field_id, profile_version_id, engine_version, derivation_version,
               dimension_coverage, input_refs, field_snapshot, field_snapshot_hash,
               input_snapshot_hash, status)
            values ($1::uuid, $2::uuid, $3::uuid, 'cross-engine', 'cross-derivation',
                    '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, repeat('1', 64),
                    repeat('2', 64), 'failed')`,
      parameters: [fixtures.tenantA, fixtures.fieldB, reference.profileVersion],
    }),
  },
  {
    table: "planting_windows",
    rowId: () => derived.planting_windows,
    crossInsert: () => ({
      sql: `insert into app.planting_windows
              (user_id, suitability_run_id, field_id, crop_id, cultivar_id, profile_version_id,
               window_start, window_end, evaluation_basis, primary_basis, mixed_evidence,
               weakest_evidence_class, evidence_segments, missing_ranges, suitability,
               input_refs, field_snapshot_hash, input_snapshot_hash)
            values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
                    current_date, current_date + 7, 'daily', 'daily', false,
                    'weather_forecast', '[]'::jsonb, '[]'::jsonb, 'suitable',
                    '[]'::jsonb, repeat('3', 64), repeat('4', 64))`,
      parameters: [
        fixtures.tenantA,
        derived.suitability_runs,
        fixtures.fieldA,
        reference.crop,
        reference.cultivar,
        reference.profileVersion,
      ],
    }),
  },
  {
    table: "ai_briefings",
    rowId: () => derived.ai_briefings,
    crossInsert: () => ({
      sql: `insert into app.ai_briefings
              (user_id, field_id, suitability_run_id, body, model_id, prompt_version,
               derivation_version, input_refs, field_snapshot_hash, source_artifact_hashes,
               input_snapshot_hash, unreproducible_reason)
            values ($1::uuid, $2::uuid, $3::uuid, '{}'::jsonb, 'cross-model', 'cross-prompt',
                    'cross-derivation', '[]'::jsonb, repeat('5', 64), array[repeat('6', 64)],
                    repeat('7', 64), 'model call is not replayable')`,
      parameters: [fixtures.tenantA, fixtures.fieldA, derived.suitability_runs],
    }),
  },
];

describe("phase 3 tenant-owned tables", () => {
  before(async () => {
    // A negative assertion against a row that does not exist proves nothing.
    for (const spec of phaseThreeTables) {
      const { rows } = await owner.query(`select user_id from app.${spec.table} where id = $1`, [
        spec.rowId(),
      ]);
      assert.equal(rows.length, 1, `${spec.table}: tenant B fixture is missing`);
      assert.equal(rows[0].user_id, fixtures.tenantB, `${spec.table}: fixture is not tenant B's`);
    }
  });

  for (const spec of phaseThreeTables) {
    test(`${spec.table} — tenant A cannot SELECT tenant B's row`, async () => {
      const rows = await singleScope.withTenant(fixtures.tenantA, (tx) =>
        tx.$queryRawUnsafe(`select id from app.${spec.table} where id = $1::uuid`, spec.rowId()),
      );
      assert.equal(rows.length, 0, `${spec.table}: tenant B's row was visible to tenant A`);
    });

    test(`${spec.table} — tenant A cannot UPDATE tenant B's row`, async () => {
      const affected = await singleScope.withTenant(fixtures.tenantA, (tx) =>
        tx.$executeRawUnsafe(
          `update app.${spec.table} set user_id = user_id where id = $1::uuid`,
          spec.rowId(),
        ),
      );
      assert.equal(affected, 0, `${spec.table}: tenant A updated a tenant B row`);
    });

    test(`${spec.table} — no tenant can DELETE, the privilege is absent`, async () => {
      // Stronger than "tenant A cannot reach tenant B's row": the runtime role
      // holds no DELETE at all, so the refusal arrives before any policy runs.
      const outcome = await attempt(
        singleScope,
        fixtures.tenantA,
        `delete from app.${spec.table} where id = $1::uuid`,
        [spec.rowId()],
      );

      assert.equal(outcome.ok, false, `${spec.table}: DELETE was accepted`);
      assertSqlState(spec.table, outcome.error, "42501");
    });

    test(`${spec.table} — tenant A cannot INSERT under tenant B's parent`, async () => {
      const { sql, parameters } = spec.crossInsert();
      const outcome = await attempt(singleScope, fixtures.tenantA, sql, parameters);

      assert.equal(
        outcome.ok,
        false,
        `${spec.table}: the cross-tenant insert succeeded (${outcome.rows} rows)`,
      );
      // 23503, not 42501: the policy accepts user_id = A, and the composite
      // ownership FK is the boundary that refuses the foreign parent.
      assertSqlState(spec.table, outcome.error, "23503");
    });
  }

  test("no tenant context — every phase 3 table returns zero rows", async () => {
    for (const spec of phaseThreeTables) {
      const { rows } = await apiPg.query(
        `select count(*)::int as n from app.${spec.table} where id = $1`,
        [spec.rowId()],
      );
      assert.equal(rows[0].n, 0, `${spec.table}: a row is visible with no tenant context`);
    }
  });
});
