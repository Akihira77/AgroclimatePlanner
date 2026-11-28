/**
 * The authentication boundary, against the real roles.
 *
 * Every probe talks to PostgreSQL as `app_auth` (or `app_api`/`app_system`) with
 * no `app.user_id` set, because authentication is the path that runs before a
 * tenant context exists. A denial is accepted only at `42501`
 * (`insufficient_privilege`); `42P01` (missing relation), `42703` (missing
 * column) and `3F000` (missing schema) fail the assertion instead of passing as
 * a boundary that was never proved. CHECK violations are asserted separately at
 * `23514` — they are constraint tests, not privilege tests.
 *
 * Fixtures carry a random suffix so two runs (or two concurrent runs against the
 * same database) never collide, and cleanup is keyed on the ids this run
 * generated rather than on a fixed email or a table-wide `TRUNCATE`.
 *
 * Requires a migrated database and the roles from `pnpm db:bootstrap`.
 * Run: pnpm --filter @agroclimate/database test:rls
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { Client } from "pg";

import { roleConnectionString } from "../../scripts/lib/connections.mjs";

const owner = new Client({ connectionString: roleConnectionString("migration_owner") });
const auth = new Client({ connectionString: roleConnectionString("app_auth") });
const api = new Client({ connectionString: roleConnectionString("app_api") });
const system = new Client({ connectionString: roleConnectionString("app_system") });

/** Ids this run created, so cleanup can never reach beyond them. */
const fixtures = {
  email: null,
  primaryUserId: null,
  registeredUserId: null,
  tokenHash: null,
  sessionId: null,
};

const hex = () => randomBytes(32).toString("hex");
/** A fresh 64-character lowercase hex token hash; each failed insert needs its own. */
const tokenHash = () => hex();
const uniqueName = (label) => `${label}-${randomBytes(6).toString("hex")}`;
const emailFor = (label) => `${label}-${randomBytes(6).toString("hex")}@auth-boundary.test`;

/**
 * Resolve one statement to `{ ok, result | error }`. A `pg` error always carries
 * a SQLSTATE; a missing one means the failure is not the database refusing the
 * statement, so it is rethrown instead of being counted as a denial.
 */
async function attempt(client, sql, parameters = []) {
  try {
    return { ok: true, result: await client.query(sql, parameters) };
  } catch (error) {
    if (typeof error.code !== "string") throw error;
    return { ok: false, error };
  }
}

/** Assert the statement is refused at exactly `code`. */
async function deniedCode(client, sql, parameters, code) {
  const outcome = await attempt(client, sql, parameters);
  assert.equal(
    outcome.ok,
    false,
    `expected SQLSTATE ${code}, statement succeeded: ${sql.replaceAll(/\s+/g, " ").trim()}`,
  );
  assert.equal(
    outcome.error.code,
    code,
    `expected SQLSTATE ${code}, got ${outcome.error.code}: ${outcome.error.message}`,
  );
}

/** Assert the statement runs, and return its result. */
async function allowed(client, sql, parameters = []) {
  return client.query(sql, parameters);
}

/**
 * Identifiers cannot be bound as parameters; escape the catalogue-supplied name
 * so a quoted table cannot break out of the statement.
 */
const quoteIdent = (name) => `"${name.replaceAll('"', '""')}"`;

/**
 * Enumerate the app tables before registering tests: a derived list has to be
 * known at registration time, and `pg_tables` does not filter by privilege, so
 * the list is the full catalogue rather than "what this role can read".
 */
const authenticationTables = new Set(["users", "sessions", "_prisma_migrations"]);
const appTables = await (async () => {
  const client = new Client({ connectionString: roleConnectionString("migration_owner") });
  await client.connect();
  try {
    const { rows } = await client.query(
      "select tablename from pg_tables where schemaname = 'app' order by tablename",
    );
    return rows.map((row) => row.tablename);
  } finally {
    await client.end();
  }
})();
const enumerableTables = appTables.filter((name) => !authenticationTables.has(name));

before(async () => {
  await Promise.all([owner.connect(), auth.connect(), api.connect(), system.connect()]);

  // A `42P01` must never be read as a denial, so the objects the suite is about
  // are asserted to exist before any probe touches them.
  const { rows: present } = await owner.query(
    `select
       to_regclass('app.users')   is not null as users,
       to_regclass('app.sessions') is not null as sessions`,
  );
  assert.equal(present[0].users, true, "app.users is missing — run the migrations");
  assert.equal(present[0].sessions, true, "app.sessions is missing — run the migrations");

  fixtures.email = emailFor("fixture");
  const { rows: created } = await owner.query(
    "insert into app.users (email, password_hash) values ($1, 'x') returning id",
    [fixtures.email],
  );
  fixtures.primaryUserId = created[0].id;
});

after(async () => {
  // Sessions first: `user_id` is a foreign key with no cascade, and `app_auth`
  // holds no DELETE, so removal is the schema owner's job.
  const userIds = [fixtures.primaryUserId, fixtures.registeredUserId].filter(
    (value) => typeof value === "string",
  );

  try {
    await owner.query("delete from app.sessions where user_id = any($1::uuid[])", [userIds]);
    const { rows: sessions } = await owner.query(
      "select count(*)::int as n from app.sessions where user_id = any($1::uuid[])",
      [userIds],
    );
    await owner.query("delete from app.users where id = any($1::uuid[])", [userIds]);
    const { rows: users } = await owner.query(
      "select count(*)::int as n from app.users where id = any($1::uuid[])",
      [userIds],
    );

    console.log(`auth-boundary cleanup: fixture sessions=${sessions[0].n} users=${users[0].n}`);
    assert.equal(sessions[0].n, 0, "fixture sessions survived cleanup");
    assert.equal(users[0].n, 0, "fixture users survived cleanup");
  } finally {
    await Promise.all([
      owner.end().catch(() => {}),
      auth.end().catch(() => {}),
      api.end().catch(() => {}),
      system.end().catch(() => {}),
    ]);
  }
});

describe("app_auth on app.users", () => {
  it("resolves a login row by email with no tenant context", async () => {
    const result = await allowed(
      auth,
      `select id, email, password_hash, role, locale, timezone
       from app.users where email = $1`,
      [fixtures.email],
    );

    assert.equal(result.rowCount, 1);
    assert.equal(result.rows[0].id, fixtures.primaryUserId);
    assert.equal(result.rows[0].email, fixtures.email);
  });

  it("cannot read created_at, which the column grant withholds", async () => {
    // `created_at`/`updated_at` are outside both credential column lists:
    // nothing on the auth path reads them, so the grant is exact, not a table ACL.
    await deniedCode(auth, "select created_at from app.users", [], "42501");
  });

  it("can register a user through the two-column INSERT grant", async () => {
    const email = emailFor("registered");
    const result = await allowed(
      auth,
      "insert into app.users (email, password_hash) values ($1, $2) returning id",
      [email, "x"],
    );

    assert.equal(result.rowCount, 1);
    assert.match(result.rows[0].id, /^[0-9a-f-]{36}$/);
    fixtures.registeredUserId = result.rows[0].id;
  });

  it("cannot choose role at registration", async () => {
    // Naming `role` is exactly how an INSERT would escalate an account.
    await deniedCode(
      auth,
      "insert into app.users (email, password_hash, role) values ($1, $2, 'admin')",
      [emailFor("escalation"), "x"],
      "42501",
    );
  });

  it("cannot update any user column", async () => {
    await deniedCode(
      auth,
      "update app.users set locale = 'en' where email = $1",
      [fixtures.email],
      "42501",
    );
  });

  it("cannot delete a user", async () => {
    await deniedCode(auth, "delete from app.users where email = $1", [fixtures.email], "42501");
  });

  it("can count users — the accepted enumeration exposure, asserted deliberately", async () => {
    // ADR-004 accepts that the auth credential can enumerate addresses. The test
    // pins the exposure so it surfaces here rather than as a later surprise.
    const result = await allowed(auth, "select count(*)::int as n from app.users");
    assert.equal(typeof result.rows[0].n, "number");
    assert.ok(result.rows[0].n >= 1, "the fixture user must be countable");
  });

  it("cannot SET ROLE to any of the other roles", async () => {
    for (const role of ["app_api", "app_system", "migration_owner"]) {
      await deniedCode(auth, `set role ${role}`, [], "42501");
    }
  });

  it("cannot create a table in app", async () => {
    await deniedCode(
      auth,
      `create table app.${quoteIdent(uniqueName("probe"))} (id int)`,
      [],
      "42501",
    );
  });
});

describe("app_auth tenant context", () => {
  it("is permitted to set app.user_id but still has no tenant-table grant", async () => {
    // The point of the fourth role: it may hold a tenant GUC (a pool may reuse
    // one), and the grant boundary still makes that context useless.
    await auth.query("begin");
    try {
      await auth.query("select set_config('app.user_id', $1, true)", [
        "00000000-0000-4000-8000-000000000000",
      ]);
      await deniedCode(auth, "select * from app.farms", [], "42501");
    } finally {
      await auth.query("rollback");
    }
  });
});

describe("app_auth catalogue enumeration", () => {
  it("derives exactly the 23 non-authentication tables", () => {
    // A shrinking list would silently drop probes; the count is the guard.
    //
    // 23 = 26 tables in `app` − users, sessions, `_prisma_migrations`. The
    // count moved 21 → 23 in Phase 5.5, when `climatology_baselines` and
    // `climatology_normals` were added; both are probed below like any other
    // table. Adjust this number when the catalogue changes — never exclude a
    // table to keep the old count.
    assert.equal(
      enumerableTables.length,
      23,
      `expected 23 non-authentication app tables (26 minus users, sessions and _prisma_migrations), got ${enumerableTables.length}: ${enumerableTables.join(", ")}`,
    );
  });

  for (const table of enumerableTables) {
    it(`cannot select from app.${table}`, async () => {
      await deniedCode(auth, `select * from app.${quoteIdent(table)}`, [], "42501");
    });
  }
});

describe("app_auth on app.sessions", () => {
  it("creates a session with SQL-computed deadlines", async () => {
    const hash = tokenHash();
    const result = await allowed(
      auth,
      `insert into app.sessions (user_id, token_hash, expires_at, absolute_expires_at)
       values ($1, $2, now() + interval '30 days', now() + interval '90 days')
       returning id, created_at, expires_at, absolute_expires_at`,
      [fixtures.primaryUserId, hash],
    );

    assert.equal(result.rowCount, 1);
    assert.match(result.rows[0].id, /^[0-9a-f-]{36}$/);
    assert.ok(result.rows[0].created_at instanceof Date, "created_at must come from the database");

    fixtures.tokenHash = hash;
    fixtures.sessionId = result.rows[0].id;
  });

  it("reads the session row back by token hash", async () => {
    const result = await allowed(
      auth,
      `select id, user_id, token_hash, expires_at, absolute_expires_at, revoked_at,
              last_seen_at, created_at
       from app.sessions where token_hash = $1`,
      [fixtures.tokenHash],
    );

    assert.equal(result.rowCount, 1);
    assert.equal(result.rows[0].id, fixtures.sessionId);
    assert.equal(result.rows[0].user_id, fixtures.primaryUserId);
    assert.equal(result.rows[0].token_hash, fixtures.tokenHash);
    assert.equal(result.rows[0].revoked_at, null);
  });

  it("rejects a cap beyond 90 days with 23514, not 42501", async () => {
    // A constraint, not a privilege: folding this into the denial checks would
    // hide a broken D-2 behind a passing boundary.
    await deniedCode(
      auth,
      `insert into app.sessions (user_id, token_hash, expires_at, absolute_expires_at)
       values ($1, $2, now() + interval '30 days', now() + interval '91 days')`,
      [fixtures.primaryUserId, tokenHash()],
      "23514",
    );
  });

  it("rejects expires_at after absolute_expires_at with 23514", async () => {
    await deniedCode(
      auth,
      `insert into app.sessions (user_id, token_hash, expires_at, absolute_expires_at)
       values ($1, $2, now() + interval '60 days', now() + interval '30 days')`,
      [fixtures.primaryUserId, tokenHash()],
      "23514",
    );
  });

  it("rejects a session born dead (expires_at before created_at) with 23514", async () => {
    await deniedCode(
      auth,
      `insert into app.sessions (user_id, token_hash, expires_at, absolute_expires_at)
       values ($1, $2, now() - interval '1 day', now() + interval '90 days')`,
      [fixtures.primaryUserId, tokenHash()],
      "23514",
    );
  });

  it("rejects a JavaScript-computed 90-day bound with 23514", async () => {
    await auth.query("begin");
    try {
      const { rows } = await auth.query("select now() as tx");
      const tx = rows[0].tx;

      // A JavaScript instant rounds to the millisecond, so the computed bound can
      // only land later than the transaction's `now()`; `D-2` compares against
      // `created_at + 90 days`, which is why the deadline must be SQL-computed.
      const bound = new Date(Math.floor(Date.parse(tx) / 1000) * 1000 + 90 * 86400000 + 1000);

      await deniedCode(
        auth,
        `insert into app.sessions (user_id, token_hash, expires_at, absolute_expires_at)
         values ($1, $2, now() + interval '30 days', $3)`,
        [fixtures.primaryUserId, tokenHash(), bound],
        "23514",
      );
    } finally {
      await auth.query("rollback");
    }
  });

  it("allows expires_at to reach absolute_expires_at (equality is legal)", async () => {
    await auth.query("begin");
    try {
      const hash = tokenHash();
      await allowed(
        auth,
        `insert into app.sessions (user_id, token_hash, expires_at, absolute_expires_at)
         values ($1, $2, now() + interval '30 days', now() + interval '90 days')`,
        [fixtures.primaryUserId, hash],
      );
      const updated = await allowed(
        auth,
        "update app.sessions set expires_at = absolute_expires_at where token_hash = $1",
        [hash],
      );
      assert.equal(updated.rowCount, 1);
    } finally {
      await auth.query("rollback");
    }
  });

  it("can revoke and un-revoke a session", async () => {
    // Logout writes `revoked_at`; there is no direction check, so clearing it is
    // possible and is an accepted limitation, not a privilege gap.
    const revoked = await allowed(
      auth,
      "update app.sessions set revoked_at = now() where token_hash = $1",
      [fixtures.tokenHash],
    );
    assert.equal(revoked.rowCount, 1);

    const cleared = await allowed(
      auth,
      "update app.sessions set revoked_at = null where token_hash = $1",
      [fixtures.tokenHash],
    );
    assert.equal(cleared.rowCount, 1);
  });

  it("can slide expires_at and last_seen_at", async () => {
    const result = await allowed(
      auth,
      `update app.sessions
       set expires_at = now() + interval '30 days', last_seen_at = now()
       where token_hash = $1`,
      [fixtures.tokenHash],
    );
    assert.equal(result.rowCount, 1);
  });

  it("can read and lazily set csrf_token, and only while it is null", async () => {
    const read = await allowed(auth, "select csrf_token from app.sessions where token_hash = $1", [
      fixtures.tokenHash,
    ]);
    assert.equal(read.rowCount, 1);
    assert.equal(read.rows[0].csrf_token, null, "not issued yet");

    const token = "A".repeat(42) + "B";
    const claimed = await allowed(
      auth,
      `update app.sessions set csrf_token = $2
        where token_hash = $1 and csrf_token is null`,
      [fixtures.tokenHash, token],
    );
    assert.equal(claimed.rowCount, 1);

    // The claim predicate is the rotation guard: a second write matches nothing.
    const again = await allowed(
      auth,
      `update app.sessions set csrf_token = $2
        where token_hash = $1 and csrf_token is null`,
      [fixtures.tokenHash, "C".repeat(43)],
    );
    assert.equal(again.rowCount, 0);
  });

  it("cannot store a csrf_token the format rule excludes", async () => {
    for (const value of ["A".repeat(42), "A".repeat(44), `${"A".repeat(42)}=`, ""]) {
      await deniedCode(
        auth,
        "update app.sessions set csrf_token = $2 where token_hash = $1",
        [fixtures.tokenHash, value],
        "23514",
      );
    }
  });

  it("cannot rewrite token_hash, user_id, created_at or absolute_expires_at", async () => {
    // The UPDATE grant is exactly the sliding window plus logout. `created_at`
    // and the cap are outside it, so a stolen credential cannot mint or extend.
    await deniedCode(
      auth,
      "update app.sessions set token_hash = $2 where token_hash = $1",
      [fixtures.tokenHash, tokenHash()],
      "42501",
    );
    await deniedCode(
      auth,
      "update app.sessions set user_id = $2 where token_hash = $1",
      [fixtures.tokenHash, fixtures.primaryUserId],
      "42501",
    );
    await deniedCode(
      auth,
      "update app.sessions set created_at = now() where token_hash = $1",
      [fixtures.tokenHash],
      "42501",
    );
    await deniedCode(
      auth,
      "update app.sessions set absolute_expires_at = now() where token_hash = $1",
      [fixtures.tokenHash],
      "42501",
    );
  });

  it("cannot delete a session", async () => {
    await deniedCode(
      auth,
      "delete from app.sessions where token_hash = $1",
      [fixtures.tokenHash],
      "42501",
    );
  });

  it("cannot execute the collection function", async () => {
    await deniedCode(auth, "select app.purge_expired_sessions()", [], "42501");
  });
});

describe("other roles on app.sessions", () => {
  for (const [label, client] of [
    ["app_api", api],
    ["app_system", system],
  ]) {
    it(`${label} is denied all four table verbs`, async () => {
      await deniedCode(client, "select * from app.sessions", [], "42501");
      await deniedCode(client, "select csrf_token from app.sessions", [], "42501");
      await deniedCode(
        client,
        `insert into app.sessions (user_id, token_hash, expires_at, absolute_expires_at)
         values ($1, $2, now() + interval '30 days', now() + interval '90 days')`,
        [fixtures.primaryUserId, tokenHash()],
        "42501",
      );
      await deniedCode(client, "update app.sessions set revoked_at = now()", [], "42501");
      await deniedCode(client, "delete from app.sessions", [], "42501");
    });
  }

  it("app_api cannot execute the collection function", async () => {
    await deniedCode(api, "select app.purge_expired_sessions()", [], "42501");
  });

  it("app_system can execute the collection function and receives an integer", async () => {
    const result = await allowed(system, "select app.purge_expired_sessions() as deleted");
    const deleted = result.rows[0].deleted;

    assert.equal(typeof deleted, "number");
    assert.ok(Number.isInteger(deleted), `expected an integer count, got ${deleted}`);
    assert.ok(deleted >= 0, "a run with nothing to collect is a success, never negative");
  });

  it("app_system holds no table privilege of any verb", async () => {
    // One denial proves one statement path; the privilege catalogue states the
    // absence directly, so "no grant" is not inferred from a single failure.
    for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
      const { rows } = await allowed(
        system,
        "select has_table_privilege('app_system', 'app.sessions', $1) as granted",
        [privilege],
      );
      assert.equal(rows[0].granted, false, `app_system unexpectedly holds ${privilege}`);
    }
  });

  it("OPEN-04 account deletion and anonymization functions are strictly role-scoped", async () => {
    await deniedCode(
      api,
      "select app.soft_delete_account($1::uuid)",
      [fixtures.primaryUserId],
      "42501",
    );
    await deniedCode(
      system,
      "select app.soft_delete_account($1::uuid)",
      [fixtures.primaryUserId],
      "42501",
    );
    await deniedCode(auth, "select app.anonymize_expired_deleted_users(30)", [], "42501");
    await deniedCode(api, "select app.anonymize_expired_deleted_users(30)", [], "42501");
  });
});
