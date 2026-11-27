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
| Shared connection resolution for every script | `packages/database/scripts/lib/connections.mjs` |
| Privilege verification against the real roles | `packages/database/scripts/lib/privilege-verification.mjs` |
| Probe isolation and cleanup-safety test | `packages/database/scripts/verify-probe-isolation.mjs` |
| Tenant tables, RLS policies, runtime grants | `packages/database/prisma/migrations/20261118020000_tenant_tables/` |
| Session CSRF token: one nullable column, one CHECK, two column grants | `packages/database/prisma/migrations/20261121000000_session_csrf_token/` |
| `withTenant` — the only tenant entry point | `packages/database/src/tenant.ts` |
| Unit tests (no database) and RLS integration tests | `packages/database/test/unit/`, `packages/database/test/rls/` |

Root scripts: `db:up`, `db:down`, `db:reset`, `db:bootstrap`, `db:migrate`, `db:verify`, `db:verify:probes`, `db:generate`, `db:status`.

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

Schema DDL must not run as any runtime role. `app_api` is subject to RLS and
holds tenant-scoped privileges; `app_system` is `BYPASSRLS` for system jobs;
`app_auth` reads credentials outside a tenant context. None of them may own tables
and none may `CREATE`. Migration execution connects as `migration_owner`, and that
connection is not reachable by the API or the worker.

See [Role and privilege boundary](#role-and-privilege-boundary-phase-222).

## Role and privilege boundary (Phase 2.2.2)

Four roles, one schema. Three came with Phase 2.2.2; `app_auth` came with S3.
`bootstrap/roles.sql` creates them all; it is executed by `scripts/bootstrap.mjs`
as a **cluster admin**, not as a migration.

That split is deliberate. `CREATE ROLE` is a cluster privilege. If migrations
could create roles, a compromised migration connection would be a compromised
cluster, so role creation lives outside the migration path entirely.

| Role              | Login          | Attributes                                        | Owns      |
| ----------------- | -------------- | ------------------------------------------------- | --------- |
| `migration_owner` | provisioned    | `NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS` | `app`     |
| `app_api`         | provisioned    | `NOBYPASSRLS`                                     | nothing   |
| `app_system`      | provisioned    | `BYPASSRLS`                                       | nothing   |
| `app_auth`        | provisioned    | `NOBYPASSRLS`                                     | nothing   |

`app_auth` gets `USAGE` on `app` and, after S4, a column grant on exactly one table:
`SELECT (id, email, password_hash, role, locale, timezone)` and `INSERT (email,
password_hash)` on `app.users`. No ownership, no `UPDATE`, no `DELETE`, no table-wide
privilege anywhere. Its purpose is to reach credentials before a tenant context
exists, and ADR-004 is explicit that the RLS boundary must not be the thing that
contains it.

All four carry `NOINHERIT`: no role is a member of another, so there is no
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

`CREATE` on `public` is revoked from `PUBLIC` and from `app_api` and
`app_system`. `USAGE` is a different privilege and must not be conflated with it.
PostgreSQL's stock ACL for `public` is
`{pg_database_owner=UC/pg_database_owner,=U/pg_database_owner}`, and `=U` is a
grant to `PUBLIC`: every role has effective `USAGE` on the schema, including
`app_auth`, which receives no direct grant of its own. Measured on a freshly
bootstrapped volume, `has_schema_privilege` returns `true` for `USAGE` and
`false` for `CREATE` for all four roles. The direct `app_api=U` and
`app_system=U` entries are therefore redundant with the `PUBLIC` grant; they are
kept so the intent is visible in `nspacl` and so a future `REVOKE ... FROM
PUBLIC` would not silently remove the runtime roles' access.

Effective `USAGE` is not access. Schema `USAGE` only lets a role resolve names
inside the schema; it confers nothing on the objects in it. What `app_auth` can
actually read in `public` is what the PostGIS installer granted to `PUBLIC`:
`SELECT` on `spatial_ref_sys` and on the `geometry_columns` and
`geography_columns` views. Those are EPSG metadata and catalog views — no tenant
data, nothing this project grants, and outside the `app` schema that holds
everything else. `db:verify` asserts the part that matters in aggregate:
`app_auth` owns nothing, holds no table privilege in `app`, and holds no column
privilege outside `app.users` — where the six `SELECT` and two `INSERT` columns of
S4 are asserted as an exact set.

On a development volume created before this phase the ledger sat in `public`,
owned by the cluster admin. The bootstrap moves it to `app` and reassigns
ownership once; subsequent runs find it already there.

### Default deny

Nothing is granted to a runtime role by default. All three get `USAGE` on `app`
and nothing else: no table, sequence, or function privilege, on any object, until
a migration grants it explicitly — which is how `app_auth` acquired its two column
grants on `app.users` and why they are absent from `bootstrap/roles.sql`.

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

65 checks, covering: identity (`current_user` matches the role, so a denial from
the wrong role cannot pass), attributes, absence of memberships, schema ownership
and `USAGE`/`CREATE`, default privileges, bootstrap idempotency, and then, against
probe objects created *after* the grants were configured — so any access would
have to come from a default that grants too much:

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

The verification creates `app.privilege_probe_{t,s,f}_<token>`, where the token
is 12 hex characters generated per run, and drops them in a `finally` block. They
are not migrations and never appear in a migration ledger.

Two properties follow, and both are asserted by `pnpm db:verify:probes`:

- **Concurrency.** Two runs in flight create distinct objects by construction, so
  neither can drop the other's table mid-assertion. The old static names made
  concurrent runs delete each other's fixtures, and a name clash with a real
  object would have dropped it.
- **Cleanup safety.** Only objects whose creation succeeded are dropped, and only
  under this run's token. A failing setup leaves its own partial work removed and
  anything else alone — the test forces a failure through the library's
  `afterProbeSetup` hook and then asserts the schema is clean.

The legacy names (`privilege_probe`, `privilege_probe_sequence`,
`privilege_probe_function`) are now the decoy fixture: the test creates them,
runs two verifications concurrently, and asserts all three survive with the same
oids, the same row, the same sequence value, and the same function result.
`privilege_probe_sequence` and `privilege_probe_function` share a prefix with the
new scheme, which is why the leftover scan matches `privilege\_probe\_[tsf]\_%`
rather than the looser pattern.

### Bootstrap is checked for idempotency, not assumed

`db:verify` plants `GRANT CREATE ON SCHEMA app TO app_api`, re-runs
`bootstrap.mjs` as the cluster admin, and then asserts the grant is gone and
`USAGE` remains. Bootstrap normalises with `REVOKE ALL ON SCHEMA app FROM
app_api, app_system, app_auth` before granting `USAGE`, so repeated runs converge
instead of accumulating whatever an older bootstrap version left behind.

Without cluster-admin credentials — `BOOTSTRAP_DATABASE_URL` unset outside
development — the check **fails** and names the missing variable. It is not a
skip: a run that silently omits idempotency still prints "all checks passed", and
an operator reads that as a verified bootstrap. The only opt-out is
`reBootstrap: false`, which the probe-isolation test needs because a re-bootstrap
would contend with itself.

The same rule applies to the role credentials: a missing `*_PASSWORD` fails the
run with the variable name, never a value, rather than quietly reducing coverage.

`public` is owned by `pg_database_owner`, so only a cluster admin can normalise
direct grants on it; `REVOKE CREATE ON SCHEMA public` for the runtime roles is
part of the bootstrap, and `db:verify` asserts the effect
(`has_schema_privilege(app_api, 'public', 'CREATE')` is false).

### Fresh-volume verification in a throwaway Compose project

The documented reset path deletes a volume, so it must not be exercised against
the development database. Run it as a separate Compose project instead — its own
container name, its own port, and a volume that belongs only to it:

```bash
COMPOSE_PROJECT_NAME=agroclimate-reset-check \
DB_CONTAINER_NAME=agroclimate-db-reset-check \
POSTGRES_PORT=5542 \
NODE_ENV=development \
pnpm db:reset

# same four variables:
pnpm db:verify
pnpm db:status

# teardown: the isolated project only
COMPOSE_PROJECT_NAME=agroclimate-reset-check \
DB_CONTAINER_NAME=agroclimate-db-reset-check \
POSTGRES_PORT=5542 docker compose down -v
```

Exported variables beat the root `.env` on both sides — Compose's own precedence,
and `process.loadEnvFile` fills in only what the environment does not already set
— so the isolated run cannot reach 5442 even though `.env` says 5442.

`container_name` is `${DB_CONTAINER_NAME:-agroclimate-db}` for exactly this
reason: two Compose projects cannot share a container name, and renaming the
development container outright would orphan the running one on a live port.

## Tenant isolation (Phase 2.2.3)

Three tables, one ownership column, one policy shape. This is the first point at
which a forgotten `WHERE user_id = …` stops being a data-leak class bug, because
PostgreSQL refuses the rows instead.

### Inventory

| Table | Ownership column | Policy `USING` / `WITH CHECK` |
|---|---|---|
| `app.users` | `id` (the tenant itself) | `id = NULLIF(current_setting('app.user_id', true), '')::uuid` |
| `app.farms` | `user_id` | `user_id = NULLIF(current_setting('app.user_id', true), '')::uuid` |
| `app.fields` | `user_id`, denormalised from `farms` | same as `farms` |

`user_id` is denormalised onto `fields` on purpose (domain-model §5, §7). The
alternative — a policy that joins through `farms` — makes every write a join
against another RLS-protected table, and puts the ownership rule in two places
instead of one.

Every table carries `ENABLE` **and** `FORCE ROW LEVEL SECURITY`. Without `FORCE`
the table owner bypasses its own policies, and the owner is `migration_owner` —
the connection that runs migrations and fixtures. `FORCE` also means the owner
needs a policy of its own, which is why each table has an explicit
`*_owner_full_access` policy for `migration_owner`. That widens nothing: owning a
table already means `ALTER` and `DROP`.

### Fail-closed, in three ways

```sql
user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
```

- unset → `current_setting(..., true)` is `NULL` → `NULLIF` is `NULL` → no row matches
- empty string → `NULLIF` is `NULL` → no row matches
- set → compared as `uuid`

No cast error, no default tenant, no "all rows if unset". A missing context reads
zero rows and cannot write: `WITH CHECK` has nothing to compare against, so
`INSERT` is rejected at SQLSTATE `42501` rather than silently storing a row
nobody can read.

### Ownership travels with the reference

```sql
CONSTRAINT fields_farm_owner_fkey FOREIGN KEY (farm_id, user_id)
  REFERENCES app.farms (id, user_id)
```

With `farms` carrying `UNIQUE (id, user_id)` as the target. A tenant cannot
create a field under another tenant's farm by writing its own `user_id`: the pair
must match a real farm row. This is a **referential-integrity** denial (`23503`),
distinct from an RLS denial (`42501`), and the test asserts the SQLSTATE rather
than lumping both together as "rejected".

### Runtime grants

| Table | `app_api` | `app_system` |
|---|---|---|
| `users` | none | none |
| `farms` | `SELECT, INSERT, UPDATE` | none |
| `fields` | `SELECT, INSERT, UPDATE` | none |

No `GRANT ALL`, no `GRANT … ON ALL TABLES`, no default privileges added: 2.2.2's
default-deny stays the baseline and each table opts in explicitly. No `DELETE`
either, for any runtime role: `20261128120000_revoke_runtime_delete` removed it
everywhere once the review found it granted and unused. A row that must survive is
a row an `UPDATE` marks — and a `DELETE` now fails with `42501` rather than
matching zero rows.

`app_system` keeps `BYPASSRLS` and receives nothing on these tables.
`background-processing.md` §10 rule 2 says a new tenant-owned table ships without
an `app_system` grant; the maintenance sweep that would need column-level reads
does not exist yet, so the grants do not exist either. When it does, the columns
are added one at a time and `db:verify` asserts the set equals the documented
list.

`app_api` has **no** grant on `app.users`. Reading a user by email is the
authentication path, and it runs before a tenant context exists — granting
`SELECT` here would either need an unpolicied table or invent a security-definer
function. Deferred, not forgotten.

### `withTenant` — the only entry point

```ts
const scope = createTenantScope(prisma);
const farms = await scope.withTenant(userId, (tx) => tx.farm.findMany());
```

`packages/database/src/tenant.ts`. Four decisions worth stating:

1. **Transaction-scoped.** `set_config('app.user_id', $1, true)` — the `true` is
   the whole point. A session-level setting on a pooled connection becomes the
   next request's identity.
2. **Row-returning raw API.** `$queryRaw`, not `$executeRaw`: `set_config`
   returns a row, and a write-path call discards the result — turning "the
   context failed to apply" into "the context silently is not there".
3. **The callback gets the transaction client.** It cannot reach the global
   client through `withTenant`, and the type it receives is Prisma's
   `TransactionClient`, which excludes `$transaction`, `$connect`, and the rest
   of the lifecycle methods.
4. **Nested scopes are rejected.** An inner `withTenant` would open an
   independent transaction with a different tenant — and with one connection in
   the pool it would deadlock behind its own caller. Internal functions take the
   `tx` they are given. Detection is per async context (`AsyncLocalStorage`), so
   two concurrent requests are not mistaken for nesting.

Validation happens before the transaction opens: a non-canonical UUID throws
`TenantContextError`, because an id that would never match a policy row is
indistinguishable from "this tenant has no data".

### Verified behaviour

`pnpm --filter @agroclimate/database test:rls` — 10 tests, all against a real
database and the real roles, fixtures created by `migration_owner` and every
assertion run as `app_api` or `app_system`:

| Scenario | Result |
|---|---|
| A sees only its own farms and fields | pass |
| B sees only its own | pass |
| No context: `SELECT` 0 rows, `INSERT`/`DELETE` `42501`, `UPDATE` 0 rows | pass |
| Context gone after commit, on the same pooled connection (`poolMax: 1`) | pass |
| Write and context gone after rollback | pass |
| Concurrent A and B do not cross | pass |
| Writing a row for another tenant → RLS violation, no row persisted | pass |
| Field referencing another tenant's farm → `23503`, no row persisted | pass |
| `app_system` refused `SELECT/INSERT/UPDATE/DELETE` on tenant tables (`42501`) | pass |
| `app_api` refused DDL and ledger writes (`42501`) | pass |

`pnpm db:verify` grew structural assertions over the same tables — `relrowsecurity`,
`relforcerowsecurity`, owner, policy `cmd`/`roles`/`qual`/`with_check`, no policy
granted to `PUBLIC`, the effective privilege matrix per table, the composite
ownership FK, and column privileges for `app_system`. A policy row existing is not
evidence that a query is isolated; that is what `test:rls` is for. Conversely a
behavioural test as `app_api` cannot notice a missing `FORCE` flag, because
`app_api` was never the bypassing role.

### Schema file

`schema.prisma` declares the three models with `schemas = ["app"]` and
`@@schema("app")`. Without it Prisma emits `public.farms` and reports a missing
table — the adapter does not read `?schema=` from the URL the way the query engine
did. Two columns are `Unsupported`: `geom` (PostGIS, unreadable by the client) and
`area_ha` (a generated column the database computes). Both are reached through raw
SQL. Omitting them would make the file lie about the schema; declaring them as
ordinary columns would let the client write values PostgreSQL rejects.

`area_ha` is `ST_Area(geom::geography) / 10000` as a stored generated column, so
there is one definition of area and it cannot drift from the geometry. A `POINT`
geometry therefore has `area_ha = 0` — it has no area, and the column says so
rather than guessing.

### Not in this phase

*(True of Phase 2.2.3 and superseded since: `docs/data-model/` was written in
Phase 2.3 and the 19 tables it specifies were created in Phase 3. Recorded rather
than rewritten, so this section stays a record of what 2.2.3 did and did not do.)*

`docs/data-model/` did not exist at the time, and `domain-model.md` §3–§6 name
derived entities (`suitability_runs`, `planting_windows`, `ai_briefings`,
`weather_records`) whose columns are discriminated unions and typed segments.
Creating them here would have meant inventing the physical schema the documents had
not specified. They remained Phase 3.



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
