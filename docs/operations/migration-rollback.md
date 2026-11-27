# Migration rollback

`docs/IMPLEMENTATION_MASTER_ROADMAP.md` §13.6 asks for a migration rollback
strategy. There are no down migrations in this repository and there will not be:
`prisma migrate deploy` reads `migration.sql` forward only, and the twelve
directories under `packages/database/prisma/migrations/` contain nothing else.

So "rollback" is one of three things, in increasing cost:

| Tier | Action | When |
|---|---|---|
| 1 | A **new** migration that reverses the effect | The default. Always prefer this |
| 2 | Restore the database from a dump | The schema is unusable, or data was damaged |
| 3 | Edit the applied migration | Never — and now detected |

## 1. Never edit an applied migration

Prisma records a SHA-256 of each `migration.sql` in `_prisma_migrations`, but it
**does not compare it**. Tried on 2026-11-27: a comment appended to
`20261127130000_jobs_cancel/migration.sql`, then `prisma migrate deploy` →
`No pending migrations to apply`, exit 0; `prisma migrate status` → `Database
schema is up to date!`. The checksum is stored and unused, which is worse than
absent because it looks like protection.

`packages/database/scripts/verify-migrations.mjs` does the comparison, and
`pnpm --filter @agroclimate/database db:verify` runs it before the privilege
checks. Every state below was provoked against a database, not imagined — the
last four on a clone, because they need a ledger with history:

| Provocation | Output | Exit |
|---|---|---|
| a comment appended to an applied `migration.sql` | `FAIL 20261127130000_jobs_cancel: edited after it was applied (recorded d6dfa894e621…, file 71f55d8497c3…)` | 1 |
| the migration directory moved out of the tree | `FAIL <name>: applied, but its directory is gone — the schema has no source` | 1 |
| a directory with no ledger row | `PENDING <name> — run pnpm db:migrate` | 0 |
| no ledger rows at all, table present | `FAIL no applied migrations in this database — check that MIGRATION_DATABASE_URL names the database you meant, or run pnpm db:migrate if this database is new` | 1 |
| a row that started and never finished | `FAIL <name>: started and never finished — … prisma migrate resolve --rolled-back <name> …, then pnpm db:migrate` | 1 |
| a migration marked rolled back and not re-applied | `FAIL <name>: marked rolled back and never re-applied — the next deploy will run it` | 1 |
| a repaired ledger: a rolled-back row beside an applied row | `13 applied migrations match their files` | 0 |

A database so fresh that `app._prisma_migrations` does not exist yet is a
different output: the `SELECT` fails with `relation "app._prisma_migrations" does
not exist` and the script exits 1 without the message above. Same verdict, less
guidance — `db:bootstrap` then `db:migrate` is the order that avoids both.

The last row is why the comparison works per migration name rather than per
ledger row. `prisma migrate resolve --rolled-back` does not edit the failed row —
it leaves it and `deploy` appends a second one, so a database that was repaired
once carries a rolled-back row forever. Judging rows individually failed every
such database, i.e. every database that had ever been repaired. Measured on a
clone on 2026-11-28, before the check was trusted.

Two measured facts about `prisma migrate resolve --rolled-back <name>`, both on
that clone: it succeeds on a row that started and never finished (the intended
case), and it also succeeds — exit 0, "marked as rolled back" — on a migration
that is already applied, appending a rolled-back row beside the applied one. The
applied row still wins, so nothing is re-run, but the ledger grows a row that
reads like a failure. Run the command once, for the migration that actually
failed, then `pnpm db:migrate`.

A pending migration is not a failure: having unapplied work is normal. Editing
applied work is not, and that is what the check exists for.

Two limits of that check, because both are easy to read past:

- **Exit 0 does not mean the schema is deployed.** It means the files and the
  ledger agree. A run with pending directories prints them and still exits 0, so a
  pipeline must run `pnpm db:migrate` as its own step and must not read a green
  `db:verify` as "the database is up to date".
- **It does not detect drift.** An object created by hand, or a constraint
  dropped outside a migration, leaves every checksum intact. `prisma migrate
  status` and `prisma migrate diff` are the drift tools; this check answers one
  narrower question — is the file the one that was applied here?

What it does enforce is the property every other tier depends on: applied files are
immutable, so a database rebuilt from the same commit runs the same bytes as this
one.

The five-state comparison lives in `scripts/lib/migration-integrity.mjs` and is
covered by `test/unit/migration-integrity.test.mjs`, which needs no database — the
tampered-file path is famous, `rolled_back_at` and `finished_at` are the branches
nobody provokes by hand.

The ledger itself is unreadable to every application role: `pnpm db:verify` asserts
`app_api`, `app_system` and `app_auth` are each denied `select` on
`app._prisma_migrations`, not just `delete`.

## 2. What the current set already guarantees

Checked by grep across every migration present on 2026-11-27 (twelve), and again
on 2026-11-28 with `20261128120000_revoke_runtime_delete` present, which only
revokes privileges:

- No `DROP TABLE`, no `DROP COLUMN`, no `RENAME`, no `ALTER TYPE`.
- No `UPDATE` or `DELETE` against application rows at migration time. The one
  `DELETE FROM app.sessions` (in `20261118050000_sessions`) is inside
  `app.purge_expired_sessions()`, a `SECURITY DEFINER` function the worker calls;
  it is retention at runtime, not a migration that removes data.
- Two migrations drop a constraint they then re-add (`20261123000000_weather_supersession`,
  `20261127130000_jobs_cancel`). A `DROP CONSTRAINT` followed by `ADD CONSTRAINT`
  in the same file is a redefinition, and `prisma migrate deploy` wraps each
  migration file in one transaction, so it is atomic. **When replaying reverse SQL
  by hand, `psql` gives no such wrapper** — put it in an explicit `BEGIN … COMMIT`
  or a dropped constraint stays dropped.

That is why every migration so far is reversible at the schema level by writing a
new one. Nothing has been destroyed.

## 3. Writing the reverse

A reverse migration is a new directory with the forward SQL's inverse. It must be
`db:verify`-clean, which means it is a new file with a new checksum, not an edit.

### What a reverse cannot decide for you

`20261127130000_jobs_cancel` is the first migration whose inverse is not mechanical:
it added `cancelled` to `jobs_status_check` and to `jobs_finished_check`. The
schema-level reverse is three statements:

```sql
ALTER TABLE app.jobs DROP CONSTRAINT jobs_status_check;
ALTER TABLE app.jobs ADD CONSTRAINT jobs_status_check
  CHECK (status IN ('queued', 'running', 'succeeded', 'dead'));
ALTER TABLE app.jobs DROP CONSTRAINT jobs_finished_check;
ALTER TABLE app.jobs ADD CONSTRAINT jobs_finished_check
  CHECK ((status IN ('succeeded', 'dead')) = (finished_at IS NOT NULL));
```

Run in a transaction and rolled back, against the development database on
2026-11-27, that applies cleanly — because that database currently has no
`cancelled` row. Insert one and the same reverse fails:

```
ERROR:  check constraint "jobs_status_check" of relation "jobs" is violated by some row
```

So the reverse is only half the work. Every reverse that narrows a domain needs a
decision about the rows that domain already holds. For `cancelled`, three of the
four options are worse than keeping the status, and the fourth buys a permanent
artefact:

| Choice | Consequence |
|---|---|
| relabel `cancelled` → `dead` | fabricates a failure and an attempt that never happened; an operator reading `last_error` finds nothing |
| relabel `cancelled` → `succeeded` | fabricates success, which is worse: work that never ran reads as done |
| archive the rows to a side table first | honest, but needs the side table to outlive the reverse: a schema artefact kept forever for rows nobody reads |
| delete the rows | loses the record of a decision someone made |

Which is the point: the migration is reversible, the *state* is not. If the narrow
must happen anyway, archive the rows to a side table in the same migration — copy,
verify the count, then narrow — and say in the migration comment what the side
table is for and who may drop it. Write that decision down before running the
reverse, not after the constraint refuses it.

## 4. Expanding without breaking the running version

There is one deployed version of the API and one worker (`system-architecture.md`);
there is no blue/green pair and no hosting decision yet. So the rule is sized for
that, not for a zero-downtime luxury this deployment does not have:

1. **Add** — new column nullable, or with a default; new table; new index
   `CONCURRENTLY` only if the table is large enough to matter (`CREATE INDEX
   CONCURRENTLY` cannot run inside Prisma's per-migration transaction, which is a
   reason to add it in a separate migration file).
2. **Backfill** — in the worker as a `maintenance` job, not in the migration. A
   migration that rewrites rows holds a lock for its whole duration and cannot be
   resumed.
3. **Switch** — new code reads the new shape. The old shape is still written.
4. **Drop** — a later release, after one release in which nothing reads the old
   shape. This is the only step that needs the previous release to be gone.

Steps 1–3 are reversible by a new migration. Step 4 is the irreversible one, and
it is why it waits: a dropped column is the only thing on this page that a restore
is needed to undo.

## 5. Restore, and its limits

`docs/operations/backup-restore.md` records a verified dump/restore drill. Use it
when the schema is unwritable or data is damaged, not as a routine reverse: a
restore loses every write after the dump, including job progress and ingestion
history that the queue would otherwise recover on its own.

Limits, unchanged from that document: the drill is development-scoped, one
machine, no retention schedule, no PITR, no managed instance. A production restore
is blocked on the hosting decision.

## 6. What is not covered

- **No rehearsal of a reverse migration.** The only replay that is exercised is
  forward from zero (`pnpm db:reset`). A reverse that has never been run against a
  full dataset is a plan, not a tested procedure.
- **No production instance.** Every statement above was checked against the
  development database on `127.0.0.1:5442`.
- **No concurrent-deployment safety.** Expand/contract is stated for one version.
  If a second version ever runs beside the first, step 4's rule tightens to "drop
  only after the old version is undeployed", which needs a deployment record that
  does not exist yet.
- **No statement about the CI host.** `pnpm db:verify` runs as `migration_owner` and
  reads `MIGRATION_DATABASE_URL`, so running it in CI assumes a trusted runner.
  That is the same assumption `db:migrate` already requires; this check adds no new
  one, but it does add a second command that holds the credential.
