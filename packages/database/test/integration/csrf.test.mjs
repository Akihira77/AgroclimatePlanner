/**
 * The session-bound CSRF token against real PostgreSQL and the real roles
 * (`ADR-006` §D2.1, *Amendment 4*).
 *
 * A double can prove the SQL was issued and the branch was taken. It cannot prove
 * the CHECK rejects a 44-character value, that `app_api` is refused `42501`, or that
 * two simultaneous first retrievals leave exactly one token in the row. Those are
 * the properties this file exists for.
 *
 * Requires `NODE_ENV=development` and the role bootstrap.
 * Run: pnpm --filter @agroclimate/database test:integration
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { Client } from "pg";

import {
  createPrismaClient,
  insertSession,
  readSessionCsrfToken,
  resolveSession,
  resolveSessionCsrfToken,
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

const mint = () => randomBytes(32).toString("base64url");
const token = () => mint();
const hashOf = (raw) => createHash("sha256").update(raw, "utf8").digest("hex");

async function createUser(label) {
  const email = `${label}-${Math.random().toString(36).slice(2, 10)}@s8-csrf.test`;
  const result = await owner.query(
    "INSERT INTO app.users (email, password_hash) VALUES ($1, $2) RETURNING id::text AS id",
    [email, PASSWORD_HASH],
  );
  const id = result.rows[0].id;
  createdUsers.add(id);
  return id;
}

async function issue(label = "csrf") {
  const raw = token();
  const session = await insertSession(auth, userId, hashOf(raw));
  return { raw, session };
}

/** Reads the row as the owner, so nothing is hidden by the credential's grants. */
async function readRow(sessionId) {
  const result = await owner.query("SELECT csrf_token FROM app.sessions WHERE id = $1", [
    sessionId,
  ]);
  return result.rows[0];
}

/** The SQLSTATE, wherever Prisma or `pg` nested it. */
function sqlState(error, depth = 0) {
  if (depth > 6 || typeof error !== "object" || error === null) return undefined;
  for (const key of ["code", "originalCode", "sqlState"]) {
    const value = error[key];
    // Prisma's own `P2010` is five characters and would otherwise mask the
    // PostgreSQL SQLSTATE nested beneath it.
    if (typeof value === "string" && /^[0-9A-Z]{5}$/.test(value) && !/^P\d{4}$/.test(value)) {
      return value;
    }
  }
  for (const value of Object.values(error)) {
    const found = sqlState(value, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

before(async () => {
  await owner.connect();
  await api.connect();
  userId = await createUser("csrf");
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

describe("the column and its constraint", () => {
  it("is nullable, present, and empty for a session created after the migration", async () => {
    const { session } = await issue();
    const row = await readRow(session.id);
    assert.equal(row.csrf_token, null, "NULL means not issued yet, not missing");
  });

  it("accepts exactly 43 base64url characters", async () => {
    const { session } = await issue();
    const value = mint();
    assert.equal(value.length, 43);

    await owner.query("UPDATE app.sessions SET csrf_token = $2 WHERE id = $1", [session.id, value]);
    assert.equal((await readRow(session.id)).csrf_token, value);
  });

  it("rejects a length or alphabet the format rule excludes, with 23514", async () => {
    const { session } = await issue();

    const rejected = [
      "A".repeat(42),
      "A".repeat(44),
      `${"A".repeat(42)}=`,
      `${"A".repeat(42)}+`,
      `${"A".repeat(42)}/`,
      `${"A".repeat(42)}.`,
      "A".repeat(42) + " ",
      "",
    ];

    for (const value of rejected) {
      await assert.rejects(
        () =>
          owner.query("UPDATE app.sessions SET csrf_token = $2 WHERE id = $1", [session.id, value]),
        (error) => {
          assert.equal(sqlState(error), "23514", `value ${JSON.stringify(value)}`);
          return true;
        },
      );
    }

    assert.equal((await readRow(session.id)).csrf_token, null, "nothing was written");
  });
});

describe("lazy initialization", () => {
  it("keeps existing NULL-token sessions valid and then mints on first retrieval", async () => {
    const { raw, session } = await issue();

    // The guard's own statement: a session from before the migration is still usable.
    const resolved = await resolveSession(auth, hashOf(raw));
    assert.equal(resolved.outcome, "active");
    assert.equal((await readRow(session.id)).csrf_token, null);

    const issued = await resolveSessionCsrfToken(auth, session.id, mint);
    assert.equal(typeof issued, "string");
    assert.equal(issued.length, 43);
    assert.equal((await readRow(session.id)).csrf_token, issued);
  });

  it("never rotates: a second retrieval returns the stored value", async () => {
    const { session } = await issue();

    const first = await resolveSessionCsrfToken(auth, session.id, mint);
    const second = await resolveSessionCsrfToken(auth, session.id, mint);
    assert.equal(second, first);
    assert.equal((await readRow(session.id)).csrf_token, first);
  });

  it("leaves one token when two retrievals race", async () => {
    const { session } = await issue();

    const [left, right] = await Promise.all([
      resolveSessionCsrfToken(auth, session.id, mint),
      resolveSessionCsrfToken(auth, session.id, mint),
    ]);

    assert.equal(left, right, "the loser adopts the winner's token");
    assert.equal((await readRow(session.id)).csrf_token, left);
  });
});

describe("a token is bound to a usable session", () => {
  it("cannot be read or minted for a revoked session", async () => {
    const { raw, session } = await issue();
    const issued = await resolveSessionCsrfToken(auth, session.id, mint);
    await revokeSession(auth, hashOf(raw));

    assert.equal(await readSessionCsrfToken(auth, session.id), null);
    assert.equal(await resolveSessionCsrfToken(auth, session.id, mint), null);
    // The column still holds the value; it is the session that is unusable, and the
    // statement's predicate is what makes the value unreachable.
    assert.equal((await readRow(session.id)).csrf_token, issued);
  });

  it("cannot be read or minted for a sliding-expired session", async () => {
    const { session } = await issue();
    await owner.query(
      `UPDATE app.sessions
          SET created_at = now() - interval '2 days',
              expires_at = now() - interval '1 second',
              absolute_expires_at = now() + interval '30 days'
        WHERE id = $1`,
      [session.id],
    );

    assert.equal(await readSessionCsrfToken(auth, session.id), null);
    assert.equal(await resolveSessionCsrfToken(auth, session.id, mint), null);
    assert.equal((await readRow(session.id)).csrf_token, null, "nothing was minted");
  });

  it("cannot be read or minted for an absolutely-expired session", async () => {
    const { session } = await issue();
    await owner.query(
      `UPDATE app.sessions
          SET created_at = now() - interval '3 days',
              expires_at = now() - interval '2 seconds',
              absolute_expires_at = now() - interval '1 second'
        WHERE id = $1`,
      [session.id],
    );

    assert.equal(await readSessionCsrfToken(auth, session.id), null);
    assert.equal(await resolveSessionCsrfToken(auth, session.id, mint), null);
  });
});

describe("privilege boundaries", () => {
  it("lets app_auth read and lazily write the one column", async () => {
    const { session } = await issue();

    const before = await auth.$queryRaw`
      SELECT csrf_token FROM app.sessions WHERE id = ${session.id}
    `;
    assert.equal(before[0].csrf_token, null);

    const value = mint();
    const written = await auth.$queryRaw`
      UPDATE app.sessions SET csrf_token = ${value}
       WHERE id = ${session.id} AND csrf_token IS NULL
      RETURNING csrf_token
    `;
    assert.equal(written[0].csrf_token, value);

    // A second claim matches no row: the credential cannot overwrite a token.
    const second = await auth.$queryRaw`
      UPDATE app.sessions SET csrf_token = ${mint()}
       WHERE id = ${session.id} AND csrf_token IS NULL
      RETURNING csrf_token
    `;
    assert.equal(second.length, 0);
    assert.equal((await readRow(session.id)).csrf_token, value);
  });

  it("gives app_api no access to csrf_token, or to the table at all", async () => {
    const { session } = await issue();
    await resolveSessionCsrfToken(auth, session.id, mint);

    await assert.rejects(
      () => api.query("SELECT csrf_token FROM app.sessions WHERE id = $1", [session.id]),
      (error) => {
        assert.equal(sqlState(error), "42501");
        return true;
      },
      "SELECT",
    );

    await assert.rejects(
      () =>
        api.query("UPDATE app.sessions SET csrf_token = $2 WHERE id = $1", [session.id, mint()]),
      (error) => {
        assert.equal(sqlState(error), "42501");
        return true;
      },
      "UPDATE",
    );

    await assert.rejects(
      () => api.query("SELECT 1 FROM app.sessions WHERE id = $1", [session.id]),
      (error) => {
        assert.equal(sqlState(error), "42501");
        return true;
      },
      "table access",
    );
  });

  it("still refuses app_auth the columns that are not granted", async () => {
    const { session } = await issue();

    for (const statement of [
      "UPDATE app.sessions SET token_hash = repeat('a', 64) WHERE id = $1",
      "UPDATE app.sessions SET absolute_expires_at = now() + interval '89 days' WHERE id = $1",
      "UPDATE app.sessions SET created_at = now() WHERE id = $1",
      "DELETE FROM app.sessions WHERE id = $1",
      "INSERT INTO app.sessions (user_id, token_hash, expires_at, absolute_expires_at, csrf_token) VALUES ($1, repeat('b', 64), now() + interval '1 day', now() + interval '2 days', repeat('c', 43))",
    ]) {
      const values = statement.includes("repeat('c'") ? [userId] : [session.id];
      await assert.rejects(
        () => auth.$queryRawUnsafe(statement, ...values),
        (error) => {
          assert.equal(sqlState(error), "42501", statement);
          return true;
        },
        statement,
      );
    }
  });
});
