import { existsSync, readFileSync } from "node:fs";

import { defineConfig } from "prisma/config";

/**
 * One configuration source for both Prisma and Docker Compose.
 *
 * Compose reads a root `.env` implicitly. Prisma 7 does not read `.env` at all,
 * and the CLI runs from this package's directory, so relying on the current
 * working directory would mean the two resolve different databases. The path
 * below is resolved from this file's own location, not from `cwd`.
 *
 * Precedence is the same as Compose's: an exported variable beats the file.
 * `process.loadEnvFile` only fills in variables that are not already set
 * (verified), so nothing here needs to save and restore the environment.
 */
const ROOT_ENV_FILE = new URL("../../.env", import.meta.url);

if (existsSync(ROOT_ENV_FILE)) {
  process.loadEnvFile(ROOT_ENV_FILE);
}

interface Defaults {
  readonly host: string;
  readonly port: string;
  readonly database: string;
  readonly schema: string;
  readonly roles: Readonly<Record<string, string>>;
}

/** Shared with scripts/bootstrap.mjs, so a dev password exists in exactly one place. */
const DEFAULTS = JSON.parse(
  readFileSync(new URL("./database.defaults.json", import.meta.url), "utf8"),
) as Defaults;

/** Commands that open a connection. `generate` and `format` must work without one. */
const CONNECTING_COMMANDS = new Set(["db", "migrate", "studio"]);

function firstCommand(): string {
  return process.argv.slice(2).find((argument) => !argument.startsWith("-")) ?? "";
}

/**
 * Migrations connect as `migration_owner`, never as a runtime identity and never
 * as the cluster admin. `MIGRATION_DATABASE_URL` wins outright; development
 * derives the same connection from the variables Compose uses.
 *
 * Outside development there is no guessing: `undefined` means "no datasource
 * url", and any command that would connect fails. A missing `NODE_ENV` is *not*
 * development, so a production container cannot silently reach localhost.
 */
export function resolveMigrationUrl(
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const explicit = environment["MIGRATION_DATABASE_URL"];
  if (explicit !== undefined && explicit !== "") return explicit;

  if (environment["NODE_ENV"] !== "development") return undefined;

  // `||`, not `??`: Compose's `${VAR:-default}` treats an empty value as absent,
  // and an empty string here would build a URL with no user and no port while
  // Compose quietly used the defaults — the same desync this function exists to
  // prevent, reachable by leaving one `=` empty.
  const password = encodeURIComponent(
    environment["MIGRATION_OWNER_PASSWORD"] || DEFAULTS.roles["migration_owner"] || "",
  );
  const host = environment["POSTGRES_HOST"] || DEFAULTS.host;
  const port = environment["POSTGRES_PORT"] || DEFAULTS.port;
  const database = environment["POSTGRES_DB"] || DEFAULTS.database;

  // ?schema=app keeps application objects — and the migration ledger — out of
  // `public`, which belongs to PostGIS.
  return `postgresql://migration_owner:${password}@${host}:${port}/${database}?schema=${DEFAULTS.schema}`;
}

const url = resolveMigrationUrl();

if (url === undefined && CONNECTING_COMMANDS.has(firstCommand())) {
  // No credentials in this message. It is read by whoever just ran the command,
  // and CI logs are not a place to learn a password.
  throw new Error(
    'MIGRATION_DATABASE_URL is not set and NODE_ENV is not "development". ' +
      "Migrations connect as migration_owner and nothing falls back to localhost outside development. " +
      "Set MIGRATION_DATABASE_URL explicitly, or run with NODE_ENV=development for local work (see .env.example).",
  );
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  ...(url === undefined ? {} : { datasource: { url } }),
});
