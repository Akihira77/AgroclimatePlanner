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

/** The 25 domain tables, `docs/data-model/ownership-and-rls.md` §2. */
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
  "climatology_baselines",
  "suitability_runs",
  "planting_windows",
  "ai_briefings",
  "sessions",
  "jobs",
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

/**
 * Identity/authentication tables: not tenant-scoped, reached only by `app_auth`,
 * protected by ENABLE + FORCE RLS, and carry no `app.user_id` predicate.
 */
const identityTables = ["sessions"];

/** Global or reference: no tenant dimension, no policy. */
const globalTables = domainTables.filter(
  (table) => !tenantTables.includes(table) && !identityTables.includes(table),
);

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
  test("exactly the 25 domain tables exist in app, plus the migration ledger", async () => {
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
  test("the ten tenant tables and one identity table are ENABLE + FORCE; the thirteen reference tables are neither", async () => {
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

    for (const table of identityTables) {
      const row = flags.get(table);
      assert.ok(row, `${table}: missing from pg_class`);
      assert.equal(row.rls, true, `${table}: relrowsecurity must be true`);
      assert.equal(row.force, true, `${table}: relforcerowsecurity must be true`);
    }
  });

  test("app.sessions must not carry a tenant GUC policy", async () => {
    const { rows } = await owner.query(
      `select policyname, qual, with_check
         from pg_policies
        where schemaname = 'app' and tablename = 'sessions'`,
    );

    assert.ok(rows.length > 0, "app.sessions must carry at least one policy");

    const tenantGuc = rows.filter(
      (row) =>
        (row.qual ?? "").includes("current_setting('app.user_id'") ||
        (row.with_check ?? "").includes("current_setting('app.user_id'"),
    );
    assert.deepEqual(tenantGuc, [], "app.sessions must not carry a tenant GUC policy");
  });

  test("tenant, identity and reference sets partition the 25 tables", () => {
    assert.equal(tenantTables.length, 10);
    assert.equal(globalTables.length, 14);
    assert.equal(identityTables.length, 1);
    assert.equal(
      tenantTables.length + globalTables.length + identityTables.length,
      domainTables.length,
    );
    assert.equal(
      new Set([...tenantTables, ...globalTables, ...identityTables]).size,
      domainTables.length,
    );
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

/**
 * Reduce a constraint definition to the planner's meaning: PostgreSQL adds casts,
 * the `interval` keyword, redundant parentheses and quotes that are formatting,
 * not policy. Applied to both sides so the comparison is against the normative
 * definition rather than against PostgreSQL's printer.
 */
function normaliseCheck(definition) {
  return definition
    .toLowerCase()
    .replace(/::[a-z_]+(?:\s+(?:with|without)\s+time\s+zone)?/g, "")
    .replace(/\binterval\b/g, "")
    .replace(/['"()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

describe("supersession chains", () => {
  /**
   * Every `supersedes_id` / `superseded_by_id` column must be a foreign key to its
   * own table. That is not a stylistic rule: `planting_windows.superseded_by_id`
   * was indexed, documented and guarded by a status check, but the constraint was
   * never written by any migration, so a window could name a superseding row that
   * does not exist. The bug was found by a schema diff, not by a test, which is
   * why the class is asserted here rather than the one instance.
   */
  const EXPECTED = [
    ["ai_briefings", "superseded_by_id"],
    ["crop_profile_versions", "supersedes_id"],
    ["monthly_outlooks", "superseded_by_id"],
    ["planting_windows", "superseded_by_id"],
    ["suitability_runs", "superseded_by_id"],
    ["suitability_runs", "supersedes_id"],
    ["weather_records", "superseded_by_id"],
    ["weather_records", "supersedes_id"],
  ];

  let found;
  let declared;

  before(async () => {
    const { rows } = await owner.query(
      `select tbl.relname as table_name,
              att.attname as column_name,
              con.conname as constraint_name,
              con.confdeltype as on_delete_policy,
              pg_get_constraintdef(con.oid) as definition
         from pg_attribute att
         join pg_class tbl on tbl.oid = att.attrelid
         join pg_namespace n on n.oid = tbl.relnamespace
         left join pg_constraint con
           on con.conrelid = tbl.oid
          and con.confrelid = tbl.oid
          and con.contype = 'f'
          and con.conkey = array[att.attnum]
        where n.nspname = 'app'
          and tbl.relkind = 'r'
          and att.attname in ('supersedes_id', 'superseded_by_id')
          and att.attnum > 0
        order by 1, 2`,
    );
    found = new Map(
      rows.map((row) => [
        `${row.table_name}.${row.column_name}`,
        {
          name: row.constraint_name,
          onDelete: row.on_delete_policy,
          definition: row.definition,
        },
      ]),
    );
    declared = [...found.keys()];
  });

  test("the eight declared chain pointers are the eight the catalogue holds", () => {
    const expected = EXPECTED.map(([table, column]) => `${table}.${column}`);
    assert.deepEqual(
      declared,
      expected,
      "a column added or removed without updating this list is a decision nobody recorded",
    );
  });

  test("each pointer is a single-column foreign key to its own table, NO ACTION on delete", () => {
    for (const [table, column] of EXPECTED) {
      const entry = found.get(`${table}.${column}`);
      assert.ok(
        entry.name,
        `${table}.${column} has a value but no constraint, so it can name a row that does not exist`,
      );
      assert.equal(
        entry.onDelete,
        "a",
        `${table}.${column} must be NO ACTION on delete, not a cascade that rewrites an audit chain`,
      );
      assert.match(
        entry.definition,
        new RegExp(`^FOREIGN KEY \\(${column}\\) REFERENCES app\\.${table}\\(id\\)`),
        `${table}.${column} must reference ${table}(id)`,
      );
    }
  });
});

describe("app.sessions structure", () => {
  test("the nine columns match the definition in attnum order", async () => {
    const expected = [
      { name: "id", type: "uuid", notNull: true, default: "uuidv7()" },
      { name: "user_id", type: "uuid", notNull: true, default: null },
      { name: "token_hash", type: "text", notNull: true, default: null },
      {
        name: "expires_at",
        type: "timestamp with time zone",
        notNull: true,
        default: null,
      },
      {
        name: "absolute_expires_at",
        type: "timestamp with time zone",
        notNull: true,
        default: null,
      },
      {
        name: "revoked_at",
        type: "timestamp with time zone",
        notNull: false,
        default: null,
      },
      {
        name: "last_seen_at",
        type: "timestamp with time zone",
        notNull: true,
        default: "now()",
      },
      {
        name: "created_at",
        type: "timestamp with time zone",
        notNull: true,
        default: "now()",
      },
      // `Amendment 4`: nullable by design — `NULL` is "not issued yet" — and
      // plaintext because the value must be re-served on every retrieval.
      { name: "csrf_token", type: "text", notNull: false, default: null },
    ];

    const { rows } = await owner.query(
      `select a.attname as name,
              format_type(a.atttypid, a.atttypmod) as type,
              a.attnotnull as not_null,
              pg_get_expr(d.adbin, d.adrelid) as default
         from pg_attribute a
         join pg_class c on c.oid = a.attrelid
         join pg_namespace n on n.oid = c.relnamespace
         left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
        where n.nspname = 'app' and c.relname = 'sessions'
          and a.attnum > 0 and not a.attisdropped
        order by a.attnum`,
    );
    assert.deepEqual(
      rows.map((row) => ({
        name: row.name,
        type: row.type,
        notNull: row.not_null,
        default: row.default,
      })),
      expected,
      "app.sessions columns must be exactly the nine approved definitions",
    );
  });

  test("the four CHECK constraints are an exact inventory", async () => {
    const expected = [
      "CHECK (absolute_expires_at >= expires_at AND expires_at > created_at)",
      "CHECK (token_hash ~ '^[0-9a-f]{64}$')",
      "CHECK (absolute_expires_at <= created_at + INTERVAL '90 days')",
      "CHECK (csrf_token IS NULL OR csrf_token ~ '^[A-Za-z0-9_-]{43}$')",
    ]
      .map(normaliseCheck)
      .sort();

    const { rows } = await owner.query(
      `select conname, pg_get_constraintdef(oid) as definition
         from pg_constraint
        where conrelid = 'app.sessions'::regclass and contype = 'c'
        order by conname`,
    );

    assert.equal(
      rows.length,
      4,
      `app.sessions must carry exactly four CHECK constraints (found ${rows
        .map((row) => row.conname)
        .join(", ")})`,
    );
    assert.deepEqual(
      rows.map((row) => normaliseCheck(row.definition)).sort(),
      expected,
      "app.sessions CHECK definitions must match the expiry order, hash shape, 90-day cap and CSRF shape",
    );
  });

  test("no constraint kind exists beyond p, u, c and f", async () => {
    const { rows } = await owner.query(
      `select distinct contype
         from pg_constraint
        where conrelid = 'app.sessions'::regclass and contype <> 'n'
        order by contype`,
    );
    assert.deepEqual(
      rows.map((row) => row.contype),
      ["c", "f", "p", "u"],
      "app.sessions must not carry an unexpected constraint kind",
    );
  });

  test("the unique constraint on token_hash and the primary key on id are present", async () => {
    const { rows } = await owner.query(
      `select con.conname as name,
              con.contype as kind,
              pg_get_constraintdef(con.oid) as definition,
              array(
                select att.attname
                  from unnest(con.conkey) with ordinality as k(attnum, ord)
                  join pg_attribute att
                    on att.attrelid = con.conrelid and att.attnum = k.attnum
                 order by k.ord
              )::text[] as columns
         from pg_constraint con
        where con.conrelid = 'app.sessions'::regclass and con.contype in ('p', 'u')
        order by con.conname`,
    );

    assert.deepEqual(
      rows.map((row) => ({
        name: row.name,
        kind: row.kind,
        definition: row.definition,
        columns: row.columns,
      })),
      [
        {
          name: "sessions_pkey",
          kind: "p",
          definition: "PRIMARY KEY (id)",
          columns: ["id"],
        },
        {
          name: "sessions_token_hash_key",
          kind: "u",
          definition: "UNIQUE (token_hash)",
          columns: ["token_hash"],
        },
      ],
      "app.sessions must carry sessions_pkey (id) and sessions_token_hash_key (token_hash)",
    );
  });

  test("the index inventory is exactly the primary key, the unique key and two lookup indexes", async () => {
    const { rows } = await owner.query(
      `select idx.relname as name,
              i.indisunique as unique,
              array(
                select att.attname
                  from unnest(i.indkey) with ordinality as k(attnum, ord)
                  join pg_attribute att
                    on att.attrelid = i.indrelid and att.attnum = k.attnum
                 order by k.ord
              )::text[] as columns,
              i.indnkeyatts as key_columns
         from pg_index i
         join pg_class idx on idx.oid = i.indexrelid
         join pg_class c on c.oid = i.indrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'app' and c.relname = 'sessions'
        order by idx.relname`,
    );

    assert.deepEqual(
      rows.map((row) => ({
        name: row.name,
        columns: row.columns,
        unique: row.unique,
        keyColumns: row.key_columns,
      })),
      [
        {
          name: "sessions_absolute_expires_at_idx",
          columns: ["absolute_expires_at"],
          unique: false,
          keyColumns: 1,
        },
        { name: "sessions_pkey", columns: ["id"], unique: true, keyColumns: 1 },
        {
          name: "sessions_token_hash_key",
          columns: ["token_hash"],
          unique: true,
          keyColumns: 1,
        },
        { name: "sessions_user_id_idx", columns: ["user_id"], unique: false, keyColumns: 1 },
      ],
      "app.sessions must have exactly the four approved single-column indexes",
    );
  });

  test("the two policies grant ALL to app_auth and migration_owner and no one else", async () => {
    const { rows } = await owner.query(
      `select policyname as name,
              permissive,
              roles::text[] as roles,
              cmd,
              qual,
              with_check
         from pg_policies
        where schemaname = 'app' and tablename = 'sessions'
        order by policyname`,
    );

    assert.deepEqual(
      rows.map((row) => ({
        name: row.name,
        permissive: row.permissive,
        roles: row.roles,
        cmd: row.cmd,
        qual: row.qual,
        withCheck: row.with_check,
      })),
      [
        {
          name: "sessions_auth_all",
          permissive: "PERMISSIVE",
          roles: ["app_auth"],
          cmd: "ALL",
          qual: "true",
          withCheck: "true",
        },
        {
          name: "sessions_owner_full_access",
          permissive: "PERMISSIVE",
          roles: ["migration_owner"],
          cmd: "ALL",
          qual: "true",
          withCheck: "true",
        },
      ],
      "app.sessions policies must be ALL/permissive/true for app_auth and migration_owner only",
    );

    const forbidden = rows
      .flatMap((row) => row.roles)
      .filter((role) => role === "PUBLIC" || role === "app_api");
    assert.deepEqual(forbidden, [], "app.sessions must not grant a policy to PUBLIC or app_api");
  });

  test("app_auth holds exactly the approved column grants", async () => {
    const { rows: columns } = await owner.query(
      `select a.attname as name
         from pg_attribute a
         join pg_class c on c.oid = a.attrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'app' and c.relname = 'sessions'
          and a.attnum > 0 and not a.attisdropped
        order by a.attnum`,
    );
    const names = columns.map((column) => column.name);
    const insertable = new Set(["user_id", "token_hash", "expires_at", "absolute_expires_at"]);
    const updatable = new Set(["expires_at", "last_seen_at", "revoked_at", "csrf_token"]);

    const { rows } = await owner.query(
      `select a.attname as name,
              has_column_privilege('app_auth', 'app.sessions', a.attname, 'SELECT') as can_select,
              has_column_privilege('app_auth', 'app.sessions', a.attname, 'INSERT') as can_insert,
              has_column_privilege('app_auth', 'app.sessions', a.attname, 'UPDATE') as can_update,
              exists (
                select 1
                  from aclexplode(coalesce(a.attacl, '{}'::aclitem[])) as acl
                  join pg_roles r on r.oid = acl.grantee
                 where r.rolname = 'app_auth' and acl.privilege_type = 'DELETE'
              ) as can_delete
         from pg_attribute a
         join pg_class c on c.oid = a.attrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'app' and c.relname = 'sessions'
          and a.attnum > 0 and not a.attisdropped
        order by a.attnum`,
    );

    assert.deepEqual(
      rows.map((row) => ({
        name: row.name,
        canSelect: row.can_select,
        canInsert: row.can_insert,
        canUpdate: row.can_update,
        canDelete: row.can_delete,
      })),
      names.map((name) => ({
        name,
        canSelect: true,
        canInsert: insertable.has(name),
        canUpdate: updatable.has(name),
        canDelete: false,
      })),
      "app_auth column grants must be SELECT all, INSERT four, UPDATE four, DELETE none",
    );
  });

  test("the column grants never become a table privilege", async () => {
    const { rows } = await owner.query(
      `select has_table_privilege('app_auth', 'app.sessions', 'SELECT') as can_select,
              has_table_privilege('app_auth', 'app.sessions', 'INSERT') as can_insert,
              has_table_privilege('app_auth', 'app.sessions', 'UPDATE') as can_update,
              has_table_privilege('app_auth', 'app.sessions', 'DELETE') as can_delete`,
    );
    assert.deepEqual(
      {
        canSelect: rows[0].can_select,
        canInsert: rows[0].can_insert,
        canUpdate: rows[0].can_update,
        canDelete: rows[0].can_delete,
      },
      { canSelect: false, canInsert: false, canUpdate: false, canDelete: false },
      "app_auth must hold no table-level privilege on app.sessions",
    );
  });

  test("user_id references app.users(id) with NO ACTION on delete", async () => {
    const { rows } = await owner.query(
      `select con.conname as name,
              pg_get_constraintdef(con.oid) as definition,
              con.confdeltype as on_delete,
              parent.relname as parent_table
         from pg_constraint con
         join pg_class parent on parent.oid = con.confrelid
        where con.conrelid = 'app.sessions'::regclass and con.contype = 'f'`,
    );

    assert.equal(rows.length, 1, "app.sessions must carry exactly one foreign key");
    assert.deepEqual(
      {
        name: rows[0].name,
        definition: rows[0].definition,
        onDelete: rows[0].on_delete,
        parentTable: rows[0].parent_table,
      },
      {
        name: "sessions_user_id_fkey",
        definition: "FOREIGN KEY (user_id) REFERENCES app.users(id)",
        onDelete: "a",
        parentTable: "users",
      },
      "user_id must reference app.users(id) with NO ACTION, not a cascade",
    );
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

  /**
   * The typmod's dimensional part, read with PostGIS's own accessor rather than
   * parsed out of `format_type`. Measured on this database (PostGIS 3.6):
   * `2` for `geometry(Geometry,4326)`, `3` for `geometry(GeometryZ,4326)`, and
   * `NULL` for an unconstrained `geometry`. A 3D typmod would accept `POLYGON Z`,
   * which the API refuses and which `ST_AsGeoJSON` would then return as
   * three-ordinate positions.
   */
  test("fields.geom is two-dimensional", async () => {
    const { rows } = await owner.query(
      `select public.postgis_typmod_dims(a.atttypmod) as dims
         from pg_attribute a
         join pg_class c on c.oid = a.attrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'app' and c.relname = 'fields' and a.attname = 'geom'
          and a.attnum > 0 and not a.attisdropped`,
    );
    assert.equal(rows.length, 1, "fields.geom is missing");
    assert.equal(
      rows[0].dims,
      2,
      `fields.geom has typmod dimensions ${rows[0].dims}; null means unconstrained, 3 means Z is accepted`,
    );
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
