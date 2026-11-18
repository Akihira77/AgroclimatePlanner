# Database foundation (Phase 2.2.1)

The database is PostgreSQL 18 with PostGIS 3.6. Prisma is the client and the
migration ledger — not the schema author.

## What exists

| Piece | Location |
|---|---|
| Postgres + PostGIS container, health check, named volume | `docker-compose.yml` |
| Prisma config (datasource URL, migration path) | `packages/database/prisma.config.ts` |
| Datasource + generator, **no models yet** | `packages/database/prisma/schema.prisma` |
| Baseline migration (extension + precondition guards) | `packages/database/prisma/migrations/20261118000000_init_extensions/` |
| Client factory | `packages/database/src/index.ts` |

Root scripts: `db:up`, `db:down`, `db:reset`, `db:migrate`, `db:generate`, `db:status`.

Port **5442**, not 5432: the development host already runs unrelated PostgreSQL
containers on 5432 and 5433. An unusual port is a smaller problem than a
migration applied to the wrong database.

PostgreSQL 18 images keep `PGDATA` at `/var/lib/postgresql/18/docker` and
declare the volume at `/var/lib/postgresql`. Mounting `/var/lib/postgresql/data`
— the pre-18 convention — silently persists nothing.

## UUIDv7

PostgreSQL 18 provides `uuidv7()` natively. There is no extension, no application
generator, and no hand-rolled PL/pgSQL function. The baseline migration asserts
that a zero-argument `uuidv7()` exists and aborts otherwise, so an older server
cannot produce a schema whose id default does not exist.

Domain models will declare it as a database-generated default:

```prisma
id String @id @default(dbgenerated("uuidv7()")) @db.Uuid
```

Database-side generation is deliberate. A client-side generator produces ids for
rows inserted through the ORM and nothing else; seed scripts, `psql`, and future
`COPY` paths would then need their own generator and would drift. One default in
one place keeps the single id space actually single.

**Ordering caveat.** `uuidv7()` is time-ordered within a backend, and a batch in
one statement sorts lexicographically (verified). It is not a global total order:
concurrent backends in the same millisecond still collide in the random tail. Ids
are suitable for B-tree locality, not for pagination or "latest row" semantics.
Use an explicit sort column for those.

## Migrations are SQL, and reviewed

Migrate with `prisma migrate deploy`. `prisma migrate dev` is deliberately unused.

The reason is measurable, not stylistic. It replays history into a shadow
database and diffs the result against the schema. PostGIS installs its own
objects in `public`, and Prisma sees them as unmanaged models:

```
$ npx prisma db pull --print | grep -c '^model '
1
$ npx prisma db pull --print | grep '^model '
model spatial_ref_sys {
```

That table belongs to PostGIS, not to us. Any shadow-database diff starts from a
state that includes it, so every future migration would either propose dropping
PostGIS internals or report permanent drift. Roles, `GRANT`s, and RLS policies
(2.2.2+) are also plain SQL that no schema-only diff can express.

Consequences, stated so nobody assumes otherwise:

- `schema.prisma` and the migrations directory are kept consistent **by hand**.
- `db:status` reports applied versus pending. Nothing diffs them.
- New DDL is written as SQL, reviewed, then applied. For a new table, the
  practical loop is: write the SQL, apply it to a scratch database, and let
  Prisma's generated types follow the model block you wrote alongside it.

## Prisma 7 specifics

Prisma 7 has no bundled query engine; the client requires a driver adapter. Here
that is `@prisma/adapter-pg` over `pg`, which also means connection pooling is
`pg`'s pool — relevant to the transaction-scoped RLS work in 2.2.3.

- The generated client is written to `packages/database/src/generated/prisma` and
  is **not committed**; `pnpm build` regenerates it before `tsc`.
- `prisma` and `@prisma/client` are pinned to **7.10.1**. Note that on npm the
  `latest` tag for `prisma` currently points at `8.0.0-rc.34`, so the CLI's own
  "run `npm i prisma@latest`" upgrade notice suggests a release candidate. The
  version is pinned for that reason; ignore that message.
- `pnpm approve-builds` was needed once: pnpm 12 blocks dependency build scripts,
  and Prisma's schema engine has one. Recorded under `allowBuilds` in
  `pnpm-workspace.yaml`.
- Prisma 7 does not read `.env`. The CLI runs from this package's directory, so
  the local URL is the default in `prisma.config.ts` and `DATABASE_URL` overrides
  it. Production refuses to start without an explicit URL.

## Deferred

Not implemented here, and required before any tenant data exists:

- `app_api` / `app_system` roles, explicit grants, default-deny (2.2.2).
- Tenant-owned tables, RLS policies, `withTenant(userId, fn)` using
  transaction-scoped `set_config(..., true)` (2.2.3).
- Security tests executed as the real roles, so `insufficient_privilege` comes
  from PostgreSQL rather than from mocks (2.2.4).

`evidenceSegments` collection validation, geometry column conventions, and
payload-size limits remain open from earlier phases.
