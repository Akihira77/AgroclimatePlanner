# Phase 3.2.2 — Owner Decision Record: Authentication & Tenant Identity

| Field | Value |
|---|---|
| Status | **OWNER DECISIONS RECORDED** — 4 of 4 decided on 2026-11-18 |
| Prepared from | `8799160` (`docs(review): split approval from implementation dependency`) |
| Authoritative source | `docs/review/phase-3.2-design-review.md` (verdict: `READY FOR OWNER DECISIONS`) |
| Decisions requested | 4 — `AG-1`, `AG-2`, `IG-5`, `IG-11` |
| Owner decisions made so far | **4 of 4** |
| Implementation started | **No** — a decision is not a line of code, a migration, or an ADR |
| `OPEN-nn` dispositions changed | **No** — `OPEN-01` and `OPEN-13` remain unresolved |

This record exists so the owner can decide without reading 1,100 lines of review. It
restates the review's recommendations; it does not add to them. Where a detail is
shortened, §16 and §17 of the review remain the authority.

**Approval is not implementation.** The four decisions below are recorded; no code,
migration, role, grant, policy, or ADR exists because of them. `OPEN-01` and `OPEN-13`
stay below `RESOLVED`: per the review's Definition of Done, resolution requires an
accepted ADR **and** an applied migration **and** green verification evidence — not an
approval. Until then the register's dispositions are unchanged.

## Recorded decisions

| ID | Decided | Date | Approver |
|---|---|---|---|
| `AG-1` | **A** — dedicated `app_auth` role, column grants on `app.users` only | 2026-11-18 | Repository owner |
| `AG-2` | **A** — PostgreSQL `app.sessions`, preserving `ADR-002` D5 | 2026-11-18 | Repository owner |
| `IG-5` | **A / C-1** — shared envelope plus one new code, `DEPENDENCY_UNAVAILABLE` | 2026-11-18 | Repository owner |
| `IG-11` | **`node:test`** for `apps/api` | 2026-11-18 | Repository owner |

## Reading legend

| Tag | Means |
|---|---|
| `[V]` | verified in this repository by reading the cited file |
| `[P]` | proposal from the design review — approved only where the corresponding owner decision form records it |
| `[O]` | this document's own inference or wording, not a repository fact |

## Decision index

| ID | Decision | Register entry | Deadline | Blocks |
|---|---|---|---|---|
| `AG-1` | Authentication database boundary | `OPEN-01` (P1) | before the boundary migration exists | S3, S4, S6, S7 |
| `AG-2` | Session storage | `OPEN-13` (P1) | before the sessions migration exists | S5, S8, S6 (session rows) |
| `IG-5` | Authentication API error contract | implementation gate | before the exception filter | S1, S2, S7 |
| `IG-11` | API test runner | implementation gate | before the first API test | S2, every API-level test |

`AG-1`/`AG-2` are architecture decisions. `IG-5`/`IG-11` are convention decisions
that would otherwise be made by whoever writes the first file. Both kinds are
recorded here because both are owed by the owner before the corresponding track can
start, and the four together are what §20 of the design review names as the
precondition for implementation.

---

# Decision 1 — AG-1: Authentication Database Boundary

**Register entry:** `OPEN-01` — P1, hard blocker. Design review §16.

## 1.1 Current repository context

| Fact | Evidence |
|---|---|
| `app_api` — the tenant runtime credential — holds **no** privilege on `app.users` | `[V]` `packages/database/prisma/migrations/20261118020000_tenant_tables/migration.sql:151-158`: the grant list covers `farms`/`fields` only, and a comment explains the omission |
| `users` has `ENABLE` + `FORCE` RLS with a self-only policy | `[V]` same file `:107-112`, predicate `id = NULLIF(current_setting('app.user_id', true), '')::uuid` |
| `app.user_id` is written only by `withTenant`, transaction-local, and `withTenant` requires the user id as its argument | `[V]` `packages/database/src/tenant.ts:61-81`, `set_config(..., true)` at `:76` |
| Three roles exist today: `migration_owner`, `app_api`, `app_system` | `[V]` `packages/database/bootstrap/roles.sql:12`, `:22-24` |
| `apps/api` has no database client and no auth code at all | `[V]` `apps/api/package.json` — dependencies are NestJS core, `@agroclimate/contracts`, `reflect-metadata`, `rxjs`; four source files |

## 1.2 Problem statement

Login must read `password_hash` **before any tenant context exists**. That read
cannot be expressed through `app_api`, because `app_api` either has no grant on
`users` (today) or, if given one, would hold tenant-table privileges at the same
time as bulk credential-read capability. The question `OPEN-01` asks is narrow: *which
credential reads the credential table, and exactly what else can that credential
reach?*

`INSERT` is part of the same question, because registration creates a `users` row
before the account has a session, hence before any tenant context. The existing
`users_self_only` policy cannot admit either operation.

## 1.3 Options

| Option | Shape | Verdict |
|---|---|---|
| **A** | Dedicated fourth role `app_auth`, with column-level `SELECT`/`INSERT` on `app.users` | **`[P]` recommended** |
| **B1** | `SECURITY DEFINER` function callable by `app_api` | Rejected in the review — it hands the tenant credential the capability permanently, and `app_api` is the credential most exposed to tenant-facing code |
| **B2** | `SECURITY DEFINER` function callable only by `app_auth` | Not the v1 choice; the tightening path if the owner later wants the credential table unreachable directly |
| **C** | Separate identity context / instance | Not a credential-read mechanism. Belongs to `OPEN-28` (signed tenant context), which is `DEFERRED`; substituting it for `OPEN-01` would leave login with no way to read the hash |

## 1.4 Recommended option

`[P]` **Option A.** A fourth role `app_auth`, provisioned by the same two-step
mechanism the three existing runtime roles already use.

**`NOLOGIN` is the bootstrap state, not the running state.** The repository creates
roles `NOLOGIN` in SQL and enables login in a separate provisioning step, so
describing the provisioned role as `NOLOGIN` would be wrong — and `db:verify` already
asserts the opposite (`privilege-verification.mjs:176`: `rolcanlogin === true` for
every role in `ROLE_NAMES`). The same distinction settles how the application
authenticates: it connects **directly** as `app_auth`, with its own connection string
and its own independently supplied secret. No second login role, no role membership,
no `SET ROLE`.

| State | Repository mechanism | `app_auth` |
|---|---|---|
| **Bootstrap SQL** | `bootstrap/roles.sql:12` (array member) and `:22-24` (`ALTER ROLE … NOLOGIN …`), executed by `bootstrap.mjs` as superuser | created `NOLOGIN` |
| **Provisioned runtime** | `scripts/bootstrap.mjs:53-60`: `select format('alter role %I with login password %L', …)`, password from the environment, statement executed and never logged | `LOGIN`, `rolcanlogin = true` |

Security attributes, identical in both states and unaffected by the login step:
`NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOREPLICATION`, `NOBYPASSRLS`,
`NOINHERIT`, and zero memberships in either direction — not a member of
`app_api`/`app_system`, and neither of them a member of `app_auth`.

The credential reaches the process the way it already does for the other three:
`connections.mjs:26-30` maps a role name to a URL variable and a password variable
(`app_api` → `APP_API_DATABASE_URL` / `APP_API_PASSWORD`), and `ROLE_NAMES` is derived
from that map — which is why the provisioning loop applies `LOGIN` to every listed
role without a per-role edit. Adding `app_auth` to that map is what makes it
provisionable; it is not a separate code path. `[V]` mechanism, `[P]` the fourth entry.

Proposed privileges, complete:

| Object | Privilege |
|---|---|
| schema `app` | `USAGE` |
| `app.users` | `SELECT (id, email, password_hash, role, locale, timezone)` |
| `app.users` | `INSERT (email, password_hash)` |
| `app.users` | **no** `UPDATE`, **no** `DELETE`, **no** row-wide privilege |
| `app.sessions` | **nothing under AG-1** — see Decision 2 |
| any function | `EXECUTE` on none |
| tenant tables (`farms`, `fields`, `plantings`, `field_outlook_cells`, …) | nothing |
| weather-plane tables, catalog tables | nothing |
| DDL, `SET ROLE` | nothing |

Two policies accompany the grants: `users_auth_lookup FOR SELECT TO app_auth USING
(true)` and `users_auth_register FOR INSERT TO app_auth WITH CHECK (true)`.
`users_self_only` is unchanged, and `app_api` is unmentioned in both. `FORCE` is
retained — it is what makes a future mistaken `app_api` grant return zero rows
instead of data.

## 1.5 Rationale

`[O]` The boundary is worth a fourth role because it separates two capabilities that
have nothing to do with each other: *"read one credential row for an address"* and
*"read and write every tenant row the caller owns"*. Merging them into `app_api`
would make every tenant-facing code path a credential-read surface, permanently,
with no way to tell from a grant dump which repository code was allowed to do what.

**This is a database-privilege boundary, not a process boundary.** The design review
places the `app_auth` client in the same process as the tenant client
(`phase-3.2-design-review.md:143` — "a second client in the same process"). The
separation therefore constrains what each *credential* may do; it does not constrain
what an attacker holding the *process* can do, because such an attacker has both
credentials. An earlier revision of this section said the two capabilities already
live in different processes today. That was wrong and is corrected here.

Column-level grants express the intended read precisely: the login path needs six
columns, not the row. `email_normalized` does not exist, `updated_at` triggers are
absent (`OPEN-19`), and a row-wide `SELECT` would hand over columns that appear
later. The grant is narrow on purpose, so that adding a column is a deliberate act
rather than an automatic widening of the auth surface.

Two facts limit how much this buys, and they are stated rather than implied:

- Column grants bound **columns**, not **rows**. `USING (true)` plus
  `SELECT (email, password_hash)` is a bulk dump of every account.
- `ALTER TABLE` on `users` can affect grants, and the `users` DDL is owned by
  `migration_owner`. The boundary is a runtime property, not a schema invariant.

## 1.6 Security and operational implications

What a holder of the `app_auth` DSN can do, stated without softening:

| Action | Possible | Mechanism |
|---|---|---|
| Enumerate every user's email address | **yes** | column `SELECT` + `USING (true)` |
| Extract every password hash for offline cracking | **yes** | same |
| Create an account outside the registration flow | **yes** | column `INSERT`, bypassing rate limits and every product rule implemented in the API |
| Issue a session for an arbitrary `user_id` | **only if AG-2 selects the PostgreSQL table** | `INSERT` on `app.sessions` under that gate |
| Revoke, or **un-revoke**, any session | **only if AG-2 selects the table**, and only in the direction the grant cannot stop | column `UPDATE (revoked_at)` has no directional form |
| Read or write any tenant row | no | no grant; RLS would return zero rows anyway |
| Read weather or catalog data | no | no grant |
| Run DDL, change roles, `SET ROLE` | no | no grant |
| Change a user's password | no | no `UPDATE` on `users` |

**A dedicated role reduces privilege scope; it does not eliminate account-takeover
risk.** Compromise of the `app_auth` credential is, in the worst case, the ability
to log in as anyone — without knowing any password and without touching the
credential table. Choosing Redis for AG-2 does not remove this: it relocates the
same power to whoever holds the store credential. The owner must accept this
residual risk explicitly, not as a footnote.

**And the role boundary does not survive process compromise.** Both clients live in
one process (`phase-3.2-design-review.md:143`), so an attacker who owns that process —
RCE, a compromised dependency, a poisoned config read — holds the tenant credential
and the auth credential together. The fourth role limits what each credential reaches;
it says nothing about what the process reaches. Hardening the process is out of scope
for this decision and must not be inferred from it.

Operational implications: a fourth DSN to provision, rotate, and audit; a fourth row
in every privilege-verification matrix; one more credential whose leak is an
incident rather than a bug.

## 1.7 Risks and accepted limitations

| # | Risk | Status if AG-1 = A |
|---|---|---|
| R-1 | Email enumeration by the auth credential — inherent, since the lookup *is* the enumeration | Accepted, disclosed. Cannot be fixed by grants; only by not having the lookup |
| R-2 | Bulk hash extraction | Accepted, disclosed |
| R-3 | Session minting for any `user_id` (AG-2 = table only) | Accepted, disclosed. Mitigated only by keeping the credential out of application code paths that do not authenticate |
| R-4 | Un-revocation cannot be prevented by a column grant | Accepted, disclosed — the grant expresses which columns may change, not in which direction |
| R-5 | Argon2id is not in core PostgreSQL, so the hash necessarily leaves the database | Accepted; not addressed by this decision |
| R-6 | `users_email_key UNIQUE (email)` is case-sensitive; normalisation is an application invariant | Untouched by AG-1; belongs to `IG-1` |
| R-7 | Both credentials are held by one API process, so compromising that process yields `app_auth` and `app_api` together — the role boundary does not survive it | Accepted, disclosed. A property of the deployment, not of the grants; hardening the process is out of scope for this decision |

None of these is resolved here. They are the price of a password-based login, and
the purpose of recording them is that item 15 of the review's Definition of Done
("no unresolved assumption presented as a control") stays satisfiable.

## 1.8 Dependencies and implementation consequences

| Depends on | Effect |
|---|---|
| none for approval | `AG-1` can be approved or rejected independently of every other decision in this document |
| `AG-2` at implementation | if the session store is the table, `sessions` grants must target the credential chosen here; that is why AG-1's sheet names no session privilege |

Consequences if approved:

1. Bootstrap change, outside the migration ledger and outside any transaction that
   touches the schema:
   - `bootstrap/roles.sql:12` — array member;
   - `bootstrap/roles.sql:22-24` — the `NOLOGIN NOSUPERUSER … NOINHERIT` line;
   - `scripts/lib/connections.mjs:26-30` — `ROLE_CONNECTIONS` entry carrying a URL
     variable and a password variable for `app_auth`;
   - `scripts/bootstrap.mjs:30-34` — `ROLE_PASSWORD_VARIABLES` entry;
   - `database.defaults.json` — a development password under `roles`, alongside the
     existing three;
   - the root env example file gains the two new variable names.

   The loop at `bootstrap.mjs:53-60` then provisions `LOGIN` with no further change,
   because it iterates `ROLE_NAMES`, which is derived from that map. The final role
   must report `rolcanlogin = true`.
2. One additive migration, `auth_boundary`: two `GRANT` statements and two
   `CREATE POLICY` statements. No `ALTER TABLE`, no column change, no rewrite.
   The role must exist first or the policy fails with `42704`.
3. `privilege-verification.mjs` gains `app_auth` rows: allow and deny per SQLSTATE
   (`42501` for grant denial), plus `has_column_privilege` probes — note that
   `has_table_privilege` reports `false` for column grants and is the wrong probe.
4. A new `auth-boundary` verification suite.
5. `ADR-004` is written and accepted in the same change that resolves `OPEN-01`.

Consequences if rejected or deferred: login cannot be implemented. There is no
fallback in the current grant model — this is not a "we can start with `app_api` and
tighten later" decision, because granting `app_api` a credential read is the very
thing `OPEN-01` declines.

## 1.9 Acceptance criteria

`[O]` The decision is correctly implemented when all of the following hold, each
with the named evidence:

1. `app_auth` exists, is `NOINHERIT`, `NOBYPASSRLS`, and has zero memberships in
   either direction — `db:verify` rows.
2. After provisioning, `app_auth` has `rolcanlogin = true`, and the process connects
   as `app_auth` with no `SET ROLE` anywhere in the path — asserted the way `db:verify`
   already asserts it for the other three roles
   (`privilege-verification.mjs:176`), plus a `current_user` check on a live
   connection.
3. `app_auth` `SELECT` on `users` is column-limited to the six named columns —
   `has_column_privilege`, plus a `SELECT` of a non-granted column failing with `42501`.
4. `app_auth` `INSERT` on `users` succeeds for `(email, password_hash)` and fails
   for any other column.
5. `app_auth` `UPDATE`/`DELETE` on `users` fails with `42501`.
6. `app_auth` holds no privilege on any tenant, weather, or catalog table — enumerated,
   not sampled.
7. `app_api` still holds no privilege on `users`.
8. The 39 tenant-isolation tests and 12 conformance tests pass unchanged.
9. The migration applies to a fresh volume, in one transaction, with the role present.
10. `db:verify` is green with the new rows included.

## 1.10 Owner decision

| Field | Value |
|---|---|
| Recommended option | **A** — dedicated `app_auth` role, `NOINHERIT`, `NOBYPASSRLS`, column grants on `app.users` only |
| Selected option | **A** — dedicated `app_auth` role with column-level grants on `app.users` |
| Decision | **Approved by repository owner** |
| Approved by | Repository owner |
| Approval date | 2026-11-18 |
| Rationale / notes | Separates credential lookup from the tenant-facing `app_api`. No access to tenant, weather, or catalog tables. The login path needs no `SECURITY DEFINER` function. The privilege boundary is verifiable through `db:verify`. |
| Accepted residual risks | `app_auth` can read every email and password hash, and can create accounts outside the registration flow (R-1, R-2, R-5). With `AG-2` = table it can also mint a session for any `user_id` and un-revoke one (R-3, R-4). Compromise of the API process yields **both** credentials together (R-7), since both clients run in one process. Enumeration is inherent: the lookup *is* the enumeration. |

```
Approved:  ☑ A   ☐ B2   ☐ other (specify): ____________      Rejected: ☐
Approved by: Repository owner   Date: 2026-11-18
```

---

# Decision 2 — AG-2: Session Storage

**Register entry:** `OPEN-13` — P1, hard blocker. Design review §17.

## 2.1 Current repository context

| Fact | Evidence |
|---|---|
| No session table, no session entity, no session grants | `[V]` 22 tables in `packages/database/prisma/schema.prisma`; `entity-catalog.md:89` lists `sessions` as *unspecified* |
| `ADR-002` D5 already recommends server-side sessions in PostgreSQL, with JWT + refresh rotation in the rejected list | `[V]` `docs/adr/ADR-002-monorepo-and-backend-architecture.md:48-50`, `:89` |
| `api-conventions.md` describes a server-side session table and the cookie/CSRF/rate-limit rules | `[V]` `docs/architecture/api-conventions.md:195-205` |
| `open-decisions.md` records `OPEN-13` as undecided | `[V]` `docs/data-model/open-decisions.md:272-275` |
| Redis is documented for other purposes but **not provisioned**: compose has one service (`db`), and `ioredis`/`bullmq` resolve to nothing in the lockfile | `[V]` `docker-compose.yml:7-9`; zero lockfile hits |
| `app_system` has no `DELETE` path to tenant or identity data | `[V]` role grants; a `DELETE` grant has no column form |

Three texts, two positions — that is the inconsistency `OPEN-13` records. This
decision settles it in one direction.

## 2.2 Problem statement

A session is read **before** its owner is known, so it cannot be a tenant-class row
and cannot go through `withTenant`. The choice is where that pre-identity read lands:
inside the database under the same credential model as the rest of identity, or in a
separate network service with its own credential and its own availability story.

## 2.3 Options

| Option | Shape | Verdict |
|---|---|---|
| **A** | `app.sessions` table in PostgreSQL, accessed only by `app_auth` | **`[P]` recommended** |
| **B** | Redis (or any external key-value store) | Legitimate, but a reversal of `ADR-002` D5 and not existing infrastructure |
| **C** | JWT, stateless | Already rejected by `ADR-002` D5; not re-opened here |

## 2.4 Recommended option

`[P]` **Option A: `app.sessions` in PostgreSQL.**

Proposed table (not created):

| Column | Type | Note |
|---|---|---|
| `id` | `uuid` PK | `uuidv7()` |
| `user_id` | `uuid` NOT NULL | references `app.users (id)` |
| `token_hash` | `text` NOT NULL | unique; `sha256(token)` only |
| `expires_at` | `timestamptz` | sliding deadline |
| `absolute_expires_at` | `timestamptz` | hard deadline |
| `revoked_at` | `timestamptz` | immediate revocation |
| `last_seen_at` | `timestamptz` | default `now()` |
| `created_at` | `timestamptz` | default `now()` |
| constraint | `CHECK (absolute_expires_at >= expires_at AND expires_at > created_at)` | `>=`, because a clamped extension makes the two coincide |

Proposed lifecycle:

1. **Issue** on successful login.
2. **Validate** on every authenticated request: not revoked, `expires_at` not passed,
   `absolute_expires_at` not passed.
3. **Sliding expiry** 30 days, extended at most once per 5 minutes per session —
   a write on every request is write amplification for no security gain.
4. **Clamp** the extension: `expires_at = LEAST(now() + interval '30 days',
   absolute_expires_at)`. Without the clamp, a session at day 70 of 90 extends to day
   100 and violates the constraint exactly when a long-lived session is most used.
5. **Revoke** on logout (`revoked_at = now()`), checked before any other validity.
6. **Purge** once `absolute_expires_at` passes, hourly, by
   `app.purge_expired_sessions()` — `SECURITY DEFINER`, owned by `migration_owner`,
   `EXECUTE` to `app_system` alone. `DELETE` has no column form, so a function is the
   only way to GC without handing a runtime role a table-wide `DELETE` grant.
7. **Absolute expiry** 90 days, unaffected by activity.

Token design: 32 bytes from a CSPRNG, base64url (43 characters), opaque, only
`sha256(token)` stored, unique index on `token_hash`.

**Why SHA-256 is right here and wrong for passwords.** A session token is 256 bits
of uniform randomness; there is no dictionary and no guessing surface, so a slow KDF
buys nothing and costs a hash per request. A password is low-entropy and reusable
across sites, so it needs a memory-hard KDF — Argon2id, per `IG-6`. Reusing SHA-256
for passwords would be a vulnerability; reusing Argon2id for tokens would be a
performance defect. The two must never be unified into one "hash password" helper.

## 2.5 Rationale

`[O]` The strongest argument is not performance — it is that `ADR-002` D5 already made
this decision and two other documents act on it. Redis here would not be a neutral
implementation detail; it would reverse an accepted architecture decision in a phase
that never claimed to revisit it, and it would add a network service that is
currently documented and not running.

PostgreSQL also inherits properties for free that Redis would need built: sessions are
covered by the existing backup/restore and audit story; expiry is testable with the
same harness as every other invariant; a failed login and a failed session read share
one failure mode. The cost is one round-trip per authenticated request, which the
existing pool absorbs, and one pre-identity read — which is the same class of read
`OPEN-01` already accepts.

## 2.6 Security and operational implications

| Aspect | PostgreSQL table | Note |
|---|---|---|
| Session authority | an `INSERT` privilege on `app.sessions`, held by `app_auth` | Under Redis it becomes "whoever holds the store credential" — the power moves, it does not disappear |
| `app_api` (tenant credential) | no privilege of any kind | `42501` on all four operations |
| `app_system` (weather credential) | `EXECUTE` on one purge function only | never a table grant |
| Revocation | immediate, one `UPDATE` | |
| Un-revocation | **possible** — a column grant cannot express direction | Disclosed, not hidden |
| Availability | one more dependency on the primary database; fail closed, `503` | A second authority as "fallback" is explicitly rejected |
| Backup / restore | covered by the existing story | Redis would need its own |
| Operations | hourly GC job in the `maintenance` queue, which does not exist yet | |
| Cost per authenticated request | one round-trip | |
| New table | one (a 23rd entity) | |

`ENABLE` + `FORCE` RLS with `sessions_auth_all FOR ALL TO app_auth USING (true) WITH
CHECK (true)` plus an owner policy. `FORCE` is retained for the same reason as on
`users`: a mistaken future grant to `app_api` returns zero rows.

Outage behaviour is fail-closed, stated once and unqualified: `/me`, login, and
logout return `503`, never anonymous access, never a second store used as a fallback.

## 2.7 Risks and accepted limitations

| # | Risk / limitation | Status |
|---|---|---|
| S-1 | One database round-trip per authenticated request | Accepted |
| S-2 | A second pre-identity read, repeating the `OPEN-01` shape | Accepted, disclosed — this is the real argument for Redis |
| S-3 | A GC job that does not exist yet | Accepted; scheduled in `maintenance` |
| S-4 | Session rows are readable by the auth credential without any tenant context | Accepted, by design |
| S-5 | Un-revocation cannot be prevented by a grant | Accepted, disclosed |
| S-6 | If option **B** is explicitly selected: `ADR-002` D5 must be amended in the same change, a compose service must be added, and the store becomes an authentication authority | Not applicable unless B is approved |
| S-7 | If **both** options are rejected: `OPEN-13` stays unresolved, `S5`/`S8` stay blocked, and no session storage exists | A recorded outcome (§2.8), not a step toward either option |

## 2.8 Dependencies and implementation consequences

| Depends on | Effect |
|---|---|
| **Approval:** none | `AG-2` can be approved or rejected independently, in either order relative to `AG-1` |
| **Implementation:** the credential chosen by `AG-1` | session code runs under that credential; the session table's grants are written against it. `S3` precedes `S5` |

Approving `AG-1` does **not** approve PostgreSQL sessions and does **not** authorise
any grant on `app.sessions`. Approving `AG-2` as a table does **not** approve
`app_auth`. The two sheets are deliberately independent so that either rejection
leaves the other decision meaningful — an owner may reasonably want the credential
boundary without a new table, or the table while deferring the fourth role.

**Four outcomes, and only one of them selects a store.** Rejecting A is not a vote for
B; the forms are separate for exactly that reason.

| Owner action | Interpretation | Consequence |
|---|---|---|
| **Approve A** | PostgreSQL `app.sessions` is selected. `ADR-002` D5 is preserved and needs no amendment | the migration, two policies, column grants, purge function, GC job, `ADR-005` |
| **Approve B** | Redis is **explicitly** selected | `ADR-002` D5 must be amended in the same change; a compose service, a store credential, and a new availability story are added; `app_auth` holds no `sessions` privilege because no table exists |
| **Reject both** | neither architecture is approved | **`OPEN-13` stays unresolved; `S5` and `S8` stay blocked; no session-storage implementation of any kind may begin.** This is a legitimate outcome, not a deferred one — it says the owner has not accepted either set of trade-offs |
| **No decision** | status stays `Pending` | nothing is implied and nothing may proceed |

Consequences if A is approved: one additive migration (`sessions` table, two policies,
column grants, the purge function), a `schema.prisma` model for representation
only, `entity-catalog.md` gains `sessions` in the **widened `identity`** class (not
a sixth class), a GC job in the `maintenance` queue, `ADR-005` written and accepted,
and new `db:verify` rows including `app_api` denials by SQLSTATE.

Consequences if B is approved: the opposite trade — no new table, no GC job, TTL and
revocation handled by the store, and in exchange an external service, a second
credential whose compromise mints sessions for anyone, a D5 amendment, and a store
whose unavailability takes login down. `S8` is written against that store instead.

Consequences if both are rejected: the work stops here. There is no third architecture
proposed, and none should be inferred — picking one is the owner's decision, not an
implementer's fallback.

## 2.9 Acceptance criteria

1. Table exists with the stated columns, constraints, `ENABLE` + `FORCE` RLS, and
   both policies.
2. `app_api` and `app_system` hold no table privilege: `42501` on `SELECT`, `INSERT`,
   `UPDATE`, `DELETE`.
3. Only `sha256(token)` is stored; the raw token appears in no column and no log.
4. `token_hash` is unique and enforced by the database.
5. Sliding extension is clamped: a session at day 70 of 90 extends to
   `absolute_expires_at`, not day 100, and the row still satisfies the constraint.
6. A session whose `expires_at` has been clamped is rejected once that instant
   passes — clamping must not create a session outliving its absolute deadline.
7. Logout sets `revoked_at` and the very next validation fails.
8. The purge function returns the **count of rows deleted by that run**; a `0` count
   is not treated as a failed job — job health is read from the queue record.
9. The migration applies to a fresh volume.
10. The §12.2 session suite and the existing 39 isolation tests pass.

## 2.10 Owner decision

| Field | Value |
|---|---|
| Recommended option | **A** — PostgreSQL table `app.sessions`, preserving `ADR-002` D5 |
| Selected option | **A** — PostgreSQL `app.sessions`, accessed only by `app_auth`; opaque 32-byte CSPRNG tokens, base64url, only `sha256(token)` stored, 30-day sliding and 90-day absolute expiry, explicit revocation via `revoked_at`, hourly garbage collection |
| Decision | **Approved by repository owner** |
| Approved by | Repository owner |
| Approval date | 2026-11-18 |
| Rationale / notes | Preserves `ADR-002` D5. PostgreSQL is already provisioned and already covered by backup and restore. No Redis infrastructure dependency is added. Session lifecycle and the privilege boundary are testable with the existing database harness. |
| Accepted residual risks | One database round-trip per authenticated request (S-1) and a second pre-identity read (S-2), which is the real argument for Redis. A GC job that does not exist yet (S-3). Session rows readable by the auth credential without a tenant context (S-4). Un-revocation cannot be prevented by a column grant (S-5). S-6 and S-7 do not apply: option B was not selected and neither option was rejected. |

```
Approved A (PostgreSQL table):  ☑
Approved B (Redis, requires ADR-002 D5 amendment in the same change):  ☐
Rejected both (OPEN-13 stays unresolved; no session storage may be implemented):  ☐
Approved by: Repository owner   Date: 2026-11-18
```

Exactly one box is marked. Two marked boxes would leave the decision unmade; none
marked would have meant no decision, not a rejection.

---

# Decision 3 — IG-5: Authentication API Error Contract

**Gate:** implementation gate. Design review §15.2.

## 3.1 Current repository context

| Fact | Evidence |
|---|---|
| An error envelope exists as prose, with one worked example | `[V]` `docs/architecture/api-conventions.md:25-35` |
| A status/code table exists | `[V]` same file `:37-47` |
| `DATA_STALE` is explicitly **not** an error code | `[V]` same file, following paragraph |
| `apps/api` has no exception filter and no envelope code | `[V]` four source files: `main.ts`, `app.module.ts`, `health/*` |
| No error-code enum exists in contracts | `[V]` `grep` over `packages/contracts/src` returns no hit for `UNAUTHENTICATED`/`RATE_LIMITED` |
| `packages/contracts` holds shared Zod schemas and is consumed by `apps/api` via `workspace:*` | `[V]` `apps/api/package.json` dependencies |

## 3.2 Problem statement

Authentication introduces failure modes the current table does not cover: a login
that must not reveal whether an account exists, a session store that is unreachable,
and an error that must be indistinguishable between "wrong password" and "no such
user". Without a decision, the exception filter author will invent the codes, and the
contract will be defined by whichever string appears first in `throw new
UnauthorizedException('...')`.

## 3.3 Options

| Option | Shape | Verdict |
|---|---|---|
| **A** | Extend the existing envelope and code table by exactly one code, shared through `packages/contracts` | **`[P]` recommended** |
| **B** | A separate authentication error format | Rejected: two envelopes means every client writes two decoders and one of them drifts |
| **C** | Leave the contract to the implementer | Rejected: this is what `IG-5` exists to prevent |

## 3.4 Recommended option

`[P]` **Option A: extend, do not fork.** Seed the enum from `api-conventions.md:37-47`
and add exactly one code for dependency unavailability.

### Decided mapping

| Status | Code | Use in the auth subsystem | New? |
|---|---|---|---|
| 400 | `VALIDATION_FAILED` | malformed body, unknown field, bad UUID in a body/query | existing |
| 401 | `UNAUTHENTICATED` | no session, expired session, revoked session — **and a failed login** | existing |
| 403 | `FORBIDDEN` | authenticated, not the owner of the addressed resource | existing |
| 404 | `*_NOT_FOUND` | resource missing or not owned — never distinguished | existing |
| 409 | `CONFLICT` | duplicate registration (`IG-2` has not chosen this yet) | existing |
| 429 | `RATE_LIMITED` | login/register attempts over budget, with `Retry-After` | existing |
| 503 | `PROVIDER_UNAVAILABLE` | weather provider has no usable value and no permitted fallback — **weather only, as currently worded** | existing |
| 503 | **`DEPENDENCY_UNAVAILABLE`** | session store / database unreachable | **approved 2026-11-18** |

`[O]` The one genuinely open wording question — `503 PROVIDER_UNAVAILABLE` already
exists for a *weather* dependency — was put to the owner rather than settled by the
implementer. Two readings were defensible and they produce different clients:

- **C-1 (approved)** — add one code, `DEPENDENCY_UNAVAILABLE`, and keep
  `PROVIDER_UNAVAILABLE` for weather providers only. Explicit, at the cost of two
  distinct 503 codes that clients must handle.
- **C-2 (not selected)** — redefine `PROVIDER_UNAVAILABLE` as "any upstream dependency
  is unavailable" and add no code at all. Simpler client surface, but it widens the
  meaning of a code the provenance contract already relies on, and a weather-specific
  `retryAfter` semantic would then apply to a database outage.

The owner selected **C-1** on 2026-11-18: the two codes stay distinct so that a client
can tell a weather outage from an authentication-infrastructure outage, and
`PROVIDER_UNAVAILABLE` keeps its existing meaning in the weather domain. The trade-off
accepted with it is two 503 codes on the client side.

### Behavioural rules the contract must carry

| Rule | Statement |
|---|---|
| Generic login failure | wrong password and unknown email return the **same** status, code, message, and body shape. The `message` is user-facing Indonesian copy; it must not be assembled per-case |
| Timing | the login path still performs a dummy-hash verification on the unknown-email branch, so response time does not disclose existence. `[O]` this is a behaviour rule, not an error code, but it is part of the same contract |
| Rate limiting | evaluated **before** the account lookup and before Argon2id. A rejected attempt must not pay the hashing cost |
| Store unreachable | fail closed: `503`, no anonymous fallback, no second authority |
| Leakage | no response body, `details` entry, or log line may contain a password, a password hash, a raw session token, or a `token_hash` |
| `requestId` | present on every error, matching the request-id middleware |

## 3.5 Rationale

`[O]` One envelope means one decoder. The existing table already covers four of the
auth subsystem's five failure classes without a single new code, which is evidence
that the vocabulary is not auth-hostile and does not need its own dialect. The only
genuinely new condition is "the thing I depend on is down", and that is worth one
distinct code because a client's correct reaction (back off and retry) differs from
its reaction to `VALIDATION_FAILED` (fix the request).

Sharing the enum through `packages/contracts` rather than duplicating strings in
`apps/api` is what makes the contract testable: a test can assert the enum member, the
status, and the body shape against the same object the server uses, so a filter
change that alters one without the others fails a test rather than a client.

## 3.6 Security and operational implications

- The generic-login rule is a security property enforced by the contract: if the
  filter maps "user not found" to `404 USER_NOT_FOUND` and "wrong password" to `401`,
  the contract has created an account-enumeration oracle faster and cheaper than
  timing. The enum must not contain a member that distinguishes the two.
- A dependency-unavailability code makes outages observable to clients instead of
  arriving as a generic 500, which also means outages become part of the public
  contract and cannot be renamed casually.
- No new infrastructure. This is a naming and mapping decision, not a monitoring one.

## 3.7 Risks and accepted limitations

| # | Risk / limitation | Status |
|---|---|---|
| E-1 | Two 503 codes exist under C-1 | Accepted if C-1 is chosen; stated in the client table |
| E-2 | The contract cannot stop an implementer from throwing a raw `Error` that the filter maps to 500 | Mitigated by the filter being the only place status is chosen; enforced by contract tests |
| E-3 | `message` copy is user-facing and localized; code is stable, message is not | Accepted — clients must key on `code` |
| E-4 | Duplicate-registration disclosure (`IG-2`) is decided elsewhere; this contract only reserves `409` | Explicitly out of scope |

## 3.8 Dependencies and implementation consequences

| Depends on | Effect |
|---|---|
| **Approval:** none | independent of the other three |
| Implementation: none (it gates S1/S2) | but S7 depends on it plus `IG-1/2/3/4/6/7/10` |

Consequences if approved: an error-code enum and error/response envelope schemas in
`packages/contracts`; a NestJS exception filter in `apps/api` that maps each contract
exception class to one status and one code; contract tests asserting status, code, and
body shape; an `api-conventions.md` amendment if C-2 is chosen.

If deferred: S1 cannot start, which means S2 cannot start, which means the register
and login endpoints have no envelope to return. The blocked surface is the whole API
track, not one endpoint.

## 3.9 Acceptance criteria

1. One response envelope and one error envelope, defined once in `packages/contracts`.
2. Stable, machine-readable `code` values; no free-form strings on the error path.
3. Status mapping matches the agreed table for every listed code, asserted by test.
4. Failed login is indistinguishable between unknown email and wrong password —
   status, code, message, and body shape identical; asserted by test.
5. Rate limiting occurs before lookup and before Argon2id; asserted by test order,
   not by prose.
6. Store outage returns the agreed 503 code, never anonymous access.
7. No password, hash, raw token, or `token_hash` in any response body or `details`
   entry; asserted by a negative test that greps serialized output.
8. `requestId` present on every error response.
9. Contract tests cover status and shape for each code.

## 3.10 Owner decision

| Field | Value |
|---|---|
| Recommended option | **A** — extend the existing envelope; seed the enum from `api-conventions.md:37-47`; add exactly one dependency-unavailability code (C-1) |
| Selected option | **A / C-1** — one shared error envelope, plus one new code `DEPENDENCY_UNAVAILABLE`; `PROVIDER_UNAVAILABLE` stays specific to weather providers |
| Decision | **Approved by repository owner** |
| Approved by | Repository owner |
| Approval date | 2026-11-18 |
| Rationale / notes | Specific meanings: a client can distinguish a weather outage from an authentication-infrastructure outage. `PROVIDER_UNAVAILABLE` keeps its existing semantics in the weather domain, so the provenance contract is untouched. |
| Accepted residual risks | Two distinct 503 codes exist and clients must handle both (E-1). The `message` is user-facing copy and may change; clients must key on `code` (E-3). The contract cannot prevent an implementer throwing an unmapped `Error` — that is the filter's job and the contract tests' subject (E-2). Duplicate-registration disclosure (`IG-2`) stays outside this decision (E-4). |

```
Approved:  ☑ A (C-1: one new code)   ☐ A (C-2: widen PROVIDER_UNAVAILABLE)   ☐ other (specify): ____________      Rejected: ☐
Approved by: Repository owner   Date: 2026-11-18
```

---

# Decision 4 — IG-11: API Test Runner

**Gate:** implementation gate. Design review §15.2.

## 4.1 Current repository context

| Fact | Evidence |
|---|---|
| `packages/database` uses `node:test` | `[V]` `packages/database/package.json:22`, `:30-31` — `node --test test/unit/*.test.mjs` |
| `packages/contracts` uses Vitest | `[V]` `packages/contracts/package.json:28` — `vitest run` |
| `apps/api` has no real test runner; its script prints a string | `[V]` `apps/api/package.json` — `"test": "node -e \"console.log('[api] no tests in Phase 2.0')\""` |
| The repo has never chosen between the two | `[V]` two runners coexist; `IG-11` exists because of this |
| Existing suites all live at the database layer, where the isolation guarantees actually are | `[V]` `db:verify` 355 assertions, `test:rls` 39, `test:schema` 12, unit 9 |

## 4.2 Problem statement

`apps/api` will need tests that fail for the right reason: an envelope mismatch, a
filter that leaks a token, a guard that skips the revocation check. Without a chosen
runner, the first person to add a test decides the tooling, and the choice is then
defended as precedent rather than judged on merit.

## 4.3 Options

| Criterion | `node:test` | Vitest |
|---|---|---|
| Already used in the repo | yes — `packages/database`, where privilege and RLS assertions live | yes — `packages/contracts` |
| Additional dependency | none — runtime built-in | `vitest`, plus its config |
| Setup for a NestJS TypeScript app | needs a compile step or a TS loader; the database package already builds first and tests `.mjs` | transformers and DI fixtures work without extra wiring |
| Watch mode / DX | minimal | richer |
| Reporting | TAP, adequate for CI | richer |
| Match with the existing test style | `.mjs` asserts, no framework API | `describe`/`it`/`expect` |
| Maintenance surface | zero new packages | one more major-version tracking obligation |

`[O]` This comparison is proportional to a repository with two small packages and no
UI; it is not a general argument about test frameworks.

## 4.4 Recommended option

`[P]` **`node:test`**, matching `packages/database`.

Two reasons, in order of weight:

1. `node:test` adds no dependency, and the API tests that matter most are not
   mock-only unit tests — they are tests against a real database with real role
   grants. Those are closer in kind to what `packages/database` already does than to
   what `packages/contracts` does, and they will need a compiled build and a live
   connection regardless of runner.
2. A third runner is not on the table, so the choice is which existing convention to
   extend. The database convention is the one whose subject matter the API tests
   share.

What is not claimed: `node:test` is better in general. Vitest would be the better
choice if the API grew a large component-level or snapshot-heavy suite; that is not
what Phase 3.2 needs.

## 4.5 Rationale

`[O]` `node:test` was chosen on cost and on subject matter, not on capability.

`packages/database` already compiles then runs `.mjs` tests with `node --test`, and
the API tests that carry security weight — privilege denial, column-grant boundary,
tenant isolation — are the same kind of test against the same database. Matching that
convention means the API suite can reuse the existing harness shape instead of
introducing a second one beside it.

Vitest is not a worse tool. It is the better tool for a large component-level or
snapshot-heavy suite, and `packages/contracts` is a reasonable home for it because
those tests are pure schema assertions with no external system. The API is not that:
its meaningful tests need a live connection and a build, which neutralises most of
Vitest's ergonomic advantage and leaves the dependency as the only difference.

A third runner is not proposed. The repository will keep two; that is a stated
limitation, not an oversight.

## 4.6 Security and operational implications

- The runner choice does not change any security property. What it changes is whether
  a security property is testable at all: privilege denials, column-grant boundaries,
  and tenant isolation must be asserted against a real database, and a mock-only
  suite cannot stand in for them.
- A repeatable test environment means the database-backed API tests run against the
  same compose service on `127.0.0.1:5442` with the same roles, not a fixture
  pretending to be one.
- Operationally: one `test` command with a real exit status, so CI can fail on it.
  A script that prints a string always exits 0, which is worse than no script.

## 4.7 Risks and accepted limitations

| # | Risk / limitation | Status |
|---|---|---|
| T-1 | `node:test` needs a build step before running against TypeScript sources | Accepted; `packages/database` already does this |
| T-2 | Less ergonomic assertions than `expect` | Accepted; `node:assert` is sufficient for status/shape assertions |
| T-3 | Two runners remain in the repo | Accepted. This decision does not merge them, and nothing here proposes to |
| T-4 | Database-backed API tests require a running database | Accepted; the same precondition already applies to `db:verify` and the RLS suites |

## 4.8 Dependencies and implementation consequences

| Depends on | Effect |
|---|---|
| **Approval:** none | independent of the other three |
| Implementation: none | but every API-level test in the review's §12 stays blocked until it is chosen |

Consequences if approved: `apps/api` gains a real `test` script; a repeatable
environment for database-backed tests; the existing placeholder script is replaced;
CI gains one command that can fail. No dependency is installed by this decision
record — installation is implementation.

## 4.9 Acceptance criteria

1. `apps/api` has a `test` command that executes tests and exits non-zero on failure.
2. The environment is repeatable: same command, same roles, same database, from a
   clean checkout.
3. Unit and integration tests are both supported, including tests that need a live
   database connection.
4. CI-compatible: non-interactive, no watch mode by default.
5. At least one test that asserts a real database denial (`42501`) exists — a
   mock-only suite is explicitly insufficient for privilege and tenant-isolation
   guarantees.
6. No placeholder script remains.

## 4.10 Owner decision

| Field | Value |
|---|---|
| Recommended option | **`node:test`**, matching `packages/database` |
| Selected option | **`node:test`** — the built-in Node.js test runner for `apps/api` |
| Decision | **Approved by repository owner** |
| Approved by | Repository owner |
| Approval date | 2026-11-18 |
| Rationale / notes | Already used by `packages/database`. Adds no dependency, so no third runner enters the repository. Fits the integration and security tests that need a real PostgreSQL and real privilege grants. |
| Accepted residual risks | API TypeScript needs a compile step or a TS loader before the tests run (T-1). Less ergonomic assertions than `expect` (T-2). Two runners continue to coexist — `node:test` and Vitest — which this decision records rather than resolves (T-3). Database-backed API tests require a running database (T-4). |

```
Approved:  ☑ node:test   ☐ Vitest   ☐ other (specify): ____________      Rejected: ☐
Approved by: Repository owner   Date: 2026-11-18
```

---

# Decision independence and dependency matrix

Two different relations, kept apart so a split gate does not become a chain.

| Decision | Approval dependency | Implementation dependency |
|---|---|---|
| `AG-1` | **None** | Required before the authentication database boundary (`S3`, `S4`) |
| `AG-2` | **None** | Session implementation uses the credential boundary selected by `AG-1` (`S3` before `S5`) |
| `IG-5` | **None** | Required before exception-filter implementation (`S1`, `S2`) |
| `IG-11` | **None** | Required before API test infrastructure and API test work (`S2`) |

| Relation | Meaning | Consequence |
|---|---|---|
| **Approval dependency** | one decision's *answer* presupposes another's | none exists among these four. Each can be approved or rejected on its own, in any order |
| **Implementation dependency** | one piece of code can only be written once another exists | `AG-2` → the credential `AG-1` selects; `S1`/`S2` → `IG-5` and `IG-11`. This constrains the order of work, not the order of decisions |

Specifically:

- Approving `AG-1` does **not** approve PostgreSQL sessions, does **not** authorise a
  grant on `app.sessions`, and does **not** pre-empt `AG-2`.
- Approving `AG-2` does **not** approve `app_auth`.
- Approving all four does **not** discharge `IG-1`, `IG-2`, `IG-3`, `IG-4`, `IG-6`,
  `IG-7`, `IG-8`, `IG-9`, or `IG-10`.

# Implementation readiness matrix

Sequence preserved from design review §18. "Unblocked" means the step's own gate is
satisfied — not that the step is complete.

| Step | Work | Gate | Unblocked by |
|---|---|---|---|
| S0a | Answer `AG-1`, `AG-2` | — | this document |
| S0b | Answer `IG-5`, `IG-11` | — | this document |
| S1 | Contracts: response/error envelope, error-code enum, `requestId` | `IG-5`, `IG-11` | `IG-5` + `IG-11` |
| S2 | API plumbing: `/v1` prefix, `ValidationPipe`, exception filter, request-id, cookie parser, helmet, trust-proxy, CORS, database client | `IG-11` | `IG-11` (filter needs `IG-5`) |
| S3 | Bootstrap `app_auth`: role, secret map, `connections.mjs`, `.env.example` | `AG-1` | `AG-1` |
| S4 | Migration `auth_boundary`: 2 policies, 2 column grants | S3 | `AG-1` + S3 |
| S5 | Migration `sessions` + policies + grants + purge function | `AG-2`, S4 | `AG-2` + S4 |
| S6 | `privilege-verification.mjs` `EXPECTED` + `has_column_privilege` probes; `auth-boundary` suite | S4 (and S5) | S4 |
| S7 | Register + login: schemas, Argon2id, dummy hash, rate limit before lookup, generic failures | S1, S2, S4, `IG-1/2/3/4/6/7/10` | **not** unblocked by these four alone |
| S8 | Session guard, `/me`, logout, sliding expiry, purge wiring | S5, S6, `IG-8/9` | **not** unblocked by these four alone |
| S9 | Docs reconciliation: `ADR-004`/`ADR-005` accepted, `entity-catalog` `sessions` in widened `identity`, `api-conventions` amendments, `auth-deferred.md` pointer, `IMPLEMENTATION_STATUS` | everything above | — |

So the honest statement of what these four decisions buy: **Track 1 can start**
(contracts and plumbing), and **Track 2 can start** (the database boundary and
sessions). Track 3 cannot — `S7` and `S8` additionally require `IG-1` through `IG-4`,
`IG-6` through `IG-10`, none of which is answered here and none of which changes the
boundary.

**As of 2026-11-18 the gates for S1, S2, S3, S4, and S5 are satisfied by approval.**
They are not satisfied by work: no contract schema, no exception filter, no `app_auth`
role, no migration, and no verification row exists yet.

# What these decisions do not settle

| Not settled | Where it lives | Blocks |
|---|---|---|
| Email normalisation: application invariant or unique index | `IG-1` | first registration |
| Duplicate registration: `409` or always `202` | `IG-2` | register endpoint |
| Register auto-login vs separate login | `IG-3` (needs `AG-2`) | register endpoint |
| Password policy: length, byte cap, composition | `IG-4` | `registerRequestSchema` |
| Argon2id parameters, measured on the deploy host | `IG-6` | hashing implementation |
| Per-account brute-force control | `IG-7` | production, not implementation |
| Cookie name and `__Host-` prefix | `IG-8` | first cookie set |
| CSRF mechanics: header, token length, comparison, rotation | `IG-9` | first non-GET endpoint |
| Email verification | `IG-10` | public deployment |
| `updated_at` trigger on `users` | `OPEN-19` | untouched by 3.2 |
| Account deletion policy | `OPEN-04` | no endpoint, no column |
| Signed tenant context | `OPEN-28` (`DEFERRED`) | — |
| `app_auth` enumeration / impersonation exposure as a stated limitation | Definition of Done item 15 | completion claims |

No `OPEN` disposition has changed in `docs/data-model/open-decisions.md`, no ADR has
been created or modified, and no implementation exists for any of the above.

`IG-1` through `IG-4` and `IG-6` through `IG-10` are **not** approved by this record and
were not part of it. Only `AG-1`, `AG-2`, `IG-5`, and `IG-11` were put to the owner, and
only those four carry an approval date.

`OPEN-01` and `OPEN-13` remain **unresolved** despite their decisions being approved.
The review's rule stands: a disposition moves to `RESOLVED` when the ADR is accepted,
the migration is applied, and the verification evidence is green — three facts about
the repository, none of which an approval can supply.

# Source inconsistencies encountered while preparing this record

| # | Observation | Action taken |
|---|---|---|
| 1 | The Phase 3.2.2 brief cites "design review §15.2 and `api-conventions.md`" for `IG-5`; §15.2 recommends "seed from `api-conventions.md:37-47`", which is the status/code table — verified present at those lines | none; cited as written |
| 2 | `api-conventions.md` already defines `503 PROVIDER_UNAVAILABLE` for weather providers. "Add exactly one code for dependency unavailability" is therefore ambiguous about whether a second 503 code is intended | reported, not resolved: C-1/C-2 presented in §3.4 for the owner |
| 3 | The brief refers to "design review §16" for `AG-1` privileges including nothing on sessions; §16 is consistent, but `app.sessions` grant details live in §4.3 | none; both referenced |

No inconsistency was found serious enough to justify editing the design review, and
it was not edited.
