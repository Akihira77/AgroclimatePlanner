import { defineConfig } from "prisma/config";

/**
 * Prisma 7 no longer reads `.env` on its own, and the CLI is invoked from this
 * package's directory, so a root-level `.env` would be invisible anyway.
 *
 * Rather than add dotenv plumbing for a value that has exactly one correct dev
 * setting, the local URL is the default and `DATABASE_URL` overrides it. In
 * production the default would be a connection to nothing, so it throws.
 */
const LOCAL_DEV_URL = "postgresql://agroclimate:agroclimate@localhost:5442/agroclimate";

function databaseUrl(): string {
  const configured = process.env["DATABASE_URL"];
  if (configured !== undefined && configured !== "") return configured;
  if (process.env["NODE_ENV"] === "production") {
    throw new Error("DATABASE_URL is required when NODE_ENV=production");
  }
  return LOCAL_DEV_URL;
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: databaseUrl(),
  },
});
