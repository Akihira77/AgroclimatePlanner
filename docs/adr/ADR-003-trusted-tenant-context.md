# ADR-003 — Trusted Tenant Context

- Status: **Proposed** — matches ADR-001/002; the decision documents existing
  behaviour and changes no code, but acceptance is the reviewer's, not the
  author's
- Date: 2026-11-18
- Depends on: ADR-002 (D3, D7), `database-foundation.md` §6,
  `docs/data-model/ownership-and-rls.md`
- Supersedes: none

## Context

Row level security on the ten tenant tables is keyed on one expression:

```sql
user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
```

`app.user_id` is an **application-defined GUC**. PostgreSQL has no notion of who
may set it: a custom parameter is created by the first role that sets it, and no
`GRANT`, `REVOKE`, or role attribute restricts it. `pg_settings` does not even
list it while unset. So the policy's correctness rests on an assumption the
database cannot check — that the setting was written by `withTenant` from an
authenticated subject.

Phase 2.2.3 shipped that assumption without measuring it. Phase 2.3 measured it.

## What was measured

Probes run as `app_api` against the live database (throwaway scripts, deleted
after use; two seeded users with one farm each):

| # | Operation | Result |
|---|---|---|
| 1 | `SELECT app.farms` with no context | `[]` — zero rows, no error |
| 2 | `select set_config('app.user_id', <other tenant>, true)` in autocommit | **returns the value**, but the next statement sees `[]` |
| 3 | `SET app.user_id = '<uuid>'` (session scope, literal) | **`ALLOWED`** — and the next statement returns the *other tenant's* farm |
| 4 | `RESET ALL` after (3) | `app.user_id` becomes `''` |
| 5 | `BEGIN; set_config(A); SELECT; set_config(B); SELECT; COMMIT` | sees `farm a`, then `farm b` |
| 6 | `INSERT INTO app.farms (user_id …) VALUES (<other tenant>, …)` in autocommit | `42501` — refused |
| 7 | `SET app.user_id = $1` (parameterised) | `42601` — `SET` takes no parameters; only `set_config()` does |
| 8 | `SECURITY DEFINER` helper reading `current_setting('app.user_id', true)` | sees the **caller's** value inside a transaction; `NULL` in autocommit |
| 9 | `pg_settings` lookup of `app.user_id` by `migration_owner` | `[]` — the parameter does not exist until someone sets it |

Three findings drive the decision:

1. **No privilege mechanism exists to protect the GUC.** Rows 1, 3 and 9 together
   say the parameter is unprotected, unlisted, and role-agnostic. There is no
   grant to add. A `SECURITY DEFINER` wrapper (row 8) does not help: it reads the
   caller's setting, so it can only re-assert what the caller already chose.
2. **Transaction scope is the only safe scope.** Row 2 versus row 3 is the whole
   security difference: `set_config(…, true)` dies at the end of the transaction,
   `SET` survives it. A session-scoped set on a **pooled** connection would hand
   one request's tenant to the next request that borrows the connection — a
   cross-tenant leak with no bug in the query and no trace in the logs.
3. **The current implementation is already on the safe side of both.** `tenant.ts`
   issues `set_config('app.user_id', $1, true)` as the first statement inside an
   interactive `$transaction`, and never `SET`. Row 2 also means a refactor that
   accidentally drops the transaction wrapper fails **closed** (every query
   returns zero rows) rather than leaking — worth knowing, not worth relying on.

## Decision

**D1. RLS remains as implemented. `app.user_id` is a code-path assertion, not a
database-enforced identity.**

The database enforces that a statement cannot read a row whose `user_id` differs
from the current setting. It does **not** enforce who may choose the setting.
That is the honest boundary, and the policies are documented as bug containment
rather than as protection against a holder of `app_api` credentials.

**D2. Transaction-local scope only. `SET app.user_id` is forbidden.**

`withTenant` must use `set_config(…, true)` inside an interactive transaction. A
session-scoped `SET` is a defect even if it "works" in a single-connection test,
because the connection pool makes it a cross-request leak. Review rule:
`grep -n "SET app\." ` on any database access code must return nothing.

**D3. Exactly one GUC, set in exactly one place.**

`app.user_id` is written by `createTenantScope`/`withTenant` in
`packages/database/src/tenant.ts` and nowhere else. No repository, service, or
raw query sets it as a side effect. Two writers would make the invariant
unprovable; a second context variable (for the auth lookup, `OPEN-01`) would need
its own ADR, because two variables with different trust levels is how a boundary
becomes a suggestion.

**D4. The `app_api` credential is treated as tier-0.**

A DSN leak is a full cross-tenant read, by construction, as row 5 demonstrates.
Consequences that are not negotiable: the credential is rotatable, it never
appears in logs or error payloads, it is a distinct role from `app_system` (which
would additionally bypass RLS), and it is deployed only to processes that serve
tenant requests.

**D5. Nested scopes are rejected, and the rejection is `AsyncLocalStorage`-based.**

A nested `withTenant` would open a second transaction and lose the first one's
setting. Rejecting it is what keeps D3 true under refactoring — measured in
Phase 2.2.3's unit suite, not assumed.

## What the policies do and do not protect

| Threat | Protected? | Why |
|---|---|---|
| A handler forgets to scope its query | **yes** — fail-closed, zero rows | the predicate matches nothing without a context |
| A query is issued with the wrong `userId` taken from a request body | **no** | the wrong value is a *valid* value; RLS compares it and agrees |
| A repository returns another tenant's row because a join forgot a filter | **yes** | the join's base table is filtered by the policy |
| A tenant crafts an `UPDATE` that moves its row to another owner | **yes** | `WITH CHECK` on the `FOR ALL` policy |
| A tenant attaches a child row to another tenant's parent | **yes** — `23503` | composite ownership FK, independent of RLS |
| The worker reads tenant rows while doing a bulk job | **yes** | `app_system` has `BYPASSRLS` and zero grants |
| An injection that only alters values inside a parameterised query | **yes** | cannot become a new statement, cannot touch the GUC |
| An injection that can execute arbitrary SQL | **no** | it can call `set_config` for any tenant, exactly as row 5 shows |
| A leaked `app_api` DSN | **no** | same as above, with more time |
| A compromised API process (RCE) | **no** | it holds both the credential and the authenticated subject |

The dividing line is consistent: **RLS protects against code that forgets; it
cannot protect against code that lies or credentials that leak.** Every "no" row
is a different control's job — parameterised queries, secrets management,
rotation, and not running untrusted code.

## Alternatives considered

**A1. `SECURITY DEFINER` validator function.** Rejected on measurement: row 8
shows the function reads the caller's setting, so it can only restate it. A
function that instead *received* the tenant and compared it to something trusted
would need that something to live in the database — and the caller can set it
too. No net gain, plus a privileged entry point on every policy evaluation.

**A2. Signed context (HMAC over `user_id`, verified in the policy).** The API
signs, a `SECURITY DEFINER` function verifies with a key the API process holds
but the DSN does not. This is the only option that meaningfully narrows the
leaked-DSN threat, because an attacker with the DSN alone cannot mint a
signature. Costs: a function call per row evaluated (or per statement, if cached
in a `STABLE` function), a key with its own rotation and storage, and
`withTenant` becoming a signer. **Deferred, not rejected** — it is the upgrade
path if the leaked-credential threat moves into scope, and it does not require
changing the policies' predicate shape, only their right-hand side.

**A3. One database role per tenant.** Rejected: a role, a connection, and a pool
per tenant. At ten thousand tenants this is a connection-management problem
pretending to be a security model, and `SET ROLE` from a shared superuser-ish
role would reintroduce the same trust question one level up.

**A4. No RLS; ownership filters in the repository layer.** Rejected in Phase 2.2
and not reopened: one forgotten `WHERE` is a data breach, and the failure is
silent.

**A5. RLS keyed on `current_user` via a login role per tenant.** Rejected for the
same reason as A3, plus it moves tenancy into the connection string, where it
cannot be changed per request.

## Consequences

Positive:

- The boundary is written down as a measured property, so a future reviewer can
  tell "RLS will catch this" from "RLS will not catch this" without re-deriving it.
- The safe scope (transaction-local) is now a review rule with a `grep`-able test.
- The upgrade path (A2) is recorded with the threat it addresses, so it is a
  decision to take later rather than a discovery to make under pressure.

Negative / accepted:

- A leaked `app_api` credential is a full read of every tenant's data. Accepted
  for v1, mitigated by rotation and by the credential never leaving the two
  processes that need it. `OPEN-28` tracks whether A2 becomes required.
- Nothing in the schema can prove `withTenant` was used. The evidence is the unit
  and RLS suites plus the review rule in D2, not a constraint.
- `app.user_id` being a placeholder GUC means it will not appear in
  `pg_stat_activity`/`pg_settings` diagnostics until set, which makes an
  incident slightly harder to read. Recorded because it will surprise someone.

## Follow-ups

1. `OPEN-01` (auth lookup) must not be solved by widening the `users` policy —
   see `ownership-and-rls.md` §5.
2. `OPEN-28` — decide whether signed context (A2) is required before production.
3. Phase 3 integration tests must include the two measured hazards: a
   session-scoped `SET` must never appear, and a nested `withTenant` must throw.
4. The connection pool must be verified to not reuse a session with a lingering
   setting. `set_config(…, true)` makes this structurally impossible; the test
   exists to catch a future refactor, and `RESET ALL` on connection release is
   **not** a substitute for it.
