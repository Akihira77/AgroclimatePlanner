# S8 — CSRF synchronizer token: design proposal

**Status: proposal. Nothing in this document is implemented.**

`IG-9` approved the *pattern* (synchronizer token, `X-CSRF-Token`, constant-time compare,
`POST`/`PUT`/`PATCH`/`DELETE`) and left token length, encoding, storage, retrieval, and
rotation to `S8` design — `ADR-006` §D2.1, *Amendment 3* of
`docs/review/phase-3.2-owner-decisions.md`. The `S8` implementation covers `Origin`
validation (`ADR-006` §D2.2) and **no synchronizer token**. This document specifies the
token so the owner can approve or amend it before any storage exists.

Two things are deliberately absent from `S8`: a CSRF token column and a CSRF retrieval
endpoint. Both need an owner decision this document cannot make, because a column means a
migration and a grant change, and `S8` was scoped without either.

---

## 1. What is implemented now, and why it is not enough on its own

| Control | Status in `S8` |
|---|---|
| `Origin` exact-match on `POST`/`PUT`/`PATCH`/`DELETE`, before body parsing | implemented |
| `SameSite=Lax` session cookie, `__Host-` prefix, `HttpOnly`, `Secure` | implemented |
| Synchronizer token | **not implemented** — this proposal |
| Constant-time token comparison | not applicable until the token exists |

`Origin` validation is the stronger control against the browser-mediated attack this
project actually faces, and `ADR-006` §D2.3 makes it the only required control for
`register`, `login`, and `logout`. It is still one header, honoured by the browser and
absent from some non-browser and `GET`-derived contexts. Two independent controls is the
approval; shipping one is a documented gap, not a satisfied gate.

**Consequence for status reporting:** `S8` cannot be reported complete while the
synchronizer token is unimplemented. `ADR-006` §D2 states both controls are required, and
`D2.1` is one of them.

---

## 2. Token shape

| Property | Decision | Reason |
|---|---|---|
| Entropy | 32 bytes from `crypto.randomBytes` | Same source and size as the session token; no weaker secret next to a strong one |
| Encoding | base64url, no padding | URL- and header-safe, no escaping question in a header value |
| Length | 43 characters | Deterministic for 32 bytes; a shape check can reject anything else before comparison |
| Alphabet | `[A-Za-z0-9_-]` | base64url only; a token that needs a different alphabet is not a token |
| Derivation | **none** — independent CSPRNG output | `ADR-006` §D2.1.2 forbids derivability from anything the client holds, which rules out `HMAC(sessionToken)` and any hash of a cookie value |

The shape rule is enforced before comparison, exactly as `isWellFormedSessionToken` is
enforced before the session lookup: a value that cannot be a token must not become a
comparison input, and must not reach a query.

## 3. Association and storage

**One token per session row**, in a new column on `app.sessions`:

```
csrf_token text NOT NULL
```

Three candidate designs were considered:

| Design | Verdict |
|---|---|
| Column on `app.sessions`, plaintext | **recommended** — see below |
| Column on `app.sessions`, `sha256` only | rejected: the token would have to be reissued on every retrieval, so a two-tab SPA breaks and rotation becomes load-bearing instead of defensive |
| Separate `session_csrf_tokens` table | rejected: one row per session, joined on every state-changing request, for no property the column does not already have |

**Why plaintext is acceptable here, and why it is not a precedent.** A CSRF token is not a
bearer credential: possessing it grants nothing without the session cookie, and a
cross-site attacker cannot read it because the response is same-origin. It is stored
readable for the same reason a session id is readable in a server-side store. The session
token is different in kind — it *is* the credential — which is why only its hash is
persisted (`ADR-005` §8). If the owner prefers hash-only storage, the retrieval endpoint in
§4 has to become "issue a new token on every call", and that is a different security
posture, not an implementation detail.

**Constraints the column inherits from the plan it lives in:**

- `NOT NULL` with no default: an existing row without a token would be a session that
  cannot pass a state-changing request, which is invisible until it fails. The migration
  must backfill (see §7).
- Shape CHECK `^[A-Za-z0-9_-]{43}$`, matching `sessions_token_hash_shape_check` in style.
- The `app_auth` column grant must be extended to include `csrf_token`, and nothing else.
  The existing grant is column-level; a `SELECT *` already fails with `42501`, so the new
  column must be named in every statement that reads it.

## 4. Retrieval

`GET /v1/auth/csrf`, guarded by `AuthGuard`:

```json
{ "data": { "token": "<43 base64url chars>" } }
```

- `200` with the token for an active session.
- `401 UNAUTHENTICATED` for absent, malformed, revoked, or expired session — the guard
  already produces this, so the handler has no branch of its own.
- `Cache-Control: no-store`, because the value is session-scoped and per-response.
- The session token is never in the body, and the response never echoes the cookie.
- `GET` is not a state-changing method, so `Origin` validation does not apply to it and
  browser same-origin policy is what protects the read.

The client fetches this once per session (on app load, after login) and attaches the value
as `X-CSRF-Token` to every state-changing request. `X-CSRF-Token` is already in the CORS
allowlist, so no CORS change is needed on the day this lands.

## 5. Validation

For `POST`, `PUT`, `PATCH`, `DELETE` on any route with an authenticated subject:

1. The header is read. Absent, empty, or wrong-shaped → `403 FORBIDDEN`.
2. The presented value is compared to the session row's `csrf_token` using
   `crypto.timingSafeEqual` over equal-length buffers.
3. Mismatch → `403 FORBIDDEN`.

Comparison is constant-time over the *fixed* 43-character length, which is why the shape
check precedes it: `timingSafeEqual` throws on length mismatch, and a thrown exception on
a bad token is a distinct behaviour from a mismatch.

`403 FORBIDDEN` rather than `401`: the session is valid, the request is not authorised.
Returning `401` would tell the client to re-authenticate for a problem that
re-authenticating does not fix.

**Placement.** The check belongs in a guard bound to state-changing routes, after
`AuthGuard` (it needs the session) and after the body has been read — nothing downstream
may act before it. It cannot be a middleware, because it needs the validated session that
`AuthGuard` attaches. `Origin` validation stays in front of everything, before parsing:
the two controls have different prerequisites, and ordering them by strength instead of by
what they need is how one of them ends up running too late.

**Exemptions.** `register`, `login`, and `logout`: `ADR-006` §D2.3 makes `Origin` their
required control. `logout` is exempt for the same reason it never returns `401` — a logout
that requires a token the client may no longer hold is a logout that fails exactly when it
is needed.

## 6. Rotation

| Event | Behaviour |
|---|---|
| Login | New session, new token. No rotation logic — the row is new. |
| Logout / revocation | Token is unreachable with the session; no rotation needed. |
| Any other event | **No rotation.** |

Rotating on a timer, on every request, or on privilege change is not proposed: there is no
privilege escalation in `S8`, no role switching, and no second factor. Rotation on a timer
would invalidate a second tab's cached token with no security gain, because the token's
only job is to prove the request came from a page that could read the session's own
response. If a future phase adds privilege change, rotate there and record it.

`ADR-006` §D2.1's "the frontend obtains it through a dedicated mechanism" is satisfied by
§4; the ADR leaves rotation open, and "never, in this phase" is the smallest rule that
holds.

## 7. Migration and grants this needs (blocked on approval)

`S8` added no migration. Implementing §3 requires one, and it is not mechanical:

1. `ALTER TABLE app.sessions ADD COLUMN csrf_token text` — nullable first.
2. Backfill existing rows. Active rows get a fresh generated value; there is no way to
   derive one, so a `SECURITY DEFINER` backfill function is needed (the existing
   `purge_expired_sessions()` is the precedent) or the column is added and populated in the
   same migration with a generated expression. Rows that are revoked or expired need no
   usable value, but `NOT NULL` applies to them too.
3. `ALTER COLUMN csrf_token SET NOT NULL` plus the shape CHECK.
4. `GRANT SELECT (csrf_token), UPDATE (csrf_token) ON app.sessions TO app_auth` — and only
   those. Whether rotation needs `UPDATE` at all depends on §6: with no rotation, `SELECT`
   alone is what the validation path needs, and `UPDATE` should not be granted
   speculatively.
5. `db:verify` gains assertions for the new grant and the new CHECK; `test:rls` gains a
   denial case for `app_api` on the column.

Migration safety: adding a nullable column is cheap; `SET NOT NULL` rewrites and locks the
table, which is acceptable at this table's size but must be
stated rather than assumed. A `CHECK` added with `NOT VALID` and validated separately is
the zero-downtime form if the table ever grows.

## 8. Testing this would need

| Test | Assertion |
|---|---|
| Token generation | 43 base64url characters, unique across a large sample, independent of the session token |
| Retrieval | `200` for an active session, `401` for every unusable session, no session token in the body, `no-store` |
| Validation | missing header, wrong shape, and mismatch are all `403 FORBIDDEN` with the standard envelope |
| Correct token | the request proceeds; the handler sees the same subject |
| Exempt routes | `login`, `register`, `logout` succeed without a header |
| Cross-session | a token from session A is rejected on session B |
| Constant-time | buffer lengths are equal before comparison (shape check is the proof) |

## 9. Decisions the owner must make

1. **Approve the column, or choose another storage shape.** A migration and a grant change
   are involved either way; §3 is the recommendation.
2. **Plaintext storage, or hash-only with reissue on retrieval.** §3 argues plaintext; the
   alternative changes the client contract.
3. **`403 FORBIDDEN` as the single failure**, or a distinct code. The bounded code set
   already carries `FORBIDDEN`, and adding a code is a contract change.
4. **No rotation in this phase.** If any rotation is required, say which event triggers it.

Until 1–4 are answered, `S8` reports the synchronizer token as **not implemented**, and the
`IG-9` gate as **partially satisfied**: the pattern, header, methods, and origin source are
implemented; length, encoding, storage, retrieval, and rotation are not.
