import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { errorResponseSchema, registeredUserSchema } from "@agroclimate/contracts";

import { createPasswordHasher } from "../dist/auth/password-hasher.js";
import { startApp } from "./helpers.mjs";

const ORIGIN = "http://localhost:5173";
const PASSWORD = "correct horse battery staple";
const COOKIE = "__Host-agroclimate_session";
const FAST = { passwordHashing: { memoryCostKib: 8, timeCost: 1, parallelism: 1 } };

async function hashOf(password) {
  return createPasswordHasher(FAST.passwordHashing).hashPassword(password);
}

function call(base, path, { method = "POST", body, cookie } = {}) {
  const headers = { origin: ORIGIN };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie !== undefined) headers.cookie = cookie;

  return fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function setCookies(response) {
  return response.headers.getSetCookie();
}

/** The raw token from a `Set-Cookie`, or `null`. */
function tokenFrom(response) {
  const header = setCookies(response).find((entry) => entry.startsWith(`${COOKIE}=`));
  if (header === undefined) return null;
  return header.slice(COOKIE.length + 1).split(";")[0];
}

describe("POST /v1/auth/login", () => {
  let app;
  let base;
  let database;

  before(async () => {
    ({ app, base, database } = await startApp({ config: FAST }));
  });

  after(async () => {
    await app.close();
  });

  async function seedAccount(email) {
    database.state.users.set(email, {
      id: "01930000-0000-7000-8000-0000000000aa",
      email,
      passwordHash: await hashOf(PASSWORD),
      role: "owner",
      locale: "id",
      timezone: "Asia/Jakarta",
    });
  }

  it("issues the approved cookie and a safe body", async () => {
    await seedAccount("login@example.com");

    const response = await call(base, "/v1/auth/login", {
      body: { email: "  Login@Example.com ", password: PASSWORD },
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(Object.keys(body), ["data"]);
    assert.equal(registeredUserSchema.safeParse(body.data).success, true);
    assert.equal(body.data.email, "login@example.com");

    const serialised = JSON.stringify(body);
    assert.equal(serialised.includes(PASSWORD), false);
    assert.equal(serialised.includes("$argon2"), false);
    assert.equal(serialised.includes("passwordHash"), false);

    const token = tokenFrom(response);
    assert.notEqual(token, null);
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(serialised.includes(token), false, "the token belongs only in the cookie");

    const header = setCookies(response).find((entry) => entry.startsWith(`${COOKIE}=`));
    assert.match(header, /; HttpOnly/i);
    assert.match(header, /; Secure/i);
    assert.match(header, /; SameSite=Lax/i);
    assert.match(header, /; Path=\//i);
    assert.match(header, /; Expires=/i);
    assert.equal(/;\s*Domain=/i.test(header), false, "the __Host- prefix forbids Domain");
  });

  it("persists only the SHA-256 hash of the presented token", async () => {
    await seedAccount("hash@example.com");

    const response = await call(base, "/v1/auth/login", {
      body: { email: "hash@example.com", password: PASSWORD },
    });
    const token = tokenFrom(response);
    const expected = createHash("sha256").update(token, "utf8").digest("hex");

    assert.equal(database.state.sessions.has(expected), true);
    assert.equal(
      [...database.state.sessions.keys()].some((key) => key === token),
      false,
      "the raw token must never be stored",
    );
  });

  it("answers an unknown address and a wrong password identically", async () => {
    await seedAccount("known@example.com");
    const sessionsBefore = database.state.sessions.size;

    const wrongPassword = await call(base, "/v1/auth/login", {
      body: { email: "known@example.com", password: "definitely the wrong password" },
    });
    const unknownEmail = await call(base, "/v1/auth/login", {
      body: { email: "nobody@example.com", password: "definitely the wrong password" },
    });

    assert.equal(wrongPassword.status, 401);
    assert.equal(unknownEmail.status, 401);

    const first = await wrongPassword.json();
    const second = await unknownEmail.json();
    assert.equal(errorResponseSchema.safeParse(first).success, true);
    assert.equal(errorResponseSchema.safeParse(second).success, true);
    assert.equal(first.error.code, "UNAUTHENTICATED");
    assert.equal(second.error.code, "UNAUTHENTICATED");
    assert.equal(first.error.message, second.error.message);
    assert.deepEqual(Object.keys(first.error).sort(), Object.keys(second.error).sort());
    assert.equal("details" in first.error, false);

    assert.equal(setCookies(wrongPassword).length, 0);
    assert.equal(setCookies(unknownEmail).length, 0);

    // The dummy verification means neither path creates a session.
    assert.equal(database.state.sessions.size, sessionsBefore);
  });

  it("rejects a malformed body and an unknown key", async () => {
    const malformed = await call(base, "/v1/auth/login", { body: { email: "not-an-address" } });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error.code, "VALIDATION_FAILED");

    const extra = await call(base, "/v1/auth/login", {
      body: { email: "a@b.example", password: PASSWORD, userId: "attacker" },
    });
    assert.equal(extra.status, 400);
  });
});

describe("authenticated routes", () => {
  let app;
  let base;
  let database;
  let token;
  let user;

  before(async () => {
    ({ app, base, database } = await startApp({ config: FAST }));
    user = {
      id: "01930000-0000-7000-8000-0000000000bb",
      email: "me@example.com",
      passwordHash: await hashOf(PASSWORD),
      role: "owner",
      locale: "id",
      timezone: "Asia/Jakarta",
    };
    database.state.users.set(user.email, user);

    const response = await call(base, "/v1/auth/login", {
      body: { email: user.email, password: PASSWORD },
    });
    token = tokenFrom(response);
  });

  after(async () => {
    await app.close();
  });

  const cookie = () => `${COOKIE}=${token}`;

  it("returns the current subject from a validated session", async () => {
    const response = await call(base, "/v1/auth/me", { method: "GET", cookie: cookie() });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(registeredUserSchema.safeParse(body.data).success, true);
    assert.equal(body.data.email, user.email);
    assert.equal(JSON.stringify(body).includes("passwordHash"), false);
    assert.equal(JSON.stringify(body).includes(token), false);
  });

  it("refuses a request with no cookie", async () => {
    const response = await call(base, "/v1/auth/me", { method: "GET" });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, "UNAUTHENTICATED");
  });

  it("refuses a malformed cookie without querying the database", async () => {
    const before = database.state.authStatements.length;

    const response = await call(base, "/v1/auth/me", {
      method: "GET",
      cookie: `${COOKIE}=too-short`,
    });

    assert.equal(response.status, 401);
    assert.equal(database.state.authStatements.length, before);
  });

  it("refuses a revoked session and clears the cookie", async () => {
    const session = database.state.sessions.get(
      createHash("sha256").update(token, "utf8").digest("hex"),
    );
    session.revokedAt = Date.now();

    const response = await call(base, "/v1/auth/me", { method: "GET", cookie: cookie() });
    assert.equal(response.status, 401);
    assert.match(setCookies(response).join(";"), new RegExp(`${COOKIE}=;`));

    session.revokedAt = null;
  });

  it("refuses an expired session", async () => {
    const session = database.state.sessions.get(
      createHash("sha256").update(token, "utf8").digest("hex"),
    );
    const original = session.expiresAt;
    session.expiresAt = Date.now() - 1_000;

    const response = await call(base, "/v1/auth/me", { method: "GET", cookie: cookie() });
    assert.equal(response.status, 401);

    session.expiresAt = original;
  });

  it("refreshes the cookie only when the database extended the session", async () => {
    const hash = createHash("sha256").update(token, "utf8").digest("hex");
    const session = database.state.sessions.get(hash);

    const quiet = await call(base, "/v1/auth/me", { method: "GET", cookie: cookie() });
    assert.equal(database.state.extensions.length, 0, "inside the five-minute throttle");
    const quietHeader = setCookies(quiet).join(";");
    assert.match(quietHeader, /Expires=/);
    assert.equal(
      new Date(quietHeader.match(/Expires=([^;]+)/)[1]).getTime(),
      Math.floor(session.expiresAt / 1000) * 1000,
    );

    session.lastSeenAt = Date.now() - 6 * 60 * 1000;
    const extended = await call(base, "/v1/auth/me", { method: "GET", cookie: cookie() });

    assert.equal(database.state.extensions.length, 1);
    const extendedHeader = setCookies(extended).join(";");
    assert.equal(
      new Date(extendedHeader.match(/Expires=([^;]+)/)[1]).getTime(),
      Math.floor(session.expiresAt / 1000) * 1000,
    );
    assert.equal(session.expiresAt <= session.absoluteExpiresAt, true);
  });

  it("revokes on logout, clears the cookie, and is idempotent", async () => {
    const first = await call(base, "/v1/auth/logout", { body: {}, cookie: cookie() });
    assert.equal(first.status, 204);
    assert.match(setCookies(first).join(";"), new RegExp(`${COOKIE}=;`));
    assert.match(setCookies(first).join(";"), /Expires=Thu, 01 Jan 1970/);

    const afterLogout = await call(base, "/v1/auth/me", { method: "GET", cookie: cookie() });
    assert.equal(afterLogout.status, 401);

    const second = await call(base, "/v1/auth/logout", { body: {}, cookie: cookie() });
    assert.equal(second.status, 204);
    assert.equal(database.state.sessions.size, 1, "logout never deletes the row");
  });

  it("logs out without a cookie", async () => {
    const response = await call(base, "/v1/auth/logout", { body: {} });
    assert.equal(response.status, 204);
  });
});

describe("shared auth rate limit", () => {
  let app;
  let base;
  let database;

  before(async () => {
    ({ app, base, database } = await startApp({ config: FAST }));
  });

  after(async () => {
    await app.close();
  });

  it("counts registration and login against one quota", async () => {
    for (let index = 0; index < 20; index += 1) {
      const response = await call(base, "/v1/auth/register", {
        body: { email: `quota-${index}@example.com`, password: PASSWORD },
      });
      assert.equal(response.status, 201);
    }

    for (let index = 0; index < 10; index += 1) {
      const response = await call(base, "/v1/auth/login", {
        body: { email: "nobody@example.com", password: PASSWORD },
      });
      assert.equal(response.status, 401, `login ${index + 1} should be verified, not limited`);
    }

    const refused = await call(base, "/v1/auth/login", {
      body: { email: "nobody@example.com", password: PASSWORD },
    });

    assert.equal(refused.status, 429);
    assert.equal((await refused.json()).error.code, "RATE_LIMITED");
    assert.ok(Number(refused.headers.get("retry-after")) >= 1);

    const before = database.state.authStatements.length;
    const afterRefusal = await call(base, "/v1/auth/login", {
      body: { email: "nobody@example.com", password: PASSWORD },
    });
    assert.equal(afterRefusal.status, 429);
    assert.equal(database.state.authStatements.length, before, "a refused request must not query");
  });
});
