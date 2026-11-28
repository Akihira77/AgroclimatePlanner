/**
 * Shared plumbing for the real-HTTP integration suites (Farm and Field).
 *
 * Each suite runs in its own Node test process, so each one boots its own
 * application and its own `migration_owner` client; nothing here holds module-level
 * state. What is shared is the boot sequence — which must be identical between the
 * suites for the same reason the application has one `createApplication` — and the
 * fixture/teardown rules.
 *
 * `migration_owner` is used only for seeding and for assertions about physical
 * state. Every request under test runs as `app_api` against a real session, so a
 * grant or a policy that hides a row is visible to the test rather than papered
 * over by an owner connection.
 */
import { createHash, randomBytes } from "node:crypto";

import { createPrismaClient } from "@agroclimate/database";

import { createApplication } from "../../dist/app.factory.js";
import { SESSION_COOKIE_NAME } from "../../dist/auth/session-cookie.js";
// The package publishes no runtime export for its scripts, and deriving the role
// DSNs a second time here would be two sources of truth for the role rules.
import { roleConnectionString } from "../../../../packages/database/scripts/lib/connections.mjs";
import { testConfig } from "../helpers.mjs";

export const ORIGIN = "http://localhost:5173";
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 106.8°E–106.9°E, 6.2°S–6.1°S: a valid, non-empty polygon (~123 ha). */
export const SQUARE = {
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
};

/** The same coordinates as a SQL argument (the database layer takes GeoJSON text). */
export const SQUARE_JSON = JSON.stringify(SQUARE);

/**
 * Boots the real application on an ephemeral port with the real role clients.
 *
 * `gridRegistry` is the only substitution the resolution suite needs: production
 * binds `syntheticGridRegistry`, which holds one `synthetic` entry the database
 * CHECK refuses, so a happy path has to supply an isolated registry rather than
 * edit the production one. Absent, the wiring is exactly production's.
 */
export async function startHarness({ gridRegistry } = {}) {
  const owner = createPrismaClient({ connectionString: roleConnectionString("migration_owner") });

  const app = await createApplication({
    config: testConfig({
      databaseUrl: roleConnectionString("app_api"),
      authDatabaseUrl: roleConnectionString("app_auth"),
    }),
    createDatabaseClient: (connectionString) => createPrismaClient({ connectionString }),
    ...(gridRegistry === undefined ? {} : { gridRegistry }),
  });

  await app.listen(0, "127.0.0.1");
  const base = (await app.getUrl()).replace("[::1]", "127.0.0.1");

  return { app, base, owner };
}

export async function stopHarness({ app, owner }) {
  await app.close();
  await owner.$disconnect();
}

/**
 * 43 base64url characters: a session token and a CSRF token have the same shape.
 * Exported so a suite can present a well-formed value that belongs to no session.
 */
export function token() {
  return randomBytes(32).toString("base64url");
}

/** Seeds a credential row, an active session, and the CSRF token the guard will check. */
export async function seedUser(owner, prefix, label) {
  const email = `${prefix}${label}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.test`;
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

export function headers(user, { csrf = true, origin = ORIGIN } = {}) {
  const result = {
    cookie: `${SESSION_COOKIE_NAME}=${user.token}`,
    origin,
    "content-type": "application/json",
  };
  if (csrf) result["x-csrf-token"] = user.csrfToken;
  return result;
}

/** Binds the request helper to one listening application. */
export function apiFor(base) {
  return {
    async call(user, method, path, { body, csrf, origin, anonymous = false } = {}) {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: anonymous ? { origin: origin ?? ORIGIN } : headers(user, { csrf, origin }),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      return { response, body: text === "" ? undefined : JSON.parse(text) };
    },
  };
}

/** Reads a row as the owner, so nothing is hidden by a grant or a policy. */
export async function ownerRow(owner, table, id) {
  const rows = await owner.$queryRawUnsafe(`SELECT * FROM app.${table} WHERE id = $1::uuid`, id);
  return rows[0];
}

/** Deletes every fixture user whose email carries the suite prefix, and its rows. */
export async function cleanupUsers(owner, prefix) {
  const users = await owner.$queryRawUnsafe(
    "SELECT id::text AS id FROM app.users WHERE email LIKE $1",
    `${prefix}%`,
  );

  for (const { id } of users) {
    await owner.$executeRawUnsafe("DELETE FROM app.ai_briefings WHERE user_id = $1::uuid", id);
    await owner.$executeRawUnsafe("DELETE FROM app.planting_windows WHERE user_id = $1::uuid", id);
    await owner.$executeRawUnsafe("DELETE FROM app.suitability_runs WHERE user_id = $1::uuid", id);
    await owner.$executeRawUnsafe("DELETE FROM app.harvests WHERE user_id = $1::uuid", id);
    await owner.$executeRawUnsafe("DELETE FROM app.plantings WHERE user_id = $1::uuid", id);
    await owner.$executeRawUnsafe(
      "DELETE FROM app.field_observations WHERE user_id = $1::uuid",
      id,
    );
    await owner.$executeRawUnsafe(
      "DELETE FROM app.field_outlook_cells WHERE user_id = $1::uuid",
      id,
    );
    await owner.$executeRawUnsafe("DELETE FROM app.fields WHERE user_id = $1::uuid", id);
    await owner.$executeRawUnsafe("DELETE FROM app.farms WHERE user_id = $1::uuid", id);
    await owner.$executeRawUnsafe("DELETE FROM app.sessions WHERE user_id = $1::uuid", id);
    await owner.$executeRawUnsafe("DELETE FROM app.users WHERE id = $1::uuid", id);
  }
}
