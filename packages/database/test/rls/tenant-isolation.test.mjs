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

/** @type {{ tenantA: string, tenantB: string, farmA: string, farmB: string, fieldA: string }} */
const fixtures = {};

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
     values ($1, $2, $3, public.ST_SetSRID(public.ST_MakePoint(106.7, -6.2), 4326))
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
});

after(async () => {
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

    const remove = await apiPg.query("delete from app.fields");
    assert.equal(remove.rowCount, 0, "DELETE without context must match no rows");
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
                 public.ST_SetSRID(public.ST_MakePoint(106.7, -6.2), 4326))`,
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
