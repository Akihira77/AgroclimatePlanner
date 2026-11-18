/**
 * Runtime configuration for the API process.
 *
 * Parsed once at startup, from an explicit record of environment variables, so a
 * bad value fails the boot instead of surfacing as a 500 on the first request
 * that needed it. Nothing here reads `process.env` directly except `readEnvironment`,
 * which is the single place the process boundary is crossed.
 *
 * Errors never echo a value: a message that printed the rejected connection string
 * would print its password too.
 */

export type NodeEnvironment = "development" | "test" | "production";

export interface RuntimeConfig {
  readonly nodeEnv: NodeEnvironment;
  readonly port: number;
  /** `app_api` connection string. Never a migration credential. */
  readonly databaseUrl: string;
  readonly corsOrigins: readonly string[];
  /** Express `trust proxy` value. `false` unless an operator says otherwise. */
  readonly trustProxy: false | readonly string[];
  /** Accept a UUID `X-Request-Id` from the caller. Off unless an operator says otherwise. */
  readonly trustRequestIdHeader: boolean;
}

export type EnvironmentInput = Readonly<Record<string, string | undefined>>;

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

const DATABASE_DEFAULTS = {
  host: "127.0.0.1",
  port: "5442",
  database: "agroclimate",
} as const;

const DEVELOPMENT_CORS_ORIGIN = "http://localhost:5173";

/** Trusted-proxy tokens Express understands, minus the unsafe `true`. */
const TRUST_PROXY_TOKENS = new Set(["loopback", "linklocal", "uniquelocal"]);

const CIDR = /^[0-9a-fA-F.:]+\/\d{1,3}$/;

export function readEnvironment(): EnvironmentInput {
  return process.env;
}

export function parseRuntimeConfig(env: EnvironmentInput): RuntimeConfig {
  const nodeEnv = parseNodeEnv(env["NODE_ENV"]);
  return {
    nodeEnv,
    port: parsePort(env["PORT"]),
    databaseUrl: parseDatabaseUrl(env, nodeEnv),
    corsOrigins: parseCorsOrigins(env, nodeEnv),
    trustProxy: parseTrustProxy(env["TRUST_PROXY"]),
    trustRequestIdHeader: parseBoolean(env["TRUST_REQUEST_ID_HEADER"], "TRUST_REQUEST_ID_HEADER"),
  };
}

function parseNodeEnv(value: string | undefined): NodeEnvironment {
  if (value === "production" || value === "test" || value === "development") return value;
  if (value === undefined || value === "") return "development";
  throw new ConfigurationError("NODE_ENV must be development, test, or production");
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value === "") return 3000;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigurationError("PORT must be an integer between 1 and 65535");
  }
  return port;
}

/**
 * The API is always `app_api`. `MIGRATION_DATABASE_URL` is deliberately never
 * consulted: it carries schema-owner privileges, so falling back to it would hand
 * the tenant-facing process a credential the RLS design exists to keep out of it.
 */
function parseDatabaseUrl(env: EnvironmentInput, nodeEnv: NodeEnvironment): string {
  const explicit = env["APP_API_DATABASE_URL"];
  if (explicit !== undefined && explicit !== "") {
    assertPostgresUrl(explicit, "APP_API_DATABASE_URL");
    return explicit;
  }

  if (nodeEnv === "production") {
    throw new ConfigurationError(
      "APP_API_DATABASE_URL is required in production; the app_api password fallback is development-only",
    );
  }

  const password = env["APP_API_PASSWORD"];
  if (password === undefined || password === "") {
    throw new ConfigurationError(
      "APP_API_PASSWORD is required to derive the development database URL; refusing to guess a credential",
    );
  }

  const host = env["POSTGRES_HOST"] ?? DATABASE_DEFAULTS.host;
  const port = env["POSTGRES_PORT"] ?? DATABASE_DEFAULTS.port;
  const database = env["POSTGRES_DB"] ?? DATABASE_DEFAULTS.database;
  return `postgresql://app_api:${encodeURIComponent(password)}@${host}:${port}/${database}?schema=app`;
}

function assertPostgresUrl(value: string, variable: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigurationError(`${variable} is not a valid URL`);
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new ConfigurationError(`${variable} must use the postgresql: scheme`);
  }
}

function parseCorsOrigins(env: EnvironmentInput, nodeEnv: NodeEnvironment): readonly string[] {
  const raw = env["CORS_ORIGINS"];
  if (raw === undefined || raw === "") {
    if (nodeEnv === "production") {
      throw new ConfigurationError(
        "CORS_ORIGINS is required in production; refusing to guess an allowlist",
      );
    }
    return [DEVELOPMENT_CORS_ORIGIN];
  }

  const origins = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");

  if (origins.length === 0) {
    throw new ConfigurationError("CORS_ORIGINS must list at least one origin");
  }

  for (const origin of origins) {
    if (origin === "*") {
      throw new ConfigurationError("CORS_ORIGINS must not contain '*'; name the origins instead");
    }
    assertOrigin(origin);
  }
  return origins;
}

function assertOrigin(origin: string): void {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new ConfigurationError(`CORS_ORIGINS contains an entry that is not a URL: ${origin}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigurationError(`CORS_ORIGINS entries must be http(s) origins: ${origin}`);
  }
  if (url.origin !== origin) {
    throw new ConfigurationError(
      `CORS_ORIGINS entries must be bare origins without a path or trailing slash: ${origin}`,
    );
  }
}

function parseTrustProxy(value: string | undefined): false | readonly string[] {
  if (value === undefined || value === "" || value === "false") return false;
  if (value === "true") {
    throw new ConfigurationError(
      "TRUST_PROXY=true is refused: any caller could then choose their own client IP via X-Forwarded-For",
    );
  }

  const tokens = value
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token !== "");

  if (tokens.length === 0) return false;

  for (const token of tokens) {
    if (TRUST_PROXY_TOKENS.has(token) || CIDR.test(token)) continue;
    throw new ConfigurationError(
      `TRUST_PROXY entry '${token}' is not a supported token; use false, loopback, linklocal, uniquelocal, or CIDRs`,
    );
  }
  return tokens;
}

function parseBoolean(value: string | undefined, variable: string): boolean {
  if (value === undefined || value === "" || value === "false") return false;
  if (value === "true") return true;
  throw new ConfigurationError(`${variable} must be true or false`);
}
