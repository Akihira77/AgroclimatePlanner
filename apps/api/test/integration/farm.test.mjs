/**
 * Farm CRUD through the real HTTP pipeline, over real PostgreSQL and the real
 * `app_api` / `app_auth` roles.
 *
 * Nothing here is a double: `createApplication` boots with `createPrismaClient`, so
 * the request runs through `Origin` middleware, body parsing, `AuthGuard`
 * (session + CSRF), `ZodValidationPipe`, the controller, `withTenant`, RLS, and the
 * exception filter. Fixtures and assertions about physical state use
 * `migration_owner`, because no runtime role holds `DELETE` or sees other tenants.
 *
 * Kept out of `test/*.test.mjs` on purpose: `pnpm test` must stay runnable without a
 * database. Run with `pnpm --filter @agroclimate/api test:integration`, which sets
 * `NODE_ENV=development` so `connections.mjs` may derive the local role DSNs.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { createPrismaClient } from "@agroclimate/database";

import { createApplication } from "../../dist/app.factory.js";
import { SESSION_COOKIE_NAME } from "../../dist/auth/session-cookie.js";
import { testConfig } from "../helpers.mjs";
// The package has no runtime export for its scripts, and re-deriving the DSNs here
// would be a second source of truth for the role rules.
import { roleConnectionString } from "../../../../packages/database/scripts/lib/connections.mjs";

const ORIGIN = "http://localhost:5173";
const EMAIL_PREFIX = "farm-api-";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 106.8°E–106.9°E, 6.2°S–6.1°S: a valid, non-empty polygon. */
const SQUARE = JSON.stringify({
  type: "Polygon",
  coordinates: [
    [
      [106.8, -6.2],
      [106.9, -6.2],
      [106.9, -6.1],
      [106.8, -6.1],
      [106.8, -6.2],
    ],
  ],
});

const owner = createPrismaClient({ connectionString: roleConnectionString("migration_owner") });

let app;
let base;
let alice;
let bob;
let carol;
let dave;

function token() {
  return randomBytes(32).toString("base64url");
}

async function seedUser(label) {
  const email = `${EMAIL_PREFIX}${label}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.test`;
  const rows = await owner.$queryRawUnsafe(
    "INSERT INTO app.users (email, password_hash) VALUES ($1, 'x') RETURNING id::text AS id",
    email,
  );
  const user = { id: rows[0].id, email, token: token(), csrfToken: token() };

  await owner.$executeRawUnsafe(
    `INSERT INTO app.sessions (user_id, token_hash, expires_at, absolute_expires_at, csrf_token)
     VALUES ($1::uuid, $2, now() + interval '30 days', now() + interval '90 days', $3)`,
    user.id,
    createHash("sha256").update(user.token, "utf8").digest("hex"),
    user.csrfToken,
  );

  return user;
}

function headers(user, { csrf = true, origin = ORIGIN } = {}) {
  const result = {
    cookie: `${SESSION_COOKIE_NAME}=${user.token}`,
    origin,
    "content-type": "application/json",
  };
  if (csrf) result["x-csrf-token"] = user.csrfToken;
  return result;
}

async function call(user, method, path, { body, csrf, origin, anonymous = false } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: anonymous ? { origin: origin ?? ORIGIN } : headers(user, { csrf, origin }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { response, body: text === "" ? undefined : JSON.parse(text) };
}

/** Creates a farm through HTTP and returns the resource. */
async function createFarm(user, body) {
  const { response, body: payload } = await call(user, "POST", "/v1/farms", { body });
  assert.equal(response.status, 201);
  return payload.data;
}

/** Reads the row as the owner, so a grant or a policy cannot hide it. */
async function ownerRow(table, id) {
  const rows = await owner.$queryRawUnsafe(`SELECT * FROM app.${table} WHERE id = $1::uuid`, id);
  return rows[0];
}

async function insertLiveField(user, farmId) {
  const rows = await owner.$queryRawUnsafe(
    `INSERT INTO app.fields (farm_id, user_id, name, geom)
     VALUES ($1::uuid, $2::uuid, 'Live field', ST_GeomFromGeoJSON($3::text))
     RETURNING id::text AS id`,
    farmId,
    user.id,
    SQUARE,
  );
  return rows[0].id;
}

before(async () => {
  app = await createApplication({
    config: testConfig({
      databaseUrl: roleConnectionString("app_api"),
      authDatabaseUrl: roleConnectionString("app_auth"),
    }),
    createDatabaseClient: (connectionString) => createPrismaClient({ connectionString }),
  });
  await app.listen(0, "127.0.0.1");
  base = (await app.getUrl()).replace("[::1]", "127.0.0.1");

  alice = await seedUser("alice");
  bob = await seedUser("bob");
  carol = await seedUser("carol");
  dave = await seedUser("dave");
});

after(async () => {
  if (app !== undefined) await app.close();

  const users = await owner.$queryRawUnsafe(
    "SELECT id::text AS id FROM app.users WHERE email LIKE $1",
    `${EMAIL_PREFIX}%`,
  );
  for (const { id } of users) {
    await owner.$executeRawUnsafe("DELETE FROM app.fields WHERE user_id = $1::uuid", id);
    await owner.$executeRawUnsafe("DELETE FROM app.farms WHERE user_id = $1::uuid", id);
    await owner.$executeRawUnsafe("DELETE FROM app.sessions WHERE user_id = $1::uuid", id);
    await owner.$executeRawUnsafe("DELETE FROM app.users WHERE id = $1::uuid", id);
  }

  await owner.$disconnect();
});

describe("POST /v1/farms", () => {
  it("creates a farm owned by the session subject, with a Location", async () => {
    const { response, body } = await call(alice, "POST", "/v1/farms", {
      body: { name: "  Block A ", region: "  Sulawesi ", notes: null },
    });

    assert.equal(response.status, 201);
    assert.equal(response.headers.get("location"), `/v1/farms/${body.data.id}`);
    assert.match(body.data.id, UUID);
    assert.equal(body.data.name, "Block A");
    assert.equal(body.data.region, "Sulawesi");
    assert.equal(body.data.notes, null);
    assert.deepEqual(Object.keys(body.data).sort(), [
      "createdAt",
      "id",
      "name",
      "notes",
      "region",
      "updatedAt",
    ]);

    const row = await ownerRow("farms", body.data.id);
    assert.equal(row.user_id, alice.id);
    assert.equal(row.deleted_at, null);
  });

  it("refuses an owner id, an unknown key and a blank name", async () => {
    for (const body of [{ name: "x", userId: bob.id }, { name: "x", areaHa: 1 }, { name: "   " }]) {
      const { response, body: payload } = await call(alice, "POST", "/v1/farms", { body });
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(payload.error.code, "VALIDATION_FAILED");
    }
  });

  it("enforces the approved length boundaries (Q6)", async () => {
    const accepted = await call(alice, "POST", "/v1/farms", {
      body: { name: "n".repeat(100), region: "r".repeat(120), notes: "t".repeat(2000) },
    });
    assert.equal(accepted.response.status, 201);

    for (const body of [
      { name: "n".repeat(101) },
      { name: "x", region: "r".repeat(121) },
      { name: "x", notes: "t".repeat(2001) },
    ]) {
      const { response } = await call(alice, "POST", "/v1/farms", { body });
      assert.equal(response.status, 400);
    }
  });

  it("requires a session, a trusted Origin and a CSRF token", async () => {
    assert.equal(
      (await call(alice, "POST", "/v1/farms", { body: { name: "x" }, anonymous: true })).response
        .status,
      401,
    );
    assert.equal(
      (await call(alice, "POST", "/v1/farms", { body: { name: "x" }, origin: "http://evil.test" }))
        .response.status,
      403,
    );
    assert.equal(
      (await call(alice, "POST", "/v1/farms", { body: { name: "x" }, csrf: false })).response
        .status,
      403,
    );

    const wrong = await fetch(`${base}/v1/farms`, {
      method: "POST",
      headers: { ...headers(alice), "x-csrf-token": token() },
      body: JSON.stringify({ name: "x" }),
    });
    assert.equal(wrong.status, 403);
    assert.equal((await wrong.json()).error.code, "FORBIDDEN");
  });
});

describe("GET /v1/farms", () => {
  let first;
  let second;
  let third;

  before(async () => {
    first = await createFarm(carol, { name: "A1" });
    second = await createFarm(carol, { name: "B2" });
    third = await createFarm(carol, { name: "C3" });
    await createFarm(bob, { name: "Bob only" });
  });

  it("lists only the caller's active farms with the documented meta", async () => {
    const { response, body } = await call(carol, "GET", "/v1/farms");

    assert.equal(response.status, 200);
    assert.deepEqual(
      body.data.map((farm) => farm.name),
      ["C3", "B2", "A1"],
      "default sort is -createdAt",
    );
    assert.deepEqual(body.meta, { page: 1, pageSize: 20, total: 3 });
    assert.equal(
      body.data.some((farm) => farm.name === "Bob only"),
      false,
    );
  });

  it("pages and sorts without repeating a row", async () => {
    const { body } = await call(carol, "GET", "/v1/farms?page=2&pageSize=2&sort=name");

    assert.deepEqual(
      body.data.map((farm) => farm.name),
      ["C3"],
    );
    assert.deepEqual(body.meta, { page: 2, pageSize: 2, total: 3 });

    const ascending = await call(carol, "GET", "/v1/farms?sort=name");
    assert.deepEqual(
      ascending.body.data.map((farm) => farm.name),
      ["A1", "B2", "C3"],
    );
  });

  it("rejects an unknown parameter, an unlisted sort and out-of-range paging", async () => {
    for (const query of ["?filter=x", "?sort=areaHa", "?page=0", "?pageSize=101", "?page=1.5"]) {
      const { response, body } = await call(carol, "GET", `/v1/farms${query}`);
      assert.equal(response.status, 400, query);
      assert.equal(body.error.code, "VALIDATION_FAILED");
    }
  });

  it("hides a soft-deleted farm", async () => {
    const doomed = await createFarm(carol, { name: "Doomed" });
    assert.equal((await call(carol, "DELETE", `/v1/farms/${doomed.id}`)).response.status, 204);

    const { body } = await call(carol, "GET", "/v1/farms");
    assert.equal(
      body.data.some((farm) => farm.id === doomed.id),
      false,
    );
    assert.equal(body.meta.total, 3);
  });

  it("does not require a CSRF token", async () => {
    const { response } = await call(carol, "GET", "/v1/farms", { csrf: false });
    assert.equal(response.status, 200);
  });

  it("returns an empty page, not a 404, for a tenant with no farms", async () => {
    const { response, body } = await call(dave, "GET", "/v1/farms?page=9&pageSize=20");
    assert.equal(response.status, 200);
    assert.deepEqual(body.data, []);
    assert.equal(body.meta.total, 0);
  });

  it("requires a session", async () => {
    assert.equal((await call(alice, "GET", "/v1/farms", { anonymous: true })).response.status, 401);
  });
});

describe("GET /v1/farms/:farmId", () => {
  it("returns the caller's own farm", async () => {
    const farm = await createFarm(alice, { name: "Detail" });
    const { response, body } = await call(alice, "GET", `/v1/farms/${farm.id}`);

    assert.equal(response.status, 200);
    assert.equal(body.data.id, farm.id);
  });

  it("answers the same 404 for missing, foreign and deleted farms", async () => {
    const foreign = await createFarm(bob, { name: "Bob's" });
    const deleted = await createFarm(alice, { name: "Gone" });
    await call(alice, "DELETE", `/v1/farms/${deleted.id}`);

    for (const id of [randomUUIDLike(), foreign.id, deleted.id]) {
      const { response, body } = await call(alice, "GET", `/v1/farms/${id}`);
      assert.equal(response.status, 404, id);
      assert.equal(body.error.code, "FARM_NOT_FOUND");
    }
  });

  it("rejects a path parameter that is not a UUID", async () => {
    const { response, body } = await call(alice, "GET", "/v1/farms/not-a-uuid");
    assert.equal(response.status, 400);
    assert.equal(body.error.code, "VALIDATION_FAILED");
  });

  it("requires a session", async () => {
    assert.equal(
      (await call(alice, "GET", "/v1/farms/not-a-uuid", { anonymous: true })).response.status,
      401,
    );
  });
});

describe("PATCH /v1/farms/:farmId", () => {
  it("updates the given keys and returns the row", async () => {
    const farm = await createFarm(alice, { name: "Old", region: "R", notes: "N" });
    const { response, body } = await call(alice, "PATCH", `/v1/farms/${farm.id}`, {
      body: { name: "  New  " },
    });

    assert.equal(response.status, 200);
    assert.equal(body.data.name, "New");
    assert.equal(body.data.region, "R", "an absent key is left unchanged");
    assert.equal(body.data.notes, "N");
  });

  it("clears a nullable column with null and keeps absent keys untouched", async () => {
    const farm = await createFarm(alice, { name: "Clear", region: "R", notes: "N" });
    const { body } = await call(alice, "PATCH", `/v1/farms/${farm.id}`, {
      body: { region: null },
    });

    assert.equal(body.data.region, null);
    assert.equal(body.data.notes, "N");
  });

  it("rejects an empty update, an unknown key and a null name", async () => {
    const farm = await createFarm(alice, { name: "Strict" });
    for (const body of [{}, { userId: alice.id }, { name: null }, { deletedAt: null }]) {
      const { response, body: payload } = await call(alice, "PATCH", `/v1/farms/${farm.id}`, {
        body,
      });
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(payload.error.code, "VALIDATION_FAILED");
    }
  });

  it("is last-write-wins (Q8: no If-Match)", async () => {
    const farm = await createFarm(alice, { name: "First" });
    await call(alice, "PATCH", `/v1/farms/${farm.id}`, { body: { name: "Second" } });
    const { body } = await call(alice, "PATCH", `/v1/farms/${farm.id}`, {
      body: { name: "Third" },
    });

    assert.equal(body.data.name, "Third");
  });

  it("answers 404 for a foreign or deleted farm", async () => {
    const foreign = await createFarm(bob, { name: "Bob's edit" });
    const deleted = await createFarm(alice, { name: "Deleted edit" });
    await call(alice, "DELETE", `/v1/farms/${deleted.id}`);

    for (const id of [foreign.id, deleted.id]) {
      const { response, body } = await call(alice, "PATCH", `/v1/farms/${id}`, {
        body: { name: "nope" },
      });
      assert.equal(response.status, 404);
      assert.equal(body.error.code, "FARM_NOT_FOUND");
    }
  });

  it("requires a session, Origin and CSRF", async () => {
    const farm = await createFarm(alice, { name: "Guarded" });

    assert.equal(
      (
        await call(alice, "PATCH", `/v1/farms/${farm.id}`, {
          body: { name: "x" },
          anonymous: true,
        })
      ).response.status,
      401,
    );
    assert.equal(
      (
        await call(alice, "PATCH", `/v1/farms/${farm.id}`, {
          body: { name: "x" },
          csrf: false,
        })
      ).response.status,
      403,
    );
    assert.equal(
      (
        await call(alice, "PATCH", `/v1/farms/${farm.id}`, {
          body: { name: "x" },
          origin: "http://evil.test",
        })
      ).response.status,
      403,
    );
  });
});

describe("DELETE /v1/farms/:farmId", () => {
  it("soft-deletes a farm with no live fields and keeps the row", async () => {
    const farm = await createFarm(alice, { name: "Disposable" });
    const { response, body } = await call(alice, "DELETE", `/v1/farms/${farm.id}`);

    assert.equal(response.status, 204);
    assert.equal(body, undefined);

    const row = await ownerRow("farms", farm.id);
    assert.notEqual(row.deleted_at, null, "the row is soft-deleted, not removed");

    assert.equal((await call(alice, "GET", `/v1/farms/${farm.id}`)).response.status, 404);
    assert.equal((await call(alice, "DELETE", `/v1/farms/${farm.id}`)).response.status, 404);
  });

  it("refuses a farm with live fields (Q2) and allows it once they are gone", async () => {
    const farm = await createFarm(alice, { name: "Occupied" });
    const fieldId = await insertLiveField(alice, farm.id);

    const refused = await call(alice, "DELETE", `/v1/farms/${farm.id}`);
    assert.equal(refused.response.status, 409);
    assert.equal(refused.body.error.code, "CONFLICT");
    assert.equal((await ownerRow("farms", farm.id)).deleted_at, null);

    await owner.$executeRawUnsafe(
      "UPDATE app.fields SET deleted_at = now() WHERE id = $1::uuid",
      fieldId,
    );

    assert.equal((await call(alice, "DELETE", `/v1/farms/${farm.id}`)).response.status, 204);
  });

  it("answers 404 for a foreign or missing farm", async () => {
    const foreign = await createFarm(bob, { name: "Bob's delete" });

    for (const id of [foreign.id, randomUUIDLike()]) {
      const { response, body } = await call(alice, "DELETE", `/v1/farms/${id}`);
      assert.equal(response.status, 404);
      assert.equal(body.error.code, "FARM_NOT_FOUND");
    }
    assert.equal((await ownerRow("farms", foreign.id)).deleted_at, null);
  });

  it("requires a session, Origin and CSRF", async () => {
    const farm = await createFarm(alice, { name: "Guarded delete" });

    assert.equal(
      (await call(alice, "DELETE", `/v1/farms/${farm.id}`, { anonymous: true })).response.status,
      401,
    );
    assert.equal(
      (await call(alice, "DELETE", `/v1/farms/${farm.id}`, { csrf: false })).response.status,
      403,
    );
    assert.equal(
      (await call(alice, "DELETE", `/v1/farms/${farm.id}`, { origin: "http://evil.test" })).response
        .status,
      403,
    );
  });
});

/** A canonical UUID that names no row. */
function randomUUIDLike() {
  return randomUUID();
}
