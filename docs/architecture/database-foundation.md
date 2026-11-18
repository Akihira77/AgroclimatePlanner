# Database foundation (Phase 2.2.1 + 2.2.1.x)

The database is PostgreSQL 18 with PostGIS 3.6. Prisma is the client and the
migration ledger — not the schema author.

## What exists

| Piece | Location |
|---|---|
| Postgres + PostGIS container, health check, named volume, loopback port | `docker-compose.yml` |
| Prisma config (env resolution, datasource URL, migration path) | `packages/database/prisma.config.ts` |
| Datasource + generator, **no models yet** | `packages/database/prisma/schema.prisma` |
| Baseline migration (extension + precondition guards) | `packages/database/prisma/migrations/20261118000000_init_extensions/` |
| Client factory | `packages/database/src/index.ts` |

Root scripts: `db:up`, `db:down`, `db:reset`, `db:migrate`, `db:generate`, `db:status`.

Port **5442**, not 5432: the development host already runs unrelated PostgreSQL
containers on 5432 and 5433. An unusual port is a smaller problem than a
migration applied to the wrong database.

## One configuration source

Compose reads a root `.env` implicitly. Prisma 7 reads no `.env` at all, and its
CLI runs from `packages/database`. Two mechanisms reading two different things is
how a migration ends up applied to a database the application does not use.

`prisma.config.ts` therefore resolves the root `.env` **from its own file
location**, never from the working directory, and derives the connection from the
same variables Compose uses:

| Variable | Effect |
|---|---|
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` / `POSTGRES_PORT` | Compose creates the database; Prisma builds its URL from the same four values |
| `DATABASE_URL` | Overrides all of the above; the only way to point Prisma somewhere Compose does not own |
| `NODE_ENV=development` | Selects development mode (see below) |

`.env.example` documents exactly this. Neither `POSTGRES_*` nor `DATABASE_URL`
appears twice, so editing one place cannot desynchronise the pair.

Precedence is Compose's: an exported variable beats the file. Verified, because
the rule depends on it — `process.loadEnvFile` fills in only variables that are
not already set, so a `DATABASE_URL` in the process environment wins over the
file without any save-and-restore dance.

## Fail-closed outside development

Development is the only mode permitted to guess:

```
DATABASE_URL                      → used as-is
else NODE_ENV === "development"   → postgresql://…@127.0.0.1:${POSTGRES_PORT}/…
else                              → no datasource url
```

An unset `NODE_ENV` counts as *not* development. That is the point: a production
container with a forgotten variable must not quietly reach `localhost`. Commands
that connect (`migrate`, `db`, `studio`) abort with a message naming both
requirements; commands that do not connect — `generate`, `validate`, `format` —
keep working, so a clean checkout builds without any database configuration.

The error text contains no URL, host, user, or password. A failed deploy is a bad
time to publish credentials into CI logs.

`POSTGRES_*` values are read at startup by `initdb` only. Changing a user, password,
or database name on an existing volume does not rewrite it — use `pnpm db:reset`,
or Prisma will authenticate against a database that no longer matches the file.

## Generated client lifecycle

The client is generated to `packages/database/src/generated/prisma` and is **not
committed**. It is produced by every `typecheck` and every `build` in that package:

```json
"build": "prisma generate && tsc -p tsconfig.build.json",
"typecheck": "prisma generate && tsc -p tsconfig.json --noEmit"
```

Typecheck generating first is not belt-and-braces. Turbo's `typecheck` depends on
`^build` — its *dependencies'* builds — which says nothing about this package's own
generated output. A clean checkout running `pnpm typecheck` without `pnpm build`
would have had nothing to compile against. Regeneration costs ~25 ms; a stale
artifact costs a confusing "no exported member" hunt.

## Loopback-only

```yaml
ports:
  - "127.0.0.1:${POSTGRES_PORT:-5442}:5432"
```

A development database with no authentication beyond a known password should not
accept connections from the rest of the network. Verified with `ss -ltn`: the
listener is `127.0.0.1:5442`, not `0.0.0.0:5442`.

## UUIDv7

PostgreSQL 18 provides `uuidv7()` natively. There is no extension, no application
generator, and no hand-rolled PL/pgSQL function. The baseline migration proves the
function is the server's own:

```sql
IF to_regprocedure('pg_catalog.uuidv7()') IS NULL THEN
  RAISE EXCEPTION 'pg_catalog.uuidv7() is required (PostgreSQL 18+) …', current_setting('server_version');
END IF;
```

The earlier check matched `pg_proc.proname = 'uuidv7' AND pronargs = 0` — any
schema, any owner. Measured on this server, with a user-defined stub added:

```
native_present=true
public_stub_before=false
public_stub_after=true
same_object=false                      -- distinct OIDs
old_predicate_matches=2                -- the old guard would have passed on the stub
new_predicate_target=uuidv7()          -- resolves inside pg_catalog
```

So a schema other than `pg_catalog` can satisfy a name-only predicate while
providing nothing. Resolution by exact signature and schema cannot be spoofed that
way, and a wrong signature aborts the migration rather than proceeding — verified
by running the guard against `pg_catalog.uuidv7(integer)`, which raised.

Domain models will declare:

```prisma
id String @id @default(dbgenerated("uuidv7()")) @db.Uuid
```

Database-side generation is deliberate. A client-side generator produces ids for
rows inserted through the ORM and nothing else; seed scripts, `psql`, and future
`COPY` paths would need their own. One default in one place keeps the single id
space actually single.

**Ordering caveat.** `uuidv7()` is time-ordered within a backend, and a batch in
one statement sorts lexicographically (verified). It is not a global total order:
concurrent backends in the same millisecond still differ in the random tail. Ids
are suitable for B-tree locality, not for pagination or "latest row" semantics.

## Migrations are SQL, and reviewed

Migrate with `prisma migrate deploy`. `prisma migrate dev` is deliberately unused.

The reason is measurable, not stylistic. It replays history into a shadow database
and diffs the result against the schema. PostGIS installs its own objects in
`public`, and Prisma sees them as unmanaged models:

```
$ npx prisma db pull --print | grep '^model '
model spatial_ref_sys {
```

That table belongs to PostGIS, not to us. Any shadow-database diff starts from a
state containing it, so every future migration would either propose dropping
PostGIS internals or report permanent drift. Roles, `GRANT`s, and RLS policies
(2.2.2+) are also plain SQL that no schema-only diff can express.

Consequences, stated so nobody assumes otherwise:

- `schema.prisma` and the migrations directory are kept consistent **by hand**.
- `db:status` reports applied versus pending. Nothing diffs them.
- `migrate deploy` does **not** verify checksums. Measured: after overwriting the
  checksum of an applied migration, both `migrate status` and `migrate deploy`
  reported success. Editing an applied migration is therefore silently accepted —
  every environment that already ran it keeps the old SQL, and no tooling says so.
  Treat applied migrations as immutable; change a guard by adding a migration.
  The 2.2.1.x hardening edited the baseline in place because it had never left a
  local development volume; any other volume needs `pnpm db:reset`.

### Privileged migration connection (requirement for 2.2.2)

Schema DDL must not run as either runtime role. `app_api` is subject to RLS and
holds tenant-scoped privileges; `app_system` is `BYPASSRLS` for system jobs.
Neither may own tables and neither may `CREATE`. Migration execution requires a
dedicated privileged owner/migration connection, separate from both, and that
connection must not be reachable by the API or the worker.

Not implemented in this phase — 2.2.2 introduces the roles and the grant matrix.
Recorded here so the migration path is not quietly wired to a runtime role later.

## Prisma 7 specifics

Prisma 7 has no bundled query engine; the client requires a driver adapter. Here
that is `@prisma/adapter-pg` over `pg`, which also means connection pooling is
`pg`'s pool — relevant to the transaction-scoped RLS work in 2.2.3.

- `prisma` and `@prisma/client` are pinned to **7.10.1**. On npm the `latest` tag
  for `prisma` currently points at `8.0.0-rc.34`, so the CLI's own "run
  `npm i prisma@latest`" notice recommends a release candidate. The pin is why;
  ignore that message.
- `pnpm approve-builds` was needed once: pnpm 12 blocks dependency build scripts
  and Prisma's schema engine has one. Recorded under `allowBuilds` in
  `pnpm-workspace.yaml`.

## Deferred

Not implemented here, and required before any tenant data exists:

- `app_api` / `app_system` roles, explicit grants, default-deny, and the separate
  privileged migration role (2.2.2).
- Tenant-owned tables, RLS policies, `withTenant(userId, fn)` using
  transaction-scoped `set_config(..., true)` (2.2.3).
- Security tests executed as the real roles, so `insufficient_privilege` comes
  from PostgreSQL rather than from mocks (2.2.4).

`evidenceSegments` collection validation, geometry column conventions, and
payload-size limits remain open from earlier phases.
