/**
 * Applied-migration integrity check.
 *
 * Prisma records a SHA-256 of every `migration.sql` in `_prisma_migrations`, but
 * neither `migrate deploy` nor `migrate status` compares it: editing an applied
 * migration and re-running both was tried on 2026-11-27 and both reported "No
 * pending migrations to apply" / "Database schema is up to date". So the
 * checksum is stored and unused — which is worse than absent, because it looks
 * like protection.
 *
 * What this proves: each `migration.sql` in this repository is byte-for-byte the
 * file that was applied to the database it just connected to. What it does not
 * prove: that the database matches `schema.prisma`. A table created by hand, or
 * a constraint dropped outside a migration, is invisible here — `prisma migrate
 * status` is the drift check, and it is a separate command.
 *
 * Run: `pnpm --filter @agroclimate/database db:verify` (it runs first there), or
 * on its own. A pending migration is reported, not failed: having unapplied work
 * is a normal state, editing applied work is not. Exit 0 therefore does not mean
 * the schema is deployed — it means the files and the ledger agree.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";

import { Client } from "pg";

import { checkMigrations } from "./lib/migration-integrity.mjs";
import { roleConnectionString } from "./lib/connections.mjs";

const MIGRATIONS_URL = new URL("../prisma/migrations/", import.meta.url);

const directories = readdirSync(MIGRATIONS_URL)
  .filter((name) => {
    const entry = new URL(name + "/", MIGRATIONS_URL);
    try {
      return statSync(entry).isDirectory();
    } catch {
      // `migration_lock.toml` is a file and `readdirSync` does not say which.
      return false;
    }
  })
  .sort();

const checksumOf = (name) =>
  createHash("sha256")
    .update(readFileSync(new URL(name + "/migration.sql", MIGRATIONS_URL)))
    .digest("hex");

const client = new Client({ connectionString: roleConnectionString("migration_owner") });
await client.connect();

let applied;
try {
  ({ rows: applied } = await client.query(`
    SELECT migration_name AS "name", checksum, finished_at, rolled_back_at
      FROM app._prisma_migrations
     ORDER BY started_at
  `));
} finally {
  // The query's rejection is what must survive; a teardown error is noise and
  // must not replace it. `end()` also rejects if the socket has already gone.
  await client.end().catch(() => {});
}

const {
  failures,
  pending,
  applied: appliedCount,
} = checkMigrations({
  applied,
  directories,
  checksumOf,
});

for (const failure of failures) console.log(`FAIL  ${failure}`);
for (const name of pending) console.log(`PENDING  ${name} — run pnpm db:migrate`);

console.log(
  failures.length === 0
    ? `\n${appliedCount} applied migrations match their files${pending.length === 0 ? "" : `, ${pending.length} pending`}`
    : `\n${failures.length} migration integrity failure(s)`,
);

if (failures.length > 0) process.exitCode = 1;
