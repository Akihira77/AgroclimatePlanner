/**
 * Session operations against the real PostgreSQL roles (`ADR-005`, `S8`).
 *
 * A double can prove the SQL was issued. It cannot prove `app_auth` may write the
 * four granted columns and nothing else, that the database owns `created_at`, or
 * that two concurrent extensions really produce one update. Every assertion here
 * runs as a real role against a migrated database.
 *
 * Requires `NODE_ENV=development` and the role bootstrap (the same prerequisite as
 * `test:rls`). Run: pnpm --filter @agroclimate/database test:integration
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { Client } from "pg";

import {
  createPrismaClient,
  extendSession,
  findActiveSession,
  findAuthUserByEmail,
  insertSession,
  revokeSession,
} from "../../dist/index.js";
import { roleConnectionString } from "../../scripts/lib/connections.mjs";

const auth = createPrismaClient({ connectionString: roleConnectionString("app_auth") });
const owner = new Client({ connectionString: roleConnectionString("migration_owner") });
const api = new Client({ connectionString: roleConnectionString("app_api") });

const createdUsers = new Set();
const PASSWORD_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

let userId;

const token = () => `t${Math.random().toString(36).slice(2)}`.padEnd(43, "A");
const hashOf = (raw) => createHash("sha256").update(raw, "utf8").digest("hex");

async function createUser(label) {
  const email = `${label}-${Math.random().toString(36).slice(2, 10)}@s8-integration.test`;
  const result = await owner.query(
    "INSERT INTO app.users (email, password_hash) VALUES ($1, $2) RETURNING id::text AS id",
    [email, PASSWORD_HASH],
  );
  const id = result.rows[0].id;
  createdUsers.add(id);
  return { id, email };
}

/** Reads the row as the owner, so nothing is hidden by the auth grant. */
async function readSession(sessionId) {
  const result = await owner.query(
    `SELECT id::text AS id, user_id::text AS user_id, token_hash,
            expires_at, absolute_expires_at, revoked_at, last_seen_at, created_at
       FROM app.sessions WHERE id = $1`,
    [sessionId],
  );
  return result.rows[0];
}

/**
 * A permission denial survives several wrappers: `pg` puts SQLSTATE on `code`, and
 * Prisma 7 nests the driver error at `meta.driverAdapterError.cause.originalCode`.
 * The assertion is about the SQLSTATE, so it is looked for wherever it landed.
 */
function isPermissionDenied(error, depth = 0) {
  if (depth > 6 || typeof error !== "object" || error === null) return false;
  if (Array.isArray(error)) return error.some((item) => isPermissionDenied(item, depth + 1));

  for (const key of ["code", "originalCode", "sqlState"]) {
    if (error[key] === "42501") return true;
  }

  // The nesting is the driver's choice, not ours: `pg` uses `code`, Prisma 7 uses
  // `meta.driverAdapterError.cause.originalCode`. Walking the values finds it
  // without this test asserting on a wrapper's internal shape.
  return Object.values(error).some((value) => isPermissionDenied(value, depth + 1));
}

/**
 * Moves a row into the past without breaking `sessions_expiry_order_check`
 * (`absolute_expires_at >= expires_at AND expires_at > created_at`) or
 * `sessions_absolute_expiry_cap_check` (`<= created_at + 90 days`). Created time
 * has to move with the deadlines, which is why the caller supplies all three as
 * signed offsets from `now()` and they are applied in one statement.
 */
async function ageSession(sessionId, created, expires, absolute) {
  await owner.query(
    `UPDATE app.sessions
        SET created_at          = now() + $2::interval,
            expires_at          = now() + $3::interval,
            absolute_expires_at = now() + $4::interval
      WHERE id = $1`,
    [sessionId, created, expires, absolute],
  );
}

async function backdateLastSeen(sessionId, minutes) {
  await owner.query(
    "UPDATE app.sessions SET last_seen_at = now() - ($2 || ' minutes')::interval WHERE id = $1",
    [sessionId, String(minutes)],
  );
}

async function issue(label = "session") {
  const raw = token();
  const session = await insertSession(auth, userId, hashOf(raw));
  return { raw, session };
}

before(async () => {
  await owner.connect();
  await api.connect();
  ({ id: userId } = await createUser("session"));
});

after(async () => {
  try {
    if (createdUsers.size > 0) {
      await owner.query("DELETE FROM app.sessions WHERE user_id = ANY($1::uuid[])", [
        [...createdUsers],
      ]);
      await owner.query("DELETE FROM app.users WHERE id = ANY($1::uuid[])", [[...createdUsers]]);
    }
  } finally {
    await owner.end();
    await api.end();
    await auth.$disconnect();
  }
});

describe("credential lookup boundary", () => {
  it("connects as app_auth and needs no tenant context", async () => {
    const rows =
      await auth.$queryRaw`SELECT current_user AS role, current_setting('app.user_id', true) AS tenant`;
    assert.equal(rows[0].role, "app_auth");
    assert.equal(rows[0].tenant, null, "authentication must not depend on app.user_id");
  });

  it("returns the credential row through app_auth", async () => {
    const record = await findAuthUserByEmail(auth, `${"x"}`);
    assert.equal(record, null, "an unknown address is a null, not an error");

    const email = `${"lookup"}-${Math.random().toString(36).slice(2, 10)}@s8-integration.test`;
    const inserted = await owner.query(
      "INSERT INTO app.users (email, password_hash) VALUES ($1, $2) RETURNING id::text AS id",
      [email, PASSWORD_HASH],
    );
    createdUsers.add(inserted.rows[0].id);

    const found = await findAuthUserByEmail(auth, email);
    assert.equal(found.id, inserted.rows[0].id);
    assert.equal(found.email, email);
    assert.equal(found.passwordHash, PASSWORD_HASH);
    assert.equal(found.role, "owner");
  });
});

describe("session issuance", () => {
  it("persists the hash the caller supplied and never the raw token", async () => {
    const { raw, session } = await issue();
    const row = await readSession(session.id);

    assert.equal(row.token_hash, hashOf(raw));
    assert.match(row.token_hash, /^[0-9a-f]{64}$/);
    assert.notEqual(row.token_hash, raw);
    for (const value of Object.values(row)) assert.notEqual(value, raw);
  });

  it("computes both deadlines from the database clock", async () => {
    const { session } = await issue();
    const row = await readSession(session.id);

    const sliding = await owner.query(
      "SELECT extract(epoch FROM ($1::timestamptz - $2::timestamptz)) AS seconds",
      [row.expires_at, row.created_at],
    );
    const absolute = await owner.query(
      "SELECT extract(epoch FROM ($1::timestamptz - $2::timestamptz)) AS seconds",
      [row.absolute_expires_at, row.created_at],
    );

    assert.equal(Number(sliding.rows[0].seconds), 30 * 86_400);
    assert.equal(Number(absolute.rows[0].seconds), 90 * 86_400);
    assert.equal(row.expires_at.getTime() > row.created_at.getTime(), true);
    assert.equal(row.absolute_expires_at.getTime() >= row.expires_at.getTime(), true);
    assert.equal(row.revoked_at, null);
  });
});

describe("session validation", () => {
  it("resolves an active session to its user", async () => {
    const { raw } = await issue();
    const active = await findActiveSession(auth, hashOf(raw));

    assert.equal(active.userId, userId);
    assert.equal(active.email.endsWith("@s8-integration.test"), true);
    assert.equal(active.expiresAt.getTime() > Date.now(), true);
  });

  it("rejects a wrong token without scanning", async () => {
    await issue();
    assert.equal(await findActiveSession(auth, hashOf(token())), null);
  });

  it("rejects a session past its sliding deadline, even though the row exists", async () => {
    const { raw, session } = await issue();
    await ageSession(session.id, "-2 days", "-1 second", "30 days");

    assert.equal(await findActiveSession(auth, hashOf(raw)), null);
    assert.notEqual(await readSession(session.id), undefined, "the row is still there");
  });

  it("rejects a session past its absolute deadline", async () => {
    const { raw, session } = await issue();
    await ageSession(session.id, "-3 days", "-2 seconds", "-1 second");

    assert.equal(await findActiveSession(auth, hashOf(raw)), null);
  });

  it("rejects a revoked session", async () => {
    const { raw, session } = await issue();
    assert.equal(await revokeSession(auth, hashOf(raw)), true);
    assert.equal(await findActiveSession(auth, hashOf(raw)), null);

    const row = await readSession(session.id);
    assert.notEqual(row.revoked_at, null);
  });
});

describe("sliding extension", () => {
  it("does not extend inside the five-minute throttle", async () => {
    const { raw } = await issue();
    assert.equal(await extendSession(auth, hashOf(raw)), null);
  });

  it("extends after the window, preserving the absolute deadline", async () => {
    const { raw, session } = await issue();
    const before = await readSession(session.id);
    await owner.query(
      "UPDATE app.sessions SET expires_at = now() + interval '1 day' WHERE id = $1",
      [session.id],
    );
    await backdateLastSeen(session.id, 6);

    const extended = await extendSession(auth, hashOf(raw));
    assert.notEqual(extended, null);

    const after = await readSession(session.id);
    assert.equal(after.absolute_expires_at.getTime(), before.absolute_expires_at.getTime());
    assert.equal(after.expires_at.getTime() > before.created_at.getTime(), true);

    const sliding = await owner.query(
      "SELECT extract(epoch FROM (expires_at - now())) AS seconds FROM app.sessions WHERE id = $1",
      [session.id],
    );
    assert.equal(Math.round(Number(sliding.rows[0].seconds)), 30 * 86_400);
  });

  it("clamps the extension to the absolute deadline", async () => {
    const { raw, session } = await issue();
    await owner.query(
      `UPDATE app.sessions
          SET expires_at = now() + interval '1 hour',
              absolute_expires_at = now() + interval '1 day'
        WHERE id = $1`,
      [session.id],
    );
    await backdateLastSeen(session.id, 6);

    const extended = await extendSession(auth, hashOf(raw));
    const after = await readSession(session.id);

    assert.equal(extended.expiresAt.getTime(), after.absolute_expires_at.getTime());
    assert.equal(after.expires_at.getTime(), after.absolute_expires_at.getTime());
    assert.equal(after.expires_at.getTime() <= after.absolute_expires_at.getTime(), true);
  });

  it("performs at most one extension when two requests race", async () => {
    const { raw, session } = await issue();
    await backdateLastSeen(session.id, 6);

    const outcomes = await Promise.all([
      extendSession(auth, hashOf(raw)),
      extendSession(auth, hashOf(raw)),
    ]);

    assert.equal(
      outcomes.filter((outcome) => outcome !== null).length,
      1,
      "the throttle is rechecked in the UPDATE predicate, so the loser updates nothing",
    );
  });

  it("never extends a revoked or expired session", async () => {
    const revoked = await issue();
    await revokeSession(auth, hashOf(revoked.raw));
    await backdateLastSeen(revoked.session.id, 6);
    assert.equal(await extendSession(auth, hashOf(revoked.raw)), null);

    const expired = await issue();
    await ageSession(expired.session.id, "-1 day", "-1 second", "30 days");
    await backdateLastSeen(expired.session.id, 6);
    assert.equal(await extendSession(auth, hashOf(expired.raw)), null);

    // Expiry is one-way: a longer extension cannot revive the row.
    assert.equal(await findActiveSession(auth, hashOf(expired.raw)), null);
  });
});

describe("logout", () => {
  it("sets revoked_at, never deletes, and is idempotent", async () => {
    const { raw, session } = await issue();

    assert.equal(await revokeSession(auth, hashOf(raw)), true);
    const first = await readSession(session.id);
    assert.notEqual(first.revoked_at, null);

    assert.equal(await revokeSession(auth, hashOf(raw)), false);
    const second = await readSession(session.id);
    assert.equal(second.revoked_at.getTime(), first.revoked_at.getTime());

    const count = await owner.query("SELECT count(*)::int AS n FROM app.sessions WHERE id = $1", [
      session.id,
    ]);
    assert.equal(count.rows[0].n, 1);
    assert.equal(await findActiveSession(auth, hashOf(raw)), null);
  });
});

describe("database-enforced boundaries", () => {
  it("does not let app_auth rewrite the immutable session columns", async () => {
    const { session } = await issue();

    for (const statement of [
      "UPDATE app.sessions SET token_hash = repeat('a', 64) WHERE id = $1",
      "UPDATE app.sessions SET user_id = gen_random_uuid() WHERE id = $1",
      "UPDATE app.sessions SET absolute_expires_at = now() + interval '89 days' WHERE id = $1",
      "UPDATE app.sessions SET created_at = now() - interval '1 day' WHERE id = $1",
      "DELETE FROM app.sessions WHERE id = $1",
    ]) {
      await assert.rejects(
        () => auth.$executeRawUnsafe(statement, session.id),
        (error) => isPermissionDenied(error),
        statement,
      );
    }
  });

  it("gives the tenant role no access to sessions at all", async () => {
    const { session } = await issue();

    for (const [statement, values] of [
      ["SELECT * FROM app.sessions LIMIT 1", []],
      ["SELECT token_hash FROM app.sessions WHERE id = $1", [session.id]],
      [
        "INSERT INTO app.sessions (user_id, token_hash, expires_at, absolute_expires_at) VALUES ($1, repeat('b', 64), now() + interval '1 day', now() + interval '2 days')",
        [userId],
      ],
      ["UPDATE app.sessions SET revoked_at = now()", []],
      ["DELETE FROM app.sessions", []],
    ]) {
      await assert.rejects(
        () => api.query(statement, values),
        (error) => isPermissionDenied(error),
        statement,
      );
    }
  });

  it("still refuses app_api the credential column", async () => {
    await assert.rejects(
      () => api.query("SELECT password_hash FROM app.users LIMIT 1"),
      (error) => isPermissionDenied(error),
    );
  });
});
