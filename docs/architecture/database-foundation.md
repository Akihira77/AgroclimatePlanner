# Database foundation (Phase 2.2.1 – 2.2.2)

The database is PostgreSQL 18 with PostGIS 3.6. Prisma is the client and the
migration ledger — not the schema author.

## What exists

| Piece | Location |
|---|---|
| Postgres + PostGIS container, health check, named volume, loopback port | `docker-compose.yml` |
| Prisma config (env resolution, migration URL, migration path) | `packages/database/prisma.config.ts` |
| Datasource + generator, **no models yet** | `packages/database/prisma/schema.prisma` |
| Baseline migration (extension + precondition guards) | `packages/database/prisma/migrations/20261118000000_init_extensions/` |
| Client factory | `packages/database/src/index.ts` |
| Role boundary, schema ownership, default deny | `packages/database/bootstrap/roles.sql` |
| Role provisioning (passwords from env, cluster-admin connection) | `packages/database/scripts/bootstrap.mjs` |
| Privilege verification against the real roles | `packages/database/scripts/verify-privileges.mjs` |

Root scripts: `db:up`, `db:down`, `db:reset`, `db:bootstrap`, `db:migrate`, `db:verify`, `db:generate`, `db:status`.

`db:reset` deletes the volume — which deletes the roles too, `initdb` having run
once — so it re-runs `db:bootstrap` before `db:migrate`. The order matters.

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
| `POSTGRES_DB` / `POSTGRES_HOST` / `POSTGRES_PORT` | Compose creates the database; Prisma builds its URL from the same values |
| `MIGRATION_DATABASE_URL` | Overrides everything below; required outside development |
| `MIGRATION_OWNER_PASSWORD` | Password for the `migration_owner` role |
| `NODE_ENV=development` | Selects development mode (see below) |

`.env.example` documents exactly this. Neither the host, the port, nor the
database name appears twice, so editing one place cannot desynchronise the pair.

The datasource is `migration_owner`, not the cluster admin and not a runtime
role, with `?schema=app` so the ledger lands inside the schema that role owns.
`POSTGRES_USER` / `POSTGRES_PASSWORD` remain Compose's bootstrap credentials for
`initdb` and are no longer used by Prisma at all — the admin connection exists
only for `db:bootstrap`.

Precedence is Compose's: an exported variable beats the file. Verified, because
the rule depends on it — `process.loadEnvFile` fills in only variables that are
not already set, so a `MIGRATION_DATABASE_URL` in the process environment wins
over the file without any save-and-restore dance.

Empty values are treated as absent on both sides. Compose uses `${VAR:-default}`,
which falls back for an unset *or empty* value; the config therefore uses `||`
rather than `??`. With `??`, `POSTGRES_PORT=` produced
`postgresql://:@127.0.0.1:/` while Compose quietly used 5442 — the exact desync
this file exists to prevent, reachable by leaving one `=` blank.

## Fail-closed outside development

Development is the only mode permitted to guess:

```
MIGRATION_DATABASE_URL           → used as-is
else NODE_ENV === "development"  → postgresql://migration_owner:…@127.0.0.1:${POSTGRES_PORT}/${POSTGRES_DB}?schema=app
else                             → no datasource url
```

An unset `NODE_ENV` counts as *not* development. That is the point: a production
container with a forgotten variable must not quietly reach `localhost`. Commands
that connect (`migrate`, `db`, `studio`) abort with a message naming both
requirements; commands that do not connect — `generate`, `validate`, `format` —
keep working, so a clean checkout builds without any database configuration.

`db:bootstrap` follows the same rule with `BOOTSTRAP_DATABASE_URL`, and it is
stricter: role bootstrap is a cluster-admin action, so outside development there
is no derived fallback of any kind, only the explicit URL.

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

### Privileged migration connection

Schema DDL must not run as either runtime role. `app_api` is subject to RLS and
holds tenant-scoped privileges; `app_system` is `BYPASSRLS` for system jobs.
Neither may own tables and neither may `CREATE`. Migration execution connects as
`migration_owner`, and that connection is not reachable by the API or the worker.

See [Role and privilege boundary](#role-and-privilege-boundary-phase-222).

## Role and privilege boundary (Phase 2.2.2)

Three roles, one schema. `bootstrap/roles.sql` creates them; it is executed by
`scripts/bootstrap.mjs` as a **cluster admin**, not as a migration.

That split is deliberate. `CREATE ROLE` is a cluster privilege. If migrations
could create roles, a compromised migration connection would be a compromised
cluster, so role creation lives outside the migration path entirely.

| Role              | Login          | Attributes                                        | Owns      |
| ----------------- | -------------- | ------------------------------------------------- | --------- |
| `migration_owner` | provisioned    | `NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS` | `app`     |
| `app_api`         | provisioned    | `NOBYPASSRLS`                                     | nothing   |
| `app_system`      | provisioned    | `BYPASSRLS`                                       | nothing   |

All three carry `NOINHERIT`: no role is a member of another, so there is no
privilege path to walk and no `SET ROLE` escalation to audit.

### No credentials in the repository

`bootstrap/roles.sql` contains no passwords and cannot: it creates the roles
`NOLOGIN`, and the provisioning step that follows turns `LOGIN` on with a
password read from the environment. Development placeholders live in
`database.defaults.json` and are applied only when `NODE_ENV=development`; outside
development `bootstrap.mjs` refuses to run without explicit values and without
`BOOTSTRAP_DATABASE_URL`. The password is passed to `ALTER ROLE` through
`format(%L, …)` server-side, so it is a quoted literal and never a statement that
gets logged.

### Why `app` and not `public`

`public` belongs to PostGIS — `spatial_ref_sys`, `postgis`, `fuzzystrmatch`,
`tiger` all install there. Application objects live in `app`, owned by
`migration_owner`, which also puts the Prisma ledger out of reach of the
extension-installed objects.

`CREATE` on `public` is revoked from `PUBLIC`; both runtime roles get `USAGE`
only, enough to resolve PostGIS types and functions, not enough to create
anything.

On a development volume created before this phase the ledger sat in `public`,
owned by the cluster admin. The bootstrap moves it to `app` and reassigns
ownership once; subsequent runs find it already there.

### Default deny

Nothing is granted to either runtime role by default. Both get `USAGE` on `app`
and nothing else: no table, sequence, or function privilege, on any object, until
a migration grants it explicitly.

Default privileges are declared for `migration_owner`, the only role that creates
application objects:

```sql
ALTER DEFAULT PRIVILEGES FOR ROLE migration_owner
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, app_api, app_system;
```

**Only the function entry is needed, and the schema-qualified form does not
work.** Measured on PostgreSQL 18.6:

- `... IN SCHEMA app REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC` records no
  `pg_default_acl` row and changes nothing — a function created afterwards was
  still executable by `app_api` (and by `PUBLIC`, which is where it comes from:
  functions are executable by `PUBLIC` by default).
- The unqualified form stores `{migration_owner=X/migration_owner}` and a
  subsequent function was no longer executable by `app_api`.
- The equivalent `REVOKE` for tables and sequences records a row only if it
  actually removes something, and PostgreSQL grants no table or sequence
  privilege to other roles by default, so no entry appears and none is required.
  `db:verify` checks this against a table created after the bootstrap, which is
  the assertion that matters — not the presence of a catalogue row.

### What is verified, and how

`pnpm db:verify` connects three times over TCP, as each real role with its real
password, and asserts behaviour. A denial counts only when PostgreSQL answers
SQLSTATE `42501`; a missing table (`42P01`), a bad credential (`28P01`), or a
syntax error all fail the check instead of silently looking like a boundary.

61 checks, covering: identity (`current_user` matches the role, so a denial from
the wrong role cannot pass), attributes, absence of memberships, schema ownership
and `USAGE`/`CREATE`, default privileges, and then, against probe objects created
*after* the grants were configured — so any access would have to come from a
default that grants too much:

- `SELECT`/`INSERT`/`UPDATE`/`DELETE` on an ungranted table, for both roles
- `CREATE`/`ALTER`/`DROP` on application tables
- `nextval` on an ungranted sequence, `EXECUTE` on an ungranted function
- `SET ROLE` to any other role, `CREATE SCHEMA`, writes to the migration ledger
- column-level grants: one granted column readable, its neighbour not, `SELECT *`
  denied, and removal of the grant taking effect

The column-level case is the stand-in for the 2.2.2 acceptance criteria that name
`fields.geom` and `ai_briefings`. Those tables do not exist yet; the mechanism
does, and it is enforced by PostgreSQL rather than by the application.

`app_system` is not exempt. `BYPASSRLS` bypasses row policies only — it confers
no table, column, or function privilege, and the verification shows it being
refused exactly where `app_api` is.

### Probe objects never persist

`app.privilege_probe`, its sequence, and its function are created by the
verification run and dropped in a `finally` block. They are not migrations and
never appear in a migration ledger.

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

- Tenant-owned tables, RLS policies, `withTenant(userId, fn)` using
  transaction-scoped `set_config(..., true)` (2.2.3).
- Security tests executed as the real roles against the real domain tables, so
  `insufficient_privilege` on `fields.geom` and `ai_briefings.body` comes from
  PostgreSQL rather than from mocks (2.2.4).
- Rotation of the role passwords without a cluster-admin connection; today that
  is `pnpm db:bootstrap` with the new value in the environment.

`evidenceSegments` collection validation, geometry column conventions, and
payload-size limits remain open from earlier phases.
