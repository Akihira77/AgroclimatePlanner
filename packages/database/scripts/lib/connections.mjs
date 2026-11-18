/**
 * One place for connection resolution, shared by bootstrap, verification, and
 * the RLS integration tests.
 *
 * Three scripts deriving the same URL three ways is how they start disagreeing:
 * the root `.env` would be loaded by one and not the other, and a "wrong host"
 * bug would look like a role/privilege bug. The rules are the same as
 * `prisma.config.ts`, and they are stated once here.
 */
import { existsSync, readFileSync } from "node:fs";

export const PACKAGE_ROOT = new URL("../../", import.meta.url);

export const defaults = JSON.parse(
  readFileSync(new URL("database.defaults.json", PACKAGE_ROOT), "utf8"),
);

// Resolved from this file's location, never from `cwd`: `PACKAGE_ROOT` is
// packages/database/, so the root is two levels up.
const ROOT_ENV_FILE = new URL("../../.env", PACKAGE_ROOT);
if (existsSync(ROOT_ENV_FILE)) process.loadEnvFile(ROOT_ENV_FILE);

export const env = process.env;
export const development = env["NODE_ENV"] === "development";

const ROLE_CONNECTIONS = {
  migration_owner: { url: "MIGRATION_DATABASE_URL", password: "MIGRATION_OWNER_PASSWORD" },
  app_api: { url: "APP_API_DATABASE_URL", password: "APP_API_PASSWORD" },
  app_system: { url: "APP_SYSTEM_DATABASE_URL", password: "APP_SYSTEM_PASSWORD" },
};

export const ROLE_NAMES = Object.keys(ROLE_CONNECTIONS);

function required(name, fallback) {
  const provided = env[name];
  if (provided !== undefined && provided !== "") return provided;
  if (development) return fallback;
  throw new Error(`${name} is required outside development; refusing a placeholder credential`);
}

function hostPortDatabase() {
  return {
    host: env["POSTGRES_HOST"] || defaults.host,
    port: env["POSTGRES_PORT"] || defaults.port,
    database: env["POSTGRES_DB"] || defaults.database,
  };
}

/** An explicit URL wins outright; otherwise only development derives one. */
export function roleConnectionString(role) {
  const names = ROLE_CONNECTIONS[role];
  if (names === undefined) throw new Error(`unknown role ${role}`);

  const explicit = env[names.url];
  if (explicit !== undefined && explicit !== "") return explicit;
  if (!development) {
    throw new Error(`${names.url} is required outside development; there is no localhost fallback`);
  }

  const { host, port, database } = hostPortDatabase();
  const password = required(names.password, defaults.roles[role]);
  // `schema=app` is what Prisma turns into `search_path`; `pg` ignores it. Without
  // it the ORM looks for `public.farms` and reports a missing table, which is a
  // confusing way to find out the search path was wrong.
  return `postgresql://${encodeURIComponent(role)}:${encodeURIComponent(password)}@${host}:${port}/${database}?schema=${defaults.schema}`;
}

/**
 * Cluster-admin connection, used only by role bootstrap. Stricter than the rest:
 * outside development there is no derived fallback at all, because there is no
 * safe guess for a credential that can create roles.
 */
export function adminConnectionString() {
  const explicit = env["BOOTSTRAP_DATABASE_URL"];
  if (explicit !== undefined && explicit !== "") return explicit;
  if (!development) {
    throw new Error(
      "BOOTSTRAP_DATABASE_URL is required outside development. Role bootstrap is a cluster-admin action; there is no localhost fallback.",
    );
  }

  const { host, port, database } = hostPortDatabase();
  const user = encodeURIComponent(required("POSTGRES_USER", defaults.owner));
  const password = encodeURIComponent(required("POSTGRES_PASSWORD", defaults.ownerPassword));
  return `postgresql://${user}:${password}@${host}:${port}/${database}`;
}
