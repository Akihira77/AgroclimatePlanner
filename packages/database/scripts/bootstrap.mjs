/**
 * Creates the role boundary and provisions logins.
 *
 * Run once per cluster, as a superuser. `CREATE ROLE` is a cluster privilege, so
 * this cannot be a migration: migration_owner must never be able to make roles,
 * otherwise a compromised migration connection becomes a compromised cluster.
 *
 * Passwords come from the environment and are applied through `format(%L, …)`,
 * never interpolated into a committed file and never printed.
 *
 * Idempotent by construction, which is what lets verification prove it: the SQL
 * normalises grants on every run, so a direct `GRANT CREATE ON SCHEMA app` left
 * behind by hand or by an older bootstrap is removed the next time this runs.
 */
import { readFileSync } from "node:fs";

import { Client } from "pg";

import {
  adminConnectionString,
  defaults,
  development,
  env,
  PACKAGE_ROOT,
  ROLE_NAMES,
} from "./lib/connections.mjs";

const rolesSql = readFileSync(new URL("bootstrap/roles.sql", PACKAGE_ROOT), "utf8");

const ROLE_PASSWORD_VARIABLES = {
  migration_owner: "MIGRATION_OWNER_PASSWORD",
  app_api: "APP_API_PASSWORD",
  app_system: "APP_SYSTEM_PASSWORD",
  app_auth: "APP_AUTH_PASSWORD",
};

function passwordFor(role) {
  const variable = ROLE_PASSWORD_VARIABLES[role];
  const provided = env[variable];
  if (provided !== undefined && provided !== "") return provided;
  if (development) return defaults.roles[role];
  throw new Error(
    `${variable} is required outside development; refusing to use a placeholder credential`,
  );
}

const admin = new Client({ connectionString: adminConnectionString() });
await admin.connect();

try {
  await admin.query("BEGIN");
  await admin.query(rolesSql);

  for (const role of ROLE_NAMES) {
    // Built server-side so the password is a properly quoted literal. The
    // statement is executed, never logged.
    const { rows } = await admin.query(
      "select format('alter role %I with login password %L', $1::text, $2::text) as statement",
      [role, passwordFor(role)],
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
  `bootstrap complete: roles ${ROLE_NAMES.join(", ")} (login provisioned); schema app owned by migration_owner`,
);
