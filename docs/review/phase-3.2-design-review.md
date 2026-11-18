# Phase 3.2 — Authentication & Tenant Identity: Design Review

Status: **design review, round 2 — decision preparation.** Documentation only.
Nothing in this document was applied. No code, no migration, no role, no grant, no
policy, no configuration change exists because of it. Every SQL block is labelled
and unimplemented.

**Reconciled 2026-11-18, after implementation.** Two rows below described the S2
validation design before it was implemented: §10's `ValidationPipe` row and §18's S2
row both named a global class-validator pipe. The owner decided Zod-only validation
bound per parameter (`IG-12`, `phase-3.2-owner-decisions.md`), so both rows were
updated to name `ZodValidationPipe`. Nothing else in this review was edited, and the
rest of it still describes `master` at `bf0e593`. Note that `IG-12` was raised after
this review, so §15's eleven-gate table does not list it; its authority is
`phase-3.2-owner-decisions.md`.

**Reconciled again 2026-11-18, after the S2 remediation at `6d36741`, the details and
path hardening at `c762171`, and the shared path grammar at `38486fd`.** No row in this
review changed: its status columns (§10 "absent", §11 "proposed") describe `bf0e593` and
are still true of that commit. Three things it could not have anticipated are recorded
where they are enforced instead — the `details` trust boundary and the encoded
validation path grammar in `api-conventions.md` §3 and §12, and the readiness budget in
§12.

**Reconciled once more 2026-11-18, after `75607d8`.** That commit made the path parser
an explicit three-state machine and guarded numeric segments with the contract's own
canonical-index rule; it changed no row in this review either, and no gate. The
behaviour it settles is recorded where it is enforced — `api-conventions.md` §12 — so
this note exists only to keep the chronology complete: `bf0e593` (reviewed) →
`6d36741` → `c762171` → `38486fd` → `75607d8` (reviewed and approved for the S2 scope).
The snapshot below is still the object of this review and has not been rewritten.

**Reconciled 2026-11-18 after the plan-review remediation.** One track definition is
clarified, not changed. `ADR-004` and `ADR-005` now exist as `Proposed` records of
`AG-1`/`AG-2`, so §18's Track 2 gate reads "`AG-1`/`AG-2` approved **and** their ADRs
accepted" before S3. §18's Track 3 `IG` gates stay exactly where that row puts them —
S7 and S8 — and none of them moves into Track 2. §3.2's "PROPOSED — not applied"
status remains accurate: this note records documents, not schema.

Repository state reviewed: `master` at `bf0e593`, reviewed again at round 2. Files
inspected: the Phase 3.2 brief; `packages/database` (`bootstrap/roles.sql`,
`bootstrap.mjs`, `scripts/lib/{connections,privilege-verification}.mjs`,
`src/tenant.ts`, all three migrations, `test/{unit,rls,schema}`); `packages/contracts`;
`apps/api`; `prisma/schema.prisma`; `docs/architecture/{api-conventions,
system-architecture,database-foundation,domain-model,background-processing}.md`;
`docs/data-model/{open-decisions,ownership-and-rls,entity-catalog,tables-identity,
physical-model,indexes-and-query-patterns}.md`; `docs/adr/ADR-001..003`;
`docker-compose.yml`; `pnpm-workspace.yaml`.

**Verdict: READY FOR OWNER DECISIONS.** Two architecture gates — `OPEN-01` and
`OPEN-13` — are specified in §§16-17 as decision sheets that can be approved or
rejected as written. Eleven implementation gates are listed in §15 — the brief's ten
plus `IG-11` — and none of them changes the database boundary. Only `IG-5` and
`IG-11` gate the contract and plumbing tracks; the rest gate the endpoint that
depends on them. None is decided here. Nothing else in the brief is blocked.

### Correction of record (round 2)

The round-2 brief cites `docs/adr/ADR-002-session-and-authentication.md`. That file
does **not** exist. `docs/adr/` holds exactly three files, and the sessions decision
lives in `ADR-002-monorepo-and-backend-architecture.md` (D5). No document was
renamed or created to accommodate the citation; the review cites the real file.
`[V]` `ls docs/adr/` → `ADR-001-weather-data-provider-strategy.md`,
`ADR-002-monorepo-and-backend-architecture.md`,
`ADR-003-trusted-tenant-context.md`.

### Corrections applied in round 2 (external review)

Four defects were reported against the round-2 text and all four were reproduced
before being fixed. All four were introduced by that text, not by the design:

| # | Defect | Fix |
|---|---|---|
| 1 | `CHECK (absolute_expires_at > expires_at)` is violated by a sliding extension near the absolute deadline (day 70 of 90 → day 100) | extension clamped with `LEAST(now() + 30 d, absolute_expires_at)`; CHECK relaxed to `>=`, because for the last stretch of a session's life the sliding deadline *is* the absolute deadline |
| 2 | `RETURNS integer` with `DELETE … RETURNING 1` yields one row per deleted row; a scalar-returning SQL function allows at most one, so it errors as soon as two sessions expire together | `WITH deleted AS (DELETE … RETURNING 1) SELECT count(*)::integer FROM deleted` — the return value is now the count of rows removed by that run |
| 3 | The `sessions` ownership class was described as new in §6.1/§9/§14 and as a widened `identity` in §4.3/§18 | one answer everywhere: **widen `identity`**, do not add a sixth class whose only member is this table |
| 4 | The `OPEN-01` sheet listed `app.sessions` privileges, so an owner who approves `AG-1` and then chooses Redis would have approved a grant to a table that does not exist | `AG-1` covers `app.users` and the role only; every session privilege moved to `AG-2` (§17), and each is marked conditional on that gate |

The fourth is the one with consequences beyond wording: the two gates must be
approvable in either order, and they are now.

### Provenance legend

Every material claim is tagged.

| Tag | Means |
|---|---|
| `[V]` | verified in this repository by reading the cited file, or by executing the cited command in an earlier phase |
| `[R]` | recommendation made by this review |
| `[A]` | assumption, unmeasured — must not be treated as a completed control |

Nothing in this document is `[V]` for runtime behaviour of code that does not
exist. No `db:*` command, no `psql`, and no Redis connection was run in producing
this review.

---

## 1. Current-state findings

| # | Sev. | Finding | Evidence |
|---|---|---|---|
| F1 | Critical | `app_api` has **no** privilege on `app.users`, and the migration says why | `[V]` `20261118020000_tenant_tables/migration.sql:151-155`; grant list `:157-158` covers `farms`/`fields` only |
| F2 | Critical | `users` is `ENABLE` + `FORCE` RLS with `users_self_only`, predicate `id = NULLIF(current_setting('app.user_id', true), '')::uuid` | `[V]` same file `:107-112`; owner policy `:134-135` |
| F3 | Critical | `app.user_id` is written only by `withTenant`, transaction-local, and `withTenant` needs the user id | `[V]` `packages/database/src/tenant.ts:61-81`, `set_config(..., true)` at `:76` |
| F4 | High | `users_email_key UNIQUE (email)` is case-sensitive; no `email_normalized`, no functional or `citext` index | `[V]` `migration.sql:16-30`, unique at `:23` |
| F5 | High | No session table, no session entity, no session grants | `[V]` 22 tables in `schema.prisma`; `grep '^model'` has no `Session`; `entity-catalog.md:89` lists `sessions` as *unspecified* |
| F6 | High | `apps/api` is 4 files with no HTTP plumbing: no `ValidationPipe`, no global prefix, no exception filter, no cookie parser, no helmet, no CORS, no throttle, no config module — and **no `@agroclimate/database` dependency** | `[V]` `apps/api/src/{main.ts,app.module.ts,health/*}`; `apps/api/package.json:6-26` |
| F7 | High | No response or error envelope contract. `UNAUTHENTICATED`/`RATE_LIMITED` exist only as markdown rows | `[V]` `grep` over `packages/contracts/src` → 0 hits; `api-conventions.md:40,45`; `contracts/src/index.ts:1-6` |
| F8 | High | Redis is documented, **not present**: compose has one service (`db`), and `ioredis`/`bullmq` resolve to nothing | `[V]` `docker-compose.yml:7-9`; 0 lockfile hits; `system-architecture.md:7,42,161,233,237`, `ADR-002:56` |
| F9 | High | `ADR-002` D5 already decides "server-side sessions in Postgres, not JWT"; `api-conventions.md:195` says "server-side session table"; `open-decisions.md:272-275` calls it undecided. Three texts, two positions | `[V]` `ADR-002:48-50,89`; `api-conventions.md:195` |
| F10 | Medium | Nested-scope guard is **per client** (`activeScope.getStore() === prisma`), so a nested `withTenant` on a *different* PrismaClient passes | `[V]` `tenant.ts:69-73` |
| F11 | Medium | `docs/architecture/auth-deferred.md` is cited by the immutable Phase 2.2.3 migration comment and does not exist | `[V]` `migration.sql:151-155`; `consistency-checklist.md` §6.1 |
| F12 | Medium | `packages/config` ("env validation, typed config") and `/health/ready` ("DB + Redis") are promised and absent | `[V]` `system-architecture.md:91,233`; `ls packages/` → `contracts`, `database` |
| F13 | Medium | `api-conventions.md` contradicts itself: `:41` mandates `403 FORBIDDEN` for "authenticated, not owner"; `:197` mandates 404 for the same case | `[V]` both lines |
| F14 | Medium | `POST /v1/auth/register` is not in the conventions' endpoint list; `:150` lists login, logout, me | `[V]` `api-conventions.md:150` |
| F15 | Low | `db:verify` asserts `users: { app_api: NONE, app_system: NONE }` by table privilege; a column grant reports `false` through `has_table_privilege` | `[V]` `privilege-verification.mjs:543-557`, column precedent at `:625-635` |
| F16 | Medium | The round-2 brief cites `docs/adr/ADR-002-session-and-authentication.md`; no such file exists. The sessions decision is `ADR-002-monorepo-and-backend-architecture.md` D5 | `[V]` `ls docs/adr/` → three files, none named that |
| F17 | Medium | No rate-limiting dependency exists anywhere (`@nestjs/throttler` absent from every manifest and from the lockfile), and `main.ts` never sets `trust proxy`, so behind Caddy `req.ip` is the proxy address | `[V]` `apps/api/package.json:6-26`, `grep` over `pnpm-lock.yaml`, `main.ts:6-11` |
| F18 | Medium | `apps/api` has no test runner — its `test` script prints a string. The repository already carries two runners: `node:test` in `packages/database`, vitest in `packages/contracts` | `[V]` `apps/api/package.json:11`; `packages/contracts/package.json` `"test": "vitest run"`; `packages/database/package.json:28-30` |
| F19 | Low | `app.user_id` is an ordinary GUC: **any** role can set it, `app_auth` included. No grant is implied by that, which is the only thing that keeps it harmless | `[V]` `ADR-003:19-24,104-115`; `ownership-and-rls.md` §6 |

### 1.1 Why the brief's own premises need correcting

Three claims in the brief are contradicted by the repository. They are not
pedantry — each changes which implementation is cheap.

1. **"The architecture already includes Redis as an infrastructure component."**
   Half true, and the wrong half is load-bearing. Redis is named in
   `system-architecture.md` and `ADR-002` D7 for **job queues and provider token
   buckets**. It is not in `docker-compose.yml`, not a dependency anywhere, and it
   is **never** named as session storage. The one auth→store edge the diagrams draw
   is `AUTH --> PG` (`system-architecture.md:53`). `[V]`
2. **`OPEN-13` is undecided.** It is inconsistently decided. `ADR-002` D5 chose
   Postgres sessions and rejected JWT + refresh rotation; `api-conventions.md:195`
   specifies the table's expiry policy. Only `open-decisions.md` treats it as open.
   Recommending Redis therefore **reverses D5** and must say so — it is not filling
   a vacuum. `[V]`
3. **Session validation is a smaller problem than `OPEN-01`.** It is the same
   problem. A Postgres session row is read by `token_hash` **before** `user_id` is
   known, so it cannot be filtered by `app.user_id` either. A table duplicates
   `OPEN-01` on a second table; Redis genuinely avoids it by leaving Postgres. This
   is the strongest argument for Redis and no document states it. `[V]` + `[R]`

---

## 2. Proposed authentication architecture

Two trust contexts, one boundary, and the boundary is the point.

```
HTTP request
  │
  ├─ [auth context]  no app.user_id anywhere in this transaction
  │    AuthController → AuthService → authPrisma (app_auth)
  │                                   ├─ SELECT users(email, password_hash, …)
  │                                   └─ INSERT users(email, password_hash)
  │    Argon2id verify  →  AuthenticatedSubject { userId, role, sessionId }
  │
  └─ [tenant context]  app.user_id set only here, only from the subject
       AuthGuard attaches subject → controller → service
       withTenant(subject.userId, tx => … )      ← app_api, transaction-local GUC
                                                   tenant tables, RLS applies
```

Rules that follow, all of them already encoded in the repository's decisions:

| Rule | Why | Status |
|---|---|---|
| `app_api` keeps zero privileges on `users` | a tenant credential must not be able to read credentials | `[V]` enforced today; must **stay** enforced |
| `app_auth` is never used for tenant CRUD or ingestion | one credential, one purpose | `[R]` |
| Identity comes only from a validated session | ADR-003 D1/D4: RLS cannot distinguish a lying caller | `[V]` `ADR-003:104-115` |
| No `SET` (session-scoped) anywhere; `set_config(..., true)` only | a pooled connection would carry the next request's identity | `[V]` `ADR-003:37,53`; `api-conventions.md`/CI rule `system-architecture.md:204` |
| `app_system` never reads credentials | `BYPASSRLS` + a grant would put every hash in the ingestion credential's reach | `[V]` `ownership-and-rls.md:206` |

The `app_auth` PrismaClient is a **second client** in the same process, built by
the existing role-agnostic factory (`createPrismaClient`, `src/index.ts:36-42`) —
no new abstraction is needed. `[V]`

---

## 3. Role and privilege matrix

### 3.1 Existing roles (measured)

| Role | Attributes | Owns | Tenant tables | Catalog | Weather plane |
|---|---|---|---|---|---|
| `migration_owner` | `NOLOGIN` at SQL level (LOGIN granted by bootstrap), `NOBYPASSRLS`, `NOINHERIT` | schema `app` | R/W via `*_owner_full_access` | R/W | R/W |
| `app_api` | `NOBYPASSRLS`, `NOINHERIT` | nothing | R/W on 10, RLS-forced | `SELECT` | `SELECT` + column `INSERT(provider, model, cell_key)` on `outlook_cells` |
| `app_system` | **`BYPASSRLS`**, `NOINHERIT` | nothing | **none** | none | R/W on 6 |
| `app_api` on `users` | — | — | **none** | — | — |

`[V]` `bootstrap/roles.sql:12,22-24,28,38-41,48-50,63-64`;
`20261118020000_tenant_tables:157-158`; `20261118030000_domain_tables:272-275,
732-744, 988-991, 1266-1268`.

### 3.2 Proposed `app_auth` — **not applied**

| Object | Privilege | Columns | Rationale |
|---|---|---|---|
| schema `app` | `USAGE` only | — | no `CREATE`, mirroring `app_api` |
| `app.users` | `SELECT` | `id, email, password_hash, role, locale, timezone` | password verification needs the hash; the profile needs the rest |
| `app.users` | `INSERT` | `email, password_hash` **only** | `role`/`locale`/`timezone`/`id`/timestamps stay on column defaults, so registration cannot choose a role |
| `app.users` | `UPDATE` | none in this phase | password reset is out of scope; changing the password later needs `(password_hash)` and its own decision |
| `app.users` | `DELETE` | none | `OPEN-04` |
| `app.sessions` | `SELECT`/`INSERT`/`UPDATE` | as designed in §6 | only if the table wins `OPEN-13` |
| `app.farms`, `app.fields`, other tenant tables | none | — | the auth credential must never read tenant data |
| catalog, weather plane | none | — | no reason exists |
| functions | `EXECUTE` on one named function only | — | only if option B is chosen; default `EXECUTE` is already revoked for `migration_owner`'s functions |

Bootstrap additions (3 lines, no existing line edited): role name in the
`roles.sql:12` array; an `ALTER ROLE app_auth … NOINHERIT NOBYPASSRLS` beside
`:22-24`; `APP_AUTH_PASSWORD` in `bootstrap.mjs:30-34`; `app_auth` in
`connections.mjs:26-30`. `[V]` all four extension points exist and `[V]`
`roleConnectionString` throws `unknown role` for anything unmapped, so a missed map
entry fails fast rather than silently connecting as the wrong role.

### 3.3 Verification consequence

`db:verify`'s `EXPECTED` map gains a third key per table row; its loops derive
role names from `ROLE_NAMES`, so identity, attribute, and membership assertions
extend without new code. `[V]` `privilege-verification.mjs:157-194,543-557`.

`app_auth`'s `users` access is **column-level**, which `has_table_privilege`
reports as `false`. Assert it with `has_column_privilege`, exactly as the
`outlook_cells` column-`INSERT` check already does. `[V]` `:625-635`. Writing the
new expectations with `has_table_privilege` would pass for the wrong reason or fail
for the wrong reason — either way the suite would be lying.

---

### 3.4 Compromise blast radius — `app_auth`

What a holder of the `app_auth` DSN can and cannot do. "Permitted" means PostgreSQL
would allow it given the proposed grants and policies; "rejected" names the mechanism
that stops it. Nothing here is implemented.

The session rows assume `AG-2` selects the Postgres table (§17). Choosing Redis does
not remove them: it relocates session authority from a `GRANT` to a Redis credential,
which is why §6.1 treats Redis as an authority question rather than a performance
one.

#### Permitted

| Operation | Mechanism | Impact |
|---|---|---|
| Bulk email enumeration | `SELECT (email, …)` + `USING (true)` | the whole account list, one query |
| Bulk password-hash extraction | same | offline cracking of every hash; Argon2id parameters set the cost, so `IG-6` is a security parameter, not tuning |
| Unauthorized credential lookup for one address | same | confirmation of membership for any address, at whatever rate the API allows |
| Account creation bypassing the registration flow | `INSERT (email, password_hash)` + `WITH CHECK (true)` | a valid account with a known password, no rate limit, no email verification, no audit — the flow's controls are all in `apps/api`, and this credential does not go through it |
| Session issuance for an arbitrary `user_id` | `INSERT` on `app.sessions` | **direct impersonation.** This is the most severe permitted operation, and it is why `app_api` must never hold the same grant |
| Session revocation / un-revocation | `UPDATE (revoked_at)` | denial of service on any user; re-activating a revoked session |
| Sliding-expiry extension of any session | `UPDATE (expires_at, last_seen_at)` | keeping an otherwise-expiring session alive indefinitely within the absolute window |
| Read of session rows by `user_id` or `token_hash` | `SELECT` on `app.sessions` | token hashes and the user binding; hashes are not directly usable without a preimage |
| `set_config('app.user_id', …)` | the GUC is application-defined; every role may set it | **no privilege follows from this**, because no tenant grant exists (§4.2). Recorded so that the absence of effect is not mistaken for a control |
| Read of `pg_catalog` metadata | default `PUBLIC` access | table and column names; no data, no password hashes (`pg_authid` is superuser-only) |

#### Rejected, and by what

| Operation | Rejected by | SQLSTATE |
|---|---|---|
| `SELECT`/`INSERT`/`UPDATE`/`DELETE` on `farms`, `fields`, `field_outlook_cells`, `field_observations`, `plantings`, `harvests`, `suitability_runs`, `planting_windows`, `ai_briefings` | no grant | `42501` |
| `SELECT` on catalog tables (`crops`, `cultivars`, …) | no grant | `42501` |
| `SELECT` on the weather plane (`weather_records`, `forecast_runs`, …) | no grant | `42501` |
| `UPDATE`/`DELETE` on `app.users` | no grant — `UPDATE`/`DELETE` are not in the matrix, deliberately | `42501` |
| Change a user's `role` to `admin` | `role` is not in the `INSERT` grant and there is no `UPDATE` grant | `42501` |
| Create a user with a chosen `id` or timestamps | those columns are not in the `INSERT` grant; defaults apply | `42501` |
| `SET ROLE app_api` / `SET ROLE app_system` / `SET ROLE migration_owner` | `NOINHERIT` plus zero memberships in either direction, measured for the existing three roles | `42501` |
| `CREATE TABLE` / `CREATE SCHEMA` / `ALTER` an existing object | no `CREATE` on schema `app`; not the owner | `42501` |
| `CREATE ROLE` / `ALTER ROLE` | `NOCREATEROLE`, `NOSUPERUSER` | `42501` |
| Read credentials belonging to another *deployment* | out of scope — same cluster | — |

The three defences that actually bound this credential are, in order: **the grant
list** (what objects), **`FORCE` RLS** (what rows, and it is what makes an accidental
future grant return zero rows rather than everything), and **separate secrets**. The
dedication of the role is not itself a defence; it is what makes the first two
describable.

Two consequences that are easy to miss: a compromise of `app_auth` **is** an account
takeover path even if the credential table is never read, because it can mint a
session for any `user_id`; and it can create accounts the application never saw,
which no `app_api`-level check can detect.

## 4. RLS policy analysis for the authentication path

Current state: `users_self_only FOR ALL TO app_api USING (id = …) WITH CHECK
(id = …)`, plus `users_owner_full_access`. `[V]`

**Why `FORCE` matters here.** Without `FORCE`, `migration_owner` — the table owner
— bypasses its own policies, and the migration connection would read every tenant.
`FORCE` is what makes the owner's exemption an explicit policy rather than an
implicit privilege. `[V]` `migration.sql:95-108`.

**The consequence for auth.** `FORCE` means a new role has no access at all until
a policy names it. `USAGE` plus a column grant is not enough; without a policy the
role reads zero rows and inserts nothing. That is correct behaviour and it is what
makes the omission visible.

### 4.1 Proposed policies — **not applied**

```sql
-- new migration, additive; users is empty, so no rewrite, no CONCURRENTLY
CREATE POLICY users_auth_lookup ON app.users
  FOR SELECT TO app_auth
  USING (true);

CREATE POLICY users_auth_register ON app.users
  FOR INSERT TO app_auth
  WITH CHECK (true);
```

| Question | Answer |
|---|---|
| Why `USING (true)`? | Because there is no predicate available. `app.user_id` is unset by definition on this path; any predicate referencing it denies every row. |
| Does it weaken the existing policy? | No. `users_self_only` stays, unchanged. Policies are permissive and additive; removing the existing one because the grant is absent would turn the next accidental grant into a privilege escalation — the exact failure `ownership-and-rls.md:151-156` warns about. |
| What bounds registration? | The **column grant**, not the policy. `INSERT (email, password_hash)` cannot set `role`, so a registration cannot mint an `admin`; the unique index bounds duplicates; `users_email_shape_check` bounds shape. |
| Does `app_api` gain anything? | No. It is not named in either policy and holds no grant. |
| What does `app_system` see? | Nothing. `BYPASSRLS` is irrelevant without a grant, and it has none. |

### 4.2 Credential enumeration — the honest limit

`GRANT SELECT (email, password_hash)` + `USING (true)` allows **every** row to be
read with `SELECT email, password_hash FROM app.users`. Column grants bound *which
columns*, not *which rows*. RLS bounds rows only through a predicate, and no
predicate exists before identity.

Two shapes are therefore available, and the choice between them **is** `OPEN-01`:

| Shape | What a leaked `app_auth` DSN can do |
|---|---|
| Bulk read (option A) | one query returns every email and hash |
| One row per call (option B) | any single row, repeatedly — same information under iteration |

There is no third shape that prevents enumeration while answering "find the user
with this email", because the lookup **is** the enumeration. Any claim otherwise
is false and must not appear in the ADR.

One more consequence, easy to design around by accident: **Argon2id is not
available in core PostgreSQL** — there is no `pgcrypto` equivalent. Password
verification must run in Node, so the hash must leave the database under every
option, including a `SECURITY DEFINER` one. A "hash never leaves Postgres" design
is not available here. `[V]` (PostgreSQL 18.6 core feature set) + `[R]`

---

### 4.3 Session table privileges and RLS — per role, per operation

Session privileges below exist **only if `AG-2` selects the table** (§17). If Redis
wins, `app_auth` holds no `sessions` privilege because there is no table to hold it
— and the impersonation risk does not disappear, it moves to whoever can write the
store. Proposed table, **not created**:

```sql
-- PROPOSED — NOT APPLIED
CREATE TABLE app.sessions (
  id                  uuid        PRIMARY KEY DEFAULT uuidv7(),
  user_id             uuid        NOT NULL REFERENCES app.users (id),
  token_hash          text        NOT NULL UNIQUE,
  expires_at          timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at          timestamptz,
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  -- `>=`, not `>`: a sliding extension is clamped to the absolute deadline, so
  -- the two timestamps legitimately coincide at the end of a session's life.
  CONSTRAINT sessions_expiry_order_check
    CHECK (absolute_expires_at >= expires_at AND expires_at > created_at)
);

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
-- no DELETE grant to any runtime role
```

| Operation | `migration_owner` | `app_auth` | `app_api` | `app_system` | Mechanism |
|---|---|---|---|---|---|
| Create session | yes — owner policy | **yes** — column `INSERT` | **no** `42501` | **no** `42501` | grant |
| Read by `token_hash` | yes | **yes** — column `SELECT` | no | no | grant + `USING (true)` |
| Read by `user_id` | yes | **yes** | no | no | grant |
| Extend sliding expiry | yes | **yes** — `UPDATE (expires_at, last_seen_at)` | no | no | column `UPDATE` |
| Revoke one session | yes | **yes** — `UPDATE (revoked_at)` | no | no | column `UPDATE` |
| Revoke all sessions for a user | yes | **yes** — same grant, `WHERE user_id = $1` | no | no | column `UPDATE` |
| Delete expired rows (GC) | yes | **not granted** | no | **`EXECUTE` only** on one function | `SECURITY DEFINER` function, owned by `migration_owner`, `EXECUTE` to `app_system` alone |
| `SELECT` any row without a tenant context | yes | **yes** — by design | no | no | `USING (true)` |

**Sliding extension must be clamped.** Extending `expires_at` to
`now() + 30 d` on its own breaks the constraint once a session nears its absolute
deadline — at day 70 of a 90-day session, the extension would land at day 100. The
extension is therefore:

```sql
-- PROPOSED — NOT APPLIED. Run by the application, once per 5 min per session.
UPDATE app.sessions
   SET expires_at   = LEAST(now() + interval '30 days', absolute_expires_at),
       last_seen_at = now()
 WHERE id = $1 AND revoked_at IS NULL;
```

`LEAST` is what keeps the invariant true without a trigger, and it is why the
constraint is `>=`: for the last stretch of a session's life, the sliding deadline
*is* the absolute deadline, and validation must reject on either. A trigger-based
extension would move this rule into the database at the cost of an invisible write
path; the application-side form is visible in one statement. `[R]`

Column-level `UPDATE` is the mechanism that satisfies requirement 6: an expiry
extension cannot touch `user_id`, `token_hash`, or `created_at`, because those
columns are not in the `UPDATE` grant. It does **not** distinguish "set `revoked_at`"
from "clear `revoked_at`" — grants cannot express direction. Residual risk, stated:
`app_auth` can un-revoke a session it previously revoked. A trigger or a separate
revocation function could close that; neither is proposed here, and pretending the
column grant does it would be false.

GC without granting tenant-wide access (requirement 7): `app_system` receives no
table privilege at all. It receives `EXECUTE` on

```sql
-- PROPOSED — NOT APPLIED
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
-- then: REVOKE ALL ON FUNCTION app.purge_expired_sessions() FROM PUBLIC;
--       GRANT EXECUTE ON FUNCTION app.purge_expired_sessions() TO app_system;

```

The return value is the **number of rows deleted by this run**, not a success
flag — the `WITH deleted … count(*)` form is what makes that true. The naive
`DELETE … RETURNING 1` returns one row per deleted row, and a scalar-returning SQL
function permits at most one result row — so it errors as soon as two sessions
expire in the same run, which is the normal case.

Three different questions, and the count answers only the first:

| Question | Answered by | What a value means |
|---|---|---|
| **Deletion count** — how many expired sessions did this run remove? | the function's return value | `0` is a legitimate outcome: no session reached its absolute deadline since the last run. It is **not** evidence of a broken sweep, and a run that deletes nothing is indistinguishable from a run that never happened *on this signal alone* |
| **Job execution health** — did the maintenance job run and complete? | the queue's job record (`background-processing.md:19`), not this function | a missing or failed job is visible there; the SQL function cannot report its own absence |
| **Operational health** — is the sweep keeping up? | last successful execution time, status, duration, error count, and a trend of the count over many runs | a count that stays `0` while `last_seen_at` keeps advancing is normal; a count that stays `0` while no job has succeeded is the alarm. The two facts must be read together |

No monitoring implementation is proposed: the existing `maintenance` queue already
records execution. The point is only that `0` deleted rows and `0` successful runs
are different observations, and treating the first as the second produces false
alarms on a young deployment.

This is the **only** place a `SECURITY DEFINER` object is proposed, and it touches
no credentials and no tenant row. `ADR-003` A1 rejected a definer-based tenant
validator on measurement grounds; that rejection does not transfer to a function
whose surface is "delete rows nobody can use any more".

`ENABLE` + `FORCE` on `sessions` mirrors `users`, for the reason `ownership-and-rls.md`
§3 gives: if a future grant to `app_api` is added by mistake, the absence of a policy
naming `app_api` returns zero rows instead of the table. Without `FORCE`, the owner
would silently bypass the same policy.

**Ownership class.** `entity-catalog.md` declares five classes (`identity`, `tenant`,
`tenant-derived`, `reference`, `global`). A session row is not described by any of
them cleanly: it belongs to a user but is read **before** identity is established, so
`tenant` fails; it is not global provider data, not a catalog entry, not a computed
artifact. Two candidates:

| Option | Cost | Verdict |
|---|---|---|
| Widen `identity` from "the tenant itself; one row per account" to "the account and its authentication state" | one sentence in one document; no new concept | **recommended** — `users` already establishes that `identity`-class rows are read on the pre-identity path, so the class already carries the right precedent |
| Add a sixth class `auth` | a new class whose membership is exactly one table; the vocabulary then has a category with no second member | not recommended |

## 5. Dedicated role vs `SECURITY DEFINER` — four alternatives

Round 1 compared "role" against "function". That collapsed two different functions
into one option and left the real question unpriced: **who is allowed to call the
credential read?** The four shapes below are genuinely distinct.

| | A — role + columns | B1 — definer, callable by `app_api` | B2 — definer, callable only by `app_auth` | C — separate identity context |
|---|---|---|---|---|
| **Shape** | `app_auth` reads `users` directly under column grants and its own policies | `app.lookup_credentials(email)` owned by `migration_owner`, `EXECUTE` to `app_api` | same function, owned by `migration_owner`, `EXECUTE` to `app_auth` only | a second GUC or signed attestation that a downstream role trusts |
| **Credential exposure** | bulk: every email and hash in one query | one row per call, but **the tenant credential holds the capability** | one row per call; capability stays outside `app_api` | changes nothing — it attests *identity*, it does not read a credential |
| **Session authority** | `app_auth` issues/revokes — only if `AG-2` selects the table (§4.3); with Redis it holds no DB session privilege | unchanged; `app_api` still cannot touch sessions | unchanged | not addressed |
| **DB privilege complexity** | 2 column grants + 2 policies on `users`; the shape `db:verify` already models | 1 function + 1 `REVOKE` + 1 `GRANT`, no policies on `users` | same as B1 plus the fourth role | plus a second trust level for one variable |
| **RLS implications** | `USING (true)` on `users`, `FORCE` retained | policies untouched; the function bypasses RLS **as owner** | same | the whole point is to avoid RLS deciding identity — `ADR-003` D1/D3 territory |
| **Function ownership** | n/a | `migration_owner` — non-login, `NOBYPASSRLS`, owns the schema; a definer function executes with **its** privileges | same | n/a |
| **`search_path` safety** | n/a | must pin `SET search_path = pg_catalog, app` and schema-qualify every reference; without it a definer function is a privilege-escalation primitive | same | n/a |
| **SQL injection impact** | parameterised queries only; a `$queryRawUnsafe` would be a credential dump | injection inside the function body would run as owner; the function must take no SQL text and build none | same | a forged context needs no injection at all |
| **Operational complexity** | fourth DSN + fourth secret, same shape as the three that exist | no new secret; one more object to review | fourth DSN **and** a function | new attestation key and rotation |
| **Bootstrap / secrets** | `roles.sql:12,22-24`, `bootstrap.mjs:30-34`, `connections.mjs:26-30` | none | same as A | new secret |
| **Testing** | extend `db:verify` `EXPECTED` + column-privilege probes; new `auth-boundary` suite | function behaviour tests + `EXECUTE` deny for third roles | same as A **and** B1 | context-forgery tests, which is exactly what `ADR-003` measured as unenforceable |
| **Migration / rollback** | additive grants + 2 policies; rollback = `DROP POLICY`, `REVOKE` | function + `REVOKE`; rollback needs `DROP FUNCTION` **and** any dependent grant | same | additive, but the trust change is behavioural |
| **Effect on `app_api`** | none | **hands the tenant credential a credential read it can never lose** | none | none |

### 5.1 `SECURITY DEFINER` specifics, evaluated

- **Fixed `search_path`.** Mandatory, not optional. `SET search_path = pg_catalog,
  app` plus fully-qualified names, or the function resolves `users` through whatever
  the caller's path happens to be. `[R]`
- **Restricted `EXECUTE`.** `REVOKE ALL … FROM PUBLIC` first — PostgreSQL grants
  `EXECUTE` to `PUBLIC` on new functions by default, and the repository already
  revokes that class of default for `migration_owner`'s functions
  (`roles.sql:63-64`). `[V]`
- **Ownership.** `migration_owner`, which is `NOLOGIN` at the SQL level and
  `NOBYPASSRLS`; it is already the owner of every object in `app`. `[V]`
- **Can callers supply arbitrary identifiers?** They supply an email, which *is* an
  arbitrary identifier. The function cannot distinguish "the caller is allowed to
  ask" from "the caller is enumerating".
- **Does it expose the hash?** It must, because Argon2id verification runs in Node
  (§4.2). Any design that keeps the hash inside Postgres is not available.
- **Does it prevent enumeration?** No. One row per call is enumeration with extra
  steps. Claiming otherwise would be the exact overclaim this review exists to avoid.
- **New escalation path?** Only if `search_path` is unpinned or `EXECUTE` is left on
  `PUBLIC`. With both pinned, the escalation surface is the function body.

### 5.2 Option C — why it is not an alternative for `OPEN-01`

C is not a credential-read mechanism. It is an *attestation* mechanism: it makes the
database believe a tenant claim that some other component signed. It cannot answer
"which row has this email", so it cannot resolve `OPEN-01` at all. It is `OPEN-28`
material, and `ADR-003` D3 already requires its own ADR, because "two variables with
different trust levels is how a boundary becomes a suggestion". A second custom GUC
set by a privileged role does not help either: any role may set any GUC (`F19`) — the
signature, not the variable, would be the control.

### 5.3 Recommendation

**A stays the provisional recommendation.** B1 is rejected: it moves the credential
read into the tenant application's trust boundary permanently, which is the one
property the fourth credential exists to prevent. B2 is the **tightening path** — if
the accepted threat model later forbids bulk read, A is upgraded by removing its
`SELECT` grant and replacing it with `EXECUTE` on one function; that change is
additive and does not invalidate the role. C is deferred to `OPEN-28` and is not a
solution to `OPEN-01`.

```
Recommendation: A  (provisional, pending owner approval)
Tightening path: A + B2, if bulk read becomes unacceptable
Rejected for OPEN-01: B1 (hands app_api the capability), C (wrong problem)
```

Residual risks that travel with A, to be written into ADR-004 rather than mitigated
on paper: bulk credential read; account creation that bypasses application controls;
session issuance for any user id; un-revocation.

## 6. Session storage: recommendation and threat model

### 6.1 Recommendation

**Postgres table**, consistent with `ADR-002` D5 and `api-conventions.md:195`.
Reasons, in order of weight:

1. The session store is an **authentication authority** — whoever can write it can
   be anyone. Postgres already has three roles, `NOINHERIT`, exactly one
   `BYPASSRLS`, and every grant measured by `db:verify`. Redis, as normally
   deployed, is an unauthenticated network service. `[R]`
2. Two documents already decide it. Choosing Redis requires amending `ADR-002` D5
   in the same change, or the repository holds two contradictory accepted
   decisions. `[V]`
3. It avoids adding a service that does not exist in `docker-compose.yml`, in a
   phase whose entire value is a boundary that can be verified. `[V]`
4. Session authority stays inside the backup, restore, and audit story that already
   exists. `[R]`

Costs that must be stated, not hidden: one more table (a 23rd entity, requiring
`entity-catalog.md` to widen its **`identity` class** — a session row is read before
its owner is known, so it cannot be a `tenant` row, and widening one class is
cheaper than adding a sixth whose only member would be this table, §4.3);
one database round-trip per authenticated request; a GC job in the `maintenance`
queue (`background-processing.md:19`), which does not exist yet. `[V]`

If the owner prefers Redis: it is defensible, it dodges the pre-identity read, and
TTL/revocation are cheaper. It then needs a compose service, a password/TLS
posture, and the D5 amendment — and the failure policy in §6.3 is unchanged.

### 6.2 Threat model

| # | Asset / threat | Control | Residual |
|---|---|---|---|
| 1 | XSS reads the cookie | `HttpOnly`, `Secure`, `SameSite=Lax` | XSS can still act as the user through the browser |
| 2 | Raw token in logs | never log token or hash; log `sessionId` only | accidental header dumps |
| 3 | Token in a DB backup | store `sha256(token)` only; the raw token exists only in the cookie | a 256-bit random preimage is not brute-forceable — SHA-256 is correct here, and is **not** the password path |
| 4 | Session fixation | rotate on login; never reuse a pre-auth id | — |
| 5 | CSRF | double-submit token on non-GET + `SameSite=Lax` | `Lax` already blocks most; keep both, decide once |
| 6 | Brute force, one account, many IPs | per-IP throttle does not cover it; Argon2id cost raises the price; generic errors | **no per-account control exists** — see `IG-7` |
| 7 | Account enumeration by response | identical status, code, and body; verify a dummy hash when the user is absent | timing still leaks if the dummy path is skipped |
| 8 | Session store compromise (Redis option) | loopback bind, `requirepass`, TLS off-host, no `FLUSHALL` exposure | accepted, recorded |
| 9 | Forged session by `app_api` credential holder | `app_api` holds **no** grant on `sessions` | a DB superuser is out of scope by definition |
| 10 | Stale sessions after a password change | revoke all sessions on password change | password change is out of scope; the hole is recorded, not closed |
| 11 | Session token reused after logout | revocation row + validation check | must be tested, including reuse of the old cookie |

`[R]` for controls 1–7, 9–11; `[V]` for 8 as a property of Redis, not of this repo.

### 6.3 Outage policy — fail closed, and say what closed means

| Situation | Required | Forbidden |
|---|---|---|
| Store unreachable on `GET /v1/auth/me` | `503` after a bounded timeout (≤100 ms) and one retry | treating the request as anonymous, or trusting a client-supplied id |
| Store unreachable on login | `503` — cannot issue, so cannot claim success | returning a cookie nothing can validate later |
| Store unreachable on logout | `503` | `204`; a claimed revocation that did not happen is the only failure that stays silent |
| Store restarted / evicted | every session invalid; re-authentication | a "fallback" that trusts another authority — that is a second authority, not a fallback |
| Store fails mid-request after validation | request proceeds on the validated subject | re-validating mid-request |

`ADR-002:54` states the principle for the analogous case — Redis eviction must
never change what a farmer was told. The same sentence governs identity. `[V]`

---

## 7. Authentication lifecycle

Ordering is the security content. Each step names the transaction it runs in.

### 7.1 Register — `POST /v1/auth/register`

1. Body parsed; `registerRequestSchema` rejects unknown keys (mass assignment). In
   the **auth context**; no tenant transaction is opened at any point.
2. Email normalised: `trim()` then `toLowerCase()`. **Application invariant only** —
   `users_email_key` is case-sensitive, so this is not enforced by the database
   (`IG-1`).
3. Password policy applied against the *plaintext*, before hashing; length is
   counted in bytes for the KDF input cap (`[R]`; `IG-4` for the policy, `IG-6` for the
   parameters).
4. `argon2id` hash computed — parameters from config, never inlined twice.
5. `INSERT INTO app.users (email, password_hash)` as `app_auth`, `ON CONFLICT
   (email) DO NOTHING` so a duplicate is a decision, not an exception path.
6. Duplicate → `409` with code `CONFLICT` (discloses existence; `IG-2` and §10).
7. Session created and cookie set — or registration and login stay separate. **This
   is a product decision** (`IG-3`). The brief returns only a safe user
   representation, which implies no session; the default is therefore *no* session.
8. Response contains `{ id, email, role, locale, timezone, createdAt }` and never
   `password_hash`, never the raw token.

### 7.2 Login — `POST /v1/auth/login`

Round 1 of this review listed rate limiting as step 6 while asserting it must run
before the lookup. That was an ordering defect, not a wording defect: a limiter that
runs after `argon2.verify` pays the full KDF cost on every rejected attempt, which
hands an attacker the exact amplifier the limiter exists to deny. The sequence below
is the corrected one, and the numbering is the implementation order.

1. **Validate** the body with `loginRequestSchema`; unknown keys are rejected
   (`forbidNonWhitelisted`), so no field can smuggle a role or an id.
2. **Normalise** the email with the single shared function used by registration. Two
   copies of this logic is how one endpoint starts accepting variants the other
   rejects.
3. **Apply rate limiting** — see §7.2.1 for what exists in v1, what is deferred, and
   what happens when the limiter's store is unavailable.
4. **Reject over-limit** with `429 RATE_LIMITED` and `Retry-After`, before any
   database round-trip and before any hashing.
5. **Look up** `SELECT id, email, password_hash, role FROM app.users WHERE email = $1`
   as `app_auth`, in the auth context. No `app.user_id` exists in this transaction;
   a test asserts it is `NULL`.
6. **User absent** → verify the supplied password against a fixed dummy hash of the
   same cost parameters, discard the result, fail. Skipping this is what converts
   "unknown user" into a timing oracle.
7. **User present** → `argon2.verify(stored, supplied)`.
8. **Fail identically** for steps 6 and 7: same status, same code, same body, no
   `details` that differ.
9. **Create the session** — `token` from 32 CSPRNG bytes, base64url; persist only
   `sha256(token)`; `expires_at = now() + 30 d`, `absolute_expires_at = now() + 90 d`;
   `last_seen_at = now()`.
10. **Set the cookie and return** the safe user representation. The raw token never
    appears in the response body, and `password_hash` never appears anywhere.

Two negative properties are as important as the steps: no session row is created
until step 9 succeeds, and no tenant transaction is opened anywhere in this handler.

#### 7.2.1 Rate limiting — what v1 actually has, and what it does not

| Question | Answer | Status |
|---|---|---|
| Controls in v1 | a single per-IP token bucket on `POST /v1/auth/login` and `POST /v1/auth/register`, plus the Argon2id cost as the only per-account brake | **proposed** — no limiter dependency exists in the repository today (F17) |
| Per-IP, per-account, or both | **per-IP in v1.** Per-account is *specified* here and *deferred* (`IG-7`): it requires a store that survives process restarts and replication, and no such store is approved | per-IP proposed; per-account deferred |
| Added dependency | yes — `@nestjs/throttler` (or an equivalent) is a new dependency, which the repository's dependency rule requires to be justified rather than assumed. Its default store is **in-process**, so N replicas behind Caddy enforce roughly N× the configured limit | **must be approved** |
| Limiter store unavailable | in-process store: nothing to be unavailable, and the limiter cannot fail open because it is local state. If a shared store is later introduced (Redis), the policy is §6.3: fail closed, `503`, never "allow because the limiter is down" | design rule |
| Trust proxy | `app.set('trust proxy', 1)` is required or `req.ip` is Caddy's address and every user shares one bucket | **proposed**; absent today |
| What remains absent with per-account deferred | distributed credential stuffing against one account (one attempt per IP across many IPs); account lockout; any delay that escalates across attempts. The only remaining brake is Argon2id cost per attempt, which is real but linear and parallelisable | **deferred, stated** |

`api-conventions.md:202` already specifies "30 req/min/IP" for public/auth
endpoints and `:205` the `RateLimit-*` headers. The convention exists; the mechanism
does not. This review must not be read as claiming otherwise.

### 7.3 Current session — `GET /v1/auth/me`

1. Cookie parsed; absent → `401 UNAUTHENTICATED`.
2. `SELECT … FROM app.sessions WHERE token_hash = $1` as `app_auth`; missing,
   `expires_at <= now()`, `absolute_expires_at <= now()`, or `revoked_at IS NOT
   NULL` → `401`, identical body.
3. Sliding expiry: extend at most once per 5 minutes per session (`[R]` — a write on
   every request is write amplification for no security gain), clamped to the
   absolute deadline: `expires_at = LEAST(now() + 30 d, absolute_expires_at)`.
   Without the clamp the extension violates `sessions_expiry_order_check` near the
   end of a session's life.
4. Load the subject and return the profile — no tenant transaction needed for the
   profile itself. Any request that touches tenant data then enters `withTenant`.

### 7.4 Logout — `POST /v1/auth/logout`

1. Validate the session; if it is already invalid, `204` (idempotent, nothing to
   revoke).
2. Set `revoked_at = now()` (or delete the key) as `app_auth`.
3. Clear the cookie with the same attributes it was set with.
4. Old cookie replayed → `401`; this is a test, not a hope.

**Cross-cutting rule:** none of §7.1–7.3 opens a tenant transaction. The first
`withTenant` call in a request happens after the subject exists, and a test asserts
`current_setting('app.user_id', true)` is `NULL` inside the auth transaction.

---

## 8. Tenant context integration

| Rule | Enforced by | Test |
|---|---|---|
| Identity comes only from the validated subject | `AuthGuard` + `@CurrentUser()`; controllers never read `body.userId` | request with a foreign `userId` in body/query changes nothing |
| Tenant work runs only inside `withTenant` | code review + the guard pattern; `withTenant` is the only writer of `app.user_id` | `app.user_id` NULL outside the callback |
| No session-scoped `SET` | existing rule: `grep -n "SET app\."` must return nothing | grep in CI, already documented |
| No nested scopes | `AsyncLocalStorage` guard | unit test — **extend for a second client** (F10) |
| Transaction client not reused after close | callback-scoped `tx` only | existing unit test |
| 404 not 403 for another user's resource | controller boundary, mirrored by RLS | existing RLS suite covers the DB half |

**What RLS does not do here**, restated because the brief requires it and because
it is the most likely thing to be overclaimed in a status document: RLS protects
against code that **forgets** a filter. It does not protect against code that
**lies** (a `userId` taken from the request), against arbitrary SQL executed with
`app_api` credentials, or against a leaked `app_api` DSN. Those are ADR-003 rows 5,
7, and 8, all answered "no" — and authentication does not change any of them.
`[V]` `ADR-003:104-115,117-120`

---

## 9. Migration impact

| # | Change | Kind | Applied migration touched | Data rewrite |
|---|---|---|---|---|
| 1 | `roles.sql`: role + attributes | bootstrap (superuser, idempotent, outside the ledger) | no | none |
| 2 | `20261118040000_auth_boundary`: 2 policies + 2 column grants on `users` | new file, additive | no | none |
| 3 | `20261118040001_sessions`: table, indexes, policies, grants | new file, additive | no | none |
| 4 | `connections.mjs` role map, `bootstrap.mjs` secret map | code | no | none |
| 5 | `.env.example`: `APP_AUTH_PASSWORD`, `APP_AUTH_DATABASE_URL` | config | no | none |
| 6 | `privilege-verification.mjs`: `EXPECTED` + column probes | harness | no | none |
| 7 | `schema.prisma`: `Session` model (representation only) | Prisma | no | none |
| 8 | `entity-catalog.md`, `tables-identity.md`, `physical-model.md`, `open-decisions.md`: 23rd table, new class, dispositions | docs | no | none |
| 9 | `lower(email)` unique index — **only if `IG-1` approves** | new file, additive | no | none (`users` is empty) |

Mechanics that constrain the SQL, all `[V]`:

- `prisma migrate deploy` runs each file in **one transaction** → no
  `CREATE INDEX CONCURRENTLY`; unnecessary here because every table is empty.
- The migration connection's `search_path` is `app`; any `public.*` object must be
  qualified. `CREATE POLICY` needs no qualification.
- Role must exist **before** the migration that names it, or `CREATE POLICY … TO
  app_auth` fails `42704`. `db:bootstrap` before `db:migrate`, already the documented
  order.
- Nothing alters a column, so `users` is not rewritten and no `db pull` drift is
  introduced.
- Rollback is `DROP POLICY`, `REVOKE`, `DROP TABLE sessions` — all additive, in the
  reverse order of creation.

**Session table shape** (proposed, decision pending): `id`, `user_id → users(id)`,
`token_hash text UNIQUE`, `expires_at`, `absolute_expires_at`, `revoked_at`,
`created_at`, `last_seen_at`. Indexes: unique on `token_hash`; `(user_id) WHERE
revoked_at IS NULL` for revoke-all; `(absolute_expires_at)` for the GC sweep. No
`updated_at` trigger — the model has none and `OPEN-19` is still open. `[V]`
`open-decisions.md` §3

---

## 10. API contract changes

Needed before any endpoint can be written, because none of it exists (`[V]` F6/F7):

| Artefact | Status today | Proposed |
|---|---|---|
| response envelope `{ data, meta? }` | absent | `envelopeSchema` + a `data`-only single-resource variant |
| error envelope `{ error: { code, message, details?, requestId } }` | absent | `errorResponseSchema`; `requestId` generated by a middleware that does not exist |
| error codes | prose rows only | a Zod enum seeded from `api-conventions.md:37-47`. Auth needs `VALIDATION_FAILED`, `UNAUTHENTICATED`, `CONFLICT`, `RATE_LIMITED`, and one for store outage (`IG-5`) |
| `registerRequestSchema` / `loginRequestSchema` | absent | email (trim, lowercase, ≤254), password (policy per `IG-4`) |
| `authenticatedUserSchema` | absent | `{ id, email, role, locale, timezone, createdAt }` — never `passwordHash` |
| global prefix `/v1` | absent | `app.setGlobalPrefix("v1")`, with `health` exempt as `api-conventions.md:183` already implies |
| Zod request validation | absent | `ZodValidationPipe(schema)` bound per controller parameter; strict objects reject unknown keys — this is the mass-assignment control. No global pipe (`IG-12`) |
| exception filter | absent | maps `ZodError`→400, `23505`→409, `TenantContextError`→500, store outage→503 |
| cookies / CSRF | absent | `cookie-parser`; double-submit token per `api-conventions.md:196`, details currently unspecified (`IG-8`, `IG-9`) |
| OpenAPI | promised, absent | `api-conventions.md:3,211-215` and `ADR-002` D4 promise generation from Zod. Adding auth without a generator breaks that promise a second time; at minimum the new schemas must be generator-ready and the gap re-recorded |
| `POST /v1/auth/register` | not in conventions | amend `api-conventions.md:150` in the same change |

The api-conventions 403/404 contradiction (F13) should be fixed while the auth
error table is being written — auth is the first feature that will hit it.

---

## 11. Security risks and mitigations

Columns are the ones the round-2 brief requires. **Status** is the honest axis:
`implemented` means measured in this repository today; `proposed` means specified
here and not applied; `deferred` means consciously not in v1. No row is marked
implemented on the strength of a design document.

| # | Threat | Required privilege | Attack impact | Existing mitigation | Residual risk | Status |
|---|---|---|---|---|---|---|
| R1 | `app_auth` DSN leaks — bulk credential read | `SELECT (email, password_hash)` + `USING (true)` | every email and hash; offline cracking bounded only by Argon2id cost | separate credential, column grants, fourth secret | bulk read is inherent to the lookup (§4.2) | proposed |
| R2 | `app_auth` mints a session for an arbitrary `user_id` (Postgres sessions only; with Redis the equivalent is write access to the store) | `INSERT` on `sessions` | **direct impersonation of any account** | none beyond the credential being separate from `app_api` | highest-severity permitted operation; a stolen auth DSN is account takeover without reading the credential table | proposed |
| R3 | `app_auth` creates accounts bypassing the flow | `INSERT (email, password_hash)` | valid account, no rate limit, no verification, no audit | column grant excludes `role` so no admin can be minted | flow-level controls live in `apps/api` and are bypassed entirely | proposed |
| R4 | `app_auth` revokes, un-revokes, or extends any session | `UPDATE (revoked_at, expires_at, last_seen_at)` | targeted denial of service; keeping a session alive | grant is column-scoped | direction is not expressible in a grant — un-revocation stays possible | proposed |
| R5 | `app_auth` sets `app.user_id` and reads tenant tables | `set_config` (any role) | none — no tenant grant exists | grant boundary; `FORCE` RLS | none today; the property must be re-verified whenever a grant is added | proposed — trivially true today because the role does not exist; must be measured after S3, not assumed |
| R6 | `app_auth` escalates via `SET ROLE` | none | reading tenant data as `app_api` | `NOINHERIT`, zero memberships, measured for the existing three roles | must be measured for the fourth | proposed |
| R7 | `app_auth` runs DDL or creates a role | `CREATE` on schema / `CREATEROLE` | schema takeover | no schema `CREATE`; `NOCREATEROLE NOSUPERUSER` | — | proposed |
| R8 | `app_api` reads `users` or `sessions` | `SELECT` | credential or session enumeration from the tenant credential | no grant on `users` today; **must be extended to `sessions`** | a future grant returns zero rows thanks to `FORCE` + no policy naming `app_api` | users: **implemented** (measured: no grant); sessions: proposed |
| R9 | Session store outage treated as "no auth needed" | none (logic) | total authentication bypass | §6.3 fail-closed table | — | proposed |
| R10 | Stolen cookie replayed | the cookie | one user's session until expiry or logout | `HttpOnly`, `Secure`, `SameSite=Lax`, rotation on login | XSS acts as the user regardless | proposed |
| R11 | Credential stuffing against one account | none | account takeover by volume | per-IP limit + Argon2id cost | **per-account control deferred** (`IG-7`); distributed attacks are unmitigated | proposed / deferred |
| R12 | Account enumeration by response or timing | none | account list validation | identical failure body; dummy-hash verification | duplicate-registration `409` still discloses (`IG-2`) | proposed |
| R13 | Leaked `app_api` DSN reads every tenant | `app_api` credential | full cross-tenant read | **none** | accepted for v1 (`ADR-003` D4); `OPEN-28` is the upgrade path | deferred (`OPEN-28`) |
| R14 | GC deletes rows it should not | `EXECUTE` on the purge function | session loss (availability), not disclosure | function predicate is `absolute_expires_at < now()` only; no parameter | a bug in the function is a global logout | proposed |
| R15 | Docs claim a control that is not implemented | none | false assurance | this review tags every claim; §19 requires evidence | process risk, not technical | — |

## 12. Test plan

Four statuses, and they are not interchangeable.

| Tag | Means |
|---|---|
| **EXISTING** | runs today; the count is measured |
| **PROPOSED** | specified here; the code does not exist |
| **NEEDS-INFRA** | also needs an artefact that does not exist yet (Redis, a test runner in `apps/api`, a second Prisma client) |
| **BLOCKED** | cannot be written until an architecture gate is approved |

Nothing in this section has been run. A proposed test that is described as passing
would be the exact failure mode §11 R15 names.

### 12.1 Authentication boundary (database, real roles, no mocks)

| Test | Tag | Home |
|---|---|---|
| `app_auth` holds exactly the approved column privileges on `users`; nothing table-wide | PROPOSED | `privilege-verification.mjs` `EXPECTED` + `has_column_privilege` |
| `app_api` still holds **no** privilege on `users` | **EXISTING** (measured at `202f508`: `users → {app_api: NONE}`) | same |
| `app_auth` `42501` on `farms`, `fields`, `field_outlook_cells`, `field_observations`, `plantings`, `harvests`, `suitability_runs`, `planting_windows`, `ai_briefings` | PROPOSED | new `test/rls/auth-boundary.test.mjs` |
| `app_auth` `42501` on the six catalog and six weather-plane tables | PROPOSED | same |
| `app_auth` `42501` on `SET ROLE app_api`, `SET ROLE app_system`, `SET ROLE migration_owner` | PROPOSED | same |
| `app_auth` `42501` on `CREATE TABLE`, `CREATE ROLE` | PROPOSED | same |
| `app_auth` cannot read a tenant row **even after setting `app.user_id` itself** — the §3.4 "permitted but useless" claim, tested rather than asserted | PROPOSED | same |
| `app_system` still has no grant on any authentication object | PROPOSED | same + `EXPECTED` |
| `users_auth_lookup` and `users_auth_register` exist, are `FOR SELECT`/`FOR INSERT TO app_auth`, and never name `app_api` | PROPOSED | `test/schema/schema-conformance.test.mjs` |
| `ENABLE`/`FORCE` still set on all 10 tenant tables; `app_api` policy shape unchanged | **EXISTING** (12 conformance tests) | same |
| 39 tenant-isolation assertions unchanged | **EXISTING** (39 tests) | `test/rls/tenant-isolation.test.mjs` |

### 12.2 Session security

| Test | Tag | Note |
|---|---|---|
| Only `sha256(token)` is persisted — read the row, fail if it equals the cookie value | BLOCKED | needs `OPEN-13` |
| The raw token never appears in a database column, a log line, or a response body | BLOCKED | needs the endpoints |
| `app_api` `42501` on `SELECT`/`INSERT`/`UPDATE`/`DELETE` of `sessions` | BLOCKED | needs the table |
| `app_system` holds no `sessions` table privilege but can `EXECUTE app.purge_expired_sessions()` | BLOCKED | needs the function |
| Expired (`expires_at`, `absolute_expires_at`), revoked, and missing sessions all return `401` | BLOCKED | needs the guard |
| Replayed cookie after logout returns `401`; logout is idempotent for an already-dead session | BLOCKED | — |
| Sliding-expiry update changes `expires_at`/`last_seen_at` only — assert every other column is byte-identical | BLOCKED | proves the column `UPDATE` grant does what §4.3 claims |
| Sliding extension is clamped: a session at day 70 of 90 extends to `absolute_expires_at`, not to day 100, and the row still satisfies `sessions_expiry_order_check` | BLOCKED | the constraint would otherwise reject the write exactly when a long-lived session is most used |
| A session whose `expires_at` has been clamped to `absolute_expires_at` is rejected once that instant passes — clamping must not create a session that outlives its absolute deadline | BLOCKED | — |
| `app_auth` **cannot** update `user_id`, `token_hash`, or `created_at` (`42501`, column grant) | BLOCKED | — |
| `app_auth` **can** un-revoke a session — recorded as a known residual, asserted so the gap cannot be discovered later as a surprise | BLOCKED | negative-by-design |
| GC deletes only `absolute_expires_at < now()`; a live row survives | BLOCKED | — |
| Store outage → `503` on `/me`, login, logout; no `200`, no anonymous fallback | NEEDS-INFRA | closed port; no Redis needed |

### 12.3 Login security

| Test | Tag |
|---|---|
| Rate limiting rejects **before** the credential lookup — assert no `SELECT` is issued by spying on the adapter, or assert the `429` arrives with the database unreachable | PROPOSED |
| Unknown email and wrong password produce byte-identical status, code, and body | PROPOSED |
| Dummy-hash verification runs for an unknown email (assert the KDF is invoked) | PROPOSED |
| No session row exists after a failed login | BLOCKED |
| Rate-limit backend unavailable has the specified behaviour (§7.2.1) | NEEDS-INFRA |
| `Retry-After` present on `429`; `RateLimit-*` headers present on success | PROPOSED |

### 12.4 Tenant identity

| Test | Tag |
|---|---|
| No tenant transaction is opened before the subject exists — `current_setting('app.user_id', true)` is `NULL` inside the auth transaction | BLOCKED |
| A `userId` in the body and in the query changes nothing about which rows are visible | PROPOSED |
| Tenant reads go through `withTenant`; the client is not reused after the callback | **EXISTING** (9 unit tests) |
| Nested scope rejected **across two clients** — the guard compares against one client instance (F10) | PROPOSED; the gap is real and currently untested |
| `app_system` remains unable to read tenant tables | **EXISTING** (part of `db:verify` and the RLS suite) |

### 12.5 Regression

`pnpm build`, `lint`, `typecheck`, `test`, `db:status`, `db:verify`,
`db:verify:probes`, `test:rls`, `test:schema` — all **EXISTING** and green at
`bf0e593` as recorded in `IMPLEMENTATION_STATUS.md` for `202f508`; they must be
re-run after any change, not assumed.

New migration must be applied to a **fresh isolated volume** in its own compose
project (the Phase 3 pattern), never by resetting the development database.
**NEEDS-INFRA**: `apps/api` has no test runner (F18) and no `@agroclimate/database`
dependency, so every API-level test above is blocked on a decision between
`node:test` (matches `packages/database`) and vitest (matches `packages/contracts`).

## 13. ADR-004 draft recommendation — Authentication Database Boundary

```text
Status: Proposed (not written; must not be accepted by its own author)
Resolves: OPEN-01
```

**Decision sheet for approval:** §16. This section is the draft text that would
become the ADR; the approval record lives in §16, not here.

**Decision.** A fourth role `app_auth`: `NOLOGIN` at SQL level, `NOSUPERUSER`,
`NOCREATEDB`, `NOCREATEROLE`, `NOREPLICATION`, `NOBYPASSRLS`, `NOINHERIT`, no
membership either way. Grants: `USAGE` on schema `app`; `SELECT (id, email,
password_hash, role, locale, timezone)` and `INSERT (email, password_hash)` on
`app.users`; nothing else, on any object. Policies: `users_auth_lookup FOR SELECT TO
app_auth USING (true)` and `users_auth_register FOR INSERT TO app_auth WITH CHECK
(true)`. `app_api` retains zero privileges on `app.users`.

**Alternatives.** B `SECURITY DEFINER` — smaller bulk exposure, but hands `app_api`
a credential read; recorded as the tightening path, not rejected. C column grant +
second GUC — rejected by `ADR-003` D3.

**Consequences.** Fourth secret to rotate; every email and hash readable in one
query by that DSN (accepted, §4.2); Argon2id forces the hash out of the database;
`db:verify` gains a column-privilege assertion class; `OPEN-01` becomes `RESOLVED`
only when this ADR is **accepted** and the migration is **applied**, not when the
proposal is written.

**Explicitly not resolved.** `OPEN-28`. A leaked `app_api` DSN still reads every
tenant.

---

## 14. ADR-005 draft recommendation — Session Storage

```text
Status: Proposed (not written)
Resolves: OPEN-13
```

**Decision sheet for approval:** §17. This section is the draft text that would
become the ADR.

**Decision.** Server-side sessions in `app.sessions`, consistent with `ADR-002` D5.
Opaque 32-byte CSPRNG token, base64url; only `sha256(token)` stored; `token_hash`
unique; sliding 30 d and absolute 90 d; explicit `revoked_at`; hourly GC in the
`maintenance` queue; grants and policies held by `app_auth` only, never `app_api`.

**Consequences.** A 23rd entity, with the `identity` class widened rather than a
sixth class added (read before identity);
a GC job that does not exist; one DB round-trip per authenticated request; the
pre-identity read repeats on `sessions` (accepted — the alternative is moving the
authority to Redis).

**Alternative.** Redis: cheaper TTL/revocation, avoids the second pre-identity read,
but reverses `ADR-002` D5 (which must then be amended in the same change), adds a
service absent from `docker-compose.yml`, and makes an unauthenticated network
service the authentication authority.

**ADR-003 interaction.** If any variant of signed tenant context (`OPEN-28`) is
adopted, the session-to-tenant handoff is where the signature matters; that ADR,
not this one, owns it.

---

## 15. Gates — architecture and implementation, kept separate

Round 1 required decisions 1–10 before any implementation. That was too coarse: the
envelope contract, the global prefix, and the exception filter do not depend on which
credential reads `users`. Splitting the decisions lets the contract and plumbing
tracks proceed without pretending the authentication architecture has been approved.

### 15.1 Architecture gates

These must be approved **by the repository owner** before the database boundary or
the session architecture is implemented. Neither is decided by this review.

| ID | Description | Owner | Recommended | Dependencies | Latest point | If deferred |
|---|---|---|---|---|---|---|
| `AG-1` = `OPEN-01` | Which credential reads `app.users` before a tenant context exists | repository owner (security) | Option A — dedicated `app_auth` with column grants and two policies (§16) | none | before migration `auth_boundary` is written | registration and login cannot be written; nothing else in 3.2 can start except contracts and plumbing |
| `AG-2` = `OPEN-13` | Where a session lives: Postgres table or Redis | repository owner | Postgres table, consistent with `ADR-002` D5 (§17) | **implementation only** — the store is accessed by whichever credential `AG-1` selects; approval is independent (see below) | before migration `sessions` is written | login cannot issue a session; `/me` and `/logout` cannot be written |

Two different things are called a dependency here, and conflating them is how a
split gate becomes a chain:

| | Meaning | Consequence |
|---|---|---|
| **Approval dependency** | one gate's *decision* presupposes another's | **none exists between `AG-1` and `AG-2`.** Each can be approved or rejected on its own, in either order. An owner may approve the credential boundary and separately choose Redis, or approve PostgreSQL sessions and separately refuse the fourth role |
| **Implementation dependency** | one piece of code can only be written after another piece exists | `AG-2` carries one: session code runs under whichever credential `AG-1` approved. This constrains the *order of work*, not the order of decisions; it is discharged by S3 before S5 in §18 |

Approving `AG-1` does **not** approve PostgreSQL sessions, does **not** authorise
any grant on `app.sessions`, and does **not** pre-empt `AG-2`. Conversely, approving
`AG-2` as a Postgres table does not approve `app_auth`; the session table's grants
are specified against whichever credential `AG-1` settles, and §17 marks them
conditional on this gate for that reason.

### 15.2 Implementation gates

These must be resolved before the subsystem that depends on them. They do not block
the boundary, the contracts, or the API plumbing.

| ID | Decision | Owner | Recommended | Dependencies | Latest point | If deferred |
|---|---|---|---|---|---|---|
| `IG-1` | Email normalisation: application invariant or `lower(email)` unique index | owner | the index — otherwise two normalisation rules create two accounts for one address | none | before the first registration row exists | duplicate-account class of bug, undetectable from the DB |
| `IG-2` | Duplicate registration: `409` (discloses existence) or always `202` | product | `409` + `CONFLICT`, documented as an accepted disclosure | `IG-5` | before the register endpoint ships | endpoint blocked; enumeration posture unstated |
| `IG-3` | Register auto-logs-in, or requires a separate login | product | separate login — the brief's "safe user representation" implies no session, and it keeps one issuance path | `AG-2` | before the register endpoint ships | endpoint blocked |
| `IG-4` | Password policy (length, byte cap, composition) | owner (security) | length ≥ 12, ≤ 1024 bytes, no composition rules (NIST SP 800-63B shape) | none | before `registerRequestSchema` | contract cannot be written; a policy invented in code is a policy nobody approved |
| `IG-5` | Error-code contract for auth, including a store-outage code | owner | seed from `api-conventions.md:37-47`; add exactly one code for dependency unavailability | none | before the exception filter | filter cannot map failures; codes drift into ad-hoc strings |
| `IG-6` | Argon2id parameters | owner, measured on the deploy host | OWASP minimum to start (19 MiB, t=2, p=1), in config | none | before hashing is implemented | cost is a security parameter; a guess is an unmeasured claim |
| `IG-7` | Per-account brute-force control | owner | defer; per-IP + Argon2id cost only in v1, recorded as a stated gap | `IG-5` | before production, not before implementation | distributed credential stuffing unmitigated (R11) |
| `IG-8` | Cookie name and prefix | owner | `__Host-` in production, plain name in dev | none | before the cookie is set | a cookie attribute chosen by the implementer becomes a de-facto decision |
| `IG-9` | CSRF mechanics (header name, token length, comparison, rotation) | owner | double-submit, `X-CSRF-Token`, constant-time compare, rotate on login | `IG-8` | before the first non-GET endpoint | `api-conventions.md:196` says "double-submit" and nothing else; the rest would be invented in code |
| `IG-10` | Email verification before first login | product | out of scope per the brief; record that anyone may register any address | `IG-1` | before any public deployment | abuse surface accepted silently |
| `IG-11` | Test runner for `apps/api` (`node:test` or vitest) | owner | `node:test`, matching `packages/database`; the repo currently has two runners and has never chosen | none | before the first API test | every API-level test in §12 stays blocked (F18) |

`IG-11` is not in the round-2 list; it is required by F18 and would otherwise be
decided by whoever writes the first `package.json` line.

**Not gates:** `OPEN-04` (deletion — untouched, no endpoint, no column) and
`OPEN-28` (signed context — `DEFERRED`; 3.2 neither worsens nor fixes it).

## 16. `OPEN-01` decision sheet — Authentication Database Boundary

| Field | Content |
|---|---|
| **Recommended** | Option A: a fourth role `app_auth`, `NOLOGIN` at SQL level, `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`, zero memberships in either direction |
| **Exact boundary** | `USAGE` on schema `app`; `SELECT (id, email, password_hash, role, locale, timezone)` and `INSERT (email, password_hash)` on `app.users`; `EXECUTE` on no function. Nothing else, on any object — **`app.sessions` is deliberately absent.** Session privileges belong to `AG-2` (§17): an approval of this sheet must remain valid if the owner then chooses Redis, and it cannot do that while naming a table that may never exist |
| **RLS implications** | `users_auth_lookup FOR SELECT TO app_auth USING (true)` and `users_auth_register FOR INSERT TO app_auth WITH CHECK (true)`. `users_self_only` unchanged; `app_api` unmentioned in both. `FORCE` retained — it is what makes a future mistaken grant return zero rows |
| **Compromise blast radius** | bulk emails + hashes; account creation that bypasses the registration flow; and, **only if `AG-2` selects the table**, session issuance for any `user_id` plus revocation/un-revocation. With Redis that power does not vanish — it becomes "whoever holds the store credential can mint any session", which is the §6.1 authority argument. In every variant: **no** tenant table, **no** catalog, **no** weather plane, **no** DDL, **no** `SET ROLE` (§3.4) |
| **Alternatives** | B1 definer callable by `app_api` — rejected, it hands the tenant credential the capability permanently. B2 definer callable only by `app_auth` — the tightening path, not v1. C separate identity context — not a credential-read mechanism; belongs to `OPEN-28` |
| **Residual risks** | enumeration is inherent (the lookup *is* the enumeration); bulk hash extraction; Argon2id is not in core Postgres, so the hash leaves the DB; and, under `AG-2` = table, un-revocation cannot be prevented by a grant |
| **Migration changes** | one new migration, additive: 2 `GRANT` + 2 `CREATE POLICY`. No `ALTER TABLE`, no column, no rewrite. Plus a bootstrap change outside the ledger: `roles.sql:12` array member, an `ALTER ROLE` line, `bootstrap.mjs` secret map, `connections.mjs` role map |
| **Verification evidence required** | `db:verify` with `app_auth` rows: allow and deny per SQLSTATE (`42501` for grant denial, `23503` where a FK is the mechanism); `has_column_privilege` for the column grants; the new `auth-boundary` suite green; 39 tenant-isolation tests unchanged; migration applied to a fresh isolated volume |
| **Marked `RESOLVED` only when** | ADR-004 is **accepted by the owner**, the migration is **applied**, and `db:verify` passes. A recommendation in a review document is not a resolution — this review does not change the disposition in `open-decisions.md` |

```
Approve: ☐ A   ☐ B2   ☐ other (specify)      Reject: ☐
Approved by: ____________________  Date: __________
```

## 17. `OPEN-13` decision sheet — Session Storage

| Field | Content |
|---|---|
| **Recommended** | Postgres table `app.sessions`, accessed only by `app_auth` |
| **Relationship with `ADR-002` D5** | D5 already decided "server-side sessions in Postgres, not JWT", with JWT + refresh rotation in its rejected list. This recommendation **preserves** D5. Nothing needs amending. Choosing Redis instead would reverse D5 and requires amending it in the same change — it is **not** existing infrastructure (`F8`) |
| **Lifecycle** | issue on successful login → validate on each request → extend sliding expiry at most once per 5 min → revoke on logout → purge when `absolute_expires_at` passes |
| **Token format** | 32 CSPRNG bytes, base64url (43 chars), opaque; only `sha256(token)` stored; `token_hash` unique; SHA-256 is correct here because the input is high-entropy — this is **not** the password path and must not be reused as one |
| **Expiry / revocation** | sliding 30 d (`expires_at`), absolute 90 d (`absolute_expires_at`), `revoked_at` for immediate revocation; all three checked on every validation. Sliding extension is clamped with `LEAST(now() + 30 d, absolute_expires_at)`, and the table's CHECK is `absolute_expires_at >= expires_at` so the clamped value is legal |
| **Database access boundary** | applies **only if this gate selects the table**. `ENABLE` + `FORCE` RLS; `sessions_auth_all FOR ALL TO app_auth USING (true) WITH CHECK (true)`; owner policy for `migration_owner`; column `SELECT`/`INSERT`/`UPDATE` per §4.3; **no `DELETE` grant**; `app_api` and `app_system` hold no table privilege. Under Redis, `app_auth` holds no `sessions` privilege at all, and the store credential replaces the grant as the authority |
| **Garbage collection** | `app.purge_expired_sessions()`, `SECURITY DEFINER`, owned by `migration_owner`, `EXECUTE` granted to `app_system` only, hourly in the `maintenance` queue (`background-processing.md:19`). `app_system` gains no table grant — requirement 7 |
| **Outage behaviour** | fail closed per §6.3: `503` on `/me`, login, and logout; never anonymous, never a second authority as "fallback" |
| **Alternatives** | Redis: cheaper TTL/revocation and it avoids the second pre-identity read, but it reverses D5, adds a service absent from `docker-compose.yml`, and makes an unauthenticated network service the authentication authority |
| **Operational trade-offs** | one DB round-trip per authenticated request; one more table and a GC job that does not exist; backup/restore already covers it; sessions do not survive nothing — they survive a Redis restart that Redis would have lost |
| **Verification evidence required** | the §12.2 suite; `db:verify` showing `app_api` `42501` on all four operations; GC test; outage test; fresh-volume migration |
| **Marked `RESOLVED` only when** | ADR-005 accepted by the owner **and** the migration applied **and** the session suite green. Not on the strength of this sheet |

```
Approve: ☐ Postgres table   ☐ Redis (requires ADR-002 D5 amendment)   Reject: ☐
Approved by: ____________________  Date: __________
```

## 18. Recommended implementation sequence

Three tracks. Only the third is gated on `AG-1`/`AG-2`; the first two are safe to do
earlier and must not be described as authentication progress.

### Track 0 — approvals

| Step | Work | Gate |
|---|---|---|
| S0a | Answer `AG-1` and `AG-2` using §§16-17; record the answers in `open-decisions.md` **only when approved** | blocks S3+ |
| S0b | Answer `IG-11` (test runner) and `IG-5` (error codes) — the tracks below cannot start without them | blocks S1 and T2 |

### Track 1 — contracts and API plumbing (safe before approval)

| Step | Work | Gate |
|---|---|---|
| S1 | Contracts: response envelope, error envelope, error-code enum, `requestId` shape. **No auth request/response schemas yet** — those depend on `IG-4` | `IG-5`, `IG-11` |
| S2 | API plumbing: global prefix `/v1`, `ZodValidationPipe` bound per parameter (`IG-12`), exception filter, request-id middleware, cookie parser, helmet, trust-proxy, CORS, `apps/api` → `@agroclimate/database` dependency and client lifecycle | `IG-11`, `IG-12` |

Both write to `apps/api` and `packages/contracts`; they do not touch roles, grants,
migrations, or the tenant path.

### Track 2 — database boundary and sessions (**gated**)

| Step | Work | Gate |
|---|---|---|
| S3 | Bootstrap: `app_auth` role, secret map, `connections.mjs`, `.env.example` | `AG-1` approved |
| S4 | Migration `auth_boundary`: 2 policies + 2 column grants. Apply to a fresh volume | S3 — the role must exist before the policy names it (`42704` otherwise) |
| S5 | Migration `sessions` + policies + grants + purge function | `AG-2` approved, S4 |
| S6 | `privilege-verification.mjs` `EXPECTED` + `has_column_privilege` probes; `auth-boundary` suite; conformance additions | S4 (and S5 for session rows) |

### Track 3 — authentication endpoints (**gated**)

| Step | Work | Gate |
|---|---|---|
| S7 | Register + login: schemas, Argon2id, dummy-hash verification, rate limiting before lookup, generic failures | S1, S2, S4, `IG-1/2/3/4/6/7/10` |
| S8 | Sessions: guard, `/me`, `/logout`, sliding expiry, purge job wiring | S5, S6, `IG-8/9` |
| S9 | Docs: ADR-004/005 accepted, `entity-catalog` gains `sessions` in the widened `identity` class, `api-conventions` amendments (`/v1/auth/register`, the 403/404 contradiction), `auth-deferred.md` pointer resolved, `IMPLEMENTATION_STATUS` | everything above |

Dependency rules preserved: role before policy; grants before endpoints; store
before validation; subject before tenant context; `withTenant` unchanged throughout.

## 19. Definition of Done

Each criterion names the artefact that proves it. "Documented" is not on this list.

| # | Criterion | Evidence | Gate |
|---|---|---|---|
| 1 | ADR-004 accepted | its Status line reads Accepted, dated, with the approver recorded | `AG-1` |
| 2 | ADR-005 accepted | same | `AG-2` |
| 3 | `OPEN-01` resolved | disposition changed to `RESOLVED` **and** the migration applied **and** `db:verify` green — not one of the three | `AG-1` |
| 4 | `OPEN-13` resolved | same, plus the `sessions` entry in `entity-catalog.md` | `AG-2` |
| 5 | Role boundary verified | `db:verify` rows for `app_auth`: allow and deny, by SQLSTATE; column grants via `has_column_privilege` | `AG-1` |
| 6 | Registration, login, `/me`, logout work | API test output, not prose | `IG-*` |
| 7 | Identity is the sole source of tenant context | the `current_setting('app.user_id', true) IS NULL` assertion inside the auth transaction | — |
| 8 | Tenant work uses `withTenant` | the body/query `userId` tests plus the existing 9 unit tests | — |
| 9 | Existing RLS intact | 39 isolation + 12 conformance tests, unchanged counts | — |
| 10 | No session-scoped `SET`, no client-supplied identity | the `grep -n "SET app\."` rule + the negative tests | — |
| 11 | Fail-closed outage behaviour | test against a closed port | — |
| 12 | Regression green | build, lint, typecheck, test, `db:status`, `db:verify`, `test:rls`, `test:schema` — command output | — |
| 13 | Fresh-volume migration | isolated compose project, own volume, removed afterwards | — |
| 14 | Docs reconciled | status entries cite commands and counts | — |
| 15 | No unresolved assumption presented as a control | `OPEN-04`, `OPEN-28`, `IG-7`, `IG-10`, and the `app_auth` bulk-read/impersonation exposure all appear as stated limitations in the same document that claims completion | — |

Item 15 fails most quietly, and it is the one this review exists to make visible.

---

## 20. Final recommendation

**READY FOR OWNER DECISIONS.**

The design is coherent and every constraint in the brief is satisfiable without
weakening anything that exists. Nothing here is blocked on missing engineering work:
the two architecture gates are owner decisions, and they are written out in §§16-17
as approve/reject sheets rather than as prose recommendations.

What is required before implementation begins:

1. `AG-1` (`OPEN-01`) — approve a credential boundary. Recommended: Option A,
   `app_auth` with column grants and two policies.
2. `AG-2` (`OPEN-13`) — approve session storage. Recommended: Postgres table,
   preserving `ADR-002` D5. Redis is legitimate but is a D5 reversal and is not
   existing infrastructure.
3. `IG-11` and `IG-5` — the test runner and the error-code contract, because the
   contract and plumbing tracks cannot start without them.

Everything else (`IG-1`–`IG-10`) can be answered while the boundary is being built;
none of them changes the boundary.

Corrections of record, all verified against the repository rather than assumed:

- The brief's `docs/adr/ADR-002-session-and-authentication.md` does not exist; the
  sessions decision is `ADR-002-monorepo-and-backend-architecture.md` D5.
- Redis is documented and not provisioned.
- `OPEN-13` is inconsistently decided rather than undecided.
- The round-1 login sequence placed rate limiting after password verification; §7.2
  is corrected, and §7.2.1 states what v1 does and does not have.
- A session lookup repeats the `OPEN-01` pre-identity read; that is the actual
  argument for Redis, and it is stated in §1.1 rather than left implicit.

No implementation begins before explicit owner approval, and no `OPEN` disposition
in `docs/data-model/open-decisions.md` has been changed by this document.
