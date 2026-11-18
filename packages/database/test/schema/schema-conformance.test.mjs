/**
 * Schema conformance: does the applied database actually match the specification?
 *
 * Read-only catalogue inspection as `migration_owner`. Every assertion is
 * answered from `pg_catalog` / `information_schema`, never by re-reading the
 * migration that was supposed to create the objects; a migration file can claim
 * anything, the catalogue is what the query planner uses.
 *
 * Requires a migrated database. Run: pnpm --filter @agroclimate/database test:schema
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { Client } from "pg";

import { roleConnectionString } from "../../scripts/lib/connections.mjs";

const owner = new Client({ connectionString: roleConnectionString("migration_owner") });

/** The 22 domain tables, `docs/data-model/ownership-and-rls.md` §2. */
const domainTables = [
  "users",
  "farms",
  "fields",
  "field_outlook_cells",
  "field_observations",
  "plantings",
  "harvests",
  "crops",
  "cultivars",
  "crop_profile_versions",
  "growth_stages",
  "constraints",
  "source_refs",
  "outlook_cells",
  "forecast_runs",
  "ingestion_runs",
  "weather_records",
  "monthly_outlooks",
  "climatology_normals",
  "suitability_runs",
  "planting_windows",
  "ai_briefings",
];

/** Tenant-owned, and therefore ENABLE + FORCE RLS. */
const tenantTables = [
  "users",
  "farms",
  "fields",
  "field_outlook_cells",
  "field_observations",
  "plantings",
  "harvests",
  "suitability_runs",
  "planting_windows",
  "ai_briefings",
];

/** Global or reference: no tenant dimension, no policy. */
const globalTables = domainTables.filter((table) => !tenantTables.includes(table));

/** Composite ownership FKs required by `docs/data-model/relationships.md` §2. */
const compositeOwnershipEdges = [
  { child: "field_outlook_cells", columns: ["field_id", "user_id"], parent: "fields" },
  { child: "field_observations", columns: ["field_id", "user_id"], parent: "fields" },
  { child: "plantings", columns: ["field_id", "user_id"], parent: "fields" },
  { child: "harvests", columns: ["planting_id", "user_id"], parent: "plantings" },
  { child: "suitability_runs", columns: ["field_id", "user_id"], parent: "fields" },
  { child: "planting_windows", columns: ["field_id", "user_id"], parent: "fields" },
  {
    child: "planting_windows",
    columns: ["suitability_run_id", "user_id"],
    parent: "suitability_runs",
  },
  { child: "ai_briefings", columns: ["field_id", "user_id"], parent: "fields" },
  {
    child: "ai_briefings",
    columns: ["suitability_run_id", "user_id"],
    parent: "suitability_runs",
  },
];

before(async () => {
  await owner.connect();
});

after(async () => {
  await owner.end().catch(() => {});
});

describe("table inventory", () => {
  test("exactly the 22 domain tables exist in app, plus the migration ledger", async () => {
    const { rows } = await owner.query(
      "select tablename from pg_tables where schemaname = 'app' order by tablename",
    );
    const actual = rows.map((row) => row.tablename);
    const extra = actual.filter(
      (table) => table !== "_prisma_migrations" && !domainTables.includes(table),
    );
    const missing = domainTables.filter((table) => !actual.includes(table));

    assert.deepEqual(extra, [], "unexpected base table(s) in app");
    assert.deepEqual(missing, [], "missing domain table(s)");
  });

  test("every domain table has a primary key", async () => {
    const { rows } = await owner.query(
      `select child.relname as table
         from pg_class child
         join pg_namespace n on n.oid = child.relnamespace
        where n.nspname = 'app'
          and child.relkind = 'r'
          and exists (
            select 1 from pg_constraint con
             where con.conrelid = child.oid and con.contype = 'p'
          )`,
    );
    const withPrimaryKey = new Set(rows.map((row) => row.table));
    const missing = domainTables.filter((table) => !withPrimaryKey.has(table));
    assert.deepEqual(missing, [], "domain table(s) without a primary key");
  });
});

describe("row-level security flags", () => {
  test("the ten tenant tables are ENABLE + FORCE; the twelve reference tables are neither", async () => {
    const { rows } = await owner.query(
      `select c.relname as table, c.relrowsecurity as rls, c.relforcerowsecurity as force
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'app' and c.relkind = 'r'`,
    );
    const flags = new Map(rows.map((row) => [row.table, row]));

    for (const table of tenantTables) {
      const row = flags.get(table);
      assert.ok(row, `${table}: missing from pg_class`);
      assert.equal(row.rls, true, `${table}: relrowsecurity must be true`);
      assert.equal(row.force, true, `${table}: relforcerowsecurity must be true`);
    }

    for (const table of globalTables) {
      const row = flags.get(table);
      assert.ok(row, `${table}: missing from pg_class`);
      assert.equal(row.rls, false, `${table}: relrowsecurity must be false`);
      assert.equal(row.force, false, `${table}: relforcerowsecurity must be false`);
    }
  });

  test("tenant and reference sets partition the 22 tables", () => {
    assert.equal(tenantTables.length, 10);
    assert.equal(globalTables.length, 12);
  });
});

describe("deferred decisions (D26 / OPEN-09)", () => {
  test("plantings.status has no default", async () => {
    const { rows } = await owner.query(
      `select column_default
         from information_schema.columns
        where table_schema = 'app' and table_name = 'plantings' and column_name = 'status'`,
    );
    assert.equal(rows.length, 1, "plantings.status is missing");
    assert.equal(rows[0].column_default, null, "plantings.status must not acquire a default");
  });

  test("no plantings_active_idx was added ahead of the vocabulary decision", async () => {
    const { rows } = await owner.query(
      "select indexname from pg_indexes where schemaname = 'app' and indexname = 'plantings_active_idx'",
    );
    assert.deepEqual(rows, [], "plantings_active_idx exists but OPEN-09 is undecided");
  });
});

describe("weather_records live key", () => {
  test("weather_records_live_key is unique and NULLS NOT DISTINCT", async () => {
    const { rows } = await owner.query(
      `select i.indisunique as unique, i.indnullsnotdistinct as nulls_not_distinct
         from pg_index i
         join pg_class idx on idx.oid = i.indexrelid
         join pg_namespace n on n.oid = idx.relnamespace
        where n.nspname = 'app' and idx.relname = 'weather_records_live_key'`,
    );
    assert.equal(rows.length, 1, "weather_records_live_key is missing");
    assert.equal(rows[0].unique, true, "weather_records_live_key must be unique");
    assert.equal(
      rows[0].nulls_not_distinct,
      true,
      "weather_records_live_key must use NULLS NOT DISTINCT",
    );
  });
});

describe("composite ownership foreign keys", () => {
  /** @type {{ child: string, parent: string, columns: string[], parentColumns: string[] }[]} */
  let found;

  before(async () => {
    const { rows } = await owner.query(
      `select child.relname as child,
              parent.relname as parent,
              array(
                select att.attname
                  from unnest(con.conkey) with ordinality as k(attnum, ord)
                  join pg_attribute att
                    on att.attrelid = con.conrelid and att.attnum = k.attnum
                 order by k.ord
              )::text[] as columns,
              array(
                select att.attname
                  from unnest(con.confkey) with ordinality as k(attnum, ord)
                  join pg_attribute att
                    on att.attrelid = con.confrelid and att.attnum = k.attnum
                 order by k.ord
              )::text[] as parent_columns
         from pg_constraint con
         join pg_class child on child.oid = con.conrelid
         join pg_class parent on parent.oid = con.confrelid
         join pg_namespace n on n.oid = child.relnamespace
        where con.contype = 'f'
          and n.nspname = 'app'
          and array_length(con.conkey, 1) = 2`,
    );
    found = rows.map((row) => ({
      child: row.child,
      parent: row.parent,
      columns: row.columns,
      parentColumns: row.parent_columns,
    }));
  });

  test("each specified edge is a two-column constraint on (id, user_id)", () => {
    for (const edge of compositeOwnershipEdges) {
      const match = found.find(
        (candidate) =>
          candidate.child === edge.child &&
          candidate.parent === edge.parent &&
          candidate.columns.length === 2 &&
          candidate.columns[0] === edge.columns[0] &&
          candidate.columns[1] === edge.columns[1],
      );
      assert.ok(
        match,
        `${edge.child}(${edge.columns.join(",")}) -> ${edge.parent} is not a composite FK`,
      );
      assert.deepEqual(
        match.parentColumns,
        ["id", "user_id"],
        `${edge.child}(${edge.columns.join(",")}) must reference ${edge.parent}(id,user_id)`,
      );
    }
  });

  test("every UNIQUE (id, user_id) target cited by a composite FK exists", async () => {
    const parents = [
      ...new Set(
        found
          .filter((edge) => edge.parentColumns.join(",") === "id,user_id")
          .map((edge) => edge.parent),
      ),
    ];

    const { rows } = await owner.query(
      `select c.relname as table,
              array(
                select att.attname
                  from unnest(i.indkey) with ordinality as k(attnum, ord)
                  join pg_attribute att
                    on att.attrelid = i.indrelid and att.attnum = k.attnum
                 order by k.ord
              )::text[] as columns
         from pg_index i
         join pg_class c on c.oid = i.indrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'app' and i.indisunique`,
    );
    const uniqueColumns = new Map();
    for (const row of rows) {
      const list = uniqueColumns.get(row.table) ?? [];
      list.push(row.columns.join(","));
      uniqueColumns.set(row.table, list);
    }

    assert.ok(parents.length > 0, "no composite FK targets were discovered");
    for (const parent of parents) {
      const targets = uniqueColumns.get(parent) ?? [];
      assert.ok(
        targets.includes("id,user_id"),
        `${parent}: composite FK cites (id,user_id) but no UNIQUE (id,user_id) exists`,
      );
    }
  });
});

describe("geometry columns", () => {
  test("fields.geom is geometry(Geometry,4326) with the SRID enforced in the typmod", async () => {
    const { rows } = await owner.query(
      `select format_type(a.atttypid, a.atttypmod) as formatted,
              a.atttypmod as typmod,
              public.postgis_typmod_srid(a.atttypmod) as srid,
              public.postgis_typmod_type(a.atttypmod) as geom_type
         from pg_attribute a
         join pg_class c on c.oid = a.attrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'app' and c.relname = 'fields' and a.attname = 'geom'
          and a.attnum > 0 and not a.attisdropped`,
    );
    assert.equal(rows.length, 1, "fields.geom is missing");
    const column = rows[0];
    assert.match(
      column.formatted,
      /^(public\.)?geometry\(Geometry,4326\)$/,
      `fields.geom has type ${column.formatted}`,
    );
    assert.ok(column.typmod >= 0, "fields.geom has no type modifier; the SRID is unconstrained");
    assert.equal(column.srid, 4326, "fields.geom does not enforce SRID 4326");
    assert.equal(column.geom_type, "Geometry");
  });

  test("fields.area_ha is a stored generated column", async () => {
    const { rows } = await owner.query(
      `select a.attgenerated as generated
         from pg_attribute a
         join pg_class c on c.oid = a.attrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'app' and c.relname = 'fields' and a.attname = 'area_ha'
          and a.attnum > 0 and not a.attisdropped`,
    );
    assert.equal(rows.length, 1, "fields.area_ha is missing");
    assert.equal(rows[0].generated, "s", "fields.area_ha must be GENERATED ALWAYS ... STORED");
  });

  test("no table carries an unconstrained geometry column", async () => {
    const { rows } = await owner.query(
      `select c.relname as table, a.attname as column, a.atttypmod as typmod
         from pg_attribute a
         join pg_class c on c.oid = a.attrelid
         join pg_namespace n on n.oid = c.relnamespace
         join pg_type t on t.oid = a.atttypid
        where n.nspname = 'app'
          and c.relkind = 'r'
          and t.typname = 'geometry'
          and a.attnum > 0
          and not a.attisdropped
          and a.atttypmod = -1`,
    );
    assert.deepEqual(rows, [], "a raw geometry column with no type modifier/SRID exists in app");
  });
});
