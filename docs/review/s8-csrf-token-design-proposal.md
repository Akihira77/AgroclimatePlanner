# S8 — CSRF synchronizer token: design record

**Status: decisions approved, implementation not started.**
**Decided in:** *Amendment 4* of `docs/review/phase-3.2-owner-decisions.md` (2026-11-21).
**Durable architectural record:** `docs/adr/ADR-006-session-transport-and-csrf.md` §D2.

`IG-9` approved the pattern (synchronizer token, `X-CSRF-Token`, constant-time
comparison, `POST`/`PUT`/`PATCH`/`DELETE`) and *Amendment 3* left token length, encoding,
storage, retrieval, and rotation open. *Amendment 4* closes those four. This document is
the design record those decisions produced, plus the implementation plan they authorise
and the boundaries that plan must not cross.

Nothing below is implemented. No column, migration, grant, endpoint, middleware, or guard
exists for CSRF. `Origin` validation (`ADR-006` §D2.2) is implemented and is the only
CSRF control shipping today.

---

## 1. What exists, and what is missing

| Control | Status |
|---|---|
| `Origin` exact-match on `POST`/`PUT`/`PATCH`/`DELETE`, before body parsing | **implemented** |
| `SameSite=Lax` cookie, `__Host-` prefix, `HttpOnly`, `Secure` | **implemented** |
| Synchronizer token — generation, storage, retrieval | **not implemented** |
| Synchronizer token — validation (`X-CSRF-Token`, constant time) | **not implemented** |

`ADR-006` §D2 requires both controls. Until the token exists, `IG-9` is partially
implemented and `S8` is not complete.

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

- No column, migration, or grant is added by the documentation task that recorded these
  decisions, and nothing in the runtime reads a CSRF token today.
- `app_api` gains nothing. `app_auth` gains read and write on one column.
- No `SECURITY DEFINER` object, no `BYPASSRLS`, no RLS change.
- Existing sessions remain valid, and no session is invalidated by adding the column.

## 5. Consequences to state plainly

1. `IG-9` is approved and fully specified but **not implemented**; `S8` must not be
   reported complete until it is.
2. The migration is small but it is still a migration: it needs the same review as the
   session migration, and `db:verify` must gain the two grants and the CHECK.
3. `app_auth` gains the ability to write one column on a session row it can already read.
   That is the minimum the lazy write needs; it does not grant access to any other column.
4. A session whose token was never retrieved refuses state-changing requests. This is
   correct, and it is the one behaviour change clients must handle by fetching the token
   once per session.
