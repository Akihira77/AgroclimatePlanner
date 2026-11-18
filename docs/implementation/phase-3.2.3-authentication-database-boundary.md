# Phase 3.2.3 — Authentication Database Boundary (S3–S6): Implementation Plan

Status: **PLAN ONLY — nothing in this document is applied.**
Prepared 2026-11-18 against `master` at `75607d8`.
Approvers needed: repository owner, for `ADR-004` and `ADR-005` (see §16).

**Document location.** This is the first file under `docs/implementation/`. The
existing directories each answer a different question — `adr/` records accepted
decisions, `architecture/` describes how the system is built, `data-model/` is the
normative schema, `review/` holds dated reviews and owner decisions, `design/` is a
Phase 0 UI analysis, `research/` is provider research. A per-phase execution plan
is none of those: it is dated, it is expected to be superseded by the code, and it
must not be mistaken for architecture. A new directory is the honest place for it;
`docs/implementation/` has no conflicting convention to break.

---

## 1. Executive summary

`OPEN-01` and `OPEN-13` were approved on 2026-11-18 (`AG-1` = Option A, `AG-2` =
Option A) and are still **unresolved**, because approval is not implementation. This
plan is the implementation half, and only the database half of it: a fourth role,
two additive migrations, and the verification that proves each boundary exists.

Four steps, in a fixed order:

| Step | Deliverable | Why it must come here |
|---|---|---|
| **S3** | `app_auth` role in bootstrap, its DSN in the process, a second Prisma client | a policy cannot name a role that does not exist (`42704`) |
| **S4** | migration `auth_boundary`: 2 policies + 2 column grants on `app.users` | registration and login are impossible until a credential can read `password_hash` before a tenant context exists |
| **S5** | migration `sessions`: table, grants, policies, GC function | session rows are written by the credential S3 creates |
| **S6** | `db:verify` rows, `auth-boundary` suite, conformance additions | a boundary nobody measured is a claim, not a control |

What this does **not** produce: a register endpoint, a login endpoint, a session
guard, `/me`, `/logout`, password hashing, rate limiting, or a GC job. Those are S7
and S8 and remain blocked on gates this plan does not answer (§13).

The honest one-line summary of the security model being built: **`app_auth` can read
every email and every password hash, and can mint a session for any `user_id`. That
is the price of the approved design, it is disclosed in the owner record, and no
grant in this plan can remove it.** Everything this plan adds is about making the
blast radius exactly that large and provably not one table wider.

---

## 2. Scope and non-goals

### In scope

- `packages/database/bootstrap/roles.sql` — fourth role, its attributes, schema
  normalisation, default privileges.
- `packages/database/scripts/bootstrap.mjs`,
  `scripts/lib/connections.mjs`, `database.defaults.json` — provisioning and
  connection resolution for `app_auth`.
- `.env.example` — two new variable **names** (never values).
- `packages/database/prisma/migrations/20261118040000_auth_boundary/` — new.
- `packages/database/prisma/migrations/20261118050000_sessions/` — new.
- `packages/database/prisma/schema.prisma` — a `Session` model for representation
  only; no `migrate dev`, ever.
- `packages/database/scripts/lib/privilege-verification.mjs`,
  `scripts/verify-probe-isolation.mjs` — new assertions.
- `packages/database/test/rls/auth-boundary.test.mjs` — new suite.
- `packages/database/test/schema/schema-conformance.test.mjs` — new rows.
- `apps/api/src/config/runtime-config.ts`, `src/database/database.module.ts`,
  `src/tokens.ts` — a validated second DSN and a second client.
- `docs/architecture/api-conventions.md`, `docs/data-model/*`,
  `docs/IMPLEMENTATION_STATUS.md` — recorded after the code, with evidence.

### Out of scope, and not to be folded in

Authentication endpoints; password hashing and its parameters (`IG-6`); rate
limiting (`IG-7`); cookie and CSRF mechanics (`IG-8`, `IG-9`); email normalisation
policy (`IG-1`); duplicate-registration semantics (`IG-2`); auto-login after
register (`IG-3`); password policy (`IG-4`); email verification (`IG-10`); Redis or
BullMQ; JWT; the `maintenance` job wiring (sessions GC is *callable* after S5, but
nothing schedules it until Phase 4); `OPEN-04` deletion policy; `OPEN-28` signed
tenant context; any change to `withTenant`; any change to the 22 existing tables.

Also out of scope by rule: changing the disposition of `OPEN-01` or `OPEN-13`. Those
flip only when an accepted ADR **and** an applied migration **and** a green
`db:verify` exist (`phase-3.2-design-review.md` §§16-17, "Marked `RESOLVED` only
when"), which is a separate,
later action.

---

## 3. Existing architecture findings (measured, not inferred)

### 3.1 Roles

`bootstrap/roles.sql:12` creates role names from an array; `:22-24` sets attributes
on every run; `bootstrap.mjs:53-60` turns login on by iterating `ROLE_NAMES`, which is
derived from `connections.mjs:26-30`. So "add a role" is three edits, not a new code
path — and `ROLE_NAMES` is also what the verification client set and the tenancy
suite iterate.

| Role | `BYPASSRLS` | `LOGIN` | Owns | Reach today |
|---|---|---|---|---|
| `migration_owner` | no | provisioned | schema `app` and every object in it | everything |
| `app_api` | no | provisioned | nothing | 9 tenant tables RW, 6 catalog + 6 weather tables R, `INSERT (provider, model, cell_key)` on `outlook_cells`; **nothing** on `users` |
| `app_system` | **yes** | provisioned | nothing | 6 weather tables RW; nothing on any tenant or identity table |
| `app_auth` | — | — | — | **does not exist** |

`NOINHERIT` is on every role and the verification asserts **zero** memberships in
either direction (`privilege-verification.mjs:182-194`). This is the property that
makes a fourth role a real boundary rather than a name: no role can acquire another's
grants through membership, and `SET ROLE` is refused (§8, S6 probes).

### 3.2 `app.users`

```sql
-- 20261118020000_tenant_tables/migration.sql:14-28 (abridged)
CREATE TABLE app.users (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  email text NOT NULL,
  password_hash text NOT NULL,
  locale text NOT NULL DEFAULT 'id',
  timezone text NOT NULL DEFAULT 'Asia/Jakarta',
  role text NOT NULL DEFAULT 'owner',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_key UNIQUE (email),
  CONSTRAINT users_email_shape_check CHECK (position('@' IN email) > 1 AND email !~ '\s'),
  CONSTRAINT users_role_check CHECK (role IN ('owner', 'admin'))
);
```

- RLS: `ENABLE` + `FORCE` (`:107-108`), policy `users_self_only FOR ALL TO app_api
  USING/WITH CHECK (id = NULLIF(current_setting('app.user_id', true), '')::uuid)`
  (`:109-112`), plus `users_owner_full_access FOR ALL TO migration_owner USING (true)`
  (`:134-135`).
- Grants: **none to any runtime role** (`:157-158` grants `farms`/`fields` only).
- `users_email_key UNIQUE (email)` is case-sensitive; normalisation is an application
  invariant and belongs to `IG-1` (owner record R-6).

The three facts that make this a hard problem, restated because every step below
depends on them: `app_api` holds no privilege; `FORCE RLS` means even a grant would
return zero rows without `app.user_id`; and `app.user_id` is only ever written by
`withTenant`, which requires the user id as an argument (`tenant.ts:61-81`). Login
must therefore run on a credential that never opens a tenant transaction.

### 3.3 What exists for sessions

Nothing. No table, no model, no grant, no job. `entity-catalog.md:89` lists
`sessions` as unspecified and blocked by `OPEN-13`; `ADR-002` D5 already decided
server-side sessions in PostgreSQL and rejected JWT with refresh rotation; Redis is
documented and **not provisioned** (one compose service, zero `ioredis`/`bullmq`
resolvable from the workspace). The `maintenance` queue that would schedule the GC
job exists only in `background-processing.md:20`, Phase 5 work.

### 3.4 The API process today

- One DSN: `APP_API_DATABASE_URL` (or `APP_API_PASSWORD` in development), parsed once
  at boot by `runtime-config.ts:96-120`, and **asserted** to be `app_api`
  (`:147-166`). `app_auth` is already listed in `NON_RUNTIME_ROLES` (`:48-53`), so it
  is explicitly refused as the tenant credential today. That is the right refusal and
  it must stay.
- One client: `DatabaseModule.register` creates exactly one `PrismaClient` from
  `config.databaseUrl` under the `DATABASE_CLIENT` token, closed by
  `DatabaseLifecycle.onModuleDestroy` (`database.module.ts:14-54`).
- Consequence: S3 is **not** just "add a DSN". A second config field, a second token,
  a second lifecycle owner, and a role assertion for `app_auth` with the allowed and
  forbidden sets swapped are all required, and neither client may be reachable
  through the other's token.

### 3.5 Migration and verification conventions

- Hand-written SQL, applied with `prisma migrate deploy` (`db:migrate`). `migrate dev`
  is banned in this repository (shadow-database diff against PostGIS is permanent
  drift) and must not return.
- Applied migrations are immutable. A mistake is fixed by a **new** migration.
- `db:verify` is a library plus a runner: `scripts/lib/privilege-verification.mjs`
  (rights, attributes, memberships, RLS flags, policies, per-table `EXPECTED`, column
  probes) and `scripts/verify-privileges.mjs` (exit code). It is documented at 355
  assertions; every denial is accepted only at SQLSTATE `42501`, so a missing relation
  cannot pass as a boundary. That is a documented count, not re-measured for this plan.
- `test/rls/tenant-isolation.test.mjs` runs 39 tests as the real roles through `withTenant`
  (documented count); `test/schema/schema-conformance.test.mjs` runs 12 structural checks.
- Fixtures are created by `migration_owner` and cleaned up by id; probe names carry a
  per-run random suffix (`createProbes`, `privilege-verification.mjs:77-88`).
- `has_table_privilege` reports **false** for column grants. Column grants must be
  probed with `has_column_privilege`, and behaviourally. This is the single most
  common way this step could be verified wrongly.

### 3.6 Known documentation gaps touched by this phase

- `docs/architecture/auth-deferred.md` is cited by the immutable Phase 2.2.3
  migration comment and **does not exist** (`consistency-checklist.md` §6.1, review
  F11). The analysis lives in `ownership-and-rls.md` §5. This is an S9 item and a
  **non-blocker** for S3–S6.
- `entity-catalog.md` has no `sessions` row in any class. The owner record accepts
  widening `identity` to "the account and its authentication state" rather than adding
  a sixth class; that edit is S9.

---

## 4. Owner decisions and constraints

Both architecture gates were approved on 2026-11-18 and this plan is bound by them
verbatim. Nothing below re-opens, re-interprets, or improves on them.

### `AG-1` — dedicated `app_auth` (Option A)

| Element | Approved |
|---|---|
| Role | `app_auth`; SQL bootstrap state `NOLOGIN`; provisioned `LOGIN`; `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`; zero memberships either direction |
| Schema | `USAGE` on `app` |
| `app.users` | `SELECT (id, email, password_hash, role, locale, timezone)`; `INSERT (email, password_hash)`; no `UPDATE`, no `DELETE`, no row-wide privilege |
| Policies | `users_auth_lookup FOR SELECT TO app_auth USING (true)`; `users_auth_register FOR INSERT TO app_auth WITH CHECK (true)`. `users_self_only` unchanged; `app_api` named in neither; `FORCE` retained |
| Everything else | nothing — no tenant table, no catalog, no weather plane, no function, no DDL, no `SET ROLE` |
| Credential | its own DSN, connecting **directly** as `app_auth`; no second login role, no membership, no `SET ROLE` |

**The boundary is a credential boundary, not a process boundary.** Both clients live
in one process (owner record §1.5, §1.7 R-7). An attacker who owns the process holds
both credentials. This plan must never be described, in code comments or documents,
as isolation between authentication and business operations — only as a statement
about what each credential reaches.

### `AG-2` — PostgreSQL sessions (Option A)

| Element | Approved |
|---|---|
| Store | `app.sessions`, accessed only by `app_auth` |
| Token | 32 CSPRNG bytes, base64url (43 chars), opaque; only `sha256(token)` stored; unique |
| Expiry | sliding 30 days, absolute 90 days; sliding extended at most once per 5 minutes; extension clamped with `LEAST(now() + 30 d, absolute_expires_at)` |
| Revocation | `revoked_at`; checked before any other validity |
| GC | `app.purge_expired_sessions()`, `SECURITY DEFINER`, owned by `migration_owner`, `EXECUTE` to `app_system` alone, hourly in `maintenance` |
| RLS | `ENABLE` + `FORCE`; `sessions_auth_all FOR ALL TO app_auth USING (true) WITH CHECK (true)`; owner policy |
| Grants | column `SELECT`/`INSERT`/`UPDATE` per design review §4.3; **no `DELETE`** to any runtime role; `app_api` and `app_system` hold no table privilege |

Explicitly rejected and not to be revisited by an implementer: Redis, JWT, a
`SECURITY DEFINER` credential read for `app_api` (option B1), and a second tenant
GUC (option C).

---

## 5. S3 — `app_auth` bootstrap and connection configuration

### 5.1 Bootstrap SQL (`bootstrap/roles.sql`)

Five edits, each mirroring an existing line rather than inventing a shape:

| Line (current) | Change |
|---|---|
| `:12` | array becomes `ARRAY['migration_owner', 'app_api', 'app_system', 'app_auth']` |
| after `:24` | `ALTER ROLE app_auth NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;` — `NOBYPASSRLS` is asserted, not assumed |
| `:40-41` | `REVOKE ALL ON SCHEMA app FROM app_api, app_system, app_auth;` and `GRANT USAGE ON SCHEMA app TO app_api, app_system, app_auth;` — the normalisation must include the new role or the file stops converging |
| `:63-64` | add `app_auth` to `REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, app_api, app_system` so a function created later is not executable by it by default |
| `:48-50` | **no change.** `app_auth` references no PostGIS type, so `public` `USAGE` is not granted. If a future auth query needs one, that is a deliberate edit with a reason, not a convenience |

Deliberately not changed: `CREATE SCHEMA app AUTHORIZATION migration_owner` (the new
role owns nothing), the `_prisma_migrations` relocation, and every existing grant.

Idempotency is preserved by construction: the file is already written as
normalisation rather than initial grants, and the existing verification proves it by
planting a stray `GRANT CREATE` and re-running the bootstrap
(`privilege-verification.mjs:250-271`). That check keeps working with four roles.

### 5.2 Provisioning (`bootstrap.mjs`)

- `ROLE_PASSWORD_VARIABLES` (`:30-34`) gains `app_auth: "APP_AUTH_PASSWORD"`.
- Nothing else changes: the loop at `:53-60` iterates `ROLE_NAMES` and applies
  `ALTER ROLE … LOGIN PASSWORD %L` through `format()`, executed and never logged.
- Outside development a missing password is an error, not a placeholder
  (`passwordFor`, `:36-44`). Keep that behaviour for the fourth role; do not add a
  fallback.

### 5.3 Connection resolution (`scripts/lib/connections.mjs`)

- `ROLE_CONNECTIONS` (`:26-30`) gains
  `app_auth: { url: "APP_AUTH_DATABASE_URL", password: "APP_AUTH_PASSWORD" }`.
- `ROLE_NAMES` is derived (`:32`), so the verification client set
  (`privilege-verification.mjs:141-147`) and every `Promise.all(ROLE_NAMES…)` grow
  automatically. Two existing assertions change meaning and must be read again:
  `no role memberships involving the three roles` (`:190-194`) becomes four roles, and
  the `can log in` loop (`:170-177`) now includes `app_auth`. Both are correct
  extensions, not regressions.
- `database.defaults.json` gains `roles.app_auth` so development derives a URL
  without an environment file. This is a development placeholder in a committed file,
  exactly like the other three.
- `.env.example` gains the two **names** with empty values. No value from any real
  environment file is read, printed, or copied by this work.

### 5.4 API configuration (`apps/api/src/config/runtime-config.ts`)

New field `authDatabaseUrl`, parsed with its own rules — the inverse of the existing
assertion, not a relaxation of it:

| Rule | Why |
|---|---|
| `APP_AUTH_DATABASE_URL` wins outright | same precedence as every other connection |
| URL must parse and use `postgresql:`/`postgres:` | reuse `parsePostgresUrl` |
| Username must decode to **`app_auth`** | the boundary is the role |
| `app_api`, `app_system`, `migration_owner`, `postgres` are refused **by name** | a swapped DSN would silently collapse two credentials into one, which is the exact failure this phase exists to prevent |
| In production, absent ⇒ `ConfigurationError` at boot | fail fast, and symmetrically with `APP_API_DATABASE_URL`; a process that will need the credential must not start without it |
| In development, derive from `APP_AUTH_PASSWORD` + the same host/port/db defaults, as `parseDatabaseUrl` already does | one rule per environment, no guessing in production |
| Exception messages name the variable and the role, never the value | `ConfigurationError` already never echoes a value; keep it that way |

`assertRuntimeRole` must **not** be generalised into one permissive helper that
accepts any of the four roles. Two call sites with opposite expectations are clearer
and safer than one with a parameter, and the existing function's error strings are
part of the operator experience already recorded in
`phase-3.2-owner-record` §1.4. Duplicating ten lines is the cheaper mistake.

**Test-fixture consequence, stated up front:** `apps/api/test/config.test.mjs`
constructs environment records and will fail until fixtures include the new field.
That edit is required by S3 and must be authorised explicitly in the implementation
task; it is not a change to what the tests assert about the tenant credential.

### 5.5 Second client (`apps/api/src/database/database.module.ts`, `tokens.ts`)

- `tokens.ts` gains `AUTH_DATABASE_CLIENT`.
- `DatabaseModule` gains a second provider built from `config.authDatabaseUrl` using
  the **same** `DatabaseClientFactory` type, plus `AuthDatabaseLifecycle` closing it
  in `onModuleDestroy`.
- Both clients are process singletons; neither token is exported to the other's
  consumers, so a module that asks for the tenant client cannot accidentally receive
  the auth client.
- `/health/ready` keeps probing the **tenant** client only. Adding an auth probe
  would change the meaning of a 503 that has already been documented
  (`api-conventions.md` §12); auth readiness is an S7 concern, together with the
  fail-closed outage policy.
- Failure handling when the credential is absent: the process does not start
  (production) or derives the development URL (development). There is **no**
  fallback to `app_api` and no lazy "create it when needed" path: a client created on
  first use turns a configuration error into a 500 at the least convenient moment.

### 5.6 Least-privilege check for S3 in isolation

S3 grants nothing on any table, so after S3 alone the role must be able to do
exactly one thing: connect, resolve `app`, and see no relation. The S3 acceptance
probes are therefore: `current_user = 'app_auth'`; `USAGE` on `app` true; `CREATE` on
`app` false; `SELECT` on `app.users`, `app.farms`, `app.sessions` (absent) all
`42501`; `SET ROLE app_api` `42501`. This is what makes S4 a reviewable delta rather
than "the role appeared and things started working".

---

## 6. S4 — migration `auth_boundary`

### 6.1 Shape

`packages/database/prisma/migrations/20261118040000_auth_boundary/migration.sql`,
additive, 4 statements plus comments. No `ALTER TABLE`, no column change, no rewrite,
no data.

```sql
-- PROPOSED — NOT APPLIED
GRANT SELECT (id, email, password_hash, role, locale, timezone) ON app.users TO app_auth;
GRANT INSERT (email, password_hash)                                ON app.users TO app_auth;

CREATE POLICY users_auth_lookup ON app.users
  FOR SELECT TO app_auth USING (true);
CREATE POLICY users_auth_register ON app.users
  FOR INSERT TO app_auth WITH CHECK (true);
```

`FOR SELECT`/`FOR INSERT` and not `FOR ALL`: one policy per capability is what makes
the grant dump readable, and `FOR ALL` would document a capability the grants do not
have and would silently cover a future `UPDATE` grant. `WITH CHECK (true)` on insert
adds nothing to the predicate — the *grant* is the boundary — but it makes the intent
explicit and keeps the policy pair symmetric with the owner record.

### 6.2 Column decisions, each with a reason

| Column | `SELECT` | `INSERT` | Reason |
|---|---|---|---|
| `id` | yes | no (DB default) | login returns the subject; registration needs the generated id back via `RETURNING` |
| `email` | yes | yes | the lookup key, and the only identity field registration sets |
| `password_hash` | yes | yes | verify on login; write on register. **This is the whole point of the phase** |
| `role` | yes | no | authorisation input on the request path; not settable by the caller (DB default `'owner'`) |
| `locale`, `timezone` | yes | no | `/me` and response localisation; defaults are DB-owned |
| `created_at`, `updated_at` | **no** | **no** | nothing on the auth path needs them; adding a column later must be a deliberate grant rewrite, and `updated_at` has no trigger (`OPEN-19`) |
| any future column | no | no | default-deny is the baseline rule 1 in `ownership-and-rls.md` §2 |

Email lookup is supported **safely in the sense that matters and not in the sense
that does not**: `USING (true)` plus `SELECT (email)` supports `WHERE email = $1`
with no GUC, and is equally a full-table email dump. The lookup *is* the enumeration;
that is owner record R-1, accepted and disclosed. `IG-1` may later add a
`lower(email)` unique index; that is a different question and this migration must not
pre-empt it.

### 6.3 Interaction with `FORCE ROW LEVEL SECURITY`

`FORCE` is retained untouched. It matters in three distinct ways here:

1. `migration_owner` is the table owner and is still subject to policies; its
   existing `users_owner_full_access` policy is what keeps fixtures and data
   migrations working. Do not remove it.
2. A future mistaken `GRANT SELECT ON app.users TO app_api` returns **zero rows**
   rather than data, because `users_self_only` requires `app.user_id`. This is the
   defence-in-depth argument in `ownership-and-rls.md` §3, unchanged.
3. `app_auth` queries work **without** setting `app.user_id`, because its policies are
   `USING (true)`. That is deliberate and is the reason the auth path never touches
   `withTenant`.

### 6.4 What must not appear in this migration

- Any grant to `app_api`, `app_system`, or `PUBLIC`.
- A table-level grant to `app_auth` (`GRANT SELECT ON app.users` would make every
  future column readable and defeat the column list).
- `ALTER TABLE`, `OWNER TO`, `SECURITY DEFINER`, `SET ROLE`, `BYPASSRLS`.
- A `sessions` reference: `S5` owns that, and S4 must stay valid on its own.
- A grant on any other table. Enumerated, not sampled: this migration names
  `app.users` four times and nothing else.

### 6.5 Application consequences to verify, not assume

- Prisma's generated `INSERT` for `User` may name columns outside the grant
  (`locale`, `timezone`, `role`, timestamps). If it does, registration **must** use a
  raw `INSERT INTO app.users (email, password_hash) … RETURNING id` rather than
  widening the grant. The implementation task must inspect the generated SQL
  (`EXPLAIN`/log at statement level, or a behavioral probe) before writing the
  registration path — the grant is authoritative, the ORM is not.
- `RETURNING id, email` is permitted because both columns are in the `SELECT` grant.
  `RETURNING created_at` would fail with `42501`, which is intended.

---

## 7. S5 — migration `sessions`

### 7.1 Table

`packages/database/prisma/migrations/20261118050000_sessions/migration.sql`.

```sql
-- PROPOSED — NOT APPLIED
CREATE TABLE app.sessions (
  id                  uuid        PRIMARY KEY DEFAULT uuidv7(),
  user_id             uuid        NOT NULL REFERENCES app.users (id),
  token_hash          text        NOT NULL,
  expires_at          timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at          timestamptz,
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sessions_token_hash_key UNIQUE (token_hash),
  CONSTRAINT sessions_expiry_order_check
    CHECK (absolute_expires_at >= expires_at AND expires_at > created_at),
  -- Addition to the review's DDL, flagged for review: see §7.3
  CONSTRAINT sessions_token_hash_shape_check CHECK (token_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX sessions_user_id_idx ON app.sessions (user_id);
CREATE INDEX sessions_absolute_expires_at_idx ON app.sessions (absolute_expires_at);
```

Ownership: created by the migration connection, so the table and both indexes are
owned by `migration_owner` along with every other object in `app`.

### 7.2 Why user-scoped, not tenant-scoped

A session row belongs to a user, but it is read **before** identity is established —
that is its purpose. A tenant-shaped policy (`user_id = current_setting('app.user_id')`)
would be unusable at the moment it matters and would tempt an implementer to set the
GUC from an unauthenticated request body, which is precisely the forgery `ADR-003`
measured as unenforceable.

So `sessions_auth_all … USING (true)` is chosen, with the consequences stated:

- **`app_auth` can read every session row.** Accepted (`AG-2` S-4). Cross-user
  isolation is therefore enforced by the *query shape* (`WHERE token_hash = $1`) and
  by the token being unguessable, **not** by RLS. This must be said in the code
  comment where the query lives, because a future reader will otherwise assume the
  policy did it.
- The tenant credential is isolated the only way that survives a forgotten filter:
  it holds **no grant at all**, and `FORCE` means a mistaken grant returns zero rows.
- `ENABLE` + `FORCE` remain correct for the same reason as on `users`.

### 7.3 The one addition to the approved DDL, and why

`sessions_token_hash_shape_check` is not in the design review's proposed DDL. It is
proposed here because `AG-2` says "only `sha256(token)` stored" and nothing in the
schema currently distinguishes a hash from a raw token: a bug that wrote the
base64url token into `token_hash` would be silently accepted and would still
authenticate.

- 64 lowercase hex characters is exactly `encode(sha256(32 bytes), 'hex')`. A
  base64url token is 43 characters, so the mistake fails at `23514` instead of
  persisting a credential.
- It constrains the *encoding*, not the algorithm. If a future decision stores
  base64 hashes, this needs a migration — which is the intended cost.
- It does not make the raw-token rule enforceable in general (an application could
  hash twice and still pass); it catches the one realistic error.

Flagged explicitly: **this is a schema addition beyond the approved design and must be
accepted or removed at review.** It is not a security control the plan may award
itself.

### 7.4 Grants, policies, and the GC function

```sql
-- PROPOSED — NOT APPLIED
ALTER TABLE app.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.sessions FORCE  ROW LEVEL SECURITY;

CREATE POLICY sessions_auth_all ON app.sessions
  FOR ALL TO app_auth USING (true) WITH CHECK (true);
CREATE POLICY sessions_owner_full_access ON app.sessions
  FOR ALL TO migration_owner USING (true) WITH CHECK (true);

GRANT SELECT (id, user_id, token_hash, expires_at, absolute_expires_at,
              revoked_at, last_seen_at, created_at) ON app.sessions TO app_auth;
GRANT INSERT (user_id, token_hash, expires_at, absolute_expires_at) ON app.sessions TO app_auth;
GRANT UPDATE (expires_at, last_seen_at, revoked_at) ON app.sessions TO app_auth;
-- no DELETE to any runtime role; no grant of any kind to app_api or app_system

CREATE FUNCTION app.purge_expired_sessions() RETURNS integer
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = pg_catalog, app
AS $$
  WITH deleted AS (
    DELETE FROM app.sessions
     WHERE absolute_expires_at < now()
    RETURNING 1
  )
  SELECT count(*)::integer FROM deleted
$$;

REVOKE ALL ON FUNCTION app.purge_expired_sessions() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.purge_expired_sessions() TO app_system;
```

Three load-bearing details, each easy to lose:

1. **`sessions_owner_full_access` is not decoration.** `SECURITY DEFINER` runs as
   `migration_owner`, `FORCE` applies to the owner, and `DELETE` needs a policy. Remove
   the owner policy and the GC function fails with `42501` — the sweep would stop
   working the day someone "cleaned up" an unused-looking policy.
2. **The `WITH deleted … count(*)` shape** is what makes the return value a count.
   A plain `DELETE … RETURNING 1` returns N rows, and a scalar SQL function permits at
   most one — it errors as soon as two sessions expire in the same hour, which is the
   normal case.
3. `SET search_path = pg_catalog, app` pins resolution for a definer function. `app`
   is second on purpose: `pg_catalog` is always searched first by PostgreSQL anyway,
   but the explicit list is what makes the function immune to a caller's `search_path`.

`SECURITY DEFINER` here is the only such object in the repository. Its surface is
"delete rows nobody can use any more" and it touches no credential and no tenant row.
`ADR-003`'s rejection of a definer-based tenant validator does not transfer to it.

### 7.5 Prisma representation

Add a `Session` model to `schema.prisma` with `@@map("sessions")` and `@@schema("app")`,
all eight scalar columns mapped, `token_hash` `@unique`, and **no relation field
requirement beyond `user User @relation(...)`**. This file is a representation;
`prisma/migrations` remains authoritative, `migrate dev` must not be used, and the
model exists so the client has a type — not so it can generate DDL. If the generated
model cannot express the CHECK constraints, say so in a comment rather than
pretending the schema file is complete.

### 7.6 Schema/Prisma write-path consequence

Session creation with Prisma names every non-defaulted column, which is exactly the
`INSERT` grant, so `create` is viable. Any read that selects `*` would need the full
`SELECT` list — which `app_auth` has — so the column grant is about *writes* and about
future columns, not about hiding present ones from `app_auth`. Say this plainly:
**the session table's column grants do not hide session rows from the auth
credential; they constrain which columns it can change.**

---

## 8. S6 — privilege verification and security tests

Three layers, each answering a different question. None of them is a text search over
SQL; every assertion talks to PostgreSQL as the role it is about.

### 8.1 `db:verify` (structural + behavioural, existing harness)

Additions to `privilege-verification.mjs`:

| Group | Assertions |
|---|---|
| Identity | `connected as app_auth`; `rolcanlogin = true`; no superuser/createdb/createrole/replication |
| Attributes | `app_auth` `NOBYPASSRLS`; `NOINHERIT` |
| Membership | the existing zero-membership query now covers four roles, in both directions |
| Schema | `app_auth` has `USAGE` on `app`, no `CREATE` on `app`, no `CREATE` on `public` |
| `EXPECTED` | `app_auth` added to every row's expectation as `NONE` — table-level only, because `has_table_privilege` reports false for column grants |
| Column grants | `has_column_privilege(app_auth, users, c, 'SELECT')` true for the six, false for `created_at`/`updated_at`; `INSERT` true for `email`/`password_hash`, false for the rest; `UPDATE` and `DELETE` false for every column |
| Sessions | table `42501` for `app_api` and `app_system` on all four verbs; `app_auth` column privileges exactly as §7.4; no `DELETE` for `app_auth` |
| RLS | `sessions` `relrowsecurity` and `relforcerowsecurity` true; both policies present; neither names `{public}` or `app_api`; `SELECT`/`INSERT` split correct |
| Function | `prosecdef` true; owner `migration_owner`; `proacl` grants `EXECUTE` to `app_system` only; `has_function_privilege` false for `app_api`, `app_auth` |
| Cross-role | `app_auth` cannot `SET ROLE app_api`/`app_system`/`migration_owner`; `app_api`/`app_system` unchanged |
| Regression | the existing `app_api holds no grant on app.users` denial stays and is asserted for the new role's neighbours too |

Every denial is accepted only at `42501`; `23503` is asserted separately where a
foreign key is the mechanism.

### 8.2 New suite `test/rls/auth-boundary.test.mjs` (`node:test`, real roles)

Fixtures: one user per run, created by `migration_owner`, email carrying
`randomBytes(6).toString("hex")` so two runs never collide; sessions created by
`app_auth` itself. `after()` deletes sessions by `user_id`, then the user, then the
connection — never a fixed id, never `DROP ROLE`, never a `TRUNCATE`.

| Probe (as `app_auth`) | Expected |
|---|---|
| `select id, email, password_hash, role, locale, timezone from app.users where email = $1` | 1 row, **with no `app.user_id` set** |
| `select created_at from app.users` | `42501` |
| `insert into app.users (email, password_hash) values ($1,$2) returning id` | succeeds |
| `insert into app.users (email, password_hash, role) …` | `42501` |
| `update app.users set locale = …` / `delete from app.users` | `42501` / `42501` |
| `select count(*) from app.users` | succeeds — the enumeration exposure, asserted so it cannot be discovered later as a surprise |
| `set role app_api` / `app_system` / `migration_owner` | `42501` |
| `set_config('app.user_id', <other tenant>, true); select … from app.farms` | `42501` — the "permitted but useless" claim, tested rather than asserted |
| `create table app.probe_…` | `42501` |
| any of the 21 other tables, `select` | `42501`, enumerated over the table list, not sampled |
| `insert into app.sessions (user_id, token_hash, expires_at, absolute_expires_at)` | succeeds |
| `select … from app.sessions where token_hash = $1` | 1 row |
| `update app.sessions set revoked_at = now()` | succeeds |
| `update app.sessions set token_hash = …` / `user_id = …` / `created_at = …` | `42501` |
| `delete from app.sessions` | `42501` |
| `select app.purge_expired_sessions()` | `42501` |

And as the other roles: `app_api`/`app_system` `42501` on every `sessions` verb;
`app_system` `EXECUTE app.purge_expired_sessions()` succeeds and returns an integer;
`app_api` `42501` on the function.

### 8.3 `test/schema/schema-conformance.test.mjs`

Structural rows, no behaviour: `sessions` exists with the eight columns, both CHECK
constraints, the unique constraint, the two indexes, `ENABLE`+`FORCE`, two policies
(`sessions_auth_all TO app_auth FOR ALL`, `sessions_owner_full_access TO
migration_owner`), and the exact grant lists via `has_column_privilege`. The existing
12 conformance checks and 39 isolation tests must pass **unchanged** — a changed
count is a finding, not a housekeeping edit.

### 8.4 Fresh-volume migration check

Both migrations are applied to an isolated compose project with its own volume
(the Phase 3 pattern), never by resetting the development database, and the project
is removed afterwards. This is the only way to know S3-before-S4 ordering holds from
zero rather than from an already-provisioned cluster.

---

## 9. Database object and privilege matrix (target state)

`own` = `migration_owner` · `api` = `app_api` · `sys` = `app_system` · `auth` =
`app_auth`. `RW` = `SELECT, INSERT, UPDATE, DELETE`.

| Object | Owner | `api` | `sys` | `auth` | Mechanism |
|---|---|---|---|---|---|
| schema `app` | `own` | USAGE | USAGE | **USAGE** | grant; `CREATE` denied to all three |
| `app.users` | `own` | **none** | none | `SELECT (id, email, password_hash, role, locale, timezone)`, `INSERT (email, password_hash)` | column grants + `users_auth_lookup` / `users_auth_register`; `users_self_only` unchanged |
| `app.sessions` | `own` | **none** | **none** | `SELECT (8 cols)`, `INSERT (4 cols)`, `UPDATE (expires_at, last_seen_at, revoked_at)`; **no DELETE** | column grants + `sessions_auth_all`; `FORCE` retained |
| `app.purge_expired_sessions()` | `own` | none | **EXECUTE** | none | `SECURITY DEFINER`, `search_path` pinned, `REVOKE … FROM PUBLIC` |
| 9 tenant tables | `own` | `RW` | none | **none** | unchanged (`rls` policy `TO app_api`) |
| 6 catalog tables | `own` | `R` | none | **none** | unchanged |
| 6 weather tables | `own` | `R` (+`INSERT (provider, model, cell_key)` on `outlook_cells`) | `RW` | **none** | unchanged |
| `app._prisma_migrations` | `own` | none | none | **none** | unchanged |
| sequences | — | — | — | — | none exist; `uuidv7()` is not a sequence |

Rules that this matrix must not break: no `GRANT ALL`, no `GRANT … ON ALL TABLES IN
SCHEMA`, no `ALTER DEFAULT PRIVILEGES` that grants anything to a runtime role, no
grant to `PUBLIC`, and each new object opts in explicitly.

---

## 10. Security threat analysis

The distinction the plan insists on: **PostgreSQL enforces object and column
privileges and row filters; the application enforces which predicate it runs; the
deployment enforces who holds which secret.** A control is listed under exactly one
of those, and "RLS protects it" is never claimed where a role can set its own context.

| Threat | Enforced by | What actually happens | Residual |
|---|---|---|---|
| Compromised API process | nothing at this layer | holds `app_auth` and `app_api` together: read all credentials, mint any session, read any tenant the RLS GUC names | R-7, accepted and disclosed. Must never be described as process isolation |
| Leaked `app_auth` DSN | PostgreSQL | bulk email + hash dump; account creation outside the flow; session minting/revocation for any `user_id`; no tenant, catalog, weather, DDL, or `SET ROLE` | R-1…R-4, accepted |
| Leaked `app_api` DSN | PostgreSQL | every tenant row the credential's own `app.user_id` names, for tenants it chooses; **no** credential reads | `OPEN-28`, unresolved and untouched here |
| SQL injection under `app_auth` | PostgreSQL | bounded by the same grants: `users` columns and `sessions` columns, no `DELETE`, no DDL, no `SET ROLE` | injection could still enumerate or forge sessions; grants bound the shape, not the intent |
| Cross-user session access | application | `WHERE token_hash = $1`; the table policy is `USING (true)`, so RLS does **not** isolate users from the auth credential | accepted (`AG-2` S-4); must be stated in the query's comment |
| Session token theft | deployment + application | opaque bearer token; only its hash stored; TLS termination and cookie attributes are `IG-8`/`IG-9`, unset | not addressed by S3–S6 |
| Session fixation | application | a token is only ever minted server-side by `crypto.randomBytes`; there is no path that accepts a caller-supplied token | S8 must not add one |
| Replay of revoked/expired session | application | every validation must check `revoked_at IS NULL AND expires_at > now() AND absolute_expires_at > now()`; the database provides the columns, not the predicate | the predicate is code; the suite must test each of the three conditions separately |
| Raw token logged or stored | application + one DB CHECK | `sessions_token_hash_shape_check` rejects a stored non-hash; log hygiene is existing practice (`c762171`) and must extend to the auth path | double-hashing would pass the CHECK |
| Privilege escalation via membership | PostgreSQL | `NOINHERIT`, zero memberships, asserted in both directions; no role may `SET ROLE` another | none at this layer |
| `SECURITY DEFINER` misuse | PostgreSQL + review | one function, owner `migration_owner`, `search_path` pinned, `EXECUTE` to `app_system` only, returns a count. It cannot be repurposed to read anything | a future definer function is a fresh review, not covered by this one |
| RLS bypass | PostgreSQL | `app_auth` is `NOBYPASSRLS`; `FORCE` keeps the owner policed; the policies for the auth role are deliberately `USING (true)` so nothing is silently filtered | `app_system` keeps `BYPASSRLS`, which is irrelevant here because it holds no table grant |
| Enumeration through login | application | identical status/code/body and a dummy hash for unknown emails (`IG-2`, S7) | not implemented by this plan |
| Un-revocation | PostgreSQL cannot | `UPDATE (revoked_at)` has no direction; `app_auth` can clear a revocation it set | accepted, owner record R-4/S-5, disclosed |

**Two claims this plan explicitly refuses to make:** that RLS protects the session
table against the auth credential, and that the fourth role protects anything if the
process is compromised. Both would be false, and item 15 of the review's Definition
of Done exists to catch exactly that kind of sentence.

---

## 11. Migration sequence and rollback considerations

### Sequence

| # | Action | Prerequisite | Reversible? |
|---|---|---|---|
| 1 | `pnpm --filter @agroclimate/database db:bootstrap` with `APP_AUTH_PASSWORD` | cluster-admin credential (`BOOTSTRAP_DATABASE_URL`, or development) | re-running is a no-op; roles are not dropped |
| 2 | `db:verify` — four roles recognised, `app_auth` connects, still no table privilege | 1 | — |
| 3 | `prisma migrate deploy` → `20261118040000_auth_boundary` | 1 (policy names `app_auth`, otherwise `42704`) | new migration revoking; never an edit |
| 4 | `db:verify` + new `auth-boundary` suite (users half) | 3 | — |
| 5 | `prisma migrate deploy` → `20261118050000_sessions` | 3 | new migration dropping; session rows are disposable |
| 6 | `db:verify` + `auth-boundary` suite (sessions half) + conformance additions | 5 | — |
| 7 | Fresh isolated volume: bootstrap → deploy both → verify | 1–6 on the dev cluster | project removed afterwards |
| 8 | Docs: `ownership-and-rls.md` matrix rows, `entity-catalog.md` (`identity` widened), `IMPLEMENTATION_STATUS.md` with command evidence | 1–7 | — |

### Rollback

- **No down migrations, no `migrate resolve`, no reset.** This repository is
  forward-only by convention and by the ban on `migrate dev`.
- To undo a grant: a new migration with `REVOKE` / `DROP POLICY`. To undo `sessions`:
  a new migration with `DROP FUNCTION`, `DROP TABLE`. Losing session rows costs one
  round of re-login, which is the only data this phase stores.
- Do **not** drop the role to "roll back". Roles are cluster-level, are referenced by
  policies, and a dropped role leaves policies that fail to resolve; the correct
  containment is `ALTER ROLE app_auth NOLOGIN` plus the revoke migration.
- If S4 has been applied and S5 has not, that is a valid, shippable intermediate
  state: registration can read/write credentials, nothing can mint a session. Say so
  in the status document rather than describing a half-applied pair.

---

## 12. Test and verification strategy

| Layer | Command | What it proves | New work |
|---|---|---|---|
| Structural + behavioural privileges | `pnpm --filter @agroclimate/database db:verify` | attributes, memberships, column grants, RLS flags, policy coverage, `42501` denials as the real roles | `app_auth` rows in `EXPECTED`, column probes, sessions/function probes |
| Probe hygiene | `pnpm --filter @agroclimate/database db:verify:probes` | the verification run cleans up its own objects and does not touch a planted decoy | extend only if the new probes touch shared names — they should not |
| Auth boundary behaviour | `pnpm --filter @agroclimate/database test:rls` (new file) | §8.2 table, each row a real connection | `test/rls/auth-boundary.test.mjs` |
| Schema conformance | `pnpm --filter @agroclimate/database test:schema` | columns, constraints, indexes, policies, grant lists | new rows; existing 12 unchanged |
| Tenant isolation (regression) | `test/rls/tenant-isolation.test.mjs` | 39 tests, unchanged count | none |
| Migration state | `pnpm --filter @agroclimate/database db:status` | applied vs pending | none |
| Fresh volume | isolated compose project | ordering from zero | new runbook step |
| Workspace regression | `pnpm build`, `typecheck`, `lint`, `test`, `prettier --check .`, `git diff --check` | nothing else broke | config fixtures in `apps/api` (§5.4) |

Rules for the new tests, so they are not written in a way that passes for the wrong
reason:

- A denial is only a denial at `42501`. `42P01` (missing relation) and `3F000` (bad
  schema) must fail the assertion.
- Column privileges are probed with `has_column_privilege` **and** behaviourally; the
  table-level helper lies about them.
- Fixtures are unique per run and removed by id in `after()`; a failed setup must not
  leave a user row behind, and a cleanup failure must not mask a test failure.
- No test reads `.env`, prints a DSN, or asserts on a literal credential.
- Tests may be added only when the implementation task is explicitly authorised to
  modify test files (repository rule); this plan records what they must contain, not
  permission to write them.

---

## 13. Dependencies and unresolved owner decisions

### Unblocked by what already exists

| Requirement | Status |
|---|---|
| `AG-1` (credential boundary) | **approved 2026-11-18** |
| `AG-2` (session storage) | **approved 2026-11-18** |
| `IG-5` (+`IG-5-A1`), `IG-11`, `IG-12` | approved / recorded; S2 implemented against them |
| `ADR-002` D5 (server-side sessions) | accepted; `AG-2` A preserves it |

### Still blocking S7 — register and login

`IG-1` (email normalisation), `IG-2` (duplicate registration: `409` vs `202`),
`IG-3` (auto-login after register), `IG-4` (password policy), `IG-6` (Argon2id
parameters, measured on the host), `IG-7` (per-account brute-force control),
`IG-10` (email verification). None is answered. S7 may not start with any of these
open, and none may be "settled by the first implementer".

### Still blocking S8 — session guard, `/me`, logout

`IG-8` (cookie name and `__Host-` prefix), `IG-9` (CSRF mechanics). Plus the
`maintenance` queue that would schedule the purge job, which is Phase 5 work: S8 can
*call* the function, and nothing can *schedule* it yet.

### Non-blocking gaps this plan records rather than fixes

1. `docs/architecture/auth-deferred.md` is missing (review F11, checklist §6.1). The
   analysis lives in `ownership-and-rls.md` §5; S9 adds the pointer.
2. `entity-catalog.md` needs `sessions` in the widened `identity` class; S9.
3. `sessions` rows whose `expires_at` has passed but whose `absolute_expires_at` has
   not are **retained** until the absolute deadline, because `AG-2` says purge on
   absolute expiry only. Bounded at 90 days; no alternative is invented here, and a
   change would need an owner decision.
4. No scheduled GC job exists. S5 makes the sweep callable; nothing calls it.
5. `app_api` cannot read `users` — unchanged, intentional, and the reason the auth
   credential exists.

---

## 14. Acceptance criteria

Each row names the evidence, not the intent.

### S3

1. `app_auth` exists with `LOGIN` after provisioning, `NOSUPERUSER`, `NOCREATEDB`,
   `NOCREATEROLE`, `NOREPLICATION`, `NOBYPASSRLS`, `NOINHERIT` — `db:verify` rows.
2. Zero memberships in either direction involving all four roles — `db:verify`.
3. A live connection reports `current_user = 'app_auth'` — suite probe.
4. After S3 **alone**, every table read fails `42501` — this is the baseline S4 is
   measured against.
5. The API boots with `APP_AUTH_DATABASE_URL`, refuses a URL naming `app_api`, and
   fails to boot in production without it — config tests plus one negative boot.
6. Two distinct clients exist, each closed on shutdown — lifecycle test.

### S4

7. `app_auth` `SELECT` succeeds on the six granted columns and fails `42501` on
   `created_at` and `updated_at`.
8. `INSERT (email, password_hash)` succeeds; any other column fails `42501`;
   `UPDATE` and `DELETE` fail `42501`.
9. `app_api` still holds no privilege on `app.users`; `users_self_only` unchanged;
   `FORCE` still set.
10. The migration names no other table and grants nothing to `PUBLIC`.
11. 39 tenant-isolation and 12 conformance assertions pass unchanged.

### S5

12. `sessions` exists with the eight columns, both CHECKs, unique `token_hash`, two
    indexes, `ENABLE`+`FORCE`, and both policies.
13. `app_api` and `app_system` fail `42501` on all four verbs; `app_auth` has exactly
    the column privileges in §7.4 and no `DELETE`.
14. `purge_expired_sessions()` is `prosecdef`, owned by `migration_owner`, `search_path`
    pinned, executable by `app_system` only, and returns a count (0 is valid).
15. A session whose `absolute_expires_at < now()` is deleted by one call; a live row
    survives; a row expired only on `expires_at` is **not** deleted.
16. A sliding extension at day 70 of 90 lands on `absolute_expires_at`, satisfies
    `sessions_expiry_order_check`, and does not exceed the absolute deadline.
17. Updating `token_hash`, `user_id`, or `created_at` as `app_auth` fails `42501`.

### S6 and cross-cutting

18. `db:verify` green with the new rows; assertion count recorded with the exact
    number, not "more than before".
19. `test/rls/auth-boundary.test.mjs` green; existing suites unchanged in count.
20. Both migrations apply to a fresh isolated volume in order.
21. No `OPEN-01`/`OPEN-13` disposition changed by the implementation. Their flip is a
    separate action requiring accepted `ADR-004`/`ADR-005` plus this evidence.
22. `pnpm build`, `typecheck`, `lint`, `test`, `prettier --check .`, `git diff --check`
    all exit 0.

---

## 15. Suggested commit boundaries

Migrations are immutable once applied, so each one ships alone and is verified before
the next.

| # | Commit | Contents | Must be green before the next |
|---|---|---|---|
| 1 | `feat(database): provision the app_auth role` | `roles.sql`, `bootstrap.mjs`, `connections.mjs`, `database.defaults.json`, `.env.example` names, `db:verify` attribute/membership rows | `db:bootstrap` + `db:verify` |
| 2 | `feat(api): hold a second, validated database credential` | `runtime-config.ts` (+fixtures), `tokens.ts`, `database.module.ts` | build, typecheck, api tests |
| 3 | `feat(database): grant the auth boundary on app.users` | migration `20261118040000_auth_boundary`, users-half verification | `db:verify`, auth-boundary users half |
| 4 | `feat(database): add server-side sessions` | migration `20261118050000_sessions`, `schema.prisma` model, function | `db:verify`, auth-boundary sessions half, conformance |
| 5 | `test(database): verify the authentication boundary` | `auth-boundary` suite, conformance rows, probe-isolation extension if needed | all DB suites |
| 6 | `docs: record the authentication database boundary` | `ownership-and-rls.md` matrix, `entity-catalog.md` class note, `IMPLEMENTATION_STATUS.md` with commands and counts | — |

Commits 1 and 3 are separable from the API work (2) and may be reviewed independently;
3 must not be squashed into 4, because a reviewer needs to see the `users` delta without
the session table in the diff.

---

## 16. Go / no-go for implementation

**GO when all of the following hold:**

1. The owner has **accepted** `ADR-004` and `ADR-005` (this plan does not write them;
   it is their implementation consequence). Acceptance is an owner action with a date
   and an approver, not an implementer's assertion.
2. `master` is at or after `75607d8` with a clean tree, and the S2 checks are green —
   the baseline this work builds on.
3. A cluster-admin path for bootstrap exists for every environment in scope
   (`BOOTSTRAP_DATABASE_URL` outside development) **or** the work is explicitly
   confined to development.
4. An isolated compose project for the fresh-volume migration check is available.
5. The implementation task explicitly authorises test-file changes (§5.4, §12).

**NO-GO — stop and escalate, do not work around:**

1. Anyone proposes giving `app_api` a read on `app.users` "temporarily" — that is
   Option C-via-the-back-door and re-opens `OPEN-01`.
2. Anyone proposes `SECURITY DEFINER` for the credential read (B2) without a new owner
   decision; it is recorded as the tightening path, not v1.
3. The session table is proposed with a tenant-scoped policy, or `app_api` is given
   any `sessions` privilege.
4. `migrate dev`, a migration rewrite, a reset, or a `DROP ROLE` is proposed as
   "cleanup". All four are prohibited.
5. Bundling S7 (register/login) into this phase because the tables "look ready". The
   seven `IG` gates that block S7 are unanswered, and a planned endpoint that invents
   a password policy or an email-normalisation rule puts an unapproved decision into
   production.
6. The `sessions_token_hash_shape_check` addition (§7.3) is neither accepted nor
   removed — an unreviewed schema constraint must not ship by default.

**What "done" looks like for this phase, in one sentence:** a fourth credential exists,
can read and insert exactly the credential columns it needs and exactly the session
columns it needs, cannot reach a single tenant, catalog, or weather row, cannot delete
a session, is proven to those bounds by `db:verify` and a behavioural suite running as
the real role, and `OPEN-01`/`OPEN-13` are still unresolved because resolution is a
separate, evidence-gated step.
