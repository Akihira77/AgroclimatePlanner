import { existsSync } from "node:fs";

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

/** Compose defaults, duplicated so an empty environment still yields a matching pair. */
const DEFAULTS = {
  user: "agroclimate",
  password: "agroclimate-dev",
  database: "agroclimate",
  port: "5442",
} as const;

/** Commands that open a connection. `generate` and `format` must work without one. */
const CONNECTING_COMMANDS = new Set(["db", "migrate", "studio"]);

function firstCommand(): string {
  return process.argv.slice(2).find((argument) => !argument.startsWith("-")) ?? "";
}

/**
 * `DATABASE_URL` wins outright. Otherwise development derives the URL from the
 * same `POSTGRES_*` variables Compose uses, so the two cannot desynchronise by
 * editing one place.
 *
 * Outside development there is no guessing: `undefined` means "no datasource
 * url", and any command that would connect fails. A missing `NODE_ENV` is
 * *not* development, so a production container cannot silently reach localhost.
 */
function resolveDatasourceUrl(): string | undefined {
  const explicit = process.env["DATABASE_URL"];
  if (explicit !== undefined && explicit !== "") return explicit;

  if (process.env["NODE_ENV"] !== "development") return undefined;

  const user = encodeURIComponent(process.env["POSTGRES_USER"] ?? DEFAULTS.user);
  const password = encodeURIComponent(process.env["POSTGRES_PASSWORD"] ?? DEFAULTS.password);
  const database = encodeURIComponent(process.env["POSTGRES_DB"] ?? DEFAULTS.database);
  const port = process.env["POSTGRES_PORT"] ?? DEFAULTS.port;

  return `postgresql://${user}:${password}@127.0.0.1:${port}/${database}`;
}

const url = resolveDatasourceUrl();

if (url === undefined && CONNECTING_COMMANDS.has(firstCommand())) {
  // No credentials in this message. It is read by whoever just ran the command,
  // and CI logs are not a place to learn a password.
  throw new Error(
    'DATABASE_URL is not set and NODE_ENV is not "development". ' +
      "Nothing falls back to localhost outside development — set DATABASE_URL explicitly, " +
      "or run with NODE_ENV=development for local work (see .env.example).",
  );
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  ...(url === undefined ? {} : { datasource: { url } }),
});
