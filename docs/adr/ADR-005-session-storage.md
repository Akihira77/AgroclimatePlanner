# ADR-005 — PostgreSQL Session Storage

- Status: **Accepted** — approved by **Akihira77 on 2026-11-20**. This ADR formalises
  decision `AG-2`, recorded by the repository owner on 2026-11-18 in
  `docs/review/phase-3.2-owner-decisions.md` §2.10, plus the three schema decisions
  `D-1`–`D-3` the owner accepted on 2026-11-20 (§2.11). That approval is the decision;
  this document is its durable record, and acceptance of it is the owner's act, separate
  from the approvals it records. Acceptance is a **documentation gate, not
  implementation**: `S5` and `S6` have not started, `app.sessions` does not exist, and
  `OPEN-13` stays unresolved until the owner applies the migration to the canonical
  database and the session suite is green there.
- Date: 2026-11-18 (decision date), schema decisions 2026-11-20, accepted 2026-11-20,
  recorded here 2026-11-20
- Depends on: ADR-002 (D5), ADR-003, ADR-004, `docs/review/phase-3.2-design-review.md`
  §4.3, §6, §12.2, §17
- Supersedes: none
- Preserves: ADR-002 D5 — "server-side sessions in PostgreSQL, not JWT", with JWT +
  refresh rotation in D5's rejected list. Nothing in D5 is amended by this ADR.
- Implemented by: `docs/implementation/phase-3.2.3-authentication-database-boundary.md`
  (steps S5, S6) — **plan only, nothing applied**
- Register entry: `OPEN-13` (P1, hard) — **still unresolved**, see *Related decisions
  and open decisions*

## Context

ADR-002 D5 chose server-side sessions in PostgreSQL and rejected JWT with refresh
rotation. That decision was never implemented: `entity-catalog.md` lists `sessions` as
unspecified, no table, model, grant, or job exists, and `OPEN-13` holds the question
open.

The environment shapes the choice more than the preference does. The stack has one
database and no cache: `docker-compose.yml` defines a single `db` service, and
`ioredis`/`bullmq` resolve to nothing in the lockfile. Redis is documented for
background processing but not provisioned. Choosing it would add a service, a second
authority, and a second failure mode to the one path — authentication — that has the
least tolerance for either.

The alternative question is therefore not "table versus cache" in the abstract. It is
whether an unauthenticated network service should become the authority for deciding
who a request is, when the only durable store the system already backs up, restores,
and replicates is PostgreSQL.

## Problem statement

Where does an authenticated session live, what does a stored session contain, what
bounds its lifetime, and which database role may read or change it?

## Decision

**Sessions are rows in `app.sessions`, reached only by `app_auth`.** The client holds
an opaque bearer token; the database holds only its SHA-256 hash.

### Alternatives that were rejected

| Alternative | Why rejected |
|---|---|
| **Redis** | reverses ADR-002 D5; adds a service absent from `docker-compose.yml`; makes an unauthenticated network service the authentication authority; its TTL/revocation ergonomics do not pay for a second authority and a second outage domain |
| **JWT, stateless** | cannot revoke before natural expiry without a denylist, which is a store — so it buys nothing and loses "revoked means revoked" |
| **JWT + refresh-token rotation** | the design ADR-002 D5 already rejected; two token types, two lifetimes, and rotation-reuse detection to implement for no capability the table lacks |
| **Session rows keyed by tenant GUC** | unusable at the moment that matters: a session is read *before* identity exists. It would also tempt an implementer to set `app.user_id` from an unauthenticated request — the forgery ADR-003 measured |

## Session token design

| Property | Value | Reason |
|---|---|---|
| Entropy | 32 bytes from a CSPRNG (`crypto.randomBytes(32)`) | 256 bits; guessing is not a threat model at any request rate |
| Encoding | base64url, 43 characters | URL-safe, no padding, cookie-safe |
| Opacity | the token carries no user id, role, or timestamp | a caller learns nothing by decoding it |
| Authority | server-side row only | the token is a lookup key, not a claim |
| Lifetime | sliding 30 days, absolute 90 days | see §8 |
| Rotation | none in v1 | rotation is an application security decision for the authentication track, not a property of this store |

## Token hashing and storage

- Only `sha256(token)` is persisted, hex-encoded lowercase, in `token_hash`, which is
  `UNIQUE`. The encoding is not a stylistic choice any more: `D-1` (accepted
  2026-11-20) makes it a database constraint.
- The CHECK constrains the **representation**, not the derivation. It rejects a value
  that is not 64 lowercase hex characters; it cannot tell a correctly computed
  `sha256(raw token)` from any other 64-character lowercase hex string, including a
  double hash or a hash of the wrong input. `sha256(token)` being the value written is
  an application property, verified by one test that compares the stored column against
  the hash of the presented token.
- SHA-256 without a salt or KDF is correct **here** and only here: the input is 256
  bits of CSPRNG output, so there is no dictionary to attack and no rainbow table to
  build. This is not the password path and must never be reused as one. Passwords are
  a separate decision (`IG-6`).
- The raw token exists in exactly two places: the caller's cookie, and process memory
  for the duration of the request. It is never written to the database, a log line, a
  metric label, a trace attribute, or an error message. The existing log-hygiene rule
  (`c762171`) applies unchanged and extends to the auth path.
- The hash is a lookup key, not a secret: possessing a stored hash does not
  authenticate, because the lookup is `WHERE token_hash = sha256(presented)`.

## Session expiration semantics

Three independent conditions govern validity, and all three are checked on every
validation:

| Column | Meaning | Violation |
|---|---|---|
| `expires_at` | sliding deadline, extended on activity | expired session — must be treated as unauthenticated |
| `absolute_expires_at` | hard deadline, set at creation, never extended | expired session, regardless of activity |
| `revoked_at` | explicit revocation; `NULL` means not revoked | revoked session — checked before the other two |

### What PostgreSQL can and cannot enforce

The distinction matters because `app_auth` holds the `INSERT` grant and is therefore
allowed to *choose* the initial `absolute_expires_at`. Without `D-2`, the column's
90-day rule would be a sentence in this document and nothing else.

| Invariant | Layer | Mechanism | What it actually prevents |
|---|---|---|---|
| `absolute_expires_at` never changes after creation | **database** | no `UPDATE` grant covers the column (`GRANT UPDATE (expires_at, last_seen_at, revoked_at)`) | a session being pushed past its deadline, or re-pointed at a new user |
| `expires_at` is later than `created_at` at insert | **database** | `CHECK (expires_at > created_at)` | a session inserted already expired, which would authenticate nothing and still occupy a unique hash |
| `absolute_expires_at` is at most 90 days after creation | **database** — `D-2`, accepted 2026-11-20 | `CHECK (absolute_expires_at <= created_at + INTERVAL '90 days')` | a `10-year` session inserted in one statement; the bound is a maximum, not an equality |
| `expires_at` never exceeds the absolute deadline | **database** | `CHECK (absolute_expires_at >= expires_at)` | an extension that outlives the hard deadline, including the clamped value |
| `token_hash` is a 64-character lowercase hex string | **database** — `D-1`, accepted 2026-11-20 | `CHECK (token_hash ~ '^[0-9a-f]{64}$')` | persisting a raw base64url token by mistake; it validates the representation, not the derivation |
| `expires_at` is exactly 30 days after the last extension | **application only** | none | nothing at the database layer |
| Extension happens at most once per 5 minutes | **application only**, and mandatory | none | nothing at the database layer; see *Concurrency* below |
| An expired or revoked row is not honoured | **application only** | the read predicate | nothing at the database layer |

The three predicates the database enforces are one constraint on the row's own
timestamps plus the two accepted additions, and they are written here in full because
an earlier draft of this ADR recorded only the second one:

```sql
-- Proposed by the S5 migration. NOT APPLIED.
CONSTRAINT sessions_expiry_order_check
  CHECK (absolute_expires_at >= expires_at AND expires_at > created_at),
CONSTRAINT sessions_token_hash_shape_check
  CHECK (token_hash ~ '^[0-9a-f]{64}$'),            -- D-1, accepted 2026-11-20
CONSTRAINT sessions_absolute_expiry_cap_check
  CHECK (absolute_expires_at <= created_at + INTERVAL '90 days')  -- D-2, accepted
```

Each predicate answers a different question, and collapsing them into "the expiry
check" loses one of the three every time:

| Predicate | Question | Failure it rejects |
|---|---|---|
| `expires_at > created_at` | can a session be born dead? | an insert whose sliding deadline is already past |
| `absolute_expires_at >= expires_at` | can a session outlive its hard deadline? | an unclamped or over-eager extension, at `23514` |
| `absolute_expires_at <= created_at + 90 days` | how long may the credential live? | a single-statement decade-long session |

The `>=` rather than `>` in the middle predicate is not sloppiness: a clamped extension
legitimately makes the two timestamps equal at the end of a session's life, which is why
the pair must be stated together. An earlier summary in `design review §17` recorded only
one clause; it has been corrected to match this one, and `AG-2` §2.4 governs either way.

Four rules follow from that table:

1. **A session cannot outlive its absolute expiration.** `absolute_expires_at` is
   written once at creation and no grant permits changing it (`UPDATE` covers
   `expires_at`, `last_seen_at`, `revoked_at` only). The *upper bound* on the initial
   value is the `D-2` 90-day CHECK; the choice of a value within that bound is the
   application's.
2. **Sliding expiration can never exceed absolute expiration.** The extension is
   clamped: `LEAST(now() + interval '30 days', absolute_expires_at)`. `LEAST()` bounds
   **the statement the application runs** and nothing else — it is an expression in a
   query, not a constraint on the column. The constraint that makes the result legal is
   `absolute_expires_at >= expires_at`, with `>=` rather than `>` because the clamped
   value legitimately coincides with the absolute deadline at the end of a session's
   life.
3. **The 30-day sliding window is an application invariant.** It cannot be expressed as
   a table constraint: `expires_at` is relative to *the moment of extension*, and the
   only columns that record anything are `last_seen_at` and `expires_at` themselves.
   A constraint such as `expires_at <= last_seen_at + 30 days` was evaluated and
   rejected — it constrains two values the application writes in the same statement, so
   it catches a typo while giving an appearance of enforcement that a caller controlling
   both columns does not face. The absolute cap is the only lifetime rule worth a
   constraint, because it bounds the credential itself rather than one write.
4. **Runtime validation is not garbage collection.** Expiry is enforced by the
   application's predicate on every request. GC only reclaims rows nobody can use; a
   row that is past `expires_at` but not yet purged must still be rejected by the
   application. Conflating the two is how an expired session becomes valid again after a
   failed job run.

### Concurrency — the throttle is an invariant, not advice

"A session may be extended at most once per five minutes" (`AG-2` §2.4, step 3) is a
**mandatory application invariant**. It is not a best-effort optimization, and it does
not become advisory because two requests can race: concurrent requests for the same
session must not produce two extensions inside the window.

This ADR deliberately does not solve that, and says so rather than implying a solution:

- The **database foundation** this ADR describes does not implement the throttle
  protocol. It supplies the columns, the grants, and the clamp; a column grant cannot
  express "at most once per five minutes", and a constraint on
  `expires_at`/`last_seen_at` would only constrain two values the same statement writes
  (rule 3).
- The **atomic update or row-locking strategy** — a conditional `UPDATE` whose predicate
  re-checks the window, a `SELECT … FOR UPDATE` around the read-modify-write, or an
  advisory lock per session — is a decision for the authentication workflow milestone
  **S7**, where the request path and its transaction boundaries exist and can be tested
  under concurrency.
- **S5 must not claim to have solved it.** S5 creates no request path, runs no
  concurrency test, and ships no procedure. A verifier row that asserted "extension
  happens at most once per five minutes" at S5 would be asserting something no object
  in the database enforces.

The clamp bounds the *result* of any number of racing extensions — `expires_at` can
never pass `absolute_expires_at` — but bounding the result is not enforcing the
throttle, and the two must not be conflated.

One consequence to state plainly rather than bury: the absolute cap is a **maximum**,
not an equality. A bug that writes `created_at + 1 day` produces a short-lived session
that no constraint rejects — the user simply logs in again. Only the direction that
extends a credential is worth a schema rule.

## Revocation

- `revoked_at timestamptz` is the only revocation mechanism. Logout sets it; a stolen
  token stops working on the next request rather than at the next expiry.
- Revocation of all sessions for a user is the same grant with `WHERE user_id = $1`,
  which is why `SELECT (user_id)` is granted.
- **Un-revocation is possible.** `UPDATE (revoked_at)` has no direction: a credential
  that can set it can also clear it. This is accepted and disclosed (`AG-2` S-5, owner
  record R-4); no grant expresses "may revoke but not un-revoke".
- Deleting a session is not a runtime capability. `DELETE` is granted to no runtime
  role; only the GC function removes rows, and only rows past the absolute deadline.

## Database table ownership and grants

Ownership: `app.sessions` and its indexes are created by the migration connection and
are owned by `migration_owner`, like every other object in `app`.

```sql
-- Proposed by the S5 migration. NOT APPLIED.
GRANT SELECT (id, user_id, token_hash, expires_at, absolute_expires_at,
              revoked_at, last_seen_at, created_at) ON app.sessions TO app_auth;
GRANT INSERT (user_id, token_hash, expires_at, absolute_expires_at) ON app.sessions TO app_auth;
GRANT UPDATE (expires_at, last_seen_at, revoked_at) ON app.sessions TO app_auth;
-- no DELETE grant to any runtime role
-- no table privilege of any kind to app_api or app_system
-- app_system receives EXECUTE on app.purge_expired_sessions() instead — see
-- "Garbage collection"; that is a function privilege, not a table one
```

What the column grants do and do not do, stated because it is easy to over-read them:

- They constrain **writes**. `app_auth` cannot change `token_hash`, `user_id`,
  `absolute_expires_at`, or `created_at`, so a session cannot be re-pointed at another
  user or pushed past its absolute deadline.
- `created_at` is outside the `INSERT` grant as well as the `UPDATE` one. That is what
  keeps the `D-2` 90-day cap meaningful: a caller cannot backdate `created_at` to
  make an arbitrarily long deadline pass
  `absolute_expires_at <= created_at + INTERVAL '90 days'`. Both timestamps come from
  the same transaction timestamp `now()`, and only one of them is the caller's to
  choose.
- They do **not** hide session rows from `app_auth`. The `SELECT` list covers every
  column, so the auth credential can read every session row. That is `AG-2` S-4,
  accepted, and §14 explains why no policy fixes it.
- `app_api` and `app_system` hold no table privilege at all. `FORCE RLS` means that a
  future mistaken `GRANT SELECT` would still return zero rows — but the absence of the
  grant, not the policy, is the boundary.

## RLS behavior

```sql
-- Proposed by the S5 migration. NOT APPLIED.
ALTER TABLE app.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.sessions FORCE  ROW LEVEL SECURITY;

CREATE POLICY sessions_auth_all ON app.sessions
  FOR ALL TO app_auth USING (true) WITH CHECK (true);
CREATE POLICY sessions_owner_full_access ON app.sessions
  FOR ALL TO migration_owner USING (true) WITH CHECK (true);
```

`USING (true)` is not an oversight and not a placeholder for a policy that was meant to
be tenant-shaped. A session is read before identity exists, so the only predicate that
would work is the token hash itself — and that predicate belongs in the query, not in
a policy. The consequences:

- **RLS does not isolate sessions between users.** `app_auth` can read all of them.
  Isolation is enforced by the query shape (`WHERE token_hash = $1`), by the token's
  entropy, and by the fact that nothing else in the system can query the table. This
  must be said in a comment where the query lives, because a future reader will
  otherwise assume the policy did it.
- `FORCE` is retained: `migration_owner` is the table owner and stays subject to its
  own policy, which is what keeps fixtures, migrations, and the GC function working.
  Removing `sessions_owner_full_access` would silently break garbage collection.
- `app_auth` is `NOBYPASSRLS`, so enabling RLS costs it no capability it was granted
  and gives it none it was not.

## Garbage collection

`app.purge_expired_sessions()` — `SECURITY DEFINER`, owned by `migration_owner`,
`EXECUTE` to `app_system` alone, hourly in the `maintenance` queue.

```sql
-- Proposed by the S5 migration. NOT APPLIED.
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

Why it needs elevated context, and why that is not a loophole:

1. No runtime role holds `DELETE` on the table — deliberately, because a `DELETE` grant
   cannot be column-scoped and would let the auth credential erase sessions it should
   only revoke. The sweep must therefore run as a role that may delete: the owner.
2. `FORCE RLS` applies to the owner too, so the owner policy is load-bearing. Delete it
   and the sweep fails with `42501` — the sweep stops working the day someone removes
   an apparently unused policy.
3. `SET search_path = pg_catalog, app` pins name resolution so a caller's
   `search_path` cannot redirect the `DELETE`. `pg_catalog` is listed explicitly even
   though PostgreSQL searches it first, because the whole list is what makes the
   function immune to the caller.
4. `EXECUTE` is granted to `app_system` only, and `app_system` gains no table grant —
   it can run the sweep and nothing else. `PUBLIC` is revoked explicitly; the default
   `EXECUTE` to `PUBLIC` is not a default this design accepts.
5. The `WITH deleted … count(*)` shape is required, not stylistic: a scalar SQL
   function may return at most one row, and a bare `DELETE … RETURNING 1` returns one
   row per session — it would error the first hour two sessions expired.
6. It purges on `absolute_expires_at`, not `expires_at`, so an idle-but-not-yet-expired
   session is never collected. The cost is a bounded amount of dead rows: at most 90
   days of sessions, which is the approved semantics rather than a bug.
7. **A return value of `0` is a success, not a failure.** The three outcomes are
   distinct and must be reported as such: the function ran and found nothing eligible
   (`0`), the function ran and removed `n` rows (`n > 0`), or the function did not
   complete (an error, no return value). `AG-2` §2.9 item 8 says a `0` count is not a
   failed job, and job health is read from the `maintenance` queue's execution record —
   a value the SQL function cannot observe about itself. No scheduler exists in S5;
   nothing calls this function until Phase 4 enqueues it hourly.

**Scope discipline.** This is the only `SECURITY DEFINER` object in the repository and
it must stay narrow. It reads no credential, returns a count, touches one table, and
cannot be parameterised into something else. ADR-003's rejection of a definer-based
tenant validator does not transfer to it; equally, this function's existence is not
precedent for a definer credential read (ADR-004, *Decision*, alternative B2) or any elevated
helper. A new definer function is a new decision.

## Accepted owner decisions on schema details

`AG-2` approved the architecture from *Decision* through *Garbage collection*. It did
not decide three schema details, which this ADR previously listed as proposals. The
owner accepted all three on **2026-11-20**; the durable record is
`docs/review/phase-3.2-owner-decisions.md` §2.11. They **supplement** `AG-2` and do not
amend it.

| ID | Decision | Exact object |
|---|---|---|
| `D-1` | Accept | `CONSTRAINT sessions_token_hash_shape_check CHECK (token_hash ~ '^[0-9a-f]{64}$')` |
| `D-2` | Accept | `CONSTRAINT sessions_absolute_expiry_cap_check CHECK (absolute_expires_at <= created_at + INTERVAL '90 days')` |
| `D-3` | Accept | `sessions_user_id_idx (user_id)`, `sessions_absolute_expires_at_idx (absolute_expires_at)` |

Why each is load-bearing:

- **`D-1`** — nothing else in the schema distinguishes a hash from a raw token. A bug
  that stored the 43-character base64url token would still authenticate. 64 lowercase
  hex characters is exactly the encoding of `sha256(32 bytes)`, so that mistake fails at
  `23514` instead of persisting a working credential. It constrains the
  **representation**, not the derivation.
- **`D-2`** — `app_auth` holds the `INSERT` grant, so it chooses the initial
  `absolute_expires_at`. Without this CHECK the 90-day rule is documentation only, and
  one statement can mint a decade-long session. The bound is a **maximum, not an
  equality**: a shorter session still passes, because a short session is a usability bug
  rather than a security one. **Insert constraint:** `created_at` defaults to `now()`,
  which is `transaction_timestamp()` — the instant the current *transaction* began, not
  the instant the current statement began — so both deadlines must be derived from that
  same clock: `now() + interval '30 days'` and `now() + interval '90 days'`. They must
  not come from a JavaScript `Date.now()`, and they must not use
  `statement_timestamp()` or `clock_timestamp()`, because either one is later than the
  value `created_at` received: a deadline that should be 90 days, but is computed from
  any clock other than `now()`, is later than `created_at + 90 days` by the elapsed time
  and fails `23514`. Using `now()` for both makes the three timestamps identical by
  construction, including inside a long transaction.
- **`D-3`** — `token_hash` is already `UNIQUE` and carries the request path. The two
  added indexes support revoke-all-by-user and the GC scan; without them both degrade to
  a sequential scan as rows accumulate. An index supports a path; it does not guarantee
  a plan. No further index is approved.

### Provenance of every element in this design

Stated so a later reader can tell an owner decision from an engineering choice, and can
see what remains undecided:

| Element | Provenance |
|---|---|
| PostgreSQL over Redis/JWT, `app.sessions`, `app_auth`-only access | `AG-2` (§2.10), 2026-11-18 |
| Columns, 30-day sliding window, 90-day absolute, 5-minute throttle, `revoked_at` | `AG-2` (§2.4, §2.6, §2.9), 2026-11-18 |
| Expiry-order CHECK (`absolute_expires_at >= expires_at AND expires_at > created_at`) | `AG-2` §2.4, corrected here to three clauses |
| `token_hash` shape CHECK, 90-day cap CHECK, two indexes | `D-1`–`D-3`, 2026-11-20 |
| `sessions_auth_all FOR ALL TO app_auth USING (true) WITH CHECK (true)` + owner policy | `AG-2` §2.4/§2.7, accepted |
| `app.purge_expired_sessions()` definer shape, `EXECUTE` to `app_system` | `AG-2` §2.9, accepted |
| Column-grant list, function body, policy names, index names | engineering detail, constrained by the rows above |
| Throttle enforcement mechanism under concurrency | **undecided**, owned by S7 |
| `sessions.user_id` FK action under account deletion | the proposed S5 FK names no action, so PostgreSQL's default `NO ACTION` would apply if that DDL is applied; it is not an owner decision, and the lifecycle policy remains **undecided**, blocked by `OPEN-04` |

## Security properties

| Property | Enforced by | Evidence required |
|---|---|---|
| Validity requires not-revoked, not-sliding-expired, not-absolutely-expired | application | three independent tests, each failing for its own reason |
| Only a hash is stored | application + `D-1` CHECK | the `token_hash` shape CHECK rejects a 43-char base64url token at `23514` |
| `absolute_expires_at` cannot be extended | PostgreSQL | no `UPDATE` grant covers it; `42501` |
| `absolute_expires_at` is at most 90 days from creation | PostgreSQL — `D-2` | an insert at `created_at + 91 days` fails `23514` |
| `expires_at` cannot exceed the absolute deadline | PostgreSQL | the expiry-order CHECK rejects the row at `23514` |
| The 30-day sliding window is exactly 30 days | **nobody** | application invariant; no constraint can express it |
| `token_hash` and `user_id` cannot be rewritten | PostgreSQL | no `UPDATE` grant covers them; `42501` |
| No runtime role can delete sessions | PostgreSQL | no `DELETE` grant; `42501`, GC reachable only through the function |
| `app_api` and `app_system` cannot read sessions | PostgreSQL | `42501` on all four verbs, per role |
| Purge cannot delete a live session | PostgreSQL | the predicate is `absolute_expires_at < now()`; tested with a live row present |
| The raw token never persists | application + review | no column holds it; log hygiene extends to the auth path |

## Explicit limitations

1. **RLS does not isolate sessions between users.** `USING (true)`, by design. A
   compromised `app_auth` credential reads every session row, and RLS cannot prevent
   it. Sessions are protected by entropy and query shape, not by a policy.
2. **A compromised API process holds a valid session for every logged-in user.** It
   can read every `token_hash`… which is not enough to authenticate, because the
   lookup needs the raw token — but it can also mint a session for any `user_id`. That
   is the real exposure, accepted in ADR-004's *Explicit limitations*.
3. **Token theft, fixation, rotation, and replay detection belong to the application
   security design** (`IG-8`, `IG-9`), not to this store. The table provides the
   columns; it provides no predicate.
4. **A token is a bearer credential.** Anyone who presents it is that user. Nothing in
   the database binds it to an IP, a user agent, or a device.
5. **Un-revocation is possible** with the granted column, as described under
   *Revocation*.
6. **GC is not expiry.** A failed or unscheduled sweep does not extend any session's
   usable life, because validity is checked at read time. Conversely, GC cannot make an
   expired session valid.
7. **No scheduled job exists yet.** The `maintenance` queue is Phase 4 work
   (`background-processing.md`: "Implementation in Phase 4"). S5 makes the function
   callable; nothing calls it on a schedule, and session rows accumulate until something
   does.
8. **One round trip per authenticated request**, plus one write per 5 minutes per
   active session. Accepted; a cache in front of it would be a second authority.
9. **Sessions do not survive nothing** — they survive a PostgreSQL restart, a Redis
   restart would not, and backup/restore already covers this table like any other.
10. **`app_auth` chooses the absolute deadline within the cap.** The database enforces
    "at most 90 days" (`D-2`); it can never enforce "the application intended 90 days".
    A session created 89 days long is legal at the database layer. Likewise, a
    compromised `app_auth` inserts a session for any `user_id` and may shorten a session
    it should not touch — bounded only by the statement's own columns, not by intent.
11. **The throttle is not enforced by any database object.** Concurrent extensions are
    bounded in result by the clamp but not prevented; enforcement is S7's, as stated
    under *Concurrency*.

## Availability and failure behaviour

The session store is a hard dependency of every authenticated request. There is no
degraded mode, and this ADR does not pretend otherwise:

| Situation | Required | Forbidden |
|---|---|---|
| Store unreachable during authentication | `503`, after a bounded timeout and at most one retry | treating the request as anonymous, or trusting a client-supplied identity |
| Store unreachable on logout | `503` | `204`; a claimed revocation that did not happen is the only failure that stays silent |
| Store fails after validation succeeded | the request proceeds on the already-validated subject | re-validating mid-request |
| Store unavailable during the GC sweep | the sweep fails and is retried; validity is unaffected | a "success" with no count, or any change to session lifetime |

The reason is the same one `ADR-002:54` states for Redis eviction: an infrastructure
failure must never change what a farmer was told, and it must never silently change
who a request is. Fail closed, and say `503` rather than 200.

## `OPEN-04` — account deletion, and the proposed foreign key

`app.sessions` does not exist yet: S5 has not started, and the table, its constraints, and
this foreign key are proposed implementation details. The proposal declares:

```sql
-- Proposed by the S5 migration. NOT APPLIED.
sessions.user_id uuid NOT NULL REFERENCES app.users (id)
```

No `ON DELETE` clause appears in that declaration. **If** the proposal is applied as
written, PostgreSQL fills the omission with its default referential action, `NO ACTION`.
That is a statement about PostgreSQL, not about this repository's policy, and it is
conditional on the migration existing: the table is not a current schema object, so
nothing here describes present database state.

The behaviour would then be mechanical: deleting a `users` row while session rows still
reference it fails with `23503` (`foreign_key_violation`), unless those session rows are
removed first. The database refuses the deletion; it does not quietly remove the
dependent rows.

Three things this section is **not** saying:

1. **It is not a decision to adopt `NO ACTION` as the account-deletion policy.** The
   default is what the constraint does when nobody has chosen an action; describing it is
   not choosing it, and the condition "if this DDL is applied" is doing real work in that
   sentence. The FK would exist for referential integrity, and its default action is a
   property of the declaration, not an owner decision.
2. **It does not resolve `OPEN-04`.** Which lifecycle wins is undecided: soft deletion,
   anonymisation, and hard deletion all remain open, as does any other option the owner
   selects. `OPEN-04` stays `P1`, product/legal, `BLOCKED_EXTERNAL_INPUT`, and its
   disposition in `docs/data-model/open-decisions.md` is unchanged by this ADR.
3. **It does not permit `ON DELETE CASCADE`.** Project decision `D16` forbids a database
   cascade anywhere (`relationships.md` §2, `lifecycle-and-retention.md`), because a
   cascade is a data-loss path that fires on a mistake.

**Hard deletion, if it is ever selected, is not a database cascade.** `D16` does not
forbid deleting a user; it forbids delegating that deletion to the foreign key. A
hard-delete strategy would therefore be an application-managed workflow that explicitly
removes the dependent rows — sessions first, then any other referencing row — in a
deliberate order inside a transaction, with the deletion path owning the order. That
workflow is not approved, not designed here, and not implied by the proposed FK: it is one
of the options `OPEN-04` has not chosen. Nothing in this ADR may be cited later as
approval of it.

`NO ACTION` and `RESTRICT` differ only in when the check runs — `RESTRICT` immediately,
`NO ACTION` at the end of the statement unless the constraint is deferred — and neither
is a statement about product policy. When `OPEN-04` is decided, the deletion path and this
proposed FK are revisited together in a later migration; nothing about that decision is
settled here.

## Alternatives considered

Covered earlier in this document and summarised here for completeness: Redis (reverses D5, adds an
authority), stateless JWT (cannot revoke), JWT with refresh rotation (rejected by D5),
and a tenant-GUC-keyed session table (unusable before identity exists). Each was
evaluated against the same criterion: which component should hold the authority for
"who is this request", given one database, no cache, and a security path that must fail
closed.

## Consequences

- Authentication gains a durable, revocable, backup-covered session store with no new
  service and no new dependency.
- The system gains one table, one function, and one job that does not exist yet. The
  job is the only part of this design that is not fully realisable in Phase 3.2.3.
- Every authenticated request costs one indexed lookup on a unique hash. This is the
  price of revocation; it was accepted when D5 was accepted.
- The auth credential can read all session rows and mint sessions for any user. That is
  a property of a single authentication credential, not of the table, and no grant in
  this ADR removes it.
- Documentation must stop implying RLS protects sessions from the auth credential. The
  honest statement is that the table's policies are `USING (true)` and the isolation is
  the query.

## Implementation references

- `packages/database/prisma/migrations/20261118050000_sessions/` — table, constraints,
  indexes, policies, grants, function (to be created).
- `packages/database/prisma/schema.prisma` — a `Session` model for representation
  only; the migration stays authoritative and `prisma migrate dev` stays banned.
- `packages/database/scripts/lib/privilege-verification.mjs`,
  `test/rls/auth-boundary.test.mjs`, `test/schema/schema-conformance.test.mjs` — the
  evidence.
- `docs/architecture/background-processing.md` — the `maintenance` queue that will
  schedule the sweep (Phase 4).
- Full step-by-step: `docs/implementation/phase-3.2.3-authentication-database-boundary.md`
  §7, §8.

## Related decisions and open decisions

- **`AG-2`** — approved 2026-11-18; this ADR is its formal record.
- **`D-1`–`D-3`** — schema decisions accepted 2026-11-20; they supplement `AG-2`.
- **`OPEN-04`** — account deletion and the proposed `sessions.user_id` foreign key,
  still **unresolved**; mechanics documented under *`OPEN-04` — account deletion, and
  the proposed foreign key*, decision untouched.
- **ADR-002 D5** — preserved, not amended.
- **ADR-004** — the `app_auth` role that reaches this table, and the credential
  boundary that bounds it.
- **ADR-003** — why the tenant GUC cannot key a session policy.
- **`OPEN-13`** — still **unresolved**. The Definition of Done requires an accepted
  ADR **and** an applied migration **and** a green session suite.
- **`IG-8`** (cookie name and `__Host-` prefix), **`IG-9`** (CSRF), **`IG-6`**
  (password hashing parameters) — unanswered, and they block S8/S7 rather than this
  store.
