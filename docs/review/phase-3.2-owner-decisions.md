# Phase 3.2.2 — Owner Decision Record: Authentication & Tenant Identity

| Field | Value |
|---|---|
| Status | **OWNER DECISIONS RECORDED** — 4 of 4 decided on 2026-11-18, plus 2 follow-ups (`IG-5-A1`, `IG-12`) recorded 2026-11-18 |
| Prepared from | `8799160` (`docs(review): split approval from implementation dependency`) |
| Authoritative source | `docs/review/phase-3.2-design-review.md` (verdict: `READY FOR OWNER DECISIONS`) |
| Decisions requested | 4 — `AG-1`, `AG-2`, `IG-5`, `IG-11` |
| Owner decisions made so far | **4 of 4**, plus `IG-5-A1` (amendment) and `IG-12` (new gate) |
| Decision approval status | **Complete** — every gate this file asked for is answered |
| Implementation status | **Snapshot at 2026-11-18; live status is `docs/IMPLEMENTATION_STATUS.md`** — at that date `S1` and `S2` were implemented and `S3` onward was not started. Since then `S3`/`S4` (`b9a27c6`, `cf0d1c2`), `S5` (`8fb2270`), and `S6` (`e9d1621`) shipped; the canonical development database is at 5/5 and `OPEN-13` was resolved on 2026-11-20. Nothing in this file's decisions changed |
| Verification status | **Green at `75607d8`, reviewed** — build, typecheck, test, lint, prettier, `git diff --check` all exit `0`; api 76, contracts 187, database 9, 0 failing |
| Remaining blockers before `S3` | **None documentation-wise** — `ADR-004` was accepted on 2026-11-18 (see the ADR status row). `S3` may begin subject to its own implementation prerequisites (§16 of the plan: test-file authorization, a cluster-admin bootstrap path, an isolated compose project). `ADR-005` gates `S5`, not `S3`. The `IG` gates block **S7** (`IG-1`–`IG-4`, `IG-6`, `IG-7`, `IG-10`) and **S8** (`IG-8`, `IG-9`), not the database boundary |
| ADR status | `ADR-004` **Accepted** 2026-11-18 and `ADR-005` **Accepted** 2026-11-20 (approver: Akihira77) — they formalise `AG-1` and `AG-2`; `ADR-005` gates `S5`, and the three schema details it needed are decided as `D-1`–`D-3` in §2.11 (2026-11-20). Neither ADR invents a decision beyond its approval, and `AG-1`/`AG-2` are **not** re-opened or asked for again. `ADR-006` **Accepted** 2026-11-21 records Amendment 3 (`IG-8`, `IG-9`) |
| `OPEN-nn` dispositions changed | **No, at the time of these decisions** — `OPEN-01` and `OPEN-13` were both unresolved then; `OPEN-13` was resolved on 2026-11-20 on `ADR-005`'s three-part Definition of Done (see `docs/data-model/open-decisions.md` §5). `OPEN-01` remains unresolved |
| Amendment 3 — 2026-11-21 | Three owner approvals recorded after this document was written: `OPEN-01`'s boundary confirmed as final, `IG-8` (session cookie) and `IG-9` (CSRF) decided. They are recorded in **Amendment 3** at the end of this file, with `ADR-006` as their durable record. Nothing above this row is rewritten; the rows above describe 2026-11-18 and 2026-11-20 as they were |

This record exists so the owner can decide without reading 1,100 lines of review. It
restates the review's recommendations; it does not add to them. Where a detail is
shortened, §16 and §17 of the review remain the authority.

**Approval is not implementation.** When this record was written, the four decisions
below were recorded and no code, migration, role, grant, policy, or ADR existed because
of them. That was accurate on 2026-11-18 before S1. `OPEN-01` and `OPEN-13` stay below
`RESOLVED`: per the review's Definition of Done, resolution requires an accepted ADR
**and** an applied migration **and** green verification evidence — not an approval.
That held on 2026-11-18. `OPEN-13` met all three on 2026-11-20 (accepted `ADR-005`,
`20261118050000_sessions` applied to the canonical development database, `test/rls/
auth-boundary.test.mjs` green there) and is recorded `RESOLVED`. `OPEN-01` stays open:
the boundary exists, but no login path reads a credential through it.

**Update, 2026-11-18 (post-S2).** Two of the tracks this record unblocked now have
work behind them: `S1` (contracts) at `c44cf5b`, `0bb9792`, `38486fd`, `75607d8`; `S2`
(API plumbing) at `ad6235b`, with remediation at `6d36741`, details and path hardening
at `c762171`, the shared path grammar at `38486fd`, and parser and numeric-segment
correctness at `75607d8`. That changes implementation status only. The approvals, their
dates, and the register's dispositions above are untouched; `S3` and everything after it
still has no code, and `OPEN-01`/`OPEN-13` still need the ADR and migration they always
needed.

## Recorded decisions

| ID | Decided | Date | Approver |
|---|---|---|---|
| `AG-1` | **A** — dedicated `app_auth` role, column grants on `app.users` only | 2026-11-18 | Repository owner |
| `AG-2` | **A** — PostgreSQL `app.sessions`, preserving `ADR-002` D5 | 2026-11-18 | Repository owner |
| `IG-5` | **A / C-1** — shared envelope plus one new code, `DEPENDENCY_UNAVAILABLE` | 2026-11-18 | Repository owner |
| `IG-5-A1` | **Add `INTERNAL_ERROR`** (500) — amendment to `IG-5`, recorded 2026-11-18 during S2; `DEPENDENCY_UNAVAILABLE` unchanged | 2026-11-18 | Repository owner |
| `IG-11` | **`node:test`** for `apps/api` | 2026-11-18 | Repository owner |
| `IG-12` | **Zod-only request validation**, bound per controller parameter; no global pipe | 2026-11-18 | Repository owner |

`IG-5-A1` is an amendment, not a fifth gate: it extends `IG-5`'s code set and changes
no other decision. The original four approvals are untouched, and `IG-5`'s text still
reads "exactly one new code" because that is what was approved at the time. See
"Amendment 1" after Decision 3.

`IG-12` is a new implementation gate raised during S2, not an amendment: the validation
engine is not part of the error contract, so it is not an `IG-5` footnote. See
"Amendment 2" immediately after Amendment 1.

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
| `IG-12` | Request-validation engine | implementation gate | before the first validated parameter | S2, every endpoint that takes input |
| `OPEN-01` | Credential lookup boundary — **confirmed** as the dedicated `app_auth` role | `OPEN-01` (P1) | — | S7, S8 (implementation only) |
| `IG-8` | Session cookie name and attributes | implementation gate | before the first cookie set | S8 |
| `IG-9` | CSRF mechanism | implementation gate | before the first non-GET endpoint | S8 |

`AG-1`/`AG-2` are architecture decisions. `IG-5`/`IG-11` are convention decisions
that would otherwise be made by whoever writes the first file. Both kinds are
recorded here because both are owed by the owner before the corresponding track can
start, and the four together are what §20 of the design review names as the
precondition for implementation. `IG-12` was raised during S2 and is listed for the
same reason: without it, the first endpoint that takes input picks its own validation
engine by default.

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
(`phase-3.2-design-review.md` §3 — "a second client in the same process"). The
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
one process (`phase-3.2-design-review.md` §3), so an attacker who owns that process —
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

## 2.11 Owner decisions on the ADR-005 schema proposals — D-1 to D-3

`AG-2` approved the architecture; it did not decide three schema details that the
implementation needs. The ADR review recorded them as *not approved* rather than
shipping them by default. The owner has now decided all three. They **supplement**
`AG-2`; they do not amend or supersede it.

| Field | Value |
|---|---|
| Decision date | 2026-11-20 |
| Approved by | Repository owner |
| Recorded in | `docs/adr/ADR-005-session-storage.md` §"Accepted owner decisions on schema details" |
| Relationship to `AG-2` | additive; `AG-2` §2.4 and §2.10 are unchanged |

### `D-1` — `token_hash` shape CHECK: **ACCEPT**

```sql
CONSTRAINT sessions_token_hash_shape_check
  CHECK (token_hash ~ '^[0-9a-f]{64}$')
```

`token_hash` must be exactly 64 lowercase hexadecimal characters. The database rejects
any other representation, so a bug that stored the 43-character base64url token fails
with `23514` instead of persisting a working credential. The CHECK validates the
**representation**; it does not prove the value was derived by SHA-256, and derivation
remains the application's responsibility. It does not touch the password path
(`IG-6`).

### `D-2` — Absolute expiration cap CHECK: **ACCEPT**

```sql
CONSTRAINT sessions_absolute_expiry_cap_check
  CHECK (absolute_expires_at <= created_at + INTERVAL '90 days')
```

The initial `absolute_expires_at` cannot exceed 90 days after `created_at`, and
`created_at` is outside both the `INSERT` and the `UPDATE` grant, so the caller cannot
move the anchor to fit a longer deadline. A 91-day initial value fails with `23514`.
This is a **maximum, not an equality**: the application still chooses a value inside the
bound, and a shorter session is legal. The consequence is stated in
`ADR-005`: the insert must derive both deadlines from SQL `now()`, not from a
JavaScript clock.

### `D-3` — Two additional indexes: **ACCEPT**

```sql
CREATE INDEX sessions_user_id_idx             ON app.sessions (user_id);
CREATE INDEX sessions_absolute_expires_at_idx ON app.sessions (absolute_expires_at);
```

| Index | Intended query path |
|---|---|
| `sessions_user_id_idx` | user-scoped session lookup and revoke-all-sessions-for-a-user |
| `sessions_absolute_expires_at_idx` | garbage-collection selection by `absolute_expires_at` |

An index supports a path; it does not guarantee a plan. No further index is approved,
and the request path still uses the `token_hash` unique constraint.

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

# Amendment 1 — 2026-11-18: `INTERNAL_ERROR` (extends `IG-5`)

**Not part of the original `IG-5` approval.** Decision 3 above added exactly one code,
`DEPENDENCY_UNAVAILABLE`, and that text is unchanged — including the words "exactly one
code", which were true of what was approved. This amendment records a second code,
decided during the S2 implementation review because the gap became concrete there rather
than remaining hypothetical.

## What was missing

`IG-5` fixed the *authentication* failure vocabulary. It did not say what `500` returns,
because the table had no `500`: every documented code was a 4xx or one of the two 503s.
`errorResponseSchema` is a strict object and `errorCodeSchema` is closed, so an
unexpected exception had no contract-valid body it could produce. S2 requires exactly
that — "unknown exceptions must fail closed and return a generic internal error
response" — and the filter could only satisfy it by violating the contract.

| Option | Outcome | Verdict |
|---|---|---|
| Reuse `DEPENDENCY_UNAVAILABLE` with `503` | A programming error is reported as an infrastructure outage and becomes retryable; clients retry something that will fail identically | rejected |
| Emit `500` with an off-contract code | Breaks the closed set and every client's exhaustive switch | rejected |
| Add one code for `500` | A bug stays a bug and an outage stays an outage | **selected** |

The reason this is a decision rather than an implementation detail is the same reason
`IG-5` existed: a code that appears first in a `throw` becomes the contract by default.

## The decision

| Field | Value |
|---|---|
| ID | `IG-5-A1` |
| Extends | `IG-5` (A / C-1) — does not replace, reinterpret, or reopen it |
| Decision | `INTERNAL_ERROR` added to `singletonErrorCodeSchema`; HTTP status `500` |
| Approved by | Repository owner |
| Date | 2026-11-18 |
| Basis | S2 remediation review: the filter cannot fail closed at `500` with the original set |
| Contract effect | One new singleton code; `NotFoundErrorCode` brand, envelope shapes, and all other codes unchanged |

Conditions attached to it:

1. `INTERNAL_ERROR` maps to `500` and to nothing else. It is not retryable, and no
   client should treat it as a signal to retry.
2. It exposes no internal detail — no stack, no SQL, no DSN, no exception message,
   no submitted value — in the response body **or** in the log. The log line carries
   `requestId`, `status`, `code`, exception class name, and environment only.

   *Amended 2026-11-18, in the same phase:* the class name was replaced by a fixed
   category — `HttpException`, `Error`, or `Unknown` — because `Error.name` is a
   mutable string and therefore not a safe field. This tightens the condition; the
   list of what may be logged is unchanged and shorter.
3. It never displaces a more specific code a handler can justify. A handler that knows
   what failed maps to the 4xx or 503 that says so; `INTERNAL_ERROR` is the residue.
4. `PROVIDER_UNAVAILABLE` and `DEPENDENCY_UNAVAILABLE` keep the meanings approved in
   Decision 3. Nothing here merges or widens them.

## Counts after the amendment

| Field | Value |
|---|---|
| Original decisions | **4** — `AG-1`, `AG-2`, `IG-5`, `IG-11` |
| Amendments | **1** — `IG-5-A1` |
| Entries in the recorded-decisions table | **5** |
| `OPEN-nn` dispositions changed | **No, at this date** — `OPEN-13` has since been resolved (2026-11-20); `OPEN-01` remains unresolved |
| Other `IG-nn` approved | **None** — `IG-1`–`IG-4` and `IG-6`–`IG-10` remain unanswered |

An amendment is not a new gate and does not unblock anything: `S1` and `S2` were already
unblocked by `IG-5` and `IG-11`. It narrows what `S2` may emit.

---

# Amendment 2 — 2026-11-18: request validation engine (`IG-12`)

This is a **new implementation gate**, not an `IG-5` amendment. Validation is not part of
the error contract; it produces an error, but the engine that produces it is a separate
choice. It is recorded here because this file is the Phase 3.2 decision log.

## What was inconsistent

The architecture already said Zod twice, in prose:

| Fact | Evidence |
|---|---|
| `api-conventions.md` names Zod as the request-validation mechanism and promises OpenAPI generated from Zod | `[V]` `docs/architecture/api-conventions.md` §12, §11 |
| `packages/contracts` defines every shared schema in Zod and is consumed by `apps/api` | `[V]` `packages/contracts/src/*` |
| S2 shipped a NestJS `ValidationPipe` over `class-validator` decorators instead | `[V]` `ad6235b`, `apps/api/src/http/validation.pipe.ts` at that commit |
| The design review's own S2 row named that global pipe | `[V]` `phase-3.2-design-review.md` §10, §18 |

Two validation systems in one repository means two error vocabularies, two places to
change a rule, and an OpenAPI document generated from schemas that are not the ones the
server enforces. The review row predates implementation and was written before anyone
had to choose; implementation then chose the wrong side of it.

## The decision

| Field | Value |
|---|---|
| ID | `IG-12` |
| Decision | **Zod is the only request-validation engine.** No global pipe; the schema is bound per controller parameter with `ZodValidationPipe` |
| Approved by | Repository owner |
| Date | 2026-11-18 |
| Applies to | `apps/api`, and any future consumer of `packages/contracts` schemas |
| Not applied to | the response envelope, error codes, or any migration — this decision adds no schema and no table |

Conditions attached:

1. **One engine.** `class-validator` and `class-transformer` are not dependencies of
   `apps/api` and must not be reintroduced. A second engine would have to be kept in
   agreement with the Zod schemas by hand, and would eventually disagree.
2. **Explicit binding.** `new ZodValidationPipe(schema)` at `@Body`, `@Query`, or
   `@Param`. A global pipe cannot know which schema belongs to which argument; one that
   validates without a schema validates nothing, which is worse than visible absence
   because it looks like coverage.
3. **Shared schemas first.** Where a shape is also part of the API document, the schema
   lives in `packages/contracts` — the document and the runtime check are then the same
   object. Local schemas are for shapes only one endpoint has.
4. **Strict by schema, not by option.** Unknown keys are rejected because the object is
   strict. Coercion exists only where a field declares `z.coerce.*`; query parameters
   arrive as strings and each non-string field says so itself.
5. **Sanitised details.** `details` carries `{ path, issue }` only — Zod's code and a
   dotted path. Zod's `message` and `issue.input` are dropped, because a custom message
   can embed a submitted value and `input` *is* the value.

## Accepted risk

A controller that forgets to bind the pipe performs **no validation on that input**. There
is no global net to catch it. The mitigation is review plus the rule that every handler
taking input names a schema at the parameter; a future lint or a spec-generation step
that fails on an unbound input would close it properly, and neither exists yet.

## Reconciliation of the design review

Two rows in `phase-3.2-design-review.md` described the discarded design: §10's
`ValidationPipe` row and §18's S2 row. Both were updated to name `ZodValidationPipe`
bound per parameter, and the file carries a dated reconciliation note at the top so the
edit is visible rather than silent. No other part of that review was changed — including
finding F6, which records what was absent at `bf0e593` and remains true of that commit.

## Counts after Amendment 2

| Field | Value |
|---|---|
| Original decisions | **4** — `AG-1`, `AG-2`, `IG-5`, `IG-11` |
| Amendments | **1** — `IG-5-A1` |
| New gates recorded after the original round | **1** — `IG-12` |
| Entries in the recorded-decisions table | **6** |
| `OPEN-nn` dispositions changed | **No, at this date** — `OPEN-13` has since been resolved (2026-11-20); `OPEN-01` remains unresolved |
| Other `IG-nn` approved | **None** — `IG-1`–`IG-4`, `IG-6`–`IG-10` remain unanswered |

`IG-12` does not unblock anything. `S2` was already unblocked; it now has one permitted
validation mechanism instead of a choice.

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
| `IG-12` | **None** | Required before the first validated parameter (`S2`, then every endpoint that takes input) |

| Relation | Meaning | Consequence |
|---|---|---|
| **Approval dependency** | one decision's *answer* presupposes another's | none exists among these. Each can be approved or rejected on its own, in any order |
| **Implementation dependency** | one piece of code can only be written once another exists | `AG-2` → the credential `AG-1` selects; `S1`/`S2` → `IG-5` and `IG-11`; a validated parameter → `IG-12`. This constrains the order of work, not the order of decisions |

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
| S2 | API plumbing: `/v1` prefix, `ZodValidationPipe` per parameter (`IG-12`), exception filter, request-id, cookie parser, helmet, trust-proxy, CORS, database client | `IG-11`, `IG-12` | `IG-11`, `IG-12` (filter needs `IG-5`) |
| S3 | Bootstrap `app_auth`: role, secret map, `connections.mjs`, env-template names; `AuthDatabaseModule` written but not imported | `AG-1` + accepted `ADR-004` | `AG-1` + `ADR-004` |
| S4 | Migration `auth_boundary`: 2 policies, 2 column grants | S3 | `AG-1` + `ADR-004` + S3 |
| S5 | Migration `sessions` + policies + grants + purge function | `AG-2` + accepted `ADR-005`, S4 | `AG-2` + `ADR-005` + S4 |
| S6 | `privilege-verification.mjs` `EXPECTED` + `has_column_privilege` probes; `auth-boundary` suite | S4 (and S5) | S4 |
| S7 | Register + login: schemas, Argon2id, dummy hash, rate limit before lookup, generic failures | S1, S2, S4, `IG-1/2/3/4/6/7/10` | **not** unblocked by these four alone |
| S8 | Session guard, `/me`, logout, sliding expiry, purge function call | S5, S6, `IG-8/9` | **not** unblocked by these four alone; the `maintenance` queue that would schedule the purge is Phase 4 (`background-processing.md`) |
| S9 | Docs reconciliation: `entity-catalog` `sessions` in widened `identity`, `api-conventions` amendments, `auth-deferred.md` pointer, `IMPLEMENTATION_STATUS` (`ADR-004`/`ADR-005` are accepted; see the ADR status row) | everything above | — |

**Implementation status of this sequence (verified 2026-11-18).** Two steps are built;
the rest are not.

| Step | Status | Evidence |
|---|---|---|
| S1 | **implemented** | `c44cf5b` — response and error envelopes, error-code set, `requestId`; `0bb9792` — branded `NotFoundErrorCode`; `38486fd` — encoded path grammar enforced by `validationIssueSchema`, with the producer importing the same identifier rule; `75607d8` — explicit parser states and canonical numeric segments |
| S2 | **implemented and remediated** | `ad6235b` — prefix, filter, request id, cookies, helmet, trust proxy, CORS, database client, health probes; `6d36741` — credential boundary, log sanitisation, 405/406/415 documentation, `statement_timeout` readiness, `IG-5-A1`, `IG-12`; `c762171` — `details` trust boundary, path sanitisation in the pipe, log category, readiness budget, S2 commit history; `38486fd` — shared path grammar, producer reuse, segment-boundary truncation; `75607d8` — parser state machine, canonical numeric guard |
| S3–S8 | **not started at that date** | no `app_auth` role, no migration, no auth endpoint on 2026-11-18 |
| S9 (partial) | **`ADR-004` and `ADR-005` accepted** | `docs/adr/ADR-004-authentication-database-boundary.md` — **Accepted** 2026-11-18 (Akihira77); `docs/adr/ADR-005-session-storage.md` — **Accepted** 2026-11-20 (Akihira77). At that date `S5` had not started; every other S9 item is still absent |

**Update, 2026-11-20 — current status of the same sequence.** The table above records
2026-11-18 and is left as written. Since then: `S3`/`S4` (`b9a27c6`, `cf0d1c2`), `S5`
(`8fb2270`), and `S6` (`e9d1621`) are implemented, verified, and pushed; `auth_boundary`
and `sessions` are applied to the canonical development database (5/5), where `db:verify`
is 499 PASS / 0 FAIL / 0 SKIP, `test:rls` is 88/88, and `test:schema` is 22/22;
`OPEN-13` is `RESOLVED` on `ADR-005`'s Definition of Done.

**Update, 2026-11-20 (later) — S7 and S8 boundary restated.** The seven `IG` gates are now
answered (`docs/review/phase-3.2-s7-owner-decisions.md`, option A each; `IG-6`/`IG-7`
conditional). *Update 2026-11-21: finalised — `IG-7` is approved, `IG-4` is approved with a
revised rule, `IG-6` remains conditional on benchmark evidence (Amendment 1).* The row
above still reads "Register + login" because that is how the
sequence was written; the applied boundary is narrower and has two owners:

- **S7** — registration and credential verification: `POST /v1/auth/register`, email
  normalisation, password policy, Argon2id hashing, user persistence, duplicate handling,
  uniform credential verification with a dummy hash, and a registration rate limit. It
  issues no session.
- **S8** — login and session flow: `POST /v1/auth/login`, session token generation and
  SHA-256 storage, the session cookie, CSRF, the authentication guard, `/me`, logout, and
  login-side rate limiting.

S7 and S8 are still unstarted. `ARGON2ID-LIB` and `LIMITER-MECHANISM` were approved on
2026-11-20; what remains before S7 is the deployment-host benchmark, prepared in
`docs/review/phase-3.2-s7-argon2-benchmark-plan.md`. No decision in this file changed, and
`OPEN-01` and `OPEN-04` are untouched.

So the honest statement of what these four decisions buy: **Track 1 can start**
(contracts and plumbing), and **Track 2 can start** (the database boundary and
sessions). Track 3 cannot — `S7` and `S8` additionally require `IG-1` through `IG-4`,
`IG-6` through `IG-10`. None of that is answered **in this document**; as of 2026-11-20 the
seven gates are recorded in `docs/review/phase-3.2-s7-owner-decisions.md`, and none of them
changes the boundary described here.

*Update 2026-11-21.* Those gates are now decided (`IG-1`–`IG-4`, `IG-7`, `IG-10`
approved; `IG-4` revised; `IG-6` conditional; `IG-8`/`IG-9` approved in *Amendment 3*), so
Track 3's remaining precondition is the S7/S8 **implementation**, not another decision.
`S7` is still unstarted, which is why this paragraph is not deleted.

**As of 2026-11-18 the architecture gate for S3, S4, and S5 is satisfied by approval.**
That is a statement about the owner's decision, not about the paperwork. As of
`75607d8`, S1 and S2 are also satisfied by work: the contract schemas, the exception
filter, and the validation pipe exist, the path grammar is enforced where the details
leave the process rather than only where they are built, and their checks exit `0`.
S3, S4, and S5 are still approval-only in the other sense — no `app_auth` role, no
migration, and no verification row exists for them.

The ADRs are now written, and `ADR-004` was **accepted on 2026-11-18**; at that date
`ADR-005` remained `Proposed` and gated `S5`, not `S3`. It was accepted on 2026-11-20 and
`S5` shipped the same day, so that gate is closed too. Do not read acceptance as a fifth
decision: they record what was approved on 2026-11-18 and add nothing. A separate,
non-architecture row survives from the original list — the `IG` gates — and it belongs
to S7/S8, where endpoint behaviour is decided.

# What these decisions do not settle

| Not settled | Where it lives | Blocks |
|---|---|---|
| Email normalisation: application invariant or unique index | `IG-1` | first registration |
| Duplicate registration: `409` or always `202` | `IG-2` | register endpoint |
| Register auto-login vs separate login | `IG-3` (needs `AG-2`) | register endpoint |
| Password policy: length, byte cap, composition | `IG-4` | `registerRequestSchema` |
| Argon2id parameters, measured on the deploy host | `IG-6` | hashing implementation |
| Per-account brute-force control | `IG-7` | production, not implementation |
| Cookie name and `__Host-` prefix | `IG-8` — **approved 2026-11-21**, see *Amendment 3* | first cookie set (S8) |
| CSRF mechanics: header, token length, comparison, rotation | `IG-9` — **approved 2026-11-21** for the pattern, header, methods, and origin source; length, encoding, retrieval, and rotation remain S8 design, see *Amendment 3* | first non-GET endpoint (S8) |
| Email verification | `IG-10` | public deployment |
| `updated_at` trigger on `users` | `OPEN-19` | untouched by 3.2 |
| Account deletion policy | `OPEN-04` | no endpoint, no column |
| Signed tenant context | `OPEN-28` (`DEFERRED`) | — |
| `app_auth` enumeration / impersonation exposure as a stated limitation | Definition of Done item 15 | completion claims |

No `OPEN` disposition changed as a result of these decisions, no ADR was created or
modified by them, and no implementation of the items below exists. (`OPEN-13` was
resolved later, on 2026-11-20, by implementation plus evidence — not by any decision in
this record; see the header.)

`IG-1` through `IG-4` and `IG-6` through `IG-10` are **not** approved by this record and
were not part of it. Only `AG-1`, `AG-2`, `IG-5`, and `IG-11` were put to the owner in
the original round, and only those four carry an approval date from that round;
`IG-5-A1` and `IG-12` were approved later on the same day and are recorded above with
their own dates. They were unanswered when this record was written; all seven are recorded
on 2026-11-20 in `docs/review/phase-3.2-s7-owner-decisions.md`, and
`docs/IMPLEMENTATION_STATUS.md` carries their current state.

**Update, 2026-11-21.** Two of those gates are no longer unanswered: `IG-8` and `IG-9`
were approved on 2026-11-21 and are recorded in *Amendment 3* at the end of this file. The
paragraph above is left as written because it describes the 2026-11-18 round; it is no
longer a complete list of what is unapproved. `IG-1`–`IG-4`, `IG-6`, `IG-7`, and `IG-10`
were finalised the same day in *Amendment 1* of
`docs/review/phase-3.2-s7-owner-decisions.md`: six approved, `IG-4` approved with a
revised rule, `IG-6` conditionally approved pending the deployment-envelope benchmark.

`OPEN-01` remains **unresolved** despite its decision being approved, because no
authentication endpoint reads a credential through the boundary yet — the login endpoint
and session issuance are S8. On 2026-11-21 the owner confirmed the boundary as the final
mechanism (*Amendment 3*), which removes the last external input the register entry was
waiting for and changes nothing about implementation. `OPEN-13` met the review's rule on
2026-11-20: the ADR is accepted, the migration is applied, and the verification evidence
is green — three facts about the repository, none of which an approval can supply.

# Source inconsistencies encountered while preparing this record

| # | Observation | Action taken |
|---|---|---|
| 1 | The Phase 3.2.2 brief cites "design review §15.2 and `api-conventions.md`" for `IG-5`; §15.2 recommends "seed from `api-conventions.md:37-47`", which is the status/code table — verified present at those lines | none; cited as written |
| 2 | `api-conventions.md` already defines `503 PROVIDER_UNAVAILABLE` for weather providers. "Add exactly one code for dependency unavailability" is therefore ambiguous about whether a second 503 code is intended | reported, not resolved: C-1/C-2 presented in §3.4 for the owner |
| 3 | The brief refers to "design review §16" for `AG-1` privileges including nothing on sessions; §16 is consistent, but `app.sessions` grant details live in §4.3 | none; both referenced |

No inconsistency was found serious enough to justify editing the design review, and
it was not edited.

---

# Amendment 3 — 2026-11-21: S8 security gates

**Approver:** Akihira77, 2026-11-21. **Status: approved, not implemented, not verified.**

This amendment records three decisions taken after this document was written. It does
not alter Decision 1–4, Amendment 1, or Amendment 2; those stand as written, with their
own dates, and none of them is re-opened. The durable architectural record for the
cookie and CSRF decisions is `docs/adr/ADR-006-session-transport-and-csrf.md`; the
credential-lookup confirmation is a restatement of `ADR-004`'s decision, not a new
boundary.

The distinction this repository keeps, and that this amendment keeps:

| Word | Means here |
|---|---|
| **approved** | the owner has decided; the wording below is final and may be implemented against |
| **implemented** | code exists and does the thing |
| **verified** | an executed check proves the code does the thing |

All three items below are **approved only**. `S8` has not started. No cookie, CSRF
token, guard, session issuance, or `Origin` check exists anywhere in `apps/`.

---

## A3.1 `OPEN-01` — Credential lookup database boundary (**confirmed**)

| Field | Value |
|---|---|
| Decision ID | `OPEN-01` (register: `docs/data-model/open-decisions.md` §1.2) |
| Approved | 2026-11-21 |
| Related ADRs | `ADR-004` (the boundary itself, accepted 2026-11-18); `ADR-003` (why a role, not a GUC); `ADR-005` (the session table `app_auth` also reaches) |
| Implementation status | **Boundary implemented and verified** (S3/S4/S6, `b9a27c6`, `cf0d1c2`, `e9d1621`); **request path not implemented** — no endpoint reads a credential |
| Verified | `test/rls/auth-boundary.test.mjs` (49 real-role cases), schema-conformance suite, `db:verify` 499 assertions on the canonical development database |

**Final approved wording.**

> Credential lookup uses the dedicated `app_auth` database role. Authentication
> database access stays separate from `app_api`, with least-privilege column grants.
> Password hashes and credential fields are never exposed through the API database role.
> `BYPASSRLS` is not granted to simplify authentication, and no new `SECURITY DEFINER`
> function is introduced. Authentication queries neither establish nor modify tenant
> context (`app.user_id`). The existing authentication/database boundary and its
> security guarantees are preserved.

**Rationale.** The mechanism was decided on 2026-11-18 as `AG-1` and built in S3/S4/S6;
this approval confirms that the shipped shape — a fourth role with column-level grants
and two narrowly scoped policies — is final, rather than a placeholder to be revisited
when `S8` starts. Confirming it now prevents the most likely drift: an implementer
reaching for `app_api`, `BYPASSRLS`, or a `SECURITY DEFINER` lookup because the login
path is the first place where a query runs with no tenant context, and the convenient
answer is also the wrong one.

**Security implications.**

- The credential table remains unreadable by the role that serves every tenant request.
  A compromised or SQL-injected `app_api` path cannot read `password_hash`.
- `app_auth` holds `SELECT` on six columns of `app.users` (`id`, `email`,
  `password_hash`, `role`, `locale`, `timezone`) and `INSERT` on two
  (`email`, `password_hash`). It has no `UPDATE`, no `DELETE`, and no grant on
  `created_at` — so it cannot rewrite a credential, and a response built from its rows
  cannot leak a creation timestamp.
- `app_auth` is `NOBYPASSRLS`, asserted rather than assumed
  (`bootstrap/roles.sql`; `db:verify` checks the attribute for every role). The two
  policies it reaches are `USING (true)` only because the column grant is what bounds
  the blast radius — the same reasoning recorded in Decision 1.
- The auth path does not call `withTenant` and does not set `app.user_id`. A login
  attempt therefore cannot inherit or poison a tenant scope, and failure leaves no
  transaction-local state behind.
- `app.purge_expired_sessions()` remains the repository's only `SECURITY DEFINER`
  function. It is unrelated to credential lookup (it deletes expired sessions, never
  reads a password) and is not touched by this decision; the approval's "no new
  `SECURITY DEFINER` function" adds none.

**Implementation scope.** `S7` (register + credential verification) and `S8` (login)
must reach `app.users` only through `AUTH_DATABASE_CLIENT`. Nothing in this approval
authorises a grant change: the grants already exist and any widening would contradict
the decision.

**Register effect.** The entry's `BLOCKED_EXTERNAL_INPUT` disposition is removed by this
approval — the external input has arrived. The entry is **not** `RESOLVED`: per §1.2 and
`ADR-004`, resolution requires a login endpoint that reads a credential through the
boundary plus the verification that proves it. It is therefore recorded as
`DEFERRED` to the authentication slice (`S7`/`S8`), with the decision half closed.

---

## A3.2 `IG-8` — Session cookie configuration

| Field | Value |
|---|---|
| Decision ID | `IG-8` (gate: `docs/review/phase-3.2-design-review.md` §17) |
| Approved | 2026-11-21 |
| Related ADRs | `ADR-006` (durable record); `ADR-005` (token lifetime, hash-only storage); `ADR-002` D5 (server-side sessions) |
| Implementation status | **Not implemented.** No cookie is set anywhere; `cookie-parser` is mounted with no secret and no cookie is issued |
| Verified | nothing — there is nothing to verify |

**Final approved wording.**

> The session cookie is host-only, named `__Host-agroclimate_session`, with `HttpOnly`,
> `Secure`, `SameSite=Lax`, `Path=/` and no `Domain` attribute. The session token is
> never exposed in a response body, and only its cryptographic hash is persisted. Cookie
> security is not weakened for development environments; local development documents
> its own HTTPS and `Secure`-cookie considerations. `SameSite=None` is not used without a
> separately approved requirement.

**Rationale.** `ADR-005` fixed the token (32 CSPRNG bytes, base64url) and the storage
(only `sha256(token)`), but left the transport open. Without a decision, the first
`res.cookie(...)` call would pick a name and attributes by habit. The `__Host-` prefix
makes the two most damaging mistakes impossible rather than reviewable: it is accepted by
the browser only with `Secure`, `Path=/`, and no `Domain`, so the cookie can neither be
sent over cleartext nor widened to sibling subdomains — the exact shape of a
cookie-injection attack that would also defeat double-submit CSRF protection.

The design review had recommended a plain name in development and `__Host-` in
production. That recommendation is declined: a dev/prod cookie difference means the
production-only path is never exercised locally, and the difference *is* the security
property.

**Security implications.**

- With no `Domain`, a session issued at one host is not presented to any other host,
  including tenant-controlled or static-content subdomains.
- `HttpOnly` keeps the token out of reach of script; it does not prevent XSS from acting
  as the user, and this decision does not claim it does.
- `Secure` is mandatory, so a deployment that cannot serve HTTPS has no working session
  — a failure that is visible, rather than a silent downgrade.
- `Path=/` is required by the prefix and is not a security boundary; authorisation is
  per-route and per-row, never per-path.
- `SameSite=Lax` blocks the cookie on cross-site `POST` by default. D3 of `ADR-006`
  freezes it at `Lax`; `None` needs a separate recorded decision.
- Only the hash is stored, so a database disclosure does not yield a usable session. The
  raw token exists in the cookie and in process memory for the request only.
- Credentialed CORS becomes necessary (web and API are different origins). The current
  factory mounts CORS with `credentials: false`; `S8` must change that while keeping the
  exact origin allowlist. A wildcard with credentials is invalid and must not appear.

**Implementation scope.** `S8` only: `Set-Cookie` on login, `Clear-Cookie` on logout,
cookie parsing on the guard, and the CORS change. No database object changes; the
`token_hash` column and its CHECK already match.

**Deviation recorded.** The review's `IG-8` recommendation ("`__Host-` in production,
plain name in dev") is superseded. Development must use a loopback origin, or local TLS,
and must not drop `Secure` or the prefix.

---

## A3.3 `IG-9` — CSRF protection

| Field | Value |
|---|---|
| Decision ID | `IG-9` (gate: `docs/review/phase-3.2-design-review.md` §17) |
| Approved | 2026-11-21 |
| Related ADRs | `ADR-006` (durable record); `ADR-005` (the session the token binds to); `ADR-004` (`app_auth`) |
| Implementation status | **Not implemented.** No token, no `X-CSRF-Token` handling, no `Origin` check |
| Verified | nothing — there is nothing to verify |

**Final approved wording.**

> CSRF protection uses the synchronizer token pattern together with `Origin`
> validation. A CSRF token is associated with the authenticated session; the frontend
> obtains it through a dedicated mechanism and sends it in the `X-CSRF-Token` header;
> the backend validates it against the active session. State-changing requests
> (`POST`, `PUT`, `PATCH`, `DELETE`) additionally have their `Origin` header validated
> against explicitly configured trusted application origins. Authentication endpoints
> that change state — registration, login, logout — are covered by `Origin` validation,
> with the pre-session case handled explicitly. `SameSite=Lax` remains defence in depth
> and is not the only control. A double-submit-cookie strategy is not used as a
> replacement.

**Rationale.** The review's `IG-9` line said "double-submit" and nothing else, which is
not implementable without inventing the rest — and double-submit is the weakest of the
available patterns: it compares two values the client supplies, so it is defeated by any
cookie-injection primitive, including the subdomain case `IG-8` exists to prevent. A
server-verified token bound to the session row costs one extra lookup and depends on the
session store that already exists.

Two controls rather than one because they fail differently: the token is defeated by a
route that forgets to check it, `Origin` validation is defeated by a same-site attacker.
Both are global, so a route added later is covered by default.

**Security implications.**

- A cross-site forged `POST` must both carry the victim's session cookie **and** present
  a token bound to that session **and** come from a trusted origin.
- `Origin` is compared exactly (scheme, host, port) against `CORS_ORIGINS`, the variable
  that already exists and is already required in production. Reusing it is deliberate:
  a second "trusted origins" list would drift from the CORS allowlist, and the drift
  would be invisible until one of the two is wrong. *(Repository-derived requirement, see
  `ADR-006` D2.2 item 3.)*
- A missing `Origin` on a state-changing request is refused. v1 has no non-browser
  client; when one appears, that is a decision, not a default.
- Registration and login have no session to bind a token to. `Origin` validation is the
  control there, applied before body parsing, lookup, or hashing. This is the "appropriate
  handling before an authenticated session exists" the approval requires; it is not a
  CSRF exemption for those routes.
- `SameSite=Lax` stays. It is the only control that works with no application code, and
  it is treated as defence in depth rather than as the mechanism.
- A refusal uses the existing bounded `FORBIDDEN` code. No new error code, no diagnostic
  detail about which control failed.

**Implementation scope.** `S8` only: token generation and storage, a retrieval mechanism,
middleware/guard for header comparison and `Origin` validation, and their tests.

**Not decided here (recorded, not inferred).** The retrieval mechanism, token length,
encoding, storage form, and rotation policy are `S8` design details. The approval fixes
the pattern, the header name, the covered methods, and the `Origin` source; it does not
fix those four, and neither does `ADR-006`. They must be proposed in the S8 design and
recorded before the first non-GET endpoint ships.

**Deviation recorded.** The review's `IG-9` recommendation (double-submit) is superseded,
and `docs/architecture/api-conventions.md` §8 said the same thing; that line is amended
to point at `ADR-006`.

---

## A3.4 Counts and dispositions after Amendment 3

| Item | Before | After 2026-11-21 |
|---|---|---|
| Owner decisions in this record | 4, plus `IG-5-A1`, `IG-12` | unchanged; Amendment 3 is separate |
| `OPEN-01` disposition | `BLOCKED_EXTERNAL_INPUT` | `DEFERRED` to `S7`/`S8` — decision made, request path outstanding |
| `IG-8` | unanswered | **approved**, not implemented |
| `IG-9` | unanswered | **approved**, not implemented |
| S8 gates outstanding | `IG-8`, `IG-9` | none; S8 is blocked only on `S7` (implementation) |
| ADRs | 5 | 6 (`ADR-006`) |
| Migrations, roles, grants | — | unchanged |

## A3.5 What Amendment 3 does not do

- It does not start `S8`, or authorise any endpoint, cookie, CSRF middleware, guard, or
  CORS change. The approvals exist so that `S8` can be written against them.
- It does not resolve `OPEN-01`. The boundary was already built; the request path is
  still absent, and the register entry closes on evidence, not on approval.
- It does not change a role, grant, policy, RLS behaviour, or migration. The `app_auth`
  grants the approval describes are the ones shipped in S4 and verified in S6.
- It does not change password hashing parameters (`IG-6`), which remain provisional
  pending a deployment-host measurement.
- It does not edit the design review. The `IG-8`/`IG-9` rows there record what was
  recommended; two of those recommendations were declined, and rewriting them would hide
  that they were considered.

---

# Amendment 4 — 2026-11-21: `IG-9` CSRF design decisions

**Approver:** Akihira77, 2026-11-21. **Status: approved for implementation; not implemented.**

*Amendment 3* approved the CSRF **pattern** and left token length, encoding, storage
form, retrieval, and rotation open (`A3.3`, "Not decided here"). This amendment closes
those four. It does not alter `A3.3`'s approved wording, Decision 1–4, Amendment 1, or
Amendment 2, and it does not implement anything: no column, migration, grant, endpoint,
middleware, or guard exists as a result of it.

The four items are approved as a set. They are only useful together — a token that is
stored but never retrievable, or retrieved but never compared, is not a control.

## A4.1 `CSRF-1` — Token storage (**approved**)

> The CSRF token is stored **in plaintext** in a dedicated nullable column on
> `app.sessions`, readable only through `app_auth`'s column grant. It is not stored as a
> hash.

**Rationale.** The token is re-served on every retrieval so that a second tab, or a
reload, keeps working; a hash-only column cannot be re-served, so the only way to keep
that behaviour would be to mint a new token on every retrieval, which is rotation
wearing a storage decision's clothes — and rotation breaks the multi-tab case the token
must support.

Writing the token in plaintext does not widen the disclosure surface by the amount it
looks like:

- It is not a bearer credential. Presenting it without the session cookie authenticates
  nothing; the cookie is `HttpOnly`, so a cross-site page cannot obtain either.
- An attacker who can read the session row already has database access, and the token is
  the least valuable column there.
- The one attacker who could read it through the application — XSS on the web origin —
  can already call the retrieval endpoint and receive the same value. Hashing the column
  would not take that capability away; it would only make the legitimate multi-tab case
  worse.

**Explicit non-precedent.** This is not a relaxation of `ADR-005` §8. The session token
*is* the credential and stays hash-only; the CSRF token proves a request came from a
page that could read the session's own response, which is a different claim.

**Rejected alternative.** A hash-only column with reissue-on-retrieval was rejected
because it converts retrieval into rotation, and the approved lifecycle (`CSRF-2`) has no
rotation.

## A4.2 `CSRF-2` — Token lifecycle (**approved**)

> 32 bytes from `crypto.randomBytes`, base64url, 43 characters, alphabet
> `[A-Za-z0-9_-]`, bound to one session row. Generated **lazily**, on the first
> retrieval for a session whose token is `NULL`, and never rotated afterwards.

| Event | Behaviour |
|---|---|
| New session (login) | Column may stay `NULL` until first retrieval; no login-path change is required |
| First `GET /v1/auth/csrf` | Token generated and persisted for that session, then returned |
| Later retrievals | The stored token is returned unchanged |
| Logout / revocation / expiry | No cleanup step. Validation happens only after the session is validated, so a token attached to an unusable session authenticates nothing |
| Rotation | **None** in this phase |

**Retrieval.** `GET /v1/auth/csrf`, behind the existing `AuthGuard`:

- `200` with `{ "data": { "token": "<43 characters>" } }`.
- `401 UNAUTHENTICATED` for absent, malformed, revoked, or expired session — the guard
  already answers this, so the handler has no branch of its own.
- `Cache-Control: no-store`, because the value is session-scoped.
- The session token is never in the body and the response never echoes the cookie.

**Lazy generation is what keeps existing sessions valid.** A `NOT NULL` column would
require a backfill of every live session, and any backfill that a runtime role performs
is either a `SECURITY DEFINER` function the boundary does not allow or a migration that
can fail halfway. `NULL` means "not issued yet", which is a state the session can
legitimately be in, and it is resolved on first use.

**Concurrency of the first retrieval.** Two simultaneous retrievals for a session with no
token must not produce two live values. The write is conditional
(`UPDATE … SET csrf_token = $2 WHERE id = $1 AND csrf_token IS NULL RETURNING csrf_token`)
and the loser re-reads the row; both callers therefore leave with the token that won.
This is implementation guidance, not a new decision.

## A4.3 `CSRF-3` — Validation behaviour (**approved**)

> The presented token is read from `X-CSRF-Token`, shape-checked, and compared to the
> session row's token with `crypto.timingSafeEqual` over equal-length buffers. A missing,
> malformed, or non-matching token is `403 FORBIDDEN`.

- **Methods.** `POST`, `PUT`, `PATCH`, `DELETE` on routes that have an authenticated
  subject. `GET` and `HEAD` are not state-changing and are not required to carry a token.
- **Exempt routes.** `POST /v1/auth/register`, `POST /v1/auth/login`, and
  `POST /v1/auth/logout`, for the reason `ADR-006` §D2.3 already gives: two of them have
  no session to bind a token to, and logout must work while the session is being revoked.
  They remain covered by `Origin` validation.
- **`403`, not `401`.** The session is valid; the request is not authorised.
  Re-authenticating does not fix it.
- **Shape check before comparison.** `timingSafeEqual` throws on a length mismatch, so a
  malformed value must be rejected by the shape rule first — otherwise "wrong token" and
  "wrong length" become distinguishable behaviours.
- **`Origin` validation remains independent.** Neither control replaces the other; both
  run, in the order their prerequisites allow: `Origin` before body parsing (it needs
  nothing), the token after the session is known (it needs the subject).
- **No new error code.** The bounded set already carries `FORBIDDEN`.

## A4.4 `CSRF-4` — Database and migration ownership (**approved**)

> One nullable `text` column on `app.sessions`, one shape CHECK, one `SELECT` grant and
> one `UPDATE` grant on that column to `app_auth`. No generated column, no
> `SECURITY DEFINER` function, no backfill, no change to any other table, role, policy, or
> existing session.

| Object | Form | Reason |
|---|---|---|
| Column | `csrf_token text NULL` | `NULL` is "not issued yet" (A4.2) |
| CHECK | `csrf_token IS NULL OR csrf_token ~ '^[A-Za-z0-9_-]{43}$'` | Same shape rule as the session token hash, nullable for lazy init |
| Grant | `SELECT (csrf_token), UPDATE (csrf_token)` to `app_auth` only | Validation reads; the first retrieval writes |
| `app_api` | nothing | Unchanged: no session column is reachable from the tenant role |
| Generated column | **rejected** | `random()` is volatile; PostgreSQL does not allow a volatile expression in a generated column, and a hash-of-something generated value would be derivable |
| `SECURITY DEFINER` backfill | **rejected** | No backfill is needed, so the function would exist to create a privilege the boundary does not need |
| Existing sessions | **stay valid** | `NULL` until first retrieval; no session becomes unusable because a column was added |
| RLS policies | unchanged | The table's policies already gate the row by session, not by column |

**Sequencing.** The migration is a separate, later task. It must ship the column as
nullable; adding `NOT NULL` later is only possible after a backfill decision, and no such
decision is approved.

**`db:verify` consequences.** The new grants and the new CHECK belong in `db:verify` and
in the RLS suite as an explicit denial case for `app_api`, because "no tenant-role
access" is currently proven by absence of a grant and would otherwise silently gain a
carve-out.

## A4.5 What Amendment 4 does not do

- It does not add the column, the CHECK, the grants, or a migration. Those are a later
  task, and this amendment is the approval that task may rely on.
- It does not implement generation, retrieval, comparison, middleware, or a guard, and it
  does not make any request require `X-CSRF-Token`.
- It does not change `A3.3`'s approved pattern, the header name, the covered methods, or
  the `Origin` source. It fills in the four details `A3.3` deferred.
- It does not rotate tokens, and it does not change the session token's hash-only
  storage.
- It does not change any role, grant, policy, or RLS behaviour that exists today.

## A4.6 Dispositions after Amendment 4

| Item | Before | After 2026-11-21 |
|---|---|---|
| `IG-9` implementation gate | pattern approved, four details open | **fully specified**; implementation is a separate task |
| `IG-9` implementation | not implemented | not implemented (unchanged) |
| `IG-8` implementation | implemented in `S8` | unchanged |
| Schema, migrations, grants | — | unchanged |
| Sessions valid | — | unchanged; no backfill required by design |

## A4.7 Implementation status (2026-11-21, later the same day)

A4.1–A4.4 were written as approvals and deliberately recorded nothing as implemented. A
follow-up task implemented them, and this note records that without altering the approved
text above.

| Item | State |
|---|---|
| `CSRF-1` plaintext nullable column | implemented — `20261121000000_session_csrf_token` |
| `CSRF-2` lifecycle, `GET /v1/auth/csrf`, no rotation | implemented, with lazy generation at first retrieval |
| `CSRF-3` `X-CSRF-Token`, constant time, `403`, methods, exemptions | implemented in `AuthGuard` (not per-route metadata) |
| `CSRF-4` migration scope and grants | implemented exactly as specified: one column, one CHECK, `SELECT`/`UPDATE` to `app_auth` only |
| Applied to canonical development database | **yes** — `db:migrate`, 6/6, after a validated backup |
| Committed / pushed | **no** |
| Verified | real-role integration (12 tests), API route and guard tests, schema, RLS, build, typecheck, lint |

Nothing in A4.5 was contradicted: the amendment itself still added nothing, and the
implementation is a separate task that this note points at.
