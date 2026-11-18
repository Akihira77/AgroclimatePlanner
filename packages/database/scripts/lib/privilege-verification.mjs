/**
 * The privilege boundary verification, as a library.
 *
 * `scripts/verify-privileges.mjs` runs it against the configured cluster. The
 * probe-isolation test imports it directly so it can also drive the failure
 * path: cleanup after a failed setup is only proven by making one fail.
 *
 * Every assertion talks to PostgreSQL over TCP as the role it is about. A
 * denial counts only at SQLSTATE 42501, so a missing relation, a syntax error,
 * or a bad credential fails the check instead of passing as a boundary.
 */
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

import { Client } from "pg";

import { development, env, roleConnectionString, ROLE_NAMES } from "./connections.mjs";

/** Names from the pre-2.2.2.x verification, kept only as the decoy test's fixture. */
export const LEGACY_PROBE_NAMES = [
  "privilege_probe",
  "privilege_probe_sequence",
  "privilege_probe_function",
];

/**
 * Tenant-owned tables (matrix rows 1-7, 20-22). `users` is identity rather than
 * tenant, but it carries the same FORCE policy shape and is checked with them;
 * its runtime grant is `none`, which `EXPECTED` states separately.
 */
export const TENANT_TABLES = [
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

/** Global content, no tenant dimension (matrix rows 8-13): read-only to app_api. */
export const REFERENCE_TABLES = [
  "crops",
  "cultivars",
  "crop_profile_versions",
  "growth_stages",
  "constraints",
  "source_refs",
];

/** The weather plane (matrix rows 14-19): no RLS, app_system writes. */
export const GLOBAL_TABLES = [
  "outlook_cells",
  "forecast_runs",
  "ingestion_runs",
  "weather_records",
  "monthly_outlooks",
  "climatology_normals",
];

/** Identifiers here are generated, never user input — but assert before quoting. */
const SAFE_IDENTIFIER = /^[a-z][a-z0-9_]{0,50}$/;

function quote(name) {
  if (!SAFE_IDENTIFIER.test(name)) throw new Error(`refusing to interpolate identifier ${name}`);
  return `"${name}"`;
}

/**
 * A fresh token per run. Two concurrent verifications therefore create distinct
 * objects, and neither can drop the other's — nor a pre-existing object that
 * happened to carry the old static name.
 */
export function createProbes() {
  const token = randomBytes(6).toString("hex");
  return {
    token,
    table: `privilege_probe_t_${token}`,
    sequence: `privilege_probe_s_${token}`,
    fn: `privilege_probe_f_${token}`,
    qualified(kind) {
      return `app.${quote(this[kind])}`;
    },
  };
}

function child(identifier) {
  // DDL in this script runs as migration_owner, which owns `app`. The probe
  // names are generated hex, so no user-controlled text reaches an identifier.
  return `app.${quote(identifier)}`;
}

export async function runPrivilegeVerification({
  log = console.log,
  hooks = {},
  reBootstrap = true,
} = {}) {
  let failures = 0;
  let skipped = 0;

  const check = (label, passed, detail) => {
    if (passed) {
      log(`PASS  ${label}`);
      return;
    }
    failures += 1;
    log(`FAIL  ${label}${detail === undefined ? "" : ` — ${detail}`}`);
  };

  const skip = (label, reason) => {
    skipped += 1;
    log(`SKIP  ${label} — ${reason}`);
  };

  /** Denial is only a denial at 42501 (insufficient_privilege). */
  const denied = async (client, label, sql, parameters) => {
    try {
      await client.query(sql, parameters);
      check(label, false, "query succeeded, expected insufficient_privilege");
      return undefined;
    } catch (error) {
      check(label, error.code === "42501", `expected 42501, got ${error.code}: ${error.message}`);
      return error;
    }
  };

  const allowed = async (client, label, sql, parameters) => {
    try {
      const result = await client.query(sql, parameters);
      check(label, true);
      return result;
    } catch (error) {
      check(label, false, `expected success, got ${error.code}: ${error.message}`);
      return undefined;
    }
  };

  const uris = Object.fromEntries(ROLE_NAMES.map((role) => [role, roleConnectionString(role)]));
  const clients = Object.fromEntries(
    ROLE_NAMES.map((role) => [role, new Client({ connectionString: uris[role] })]),
  );
  const owner = clients["migration_owner"];
  const api = clients["app_api"];
  const system = clients["app_system"];

  const probes = createProbes();
  const created = { table: false, sequence: false, fn: false };

  try {
    await Promise.all(Object.values(clients).map((client) => client.connect()));

    // ---------------------------------------------------------------- identity
    // Before anything else. A denial coming from the wrong role proves nothing.
    for (const role of ROLE_NAMES) {
      const { rows } = await clients[role].query("select current_user as who");
      check(`connected as ${role}`, rows[0].who === role, `server reported ${rows[0].who}`);
    }

    // -------------------------------------------------------------- attributes
    const { rows: roles } = await owner.query(
      "select rolname, rolsuper, rolcanlogin, rolbypassrls, rolcreatedb, rolcreaterole from pg_roles where rolname = any($1)",
      [ROLE_NAMES],
    );
    const attribute = (name) => roles.find((role) => role.rolname === name);

    for (const name of ROLE_NAMES) check(`${name} exists`, attribute(name) !== undefined);
    for (const name of ROLE_NAMES) {
      const role = attribute(name);
      if (role === undefined) continue;
      check(`${name} is not a superuser`, role.rolsuper === false);
      check(`${name} cannot create databases`, role.rolcreatedb === false);
      check(`${name} cannot create roles`, role.rolcreaterole === false);
      check(`${name} can log in`, role.rolcanlogin === true);
    }
    check("app_api lacks BYPASSRLS", attribute("app_api")?.rolbypassrls === false);
    check("app_system has BYPASSRLS", attribute("app_system")?.rolbypassrls === true);

    // -------------------------------------------------------------- membership
    const { rows: memberships } = await owner.query(
      `select r.rolname as member, g.rolname as granted
         from pg_auth_members m
         join pg_roles r on r.oid = m.member
         join pg_roles g on g.oid = m.roleid
        where r.rolname = any($1) or g.rolname = any($1)`,
      [ROLE_NAMES],
    );
    check(
      "no role memberships involving the three roles",
      memberships.length === 0,
      JSON.stringify(memberships),
    );

    // ------------------------------------------------------------------ schema
    const { rows: schema } = await owner.query(
      "select pg_get_userbyid(nspowner) as schema_owner from pg_namespace where nspname = 'app'",
    );
    check(
      "schema app is owned by migration_owner",
      schema[0]?.schema_owner === "migration_owner",
      schema[0]?.schema_owner,
    );

    for (const role of ["app_api", "app_system"]) {
      const { rows } = await owner.query(
        "select has_schema_privilege($1, 'app', 'USAGE') as usage, has_schema_privilege($1, 'app', 'CREATE') as create",
        [role],
      );
      check(`${role} has USAGE on app`, rows[0].usage === true);
      check(`${role} has no CREATE on app`, rows[0].create === false);
    }

    const { rows: publicCreate } = await owner.query(
      "select has_schema_privilege($1, 'public', 'CREATE') as create",
      ["app_api"],
    );
    check("app_api has no CREATE on public", publicCreate[0].create === false);

    // --------------------------------------------- default privileges declared
    const { rows: defaultAcl } = await owner.query(
      `select d.defaclobjtype::text as kind, d.defaclacl::text as acl
         from pg_default_acl d join pg_roles r on r.oid = d.defaclrole
        where r.rolname = 'migration_owner'`,
    );
    const functionAcl = defaultAcl.find((row) => row.kind === "f");
    check(
      "default privileges revoke EXECUTE on functions from PUBLIC",
      functionAcl !== undefined && functionAcl.acl === "{migration_owner=X/migration_owner}",
      functionAcl?.acl,
    );

    // ------------------------------- bootstrap normalises a direct schema grant
    // Idempotency is a claim until a stray grant is planted and removed. The
    // bootstrap is a cluster-admin action, so this check needs that credential;
    // without it the assertion is reported as skipped, never as passed.
    const canRebootstrap = development || (env["BOOTSTRAP_DATABASE_URL"] ?? "") !== "";
    if (!reBootstrap) {
      skip(
        "bootstrap removes a direct CREATE grant on app",
        "re-bootstrap disabled for this run; concurrent bootstraps would contend on the same roles",
      );
    } else if (!canRebootstrap) {
      skip(
        "bootstrap removes a direct CREATE grant on app",
        "BOOTSTRAP_DATABASE_URL is unset outside development; cluster-admin re-bootstrap unavailable",
      );
    } else {
      await owner.query("grant create on schema app to app_api");
      const { rows: planted } = await owner.query(
        "select has_schema_privilege('app_api', 'app', 'CREATE') as create",
      );
      check("planted direct CREATE grant is visible", planted[0].create === true);

      const exitCode = await new Promise((resolve) => {
        const bootstrap = spawn(
          process.execPath,
          [new URL("../bootstrap.mjs", import.meta.url).pathname],
          { stdio: "ignore" },
        );
        bootstrap.on("exit", (code) => resolve(code));
      });
      check("re-bootstrap exits successfully", exitCode === 0, `exit code ${exitCode}`);

      const { rows: removed } = await owner.query(
        "select has_schema_privilege('app_api', 'app', 'CREATE') as create, has_schema_privilege('app_api', 'app', 'USAGE') as usage",
      );
      check("re-bootstrap removed the direct CREATE grant", removed[0].create === false);
      check("re-bootstrap preserved USAGE", removed[0].usage === true);
    }

    // ---------------------------------------- probe objects, created after grants
    // Deliberately unprivileged: nothing is granted to either runtime role, and
    // these are created after default privileges were configured, so any access
    // would have to come from a default that grants too much.
    await owner.query(`create table ${child(probes.table)} (id integer primary key, secret text)`);
    created.table = true;
    await owner.query(`create sequence ${child(probes.sequence)}`);
    created.sequence = true;
    await owner.query(
      `create function ${child(probes.fn)}() returns integer language sql as 'select 1'`,
    );
    created.fn = true;
    await owner.query(`insert into ${child(probes.table)} values (1, 'classified')`);

    await hooks.afterProbeSetup?.(probes);

    const { rows: probeOwner } = await owner.query(
      "select pg_get_userbyid(relowner) as owner_name from pg_class where oid = $1::regclass",
      [`app.${probes.table}`],
    );
    check(
      "probe table is owned by migration_owner",
      probeOwner[0]?.owner_name === "migration_owner",
      probeOwner[0]?.owner_name,
    );

    for (const role of ["app_api", "app_system"]) {
      const { rows } = await owner.query(
        `select has_table_privilege($1, $2, 'SELECT') as can_select,
                has_table_privilege($1, $2, 'INSERT') as can_insert,
                has_table_privilege($1, $2, 'UPDATE') as can_update,
                has_table_privilege($1, $2, 'DELETE') as can_delete`,
        [role, `app.${probes.table}`],
      );
      const row = rows[0];
      check(
        `${role} holds no probe table privilege`,
        !row.can_select && !row.can_insert && !row.can_update && !row.can_delete,
        JSON.stringify(row),
      );
    }

    // ------------------------------------------------------------- app_api: deny
    await denied(
      api,
      "app_api cannot SELECT an ungranted table",
      `select * from ${child(probes.table)}`,
    );
    await denied(
      api,
      "app_api cannot INSERT into an ungranted table",
      `insert into ${child(probes.table)} values (2, 'x')`,
    );
    await denied(
      api,
      "app_api cannot UPDATE an ungranted table",
      `update ${child(probes.table)} set secret = 'x'`,
    );
    await denied(
      api,
      "app_api cannot DELETE from an ungranted table",
      `delete from ${child(probes.table)}`,
    );
    await denied(
      api,
      "app_api cannot create a table in app",
      "create table app.should_not_exist (id int)",
    );
    await denied(
      api,
      "app_api cannot alter an application table",
      `alter table ${child(probes.table)} add column extra text`,
    );
    await denied(
      api,
      "app_api cannot drop an application table",
      `drop table ${child(probes.table)}`,
    );
    await denied(
      api,
      "app_api cannot use an ungranted sequence",
      `select nextval('app.${probes.sequence}')`,
    );
    await denied(api, "app_api cannot set role to migration_owner", "set role migration_owner");
    await denied(api, "app_api cannot create a schema", "create schema not_allowed");
    await denied(
      api,
      "app_api cannot write the migration ledger",
      "delete from app._prisma_migrations",
    );
    await denied(
      api,
      "app_api cannot execute an ungranted function",
      `select ${child(probes.fn)}()`,
    );
    await allowed(api, "app_api can read the catalogue", "select count(*) from pg_class");

    // ---------------------------------------------------------- app_system: deny
    await denied(
      system,
      "app_system cannot SELECT an ungranted table",
      `select * from ${child(probes.table)}`,
    );
    await denied(
      system,
      "app_system cannot INSERT into an ungranted table",
      `insert into ${child(probes.table)} values (3, 'x')`,
    );
    await denied(
      system,
      "app_system cannot UPDATE an ungranted table",
      `update ${child(probes.table)} set secret = 'x'`,
    );
    await denied(
      system,
      "app_system cannot DELETE from an ungranted table",
      `delete from ${child(probes.table)}`,
    );
    await denied(
      system,
      "app_system cannot create a table in app",
      "create table app.should_not_exist (id int)",
    );
    await denied(
      system,
      "app_system cannot alter an application table",
      `alter table ${child(probes.table)} add column extra text`,
    );
    await denied(
      system,
      "app_system cannot drop an application table",
      `drop table ${child(probes.table)}`,
    );
    await denied(
      system,
      "app_system cannot use an ungranted sequence",
      `select nextval('app.${probes.sequence}')`,
    );
    await denied(
      system,
      "app_system cannot set role to migration_owner",
      "set role migration_owner",
    );
    await denied(system, "app_system cannot set role to app_api", "set role app_api");
    await denied(
      system,
      "app_system cannot write the migration ledger",
      "delete from app._prisma_migrations",
    );
    await denied(
      system,
      "app_system cannot execute an ungranted function",
      `select ${child(probes.fn)}()`,
    );

    // ------------------------------------------------------- column-level grants
    // The mechanism behind the later `SELECT geom FROM fields` denial: a role
    // may be granted one column and still be unable to read its neighbours.
    await owner.query(`grant select (id) on ${child(probes.table)} to app_system`);
    await allowed(
      system,
      "app_system can read the granted column",
      `select id from ${child(probes.table)}`,
    );
    await denied(
      system,
      "app_system cannot read an ungranted column",
      `select secret from ${child(probes.table)}`,
    );
    await denied(
      system,
      "app_system cannot read the whole row",
      `select * from ${child(probes.table)}`,
    );
    await owner.query(`revoke select (id) on ${child(probes.table)} from app_system`);
    await denied(
      system,
      "column grant removal takes effect",
      `select id from ${child(probes.table)}`,
    );

    // --------------------------------------------------------------- ledger owner
    const { rows: ledger } = await owner.query(
      "select pg_get_userbyid(relowner) as owner_name from pg_class where oid = to_regclass('app._prisma_migrations')",
    );
    check(
      "migration ledger lives in app and is owned by migration_owner",
      ledger[0]?.owner_name === "migration_owner",
      ledger[0]?.owner_name,
    );

    // ------------------------------------------------------------ tenant tables
    // Structure first, then behaviour. A policy row existing is not evidence that
    // a query is isolated — `db` does that part — but a missing FORCE flag means
    // the owner (migration_owner) reads every tenant's rows, which no behavioural
    // test running as app_api would ever notice.
    const { rows: tenantTables } = await owner.query(
      `select c.relname as name,
              c.relrowsecurity as rls,
              c.relforcerowsecurity as force_rls,
              pg_get_userbyid(c.relowner) as owner_name
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'app' and c.relkind = 'r' and c.relname = any($1)
        order by c.relname`,
      [TENANT_TABLES],
    );

    check(
      `tenant tables exist: ${TENANT_TABLES.join(", ")}`,
      tenantTables.length === TENANT_TABLES.length,
      tenantTables.map((table) => table.name).join(", "),
    );

    for (const table of tenantTables) {
      check(`${table.name} has RLS enabled`, table.rls === true);
      check(`${table.name} has FORCE RLS`, table.force_rls === true);
      check(
        `${table.name} is owned by migration_owner`,
        table.owner_name === "migration_owner",
        table.owner_name,
      );
    }

    const { rows: policies } = await owner.query(
      `select tablename, policyname, cmd, roles::text as roles, qual, with_check
         from pg_policies
        where schemaname = 'app' and tablename = any($1)`,
      [TENANT_TABLES],
    );

    for (const table of TENANT_TABLES) {
      const own = policies.filter((policy) => policy.tablename === table);
      const tenantPolicy = own.find((policy) => policy.roles === "{app_api}");
      check(
        `${table} has an app_api policy for all commands`,
        tenantPolicy !== undefined && tenantPolicy.cmd === "ALL",
        JSON.stringify(own.map((policy) => `${policy.policyname}:${policy.cmd}:${policy.roles}`)),
      );
      // USING alone would let app_api move a row into another tenant's ownership
      // via UPDATE; WITH CHECK is what forbids the result.
      check(
        `${table} policy has both USING and WITH CHECK`,
        tenantPolicy !== undefined &&
          typeof tenantPolicy.qual === "string" &&
          typeof tenantPolicy.with_check === "string" &&
          tenantPolicy.qual.includes("app.user_id") &&
          tenantPolicy.with_check.includes("app.user_id"),
        `${tenantPolicy?.qual} / ${tenantPolicy?.with_check}`,
      );
      check(
        `${table} has no policy granted to PUBLIC`,
        !own.some((policy) => policy.roles === "{public}"),
        JSON.stringify(own.map((policy) => policy.roles)),
      );
      // FORCE denies the owner too, so a missing owner policy locks fixture
      // inserts and data migrations out of their own table.
      check(
        `${table} has a migration_owner policy`,
        own.some((policy) => policy.roles === "{migration_owner}" && policy.cmd === "ALL"),
        JSON.stringify(own.map((policy) => `${policy.policyname}:${policy.roles}`)),
      );
    }

    // Effective privileges, per table per operation, from PostgreSQL's own
    // answer rather than from the migration text. Built from the ownership
    // classes so the matrix cannot drift from the table list.
    const RW = ["SELECT", "INSERT", "UPDATE", "DELETE"];
    const R = ["SELECT"];
    const NONE = [];

    const EXPECTED = Object.fromEntries([
      // Row 1: identity. No grant at all — the login lookup is OPEN-01.
      ["users", { app_api: NONE, app_system: NONE }],
      ...TENANT_TABLES.filter((table) => table !== "users").map((table) => [
        table,
        { app_api: RW, app_system: NONE },
      ]),
      ...REFERENCE_TABLES.map((table) => [table, { app_api: R, app_system: NONE }]),
      // Row 14: app_api reads and holds the column-level INSERT checked below.
      ["outlook_cells", { app_api: R, app_system: RW }],
      ...GLOBAL_TABLES.filter((table) => table !== "outlook_cells").map((table) => [
        table,
        { app_api: R, app_system: RW },
      ]),
    ]);

    for (const [table, expectations] of Object.entries(EXPECTED)) {
      for (const [role, allowed] of Object.entries(expectations)) {
        for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
          const expected = allowed.includes(privilege);
          const { rows } = await owner.query(`select has_table_privilege($1, $2, $3) as granted`, [
            role,
            `app.${table}`,
            privilege,
          ]);
          check(
            `${role} ${expected ? "holds" : "lacks"} ${privilege} on ${table}`,
            rows[0].granted === expected,
            `expected ${expected}, got ${rows[0].granted}`,
          );
        }
      }
    }

    // The columns the maintenance sweep must never reach. app_system has no grant
    // on these tables at all, which is the stricter version of the documented
    // column-list rule: absence by default.
    for (const [table, column] of [
      ["fields", "geom"],
      ["fields", "soil_ph"],
      ["farms", "notes"],
    ]) {
      const { rows } = await owner.query(
        "select has_column_privilege($1, $2, $3, 'SELECT') as granted",
        ["app_system", `app.${table}`, column],
      );
      check(`app_system has no SELECT on ${table}.${column}`, rows[0].granted === false);
    }

    // Matrix rule 2: app_system holds nothing on a tenant-owned table, column
    // privileges included. A table-level grant makes has_column_privilege true
    // for every column, so this catches both shapes.
    for (const table of TENANT_TABLES) {
      const { rows } = await owner.query(
        `select (select array_agg(p.priv)
                   from (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) as p(priv)
                  where has_table_privilege('app_system', c.oid, p.priv)) as table_privs,
                -- PostgreSQL has no column-level DELETE: only the other three
                -- verbs can be granted per column.
                (select array_agg(p.priv || ':' || a.attname order by p.priv, a.attname)
                   from pg_attribute a
                   cross join (values ('SELECT'), ('INSERT'), ('UPDATE')) as p(priv)
                  where a.attrelid = c.oid
                    and a.attnum > 0
                    and not a.attisdropped
                    and has_column_privilege('app_system', c.oid, a.attnum, p.priv)) as column_privs
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'app' and c.relname = $1`,
        [table],
      );
      const row = rows[0];
      const held = [...(row?.table_privs ?? []), ...(row?.column_privs ?? [])];
      check(
        `app_system holds no privilege of any kind on ${table}`,
        rows.length === 1 && held.length === 0,
        rows.length === 0 ? "relation not found" : JSON.stringify(held),
      );
    }

    // app_api's only write into the weather plane: the identity triple, because
    // field creation resolves a cell before any ingest exists (D14).
    for (const column of ["provider", "model", "cell_key"]) {
      const { rows } = await owner.query(
        "select has_column_privilege($1, $2, $3, 'INSERT') as granted",
        ["app_api", "app.outlook_cells", column],
      );
      check(
        `app_api holds INSERT on outlook_cells.${column}`,
        rows[0].granted === true,
        `expected true, got ${rows[0].granted}`,
      );
    }
    // The served coordinate is a provider fact only app_system observes. A
    // table-level INSERT would defeat the column grant silently — every one of
    // these columns is asserted, not just the first.
    for (const column of ["served_lat", "served_lon", "elevation_m", "spatial_resolution_km"]) {
      const { rows } = await owner.query(
        "select has_column_privilege($1, $2, $3, 'INSERT') as granted",
        ["app_api", "app.outlook_cells", column],
      );
      check(
        `app_api lacks INSERT on outlook_cells.${column}`,
        rows[0].granted === false,
        `expected false, got ${rows[0].granted}`,
      );
    }
    await denied(
      api,
      "app_api cannot write a served coordinate on outlook_cells",
      `insert into app.outlook_cells (provider, model, cell_key, served_lat)
       values ('bmkg', 'privilege_probe', 'probe', 1)`,
    );

    // RLS on a table with no owner column would only lock migration_owner out of
    // its own seed or ingest, so `none` in the matrix is load-bearing.
    for (const table of [...REFERENCE_TABLES, ...GLOBAL_TABLES]) {
      const { rows } = await owner.query(
        `select c.relrowsecurity as rls
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'app' and c.relname = $1`,
        [table],
      );
      check(
        `${table} has no row level security`,
        rows.length === 1 && rows[0].rls === false,
        rows.length === 0 ? "relation not found" : `relrowsecurity = ${rows[0].rls}`,
      );
    }

    // Phase 3 decisions rather than privileges: the status vocabulary is
    // undecided (OPEN-09/D26), so a default or a partial index on a status
    // literal would encode a value nobody approved.
    const { rows: plantingsStatus } = await owner.query(
      `select column_default
         from information_schema.columns
        where table_schema = 'app' and table_name = 'plantings' and column_name = 'status'`,
    );
    check(
      "plantings.status has no column default",
      plantingsStatus.length === 1 && plantingsStatus[0].column_default === null,
      plantingsStatus.length === 0
        ? "column not found"
        : `default ${plantingsStatus[0].column_default}`,
    );

    const { rows: plantingsActive } = await owner.query(
      "select indexname from pg_indexes where schemaname = 'app' and indexname = 'plantings_active_idx'",
    );
    check(
      "no plantings_active_idx exists",
      plantingsActive.length === 0,
      JSON.stringify(plantingsActive),
    );

    // Without NULLS NOT DISTINCT every re-ingest of a deterministic product
    // appends a duplicate set: PostgreSQL treats NULL as distinct by default,
    // so ensemble_member = NULL rows never collide.
    const { rows: liveKey } = await owner.query(
      `select i.indnullsnotdistinct as nulls_not_distinct
         from pg_index i
         join pg_class c on c.oid = i.indexrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'app' and c.relname = 'weather_records_live_key'`,
    );
    check(
      "weather_records_live_key treats NULLS as NOT DISTINCT",
      liveKey.length === 1 && liveKey[0].nulls_not_distinct === true,
      liveKey.length === 0
        ? "index not found"
        : `indnullsnotdistinct = ${liveKey[0].nulls_not_distinct}`,
    );

    // Composite ownership foreign key: (farm_id, user_id) -> farms(id, user_id).
    // Without it a tenant could attach its field to another tenant's farm.
    const { rows: composite } = await owner.query(
      `select con.conname as name,
              array_length(con.conkey, 1) as width,
              pg_get_constraintdef(con.oid) as definition
         from pg_constraint con
         join pg_class c on c.oid = con.conrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'app' and c.relname = 'fields' and con.contype = 'f'`,
    );
    const ownershipKey = composite.find((constraint) => constraint.width === 2);
    check(
      "fields carries a composite ownership foreign key",
      ownershipKey !== undefined &&
        /FOREIGN KEY \(farm_id, user_id\) REFERENCES app\.farms\(id, user_id\)/.test(
          ownershipKey.definition,
        ),
      ownershipKey?.definition,
    );

    // app_system is BYPASSRLS, so its restriction is the grant list, not a policy.
    await denied(system, "app_system cannot read fields.geom", "select geom from app.fields");
    await denied(system, "app_system cannot read fields.soil_ph", "select soil_ph from app.fields");
    await denied(
      system,
      "app_system cannot update a tenant table",
      "update app.farms set name = 'x'",
    );
    await denied(system, "app_system cannot delete from a tenant table", "delete from app.fields");
    await denied(
      system,
      "app_system cannot insert into a tenant table",
      "insert into app.farms (user_id, name) values (gen_random_uuid(), 'x')",
    );

    // app_api owns its tenant's data on farms and fields, and holds no grant at
    // all on users: email lookup is the authentication path, which runs before a
    // tenant context exists and is deliberately deferred rather than half-built.
    await denied(api, "app_api holds no grant on app.users", "select * from app.users");
  } finally {
    // Only what this run created, and only if creation succeeded. A name that
    // collided with something else is reported by the check above, not dropped.
    if (created.table)
      await owner.query(`drop table if exists ${child(probes.table)}`).catch(() => {});
    if (created.sequence)
      await owner.query(`drop sequence if exists ${child(probes.sequence)}`).catch(() => {});
    if (created.fn)
      await owner.query(`drop function if exists ${child(probes.fn)}()`).catch(() => {});
    await Promise.all(Object.values(clients).map((client) => client.end().catch(() => {})));
  }

  return { failures, skipped, probes };
}
