import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createHash } from "node:crypto";

import { AuthService } from "../dist/auth/auth.service.js";
import { MalformedPasswordHashError } from "../dist/auth/password-hasher.js";
import { isWellFormedSessionToken } from "../dist/auth/session-token.js";
import { seedSession, seedUser, testDatabase } from "./helpers.mjs";

/**
 * The verification policy, without HTTP.
 *
 * These assertions are about *which* failures are one public failure and which are
 * not: uniform `null` for unknown address, wrong password, and unreadable hash;
 * propagation for an operational fault. A stub hasher makes that visible, because
 * a real Argon2 run cannot be told to fail on demand.
 */

function stubHasher(overrides = {}) {
  const calls = { hashed: 0, verified: [] };

  return {
    calls,
    hasher: {
      async hashPassword() {
        calls.hashed += 1;
        return "$argon2id$v=19$m=8,t=1,p=1$ZHVtbXlkdW1teWR1bW15$ZHVtbXlkdW1teWR1bW15ZHVtbXlkdW1teWR1bW15";
      },
      async verifyPassword(hash, password) {
        calls.verified.push({ hash, password });
        return false;
      },
      ...overrides,
    },
  };
}

function setup(hasherOverrides = {}) {
  const database = testDatabase();
  const client = database.factory("postgresql://app_auth:test@127.0.0.1:1/agroclimate");
  const { calls, hasher } = stubHasher(hasherOverrides);
  return { database, calls, hasher, service: new AuthService(client, hasher) };
}

const DUMMY =
  "$argon2id$v=19$m=8,t=1,p=1$ZHVtbXlkdW1teWR1bW15$ZHVtbXlkdW1teWR1bW15ZHVtbXlkdW1teWR1bW15";

describe("uniform credential verification", () => {
  it("returns null for an unknown address after doing the dummy work", async () => {
    const { calls, service } = setup();

    assert.equal(await service.login("nobody@example.com", "correct horse battery staple"), null);
    assert.equal(calls.verified.length, 1);
    assert.equal(calls.verified[0].hash, DUMMY);
    assert.equal(calls.hashed, 1);
  });

  it("reuses one dummy hash across failures instead of hashing per attempt", async () => {
    const { calls, service } = setup();

    await service.login("nobody@example.com", "first attempt password");
    await service.login("nobody@example.com", "second attempt password");
    await service.login("nobody@example.com", "third attempt password");

    assert.equal(calls.hashed, 1);
    assert.equal(calls.verified.length, 3);
    assert.deepEqual(new Set(calls.verified.map((call) => call.hash)).size, 1);
  });

  it("returns null for a wrong password, verifying against the stored hash", async () => {
    const { database, calls, service } = setup();
    seedUser(database, { email: "user@example.com", passwordHash: "stored-hash" });

    assert.equal(await service.login("user@example.com", "wrong password value"), null);
    assert.equal(calls.verified.length, 1);
    assert.equal(calls.verified[0].hash, "stored-hash");
  });

  it("returns null for an unreadable stored hash, with no extra query and dummy work", async () => {
    const { database, calls, service } = setup({
      async verifyPassword(hash, password) {
        calls.verified.push({ hash, password });
        if (hash !== DUMMY) throw new MalformedPasswordHashError();
        return false;
      },
    });
    seedUser(database, { email: "broken@example.com", passwordHash: "not-a-hash" });

    assert.equal(await service.login("broken@example.com", "correct horse battery staple"), null);
    assert.deepEqual(
      calls.verified.map((call) => call.hash),
      ["not-a-hash", DUMMY],
      "the stored value is attempted, then the dummy path",
    );
  });

  it("propagates an operational verification failure instead of reporting 401", async () => {
    const { database, service } = setup({
      async verifyPassword() {
        throw new Error("native argon2 failure: could not allocate memory");
      },
    });
    seedUser(database, { email: "user@example.com", passwordHash: "stored-hash" });

    await assert.rejects(
      () => service.login("user@example.com", "correct horse battery staple"),
      /native argon2 failure/,
    );
  });

  it("issues a session only after the password matched", async () => {
    const { database, calls, service } = setup({
      async verifyPassword() {
        calls.verified.push({ hash: "stored-hash", password: "unused" });
        return false;
      },
    });
    seedUser(database, { email: "user@example.com", passwordHash: "stored-hash" });

    await service.login("user@example.com", "wrong");
    assert.equal(database.state.sessions.size, 0);
  });
});

describe("session issuance", () => {
  it("returns a 43-character token, stores only its SHA-256 hash, and hides the hash", async () => {
    const { database, service } = setup({
      async verifyPassword() {
        return true;
      },
    });
    const user = seedUser(database, {
      email: "user@example.com",
      passwordHash: "stored-hash",
    });

    const result = await service.login("user@example.com", "correct horse battery staple");
    assert.notEqual(result, null);

    assert.equal(isWellFormedSessionToken(result.token), true);
    assert.equal(result.token.length, 43);

    const expectedHash = createHash("sha256").update(result.token, "utf8").digest("hex");
    const [session] = [...database.state.sessions.values()];
    assert.equal(session.tokenHash, expectedHash);
    assert.equal(session.tokenHash.length, 64);
    assert.equal(JSON.stringify(session).includes(result.token), false);

    assert.deepEqual(result.user, {
      id: user.id,
      email: "user@example.com",
      role: "owner",
      locale: "id",
      timezone: "Asia/Jakarta",
    });
    assert.equal("passwordHash" in result.user, false);
    assert.equal(JSON.stringify(result).includes("stored-hash"), false);
  });
});

describe("session validation", () => {
  const TOKEN = "A".repeat(43);
  const HASH = createHash("sha256").update(TOKEN, "utf8").digest("hex");

  it("resolves an active session to its user", async () => {
    const { database, service } = setup();
    const user = seedUser(database, { email: "user@example.com", passwordHash: "hash" });
    seedSession(database, { userId: user.id, tokenHash: HASH });

    const check = await service.authenticate(TOKEN);
    assert.notEqual(check, null);
    assert.equal(check.user.id, user.id);
    assert.equal(check.sessionId.length > 0, true);
  });

  it("returns null for an unknown token", async () => {
    const { service } = setup();
    assert.equal(await service.authenticate("B".repeat(43)), null);
  });

  it("returns null for a revoked, expired, or absolutely expired session", async () => {
    const { database, service } = setup();
    const user = seedUser(database, { email: "user@example.com", passwordHash: "hash" });

    seedSession(database, { userId: user.id, tokenHash: HASH, revokedAt: Date.now() });
    assert.equal(await service.authenticate(TOKEN), null);

    seedSession(database, {
      userId: user.id,
      tokenHash: HASH,
      expiresAt: Date.now() - 1_000,
    });
    assert.equal(await service.authenticate(TOKEN), null);

    const now = Date.now();
    seedSession(database, {
      userId: user.id,
      tokenHash: HASH,
      expiresAt: now + 1_000,
      absoluteExpiresAt: now - 1_000,
    });
    assert.equal(await service.authenticate(TOKEN), null);
  });

  it("does not extend a session inside the five-minute throttle", async () => {
    const { database, service } = setup();
    const user = seedUser(database, { email: "user@example.com", passwordHash: "hash" });
    seedSession(database, { userId: user.id, tokenHash: HASH });

    await service.authenticate(TOKEN);
    assert.equal(database.state.extensions.length, 0);
  });

  it("still authenticates when the throttle holds, and keeps the old deadline", async () => {
    // The distinction the previous two-call shape lost: `extendSession` returned
    // `null` for "throttled" *and* for "revoked", so the caller could fall back to
    // stale data. A throttled extension is a successful authentication.
    const { database, service } = setup();
    const user = seedUser(database, { email: "user@example.com", passwordHash: "hash" });
    const seeded = seedSession(database, {
      userId: user.id,
      tokenHash: HASH,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    });

    const check = await service.authenticate(TOKEN);
    assert.notEqual(check, null);
    assert.equal(database.state.extensions.length, 0, "inside the throttle");
    assert.equal(check.expiresAt.getTime(), Math.floor(seeded.expiresAt));
  });

  it("returns null when the session was revoked between the read and the write", async () => {
    // The double cannot hold a row lock, so this models the observable outcome of
    // the race: the statement sees a revoked row and reports `revoked`, not
    // "throttled". The lock that makes the real database behave this way is proven
    // in the integration suite.
    const { database, service } = setup();
    const user = seedUser(database, { email: "user@example.com", passwordHash: "hash" });
    seedSession(database, {
      userId: user.id,
      tokenHash: HASH,
      revokedAt: Date.now(),
      lastSeenAt: Date.now() - 6 * 60 * 1000,
    });

    assert.equal(await service.authenticate(TOKEN), null);
    assert.equal(database.state.extensions.length, 0);
  });

  it("answers 503 when the session store is unreachable", async () => {
    const client = {
      async $queryRaw() {
        throw Object.assign(new Error("connect ECONNREFUSED"), { code: "P1001" });
      },
    };
    const { hasher } = stubHasher();
    const service = new AuthService(client, hasher);

    await assert.rejects(
      () => service.authenticate("A".repeat(43)),
      (error) => {
        assert.equal(error.getStatus(), 503);
        assert.equal(error.getResponse().code, "DEPENDENCY_UNAVAILABLE");
        return true;
      },
    );
  });

  it("extends once the throttle window has passed, and reports the new deadline", async () => {
    const { database, service } = setup();
    const user = seedUser(database, { email: "user@example.com", passwordHash: "hash" });
    seedSession(database, {
      userId: user.id,
      tokenHash: HASH,
      // A deadline visibly behind the 30-day window, so the assertion is about the
      // extension rather than about two calls landing in the same millisecond.
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      lastSeenAt: Date.now() - 6 * 60 * 1000,
    });

    const before = database.state.sessions.get(HASH).expiresAt;
    const check = await service.authenticate(TOKEN);

    assert.equal(database.state.extensions.length, 1);
    assert.equal(
      check.expiresAt.getTime(),
      Math.floor(database.state.sessions.get(HASH).expiresAt),
    );
    assert.equal(check.expiresAt.getTime() > before, true);
  });

  it("does not extend a revoked session", async () => {
    const { database, service } = setup();
    const user = seedUser(database, { email: "user@example.com", passwordHash: "hash" });
    seedSession(database, {
      userId: user.id,
      tokenHash: HASH,
      revokedAt: Date.now(),
      lastSeenAt: Date.now() - 6 * 60 * 1000,
    });

    assert.equal(await service.authenticate(TOKEN), null);
    assert.equal(database.state.extensions.length, 0);
  });
});

describe("CSRF token issuance", () => {
  it("mints once and then returns the stored value", async () => {
    const { database, service } = setup();
    const user = seedUser(database, { email: "csrf@example.com", passwordHash: "hash" });
    const session = seedSession(database, { userId: user.id, tokenHash: "a".repeat(64) });

    const first = await service.issueCsrfToken(session.id);
    const second = await service.issueCsrfToken(session.id);

    assert.match(first, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(second, first, "a retrieval must never rotate the token");
    assert.equal(database.state.sessions.get(session.tokenHash).csrfToken, first);
  });

  it("keeps one token when two retrievals race", async () => {
    const { database, service } = setup();
    const user = seedUser(database, { email: "race@example.com", passwordHash: "hash" });
    const session = seedSession(database, { userId: user.id, tokenHash: "b".repeat(64) });

    const [left, right] = await Promise.all([
      service.issueCsrfToken(session.id),
      service.issueCsrfToken(session.id),
    ]);

    assert.equal(left, right, "the loser adopts the winner's token");
    assert.equal(database.state.sessions.get(session.tokenHash).csrfToken, left);
  });

  it("returns null for a session that is no longer usable, and mints nothing", async () => {
    const { database, service } = setup();
    const user = seedUser(database, { email: "dead@example.com", passwordHash: "hash" });
    const session = seedSession(database, {
      userId: user.id,
      tokenHash: "c".repeat(64),
      revokedAt: Date.now(),
    });

    assert.equal(await service.issueCsrfToken(session.id), null);
    assert.equal(database.state.sessions.get(session.tokenHash).csrfToken, null);
    assert.equal(await service.storedCsrfToken(session.id), null);
  });

  it("propagates an unreachable session store as 503, never as a CSRF failure", async () => {
    const client = {
      async $queryRaw() {
        throw Object.assign(new Error("connect ECONNREFUSED"), { code: "P1001" });
      },
    };
    const { hasher } = stubHasher();
    const service = new AuthService(client, hasher);

    await assert.rejects(
      () => service.issueCsrfToken("01a1fca5-f4c1-7fba-860a-d013ac82089c"),
      (error) => {
        assert.equal(error.getStatus(), 503);
        assert.equal(error.getResponse().code, "DEPENDENCY_UNAVAILABLE");
        return true;
      },
    );
    await assert.rejects(
      () => service.storedCsrfToken("01a1fca5-f4c1-7fba-860a-d013ac82089c"),
      (error) => error.getStatus() === 503,
    );
  });
});

describe("logout", () => {
  it("revokes the matching session and is idempotent", async () => {
    const { database, service } = setup();
    const user = seedUser(database, { email: "user@example.com", passwordHash: "hash" });
    const token = "C".repeat(43);
    const tokenHash = createHash("sha256").update(token, "utf8").digest("hex");
    seedSession(database, { userId: user.id, tokenHash });

    await service.logout(token);
    const session = database.state.sessions.get(tokenHash);
    assert.notEqual(session.revokedAt, null);

    const firstRevocation = session.revokedAt;
    await service.logout(token);
    assert.equal(session.revokedAt, firstRevocation, "a second logout must not rewrite the time");
    assert.equal(database.state.sessions.size, 1, "logout never deletes");
  });
});
