/**
 * The Prisma schema and the applied database must not disagree.
 *
 * Run: `pnpm --filter @agroclimate/database db:verify` (third step).
 *
 * `prisma/schema.prisma` is kept in sync with `prisma/migrations/` by hand — the
 * SQL is authoritative and the schema is the client-facing view of it. Hand-sync
 * drifts, and the drifts are quiet: on 2026-11-28 an audit found three.
 *
 * 1. `Session.tokenHash` had no `@map("token_hash")`, so Prisma believed the
 *    column was `tokenHash`. Nothing broke only because every session query is
 *    raw SQL — a client query would have failed on a column that does not exist.
 * 2. `fields_geom_gist_idx` and `jobs_created_idx` were in the migrations and not
 *    in the schema, so `migrate diff` read them as indexes to drop.
 * 3. `planting_windows.superseded_by_id` was declared as a self-relation and
 *    documented as one, but no migration ever created the constraint. A window
 *    could point at a superseding row that does not exist.
 *
 * The check is therefore not a diff of two schema files: it asks Prisma for the
 * script that would make the database match the schema and refuses anything but
 * the one difference Prisma cannot express.
 *
 * That difference is `fields.area_ha`: `GENERATED ALWAYS AS (...) STORED`, which
 * Prisma has no syntax for, so it reads the generated column as a plain nullable
 * `double precision` and wants to drop the generation. The allowlist is one
 * statement, and a separate query below asserts the column really is still
 * generated — so the allowlist cannot become a place where real drift hides.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "pg";

import { roleConnectionString } from "./lib/connections.mjs";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The one statement Prisma must always want, and never anything else. */
const UNEXPRESSIBLE = [
  'ALTER TABLE "fields" ALTER COLUMN "area_ha" DROP DEFAULT,',
  'ALTER COLUMN "area_ha" SET DATA TYPE double precision;',
].join("\n");

function statements(script) {
  return script
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => `${chunk.replace(/\s+/g, " ")}`);
}

function diffScript() {
  const prisma = join(packageRoot, "node_modules", ".bin", "prisma");
  const result = spawnSync(
    prisma,
    [
      "migrate",
      "diff",
      "--from-config-datasource",
      "--to-schema",
      join(packageRoot, "prisma", "schema.prisma"),
      "--script",
    ],
    { cwd: packageRoot, encoding: "utf8", timeout: 240_000 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`prisma migrate diff failed (exit ${result.status}): ${result.stderr.trim()}`);
  }
  return result.stdout;
}

const expected = statements(UNEXPRESSIBLE);
const actual = statements(diffScript());

let failures = 0;
const check = (label, passed, detail) => {
  if (passed) {
    console.log(`PASS  ${label}`);
    return;
  }
  failures += 1;
  console.log(`FAIL  ${label}${detail === undefined ? "" : ` — ${detail}`}`);
};

const unexplained = actual.filter((statement) => !expected.includes(statement));
const missing = expected.filter((statement) => !actual.includes(statement));

check(
  "the schema and the database differ only where Prisma cannot express the difference",
  unexplained.length === 0 && missing.length === 0,
  JSON.stringify({ unexpected: unexplained, absent: missing }),
);

// The allowlist says "generated column"; if that stops being true, the exception
// has outlived its reason and the diff is real drift.
const client = new Client({ connectionString: roleConnectionString("migration_owner") });
try {
  await client.connect();
  const { rows } = await client.query(
    `select is_generated, generation_expression <> '' as has_expression
       from information_schema.columns
      where table_schema = 'app' and table_name = 'fields' and column_name = 'area_ha'`,
  );
  const column = rows[0];
  check(
    "fields.area_ha is still a generated column, so the one allowed difference is still an inexpressible one",
    column !== undefined && column.is_generated === "ALWAYS" && column.has_expression === true,
    JSON.stringify(column ?? "column not found"),
  );
} finally {
  await client.end().catch(() => {});
}

if (failures > 0) {
  console.log(`\n${failures} schema check(s) failed`);
  process.exitCode = 1;
} else {
  console.log("\nPrisma schema and database agree");
}
