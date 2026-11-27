# Backup and restore — verified drill

Phase 9, `docs/IMPLEMENTATION_MASTER_ROADMAP.md` §13.6. It records one restore
that was actually run on this machine, the exact commands, and what the run does
**not** prove.

**Scope.** Development PostgreSQL 18 + PostGIS in Docker (`127.0.0.1:5442`,
database `agroclimate`). There is no production instance, so nothing below
describes a managed database, point-in-time recovery, retention or off-site
copies. Those are provider decisions and stay open on the roadmap.

---

## 1. Why a dump is not a backup until it restores

`pg_dump` exits successfully for a database whose schema cannot be replayed — a
missing role, a function depending on an extension, a policy referencing a
dropped column. The drill therefore has three gates, and only the third is
evidence:

1. `pg_dump -Fc` exits 0.
2. `pg_restore -l` lists the archive (the file is a readable custom-format dump).
3. `pg_restore --exit-on-error` into a **separate** database exits 0 **and** the
   restored object and row counts match the source.

## 2. Commands

Run from the repository root. `docker exec` is used because the database is only
reachable on loopback; a managed instance needs its own connection string
instead.

```bash
# 1. dump
docker exec agroclimate-db pg_dump -U agroclimate -Fc agroclimate > /tmp/agroclimate.dump

# 2. is the archive readable?
docker exec agroclimate-db pg_restore -l -U agroclimate /dev/stdin < /tmp/agroclimate.dump | head

# 3. restore into a throwaway database, never over the live one
docker cp /tmp/agroclimate.dump agroclimate-db:/tmp/agroclimate.dump
docker exec agroclimate-db sh -c \
  'dropdb -U agroclimate --if-exists agroclimate_restore_check && createdb -U agroclimate agroclimate_restore_check'
docker exec agroclimate-db sh -c \
  'pg_restore -U agroclimate -d agroclimate_restore_check --exit-on-error /tmp/agroclimate.dump'
```

`--exit-on-error` is the point of the drill: without it `pg_restore` reports every
failure as a warning and still exits 0.

## 3. Comparison queries

Structure and security objects first, because a restore that loses RLS looks fine
and is not.

```sql
-- per database
select count(*) from information_schema.tables where table_schema = 'app';          -- 26
select count(*) from pg_policies;                                                    -- 24
select count(*) from pg_indexes where schemaname = 'app';                            -- 88
select count(*) from pg_constraint c join pg_namespace n on n.oid = c.connamespace
  where n.nspname = 'app';                                                           -- 472
select count(*) from information_schema.role_table_grants where table_schema = 'app'; -- 263
select count(*) from pg_trigger where not tgisinternal;                              -- 5
select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'app';                                                           -- 3
select tableowner, count(*) from pg_tables where schemaname = 'app' group by 1;      -- migration_owner, 26
select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'app' and c.relrowsecurity;                                      -- 11
select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'app' and c.relforcerowsecurity;                                 -- 11
```

Then rows, per table, in both databases:

```bash
for db in agroclimate agroclimate_restore_check; do
  echo "== $db"
  docker exec agroclimate-db sh -c "psql -U agroclimate -d $db -Atc \
    \"select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'app' and c.relkind = 'r' order by 1\"" |
  while read -r table; do
    printf '%s=' "$table"
    docker exec agroclimate-db sh -c "psql -U agroclimate -d $db -Atc 'select count(*) from app.\"$table\"'"
  done
done
```

`pg_stat_user_tables.n_live_tup` is **not** a substitute: it is a planner estimate,
refreshed by autovacuum, and it disagreed with the real count for one table in this
drill (`fields` read 12 while the table held 0). The comparison uses `count(*)`.

## 4. Cleanup

```bash
docker exec agroclimate-db sh -c 'dropdb -U agroclimate --if-exists agroclimate_restore_check'
docker exec agroclimate-db rm -f /tmp/agroclimate.dump
rm -f /tmp/agroclimate.dump
```

A dump contains every row of every table, including password hashes and session
tokens. It is a secret file: delete it after the drill, and never attach one to an
issue.

## 5. What the 2026-11-27 drill established

| Check | Result |
|---|---|
| `pg_dump -Fc` | exit 0, 145 723 bytes |
| `pg_restore -l` | archive listed |
| `pg_restore --exit-on-error` into `agroclimate_restore_check` | exit 0, 4 s |
| Structure | 26 `app` tables, 88 indexes, 472 constraints, 3 `app` functions, 5 triggers — identical |
| Tenancy | 11 tables with RLS enabled **and** forced, 24 policies, 263 table grants — identical |
| Ownership | all 26 tables owned by `migration_owner` in both |
| Rows | every table identical, including the non-empty ones: `users` 41, `weather_records` 120, `climatology_normals` 48, `monthly_outlooks` 40, `forecast_runs` 9, `jobs` 11, `ingestion_runs` 11, `_prisma_migrations` 11, `outlook_cells` 5, `climatology_baselines` 4, `sessions` 1 |
| Roles | `app_api`, `app_auth`, `app_system`, `migration_owner` are cluster-wide and already existed, so ownership resolved; a restore into a **different** cluster needs the roles created first (`pnpm db:bootstrap`) or `pg_restore` fails on ownership |

## 6. What it does not prove

- **Production.** No managed instance, no WAL archiving, no point-in-time
  recovery, no retention policy, no off-site copy, no encryption at rest. All of
  that belongs to the hosting decision (§13.7), not to this drill.
- **Scheduling.** Nothing takes a backup automatically; the command above is run
  by hand.
- **The application roles.** The restore ran as the `agroclimate` superuser. That
  the API and worker still work against a restored database — RLS applied through
  `app.user_id`, grants intact at runtime — was verified by the same role and
  policy objects existing, not by issuing a query as `app_api`. `pnpm db:verify`
  and `pnpm db:verify:probes` are the tools that check that, and they run against
  the configured database, not against an arbitrary restored one.
- **A real loss.** The source database was healthy and nothing was overwritten;
  the drill proves a dump of a healthy database restores, which is weaker than
  restoring after corruption or a bad migration.
