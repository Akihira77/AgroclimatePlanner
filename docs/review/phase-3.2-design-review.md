# Phase 3.2 — Authentication & Tenant Identity: Design Review

Status: **design review only.** Nothing in this document was applied. No code, no
migration, no role, no grant, no policy, no configuration change exists because of
it. Every SQL block is a proposal.

Repository state reviewed: `master` at `5b9b959`, working tree clean except this
file. Reviewed: the Phase 3.2 brief; `packages/database` (bootstrap, scripts,
`src/tenant.ts`, migrations, tests); `packages/contracts`; `apps/api`;
`prisma/schema.prisma`; `docs/architecture/{api-conventions,system-architecture,
database-foundation,domain-model,background-processing}.md`;
`docs/data-model/*`; `docs/adr/ADR-001..003`; `docker-compose.yml`.

**Verdict: READY AFTER DECISIONS.** Two blocking decisions and eight smaller ones
are listed in §15. Nothing else in the brief is blocked; the remainder is
mechanical once those land.

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

## 5. Dedicated role vs `SECURITY DEFINER`

`ownership-and-rls.md` §5 records three options. Option C (column grant plus a
second authority GUC) is **disqualified by an existing decision**, not by taste:
`ADR-003` D3 says a second context variable "would need its own ADR, because two
variables with different trust levels is how a boundary becomes a suggestion".
`[V]`

| Criterion | A — `app_auth` role | B — `SECURITY DEFINER` function |
|---|---|---|
| Fails visibly | yes: `42501` on any ungranted object | partly: one object; a wrong `search_path` fails **open**, not closed |
| Reviewable surface | 2 policies + 2 column grants, comparable to the existing matrix | one function body, must pin `SET search_path` and qualify names |
| Leaked-DSN blast radius | full `users` read | one row per call |
| Effect on `app_api` | none | **grants `app_api` a credential read** — the tenant credential gains a capability it cannot lose |
| Interaction with `FORCE` | policies apply; owner unaffected | function runs as owner, bypassing RLS by design — the point and the risk |
| Migration cost | 2 policies, 2 grants, no table change | function + `REVOKE` + `GRANT`; rollback needs `DROP FUNCTION` |
| Bootstrap cost | fourth role, fourth DSN, fourth secret | none |
| Precedent in repo | column grant already used (`outlook_cells`) | none |

**Recommendation: A**, with B named as the tightening path. The property worth a
fourth credential is that the credential sits entirely **outside** `app_api`; a
function executed by `app_api` hands the tenant role a credential-read capability
permanently. A's cost — bulk read by whoever holds the `app_auth` DSN — is real and
belongs in the ADR as an accepted limitation, not mitigated with a predicate that
cannot exist.

**Upgrade path, if the threat model later forbids bulk read:** A + B together —
the role exists, and its only privilege on `users` becomes `EXECUTE` on one
function. Additive; does not invalidate A.

---

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
`entity-catalog.md` to grow a **new ownership class** — a session row is read
before its owner is known, and none of the five existing classes describes it);
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
| 6 | Brute force, one account, many IPs | per-IP throttle does not cover it; Argon2id cost raises the price; generic errors | **no per-account control exists** — see decision 8 |
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
   `users_email_key` is case-sensitive, so this is not enforced by the database (§15
   decision 3).
3. Password policy applied against the *plaintext*, before hashing; length is
   counted in bytes for the KDF input cap (`[R]`, decision 6/9).
4. `argon2id` hash computed — parameters from config, never inlined twice.
5. `INSERT INTO app.users (email, password_hash)` as `app_auth`, `ON CONFLICT
   (email) DO NOTHING` so a duplicate is a decision, not an exception path.
6. Duplicate → `409` with code `CONFLICT` (discloses existence; see §10 and
   decision 4).
7. Session created and cookie set — or registration and login stay separate. **This
   is a product decision** (§15 decision 5); the brief implies auto-login by
   returning a "safe user representation" only, so the default is *no* session.
8. Response contains `{ id, email, role, locale, timezone, createdAt }` and never
   `password_hash`, never the raw token.

### 7.2 Login — `POST /v1/auth/login`

1. `loginRequestSchema` validated.
2. Email normalised identically to registration (one shared function, not two
   copies).
3. `SELECT id, email, password_hash, role FROM app.users WHERE email = $1` as
   `app_auth`. No `app.user_id` exists in this transaction, and a test asserts it.
4. User absent → verify the password against a fixed dummy hash, then fail. Skipping
   this step is what turns "wrong password" into an enumeration oracle by timing.
5. User present → `argon2.verify`. Failure → the same `401` body as step 4.
6. Rate limit checked before the lookup, not after (a limiter that runs post-hash
   pays the Argon2id cost on every attempt).
7. Session row inserted (or key written): `token` from 32 CSPRNG bytes, base64url;
   only `sha256(token)` persisted; `expires_at = now() + 30 d`,
   `absolute_expires_at = now() + 90 d`.
8. Cookie set: `HttpOnly`, `Secure` in production, `SameSite=Lax`, `Path=/`, no
   `Domain`; name per decision 10.
9. Response: the same safe user representation; never the token in the body.

### 7.3 Current session — `GET /v1/auth/me`

1. Cookie parsed; absent → `401 UNAUTHENTICATED`.
2. `SELECT … FROM app.sessions WHERE token_hash = $1` as `app_auth`; missing,
   `expires_at <= now()`, `absolute_expires_at <= now()`, or `revoked_at IS NOT
   NULL` → `401`, identical body.
3. Sliding expiry: extend at most once per 5 minutes per session (`[R]` — a write on
   every request is write amplification for no security gain).
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
| 9 | `lower(email)` unique index — **only if decision 3 approves** | new file, additive | no | none (`users` is empty) |

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
| error codes | prose rows only | a Zod enum seeded from `api-conventions.md:37-47`. Auth needs `VALIDATION_FAILED`, `UNAUTHENTICATED`, `CONFLICT`, `RATE_LIMITED`, and one for store outage (decision 7) |
| `registerRequestSchema` / `loginRequestSchema` | absent | email (trim, lowercase, ≤254), password (policy per decision 6) |
| `authenticatedUserSchema` | absent | `{ id, email, role, locale, timezone, createdAt }` — never `passwordHash` |
| global prefix `/v1` | absent | `app.setGlobalPrefix("v1")`, with `health` exempt as `api-conventions.md:183` already implies |
| `ValidationPipe` | absent | global, `whitelist: true`, `forbidNonWhitelisted: true` — this is the mass-assignment control |
| exception filter | absent | maps `ZodError`→400, `23505`→409, `TenantContextError`→500, store outage→503 |
| cookies / CSRF | absent | `cookie-parser`; double-submit token per `api-conventions.md:196`, details currently unspecified (decision 10) |
| OpenAPI | promised, absent | `api-conventions.md:3,211-215` and `ADR-002` D4 promise generation from Zod. Adding auth without a generator breaks that promise a second time; at minimum the new schemas must be generator-ready and the gap re-recorded |
| `POST /v1/auth/register` | not in conventions | amend `api-conventions.md:150` in the same change |

The api-conventions 403/404 contradiction (F13) should be fixed while the auth
error table is being written — auth is the first feature that will hit it.

---

## 11. Security risks and mitigations

| # | Risk | Sev. | Mitigation | Residual, stated |
|---|---|---|---|---|
| R1 | `app_auth` DSN leak | High | separate credential, column grants, separate secret, never in the API's tenant path | full `users` read (§4.2) |
| R2 | Registration mass assignment to `role` | High | column grant excludes `role`; `ValidationPipe` rejects unknown keys | both controls, either alone is insufficient by design |
| R3 | Account enumeration | Medium | identical body/code/status; dummy-hash verification; uniform timing | `409` on duplicate registration still discloses existence (decision 4) |
| R4 | Credential stuffing | Medium | `429` per IP, Argon2id cost, generic errors | no per-account control (decision 8) |
| R5 | Session fixation | High | rotate on login; cookie set only after success | — |
| R6 | Session theft via XSS | Medium | `HttpOnly` | XSS acts as the user regardless |
| R7 | Forged session via a leaked session-table credential | High | `app_api` gains nothing on `sessions`; only `app_auth` reads it | a superuser is out of scope |
| R8 | Store outage treated as "no auth needed" | Critical | fail-closed table (§6.3), tested against a closed port | — |
| R9 | Identity taken from the request body | Critical | guard + `@CurrentUser()`; test with a foreign `userId`; ADR-003 row 5 | RLS cannot catch it — this is a code-path control |
| R10 | Leaked `app_api` DSN reads every tenant | High | **not mitigated**; `OPEN-28` is the upgrade path | accepted for v1 per ADR-003 D4 |
| R11 | Hash parameters too weak | Medium | configurable, recorded in ADR-004, one definition | hardware-dependent; re-measure on deploy |
| R12 | Session table growth | Low | GC in `maintenance`; `(absolute_expires_at)` index | GC job does not exist yet |
| R13 | Docs claim a control that is not implemented | Medium | every status entry states what was *run*; this review's §16 tags each DoD item | process risk, not technical |

---

## 12. Test plan

Existing infrastructure: `packages/database/test/unit` (node:test, no DB),
`test/rls` (39 real-role tests), `test/schema` (12 catalogue tests), and
`privilege-verification.mjs` (355 assertions, not a test file). `packages/contracts`
uses vitest. **`apps/api` has no runner** — its `test` script prints a string.
`[V]`

### 12.1 Database security (real roles, no mocks)

| Test | Home |
|---|---|
| `app_auth` holds exactly the listed column grants; `app_api` still `NONE` on `users` | `privilege-verification.mjs` `EXPECTED` + `has_column_privilege` |
| `app_auth` `42501` on `farms`, `fields`, catalog, weather plane, `CREATE TABLE`, `SET ROLE app_api`, `SET ROLE migration_owner` | new `test/rls/auth-boundary.test.mjs` |
| `app_auth` cannot read a tenant row even after setting `app.user_id` itself | same file |
| `app_api` cannot read `users` or `sessions` (`42501`) | same file |
| `users_auth_lookup`/`_register` exist, are `FOR SELECT`/`FOR INSERT` `TO app_auth`, and do not name `app_api` | `test/schema/schema-conformance.test.mjs` |
| `FORCE`/`ENABLE` still set on all 10 tenant tables; policy count unchanged for `app_api` | existing conformance suite |
| 39 existing isolation tests still pass | `test/rls/tenant-isolation.test.mjs`, unchanged |
| nested scope rejected **across two clients** (F10) | `test/unit/tenant.test.mjs` |

### 12.2 API

Registration: valid; duplicate (exact and case-variant); invalid email; short
password; `password_hash` never in the response; client-supplied `role` ignored or
rejected; concurrent duplicates yield one row.

Login: correct; wrong password; unknown email — **all three failure bodies
byte-identical**; rate limit `429` with `Retry-After`; no session row on failure;
`current_setting('app.user_id', true)` is `NULL` inside the auth transaction.

Session: valid resolves the right user; missing/expired/revoked → `401`; logout
invalidates; replayed old cookie → `401`; the store holds only a hash (assert by
reading the row and failing if it equals the cookie value); sliding expiry extends
at most once per window.

Tenant integration: body `userId` and query `userId` change nothing; missing session
→ `401` before any tenant transaction; `withTenant` receives only the subject id.

Outage: session store pointed at a closed port → `503` on `/me`, login, and logout;
never `200`, never anonymous.

### 12.3 Regression

`pnpm build`, `lint`, `typecheck`, `test`, `db:status`, `db:verify`,
`db:verify:probes`, `test:rls`, `test:schema`, plus the new migration applied to a
**fresh isolated volume** in its own compose project (the Phase 3 pattern), never a
reset of the dev database.

Two gaps this review cannot paper over: `apps/api` needs a runner (pick `node:test`
for consistency with the DB suites, or vitest for consistency with contracts — the
repo currently uses both and has never chosen), and `apps/api` needs
`@agroclimate/database` as a dependency before its first integration test.

---

## 13. ADR-004 draft recommendation — Authentication Database Boundary

```text
Status: Proposed (not written; must not be accepted by its own author)
Resolves: OPEN-01
```

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

**Decision.** Server-side sessions in `app.sessions`, consistent with `ADR-002` D5.
Opaque 32-byte CSPRNG token, base64url; only `sha256(token)` stored; `token_hash`
unique; sliding 30 d and absolute 90 d; explicit `revoked_at`; hourly GC in the
`maintenance` queue; grants and policies held by `app_auth` only, never `app_api`.

**Consequences.** A 23rd entity and a new ownership class (read before identity);
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

## 15. Unresolved decisions

| # | Decision | Blocks | Recommendation | Owner |
|---|---|---|---|---|
| 1 | `OPEN-01`: A, B, or C | login, sessions, every authenticated request | **A**; C rejected by ADR-003 D3 | owner — a fourth role is a security decision |
| 2 | `OPEN-13`: table or Redis | session issuance and validation | **table**; Redis requires amending D5 | owner |
| 3 | Email normalisation: app invariant, or `lower(email)` unique index | registration correctness across writers | index — otherwise two normalisation rules create two accounts for one address | owner (touches `users`) |
| 4 | Duplicate registration discloses existence (`409`) | account enumeration posture | accept and document, or always `202`; silently picking one is not an option | product |
| 5 | Register auto-logs-in, or requires a separate login | endpoint shape, test matrix | auto-login is fewer round-trips but implies session creation on `POST /register`; **the brief implies no session** | product |
| 6 | Password policy | contract schema, Argon2id input cap | length ≥ 12, ≤ 1024 bytes, no composition rules (NIST SP 800-63B shape); record it | owner |
| 7 | Error code for a session-store outage | filter, contracts enum | add one code to the conventions table; reuse none of the data-plane codes | owner |
| 8 | Per-account brute-force control | login hardening | defer with a written note; per-IP throttle + Argon2id only in v1 | owner |
| 9 | Argon2id parameters | cost, hardware sensitivity | OWASP minimum to start (19 MiB, t=2, p=1), in config, measured on the deploy host | owner |
| 10 | Cookie name/prefix and CSRF token mechanics | implementation | `__Host-` prefix in production (forces `Secure`, `Path=/`, no `Domain`), plain name in dev; double-submit header `X-CSRF-Token` compared in constant time | owner |
| 11 | Email verification before first login | abuse surface | out of scope per the brief; without it anyone can register any address — accept explicitly | product |
| 12 | `OPEN-28` timing | production readiness | stay `DEFERRED`; 3.2 neither worsens nor fixes it | owner |

`OPEN-04` is untouched: no deletion endpoint, no `deleted_at` on `users`, no partial
email index. Auth must not quietly pre-empt it.

---

## 16. Recommended implementation sequence

Each step ends in something runnable and verifiable; no step is a placeholder.

| Step | Work | Gate |
|---|---|---|
| S0 | **Decisions 1–10 answered.** No code. | written dispositions updated in `open-decisions.md` |
| S1 | Contracts: envelope, error codes, auth request/response schemas, shared email normaliser | `pnpm test` in contracts; no endpoint yet |
| S2 | Bootstrap: `app_auth` role + secret map + `connections.mjs`; `.env.example` | `db:bootstrap` idempotent; `db:verify` still 355/0 with the new role's *negative* assertions |
| S3 | Migration: 2 policies + 2 column grants | applied to a **fresh** volume; conformance + auth-boundary tests green |
| S4 | API plumbing: prefix `/v1`, `ValidationPipe`, exception filter, request id, cookie parser, throttle, trust-proxy, database client lifecycle | health still green; existing suites unaffected |
| S5 | Register + login + hashing + timing equalisation | §12.2 registration/login tests; `app_auth` never opens a tenant transaction |
| S6 | Sessions: table, guard, `/me`, `/logout`, sliding expiry, GC job | §12.2 session tests; outage test |
| S7 | Docs: ADR-004/005 accepted, `entity-catalog` 23rd table + new class, `api-conventions` amendments, `IMPLEMENTATION_STATUS`, `auth-deferred.md` pointer resolved | status entries state commands actually run |

S3 cannot precede S2 (role must exist); S5 cannot precede S3 (no grant); S6 cannot
precede S5 (nothing to issue); S4 can run in parallel with S1–S3.

---

## 17. Definition of Done

| # | Criterion | How it will be evidenced |
|---|---|---|
| 1 | ADR-004 accepted | its Status line says Accepted, dated |
| 2 | ADR-005 accepted | same |
| 3 | `OPEN-01` resolved | disposition changed to `RESOLVED` **and** the migration applied, verified by `db:verify` |
| 4 | `OPEN-13` resolved | same, with the entity-catalog entry added |
| 5 | Role boundary verified | `db:verify` with `app_auth` rows: allow and deny, by SQLSTATE |
| 6 | Registration, login, `/me`, logout work | API test suite output, not prose |
| 7 | Identity is the sole source of tenant context | the `app.user_id IS NULL` assertion inside the auth transaction |
| 8 | Tenant work uses `withTenant` | existing rule + the body/query `userId` tests |
| 9 | Existing RLS intact | 39 isolation tests + 12 conformance tests, unchanged |
| 10 | No session-scoped `SET`, no client-supplied identity | grep rule + negative tests |
| 11 | Fail-closed outage behaviour | test against a closed port |
| 12 | Regression green | build, lint, typecheck, test, `db:status`, `db:verify`, `test:rls`, `test:schema` |
| 13 | Fresh-volume migration | isolated compose project, own volume, removed afterwards |
| 14 | Docs reconciled | status entries cite commands and counts |
| 15 | No unresolved assumption presented as a control | `OPEN-04`, `OPEN-28`, email verification, per-account throttling, and the `app_auth` bulk-read exposure all appear as stated limitations |

Item 15 is the one that fails most quietly. Nothing in this review enables it.

---

## 18. Final recommendation

**READY AFTER DECISIONS.**

The design is sound and the constraints in the brief are satisfiable without
weakening anything that exists. The blocker is not technical: `OPEN-01` and
`OPEN-13` are both `BLOCKED_EXTERNAL_INPUT`, and the brief's own DoD requires them
resolved. Decision 1 (role vs function) and decision 2 (table vs Redis) unlock the
rest.

Three of the brief's premises are contradicted by the repository and are corrected
in §1.1 — most importantly, Redis is not provisioned, and `ADR-002` D5 already
chose Postgres sessions. Choosing Redis is legitimate, but it is a reversal that
must be recorded as one, not a gap being filled.

No implementation will begin before explicit approval.
