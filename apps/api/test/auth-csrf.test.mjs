import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { csrfTokenResponseSchema, registeredUserSchema } from "@agroclimate/contracts";

import { AuthGuard } from "../dist/auth/auth.guard.js";
import { SESSION_COOKIE_NAME } from "../dist/auth/session-cookie.js";
import { seedSession, seedUser, startApp } from "./helpers.mjs";

/**
 * CSRF at the edges: the retrieval endpoint, the exemptions, and the guard's
 * method matrix.
 *
 * The guard is exercised directly — resolved from the running application, so it is
 * the wired instance with the real `AuthService` and `CsrfValidator` — because no
 * authenticated mutation route exists yet to send an `X-CSRF-Token` to. Everything
 * else goes through HTTP: the endpoint, the cookie, the envelopes, and the fact that
 * `Origin` still refuses a bad origin on an exempt route.
 */

const ORIGIN = "http://localhost:5173";
const PASSWORD_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const rawToken = (seed) => `${seed}`.padEnd(43, "A");
const cookieFor = (raw) => `${SESSION_COOKIE_NAME}=${raw}`;

function sessionRequest({ method, raw, headers = {} }) {
  return {
    method,
    cookies: raw === undefined ? {} : { [SESSION_COOKIE_NAME]: raw },
    headers,
  };
}

/**
 * A response that records what the guard told the browser to do, so a `Set-Cookie`
 * can be asserted on a request that never reaches a handler.
 */
function fakeResponse() {
  return {
    cookies: [],
    cleared: [],
    cookie(name, value, options) {
      this.cookies.push({ name, value, options });
    },
    clearCookie(name, options) {
      this.cleared.push({ name, options });
    },
  };
}

/** Calls `canActivate` with just enough of an `ExecutionContext`. */
function activate(guard, request, response = fakeResponse()) {
  return guard.canActivate({
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
  });
}

function seedActiveSession(database, { raw, csrfToken = null, ...overrides }) {
  const user = seedUser(database, { email: `${raw}@example.com`, passwordHash: PASSWORD_HASH });
  const session = seedSession(database, {
    userId: user.id,
    tokenHash: sha256(raw),
    csrfToken,
    ...overrides,
  });
  return { user, session };
}

describe("CSRF token retrieval", () => {
  let app;
  let base;
  let database;

  before(async () => {
    ({ app, base, database } = await startApp());
  });

  after(async () => {
    await app.close();
  });

  it("answers an authenticated session with a 43-character token and no-store", async () => {
    const raw = rawToken("retrieve");
    seedActiveSession(database, { raw });

    const response = await fetch(`${base}/v1/auth/csrf`, {
      headers: { cookie: cookieFor(raw) },
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");

    const body = await response.json();
    const parsed = csrfTokenResponseSchema.safeParse(body.data);
    assert.equal(parsed.success, true, JSON.stringify(body));
    assert.match(body.data.token, /^[A-Za-z0-9_-]{43}$/);
  });

  it("returns the same token on every later retrieval, and never rotates it", async () => {
    const raw = rawToken("stable");
    const { session } = seedActiveSession(database, { raw });
    const headers = { cookie: cookieFor(raw) };

    const first = await (await fetch(`${base}/v1/auth/csrf`, { headers })).json();
    const second = await (await fetch(`${base}/v1/auth/csrf`, { headers })).json();
    // "A second tab" is a request with the same cookie and nothing else.
    const third = await (await fetch(`${base}/v1/auth/csrf`, { headers })).json();

    assert.equal(first.data.token, second.data.token);
    assert.equal(first.data.token, third.data.token);
    assert.equal(database.state.sessions.get(session.tokenHash).csrfToken, first.data.token);
  });

  it("answers 401 for absent, malformed, revoked, and expired sessions", async () => {
    const revoked = rawToken("revoked");
    seedActiveSession(database, { raw: revoked, revokedAt: Date.now() });

    const expired = rawToken("expired");
    seedActiveSession(database, { raw: expired, expiresAt: Date.now() - 1_000 });

    const absolutely = rawToken("absolute");
    seedActiveSession(database, {
      raw: absolutely,
      absoluteExpiresAt: Date.now() - 1_000,
    });

    for (const [label, cookie] of [
      ["absent", undefined],
      ["malformed", `${SESSION_COOKIE_NAME}=nope`],
      ["revoked", cookieFor(revoked)],
      ["expired", cookieFor(expired)],
      ["absolutely expired", cookieFor(absolutely)],
    ]) {
      const response = await fetch(`${base}/v1/auth/csrf`, {
        headers: cookie === undefined ? {} : { cookie },
      });
      assert.equal(response.status, 401, label);
      const body = await response.json();
      assert.equal(body.error.code, "UNAUTHENTICATED", label);
    }
  });

  it("does not expose the token through /me, login, or registration", async () => {
    const raw = rawToken("leak");
    seedActiveSession(database, { raw });
    const headers = { cookie: cookieFor(raw) };

    const csrf = await (await fetch(`${base}/v1/auth/csrf`, { headers })).json();
    const token = csrf.data.token;

    const me = await fetch(`${base}/v1/auth/me`, { headers });
    const meBody = await me.json();
    assert.equal(registeredUserSchema.safeParse(meBody.data).success, true);
    assert.equal(JSON.stringify(meBody).includes(token), false, "/me");

    const login = await fetch(`${base}/v1/auth/login`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ email: "nobody@example.com", password: "irrelevant-passphrase" }),
    });
    assert.equal(JSON.stringify(await login.json()).includes(token), false, "login");

    const register = await fetch(`${base}/v1/auth/register`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ email: "new@example.com", password: "a long enough passphrase" }),
    });
    assert.equal(register.status, 201);
    assert.equal(JSON.stringify(await register.json()).includes(token), false, "register");
  });
});

describe("authentication routes exempt from the synchronizer token", () => {
  let app;
  let base;
  let database;

  before(async () => {
    ({ app, base, database } = await startApp());
    seedUser(database, { email: "exempt@example.com", passwordHash: PASSWORD_HASH });
  });

  after(async () => {
    await app.close();
  });

  it("keeps register, login, and logout open without X-CSRF-Token, behind Origin", async () => {
    const calls = [
      [
        "register",
        "POST",
        "/v1/auth/register",
        { email: "x@example.com", password: "a long enough passphrase" },
      ],
      [
        "login",
        "POST",
        "/v1/auth/login",
        { email: "exempt@example.com", password: "wrong passphrase" },
      ],
      ["logout", "POST", "/v1/auth/logout", undefined],
    ];

    for (const [label, method, path, body] of calls) {
      const allowed = await fetch(`${base}${path}`, {
        method,
        headers:
          body === undefined
            ? { origin: ORIGIN }
            : { origin: ORIGIN, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      assert.notEqual(allowed.status, 403, `${label} must not need a CSRF token`);

      // The independent control: Origin still refuses a foreign origin on the same
      // route, with or without a token.
      const refused = await fetch(`${base}${path}`, {
        method,
        headers:
          body === undefined
            ? { origin: "https://evil.example" }
            : { origin: "https://evil.example", "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      assert.equal(refused.status, 403, `${label} must still be Origin-checked`);
      assert.equal((await refused.json()).error.code, "FORBIDDEN", label);
    }
  });

  it("does not require a token for GET/HEAD/OPTIONS", async () => {
    const raw = rawToken("safe");
    seedActiveSession(database, { raw });
    const headers = { cookie: cookieFor(raw) };

    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      const response = await fetch(`${base}/v1/auth/me`, { method, headers });
      assert.notEqual(response.status, 401, method);
      assert.notEqual(response.status, 403, method);
    }
  });
});

describe("guard method matrix", () => {
  let app;
  let guard;
  let database;

  before(async () => {
    ({ app, database } = await startApp());
    guard = app.get(AuthGuard);
  });

  after(async () => {
    await app.close();
  });

  it("permits a protected method that presents the session's own token", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const raw = rawToken(`own-${method}`);
      const csrf = "c".repeat(42) + "A";
      seedActiveSession(database, { raw, csrfToken: csrf });

      const allowed = await activate(
        guard,
        sessionRequest({ method, raw, headers: { "x-csrf-token": csrf } }),
      );
      assert.equal(allowed, true, method);
    }
  });

  it("refuses a protected method without a token, with a malformed one, or duplicated", async () => {
    const raw = rawToken("refusals");
    const csrf = "d".repeat(42) + "A";
    seedActiveSession(database, { raw, csrfToken: csrf });

    const cases = [
      ["missing", {}],
      ["empty", { "x-csrf-token": "" }],
      ["short", { "x-csrf-token": "short" }],
      ["non-canonical", { "x-csrf-token": "A".repeat(42) + "B" }],
      ["duplicate", { "x-csrf-token": [csrf, csrf] }],
      ["joined", { "x-csrf-token": `${csrf},${csrf}` }],
    ];

    for (const [label, headers] of cases) {
      await assert.rejects(
        () => activate(guard, sessionRequest({ method: "POST", raw, headers })),
        (error) => {
          assert.equal(error.getStatus(), 403, label);
          assert.equal(error.getResponse().code, "FORBIDDEN", label);
          return true;
        },
        label,
      );
    }
  });

  it("refuses a well-formed token that belongs to a different session", async () => {
    const first = rawToken("session-one");
    const second = rawToken("session-two");
    const foreignToken = "e".repeat(42) + "A";

    seedActiveSession(database, { raw: first, csrfToken: "f".repeat(42) + "A" });
    seedActiveSession(database, { raw: second, csrfToken: foreignToken });

    await assert.rejects(
      () =>
        activate(
          guard,
          sessionRequest({
            method: "PATCH",
            raw: first,
            headers: { "x-csrf-token": foreignToken },
          }),
        ),
      (error) => error.getStatus() === 403,
    );
  });

  it("refuses a protected method when no token has been issued yet", async () => {
    const raw = rawToken("never-issued");
    seedActiveSession(database, { raw, csrfToken: null });

    await assert.rejects(
      () =>
        activate(
          guard,
          sessionRequest({ method: "POST", raw, headers: { "x-csrf-token": "A".repeat(43) } }),
        ),
      (error) => error.getStatus() === 403,
    );
  });

  it("answers 401 before any CSRF validation when there is no session", async () => {
    await assert.rejects(
      () => activate(guard, sessionRequest({ method: "POST", raw: undefined })),
      (error) => error.getStatus() === 401,
    );
  });

  it("does not consult the token on a safe method", async () => {
    const raw = rawToken("no-token-needed");
    seedActiveSession(database, { raw, csrfToken: null });

    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      assert.equal(await activate(guard, sessionRequest({ method, raw })), true, method);
    }
  });
});

describe("cookie expiry synchronization", () => {
  let app;
  let guard;
  let database;

  before(async () => {
    ({ app, database } = await startApp());
    guard = app.get(AuthGuard);
  });

  after(async () => {
    await app.close();
  });

  /** Ten minutes since the last request, so the guard's statement extends the row. */
  const stale = () => Date.now() - 10 * 60 * 1000;
  /** A slid window shorter than 30 days, so an extension is observable as a move. */
  const shortWindow = () => Date.now() + 10 * 24 * 60 * 60 * 1000;

  it("serves the extended deadline after a successful mutation", async () => {
    const raw = rawToken("extended-ok");
    const csrf = "g".repeat(42) + "A";
    const { session } = seedActiveSession(database, {
      raw,
      csrfToken: csrf,
      lastSeenAt: stale(),
      expiresAt: shortWindow(),
    });
    const seededExpiry = session.expiresAt;

    const response = fakeResponse();
    assert.equal(
      await activate(
        guard,
        sessionRequest({ method: "POST", raw, headers: { "x-csrf-token": csrf } }),
        response,
      ),
      true,
    );

    assert.equal(database.state.extensions.includes(session.tokenHash), true, "the row moved");
    assert.equal(session.expiresAt > seededExpiry, true);
    assert.equal(response.cookies.length, 1, "exactly one Set-Cookie");
    assert.equal(response.cookies[0].options.expires.getTime(), session.expiresAt);
  });

  it("serves the row deadline unchanged when the throttle holds", async () => {
    const raw = rawToken("no-extension");
    const csrf = "h".repeat(42) + "A";
    const { session } = seedActiveSession(database, { raw, csrfToken: csrf });
    const seededExpiry = session.expiresAt;

    const response = fakeResponse();
    await activate(
      guard,
      sessionRequest({ method: "POST", raw, headers: { "x-csrf-token": csrf } }),
      response,
    );

    assert.equal(database.state.extensions.includes(session.tokenHash), false, "no extension");
    assert.equal(response.cookies.length, 1);
    assert.equal(response.cookies[0].options.expires.getTime(), seededExpiry);
  });

  it("serves the extended deadline even though CSRF answers 403", async () => {
    // The bug this covers: authentication commits the extension, then the CSRF check
    // refuses, and the browser is never told — so its cookie keeps the old deadline
    // while the row has a new one. The refusal is of the request, not the session.
    const raw = rawToken("extended-403");
    const { session } = seedActiveSession(database, {
      raw,
      csrfToken: "i".repeat(42) + "A",
      lastSeenAt: stale(),
      expiresAt: shortWindow(),
    });
    const seededExpiry = session.expiresAt;

    const response = fakeResponse();
    await assert.rejects(
      () => activate(guard, sessionRequest({ method: "PUT", raw }), response),
      (error) => {
        assert.equal(error.getStatus(), 403, "still a CSRF refusal");
        assert.equal(error.getResponse().code, "FORBIDDEN");
        return true;
      },
    );

    assert.equal(
      database.state.extensions.includes(session.tokenHash),
      true,
      "the row was extended",
    );
    assert.equal(session.expiresAt > seededExpiry, true);
    assert.equal(response.cookies.length, 1, "and the browser still learned it");
    assert.equal(response.cookies[0].options.expires.getTime(), session.expiresAt);
  });

  it("serves a refreshed deadline on a safe method while the CSRF token was never issued", async () => {
    const raw = rawToken("safe-extended");
    const { session } = seedActiveSession(database, {
      raw,
      lastSeenAt: stale(),
      expiresAt: shortWindow(),
    });

    const response = fakeResponse();
    assert.equal(await activate(guard, sessionRequest({ method: "GET", raw }), response), true);

    assert.equal(response.cookies.length, 1);
    assert.equal(response.cookies[0].options.expires.getTime(), session.expiresAt);
  });

  it("writes no cookie for a session that cannot authenticate", async () => {
    const revoked = rawToken("dead-cookie");
    seedActiveSession(database, { raw: revoked, revokedAt: Date.now() });

    for (const [label, raw] of [
      ["revoked", revoked],
      ["unknown", rawToken("never-seeded")],
      ["malformed", "nope"],
      ["absent", undefined],
    ]) {
      const response = fakeResponse();
      await assert.rejects(
        () => activate(guard, sessionRequest({ method: "GET", raw }), response),
        (error) => error.getStatus() === 401,
        label,
      );
      assert.equal(response.cookies.length, 0, `${label}: no refreshed cookie`);
    }
  });

  it("keeps the clearing behaviour of an unusable session unchanged", async () => {
    const raw = rawToken("clears");
    seedActiveSession(database, { raw, revokedAt: Date.now() });

    const response = fakeResponse();
    await assert.rejects(
      () => activate(guard, sessionRequest({ method: "GET", raw }), response),
      (error) => error.getStatus() === 401,
    );

    assert.equal(response.cookies.length, 0, "nothing to refresh");
    assert.equal(response.cleared.length, 1, "the dead cookie is removed");
    assert.equal(response.cleared[0].name, SESSION_COOKIE_NAME);
    assert.equal(response.cleared[0].options.expires.getTime(), 0);
  });

  it("keeps the cookie attributes of the issued session cookie", async () => {
    const raw = rawToken("attributes");
    seedActiveSession(database, { raw, lastSeenAt: stale() });

    const response = fakeResponse();
    await activate(guard, sessionRequest({ method: "GET", raw }), response);

    const [cookie] = response.cookies;
    assert.equal(cookie.name, SESSION_COOKIE_NAME);
    assert.equal(cookie.value, raw);
    assert.equal(cookie.options.httpOnly, true);
    assert.equal(cookie.options.secure, true);
    assert.equal(cookie.options.sameSite, "lax");
    assert.equal(cookie.options.path, "/");
    assert.equal("domain" in cookie.options, false, "__Host- forbids a Domain");
  });
});
