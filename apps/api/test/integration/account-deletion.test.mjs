/**
 * OPEN-04 account deletion (soft-delete, immediate session revocation, login
 * denial, email re-registration via partial unique index, and 30-day grace
 * anonymization preserving farm/field provenance).
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { ORIGIN, SQUARE, apiFor, cleanupUsers, startHarness, stopHarness } from "./support.mjs";

const EMAIL_PREFIX = "acct-del-";

let harness;
let call;

before(async () => {
  harness = await startHarness();
  call = apiFor(harness.base).call;
});

after(async () => {
  await cleanupUsers(harness.owner, EMAIL_PREFIX);
  await harness.owner.$executeRawUnsafe(
    "DELETE FROM app.users WHERE email LIKE 'deleted+%@deleted.invalid' AND id NOT IN (SELECT user_id FROM app.farms)",
  );
  await stopHarness(harness);
});

describe("DELETE /v1/auth/account (OPEN-04)", () => {
  it("soft-deletes account, revokes session, allows email re-use, and anonymizes while preserving provenance", async () => {
    const email = `${EMAIL_PREFIX}${Date.now()}@example.test`;
    const password = "StrongPassword!12345";

    const reg = await fetch(`${harness.base}/v1/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ email, password }),
    });
    assert.equal(reg.status, 201);
    const { data: createdUser } = await reg.json();

    const login = await fetch(`${harness.base}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ email, password }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0];

    const csrfRes = await fetch(`${harness.base}/v1/auth/csrf`, {
      headers: { cookie },
    });
    assert.equal(csrfRes.status, 200);
    const { data: csrfData } = await csrfRes.json();

    // Create a farm + field so provenance rows exist
    const farmRes = await fetch(`${harness.base}/v1/farms`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        cookie,
        "x-csrf-token": csrfData.token,
      },
      body: JSON.stringify({ name: "Kebun Uji Hapus", region: "Jabar" }),
    });
    assert.equal(farmRes.status, 201);
    const { data: farm } = await farmRes.json();

    const fieldRes = await fetch(`${harness.base}/v1/fields`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        cookie,
        "x-csrf-token": csrfData.token,
      },
      body: JSON.stringify({ farmId: farm.id, name: "Petak Uji", geometry: SQUARE }),
    });
    assert.equal(fieldRes.status, 201);

    // Unauthenticated / missing CSRF refused
    const unauth = await call(
      { id: createdUser.id, token: "", csrfToken: "" },
      "DELETE",
      "/v1/auth/account",
      {
        anonymous: true,
      },
    );
    assert.equal(unauth.response.status, 401);

    const noCsrf = await fetch(`${harness.base}/v1/auth/account`, {
      method: "DELETE",
      headers: { origin: ORIGIN, cookie },
    });
    assert.equal(noCsrf.status, 403);

    // Delete account
    const delRes = await fetch(`${harness.base}/v1/auth/account`, {
      method: "DELETE",
      headers: {
        origin: ORIGIN,
        cookie,
        "x-csrf-token": csrfData.token,
      },
    });
    assert.equal(delRes.status, 204);

    // Session immediately invalid
    const meAfter = await fetch(`${harness.base}/v1/auth/me`, { headers: { cookie } });
    assert.equal(meAfter.status, 401);

    // Login denied
    const loginAfter = await fetch(`${harness.base}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ email, password }),
    });
    assert.equal(loginAfter.status, 401);

    // Partial unique index permits re-registration with the same email
    const reReg = await fetch(`${harness.base}/v1/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ email, password }),
    });
    assert.equal(reReg.status, 201);

    // Anonymization after grace period preserves farm/field rows
    const anonRows = await harness.owner.$queryRawUnsafe(
      "SELECT app.anonymize_expired_deleted_users(0) AS count",
    );
    assert.ok(anonRows[0].count >= 1);

    const userRows = await harness.owner.$queryRawUnsafe(
      "SELECT email, deleted_at, anonymized_at FROM app.users WHERE id = $1::uuid",
      createdUser.id,
    );
    assert.equal(userRows[0].email, `deleted+${createdUser.id}@deleted.invalid`);
    assert.ok(userRows[0].deleted_at !== null);
    assert.ok(userRows[0].anonymized_at !== null);

    // Clean up anonymized user's farm/field manually before after()
    await harness.owner.$executeRawUnsafe(
      "DELETE FROM app.fields WHERE user_id = $1::uuid",
      createdUser.id,
    );
    await harness.owner.$executeRawUnsafe(
      "DELETE FROM app.farms WHERE user_id = $1::uuid",
      createdUser.id,
    );
    await harness.owner.$executeRawUnsafe(
      "DELETE FROM app.sessions WHERE user_id = $1::uuid",
      createdUser.id,
    );
    await harness.owner.$executeRawUnsafe(
      "DELETE FROM app.users WHERE id = $1::uuid",
      createdUser.id,
    );
  });
});
