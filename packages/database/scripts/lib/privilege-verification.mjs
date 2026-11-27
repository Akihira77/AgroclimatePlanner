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
  "climatology_baselines",
];

/**
 * Tables the request path must not read. `app.jobs` is the queue: user-facing
 * ingestion state is read from `app.ingestion_runs`, which `app_api` already
 * holds SELECT on. Kept out of `GLOBAL_TABLES` on purpose — that list drives a
 * `{ app_api: R, app_system: RW }` expectation, and inheriting it would grant a
 * privilege nobody asked for.
 */
export const SYSTEM_ONLY_TABLES = ["jobs"];

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

/** Set equality on a column-name list, shared by the exact grant inventories. */
function sameSet(actual, expected) {
  const sorted = [...new Set(actual)].sort();
  const wanted = [...new Set(expected)].sort();
  return sorted.length === wanted.length && sorted.every((name, index) => name === wanted[index]);
}

/**
 * `pg_policies.roles` arrives as `name[]`, but a driver or an older query may hand
 * back its text form. A plain `roles === "{public}"` test misses
 * `{app_auth,public}`, so the array is normalised before every comparison.
 */
function policyRoles(policy) {
  const roles = policy?.roles;
  if (Array.isArray(roles)) return roles.map(String);
  if (typeof roles === "string") {
    return roles
      .replace(/^\{|\}$/g, "")
      .split(",")
      .map((role) => role.trim().replace(/^"|"$/g, ""))
      .filter(Boolean);
  }
  return [];
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
 * The tenant predicate, in the form `pg_policies` returns it on PostgreSQL 18.6.
 * Quoted from `20261118020000_tenant_tables/migration.sql` and normalised by the
 * catalogue — `current_setting('app.user_id', true)` acquires its casts once it is
 * stored as an expression. Comparing against the migration text would fail on
 * whitespace that PostgreSQL never preserves.
 */
const TENANT_SELF_PREDICATE =
  "(id = (NULLIF(current_setting('app.user_id'::text, true), ''::text))::uuid)";

/**
 * The complete policy inventory of `app.users`, not just the two S4 adds.
 *
 * A policy is four independent properties — command, roles, `USING`, `WITH CHECK` —
 * and three of them can be widened without any name changing. Asserting the names
 * would have passed a `users_self_only` rewritten to `USING (true)`, which is the
 * single most dangerous edit that table allows.
 *
 * Roles arrive from `pg_policies.roles` as `name[]`; a plain `roles === "{public}"`
 * test misses `{app_auth,public}`, so the check parses the array.
 */
export function checkUsersPolicyInventory(check, policies) {
  const expected = [
    {
      name: "users_auth_lookup",
      cmd: "SELECT",
      roles: ["app_auth"],
      qual: "true",
      withCheck: null,
    },
    {
      name: "users_auth_register",
      cmd: "INSERT",
      roles: ["app_auth"],
      qual: null,
      withCheck: "true",
    },
    {
      name: "users_owner_full_access",
      cmd: "ALL",
      roles: ["migration_owner"],
      qual: "true",
      withCheck: "true",
    },
    {
      name: "users_self_only",
      cmd: "ALL",
      roles: ["app_api"],
      qual: TENANT_SELF_PREDICATE,
      withCheck: TENANT_SELF_PREDICATE,
    },
  ];

  const actual = Array.isArray(policies) ? policies : [];
  const actualNames = actual.map((policy) => policy.policyname).sort();
  const expectedNames = expected.map((policy) => policy.name).sort();

  check(
    "app.users carries exactly the four expected policies",
    actualNames.length === expectedNames.length &&
      actualNames.every((name, index) => name === expectedNames[index]),
    JSON.stringify(actualNames),
  );

  for (const wanted of expected) {
    const found = actual.find((policy) => policy.policyname === wanted.name);
    const roles = policyRoles(found).sort();
    const wantedRoles = [...wanted.roles].sort();

    check(
      `${wanted.name} has its recorded command, roles, USING and WITH CHECK`,
      found !== undefined &&
        found.cmd === wanted.cmd &&
        found.permissive === "PERMISSIVE" &&
        roles.length === wantedRoles.length &&
        roles.every((role, index) => role === wantedRoles[index]) &&
        (found.qual ?? null) === wanted.qual &&
        (found.with_check ?? null) === wanted.withCheck,
      JSON.stringify(found ?? null),
    );
  }

  // `PUBLIC` is a role name like any other to the catalogue; a policy naming it
  // applies to every role that has the command, which would make the column grant
  // the only thing left. Both spellings occur depending on who wrote the SQL.
  check(
    "no policy on app.users names PUBLIC",
    !actual.some((policy) => policyRoles(policy).some((role) => role.toLowerCase() === "public")),
    JSON.stringify(actual.map((policy) => `${policy.policyname}:${policyRoles(policy).join(",")}`)),
  );

  check(
    "app_auth holds no FOR ALL policy on app.users",
    !actual.some((policy) => policy.cmd === "ALL" && policyRoles(policy).includes("app_auth")),
    JSON.stringify(actual.filter((policy) => policy.cmd === "ALL").map((p) => p.policyname)),
  );
}

/**
 * `pg_get_constraintdef` returns a decompiled reconstruction, not the source
 * text: `INTERVAL '90 days'` comes back as `'90 days'::interval` and the
 * expression gains parentheses. Comparing the catalogue's text against the
 * migration's text therefore requires discarding the things PostgreSQL is free
 * to rewrite — casts, quotes, the `INTERVAL` keyword, parentheses, whitespace —
 * and keeping everything that carries meaning. A weakened predicate (`<=` to
 * `<`, `90` to `99`, `AND` to `OR`) survives this normalisation and still fails.
 */
function normaliseConstraint(definition) {
  return String(definition)
    .toLowerCase()
    .replace(/::[a-z_ ]+/g, "")
    .replace(/\binterval\b/g, "")
    .replace(/[()'"]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The three predicates `D-1`, `D-2` and the expiry ordering require. */
const EXPECTED_SESSION_CHECKS = [
  "CHECK (absolute_expires_at >= expires_at AND expires_at > created_at)",
  "CHECK (token_hash ~ '^[0-9a-f]{64}$')",
  "CHECK (absolute_expires_at <= created_at + INTERVAL '90 days')",
  "CHECK (csrf_token IS NULL OR csrf_token ~ '^[A-Za-z0-9_-]{43}$')",
];

/**
 * The session table is S5's, and with S5 applied it is required state.
 *
 * Four separate assertions rather than one: a relation that exists in the wrong
 * schema, or as a view that shadows the name, satisfies "something answers to
 * that name" while the migration it was supposed to prove never ran.
 */
export function checkSessionTable(check, relation) {
  const found = relation ?? null;
  check("app.sessions exists", found !== null, found === null ? "relation not found" : undefined);
  check("app.sessions lives in schema app", found?.nspname === "app", found?.nspname);
  check("app.sessions is named sessions", found?.relname === "sessions", found?.relname);
  check("app.sessions is an ordinary table (relkind r)", found?.relkind === "r", found?.relkind);
}

/**
 * Every constraint on the table, compared as an inventory rather than by name.
 *
 * A name survives a rewrite: `sessions_absolute_expiry_cap_check` still exists
 * after its predicate is relaxed to `99 days`. The definition is what the
 * planner enforces, so that is what is asserted — and the count is asserted
 * too, so an extra constraint cannot hide behind three expected ones.
 *
 * `NOT NULL` arrives separately: PostgreSQL 18 catalogues it as `contype = 'n'`,
 * which is not part of this inventory.
 */
export function checkSessionConstraints(check, constraints) {
  const rows = Array.isArray(constraints) ? constraints : [];
  const of = (kind) => rows.filter((row) => row.contype === kind);

  check(
    "app.sessions carries no constraint kind beyond key, unique, check and foreign key",
    rows.every((row) => ["p", "u", "c", "f"].includes(row.contype)),
    JSON.stringify(rows.map((row) => row.contype)),
  );

  const primary = of("p");
  check(
    "app.sessions has exactly one primary key, on id",
    primary.length === 1 &&
      normaliseConstraint(primary[0].definition) === normaliseConstraint("PRIMARY KEY (id)"),
    JSON.stringify(primary.map((row) => row.definition)),
  );

  const unique = of("u");
  check(
    "app.sessions has exactly one unique constraint, on token_hash",
    unique.length === 1 &&
      unique[0].conname === "sessions_token_hash_key" &&
      normaliseConstraint(unique[0].definition) === normaliseConstraint("UNIQUE (token_hash)"),
    JSON.stringify(unique.map((row) => `${row.conname}:${row.definition}`)),
  );

  const checks = of("c").map((row) => normaliseConstraint(row.definition));
  const expected = EXPECTED_SESSION_CHECKS.map(normaliseConstraint).sort();
  const actual = [...checks].sort();
  check(
    "app.sessions enforces exactly the four approved CHECK constraints",
    actual.length === expected.length &&
      actual.every((definition, index) => definition === expected[index]),
    JSON.stringify(actual),
  );

  const foreignKeys = of("f");
  check(
    "app.sessions has exactly one foreign key, from user_id to app.users",
    foreignKeys.length === 1 &&
      normaliseConstraint(foreignKeys[0].definition) ===
        normaliseConstraint("FOREIGN KEY (user_id) REFERENCES app.users(id)"),
    JSON.stringify(foreignKeys.map((row) => row.definition)),
  );
  check(
    "the session foreign key keeps PostgreSQL's default NO ACTION",
    foreignKeys.length === 1 && foreignKeys[0].confdeltype === "a",
    foreignKeys[0]?.confdeltype,
  );
}

/**
 * The index inventory, exact. `sessions_pkey` and `sessions_token_hash_key` are
 * the primary key's and the unique constraint's backing indexes; only the other
 * two are `D-3`. Counting "two indexes" would be wrong, and dropping the unique
 * constraint to make a count pass would be a decision violation.
 */
export function checkSessionIndexes(check, indexes) {
  const rows = Array.isArray(indexes) ? indexes : [];
  const expected = [
    { name: "sessions_pkey", column: "id", unique: true },
    { name: "sessions_token_hash_key", column: "token_hash", unique: true },
    { name: "sessions_user_id_idx", column: "user_id", unique: false },
    { name: "sessions_absolute_expires_at_idx", column: "absolute_expires_at", unique: false },
  ];

  const actual = rows.map((row) => row.name).sort();
  const wanted = expected.map((row) => row.name).sort();
  check(
    "app.sessions carries exactly the four expected indexes",
    actual.length === wanted.length && actual.every((name, index) => name === wanted[index]),
    JSON.stringify(actual),
  );

  for (const index of expected) {
    const found = rows.find((row) => row.name === index.name);
    check(
      `${index.name} covers ${index.column}${index.unique ? " and is unique" : ""}`,
      found !== undefined && found.column === index.column && found.unique === index.unique,
      JSON.stringify(found ?? null),
    );
  }
}

/**
 * Both session policies, as four properties each.
 *
 * `USING (true)` is the recorded design, not a placeholder: authentication runs
 * before `app.user_id` exists, so a predicate here would match nothing at the
 * moment it is needed. That also means a policy that *gains* a predicate is a
 * failure worth reporting, and the last check states the rule directly rather
 * than inferring it from `qual === "true"`.
 */
export function checkSessionPolicyInventory(check, policies) {
  const expected = [
    {
      name: "sessions_auth_all",
      cmd: "ALL",
      roles: ["app_auth"],
      qual: "true",
      withCheck: "true",
    },
    {
      name: "sessions_owner_full_access",
      cmd: "ALL",
      roles: ["migration_owner"],
      qual: "true",
      withCheck: "true",
    },
  ];

  const actual = Array.isArray(policies) ? policies : [];
  const actualNames = actual.map((policy) => policy.policyname).sort();
  const expectedNames = expected.map((policy) => policy.name).sort();

  check(
    "app.sessions carries exactly the two expected policies",
    actualNames.length === expectedNames.length &&
      actualNames.every((name, index) => name === expectedNames[index]),
    JSON.stringify(actualNames),
  );

  for (const wanted of expected) {
    const found = actual.find((policy) => policy.policyname === wanted.name);
    const roles = policyRoles(found).sort();
    const wantedRoles = [...wanted.roles].sort();

    check(
      `${wanted.name} has its recorded command, roles, USING and WITH CHECK`,
      found !== undefined &&
        found.cmd === wanted.cmd &&
        found.permissive === "PERMISSIVE" &&
        roles.length === wantedRoles.length &&
        roles.every((role, index) => role === wantedRoles[index]) &&
        (found.qual ?? null) === wanted.qual &&
        (found.with_check ?? null) === wanted.withCheck,
      JSON.stringify(found ?? null),
    );
  }

  check(
    "no policy on app.sessions names PUBLIC",
    !actual.some((policy) => policyRoles(policy).some((role) => role.toLowerCase() === "public")),
    JSON.stringify(actual.map((policy) => `${policy.policyname}:${policyRoles(policy).join(",")}`)),
  );

  check(
    "no policy on app.sessions filters on the tenant GUC",
    !actual.some((policy) =>
      /current_setting/.test(`${policy.qual ?? ""}${policy.with_check ?? ""}`),
    ),
    JSON.stringify(actual.map((policy) => policy.policyname)),
  );
}

/**
 * The three column grants, as exact sets. `created_at` and `absolute_expires_at`
 * are the point: both are readable, neither is writable, so the 90-day cap
 * cannot be moved by the credential that holds the session.
 */
export function checkSessionColumnGrants(check, held) {
  const select = held?.select_columns ?? [];
  const insert = held?.insert_columns ?? [];
  const update = held?.update_columns ?? [];

  check(
    "app_auth SELECTs exactly the nine approved columns of app.sessions",
    sameSet(select, [
      "id",
      "user_id",
      "token_hash",
      "expires_at",
      "absolute_expires_at",
      "revoked_at",
      "last_seen_at",
      "created_at",
      "csrf_token",
    ]),
    JSON.stringify([...select].sort()),
  );
  check(
    "app_auth INSERTs exactly the four approved columns of app.sessions",
    sameSet(insert, ["user_id", "token_hash", "expires_at", "absolute_expires_at"]),
    JSON.stringify([...insert].sort()),
  );
  check(
    "app_auth UPDATEs exactly the four approved columns of app.sessions",
    sameSet(update, ["expires_at", "last_seen_at", "revoked_at", "csrf_token"]),
    JSON.stringify([...update].sort()),
  );
}

/**
 * The collection function's contract. Its security is the combination, not any
 * single flag: a definer right without the pinned `search_path` is a hijack, a
 * pinned path without the definer right cannot delete, and an `EXECUTE` grant to
 * `PUBLIC` makes both irrelevant.
 */
export function checkSessionFunction(check, fn) {
  const found = fn ?? null;
  check(
    "app.purge_expired_sessions() exists",
    found !== null,
    found === null ? "function not found" : undefined,
  );
  check("app.purge_expired_sessions() is SECURITY DEFINER", found?.prosecdef === true);
  check(
    "app.purge_expired_sessions() takes no arguments and returns integer",
    found?.pronargs === 0 && found?.prorettype === "integer",
    JSON.stringify({ pronargs: found?.pronargs, prorettype: found?.prorettype }),
  );
  check(
    "app.purge_expired_sessions() pins search_path to pg_catalog, app",
    Array.isArray(found?.proconfig) &&
      found.proconfig.length === 1 &&
      /^search_path=pg_catalog,\s*app$/.test(found.proconfig[0]),
    JSON.stringify(found?.proconfig ?? null),
  );
  check(
    "app.purge_expired_sessions() is owned by migration_owner",
    found?.owner_name === "migration_owner",
    found?.owner_name,
  );

  const acl = Array.isArray(found?.acl) ? found.acl : [];
  const grantees = acl.map((entry) => entry.grantee).sort();
  check(
    "app.purge_expired_sessions() grants EXECUTE to migration_owner and app_system only",
    grantees.length === 2 &&
      grantees[0] === "app_system" &&
      grantees[1] === "migration_owner" &&
      acl.every((entry) => entry.privilege === "EXECUTE" && entry.grantable === false),
    JSON.stringify(acl),
  );
  check(
    "PUBLIC holds no EXECUTE on app.purge_expired_sessions()",
    !acl.some((entry) => entry.grantee === null || entry.grantee === "PUBLIC"),
    JSON.stringify(grantees),
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

  /**
   * An expected error at a named SQLSTATE. Used where the statement is supposed to
   * fail for a reason other than permission — a foreign key still in use must fail
   * `23503`, and a probe that passed because it hit `42501` instead would prove the
   * wrong thing about the wrong constraint.
   */
  const expectCode = async (client, label, code, sql, parameters) => {
    try {
      await client.query(sql, parameters);
      check(label, false, `query succeeded, expected ${code}`);
    } catch (error) {
      check(label, error.code === code, `expected ${code}, got ${error.code}: ${error.message}`);
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
    // not touch. `users` (S4) and `sessions` (S5) are excluded here and asserted
    // exactly below; an aggregate that silently tolerated their granted columns
    // would prove nothing there.
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
          and c.relname not in ('users', 'sessions')
          and a.attnum > 0
          and not a.attisdropped
          and has_column_privilege('app_auth', a.attrelid, a.attnum, p.priv)`,
    );
    check(
      "app_auth holds no column privilege on any app table other than users and sessions",
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

    // The full policy contract, not four name lookups: the catalogue query and the
    // comparison are separated so the comparison can be unit-tested without a
    // database, and so a policy that was rewritten rather than removed cannot pass.
    const { rows: userPolicies } = await owner.query(
      `select policyname, cmd, permissive, roles::text[] as roles, qual, with_check
         from pg_policies
        where schemaname = 'app' and tablename = 'users'`,
    );
    checkUsersPolicyInventory(check, userPolicies);

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

    // ---------------------------------------- S5 — session storage (ADR-005)
    // The table is required state now. A missing relation is reported as a failure
    // per group rather than as a `42P01` mid-run, so the report still says what is
    // absent instead of stopping at the first statement that needed it.
    const { rows: sessionsRelation } = await owner.query(
      `select c.oid::text as oid, c.relname, n.nspname, c.relkind::text as relkind
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.oid = to_regclass('app.sessions')`,
    );
    const sessionsPresent = sessionsRelation.length === 1;
    checkSessionTable(check, sessionsRelation[0] ?? null);

    if (!sessionsPresent) {
      for (const group of [
        "column inventory and owner",
        "constraint inventory",
        "index inventory",
        "row-level security and policies",
        "column grants",
        "collection function",
        "behavioural probes",
      ]) {
        check(`app.sessions ${group}`, false, "app.sessions does not exist");
      }
    }

    if (sessionsPresent) {
      // Columns, types, nullability and defaults, in `attnum` order: a column that
      // moved or changed type is a different schema even under the same name.
      const { rows: sessionColumns } = await owner.query(
        `select a.attname::text as name,
                format_type(a.atttypid, a.atttypmod) as type,
                a.attnotnull as not_null,
                pg_get_expr(d.adbin, d.adrelid) as default_value
           from pg_attribute a
           left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
          where a.attrelid = 'app.sessions'::regclass
            and a.attnum > 0
            and not a.attisdropped
          order by a.attnum`,
      );
      const expectedSessionColumns = [
        ["id", "uuid", true, "uuidv7()"],
        ["user_id", "uuid", true, null],
        ["token_hash", "text", true, null],
        ["expires_at", "timestamp with time zone", true, null],
        ["absolute_expires_at", "timestamp with time zone", true, null],
        ["revoked_at", "timestamp with time zone", false, null],
        ["last_seen_at", "timestamp with time zone", true, "now()"],
        ["created_at", "timestamp with time zone", true, "now()"],
        // Added by `20261121000000_session_csrf_token`; nullable and default-less
        // because the token is issued lazily on first retrieval (`ADR-006` §D2.1).
        ["csrf_token", "text", false, null],
      ];
      check(
        "app.sessions carries exactly the nine approved columns, types, nullability and defaults",
        sessionColumns.length === expectedSessionColumns.length &&
          expectedSessionColumns.every(([name, type, notNull, defaultValue], index) => {
            const actual = sessionColumns[index];
            return (
              actual?.name === name &&
              actual.type === type &&
              actual.not_null === notNull &&
              (actual.default_value ?? null) === defaultValue
            );
          }),
        JSON.stringify(sessionColumns),
      );

      const { rows: sessionOwner } = await owner.query(
        `select pg_get_userbyid(c.relowner) as owner_name
           from pg_class c where c.oid = 'app.sessions'::regclass`,
      );
      check(
        "app.sessions is owned by migration_owner",
        sessionOwner[0]?.owner_name === "migration_owner",
        sessionOwner[0]?.owner_name,
      );

      // `contype <> 'n'`: PostgreSQL 18 catalogues `NOT NULL` as a constraint row,
      // and it is not part of this inventory.
      const { rows: sessionConstraints } = await owner.query(
        `select conname::text as conname, contype::text as contype,
                pg_get_constraintdef(oid) as definition, confdeltype::text as confdeltype
           from pg_constraint
          where conrelid = 'app.sessions'::regclass and contype <> 'n'`,
      );
      checkSessionConstraints(check, sessionConstraints);

      const { rows: sessionIndexes } = await owner.query(
        `select i.relname::text as name,
                ix.indisunique as "unique",
                (select a.attname::text
                   from pg_attribute a
                  where a.attrelid = ix.indrelid and a.attnum = ix.indkey[0]) as column
           from pg_index ix
           join pg_class i on i.oid = ix.indexrelid
          where ix.indrelid = 'app.sessions'::regclass`,
      );
      checkSessionIndexes(check, sessionIndexes);

      const { rows: sessionRls } = await owner.query(
        `select c.relrowsecurity as rls, c.relforcerowsecurity as force_rls
           from pg_class c where c.oid = 'app.sessions'::regclass`,
      );
      check("app.sessions has ENABLE ROW LEVEL SECURITY", sessionRls[0]?.rls === true);
      check("app.sessions has FORCE ROW LEVEL SECURITY", sessionRls[0]?.force_rls === true);

      const { rows: sessionPolicies } = await owner.query(
        `select policyname, cmd, permissive, roles::text[] as roles, qual, with_check
           from pg_policies
          where schemaname = 'app' and tablename = 'sessions'`,
      );
      checkSessionPolicyInventory(check, sessionPolicies);

      const { rows: sessionGrants } = await owner.query(
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
          where a.attrelid = 'app.sessions'::regclass
            and a.attnum > 0
            and not a.attisdropped`,
      );
      checkSessionColumnGrants(check, sessionGrants[0]);

      const { rows: sessionAuthTablePrivileges } = await owner.query(
        `select coalesce(array_agg(p.priv::text order by p.priv::text), '{}') as held
           from (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) as p(priv)
          where has_table_privilege('app_auth', 'app.sessions', p.priv)`,
      );
      check(
        "app_auth holds no table-level privilege on app.sessions",
        sessionAuthTablePrivileges[0].held.length === 0,
        JSON.stringify(sessionAuthTablePrivileges[0].held),
      );

      // `PUBLIC` is grantee oid 0 in the ACL array, and it is not a role any other
      // assertion in this file speaks for: a grant to it would hand the table to
      // every credential in the cluster while every per-role check stayed green.
      // Table ACL and column ACL are separate arrays, so both are read.
      const { rows: sessionPublicAcl } = await owner.query(
        `select coalesce((select array_agg(distinct a.privilege_type::text)
                            from pg_class c
                            cross join lateral aclexplode(c.relacl) a
                           where c.oid = 'app.sessions'::regclass and a.grantee = 0),
                         '{}'::text[]) as table_public,
                coalesce((select array_agg(distinct a.privilege_type::text)
                            from pg_attribute at
                            cross join lateral aclexplode(at.attacl) a
                           where at.attrelid = 'app.sessions'::regclass and a.grantee = 0),
                         '{}'::text[]) as column_public`,
      );
      check(
        "PUBLIC holds no table-level or column-level privilege on app.sessions",
        sessionPublicAcl[0].table_public.length === 0 &&
          sessionPublicAcl[0].column_public.length === 0,
        JSON.stringify(sessionPublicAcl[0]),
      );

      for (const role of ["app_api", "app_system"]) {
        const { rows } = await owner.query(
          `select coalesce(array_agg(p.priv::text order by p.priv::text), '{}') as table_privs,
                  (select count(*)::integer
                     from pg_attribute a
                    where a.attrelid = 'app.sessions'::regclass
                      and a.attnum > 0
                      and not a.attisdropped
                      and (has_column_privilege($1, a.attrelid, a.attnum, 'SELECT')
                        or has_column_privilege($1, a.attrelid, a.attnum, 'INSERT')
                        or has_column_privilege($1, a.attrelid, a.attnum, 'UPDATE'))) as column_privs
             from (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) as p(priv)
            where has_table_privilege($1, 'app.sessions', p.priv)`,
          [role],
        );
        check(
          `${role} holds no privilege on app.sessions`,
          rows[0].table_privs.length === 0 && rows[0].column_privs === 0,
          JSON.stringify(rows[0]),
        );
      }

      const { rows: purgeOverloads } = await owner.query(
        `select p.proname::text as proname, p.prosecdef as prosecdef,
                p.prorettype::regtype::text as prorettype, p.pronargs as pronargs,
                p.proconfig as proconfig, pg_get_userbyid(p.proowner) as owner_name
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'app' and p.proname = 'purge_expired_sessions'`,
      );
      check(
        "app.purge_expired_sessions has exactly one signature",
        purgeOverloads.length === 1,
        JSON.stringify(purgeOverloads.map((row) => row.pronargs)),
      );

      // `aclexplode` rather than the textual `proacl`: the array's order is not
      // guaranteed, and a missing grant and an extra one have to be told apart.
      const { rows: purgeAcl } = await owner.query(
        `select coalesce(r.rolname::text, 'PUBLIC') as grantee,
                a.privilege_type::text as privilege,
                a.is_grantable as grantable
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           cross join lateral aclexplode(p.proacl) a
           left join pg_roles r on r.oid = a.grantee
          where n.nspname = 'app' and p.proname = 'purge_expired_sessions'`,
      );
      checkSessionFunction(
        check,
        purgeOverloads.length === 0 ? null : { ...purgeOverloads[0], acl: purgeAcl },
      );

      // Behavioural half, on a real credential. The fixture user is created by the
      // owner because `app_auth` may not supply `role`, and removed at the end.
      const hex64 = (suffix) => `${probes.token}${suffix}`.padStart(64, "0");
      const liveToken = hex64("a1");
      const revokedToken = hex64("a2");
      const expiredToken = hex64("a3");
      const idleToken = hex64("a5");
      const equalToken = hex64("a4");
      const sessionEmail = `session_probe_${probes.token}@verify.invalid`;
      let sessionUserId;

      try {
        const { rows: seeded } = await owner.query(
          "insert into app.users (email, password_hash) values ($1, $2) returning id",
          [sessionEmail, "verification-probe-not-a-hash"],
        );
        sessionUserId = seeded[0]?.id;

        const inserted = await allowed(
          auth,
          "app_auth can INSERT a session without supplying id or created_at",
          `insert into app.sessions (user_id, token_hash, expires_at, absolute_expires_at)
           values ($1, $2, now() + interval '30 days', now() + interval '90 days')
           returning id, created_at`,
          [sessionUserId, liveToken],
        );
        check(
          "the inserted session took its id and created_at from the database",
          typeof inserted?.rows[0]?.id === "string" && inserted.rows[0].created_at instanceof Date,
          JSON.stringify(inserted?.rows[0] ?? null),
        );

        const read = await allowed(
          auth,
          "app_auth can SELECT the eight granted columns of app.sessions",
          `select id, user_id, token_hash, expires_at, absolute_expires_at,
                  revoked_at, last_seen_at, created_at
             from app.sessions where token_hash = $1`,
          [liveToken],
        );
        check(
          "the session row is readable by the credential that wrote it",
          read?.rows.length === 1,
          `rows=${read?.rows.length}`,
        );

        await allowed(
          auth,
          "app_auth can extend expires_at and touch last_seen_at",
          `update app.sessions
              set expires_at = now() + interval '30 days', last_seen_at = now()
            where token_hash = $1`,
          [liveToken],
        );
        await allowed(
          auth,
          "app_auth can revoke a session through revoked_at",
          "update app.sessions set revoked_at = now() where token_hash = $1",
          [liveToken],
        );
        await allowed(
          auth,
          "app_auth can clear revoked_at",
          "update app.sessions set revoked_at = null where token_hash = $1",
          [liveToken],
        );

        // `23514`, never `42501`: these rows are refused by the CHECK constraints, not
        // by the grant, and conflating the two would let a missing constraint hide
        // behind a passing denial. `insertRejected` keeps the deadlines as SQL
        // expressions on purpose — the acceptance criterion is about the transaction
        // clock, and a test that binds a timestamp proves nothing about it.
        const insertRejected = async (label, deadlines, token) =>
          expectCode(
            auth,
            label,
            "23514",
            `insert into app.sessions (user_id, token_hash, expires_at, absolute_expires_at)
             values ($1, $2, ${deadlines})`,
            [sessionUserId, token],
          );

        await insertRejected(
          "a 91-day absolute deadline is refused by the D-2 cap (23514)",
          "now() + interval '30 days', now() + interval '91 days'",
          hex64("e1"),
        );
        await insertRejected(
          "a sliding deadline beyond the absolute deadline is refused (23514)",
          "now() + interval '60 days', now() + interval '30 days'",
          hex64("e2"),
        );
        await insertRejected(
          "a session born already expired is refused (23514)",
          "now() - interval '1 day', now() + interval '30 days'",
          hex64("e3"),
        );

        // §7.1's consequence, made executable. JavaScript reads its own clock after
        // the transaction has begun and rounds to the millisecond, so a JS-computed
        // deadline can only land at or after `created_at + 90 days` — never before.
        // The offset is one second rather than a sleep: it is the smallest gap that
        // is guaranteed rather than probable, and the cap has to refuse it anyway.
        await auth.query("begin");
        try {
          const { rows: transactionClock } = await auth.query("select now() as tx");
          const computedDeadline = new Date(
            Math.floor(new Date(transactionClock[0].tx).getTime() / 1000) * 1000 +
              90 * 24 * 60 * 60 * 1000 +
              1000,
          );
          await expectCode(
            auth,
            "a JavaScript-computed 90-day deadline is refused (23514)",
            "23514",
            `insert into app.sessions (user_id, token_hash, expires_at, absolute_expires_at)
             values ($1, $2, now() + interval '30 days', $3)`,
            [sessionUserId, hex64("e4"), computedDeadline.toISOString()],
          );
        } finally {
          await auth.query("rollback").catch(() => undefined);
        }

        // Equality is the clamped-extension shape `AG-2` describes, not a violation:
        // at day 70 of 90 `LEAST(now() + 30 days, absolute_expires_at)` lands exactly
        // on the cap, and the ordering CHECK has to accept it.
        await auth.query("begin");
        try {
          await auth.query(
            `insert into app.sessions (user_id, token_hash, expires_at, absolute_expires_at)
             values ($1, $2, now() + interval '30 days', now() + interval '90 days')`,
            [sessionUserId, hex64("e5")],
          );
          await allowed(
            auth,
            "a sliding deadline may equal the absolute deadline (clamped extension)",
            "update app.sessions set expires_at = absolute_expires_at where token_hash = $1",
            [hex64("e5")],
          );
        } finally {
          await auth.query("rollback").catch(() => undefined);
        }

        // One probe per protected column, with a value of that column's own type, so
        // a type error cannot be read as a denial.
        const protectedUpdates = {
          id: "00000000-0000-7000-8000-000000000001",
          user_id: "00000000-0000-7000-8000-000000000002",
          token_hash: hex64("b1"),
          absolute_expires_at: "2026-01-01T00:00:00Z",
          created_at: "2026-01-01T00:00:00Z",
        };
        for (const [column, value] of Object.entries(protectedUpdates)) {
          await denied(
            auth,
            `app_auth cannot UPDATE app.sessions.${column}`,
            `update app.sessions set ${column} = $1 where token_hash = $2`,
            [value, liveToken],
          );
        }

        const protectedInserts = {
          id: "00000000-0000-7000-8000-000000000003",
          revoked_at: "2026-01-01T00:00:00Z",
          last_seen_at: "2026-01-01T00:00:00Z",
          created_at: "2026-01-01T00:00:00Z",
        };
        for (const [index, [column, value]] of Object.entries(protectedInserts).entries()) {
          await denied(
            auth,
            `app_auth cannot INSERT app.sessions.${column}`,
            `insert into app.sessions
               (user_id, token_hash, expires_at, absolute_expires_at, ${column})
             values ($1, $2, now() + interval '30 days', now() + interval '90 days', $3)`,
            [sessionUserId, hex64(`c${index}`), value],
          );
        }

        await denied(
          auth,
          "app_auth cannot DELETE from app.sessions",
          "delete from app.sessions where token_hash = $1",
          [liveToken],
        );

        for (const [index, role] of ["app_api", "app_system"].entries()) {
          const client = role === "app_api" ? api : system;
          await denied(
            client,
            `${role} cannot SELECT from app.sessions`,
            "select * from app.sessions",
          );
          await denied(
            client,
            `${role} cannot INSERT into app.sessions`,
            `insert into app.sessions (user_id, token_hash, expires_at, absolute_expires_at)
             values ($1, $2, now() + interval '30 days', now() + interval '90 days')`,
            [sessionUserId, hex64(`d${index}`)],
          );
          await denied(
            client,
            `${role} cannot UPDATE app.sessions`,
            "update app.sessions set last_seen_at = now()",
          );
          await denied(
            client,
            `${role} cannot DELETE from app.sessions`,
            "delete from app.sessions",
          );
        }

        // `app_auth` answers logins and must not run collection; `app_system` is the
        // one credential that may, asserted positively below.
        await denied(
          auth,
          "app_auth cannot execute app.purge_expired_sessions()",
          "select app.purge_expired_sessions()",
        );

        // `OPEN-04` is undecided and `D16` forbids a cascade, so the foreign key is
        // the only thing standing between a mistaken account delete and a session
        // that outlives its subject. `42501` would mean the probe proved nothing.
        await expectCode(
          owner,
          "a user with a live session cannot be deleted (NO ACTION, 23503)",
          "23503",
          "delete from app.users where id = $1",
          [sessionUserId],
        );

        // Collection is asserted against an exclusive view of the eligible set.
        // Two verifications may run concurrently against one database, and a purge
        // in one would otherwise be counted by the other. `pg_advisory_lock` is
        // session-scoped, so it holds across the statements below; the unlock is in
        // the `finally` that closes this block.
        await owner.query("select pg_advisory_lock(hashtext('db:verify:sessions'))");
        try {
          // Collection fixtures, written by the owner because the past `created_at`
          // they need is outside `app_auth`'s INSERT grant.
          await owner.query(
            `insert into app.sessions (user_id, token_hash, expires_at, absolute_expires_at, created_at)
           values ($1, $2, now() - interval '62 days', now() - interval '3 days',
                   now() - interval '92 days')`,
            [sessionUserId, expiredToken],
          );
          await owner.query(
            `insert into app.sessions
             (user_id, token_hash, expires_at, absolute_expires_at, revoked_at)
           values ($1, $2, now() + interval '30 days', now() + interval '90 days', now())`,
            [sessionUserId, revokedToken],
          );

          // Sliding expiry in the past, absolute cap still ahead: the purge must leave
          // it alone. This is what keeps a long-idle session recoverable, and it fails
          // if the predicate is ever "improved" to `expires_at < now()`.
          await owner.query(
            `insert into app.sessions
             (user_id, token_hash, expires_at, absolute_expires_at, created_at)
           values ($1, $2, now() - interval '1 day', now() + interval '30 days',
                   now() - interval '60 days')`,
            [sessionUserId, idleToken],
          );

          const { rows: eligible } = await owner.query(
            "select count(*)::integer as n from app.sessions where absolute_expires_at < now()",
          );
          const purged = await allowed(
            system,
            "app_system can execute app.purge_expired_sessions()",
            "select app.purge_expired_sessions() as deleted",
          );
          check(
            "the purge returns the count it deleted",
            purged?.rows[0]?.deleted === eligible[0].n && eligible[0].n >= 1,
            `deleted=${purged?.rows[0]?.deleted} eligible=${eligible[0].n}`,
          );

          const { rows: stillExpired } = await owner.query(
            "select count(*)::integer as n from app.sessions where absolute_expires_at < now()",
          );
          check(
            "no session past its absolute deadline survives the purge",
            stillExpired[0].n === 0,
            `remaining=${stillExpired[0].n}`,
          );

          const emptyRun = await allowed(
            system,
            "a purge with nothing to collect still succeeds",
            "select app.purge_expired_sessions() as deleted",
          );
          check(
            "a purge with nothing to collect returns zero",
            emptyRun?.rows[0]?.deleted === 0,
            `deleted=${emptyRun?.rows[0]?.deleted}`,
          );

          const { rows: survivors } = await owner.query(
            "select token_hash from app.sessions where token_hash = any($1)",
            [[liveToken, revokedToken, expiredToken, idleToken]],
          );
          const survived = new Set(survivors.map((row) => row.token_hash));
          check(
            "the purge preserves a session whose absolute deadline is still ahead",
            survived.has(liveToken),
          );
          check(
            "the purge preserves a revoked session before its absolute deadline",
            survived.has(revokedToken),
          );
          check(
            "the purge ignores the sliding deadline: an idle session inside its cap keeps its row",
            survived.has(idleToken),
          );
          check(
            "the purge removed the session past its absolute deadline",
            !survived.has(expiredToken),
          );

          // The predicate is strict: a row whose absolute deadline equals the current
          // transaction's `now()` is not expired yet. Both statements run in one
          // transaction so the two `now()` values are the same timestamp.
          await owner.query("begin");
          try {
            await owner.query(
              `insert into app.sessions
               (user_id, token_hash, expires_at, absolute_expires_at, created_at)
             values ($1, $2, now() - interval '1 second', now(), now() - interval '1 hour')`,
              [sessionUserId, equalToken],
            );
            await owner.query("select app.purge_expired_sessions()");
            const { rows: boundary } = await owner.query(
              "select 1 from app.sessions where token_hash = $1",
              [equalToken],
            );
            check(
              "a session whose absolute deadline equals now() survives the same transaction",
              boundary.length === 1,
            );
          } finally {
            await owner.query("rollback").catch(() => undefined);
          }
        } finally {
          await owner
            .query("select pg_advisory_unlock(hashtext('db:verify:sessions'))")
            .catch(() => undefined);
        }
      } finally {
        // Sessions first: the foreign key refuses to orphan them, which is the
        // behaviour the probe above asserts.
        if (sessionUserId !== undefined) {
          await owner
            .query("delete from app.sessions where user_id = $1", [sessionUserId])
            .catch(() => undefined);
          await owner
            .query("delete from app.users where id = $1", [sessionUserId])
            .catch(() => undefined);
        }
      }
    }

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
    // Read as well as write: the ledger names every migration and its digest, so
    // it is a map of the schema to anyone who can select from it.
    await denied(
      api,
      "app_api cannot read the migration ledger",
      "select count(*) from app._prisma_migrations",
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
      "app_system cannot read the migration ledger",
      "select count(*) from app._prisma_migrations",
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
      "app_auth cannot read the migration ledger",
      "select count(*) from app._prisma_migrations",
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
    //
    // `DELETE` is absent on purpose. No runtime role holds it anywhere, which the
    // loop below asserts as a refusal rather than as an omission, and
    // `20261128120000_revoke_runtime_delete` is the migration that took it away.
    const RW = ["SELECT", "INSERT", "UPDATE"];
    const R = ["SELECT"];
    const NONE = [];

    const EXPECTED = Object.fromEntries([
      // Row 1: identity. No grant at all — the login lookup is OPEN-01.
      ["users", { app_api: NONE, app_system: NONE }],
      // Sessions are reached through column grants to `app_auth` only, which is
      // neither of the roles this matrix reads. Listed so the coverage assertion
      // at the end of this block has no exception to remember.
      ["sessions", { app_api: NONE, app_system: NONE }],
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
      ...SYSTEM_ONLY_TABLES.map((table) => [table, { app_api: NONE, app_system: RW }]),
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

    // The matrix above reads the catalogue. These two read what a client actually
    // gets: a `DELETE` that a runtime role sends must come back as 42501, not as
    // "0 rows affected", because a policy that hides rows and a privilege that
    // does not exist are different guarantees.
    await denied(
      api,
      "app_api cannot DELETE from a tenant table",
      "delete from app.farms where false",
    );
    for (const table of [...GLOBAL_TABLES, ...SYSTEM_ONLY_TABLES]) {
      await denied(
        system,
        `app_system cannot DELETE from ${table}`,
        `delete from app.${quote(table)} where false`,
      );
    }

    // Every table in the schema must be classified above. The matrix is built
    // from the four class constants, so a table nobody added to one of them is
    // exempt from every assertion in this file — which is exactly how the
    // privilege this migration removed came to exist unnoticed. The ledger is the
    // one relation that is not application data.
    const { rows: unclassified } = await owner.query(
      `select c.relname as table
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'app'
          and c.relkind = 'r'
          and c.relname <> '_prisma_migrations'
          -- A crashed run can leave its probe table behind, and teardown only
          -- drops the one this run created.
          and c.relname not like 'privilege_probe\_%'
        order by c.relname`,
    );
    const classified = new Set(Object.keys(EXPECTED));
    const orphans = unclassified.map((row) => row.table).filter((table) => !classified.has(table));
    check(
      "every app table is classified in the privilege matrix",
      orphans.length === 0,
      `unclassified: ${JSON.stringify(orphans)}`,
    );

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
    for (const table of [...REFERENCE_TABLES, ...GLOBAL_TABLES, ...SYSTEM_ONLY_TABLES]) {
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
