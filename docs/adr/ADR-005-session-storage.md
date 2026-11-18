# ADR-005 — PostgreSQL Session Storage

- Status: **Proposed** — formalises decision `AG-2` recorded by the repository owner
  on 2026-11-18 in `docs/review/phase-3.2-owner-decisions.md` §2.10. That approval is
  the decision; this document is its durable record. Acceptance of *this document* is
  the owner's, not the author's, and is a separate act from the approval it records.
- Date: 2026-11-18 (decision date), recorded here 2026-11-18
- Depends on: ADR-002 (D5), ADR-003, ADR-004, `docs/review/phase-3.2-design-review.md`
  §4.3, §6, §12.2, §17
- Supersedes: none
- Preserves: ADR-002 D5 — "server-side sessions in PostgreSQL, not JWT", with JWT +
  refresh rotation in D5's rejected list. Nothing in D5 is amended by this ADR.
- Implemented by: `docs/implementation/phase-3.2.3-authentication-database-boundary.md`
  (steps S5, S6) — **plan only, nothing applied**
- Register entry: `OPEN-13` (P1, hard) — **still unresolved**, see §18

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

- Only `sha256(token)` is persisted, hex-encoded, in `token_hash`, which is `UNIQUE`.
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

Rules:

1. **A session cannot outlive its absolute expiration.** `absolute_expires_at` is
   written once at creation and no grant permits changing it (`UPDATE` covers
   `expires_at`, `last_seen_at`, `revoked_at` only). That is a database-enforced
   property, not a convention.
2. **Sliding expiration can never exceed absolute expiration.** The extension is
   clamped in SQL, not in application arithmetic: `LEAST(now() + interval '30 days',
   absolute_expires_at)`. The table's CHECK is `absolute_expires_at >= expires_at` —
   `>=`, not `>`, because the clamped value legitimately coincides with the absolute
   deadline at the end of a session's life.
3. **Extension happens at most once per 5 minutes per session.** Without this, every
   authenticated request becomes a write. The application decides when to extend; the
   database only bounds the result.
4. **Runtime validation is not garbage collection.** Expiry is enforced by the
   application's predicate on every request. GC only reclaims rows nobody can use; a
   row that is past `expires_at` but not yet purged must still be rejected by the
   application. Conflating the two is how an expired session becomes valid again after
   a failed job run.

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
-- no DELETE grant to any runtime role; no grant of any kind to app_api or app_system
```

What the column grants do and do not do, stated because it is easy to over-read them:

- They constrain **writes**. `app_auth` cannot change `token_hash`, `user_id`,
  `absolute_expires_at`, or `created_at`, so a session cannot be re-pointed at another
  user or pushed past its absolute deadline.
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

**Scope discipline.** This is the only `SECURITY DEFINER` object in the repository and
it must stay narrow. It reads no credential, returns a count, touches one table, and
cannot be parameterised into something else. ADR-003's rejection of a definer-based
tenant validator does not transfer to it; equally, this function's existence is not
precedent for a definer credential read (ADR-004, *Decision*, alternative B2) or any elevated
helper. A new definer function is a new decision.

## Security properties

| Property | Enforced by | Evidence required |
|---|---|---|
| Validity requires not-revoked, not-sliding-expired, not-absolutely-expired | application | three independent tests, each failing for its own reason |
| Only a hash is stored | application + one CHECK | the proposed `token_hash` shape CHECK rejects a 43-char base64url token at `23514` |
| `absolute_expires_at` cannot be extended | PostgreSQL | no `UPDATE` grant covers it; `42501` |
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
5. **Un-revocation is possible** with the granted column, as described in §10.
6. **GC is not expiry.** A failed or unscheduled sweep does not extend any session's
   usable life, because validity is checked at read time. Conversely, GC cannot make an
   expired session valid.
7. **No scheduled job exists yet.** The `maintenance` queue is Phase 5 work. S5 makes
   the function callable; nothing calls it on a schedule, and session rows accumulate
   until something does.
8. **One round trip per authenticated request**, plus one write per 5 minutes per
   active session. Accepted; a cache in front of it would be a second authority.
9. **Sessions do not survive nothing** — they survive a PostgreSQL restart, a Redis
   restart would not, and backup/restore already covers this table like any other.
10. **The hash-shape CHECK is an implementation proposal, not an owner decision.** See
    §17.

## Alternatives considered

Covered in §5 and summarised here for completeness: Redis (reverses D5, adds an
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
  schedule the sweep (Phase 5).
- Full step-by-step: `docs/implementation/phase-3.2.3-authentication-database-boundary.md`
  §7, §8.

## Related decisions and open decisions

- **`AG-2`** — approved 2026-11-18; this ADR is its formal record.
- **ADR-002 D5** — preserved, not amended.
- **ADR-004** — the `app_auth` role that reaches this table, and the credential
  boundary that bounds it.
- **ADR-003** — why the tenant GUC cannot key a session policy.
- **`OPEN-13`** — still **unresolved**. The Definition of Done requires an accepted
  ADR **and** an applied migration **and** a green session suite.
- **`IG-8`** (cookie name and `__Host-` prefix), **`IG-9`** (CSRF), **`IG-6`**
  (password hashing parameters) — unanswered, and they block S8/S7 rather than this
  store.

## Implementation details still requiring review

The owner approved the architecture in §6–§13. Two schema details are proposals that
the owner decision does not cover, and they must be **accepted or removed** at S5
review rather than shipped by default:

| Proposal | Status | Argument |
|---|---|---|
| `CHECK (token_hash ~ '^[0-9a-f]{64}$')` | **not approved** | nothing in the schema currently distinguishes a hash from a raw token; a bug that stored the base64url token would still authenticate. 64 lowercase hex characters is exactly the encoding of `sha256(32 bytes)`, so the mistake fails at `23514` instead of persisting a credential. It constrains the encoding, not the algorithm |
| Indexes `sessions_user_id_idx` and `sessions_absolute_expires_at_idx` | **not approved** | `token_hash` is already `UNIQUE` and carries the request path. The other two support revoke-all-by-user and the GC scan; without them both degrade to a sequential scan as rows accumulate |

Everything else in this ADR — the table, its columns, the CHECK on expiry order, the
grants, the policies, and the purge function — is the approved `AG-2` design as
recorded on 2026-11-18.
