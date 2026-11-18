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

import {
  credentialVariables,
  development,
  env,
  roleConnectionString,
  ROLE_NAMES,
} from "./connections.mjs";

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

/**
 * Role attribute assertions, in one place because they are also asserted without
 * a cluster.
 *
 * The verifier's own run needs a live PostgreSQL, so an attribute assertion that
 * lived only inside it could not be tested at all — and an untested assertion is
 * one that can quietly stop running. `test/unit/privilege-verification.test.mjs`
 * drives these two functions with a recording `check`.
 */
export function checkRoleAttributes(check, name, role) {
  check(`${name} is not a superuser`, role.rolsuper === false);
  check(`${name} cannot create databases`, role.rolcreatedb === false);
  check(`${name} cannot create roles`, role.rolcreaterole === false);
  check(`${name} can log in`, role.rolcanlogin === true);
  check(`${name} does not inherit privileges`, role.rolinherit === false);
  check(`${name} cannot replicate`, role.rolreplication === false);
}

/**
 * The column grant on `app.users` is the whole authentication boundary (S4), so it
 * is asserted as an exact set rather than as a floor: a column added by accident is
 * a failure even though it still satisfies "these columns are readable".
 *
 * Takes what the catalogue reported so the same function can be driven by a unit
 * test; the verifier fills it from `has_column_privilege`.
 */
export function checkAuthUserColumnGrants(check, held) {
  const sameSet = (actual, expected) => {
    const sorted = [...new Set(actual)].sort();
    return (
      sorted.length === expected.length && sorted.every((name, index) => name === expected[index])
    );
  };

  const select = held.select_columns ?? [];
  const insert = held.insert_columns ?? [];
  const update = held.update_columns ?? [];

  check(
    "app_auth SELECTs exactly the six approved columns of app.users",
    sameSet(select, ["email", "id", "locale", "password_hash", "role", "timezone"]),
    JSON.stringify([...select].sort()),
  );
  check(
    "app_auth INSERTs exactly the two approved columns of app.users",
    sameSet(insert, ["email", "password_hash"]),
    JSON.stringify([...insert].sort()),
  );
  check(
    "app_auth holds UPDATE on no column of app.users",
    update.length === 0,
    JSON.stringify([...update].sort()),
  );
}

/**
 * The session table belongs to S5. Checking that it is absent is not a formality:
 * a table created early would make the later migration a no-op and leave the
 * sessions of this phase half-built.
 *
 * Unconditional on purpose. A check that only runs when the relation is missing
 * reports nothing in the one state that matters.
 */
export function checkSessionAbsence(check, oid) {
  const absent = oid === null;
  check(
    "app.sessions is absent before S5",
    absent,
    absent ? undefined : `app.sessions already exists as ${String(oid)}; S3 must not create it`,
  );
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
  const auth = clients["app_auth"];

  const probes = createProbes();
  const created = { table: false, sequence: false, fn: false };

  try {
    // Sequential, so a failure names the role whose credential is wrong instead of
    // the first rejection out of four. Neither the URL nor the password is ever
    // printed: only the PostgreSQL SQLSTATE.
    for (const [role, client] of Object.entries(clients)) {
      try {
        await client.connect();
      } catch (error) {
        const code = error?.code ?? "no SQLSTATE";
        const names = credentialVariables(role);
        throw new Error(
          `db:verify could not connect as ${role} (${code}). Set ${names.password} or ${names.url} ` +
            "for this environment. Values are never printed.",
        );
      }
    }

    // ---------------------------------------------------------------- identity
    // Before anything else. A denial coming from the wrong role proves nothing.
    for (const role of ROLE_NAMES) {
      const { rows } = await clients[role].query("select current_user as who");
      check(`connected as ${role}`, rows[0].who === role, `server reported ${rows[0].who}`);
    }

    // -------------------------------------------------------------- attributes
    const { rows: roles } = await owner.query(
      "select rolname, rolsuper, rolcanlogin, rolbypassrls, rolcreatedb, rolcreaterole, rolinherit, rolreplication from pg_roles where rolname = any($1)",
      [ROLE_NAMES],
    );
    const attribute = (name) => roles.find((role) => role.rolname === name);

    for (const name of ROLE_NAMES) check(`${name} exists`, attribute(name) !== undefined);
    for (const name of ROLE_NAMES) {
      const role = attribute(name);
      if (role === undefined) continue;
      checkRoleAttributes(check, name, role);
    }
    check("app_api lacks BYPASSRLS", attribute("app_api")?.rolbypassrls === false);
    check("app_system has BYPASSRLS", attribute("app_system")?.rolbypassrls === true);
    check("app_auth lacks BYPASSRLS", attribute("app_auth")?.rolbypassrls === false);

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
      "no role memberships involving the four roles",
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

    for (const role of ["app_api", "app_system", "app_auth"]) {
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

    // -------------------------- app_auth owns nothing, because it creates nothing
    // A role that owns an object bypasses every policy on it, so "no ownership" is
    // the property that keeps the credential boundary from depending on RLS.
    const { rows: authOwnership } = await owner.query(
      `select (select count(*)
                 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                where pg_get_userbyid(c.relowner) = 'app_auth')::integer as relations,
              (select count(*)
                 from pg_namespace where pg_get_userbyid(nspowner) = 'app_auth')::integer as schemas,
              (select count(*)
                 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where pg_get_userbyid(p.proowner) = 'app_auth')::integer as functions`,
    );
    check(
      "app_auth owns no relation, schema, or function",
      authOwnership[0].relations === 0 &&
        authOwnership[0].schemas === 0 &&
        authOwnership[0].functions === 0,
      JSON.stringify(authOwnership[0]),
    );

    // Same shape one level up, over every app table: S4 grants columns on `users`
    // but no table privilege anywhere, so the expected set is still empty.
    const { rows: authTablePrivileges } = await owner.query(
      `select coalesce(
                array_agg(c.relname || ':' || p.priv::text order by c.relname, p.priv::text),
                '{}'
              ) as held
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) as p(priv)
        where n.nspname = 'app'
          and c.relkind = 'r'
          and has_table_privilege('app_auth', c.oid, p.priv)`,
    );
    check(
      "app_auth holds no table privilege on any app table",
      authTablePrivileges[0].held.length === 0,
      JSON.stringify(authTablePrivileges[0].held),
    );

    // One aggregate rather than one assertion per column, over the tables S4 does
    // not touch. `users` is excluded here and asserted exactly below; an aggregate
    // that silently tolerated the six granted columns would prove nothing there.
    const { rows: authColumnPrivileges } = await owner.query(
      `select coalesce(
                array_agg(c.relname || '.' || a.attname || ':' || p.priv order by c.relname, a.attname),
                '{}'
              ) as held
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         join pg_attribute a on a.attrelid = c.oid
         cross join (values ('SELECT'), ('INSERT'), ('UPDATE')) as p(priv)
        where n.nspname = 'app'
          and c.relkind = 'r'
          and c.relname <> 'users'
          and a.attnum > 0
          and not a.attisdropped
          and has_column_privilege('app_auth', a.attrelid, a.attnum, p.priv)`,
    );
    check(
      "app_auth holds no column privilege on any app table other than users",
      authColumnPrivileges[0].held.length === 0,
      JSON.stringify(authColumnPrivileges[0].held),
    );

    // ------------------------------------- authentication boundary on app.users
    // S4 in one section: the grant as a set, the policies as text, and the
    // behaviour as a real login — because a column grant that has never carried a
    // query is a claim about the catalogue, not about the credential.
    const { rows: usersRelation } = await owner.query("select to_regclass('app.users') as oid");
    check("app.users exists", usersRelation[0].oid !== null);

    // `attname` is `name`, and `coalesce(name[], '{}')` resolves the unknown
    // literal to text — the driver then hands back the array's text form. Casting
    // the aggregate keeps a genuine `text[]` in the result.
    const { rows: authUserColumns } = await owner.query(
      `select coalesce(array_agg(distinct a.attname::text)
                         filter (where has_column_privilege('app_auth', a.attrelid, a.attnum, 'SELECT')),
                       '{}'::text[]) as select_columns,
              coalesce(array_agg(distinct a.attname::text)
                         filter (where has_column_privilege('app_auth', a.attrelid, a.attnum, 'INSERT')),
                       '{}'::text[]) as insert_columns,
              coalesce(array_agg(distinct a.attname::text)
                         filter (where has_column_privilege('app_auth', a.attrelid, a.attnum, 'UPDATE')),
                       '{}'::text[]) as update_columns
         from pg_attribute a
        where a.attrelid = 'app.users'::regclass
          and a.attnum > 0
          and not a.attisdropped`,
    );
    checkAuthUserColumnGrants(check, authUserColumns[0]);

    const { rows: authUserTablePrivileges } = await owner.query(
      `select coalesce(array_agg(p.priv::text order by p.priv::text), '{}') as held
         from (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) as p(priv)
        where has_table_privilege('app_auth', 'app.users', p.priv)`,
    );
    check(
      "app_auth holds no table-level privilege on app.users",
      authUserTablePrivileges[0].held.length === 0,
      JSON.stringify(authUserTablePrivileges[0].held),
    );

    // The neighbours must not have gained anything from the new role's arrival.
    // `has_table_privilege` and `has_column_privilege` are both consulted: a
    // column grant to app_api would be invisible to the first.
    for (const role of ["app_api", "app_system"]) {
      const { rows } = await owner.query(
        `select coalesce(array_agg(p.priv::text order by p.priv::text), '{}') as table_privs,
                (select count(*)::integer
                   from pg_attribute a
                  where a.attrelid = 'app.users'::regclass
                    and a.attnum > 0
                    and not a.attisdropped
                    and (has_column_privilege($1, a.attrelid, a.attnum, 'SELECT')
                      or has_column_privilege($1, a.attrelid, a.attnum, 'INSERT')
                      or has_column_privilege($1, a.attrelid, a.attnum, 'UPDATE'))) as column_privs
           from (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) as p(priv)
          where has_table_privilege($1, 'app.users', p.priv)`,
        [role],
      );
      check(
        `${role} holds no privilege on app.users`,
        rows[0].table_privs.length === 0 && rows[0].column_privs === 0,
        JSON.stringify(rows[0]),
      );
    }

    const { rows: usersRls } = await owner.query(
      `select c.relrowsecurity as rls,
              c.relforcerowsecurity as force_rls,
              pg_get_userbyid(c.relowner) as owner_name
         from pg_class c
        where c.oid = 'app.users'::regclass`,
    );
    check("app.users keeps ENABLE ROW LEVEL SECURITY", usersRls[0]?.rls === true);
    check("app.users keeps FORCE ROW LEVEL SECURITY", usersRls[0]?.force_rls === true);
    check(
      "app.users is owned by migration_owner",
      usersRls[0]?.owner_name === "migration_owner",
      usersRls[0]?.owner_name,
    );

    const { rows: userPolicies } = await owner.query(
      `select policyname, cmd, roles::text as roles, qual, with_check
         from pg_policies
        where schemaname = 'app' and tablename = 'users'`,
    );
    const userPolicy = (name) => userPolicies.find((policy) => policy.policyname === name);

    check(
      "users_auth_lookup is FOR SELECT TO app_auth USING (true)",
      userPolicy("users_auth_lookup")?.cmd === "SELECT" &&
        userPolicy("users_auth_lookup")?.roles === "{app_auth}" &&
        userPolicy("users_auth_lookup")?.qual === "true",
      JSON.stringify(userPolicy("users_auth_lookup") ?? null),
    );
    check(
      "users_auth_register is FOR INSERT TO app_auth WITH CHECK (true)",
      userPolicy("users_auth_register")?.cmd === "INSERT" &&
        userPolicy("users_auth_register")?.roles === "{app_auth}" &&
        userPolicy("users_auth_register")?.with_check === "true",
      JSON.stringify(userPolicy("users_auth_register") ?? null),
    );
    // S4 adds two policies and rewrites none. The tenant policy is quoted here
    // because a rewrite would look like a working login and a broken isolation.
    check(
      "users_self_only is still FOR ALL TO app_api keyed on app.user_id",
      userPolicy("users_self_only")?.cmd === "ALL" &&
        userPolicy("users_self_only")?.roles === "{app_api}" &&
        userPolicy("users_self_only")?.qual?.includes("app.user_id") === true &&
        userPolicy("users_self_only")?.with_check?.includes("app.user_id") === true,
      JSON.stringify(userPolicy("users_self_only") ?? null),
    );
    check(
      "users_owner_full_access is still FOR ALL TO migration_owner",
      userPolicy("users_owner_full_access")?.cmd === "ALL" &&
        userPolicy("users_owner_full_access")?.roles === "{migration_owner}",
      JSON.stringify(userPolicy("users_owner_full_access") ?? null),
    );
    check(
      "no authentication policy is FOR ALL, and none names PUBLIC",
      !userPolicies.some(
        (policy) =>
          policy.roles === "{public}" || (policy.roles === "{app_auth}" && policy.cmd === "ALL"),
      ),
      JSON.stringify(
        userPolicies.map((policy) => `${policy.policyname}:${policy.cmd}:${policy.roles}`),
      ),
    );

    // Behavioural half. The row is inserted by app_auth — which is the
    // registration probe — and removed by migration_owner, because app_auth has
    // no DELETE. A row of its own is the only way to prove the lookup works with
    // no `app.user_id` set.
    const authEmail = `auth_probe_${probes.token}@verify.invalid`;
    try {
      const { rows: registered } = await auth.query(
        "insert into app.users (email, password_hash) values ($1, $2) returning id",
        [authEmail, "verification-probe-not-a-hash"],
      );
      check(
        "app_auth can INSERT a user and read the generated columns back",
        typeof registered[0]?.id === "string" && registered[0].id.length === 36,
        JSON.stringify(registered[0] ?? null),
      );

      const { rows: lookup } = await auth.query(
        `select id, email, password_hash, role, locale, timezone
           from app.users where email = $1`,
        [authEmail],
      );
      check(
        "app_auth can SELECT the six granted columns with no app.user_id set",
        lookup.length === 1 &&
          lookup[0].email === authEmail &&
          lookup[0].role === "owner" &&
          lookup[0].locale === "id" &&
          lookup[0].timezone === "Asia/Jakarta",
        JSON.stringify(lookup[0] ?? null),
      );

      // Defaults are the reason `role`/`locale`/`timezone` need no INSERT grant:
      // the database owns them, and the row above proves it.
      await denied(
        auth,
        "app_auth cannot SELECT app.users.created_at",
        "select created_at from app.users",
      );
      await denied(
        auth,
        "app_auth cannot SELECT app.users.updated_at",
        "select updated_at from app.users",
      );
      await denied(
        auth,
        "app_auth cannot SELECT every column of app.users",
        "select * from app.users",
      );
      // One probe per ungranted column, with a value of the column's own type: an
      // ill-typed parameter would fail 22P02 during bind, and a check that cannot
      // tell a type error from a denial proves nothing.
      const unapprovedInsertValues = {
        id: "00000000-0000-7000-8000-000000000000",
        role: "admin",
        locale: "id",
        timezone: "Asia/Jakarta",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      };
      for (const [column, value] of Object.entries(unapprovedInsertValues)) {
        await denied(
          auth,
          `app_auth cannot INSERT app.users.${column}`,
          `insert into app.users (email, password_hash, ${column}) values ($1, $2, $3)`,
          [`auth_probe_rejected_${column}_${probes.token}@verify.invalid`, "x", value],
        );
      }
      await denied(auth, "app_auth cannot UPDATE app.users", "update app.users set locale = 'en'");
      await denied(auth, "app_auth cannot DELETE from app.users", "delete from app.users");
    } finally {
      // Cleanup cannot be a denial: it runs as the owner, through its own policy.
      await owner
        .query("delete from app.users where email = $1", [authEmail])
        .catch(() => undefined);
    }

    // S3 and S4 do not create the session table; asserting its absence here keeps a
    // `42P01` from ever being recorded as a privilege denial. When S5 lands, S6 owns
    // the session assertions and this check simply stops applying.
    const { rows: sessionsRelation } = await owner.query(
      "select to_regclass('app.sessions') as oid",
    );
    checkSessionAbsence(check, sessionsRelation[0].oid);

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
    // bootstrap is a cluster-admin action, so this check needs that credential.
    //
    // A missing credential is a failure, not a skip: a verification run that
    // silently omits idempotency still reports success, and the operator reads
    // that as "the bootstrap normalises grants". `reBootstrap: false` remains the
    // only way to opt out, and it is reserved for the probe-isolation test, which
    // cannot re-run a bootstrap concurrently with itself.
    const canRebootstrap = development || (env["BOOTSTRAP_DATABASE_URL"] ?? "") !== "";
    if (!reBootstrap) {
      skip(
        "bootstrap removes a direct CREATE grant on app",
        "re-bootstrap disabled for this run; concurrent bootstraps would contend on the same roles",
      );
    } else if (!canRebootstrap) {
      check(
        "bootstrap removes a direct CREATE grant on app",
        false,
        "BOOTSTRAP_DATABASE_URL is unset and NODE_ENV is not development; set the cluster-admin " +
          "credential, or the bootstrap idempotency assertion cannot be made",
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

    for (const role of ["app_api", "app_system", "app_auth"]) {
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

    // ---------------------------------------------------------- app_auth: deny
    // This credential is the one ADR-004 says must not be trusted as a second
    // boundary. Its bounds are asserted behaviourally rather than inferred from
    // a narrow ACL: the probe table exists, so a denial here is 42501 and not a
    // missing relation. Its one granted table — `app.users` — is exercised in the
    // authentication-boundary section above, which also proves the column limits.
    await denied(
      auth,
      "app_auth cannot SELECT an ungranted table",
      `select * from ${child(probes.table)}`,
    );
    await denied(
      auth,
      "app_auth cannot INSERT into an ungranted table",
      `insert into ${child(probes.table)} values (4, 'x')`,
    );
    await denied(
      auth,
      "app_auth cannot create a table in app",
      "create table app.should_not_exist (id int)",
    );
    await denied(
      auth,
      "app_auth cannot write the migration ledger",
      "delete from app._prisma_migrations",
    );
    await denied(
      auth,
      "app_auth cannot execute an ungranted function",
      `select ${child(probes.fn)}()`,
    );
    for (const target of ["migration_owner", "app_api", "app_system"]) {
      await denied(auth, `app_auth cannot set role to ${target}`, `set role ${target}`);
    }
    await allowed(auth, "app_auth can resolve names in app", "select to_regclass('app.users')");

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
    // tenant context exists and runs as `app_auth`, not as the request credential.
    // INSERT is asserted separately because a table-wide SELECT denial says nothing
    // about the write path, and a column grant is invisible to both.
    await denied(api, "app_api holds no grant on app.users", "select * from app.users");
    await denied(
      api,
      "app_api cannot insert into app.users",
      "insert into app.users (email, password_hash) values ('api_probe@verify.invalid', 'x')",
    );
    await denied(system, "app_system cannot select from app.users", "select * from app.users");
    await denied(
      system,
      "app_system cannot insert into app.users",
      "insert into app.users (email, password_hash) values ('system_probe@verify.invalid', 'x')",
    );
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
