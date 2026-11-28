/**
 * AUTH-14 change password and MOD-11 health/status integration verification.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { ORIGIN, cleanupUsers, startHarness, stopHarness } from "./support.mjs";

const EMAIL_PREFIX = "pwd-chg-";

let harness;

before(async () => {
  harness = await startHarness();
});

after(async () => {
  await cleanupUsers(harness.owner, EMAIL_PREFIX);
  await stopHarness(harness);
});

describe("POST /v1/auth/password (AUTH-14) & GET /health/status (MOD-11)", () => {
  it("changes password, revokes other sessions, keeps current session, and rejects invalid attempts", async () => {
    const email = `${EMAIL_PREFIX}${Date.now()}@example.test`;
    const oldPassword = "OldStrongPassword!123";
    const newPassword = "NewStrongPassword!456";

    const reg = await fetch(`${harness.base}/v1/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ email, password: oldPassword }),
    });
    assert.equal(reg.status, 201);

    // Session 1 (caller) and Session 2 (other device)
    const login1 = await fetch(`${harness.base}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ email, password: oldPassword }),
    });
    assert.equal(login1.status, 200);
    const cookie1 = login1.headers.get("set-cookie").split(";")[0];

    const login2 = await fetch(`${harness.base}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ email, password: oldPassword }),
    });
    assert.equal(login2.status, 200);
    const cookie2 = login2.headers.get("set-cookie").split(";")[0];

    const csrfRes = await fetch(`${harness.base}/v1/auth/csrf`, {
      headers: { cookie: cookie1 },
    });
    assert.equal(csrfRes.status, 200);
    const { data: csrfData } = await csrfRes.json();

    // Missing CSRF -> 403
    const noCsrf = await fetch(`${harness.base}/v1/auth/password`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, cookie: cookie1 },
      body: JSON.stringify({ currentPassword: oldPassword, newPassword }),
    });
    assert.equal(noCsrf.status, 403);

    // Identical password -> 400
    const identical = await fetch(`${harness.base}/v1/auth/password`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        cookie: cookie1,
        "x-csrf-token": csrfData.token,
      },
      body: JSON.stringify({ currentPassword: oldPassword, newPassword: oldPassword }),
    });
    assert.equal(identical.status, 400);

    // Wrong current password -> 401
    const wrongCurrent = await fetch(`${harness.base}/v1/auth/password`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        cookie: cookie1,
        "x-csrf-token": csrfData.token,
      },
      body: JSON.stringify({ currentPassword: "WrongPassword!999", newPassword }),
    });
    assert.equal(wrongCurrent.status, 401);

    // Valid change -> 204
    const ok = await fetch(`${harness.base}/v1/auth/password`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        cookie: cookie1,
        "x-csrf-token": csrfData.token,
      },
      body: JSON.stringify({ currentPassword: oldPassword, newPassword }),
    });
    assert.equal(ok.status, 204);

    // Caller session remains active
    const me1 = await fetch(`${harness.base}/v1/auth/me`, { headers: { cookie: cookie1 } });
    assert.equal(me1.status, 200);

    // Other device session was revoked
    const me2 = await fetch(`${harness.base}/v1/auth/me`, { headers: { cookie: cookie2 } });
    assert.equal(me2.status, 401);

    // Old password cannot log in; new password can
    const oldLogin = await fetch(`${harness.base}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ email, password: oldPassword }),
    });
    assert.equal(oldLogin.status, 401);

    const newLogin = await fetch(`${harness.base}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ email, password: newPassword }),
    });
    assert.equal(newLogin.status, 200);
  });

  it("GET /v1/health/status returns non-sensitive operational status", async () => {
    const res = await fetch(`${harness.base}/v1/health/status`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "ok");
    assert.equal(typeof body.uptimeSec, "number");
    assert.equal(typeof body.catalog.crops, "number");
    assert.equal(typeof body.catalog.publishedProfiles, "number");
    assert.equal(typeof body.weather.forecastRuns, "number");
  });
});
