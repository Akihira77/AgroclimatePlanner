/**
 * Registration against the real PostgreSQL roles (S7, `H-2`).
 *
 * Unit tests use doubles, and a double cannot prove `app_auth` may insert and the
 * tenant role may not read the hash. Every assertion here runs as the real role
 * against a migrated database.
 *
 * Requires `NODE_ENV=development` and the role bootstrap (the same prerequisite as
 * `test:rls`). Run: pnpm --filter @agroclimate/database test:integration
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { Client } from "pg";

import {
  createPrismaClient,
  EmailAlreadyRegisteredError,
  insertRegisteredUser,
} from "../../dist/index.js";
import { roleConnectionString } from "../../scripts/lib/connections.mjs";

const auth = createPrismaClient({ connectionString: roleConnectionString("app_auth") });
const owner = new Client({ connectionString: roleConnectionString("migration_owner") });
const api = new Client({ connectionString: roleConnectionString("app_api") });

/** Ids this run created, so cleanup can never reach past them. */
const created = new Set();
const emailFor = (label) => `${label}-${randomBytes(6).toString("hex")}@s7-integration.test`;
const PASSWORD_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

async function fetchUser(email) {
  const result = await owner.query(
    "SELECT id, email, password_hash, role, locale, timezone, created_at FROM app.users WHERE email = $1",
    [email],
  );
  return result.rows[0];
}

before(async () => {
  await owner.connect();
  await api.connect();
});

after(async () => {
  try {
    if (created.size > 0) {
      await owner.query("DELETE FROM app.users WHERE id = ANY($1::uuid[])", [[...created]]);
    }
  } finally {
    await owner.end();
    await api.end();
    await auth.$disconnect();
  }
});

describe("app_auth registration boundary", () => {
  it("connects as app_auth, not the tenant role", async () => {
    const rows = await auth.$queryRaw`SELECT current_user AS role`;
    assert.equal(rows[0].role, "app_auth");
  });

  it("inserts a user and returns only the granted columns", async () => {
    const email = emailFor("insert");
    const user = await insertRegisteredUser(auth, email, PASSWORD_HASH);
    created.add(user.id);

    assert.equal(user.email, email);
    assert.equal(user.role, "owner");
    assert.equal(user.locale, "id");
    assert.equal(user.timezone, "Asia/Jakarta");
    assert.equal("createdAt" in user, false);
    assert.equal("created_at" in user, false);
    assert.equal("passwordHash" in user, false);

    const stored = await fetchUser(email);
    assert.equal(stored.password_hash, PASSWORD_HASH, "the supplied hash, not the plaintext");
    assert.equal(stored.password_hash.includes("correct horse"), false);
  });

  it("maps a duplicate address to EmailAlreadyRegisteredError", async () => {
    const email = emailFor("duplicate");
    const first = await insertRegisteredUser(auth, email, PASSWORD_HASH);
    created.add(first.id);

    await assert.rejects(
      () => insertRegisteredUser(auth, email, PASSWORD_HASH),
      EmailAlreadyRegisteredError,
    );
  });

  it("lets exactly one of two concurrent inserts win", async () => {
    const email = emailFor("concurrent");
    const outcomes = await Promise.allSettled([
      insertRegisteredUser(auth, email, PASSWORD_HASH),
      insertRegisteredUser(auth, email, PASSWORD_HASH),
    ]);

    const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected");

    assert.equal(fulfilled.length, 1, "exactly one insert must succeed");
    assert.equal(rejected.length, 1, "the loser must be refused, not silently dropped");
    assert.ok(rejected[0].reason instanceof EmailAlreadyRegisteredError);

    created.add(fulfilled[0].value.id);

    const count = await owner.query("SELECT count(*)::int AS n FROM app.users WHERE email = $1", [
      email,
    ]);
    assert.equal(count.rows[0].n, 1);
  });

  it("keeps the tenant role unable to read or write credentials", async () => {
    const email = emailFor("api-boundary");
    const user = await insertRegisteredUser(auth, email, PASSWORD_HASH);
    created.add(user.id);

    await assert.rejects(
      () => api.query("SELECT password_hash FROM app.users LIMIT 1"),
      (error) => error.code === "42501",
    );
    await assert.rejects(
      () =>
        api.query("INSERT INTO app.users (email, password_hash) VALUES ($1, $2)", [
          emailFor("api-write"),
          PASSWORD_HASH,
        ]),
      (error) => error.code === "42501",
    );
  });

  it("leaves the database constraint as the duplicate authority", async () => {
    const email = emailFor("constraint");
    await assert.rejects(
      () =>
        owner
          .query("INSERT INTO app.users (email, password_hash) VALUES ($1, $2)", [
            email,
            PASSWORD_HASH,
          ])
          .then(() =>
            owner.query("INSERT INTO app.users (email, password_hash) VALUES ($1, $2)", [
              email,
              PASSWORD_HASH,
            ]),
          ),
      (error) => error.code === "23505",
    );
  });
});
