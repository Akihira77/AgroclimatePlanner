/**
 * Creates the role boundary and provisions logins.
 *
 * Run once per cluster, as a superuser. `CREATE ROLE` is a cluster privilege, so
 * this cannot be a migration: migration_owner must never be able to make roles,
 * otherwise a compromised migration connection becomes a compromised cluster.
 *
 * Passwords come from the environment and are applied through `format(%L, …)`,
 * never interpolated into a committed file and never printed.
 */
import { existsSync, readFileSync } from "node:fs";

import { Client } from "pg";

const PACKAGE_ROOT = new URL("../", import.meta.url);
const defaults = JSON.parse(readFileSync(new URL("database.defaults.json", PACKAGE_ROOT), "utf8"));
const rolesSql = readFileSync(new URL("bootstrap/roles.sql", PACKAGE_ROOT), "utf8");

// Same source, same precedence as prisma.config.ts: the root file fills in what
// the environment has not already set.
const ROOT_ENV_FILE = new URL("../../.env", PACKAGE_ROOT);
if (existsSync(ROOT_ENV_FILE)) process.loadEnvFile(ROOT_ENV_FILE);

const env = process.env;
const development = env["NODE_ENV"] === "development";

const ROLE_PASSWORD_VARIABLES = {
  migration_owner: "MIGRATION_OWNER_PASSWORD",
  app_api: "APP_API_PASSWORD",
  app_system: "APP_SYSTEM_PASSWORD",
};

function required(name, fallback) {
  const provided = env[name];
  if (provided !== undefined && provided !== "") return provided;
  if (development) return fallback;
  throw new Error(
    `${name} is required outside development; refusing to use a placeholder credential`,
  );
}

function bootstrapConnectionString() {
  const explicit = env["BOOTSTRAP_DATABASE_URL"];
  if (explicit !== undefined && explicit !== "") return explicit;
  if (!development) {
    throw new Error(
      "BOOTSTRAP_DATABASE_URL is required outside development. Role bootstrap is a cluster-admin action; there is no localhost fallback.",
    );
  }

  const user = encodeURIComponent(required("POSTGRES_USER", defaults.owner));
  const password = encodeURIComponent(required("POSTGRES_PASSWORD", defaults.ownerPassword));
  const host = env["POSTGRES_HOST"] || defaults.host;
  const port = env["POSTGRES_PORT"] || defaults.port;
  const database = env["POSTGRES_DB"] || defaults.database;
  return `postgresql://${user}:${password}@${host}:${port}/${database}`;
}

const admin = new Client({ connectionString: bootstrapConnectionString() });
await admin.connect();

try {
  await admin.query("BEGIN");
  await admin.query(rolesSql);

  for (const [role, variable] of Object.entries(ROLE_PASSWORD_VARIABLES)) {
    const password = required(variable, defaults.roles[role]);
    // Built server-side so the password is a properly quoted literal. The
    // statement is executed, never logged.
    const { rows } = await admin.query(
      "select format('alter role %I with login password %L', $1::text, $2::text) as statement",
      [role, password],
    );
    await admin.query(rows[0].statement);
  }

  await admin.query("COMMIT");
} catch (error) {
  await admin.query("ROLLBACK").catch(() => {});
  throw error;
} finally {
  await admin.end();
}

console.log(
  "bootstrap complete: roles migration_owner, app_api, app_system (login provisioned); schema app owned by migration_owner",
);
