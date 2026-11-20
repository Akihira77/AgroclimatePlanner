# Phase 3.2.3 — Authentication Database Boundary (S3–S6): Implementation Plan

Status: **PLAN ONLY — nothing in this document is applied.**
Prepared 2026-11-18 against `master` at `75607d8`; revised after independent review.
Architecture records: `ADR-004` (`app_auth` boundary) and `ADR-005` (session storage),
formalising the owner decisions `AG-1`/`AG-2` of 2026-11-18. **`ADR-004` was accepted on
2026-11-18 and `ADR-005` on 2026-11-20**, so both ADR gates are satisfied; neither
acceptance applies any schema. The two gates are independent — a decision about a session
table did not gate the role bootstrap (§13.2, §16). `AG-1` and `AG-2` are **not**
re-opened here and are not asked for again.

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
Option A). Approval is not implementation, so both stayed unresolved through the work
below: `OPEN-13`'s storage question was **resolved on 2026-11-20** once all three of
`ADR-005`'s conjuncts held (accepted ADR, applied migration, green session suite) and
`OPEN-01` — the request path — stays open. This
plan is the implementation half, and only the database half of it: a fourth role,
two additive migrations, and the verification that proves each boundary exists.

Four steps, in a fixed order:

| Step | Deliverable | Why it must come here |
|---|---|---|
| **S3** | `app_auth` role in bootstrap, its DSN validated at boot, `AuthDatabaseModule` created but **not imported** — the client is instantiated at S7 | a policy cannot name a role that does not exist (`42704`) |
| **S4** | migration `auth_boundary`: 2 policies + 2 column grants on `app.users` | registration and login are impossible until a credential can read `password_hash` before a tenant context exists |
| **S5** | migration `sessions`: table, grants, policies, GC function | session rows are written by the credential S3 creates |
| **S6** | `db:verify` rows, `auth-boundary` suite, conformance additions | a boundary nobody measured is a claim, not a control |

Status, as of 2026-11-18 (kept as the starting point): **S3 and S4 are implemented,
verified in isolated projects, and pushed** (`b9a27c6`, `cf0d1c2`). Since then `S5`
(`8fb2270`) and `S6` shipped and were applied to the canonical development database on
2026-11-20 — `db:verify` 499/0/0, `test:rls` 88, `test:schema` 22 — with a fresh isolated
project reproducing the same numbers from an empty volume (§8.5).

What this does **not** produce: a register endpoint, a login endpoint, a session
guard, `/me`, `/logout`, password hashing, rate limiting, or a GC job. Those are S7
and S8 and remain blocked on gates this plan does not answer (§13).

The architecture half is now written down where it belongs rather than only in this
plan: `docs/adr/ADR-004-authentication-database-boundary.md` formalises `AG-1` and
`docs/adr/ADR-005-session-storage.md` formalises `AG-2`. `ADR-004` was **accepted on
2026-11-18** and `ADR-005` on **2026-11-20**, because approval of a decision and
acceptance of its record are different acts. This plan links to them and does not
restate them (§4).

## 1.1 What the first independent review changed

Four corrections, each of which would have produced a wrong implementation:

| # | Finding | Correction |
|---|---|---|
| 1 | adding `AUTH_DATABASE_CLIENT` to the `@Global()` `DatabaseModule` would have made both credentials reachable from every module, so the claimed isolation would have been a naming convention | §5.5: a separate, non-global `AuthDatabaseModule` that owns the token and its lifecycle; `DatabaseModule` is left unchanged |
| 2 | the S3 probe expected `42501` from `app.sessions` before the table exists — that statement returns `42P01`, so the check would have failed or been "fixed" by weakening it | §5.6, §8.0: relation **existence** is asserted with `to_regclass`, and denial only ever at `42501` |
| 3 | the gate matrix contradicted itself: the owner record listed the `IG` gates as blockers before S3, while this plan assigned them to S7/S8 | §13: architecture decision, ADR acceptance, implementation gate, milestone, and register item are now five separate states, and the owner record's header row is corrected |
| 4 | the Prisma `Session` model was left as "a relation, maybe", and the `User` model has no reciprocal field | §7.5: the relation is declared on both sides (matching `User`/`Farm`); §6.5 records that `User`'s literal defaults plus `@updatedAt` make `prisma.user.create/update` unusable under the grant, so registration is explicit-column SQL |

## 1.2 What the second review changed

Four more, all of them contradictions or unenforced claims rather than missing features:

| # | Finding | Correction |
|---|---|---|
| 1 | `app_auth` holds the `INSERT` grant, so it chooses `absolute_expires_at` — and nothing constrained it to 90 days. The 90-day rule was a sentence, not a schema | §7.1 adds `CHECK (absolute_expires_at <= created_at + INTERVAL '90 days')`, now owner-accepted as `D-2` (2026-11-20). §7.3 states that `LEAST()` bounds one statement, not the column, and that the 30-day sliding window stays an application invariant because no constraint can express it |
| 2 | S3 was listed as delivering "a second Prisma client", while §5.5 said the module is not imported until S7 | §5.5, §14: the module and its lifecycle provider are written at S3 and proven by a module-assembly test, but `AppModule` does not import them until S7, so no pool is opened for a credential nothing uses. Validation of the DSN still happens at boot |
| 3 | requiring **both** ADRs before S3 coupled S3 to a decision about a table it does not create | §13.2: independent gates — `ADR-004` before S3, `ADR-005` before S5 — restoring the original track granularity without weakening either |
| 4 | the GC job was called "Phase 5" in three places; `background-processing.md` says implementation is Phase 4 | corrected in this plan (§3.3, §13.3) and in ADR-005 |

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
- `apps/api/src/config/runtime-config.ts`, `src/tokens.ts` — a validated second DSN and
  its token. `src/database/database.module.ts` is **not** changed; the second client
  lives in a new, non-global `src/database/auth-database.module.ts` (§5.5).
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
later action. (`OPEN-13` was flipped that way on 2026-11-20 — ADR accepted, migration
applied to canonical, `auth-boundary` suite green — and it is recorded in the register as
its own act, not as a side effect of S5 or S6.)

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
| `app_auth` | no | provisioned (S3) | nothing | `SELECT` 6 columns + `INSERT` 2 on `users`; session columns only on `sessions`; no tenant, catalog, or weather reach |

The `app_auth` row records the state after S3–S5; when this section was measured
(2026-11-18) the role did not exist and its `LOGIN`/`BYPASSRLS` columns were empty. What
it may reach is asserted row by row in §8.2, not summarised here.

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

*(Written before S5. Since 2026-11-20 the table, its column grants, its policies, and
`purge_expired_sessions()` exist and are verified on canonical; see §7 and §8. The
paragraph below records the starting point the design was written against.)*

Nothing. No table, no model, no grant, no job. `entity-catalog.md:89` lists
`sessions` as unspecified and blocked by `OPEN-13`; `ADR-002` D5 already decided
server-side sessions in PostgreSQL and rejected JWT with refresh rotation; Redis is
documented and **not provisioned** (one compose service, zero `ioredis`/`bullmq`
resolvable from the workspace). The `maintenance` queue that would schedule the GC
job exists only in `background-processing.md:20`, Phase 4 work.

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
`SECURITY DEFINER` credential read for `app_api` (option B2, not B1 — B1 is the
`app_api`-reads-`users` variant), and a second tenant GUC (option C).

### 4.1 Where these two decisions are recorded

Three artefacts, three different meanings, and none of them substitutes for another:

| Artefact | Meaning | State |
|---|---|---|
| `phase-3.2-owner-decisions.md` §1.10, §2.10 | the owner **approved** `AG-1`/`AG-2` on 2026-11-18 | approved |
| `phase-3.2-owner-decisions.md` §2.11 | the owner **accepted** the three schema details `D-1`–`D-3` on 2026-11-20 (hash-shape CHECK, 90-day cap CHECK, two indexes) | approved; supplements `AG-2`, does not amend it |
| `ADR-004`, `ADR-005` | the durable formal record of those approvals | `ADR-004` **Accepted** 2026-11-18; `ADR-005` **Accepted** 2026-11-20 |
| this plan | how the approved architecture becomes schema and evidence | `S3`–`S6` implemented; canonical application and evidence in §7–§8 |

Approval is not acceptance of a document, and neither is implementation. Nothing here
asks the owner to decide `AG-1`/`AG-2` a second time: acceptance was a statement that each
ADR faithfully records what was approved. Both are now accepted — `ADR-004` on
2026-11-18, `ADR-005` on 2026-11-20 — and `D-1`–`D-3` settled the remaining schema
questions. All four steps have since been implemented and pushed: `S5` in `8fb2270`,
`S6` in `e9d1621`, with the canonical database at 5/5 and the evidence in §7 and §8.5.

The gates are per-milestone, not per-phase:

| Milestone | Gate |
|---|---|
| S3 | `ADR-004` accepted |
| S4 | S3 completed |
| S5 | `ADR-005` accepted **and** S4 completed |
| S6 | the stages whose rows it verifies — S3/S4 for the `users` half, S5 for the session half |

So `ADR-005` does **not** gate S3, S4, or anything else that creates no session table;
and S3 does not wait on a decision about sessions (§13.2, §16).

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

**Parse at boot, connect at S7.** `RuntimeConfig` is built once at startup and every
field is validated then, so `authDatabaseUrl` is parsed and asserted at S3 — a missing
or swapped credential still fails the boot, exactly as the table above requires. What
S3 does **not** do is open a connection pool: the client is created by the provider in
`AuthDatabaseModule`, and that provider is only instantiated when a module that needs
it is in the graph. At S3 nothing is, so the process holds a validated string and no
socket (§5.5).

### 5.5 The second client lives in its own module

The existing `DatabaseModule` is `@Global()` and exports `DATABASE_CLIENT` and
`DatabaseLifecycle` (`apps/api/src/database/database.module.ts:37-54`). Adding
`AUTH_DATABASE_CLIENT` to it would put both credentials behind one global token set:
every module in the process could inject the auth client by name without importing
anything. The separation would then be a naming convention enforced by review, not by
the dependency graph.

So the second client gets its own module, and `DatabaseModule` is left alone.

```text
AppModule
├── DatabaseModule        (@Global)     → DATABASE_CLIENT       app_api
├── AuthenticationModule
│   └── AuthDatabaseModule (not global) → AUTH_DATABASE_CLIENT  app_auth
└── HealthModule                        → DATABASE_CLIENT       app_api
```

| Element | Change |
|---|---|
| `src/tokens.ts` | gains `AUTH_DATABASE_CLIENT` — one symbol, nothing else |
| `src/database/database.module.ts` | **unchanged**; stays `@Global`, keeps one provider and one lifecycle, and must not export the auth token |
| `src/database/auth-database.module.ts` | new, **not** `@Global`; owns `AUTH_DATABASE_CLIENT` and `AuthDatabaseLifecycle` |
| `src/auth/auth.module.ts` | new at S7; the only module that imports `AuthDatabaseModule` |
| `src/app.module.ts` | **unchanged at S3**; gains `AuthenticationModule` at S7, and with it `AuthDatabaseModule` |

**Milestone boundary, decided: the module is written at S3, the client is instantiated
at S7.** This resolves what the previous revision left ambiguous — S3 was described as
delivering a second Prisma client while the same section said the module is not in the
graph until S7. Both cannot be true, and the second is the one to keep:

| Option | Verdict |
|---|---|
| **A** — instantiate at S3, i.e. import `AuthDatabaseModule` into `AppModule` immediately | rejected: it opens a `pg` pool for a credential no code reads, adds one connection's worth of failure surface to `/health/ready` semantics that do not probe it, and makes S7 look like no change when it is the milestone that introduces authentication |
| **B** — module and provider written at S3, not imported until S7 | **chosen**: a provider that is never in the graph is never instantiated, so the pool is created exactly when the first consumer arrives. Configuration is still validated at boot (§5.4), the boundary is still proven by tests at S3, and no dead connection exists in between |

The concrete consequence for S3's deliverable list: `auth-database.module.ts` and the
`AUTH_DATABASE_CLIENT` symbol are created and tested; `app.module.ts` is untouched.
Reading `AppModule` at S3 tells you nothing about the auth client, which is the point —
the module cannot be reached without editing the module that owns authentication.

Four consequences worth stating, because each is a way this is usually done wrong:

1. **Why not one global module with two providers.** It works mechanically and fails
   the only test that matters: a business module injecting `AUTH_DATABASE_CLIENT` would
   compile, pass review, and give tenant code access to every credential row. A
   non-global module turns that mistake into a missing import.
2. **Why not `@Global` on the auth module either.** A global non-tenant client is
   exactly the credential-by-default arrangement the module split exists to prevent.
3. **Lifecycle stays one provider per client.** Each lifecycle provider injects
   exactly one token and holds its own `closed` flag
   (`database.module.ts:24-35` is the pattern to copy). Nest calls `onModuleDestroy`
   once per provider instance, so no client is disconnected twice and neither
   lifecycle can reach the other client. Sharing one lifecycle class across both
   tokens is the shape that produces a double `$disconnect()`.
4. **No circular dependency is introduced.** `AuthDatabaseModule` depends on
   `APP_CONFIG` and the factory only; `DatabaseModule` depends on neither. The factory
   type `DatabaseClientFactory` is reused from the existing module (a type import, so
   it erases at compile time), which keeps both clients constructed the same way
   without either module importing the other's runtime value.

What this boundary is **not**: a NestJS module graph is compile-time structure. It
prevents accidental injection; it does not survive a compromised process, which holds
both tokens (`AG-1`; ADR-004, *Explicit limitations*). Nothing in the code may claim
otherwise.

Two further rules:

- `/health/ready` keeps probing the **tenant** client only. Adding an auth probe would
  change the meaning of a 503 already documented in `api-conventions.md` §12; auth
  readiness is an S7 concern with the fail-closed outage policy.
- Failure handling when the credential is absent: the process does not start
  (production) or derives the development URL (development). There is **no** fallback
  to `app_api` and no lazy "create it when needed" path — a client created on first use
  turns a configuration error into a 500 at the worst moment. This is unaffected by the
  deferred instantiation: the failure is a *configuration* failure and happens at boot,
  long before a provider would be constructed.

**How the boundary is tested at S3** (needs `IG-11`, which is already decided — this is
not deferred to S7, because an unproven boundary is exactly what the earlier revision
lacked):

| Test | Asserts |
|---|---|
| assembly A — `Test.createTestingModule({ imports: [AuthDatabaseModule.register(config, factory)] })` | `AUTH_DATABASE_CLIENT` resolves to exactly one instance, and `factory` was called once with **`config.authDatabaseUrl`**, not the tenant URL |
| assembly B — a module importing only `DatabaseModule` | `AUTH_DATABASE_CLIENT` does **not** resolve — the token is not global |
| assembly C — both modules, then `module.close()` | each client receives exactly one `$disconnect()`; the tenant client and the auth client are distinct objects |

The `DatabaseClientFactory` double already exists for this
(`AppDependencies.createDatabaseClient`), so all three run without a live PostgreSQL.
An additional S7 test asserts that `AuthenticationModule` is the module that imports
`AuthDatabaseModule`, so the graph does not drift.

### 5.6 Least-privilege check for S3 in isolation

S3 grants nothing on any table, so after S3 alone the role must be able to do exactly
one thing: connect, resolve `app`, and reach nothing.

**The absence of `app.sessions` is not a privilege check.** Before S5 the table does
not exist, and `SELECT FROM app.sessions` returns `42P01` (`undefined_table`) — an
object-existence failure, not a denial. Asserting `42501` there would either fail the
run or, worse, be "fixed" by widening the check. The correct probe is
`to_regclass('app.sessions') IS NULL`, stated as a positive fact about ordering.

The S3 acceptance probes are therefore:

| Probe (as `app_auth`) | Expected |
|---|---|
| `select current_user` | `app_auth` |
| `has_schema_privilege('app_auth', 'app', 'USAGE')` | true |
| `has_schema_privilege('app_auth', 'app', 'CREATE')` | false |
| `has_table_privilege('app_auth', 'app.users', 'SELECT')` | false (table-level); the column grants arrive at S4 |
| `select count(*) from app.users` | **`42501`** — the relation exists, the privilege does not |
| `select count(*) from app.farms` | **`42501`** — same |
| `to_regclass('app.sessions')` | `NULL` — declared as absence, never as a denial |
| `set role app_api` | **`42501`** |

That is what makes S4 a reviewable delta rather than "the role appeared and things
started working".

---

## 6. S4 — migration `auth_boundary`

### 6.1 Shape

`packages/database/prisma/migrations/20261118040000_auth_boundary/migration.sql`,
additive, 4 statements plus comments. No `ALTER TABLE`, no column change, no rewrite,
no data.

```sql
-- APPLIED 2026-11-18 by `20261118040000_auth_boundary` (S4).
GRANT SELECT (id, email, password_hash, role, locale, timezone) ON app.users TO app_auth;
GRANT INSERT (email, password_hash)                                ON app.users TO app_auth;

CREATE POLICY users_auth_lookup ON app.users
  FOR SELECT TO app_auth USING (true);
CREATE POLICY users_auth_register ON app.users
  FOR INSERT TO app_auth WITH CHECK (true);
```

**Implementation status (S4).** Committed and pushed to `master` as `b9a27c6`
(migration, verifier, unit tests) and `cf0d1c2` (status reconciliation). Applied and
verified in isolated Compose projects, never the canonical database: `db:verify`
reports **417 PASS / 0 FAIL / 0 SKIP** at `b9a27c6` and **419** after the corrective
pass that added the exact policy contract (§8.2). The behavioural half registers a
real `app_auth` row, reads it back with no `app.user_id` set, and gets `42501` for
`created_at`, `updated_at`, `SELECT *`, six unapproved INSERT columns, `UPDATE`, and
`DELETE`. `app_api` and `app_system` are unchanged and still hold no privilege on
`app.users`.

Three facts that are not the same fact, and are not to be merged in prose:

| Fact | State |
|---|---|
| S4 implementation in source control | **committed and pushed** — `b9a27c6`, `cf0d1c2` |
| S4 isolated verification | **passed** — 419 PASS / 0 FAIL / 0 SKIP on a fresh volume, all four migrations in order |
| S4 on the canonical database | **applied** — `db:bootstrap` then `db:migrate` on 2026-11-20 applied `auth_boundary` and `sessions` together; canonical is at 5/5 and `db:verify` is 499 PASS / 0 FAIL / 0 SKIP there |
| S6 standalone authentication suite | **implemented and green on canonical** — `test/rls/auth-boundary.test.mjs`, 49 cases |
| `OPEN-01` | **unresolved** |

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

### 6.5 Application consequences: the ORM does not fit the grant

`app_auth` cannot use `prisma.user.create()` or `prisma.user.update()` against this
grant, for reasons visible in `packages/database/prisma/schema.prisma:46-59`:

| Prisma declaration | What the client does | Against the grant |
|---|---|---|
| `locale String @default("id")` | a **client-side** default: the field is sent in the `INSERT` | `42501` — `locale` has no `INSERT` grant |
| `timezone String @default("Asia/Jakarta")` | same | `42501` |
| `role String @default("owner")` | same | `42501` |
| `updatedAt DateTime @default(now()) @updatedAt` | `@updatedAt` makes every `update()` write `updated_at = now()` | `42501` — and there is no `UPDATE` grant at all |
| `id String @id @default(dbgenerated("uuidv7()"))` | omitted, left to the database | fine |

So the strategy is decided here rather than discovered at S7:

- **Registration** is an explicit column insert, not an ORM create:
  `INSERT INTO app.users (email, password_hash) VALUES ($1, $2) RETURNING id`
  through `$queryRaw`. It names exactly the granted columns, lets PostgreSQL apply
  `locale`/`timezone`/`role`/timestamps from their column defaults, and returns only
  granted `SELECT` columns.
- **Login** is a `SELECT` of the six granted columns; nothing to adapt.
- **Any user write beyond insert is out of scope for `app_auth`.** Password change and
  email verification need `UPDATE` on specific columns — a new grant and a new policy,
  i.e. an owner decision, not something S4 quietly adds.

`RETURNING id, email, role, locale, timezone` is permitted because all six are in the
`SELECT` grant; `RETURNING created_at` would fail `42501`, which is intended.

The generated SQL still has to be confirmed empirically at S4 — statement logging or a
behavioural probe — because the point is to test the grant against the *actual*
statement, not against this table. The grant is authoritative; the ORM is not.

---

## 7. S5 — migration `sessions`

Status: **implemented (commit `8fb2270`), applied to the isolated verification project and
to the canonical development database on 2026-11-20.** Canonical is `127.0.0.1:5442`,
database `agroclimate`, schema `app`: `prisma migrate status` reports 5/5 applied, and on
that database `db:verify` reports 493 assertions with 0 `FAIL` and 0 `SKIP`,
`db:verify:probes` 12/12, `test:schema` 13/13 and `test:rls` 39/39. The isolated project
`agroclimate-db-s5-check` (port 5545) produced the same numbers before the canonical run.
`S6` later raised the same database to 499 assertions, `test:schema` 22 and `test:rls` 88
(§8.5).

Deployment had a precondition the plan did not anticipate: canonical was still at
`domain_tables`. It had three of four roles — `app_auth` did not exist — so
`db:bootstrap` ran first, and `db:migrate` then applied `auth_boundary` **and** `sessions`
in one pass. Both are committed and reviewed; neither was altered to make this work. A
custom-format backup was taken and validated before either step.

`OPEN-13` was **resolved on 2026-11-20**, once the third of `ADR-005`'s conjuncts
existed: the S6 suite `test/rls/auth-boundary.test.mjs` is green on canonical. The first
two conjuncts were already satisfied — ADR accepted, migration applied — so the flip is
recorded in `docs/data-model/open-decisions.md` §5 as its own act, and it resolves the
storage question only: `OPEN-01` (the request path) and `OPEN-04` (account deletion)
remain open.

Everything from §7.5 onward that describes the request path is still S7's: S5 ships no
endpoint, no token generation, and no throttle.

One consequence worth stating: `db:verify` now asserts session storage as **required**
state, so a database that stops at S4 fails it by design rather than reporting a skip.

### 7.1 Table

`packages/database/prisma/migrations/20261118050000_sessions/migration.sql`.

```sql
-- APPLIED as 20261118050000_sessions in both the isolated project and canonical (5442).
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
  -- D-1, accepted 2026-11-20 (§2.11 of the owner record)
  CONSTRAINT sessions_token_hash_shape_check CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  -- D-2, accepted 2026-11-20; the cap AG-2 describes, made checkable.
  CONSTRAINT sessions_absolute_expiry_cap_check
    CHECK (absolute_expires_at <= created_at + INTERVAL '90 days')
);

-- D-3, accepted 2026-11-20.
CREATE INDEX sessions_user_id_idx ON app.sessions (user_id);
CREATE INDEX sessions_absolute_expires_at_idx ON app.sessions (absolute_expires_at);
```

Ownership: created by the migration connection, so the table and both indexes are
owned by `migration_owner` along with every other object in `app`.

**The cap constraint changes how the insert must be written, and that is the point.**
`created_at` defaults to `now()`, which is `transaction_timestamp()`: the time the current
transaction began, not the time the current statement began, and it does not change for
the duration of that transaction. If the application computes a deadline in JavaScript,
`Date.now() + 90 days` is already later than `created_at + 90 days` by however much time
elapsed since the transaction started, and the insert fails `23514`. Both deadlines must
therefore come from the same SQL clock:

```sql
-- What the application must run instead of binding two JS timestamps.
INSERT INTO app.sessions (user_id, token_hash, expires_at, absolute_expires_at)
VALUES ($1, $2, now() + INTERVAL '30 days', now() + INTERVAL '90 days')
RETURNING id;
```

This is a consequence of the constraint, not a preference: it is what makes "90 days
from creation" mean the same instant on both sides. `statement_timestamp()` and
`clock_timestamp()` would not work here — both are later than the value `created_at`
received from `now()`, so a deadline built from either can violate `D-2` by the elapsed
time. Inside a longer transaction, `now()` is earlier than the moment of the insert;
that is the property being relied on, and it is why all three timestamps agree exactly.

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

### 7.3 Three additions to the approved DDL — accepted as `D-1`–`D-3`

None is in the design review's proposed DDL, and none was covered by `AG-2`. They are
now **owner decisions**: `D-1` (hash-shape CHECK), `D-2` (90-day cap CHECK), and `D-3`
(two indexes), accepted 2026-11-20 and recorded in
`docs/review/phase-3.2-owner-decisions.md` §2.11. They supplement `AG-2`; they do not
amend it. The migration ships them; it does not re-litigate them.

**1. `sessions_absolute_expiry_cap_check`.** This is the one that changes what the
database can promise. `app_auth` holds `INSERT (user_id, token_hash, expires_at,
absolute_expires_at)`, so it **chooses** the absolute deadline. Without a constraint,
`AG-2`'s "absolute 90 days" is a property of the code path that happens to write the
row — and a single statement can insert a session valid for a decade, which is a valid
row under `absolute_expires_at >= expires_at`.

- `CHECK (absolute_expires_at <= created_at + INTERVAL '90 days')` makes the approved
  maximum checkable. It encodes a number the owner already decided; it does not add,
  loosen, or reinterpret a rule.
- It is a **ceiling, not an equality**. A session created 1 day long passes. A short
  session is a usability bug the user fixes by logging in again; a long one is a
  credential that outlives its decision, which is why only this direction is
  constrained.
- **What it does not do:** it cannot force the application to choose 90 days, and it
  cannot see intent. It also cannot express the *sliding* 30-day rule (below).
- **Why it cannot be gamed by backdating:** `created_at` is not in the `INSERT` grant
  (`GRANT INSERT (user_id, token_hash, expires_at, absolute_expires_at)`), so the
  application cannot move the anchor backwards to fit a longer deadline. It is also
  absent from the `UPDATE` grant, so it cannot be moved afterwards either.
- **Cost to the application:** the insert must derive both deadlines from SQL `now()`
  (§7.1), not from a JavaScript clock, or it fails `23514` by the request's latency.
- If a future change removes it, the gap must move into the limitations list rather
  than disappear: `app_auth` would be able to insert any lifetime it likes, and the
  90-day bound would be application-only.

**2. `sessions_token_hash_shape_check`.** `AG-2` says "only `sha256(token)` stored",
and nothing in the schema currently distinguishes a hash from a raw token: a bug that
wrote the base64url token into `token_hash` would be silently accepted and would still
authenticate.

- 64 lowercase hex characters is exactly `encode(sha256(32 bytes), 'hex')`. A base64url
  token is 43 characters, so the mistake fails at `23514` instead of persisting a
  credential.
- It constrains the *encoding*, not the algorithm. If a future decision stores base64
  hashes, this needs a migration — which is the intended cost.
- It does not make the raw-token rule enforceable in general (an application could hash
  twice and still pass); it catches the one realistic error.

**3. `sessions_user_id_idx` and `sessions_absolute_expires_at_idx`.** The review's DDL
declares `token_hash UNIQUE` and no other index. Two scans then have no index:
revoke-all-sessions-for-a-user (`WHERE user_id = $1`) and the GC sweep
(`WHERE absolute_expires_at < now()`). Both are rare and both are sequential scans over
a table that grows to 90 days of every user's sessions, on the hour, forever.

- They add no capability and change no plan for the request path, which is the unique
  `token_hash` lookup.
- A partial index (`WHERE revoked_at IS NULL`) was considered for the user index and
  rejected: revoking all of a user's sessions must also find already-revoked rows if it
  is ever used to audit, and the table is small enough that the distinction is noise.

**What stays application-level, deliberately.** The sliding window is not constrained,
and `LEAST(now() + INTERVAL '30 days', absolute_expires_at)` is an expression in one
statement, not a rule about the column: a caller that skips it and writes any
`expires_at <= absolute_expires_at` succeeds. Three candidates were considered and
rejected, so the choice is not an oversight:

| Candidate | Why not |
|---|---|
| `expires_at <= created_at + INTERVAL '30 days'` | **wrong**, not merely weak: a legitimate extension at day 40 lands at day 70, beyond `created_at + 30 days`. It would break the approved sliding behaviour |
| `expires_at <= last_seen_at + INTERVAL '30 days'` | constrains two values the application writes in the same statement; it catches a typo and enforces nothing against a caller that controls both. It also couples `last_seen_at` to extension, which the design does not require |
| A trigger recomputing the deadline | application logic in the database, with a definer-style surface and no gain over the absolute cap. `SECURITY DEFINER` scope discipline (ADR-005, *Garbage collection*) applies |

All three additions were cheap to reverse while S5 was still unshipped — a constraint and
an index are one `ALTER`/`DROP` each in the *same* migration, not a later one. Once it has
been applied anywhere that matters, they are immutable like everything else, and a change
becomes a new migration.

### 7.4 Grants, policies, and the GC function

```sql
-- APPLIED in 20261118050000_sessions; verified in an isolated project only.
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
-- no DELETE to any runtime role
-- no table privilege of any kind to app_api or app_system; app_system receives
-- EXECUTE on app.purge_expired_sessions() below — a function privilege, not a table one

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

### 7.5 Prisma representation — relation traversal declared, deliberately

One direction, chosen now so S5 does not rediscover it: **declare the relation on both
sides**, matching how `User`/`Farm` already works (`schema.prisma:55` `farms Farm[]`,
`:71` `user User @relation(fields: [userId], references: [id])`).

```prisma
// In model User — currently absent, so the reciprocal field must be added:
sessions Session[]

// New model:
model Session {
  id                String    @id @default(dbgenerated("uuidv7()")) @db.Uuid
  userId            String    @map("user_id") @db.Uuid
  tokenHash         String    @unique @map("token_hash")
  expiresAt         DateTime  @map("expires_at") @db.Timestamptz(6)
  absoluteExpiresAt DateTime  @map("absolute_expires_at") @db.Timestamptz(6)
  revokedAt         DateTime? @map("revoked_at") @db.Timestamptz(6)
  lastSeenAt        DateTime  @default(now()) @map("last_seen_at") @db.Timestamptz(6)
  createdAt         DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)

  user User @relation(fields: [userId], references: [id])

  @@schema("app")
  @@map("sessions")
}
```

Why the relation and not a bare scalar:

- It is the existing convention in this file. A `user_id` scalar with no relation would
  be the only foreign key in the schema represented that way, and the next reader would
  read it as an oversight.
- The FK's referential action is `NO ACTION` (`RESTRICT`-like), matching the SQL
  migration's plain `REFERENCES`. Nothing here specifies `onDelete`/`onUpdate`, because
  the SQL says neither and the representation must not invent a behaviour.
- It creates **no** traversal requirement: nothing on the auth path needs
  `session.user` or `user.sessions`. The relation is declared for fidelity, not for use.

Two constraints on this model, both non-negotiable:

1. **`prisma/migrations` remains authoritative.** `migrate dev` is banned and must not
   return; the model exists so the client has a type, not so it can generate DDL. CHECK
   constraints and the function have no Prisma representation — say so in a comment
   rather than pretending the schema file is complete.
2. **This task does not touch `schema.prisma`.** The `Session` model and the reciprocal
   `sessions Session[]` on `User` are S5 changes, made by hand and reviewed against the
   applied migration.

### 7.6 Schema/Prisma write-path consequence

Session creation names `user_id`, `token_hash`, `expires_at`, `absolute_expires_at` —
exactly the `INSERT` grant — plus nothing else, because `id`, `last_seen_at`, and
`created_at` are database defaults (`dbgenerated`/`now()`), which Prisma omits. So
`create` is viable here where `user.create` is not; the difference is that every
non-defaulted session column is granted, while `User`'s literal defaults are
client-sent (§6.5).

Any read that selects `*` needs the full `SELECT` list — which `app_auth` has. So the
column grant is about **writes** and about future columns, not about hiding present
rows from the auth credential. Say it plainly where the query lives: **the session
table's column grants do not hide session rows from `app_auth`; they constrain which
columns it can change.**

---

## 8. S6 — privilege verification and security tests

Three harnesses, each answering a different question. None of them is a text search over
SQL; every assertion talks to PostgreSQL as the role it is about.

### 8.0 Six layers, and why they must not be collapsed

A single "denied or not" assertion cannot tell a boundary apart from a typo, and it
cannot run before the object exists. Verification is therefore layered, and each layer
answers a question the others cannot:

| Layer | Question | Probe | Failure mode if collapsed |
|---|---|---|---|
| **Existence** | is the object there at all? | `to_regclass('app.sessions')`, `pg_proc` lookup, `information_schema.columns` | querying a missing table returns `42P01` — an object error read as a denial |
| **Schema** | may the role resolve `app`? | `has_schema_privilege(…, 'USAGE'/'CREATE')` | a `42P01` from an unresolvable schema duplicates the existence layer |
| **Table** | any table-wide grant? | `has_table_privilege` + policy/ACL dump | `has_table_privilege` is **false for column grants**, so it cannot prove a column grant exists — and reads as "locked down" when it is not |
| **Column** | exactly which columns? | `has_column_privilege` per column, positive and negative | the only safe way to assert a column grant; table-level checks are structurally blind here |
| **RLS** | is the policy set what we think? | `relrowsecurity`, `relforcerowsecurity`, `pg_policies` | a grant without `FORCE` and a policy is a different system than one with them |
| **Behaviour** | does the database actually refuse? | the statement, as the role, expecting an exact SQLSTATE | any of the above can be true while the statement still succeeds (e.g. via a different grant path) |

**SQLSTATE discipline.** A denial is accepted only at `42501`
(`insufficient_privilege`). Every other code fails the assertion:

| Code | Meaning | Verdict |
|---|---|---|
| `42501` | `insufficient_privilege` | the only accepted denial |
| `42P01` | `undefined_table` | **fails** the check — the object is missing, nothing was proved about privileges |
| `3F000` | `invalid_schema_name` | fails — the schema is wrong, not the privilege |
| `23503` | `foreign_key_violation` | asserted separately, where a FK is the actual mechanism, never as a denial |
| `23514` | `check_violation` | asserted separately, for constraint tests |
| `42601`, `42703` | syntax/undefined column | fails — the probe is broken |

Relation **absence** is asserted as absence, never as a denial. Before S5 the correct
statement about `app.sessions` is `to_regclass('app.sessions') IS NULL`.

### 8.1 Stage-appropriate scope

Verification grows with the schema; each stage's suite must pass on its own, because
each ships as its own commit.

| Stage | What exists | What is asserted |
|---|---|---|
| **after S3** | role only, no table grant | role identity and attributes; zero memberships; `USAGE` on `app`, no `CREATE`; `42501` on `app.users` and `app.farms` (relations exist); `to_regclass('app.sessions') IS NULL`; `SET ROLE` refused |
| **after S4** | `users` column grants + 2 policies | the six `SELECT` columns granted and the two absent; `INSERT` for `email`/`password_hash` only; `UPDATE`/`DELETE` `42501`; `app_api` still `42501`; `users_self_only` unchanged; `FORCE` intact |
| **after S5** | `sessions` table + function | column grants exactly as §7.4 with no `DELETE`; `app_api`/`app_system` `42501` on all four verbs; RLS flags and both policies; function `prosecdef`/owner/`EXECUTE`/`search_path`; GC deletes dead rows only |
| **cross-stage regression** | everything | 39 tenant-isolation tests and 12 conformance checks unchanged; `app_api`'s credential denial re-asserted |

### 8.2 `db:verify` (structural + behavioural, existing harness)

Additions to `privilege-verification.mjs`:

| Group | Assertions |
|---|---|
| Existence | `to_regclass('app.users')` not null; **at S3 only**, `to_regclass('app.sessions')` is null — recorded as ordering evidence, and the S6 run adds the non-null assertion once S5 has applied |
| Identity | `connected as app_auth`; `rolcanlogin = true`; no superuser/createdb/createrole/replication |
| Attributes | `app_auth` `NOBYPASSRLS`; `NOINHERIT` |
| Membership | the existing zero-membership query now covers four roles, in both directions |
| Schema | `app_auth` has `USAGE` on `app`, no `CREATE` on `app`, no `CREATE` on `public` |
| `EXPECTED` | `app_auth` added to every row's expectation as `NONE` — table-level only, because `has_table_privilege` reports false for column grants |
| Column grants | `has_column_privilege(app_auth, users, c, 'SELECT')` true for the six, false for `created_at`/`updated_at`; `INSERT` true for `email`/`password_hash`, false for the rest; `UPDATE` and `DELETE` false for every column |
| Sessions | table `42501` for `app_api` and `app_system` on all four verbs; `app_auth` column privileges exactly as §7.4; no `DELETE` for `app_auth` |
| RLS | `sessions` `relrowsecurity` and `relforcerowsecurity` true; both policies present; neither names `{public}` or `app_api`; `SELECT`/`INSERT` split correct |
| Function | `prosecdef` true; owner `migration_owner`; `proacl` grants `EXECUTE` to `app_system` only; `has_function_privilege` false for `app_api`, `app_auth`; `pg_proc.proconfig` contains the pinned `search_path` |
| Cross-role | `app_auth` cannot `SET ROLE app_api`/`app_system`/`migration_owner`; `app_api`/`app_system` unchanged |
| Regression | the existing `app_api holds no grant on app.users` denial stays and is asserted for the new role's neighbours too |

Every denial is accepted only at `42501`; `23503` and `23514` are asserted separately,
where a foreign key or a CHECK is the actual mechanism, and never counted as denials.

**Implemented at S4 (2026-11-18), and where it diverges from the rows above.** The
`users` half of this table is in `db:verify` now; the `sessions` and function rows stay
unimplemented until S5. Four concrete choices:

- The grant is asserted as an **exact set** (`checkAuthUserColumnGrants`), not as a
  floor: a seventh readable column fails even though it satisfies "the six are
  readable". The same function is unit-tested without a database in
  `packages/database/test/unit/privilege-verification.test.mjs` — six cases, including
  a duplicate that pads the set to the right length and a missing row that must be a
  failure rather than silence.
- The pre-S4 aggregate `app_auth holds no column privilege on any app table` became
  `…on any app table other than users`, and `app.users` is asserted exactly instead.
  Leaving the aggregate inclusive would have tolerated the six approved columns by
  arithmetic.
- The behavioural half lives inside `db:verify`, not in `test/rls/auth-boundary.test.mjs`:
  it inserts one row as `app_auth` (which *is* the registration probe), reads it back
  with no `app.user_id`, and removes it as `migration_owner` because `app_auth` has no
  `DELETE`. The standalone suite in §8.3 remains S6's deliverable, so this must not be
  counted as having been written.
- `app_api`/`app_system` are asserted with both `has_table_privilege` and
  `has_column_privilege`; the first alone would miss a column grant added by mistake.
- The policies are asserted as a **contract**, not a name list, by
  `checkUsersPolicyInventory`: four records compared on command, `permissive`, role
  set, `USING` and `WITH CHECK`, with a missing policy, an extra policy, and a
  rewritten expression all failing. `users_self_only`'s predicate is compared against
  the catalogue's normalised text
  (`(id = (NULLIF(current_setting('app.user_id'::text, true), ''::text))::uuid)`), so
  widening it to `USING (true)` is a red run rather than a silent tenancy hole.
  `roles` is fetched as `text[]`, because `roles === "{public}"` misses
  `{app_auth,public}`. The comparison is a pure function and is unit-tested without a
  database; a real `CREATE POLICY … TO PUBLIC` on an isolated table was used once to
  confirm the assertion actually fires (`db:verify` exit 1, three FAIL).

**What happens to `checkSessionAbsence` at S5 — replace it, never delete it.** The
function asserts `to_regclass('app.sessions') IS NULL`, which is correct only before S5.
Deleting it at S5 would remove the only existence assertion, so a migration that created
nothing, or created a table under the wrong schema, could still pass. It is therefore
**replaced by a presence + structure check**:

| Assertion | Probe |
|---|---|
| The relation exists, in `app`, as a table | `to_regclass('app.sessions')` not null; `relkind = 'r'`; `relnamespace = 'app'::regnamespace` |
| The column set is exactly the eight approved columns | `information_schema.columns` compared as a set, not a count |
| The exact three-check inventory exists, by definition | `pg_constraint` rows for the relation with `contype = 'c'`, each definition compared against its expected `pg_get_constraintdef` text — not matched by name, and not matched as a count |
| The unique constraint protects `token_hash` | `pg_index`/`pg_constraint` on the column, not a name lookup |
| Both indexes exist and are on the intended columns | `pg_indexes` on the relation |
| RLS is enabled **and** forced | `pg_class.relrowsecurity`, `relforcerowsecurity` |

As shipped on 2026-11-20 that replacement is `checkSessionTable()` plus the `app.sessions`
section of `runPrivilegeVerification()`; the absence call no longer exists in the file.

**The three CHECK constraints, and what "verified" means.** The approved DDL has exactly
three CHECK constraints. All three are structural, so an assertion that "a CHECK exists"
or that "two of them exist" would pass on a table that lost one and gained another. Each
is verified separately, by purpose:

| ID | Constraint | Purpose | Expected definition |
|---|---|---|---|
| A | expiry order (`AG-2` §2.4) | a session cannot be born dead or outlive its hard deadline | `CHECK (absolute_expires_at >= expires_at AND expires_at > created_at)` |
| B | token hash shape (`D-1`) | the stored value is 64 lowercase hex characters | `CHECK (token_hash ~ '^[0-9a-f]{64}$')` |
| C | absolute expiry cap (`D-2`) | no single statement can mint a decade-long credential | `CHECK (absolute_expires_at <= created_at + INTERVAL '90 days')` |

`B` validates the **representation** only; it cannot prove the value was derived with
SHA-256. `C` is an **upper bound**, not an obligation to use exactly 90 days. `A` is the
`AG-2` constraint that predates `D-1`/`D-2` — a verifier that checks only `B` and `C`
would leave the expiry-order rule unmeasured, which is the defect this inventory exists
to prevent.

The comparison target is the catalogue's normalised text, not the source SQL: PostgreSQL
rewrites definitions (`'90 days'::interval`, parenthesisation, `'^[0-9a-f]{64}$'::text`),
the same reason `users_self_only`'s predicate is recorded from `pg_get_constraintdef`
rather than copied from the migration. The expected strings are therefore captured from
an isolated project at S5 and unit-tested without a database, exactly as the policy
contract is.

The verifier must fail, as separate cases, on each of these:

1. **Missing** — the relation has fewer than three CHECK constraints
   (`contype = 'c'`), or one of the three expected definitions is absent. A missing `A`
   is not compensated by a present `B`/`C`.
2. **Extra** — a fourth CHECK constraint, or any CHECK whose definition is none of the
   three. The approved DDL declares no other CHECK on `app.sessions`, so the inventory
   is exact; an additional constraint is a schema change that bypassed review.
3. **Weakened or rewritten** — right purpose, different predicate: `>` for `>=`, a
   `30 days` cap, `[0-9a-f]{1,64}`, `OR` in place of `AND`, or a dropped clause. Text
   equality on the normalised definition catches all of them.
4. **Renamed** — a correct definition under an unexpected name still passes, because the
   name is not the contract; the mismatch is logged as an informational note so the
   rename is visible rather than silent. If the definition changed as well, case 3 fails
   it.
5. **Displaced** — a matching definition attached to a different relation. The probe
   filters by the session table's oid, so a constraint of the same name on another table
   cannot satisfy the assertion.

Constraint names are recorded for diagnostics only
(`sessions_expiry_order_check`, `sessions_token_hash_shape_check`,
`sessions_absolute_expiry_cap_check`). A later rename must not turn the suite red; a
later rewrite must.

The unit tests that drive the function move with it: the "passes when the relation is
missing" case becomes "fails when the relation is missing", and the "already exists"
case is the passing case after S5. Nothing is dropped without its replacement landing in
the same change, and S6 records the transition in its evidence.

### 8.3 New suite `test/rls/auth-boundary.test.mjs` (`node:test`, real roles)

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
| any of the 21 existing tables other than `users`, `select` | `42501`, enumerated over the table list, not sampled |
| `insert into app.sessions (user_id, token_hash, expires_at, absolute_expires_at)` with `now() + 30d` / `now() + 90d` in SQL | succeeds |
| the same insert with `absolute_expires_at = now() + INTERVAL '91 days'` | `23514` — constraint, **not** a denial; asserted separately from every `42501` row |
| the same insert with `expires_at > absolute_expires_at` | `23514` |
| the same insert with `expires_at <= created_at` | `23514` |
| the same insert binding a JavaScript `Date.now() + 90d` value | `23514` — the documented consequence of §7.1, asserted so the raw-SQL requirement is not a comment nobody tests |
| `select … from app.sessions where token_hash = $1` | 1 row |
| `update app.sessions set revoked_at = now()` | succeeds |
| `update app.sessions set token_hash = …` / `user_id = …` / `created_at = …` / `absolute_expires_at = …` | `42501` |
| `delete from app.sessions` | `42501` |
| `select app.purge_expired_sessions()` | `42501` |

Rows that need an object that does not exist yet are **stage-gated**: the `sessions`
block runs only after S5, and the suite asserts `to_regclass('app.sessions')` before
using it rather than letting `42P01` masquerade as a denial.

And as the other roles: `app_api`/`app_system` `42501` on every `sessions` verb;
`app_system` `EXECUTE app.purge_expired_sessions()` succeeds and returns an integer;
`app_api` `42501` on the function.

### 8.4 `test/schema/schema-conformance.test.mjs`

Structural rows, no behaviour: `sessions` exists with the eight columns, all three
CHECK constraints (expiry order, hash shape, absolute cap), the unique constraint, the
two indexes, `ENABLE`+`FORCE`, two policies
(`sessions_auth_all TO app_auth FOR ALL`, `sessions_owner_full_access TO
migration_owner`), and the exact grant lists via `has_column_privilege`. The existing
12 conformance checks and 39 isolation tests must pass **unchanged** — a changed
count is a finding, not a housekeeping edit.

### 8.5 Fresh-volume migration check

Both migrations are applied to an isolated compose project with its own volume
(the Phase 3 pattern), never by resetting the development database, and the project
is removed afterwards. This is the only way to know S3-before-S4 ordering holds from
zero rather than from an already-provisioned cluster.

**Implemented 2026-11-20, with the numbers.** Three deliverables, each with its own
evidence:

| Deliverable | Before | After | Evidence |
|---|---|---|---|
| `db:verify` assertions | 493 PASS | **499 PASS**, 0 FAIL, 0 SKIP | six new rows: four `23514` constraint probes (90-day cap, expiry order, born-expired, JavaScript-computed deadline), the clamped-extension equality, and PUBLIC holding no table- or column-level privilege on `app.sessions` |
| `test/rls/auth-boundary.test.mjs` | did not exist | **49 cases**, all passing | real roles only; `42501` exact for every denial; `23514`/`23503` asserted separately; 21 non-authentication tables enumerated from the catalogue, not sampled |
| `test:schema` | 13 tests | **22 tests**, all passing | eight session columns in `attnum` order, the three CHECK definitions as an exact inventory, the unique key, the four indexes, both policies as contracts, the column-grant sets, and the FK's `confdeltype = 'a'` |

`test:rls` therefore runs 88 cases (39 isolation + 49 boundary) and the existing 39 are
unchanged. Canonical (`127.0.0.1:5442`, 5/5) and a fresh isolated project
(`agroclimate-s6-fresh`, port 5546, own volume, bootstrap then `db:migrate`) produced the
same 499/22/88; the isolated project was removed afterwards and canonical was untouched.
Migration order from zero is therefore evidenced, not assumed.

Two boundaries the implementation deliberately keeps: the JavaScript-deadline probe uses
a one-second offset inside a transaction rather than a sleep, because JavaScript rounds to
the millisecond and can only land *after* the transaction clock; and the suite derives the
21-table denial list from `pg_tables` at run time, asserting the derived count, so a table
added later cannot silently escape coverage.

The `OPEN-13` flip is recorded in the register as its own act (§8.2 of this document
required exactly that): accepted ADR, applied migration, green suite — in that order.

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
| A session with an unbounded lifetime | PostgreSQL (`D-2`) | the insert names `absolute_expires_at` and `app_auth` chooses it, so the choice is bounded only by `created_at + 90 days`. Without the CHECK the bound is application-only and a single statement can mint a decade-long session | if removed, this line moves to the limitations instead of disappearing |
| A session extended past its deadline | PostgreSQL | `expires_at <= absolute_expires_at` is a CHECK, and `UPDATE` cannot reach `absolute_expires_at` at all | none at this layer |
| A session extended by more than 30 days | **nobody** | `LEAST()` is an expression in one statement, not a column rule; `expires_at - last_seen_at` is not constrained. The 30-day window is application intent | disclosed; no constraint can express it (§7.3) |
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

### 10.1 What a compromised `app_auth` can and cannot enforce

Written as a list of capabilities rather than prose, because this is the paragraph a
future reader will quote:

| Capability | Possible? | Bound |
|---|---|---|
| Read every `users` row (email, hash, role, locale, timezone) | yes | column grant; `USING (true)` adds no filter |
| Insert a user outside the registration flow | yes | `INSERT (email, password_hash)` only |
| Change a user's password, email, or role | **no** | no `UPDATE` grant on `users` |
| Read every session row | yes | accepted (`AG-2` S-4) |
| Insert a session for **any** `user_id` | yes | this is impersonation, and no grant prevents it |
| Choose a session lifetime up to 90 days | yes | the `D-2` cap CHECK is a ceiling, not an equality |
| Choose a session lifetime **beyond** 90 days | **no** | `D-2`; the one place where a schema constraint changes the answer |
| Move an existing session's absolute deadline | **no** | `absolute_expires_at` is outside the `UPDATE` grant |
| Re-point a session at another user | **no** | `user_id` is outside the `UPDATE` grant |
| Revoke a session | yes | `UPDATE (revoked_at)` |
| Un-revoke a session it revoked | yes | same grant, no direction |
| Delete a session | **no** | no `DELETE` grant; only the GC function deletes, as the owner |
| Extend a session by more than 30 days | yes | no constraint exists; only the application's `LEAST()` and its 5-minute rule |
| Reach a tenant, catalog, or weather row | **no** | `42501` on all 21, enumerated |
| Create or alter schema objects | **no** | no `CREATE` on `app` |
| Become another role | **no** | `NOINHERIT`, zero memberships, `SET ROLE` refused |

Three conclusions that follow directly, and that no wording elsewhere in this plan may
contradict:

1. **The credential cannot be constrained to *intent*, only to *shape*.** Every "no"
   above is a privilege or a constraint; every "yes" is a capability the approved
   design grants deliberately. The 90-day cap is the only lifetime property that moved
   from "the code promises" to "the database refuses".
2. **The 30-day sliding rule is application-only, permanently.** It is relative to the
   moment of extension, and the table does not record that moment. A constraint here
   would either break legitimate extensions or constrain two values the same statement
   writes.
3. **Impersonation is not a lifetime problem.** `INSERT (user_id, …)` means the
   credential can mint a session for any user regardless of any expiry rule; the cap
   limits how long that session lives, not whether it exists. Bounding it is ADR-004's
   credential boundary, not ADR-005's table.

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

### 13.1 The five statuses this plan keeps apart

Every gate below is in exactly one of these states, and the states are not
interchangeable. Most gate confusion in this repository has come from collapsing two
of them into "done" or "blocked".

| # | State | Meaning | What it is not |
|---|---|---|---|
| 1 | **Architecture decided** | the owner chose an option on a date | not an implementation |
| 2 | **ADR written, not accepted** | the decision is recorded durably and awaits owner acceptance of the record | not a new decision, not a second approval |
| 3 | **Implementation gate open** | an owner answer is still required before a named step can be written | not answerable by an implementer |
| 4 | **Milestone not started** | no code exists for a step whose gates are satisfied | not blocked |
| 5 | **Register item unresolved** | `OPEN-nn` still needs accepted ADR **+** applied migration **+** green verification | not resolved by approval alone |

### 13.2 Where each gate currently sits

| Gate | State | Detail |
|---|---|---|
| `AG-1` | **1 — decided** 2026-11-18 | owner record §1.10, Option A |
| `AG-2` | **1 — decided** 2026-11-18 | owner record §2.10, Option A |
| `ADR-004` | **accepted 2026-11-18** (Akihira77) — left state 2 | `docs/adr/ADR-004-authentication-database-boundary.md`; formalises `AG-1`, not implemented |
| `ADR-005` | **accepted 2026-11-20** (Akihira77) — left state 2 | `docs/adr/ADR-005-session-storage.md`; formalises `AG-2`; its three schema details are decided as `D-1`–`D-3` (2026-11-20) |
| `D-1`–`D-3` | **1 — decided** 2026-11-20 | owner record §2.11; they supplement `AG-2` |
| `IG-5`, `IG-5-A1` | decided, implemented | S1/S2 shipped against them |
| `IG-11` | decided | `node:test` for `apps/api`; already in use |
| `IG-12` | decided | Zod-only validation, bound per parameter; in use |
| `IG-1`–`IG-4`, `IG-6`, `IG-7`, `IG-10` | **3 — open** | block **S7**, not S3–S6 |
| `IG-8`, `IG-9` | **3 — open** | block **S8**, not S3–S6 |
| S3 | **4 — implemented** | gate: accepted `ADR-004`; `db:verify` 387 assertions at the time |
| S4 | **4 — implemented and pushed** | gate: S3 (the role must exist before a policy names it); `db:verify` 419 assertions after the corrective pass |
| S5 | **4 — implemented, committed, pushed, and applied to canonical** | gate: accepted `ADR-005` **and** S4, both satisfied 2026-11-20; commit `8fb2270`; canonical `127.0.0.1:5442` at 5/5 with `db:verify` 493/0/0 |
| S6 | **4 — implemented, committed, pushed, and verified** | gate: the stages whose rows it verifies — S3/S4 for the `users` half, plus S5 for the session half. `e9d1621`; canonical: `db:verify` 499/0/0, `test:rls` 88, `test:schema` 22 |
| `OPEN-01` | **5 — unresolved** | needs accepted `ADR-004` + migration + `db:verify` |
| `OPEN-13` | **RESOLVED 2026-11-20** | `ADR-005` accepted + migration applied + session suite green |

**Two things this table exists to fix.** First: **no `IG` gate blocks S3, S4, S5, or
S6.** They are endpoint-behaviour decisions — email normalisation, duplicate
registration, auto-login, password policy, hashing parameters, rate limiting, email
verification, cookie naming, CSRF — and none of them can change a role, a grant, a
policy, or a table's shape. The owner record previously listed them in a row labelled
"blockers before `S3`"; that row is corrected in the record itself, not only here.

Second: **the ADR gates are independent.** A previous revision made acceptance of both
ADRs a prerequisite for all of S3–S6. That over-couples them: `ADR-004` is about a role
and two grants on `app.users`; `ADR-005` is about a table that does not exist until S5.
Requiring `ADR-005` before S3 means a decision about a session table can block work that
never mentions a session. The gates that follow the object being built are:

```text
ADR-004 accepted ──► S3 ──► S4 ──┐
                                  ├──► S6
ADR-005 accepted ─────────► S5 ───┘
```

This is not a relaxation. Nothing is applied without an accepted ADR covering it, S4
still cannot precede S3, and S6 still cannot precede the stages it measures. It only
stops one track's paperwork from gating the other's code.

### 13.3 Unblocked by what already exists

| Requirement | Status |
|---|---|
| `AG-1` (credential boundary) | **approved 2026-11-18** — ADR-004 is its record |
| `AG-2` (session storage) | **approved 2026-11-18** — ADR-005 is its record |
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
`maintenance` queue that would schedule the purge job, which is Phase 4 work: S8 can
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
4. After S3 **alone**, every read of an **existing** table fails `42501` — this is the
   baseline S4 is measured against — and `app.sessions` is asserted **absent**
   (`to_regclass(...) IS NULL`), never queried. A `42P01` is not a denial and must not
   be recorded as one.
5. The API boots with `APP_AUTH_DATABASE_URL`, refuses a URL naming `app_api`, and
   fails to boot in production without it — config tests plus one negative boot.
6. `AuthDatabaseModule` is written and tests prove the boundary — `AUTH_DATABASE_CLIENT`
   resolves inside it and does **not** resolve from a module importing only the global
   `DatabaseModule`; with both modules assembled, the tenant client and the auth client
   are distinct objects and each receives exactly one `$disconnect()`.
7. At S3 the client is **not** instantiated in the running application: `AppModule`
   does not import `AuthDatabaseModule`, and `createClient` is never called for
   `authDatabaseUrl` during boot. The DSN is nevertheless parsed and asserted, so a
   missing or swapped credential still fails the boot.

### S4

8. `app_auth` `SELECT` succeeds on the six granted columns and fails `42501` on
   `created_at` and `updated_at`.
9. `INSERT (email, password_hash)` succeeds; any other column fails `42501`;
   `UPDATE` and `DELETE` fail `42501`.
10. `app_api` still holds no privilege on `app.users`; `users_self_only` unchanged;
   `FORCE` still set.
11. The migration names no other table and grants nothing to `PUBLIC`.
12. 39 tenant-isolation and 12 conformance assertions pass unchanged.

### S5

13. `sessions` exists with the eight columns, all three CHECKs (expiry order, hash
    shape, absolute cap) asserted as an **exact inventory** — a missing, extra, or
    rewritten definition each fails separately — plus unique `token_hash`, two indexes,
    `ENABLE`+`FORCE`, and both policies.
14. `app_api` and `app_system` fail `42501` on all four verbs; `app_auth` has exactly
    the column privileges in §7.4 and no `DELETE`.
15. `purge_expired_sessions()` is `prosecdef`, owned by `migration_owner`, `search_path`
    pinned, executable by `app_system` only, and returns a count (0 is valid).
16. A session whose `absolute_expires_at < now()` is deleted by one call; a live row
    survives; a row expired only on `expires_at` is **not** deleted.
17. A sliding extension at day 70 of 90 lands on `absolute_expires_at`, satisfies
    `sessions_expiry_order_check`, and does not exceed the absolute deadline.
18. Updating `token_hash`, `user_id`, `created_at`, or `absolute_expires_at` as
    `app_auth` fails `42501` — the last one is what makes "a session cannot outlive its
    absolute expiration" a database property rather than a promise.
19. An insert at `created_at + INTERVAL '91 days'` fails `23514`; an insert at
    `now() + INTERVAL '90 days'` succeeds; an insert binding a JavaScript-computed
    90-day deadline fails `23514` (the §7.1 consequence, asserted). If the cap CHECK is
    ever removed, this criterion is deleted from the list rather than relaxed, and the
    gap is recorded as a limitation.

**S5 status against these criteria (2026-11-20).** 13 is asserted by `db:verify` and
`test:schema`; 14, 15, 18 and 19 by `db:verify`; 16 by the collection probes (an expired
row is deleted, a live row, a revoked row and an idle row whose *sliding* deadline has
passed all survive, and the predicate is asserted strict at `absolute_expires_at = now()`).
Criterion 17 is an S7 statement: the clamp is an expression the application will send, and
S5 asserts only that the row it produces cannot violate the CHECKs. The `91 days` half of
19 is covered by the cap CHECK's exact-definition assertion rather than by inserting a
rejected row.

### S6 and cross-cutting

20. `db:verify` green with the new rows; assertion count recorded with the exact
    number, not "more than before". Every denial is `42501`; no `42P01` appears in a
    denial log, because a missing relation would be a defect in the stage, not a pass.
21. `test/rls/auth-boundary.test.mjs` green; existing suites unchanged in count.
22. Both migrations apply to a fresh isolated volume in order.
23. No `OPEN-01`/`OPEN-13` disposition changed by the implementation. Their flip is a
    separate action requiring accepted `ADR-004`/`ADR-005` plus this evidence.
24. `pnpm build`, `typecheck`, `lint`, `test`, `prettier --check .`, `git diff --check`
    all exit 0.

**S6 status against these criteria (2026-11-20).** 20 — `db:verify` is 499 PASS / 0 FAIL /
0 SKIP, the exact count recorded in §8.5; every denial in the run is `42501`, and the log
carries no `42P01`, because existence is asserted before any probe that needs it. 21 — the
suite is green (49 cases, twice in a row, and twice concurrently against one database) and
the 39 isolation tests are unchanged, so no existing count moved. 22 — both migrations
applied in order from an empty volume (`agroclimate-s6-fresh`, port 5546, own volume,
removed afterwards). 23 — neither disposition changed *by the implementation*;
`OPEN-13` was resolved afterwards, as the separate act the ADR's Definition of Done
requires and the register now records. 24 — build, typecheck, lint, `test`,
`prettier --check .` and `git diff --check` all exit 0; the known Prisma-generation race is
handled by building `@agroclimate/database` before the root typecheck, and it did not
reproduce in that order.

---

## 15. Suggested commit boundaries

Migrations are immutable once applied, so each one ships alone and is verified before
the next.

| # | Commit | Contents | Must be green before the next |
|---|---|---|---|
| **0** | `docs(adr): record the authentication database boundary and session storage` | `ADR-004`, `ADR-005`, this plan, the owner-record gate correction | `ADR-004` accepted before commit 1; `ADR-005` accepted before commit 4. The two are independent, and no code waits on both |
| 1 | `feat(database): provision the app_auth role` | `roles.sql`, `bootstrap.mjs`, `connections.mjs`, `database.defaults.json`, `.env.example` names, `db:verify` attribute/membership rows | `db:bootstrap` + `db:verify` |
| 2 | `feat(api): hold a second, validated database credential` | `runtime-config.ts` (+fixtures), `tokens.ts`, new `auth-database.module.ts`; **`database.module.ts` untouched** | build, typecheck, api tests, module-assembly + lifecycle test |
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

1. The owner has **accepted `ADR-004`** — the only ADR gate that precedes S3 (§13.2).
   `ADR-005` is written and **accepted** (2026-11-20) as well, and gates **S5**; S3
   does not wait on it. Acceptance adds a date and an approver to the record and is the
   owner's act, not an implementer's assertion. Note what this does *not* mean: `AG-1`
   and `AG-2` are already decided (2026-11-18), so acceptance is a statement that the
   record is faithful — not a fresh architecture decision, and not a re-vote.
2. `master` is at or after `75607d8` with a clean tree, and the S2 checks are green —
   the baseline this work builds on. `ADR-005` acceptance was required before the S5
   commit, not before S3; it was given on 2026-11-20.
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
6. Any of the **three** additions in §7.3 is absent from the `sessions` migration or
   described as a database-enforced property without existing — the absolute-expiry cap
   CHECK, the `token_hash` shape CHECK, and the two supporting indexes. They are
   accepted as `D-1`–`D-3` (2026-11-20), so the defect is a missing object, not an
   unapproved one.
7. A privilege test is "fixed" by accepting a SQLSTATE other than `42501` as a denial,
   or by querying `app.sessions` before S5 and calling the `42P01` a pass. Both turn a
   missing object into false evidence.
8. `AUTH_DATABASE_CLIENT` is added to the `@Global()` `DatabaseModule`, or
   `DatabaseModule` starts exporting it. That would make the module boundary in §5.5
   decorative.
9. An implementer grants `UPDATE` on `app.users` so that Prisma's `@updatedAt` stops
   failing. The grant is the decision; the ORM is the thing to change (§6.5).

**What "done" looks like for this phase, in one sentence:** a fourth credential exists,
can read and insert exactly the credential columns it needs and exactly the session
columns it needs, cannot reach a single tenant, catalog, or weather row, cannot delete
a session, is proven to those bounds by `db:verify` and a behavioural suite running as
the real role, and `OPEN-01` stays unresolved because resolution is a separate,
evidence-gated step (`OPEN-13` met that gate on 2026-11-20 and is recorded as resolved).
