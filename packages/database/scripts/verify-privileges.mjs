/**
 * Privilege boundary verification against a real PostgreSQL instance.
 *
 * Every assertion here runs as the role it is about, over a password-
 * authenticated TCP connection. Nothing is simulated: a denial is only counted
 * when PostgreSQL answers with SQLSTATE 42501, so a typo, a missing table, or a
 * bad credential cannot masquerade as a working boundary.
 *
 * Run: pnpm --filter @agroclimate/database db:verify
 */
import { existsSync, readFileSync } from "node:fs";

import { Client } from "pg";

const defaults = JSON.parse(
  readFileSync(new URL("../database.defaults.json", import.meta.url), "utf8"),
);

// Same source, same precedence as prisma.config.ts: the root file fills in what
// the environment has not already set.
const ROOT_ENV_FILE = new URL("../../../.env", import.meta.url);
if (existsSync(ROOT_ENV_FILE)) process.loadEnvFile(ROOT_ENV_FILE);

const env = process.env;
const development = env["NODE_ENV"] === "development";

const PROBE_TABLE = "app.privilege_probe";
const PROBE_SEQUENCE = "app.privilege_probe_sequence";
const PROBE_FUNCTION = "app.privilege_probe_function";

function connectionString(explicitVariable, role, passwordVariable) {
  const explicit = env[explicitVariable];
  if (explicit !== undefined && explicit !== "") return explicit;
  if (!development) {
    throw new Error(
      `${explicitVariable} is required outside development; there is no localhost fallback`,
    );
  }
  const host = env["POSTGRES_HOST"] || defaults.host;
  const port = env["POSTGRES_PORT"] || defaults.port;
  const database = env["POSTGRES_DB"] || defaults.database;
  const password = env[passwordVariable] || defaults.roles[role];
  return `postgresql://${encodeURIComponent(role)}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
}

const URIS = {
  migration_owner: connectionString(
    "MIGRATION_DATABASE_URL",
    "migration_owner",
    "MIGRATION_OWNER_PASSWORD",
  ),
  app_api: connectionString("APP_API_DATABASE_URL", "app_api", "APP_API_PASSWORD"),
  app_system: connectionString("APP_SYSTEM_DATABASE_URL", "app_system", "APP_SYSTEM_PASSWORD"),
};

let failures = 0;

function check(label, passed, detail) {
  if (passed) {
    console.log(`PASS  ${label}`);
    return;
  }
  failures += 1;
  console.log(`FAIL  ${label}${detail === undefined ? "" : ` — ${detail}`}`);
}

/** Denial is only a denial at 42501 (insufficient_privilege). */
async function denied(client, label, sql, parameters) {
  try {
    await client.query(sql, parameters);
    check(label, false, "query succeeded, expected insufficient_privilege");
  } catch (error) {
    check(label, error.code === "42501", `expected 42501, got ${error.code}: ${error.message}`);
  }
}

async function allowed(client, label, sql, parameters) {
  try {
    const result = await client.query(sql, parameters);
    check(label, true);
    return result;
  } catch (error) {
    check(label, false, `expected success, got ${error.code}: ${error.message}`);
    return undefined;
  }
}

const owner = new Client({ connectionString: URIS.migration_owner });
const api = new Client({ connectionString: URIS.app_api });
const system = new Client({ connectionString: URIS.app_system });

try {
  await Promise.all([owner.connect(), api.connect(), system.connect()]);

  // Identity first. A denial coming from the wrong role proves nothing at all.
  for (const [role, client] of [
    ["migration_owner", owner],
    ["app_api", api],
    ["app_system", system],
  ]) {
    const { rows } = await client.query("select current_user as who");
    check(`connected as ${role}`, rows[0].who === role, `server reported ${rows[0].who}`);
  }

  // ---------------------------------------------------------------- attributes
  const { rows: roles } = await owner.query(
    "select rolname, rolsuper, rolcanlogin, rolbypassrls, rolcreatedb, rolcreaterole from pg_roles where rolname = any($1)",
    [["migration_owner", "app_api", "app_system"]],
  );
  const attribute = (name) => roles.find((role) => role.rolname === name);

  check("migration_owner exists", attribute("migration_owner") !== undefined);
  check("app_api exists", attribute("app_api") !== undefined);
  check("app_system exists", attribute("app_system") !== undefined);

  for (const name of ["migration_owner", "app_api", "app_system"]) {
    const role = attribute(name);
    if (role === undefined) continue;
    check(`${name} is not a superuser`, role.rolsuper === false);
    check(`${name} cannot create databases`, role.rolcreatedb === false);
    check(`${name} cannot create roles`, role.rolcreaterole === false);
    check(`${name} can log in`, role.rolcanlogin === true);
  }
  check("app_api lacks BYPASSRLS", attribute("app_api")?.rolbypassrls === false);
  check("app_system has BYPASSRLS", attribute("app_system")?.rolbypassrls === true);

  // ---------------------------------------------------------------- membership
  const { rows: memberships } = await owner.query(
    `select r.rolname as member, g.rolname as granted
       from pg_auth_members m
       join pg_roles r on r.oid = m.member
       join pg_roles g on g.oid = m.roleid
      where r.rolname = any($1) or g.rolname = any($1)`,
    [["migration_owner", "app_api", "app_system"]],
  );
  check(
    "no role memberships involving the three roles",
    memberships.length === 0,
    JSON.stringify(memberships),
  );

  // ------------------------------------------------------------------- schema
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

  // ------------------------------------------------- default privileges declared
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

  // ---------------------------------------- probe objects, created after grants
  // Deliberately unprivileged: nothing is granted to either runtime role, and
  // these objects are created after default privileges were configured, so any
  // access would have to come from a default that grants too much.
  await owner.query(`drop table if exists ${PROBE_TABLE}`);
  await owner.query(`drop sequence if exists ${PROBE_SEQUENCE}`);
  await owner.query(`drop function if exists ${PROBE_FUNCTION}()`);
  await owner.query(`create table ${PROBE_TABLE} (id integer primary key, secret text)`);
  await owner.query(`create sequence ${PROBE_SEQUENCE}`);
  await owner.query(
    `create function ${PROBE_FUNCTION}() returns integer language sql as 'select 1'`,
  );
  await owner.query(`insert into ${PROBE_TABLE} values (1, 'classified')`);

  const { rows: probeOwner } = await owner.query(
    `select pg_get_userbyid(relowner) as owner_name from pg_class where oid = $1::regclass`,
    [PROBE_TABLE],
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
      [role, PROBE_TABLE],
    );
    const row = rows[0];
    check(
      `${role} holds no probe table privilege`,
      !row.can_select && !row.can_insert && !row.can_update && !row.can_delete,
      JSON.stringify(row),
    );
  }

  // ------------------------------------------------------------- app_api: deny
  await denied(api, "app_api cannot SELECT an ungranted table", `select * from ${PROBE_TABLE}`);
  await denied(
    api,
    "app_api cannot INSERT into an ungranted table",
    `insert into ${PROBE_TABLE} values (2, 'x')`,
  );
  await denied(
    api,
    "app_api cannot UPDATE an ungranted table",
    `update ${PROBE_TABLE} set secret = 'x'`,
  );
  await denied(api, "app_api cannot DELETE from an ungranted table", `delete from ${PROBE_TABLE}`);
  await denied(
    api,
    "app_api cannot create a table in app",
    "create table app.should_not_exist (id int)",
  );
  await denied(
    api,
    "app_api cannot alter an application table",
    `alter table ${PROBE_TABLE} add column extra text`,
  );
  await denied(api, "app_api cannot drop an application table", `drop table ${PROBE_TABLE}`);
  await denied(
    api,
    "app_api cannot use an ungranted sequence",
    `select nextval('${PROBE_SEQUENCE}')`,
  );
  await denied(api, "app_api cannot set role to migration_owner", "set role migration_owner");
  await denied(api, "app_api cannot create a schema", "create schema not_allowed");
  await denied(
    api,
    "app_api cannot write the migration ledger",
    "delete from app._prisma_migrations",
  );
  await denied(api, "app_api cannot execute an ungranted function", `select ${PROBE_FUNCTION}()`);
  await allowed(api, "app_api can read the catalogue", "select count(*) from pg_class");

  // ---------------------------------------------------------- app_system: deny
  await denied(
    system,
    "app_system cannot SELECT an ungranted table",
    `select * from ${PROBE_TABLE}`,
  );
  await denied(
    system,
    "app_system cannot INSERT into an ungranted table",
    `insert into ${PROBE_TABLE} values (3, 'x')`,
  );
  await denied(
    system,
    "app_system cannot UPDATE an ungranted table",
    `update ${PROBE_TABLE} set secret = 'x'`,
  );
  await denied(
    system,
    "app_system cannot DELETE from an ungranted table",
    `delete from ${PROBE_TABLE}`,
  );
  await denied(
    system,
    "app_system cannot create a table in app",
    "create table app.should_not_exist (id int)",
  );
  await denied(
    system,
    "app_system cannot alter an application table",
    `alter table ${PROBE_TABLE} add column extra text`,
  );
  await denied(system, "app_system cannot drop an application table", `drop table ${PROBE_TABLE}`);
  await denied(
    system,
    "app_system cannot use an ungranted sequence",
    `select nextval('${PROBE_SEQUENCE}')`,
  );
  await denied(system, "app_system cannot set role to migration_owner", "set role migration_owner");
  await denied(system, "app_system cannot set role to app_api", "set role app_api");
  await denied(
    system,
    "app_system cannot write the migration ledger",
    "delete from app._prisma_migrations",
  );
  await denied(
    system,
    "app_system cannot execute an ungranted function",
    `select ${PROBE_FUNCTION}()`,
  );

  // ------------------------------------------------------- column-level grants
  // Stands in for the future `SELECT geom FROM fields` / `SELECT body FROM
  // ai_briefings` denials: a role may be granted one column and still be unable
  // to read its neighbours.
  await owner.query(`grant select (id) on ${PROBE_TABLE} to app_system`);
  await allowed(system, "app_system can read the granted column", `select id from ${PROBE_TABLE}`);
  await denied(
    system,
    "app_system cannot read an ungranted column",
    `select secret from ${PROBE_TABLE}`,
  );
  await denied(system, "app_system cannot read the whole row", `select * from ${PROBE_TABLE}`);
  await owner.query(`revoke select (id) on ${PROBE_TABLE} from app_system`);
  await denied(system, "column grant removal takes effect", `select id from ${PROBE_TABLE}`);

  // --------------------------------------------------------------- ledger owner
  const { rows: ledger } = await owner.query(
    "select pg_get_userbyid(relowner) as owner_name from pg_class where oid = to_regclass('app._prisma_migrations')",
  );
  check(
    "migration ledger lives in app and is owned by migration_owner",
    ledger[0]?.owner_name === "migration_owner",
    ledger[0]?.owner_name,
  );
} finally {
  await owner.query(`drop table if exists ${PROBE_TABLE}`).catch(() => {});
  await owner.query(`drop sequence if exists ${PROBE_SEQUENCE}`).catch(() => {});
  await owner.query(`drop function if exists ${PROBE_FUNCTION}()`).catch(() => {});
  await Promise.all([
    owner.end().catch(() => {}),
    api.end().catch(() => {}),
    system.end().catch(() => {}),
  ]);
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log("\nall privilege checks passed");
}
