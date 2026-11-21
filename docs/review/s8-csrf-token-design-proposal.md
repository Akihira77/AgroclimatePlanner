# S8 — CSRF synchronizer token: design record

**Status: decisions approved (Amendment 4); implemented and verified 2026-11-21; not committed.**
**Decided in:** *Amendment 4* of `docs/review/phase-3.2-owner-decisions.md` (2026-11-21).
**Durable architectural record:** `docs/adr/ADR-006-session-transport-and-csrf.md` §D2.
**Migration:** `prisma/migrations/20261121000000_session_csrf_token/` — applied to the
canonical development database, not yet committed.

`IG-9` approved the pattern (synchronizer token, `X-CSRF-Token`, constant-time
comparison, `POST`/`PUT`/`PATCH`/`DELETE`) and *Amendment 3* left token length, encoding,
storage, retrieval, and rotation open. *Amendment 4* closes those four. This document is
the design record those decisions produced, plus the implementation plan they authorise
and the boundaries that plan must not cross.

Both halves of `ADR-006` §D2 now exist: `Origin` validation in the middleware chain, and
the synchronizer token in the database, the guard, and one endpoint. §2 and §3 below are
kept as the approved design; §6 records what was built and where it differs.

---

## 1. What exists, and what is missing

| Control | Status |
|---|---|
| `Origin` exact-match on `POST`/`PUT`/`PATCH`/`DELETE`, before body parsing | **implemented** |
| `SameSite=Lax` cookie, `__Host-` prefix, `HttpOnly`, `Secure` | **implemented** |
| Synchronizer token — generation, storage, retrieval | **implemented** (`GET /v1/auth/csrf`) |
| Synchronizer token — validation (`X-CSRF-Token`, constant time) | **implemented** (`AuthGuard`) |

`ADR-006` §D2 requires both controls and both are now in place, so `IG-9` is satisfied by
implementation rather than by approval. The remaining state difference is delivery: the
code is uncommitted, so the deployed commit is still `913b041`.

## 2. Approved design

| Property | Decision |
|---|---|
| Entropy | 32 bytes from `crypto.randomBytes` |
| Encoding | base64url, no padding — 43 characters |
| Shape rule | `^[A-Za-z0-9_-]{43}$` |
| Binding | one token per `app.sessions` row |
| Storage | **plaintext**, nullable column |
| Generation | lazy, on first retrieval for a `NULL` column |
| Retrieval | `GET /v1/auth/csrf`, behind `AuthGuard`, `Cache-Control: no-store` |
| Response | `{ "data": { "token": "…" } }` |
| Comparison | `crypto.timingSafeEqual`, after the shape check, over equal-length buffers |
| Failure | `403 FORBIDDEN`, standard envelope, no new error code |
| Rotation | none in this phase |
| Methods | `POST`, `PUT`, `PATCH`, `DELETE` on authenticated routes |
| Exempt | `register`, `login`, `logout` (`ADR-006` §D2.3 — `Origin` covers them) |

**Why plaintext.** The token is re-served on every retrieval so a second tab or a reload
keeps working. A hash-only column cannot be re-served, so it would force a new token per
retrieval — rotation by another name — and rotation breaks the multi-tab case. The token
is not a bearer credential: without the `HttpOnly` session cookie it authenticates
nothing, and an attacker who can read the session row already has the database. This is
not a relaxation of `ADR-005` §8; the session token remains hash-only.

**Why lazy generation.** A `NOT NULL` column needs a backfill of every live session, and
there is no way to backfill a random value from a runtime role without a `SECURITY
DEFINER` function or a migration that can fail halfway. `NULL` means "not issued yet", is
a legitimate state, and is resolved on first use. Existing sessions stay valid.

**Why no rotation.** There is no privilege escalation, role switch, or second factor in
this phase. Timer-based rotation would invalidate another tab's cached token and buy
nothing: the token only proves the request came from a page that could read the session's
own response.

## 3. Implementation plan (a later task)

### 3.1 Migration

1. `ALTER TABLE app.sessions ADD COLUMN csrf_token text` — nullable, no default.
2. `CHECK (csrf_token IS NULL OR csrf_token ~ '^[A-Za-z0-9_-]{43}$')`.
3. `GRANT SELECT (csrf_token), UPDATE (csrf_token) ON app.sessions TO app_auth`.
   Nothing to `app_api`, nothing table-wide.

Rejected forms, and why:

| Rejected | Reason |
|---|---|
| Generated column | `random()` is volatile; PostgreSQL forbids a volatile expression in a generated column |
| `SECURITY DEFINER` backfill function | unnecessary once the column is nullable; it would create a privilege the boundary does not need |
| `NOT NULL` at creation | forces a backfill, and no backfill decision is approved |
| Table-wide `UPDATE` | wider than the two columns the feature uses |

### 3.2 Retrieval and lazy write

```
GET /v1/auth/csrf           (AuthGuard)
```

- Read the session's `csrf_token`.
- If `NULL`, run one conditional update:
  `UPDATE app.sessions SET csrf_token = $2 WHERE id = $1 AND csrf_token IS NULL RETURNING csrf_token`
  and, when it returns nothing, re-read the row. Two simultaneous first retrievals must
  leave with the same value; the loser adopts the winner's token.
- Respond `200` with the token, `Cache-Control: no-store`.

The handler needs the session **row id**, which `AuthGuard` already attaches for exactly
this kind of use (`sessionId`).

### 3.3 Validation

Bound to authenticated state-changing routes, after `AuthGuard`:

1. Read `X-CSRF-Token`. Absent, empty, or wrong shape → `403 FORBIDDEN`.
2. `timingSafeEqual(Buffer.from(presented), Buffer.from(stored))`.
3. Mismatch, or a `NULL` stored token → `403 FORBIDDEN`.

`403`, not `401`: the session is valid and re-authenticating would not help. The shape
check precedes the comparison because `timingSafeEqual` throws on unequal lengths, which
would make "wrong token" and "wrong length" distinguishable.

A `NULL` stored token is a refusal, not an implicit pass: a caller that never retrieved
its token has not proven it can read the session's response.

### 3.4 Tests this needs

| Test | Assertion |
|---|---|
| Generation | 43 base64url characters, unique across a large sample, not derived from the session token |
| Retrieval | `200` for an active session; `401` for absent, malformed, revoked, expired, or unknown session; `no-store` |
| First retrieval race | two concurrent retrievals return the same token and leave one row value |
| Validation | missing, malformed, mismatched → `403 FORBIDDEN` with the standard envelope |
| Cross-session | a token from session A is rejected on session B |
| Exempt routes | `register`, `login`, `logout` succeed without the header |
| Session isolation | a token with a `NULL` column does not authenticate a state-changing request |
| Privilege boundary | `app_api` refused `42501` on `csrf_token`; `app_auth` refused on every other column |

## 4. Boundaries this document respects

- The documentation task that recorded these decisions added no column, migration, or
  grant, and nothing in the runtime read a CSRF token then. A separate implementation task
  has since added exactly one column, one CHECK, and two column grants (§6).
- `app_api` gains nothing. `app_auth` gains read and write on one column.
- No `SECURITY DEFINER` object, no `BYPASSRLS`, no RLS change.
- Existing sessions remain valid, and no session is invalidated by adding the column.

## 5. Consequences to state plainly

1. `IG-9` is approved, fully specified, and — as of 2026-11-21 — **implemented and
   verified**; `S8` may be reported complete on that basis, while the code remains
   uncommitted (§6).
2. The migration is small but it is still a migration: it needed the same review as the
   session migration, and `db:verify` gained the two grants and the CHECK. It is applied
   to the canonical development database; the code that depends on it is not committed.
3. `app_auth` gains the ability to write one column on a session row it can already read.
   That is the minimum the lazy write needs; it does not grant access to any other column.
4. A session whose token was never retrieved refuses state-changing requests. This is
   correct, and it is the one behaviour change clients must handle by fetching the token
   once per session.

## 6. Implementation record (2026-11-21)

What shipped, where it lives, and the three places the implementation is more specific
than the plan above.

| Piece | Location |
|---|---|
| Column, CHECK, two column grants | `prisma/migrations/20261121000000_session_csrf_token/migration.sql` |
| Prisma model field | `packages/database/prisma/schema.prisma` — `csrfToken String? @map("csrf_token")` |
| Lazy mint + conditional claim | `packages/database/src/auth-csrf.ts` — `resolveSessionCsrfToken` |
| Validation read | `packages/database/src/auth-csrf.ts` — `readSessionCsrfToken` |
| Generation, strict shape, constant-time compare, header reading | `apps/api/src/auth/csrf-token.ts` |
| Enforcement | `apps/api/src/auth/csrf-validator.ts`, called from `AuthGuard` |
| Endpoint | `apps/api/src/auth/auth.controller.ts` — `GET /v1/auth/csrf` |
| Contract | `packages/contracts/src/auth.ts` — `CSRF_TOKEN_PATTERN`, `csrfTokenResponseSchema` |

**Delta 1 — enforcement is inside `AuthGuard`, not in per-route metadata.** The plan
proposed a separate guard applied alongside `AuthGuard`. Building it that way would make
"authenticated mutation" and "CSRF-checked mutation" two lists that can drift, and the
failure mode is silent: a new route that forgets the second guard is authenticated and
unprotected. The requirement is derived from the method inside the guard that already
authenticates, so the two sets cannot diverge. It also produces the exemptions without a
list — `register`, `login`, and `logout` are not behind the guard at all.

**Delta 2 — the read and the claim repeat the session's validity predicates.** The plan
scoped both statements by `id` alone, relying on the guard's statement microseconds
earlier. They now also require `revoked_at IS NULL` and both deadlines, so a session that
becomes unusable between the two statements cannot hand out or accept a token. This is
what makes "a revoked or expired session cannot retrieve or validate its token" true of
the data layer and not only of the request path.

**Delta 3 — the shape check is canonical, not just a regex.** A 43-character value can
carry two bits that are not part of the 32-byte payload, so decoding is checked for
exactly 32 bytes and the value must re-encode to itself. The regex is exported from
`packages/contracts` so the wire contract and the validator cannot drift.

**Test evidence.** `test/integration/csrf.test.mjs` (12 real-role tests) proves the
migration's column, CHECK (`23514` on eight malformed values), lazy init, single-winner
concurrency, unusable-session refusal, `app_auth`'s exact column rights, and `app_api`'s
`42501` on `SELECT csrf_token`, `UPDATE csrf_token`, and the table itself.
`apps/api/test/csrf-token.test.mjs` covers entropy, encoding, the non-canonical case,
length-mismatch safety, and header ambiguity. `apps/api/test/auth-csrf.test.mjs` covers the
endpoint, `no-store`, `401` for every unusable session, stable repeat retrieval, the guard
method matrix (`403 FORBIDDEN` for missing/empty/short/non-canonical/duplicate/joined/
foreign/never-issued), safe methods needing no token, the three exemptions, `Origin` still
refusing a foreign origin on those exemptions, and no token through `/me`, login, or
registration. Unit and route suites run without a database; the integration suite runs as
the real roles.

**Known limitation.** Validation costs one extra `SELECT` of one column per authenticated
state-changing request; there is no cache, deliberately, because a cached token would be a
second source of truth for a value whose whole purpose is to be checked against the row.
