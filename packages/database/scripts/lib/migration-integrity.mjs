/**
 * The applied-migration comparison, with no I/O of its own.
 *
 * `scripts/verify-migrations.mjs` supplies the directories, the rows and the
 * hashing function; this module decides. Split out because the decision is four
 * branches that a regression would hide: the tamper path is the one everybody
 * remembers, `rolled_back_at` and `finished_at` are the ones nobody provokes.
 *
 * `_prisma_migrations` keeps a row per *attempt*, not per migration: solving a
 * failed migration with `prisma migrate resolve --rolled-back` leaves that row
 * behind forever, and the subsequent `deploy` appends an applied row beside it.
 * So a rolled-back row is not a failure on its own — the failure is a migration
 * whose latest state is rolled back and never re-applied, which `deploy` would
 * run again. Reading the ledger row-by-row instead of per name failed every
 * database that had ever been repaired, and this was measured against a clone on
 * 2026-11-28 before the first line of this comment was written.
 *
 * A `migration.sql` that cannot be read is a failure, not a crash: the run must
 * still report every other row before it gives up.
 */

/**
 * @param {object} input
 * @param {readonly {name: string, checksum: string, finished_at: Date | null, rolled_back_at: Date | null}[]} input.applied
 * @param {readonly string[]} input.directories
 * @param {(name: string) => string} input.checksumOf
 * @returns {{failures: string[], pending: string[], applied: number}}
 */
export function checkMigrations({ applied, directories, checksumOf }) {
  const failures = [];
  const byName = new Map();
  for (const row of applied) {
    const rows = byName.get(row.name) ?? [];
    rows.push(row);
    byName.set(row.name, rows);
  }

  /**
   * A migration counts as applied only when some row finished and was not undone.
   * `done[0]` is the earliest settled row: two settled rows for one name can only
   * come from a hand-edited ledger, and the earliest is what `deploy` recorded
   * first. Picking the latest would hide a file that matches the wrong apply.
   */
  const settled = new Map(
    [...byName].flatMap(([name, rows]) => {
      const done = rows.filter((row) => row.finished_at !== null && row.rolled_back_at === null);
      return done.length === 0 ? [] : [[name, done[0]]];
    }),
  );

  if (applied.length === 0 && directories.length > 0) {
    // A database with no settled migration is not a verified database. Without
    // this, pointing the check at the wrong database printed "0 applied
    // migrations match their files" and exit 0.
    failures.push(
      "no applied migrations in this database — check that MIGRATION_DATABASE_URL names the database you meant, or run pnpm db:migrate if this database is new",
    );
  }

  for (const [name, rows] of byName) {
    if (!settled.has(name)) {
      const unfinished = rows.some(
        (row) => row.finished_at === null && row.rolled_back_at === null,
      );
      failures.push(
        unfinished
          ? `${name}: started and never finished — the schema is in an unknown state; inspect the failed statement, then prisma migrate resolve --rolled-back ${name} (or --applied if its effects landed), then pnpm db:migrate`
          : `${name}: marked rolled back and never re-applied — the next deploy will run it; run pnpm db:migrate when that is intended`,
      );
      continue;
    }

    const row = settled.get(name);
    if (!directories.includes(name)) {
      failures.push(`${name}: applied, but its directory is gone — the schema has no source`);
      continue;
    }

    if (row.checksum === null || row.checksum === "") {
      // Only reachable by a hand-edited or foreign-written ledger, and it must not
      // crash the run: the remaining migrations still need reporting.
      failures.push(`${name}: no checksum recorded — the ledger row cannot be trusted`);
      continue;
    }

    let actual;
    try {
      actual = checksumOf(name);
    } catch (error) {
      failures.push(
        `${name}: migration.sql is missing or unreadable (${error instanceof Error ? (error.code ?? error.message) : String(error)})`,
      );
      continue;
    }
    if (actual !== row.checksum) {
      failures.push(
        `${name}: edited after it was applied (recorded ${row.checksum.slice(0, 12)}…, file ${actual.slice(0, 12)}…) — git diff it`,
      );
    }
  }

  // Pending means "no ledger row at all". A directory whose only rows failed is
  // already reported as a failure above; counting it twice would suggest two
  // problems where there is one.
  const pending = directories.filter((name) => !byName.has(name));
  return { failures, pending, applied: settled.size };
}
