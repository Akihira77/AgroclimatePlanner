-- S5 — session storage.
--
-- ADR-005 records the owner's decision (`AG-2`, plus `D-1`–`D-3`), and this
-- migration is the first object it describes. One table, two indexes, two
-- policies, three column grants, one function.
--
-- The table exists because a session outlives the request that created it and
-- has to survive a deploy, which is the property Redis was being considered for
-- (`OPEN-13`). This file does not resolve that register item: a migration is not
-- an application to the canonical database, and the register's disposition is
-- unchanged. Likewise `OPEN-04`: `user_id` names no `ON DELETE` action, so
-- PostgreSQL's default `NO ACTION` stands and account deletion stays undecided
-- (`D16` still forbids a database cascade).
--
-- What this file deliberately does not do: no scheduler (hourly GC is Phase 4's
-- `maintenance` queue), no request path, no token generation, and no
-- five-minute extension throttle — that throttle is an application invariant
-- owned by S7, and nothing in the database enforces it.

-- The eight columns are the accepted set, and the three grants below are split
-- deliberately rather than uniformly.
--
-- `created_at` is outside both the `INSERT` and the `UPDATE` grant, so the
-- database owns it and no credential can backdate a session. Both deadlines must
-- therefore come from the same `now()`, which is `transaction_timestamp()`: a
-- deadline computed in JavaScript is already later than `created_at + 90 days`
-- by the time the transaction began, and fails `D-2`.
--
-- `absolute_expires_at` is `INSERT`-writable but not `UPDATE`-writable. A new
-- session states its own cap, which `sessions_absolute_expiry_cap_check` (`D-2`)
-- bounds at 90 days from `created_at`; after that insert neither `app_auth` nor
-- anything else can extend or shorten it. `expires_at` and `last_seen_at` are
-- the sliding window and stay writable; `revoked_at` is logout.
--
-- The ordering CHECK is `absolute_expires_at >= expires_at`, so equality is
-- allowed: a clamped extension makes the sliding deadline reach the cap and the
-- two coincide. It is not required to.
CREATE TABLE app.sessions (
  id                  uuid        PRIMARY KEY DEFAULT uuidv7(),
  user_id             uuid        NOT NULL REFERENCES app.users (id),
  token_hash          text        NOT NULL,
  expires_at          timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at          timestamptz,
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT sessions_token_hash_key UNIQUE (token_hash),

  CONSTRAINT sessions_expiry_order_check
    CHECK (
      absolute_expires_at >= expires_at
      AND expires_at > created_at
    ),

  CONSTRAINT sessions_token_hash_shape_check
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),

  CONSTRAINT sessions_absolute_expiry_cap_check
    CHECK (
      absolute_expires_at <= created_at + INTERVAL '90 days'
    )
);

-- `D-3`, and nothing else. Token lookup runs on `sessions_token_hash_key`, which
-- the UNIQUE above already provides; these two serve revoke-all-by-user and the
-- GC scan. The table is empty here, so the index builds are not a write storm.
CREATE INDEX sessions_user_id_idx ON app.sessions (user_id);
CREATE INDEX sessions_absolute_expires_at_idx ON app.sessions (absolute_expires_at);

ALTER TABLE app.sessions ENABLE ROW LEVEL SECURITY;

-- No row filtering, by design: `app_auth` is the credential that answers a login
-- and has to find a session before any `app.user_id` exists. Isolation is the
-- query shape (`WHERE token_hash = $1`) plus token entropy, not a policy
-- predicate — the same disclosed limitation ADR-004 records for `app.users`.
-- A tenant GUC policy here would be a filter that silently matches nothing
-- during authentication.
CREATE POLICY sessions_auth_all
ON app.sessions
FOR ALL
TO app_auth
USING (true)
WITH CHECK (true);

-- Required for garbage collection. With FORCE on, the table owner is policed
-- like everyone else, so `purge_expired_sessions()` needs a policy naming
-- `migration_owner` in order to delete anything at all.
CREATE POLICY sessions_owner_full_access
ON app.sessions
FOR ALL
TO migration_owner
USING (true)
WITH CHECK (true);

-- After the owner policy exists: there is then no state in which `migration_owner`
-- is subject to RLS with nothing to match.
ALTER TABLE app.sessions FORCE ROW LEVEL SECURITY;

-- SELECT names all eight columns because a session read returns the row that
-- validates the credential. INSERT omits `id`, `revoked_at`, `last_seen_at` and
-- `created_at`: the database owns them, and naming one fails with 42501.
--
-- UPDATE is the sliding window and logout, and nothing else. `absolute_expires_at`
-- and `created_at` stay out of it, so the cap cannot be extended by the same
-- credential that reads the row.
GRANT SELECT (
  id,
  user_id,
  token_hash,
  expires_at,
  absolute_expires_at,
  revoked_at,
  last_seen_at,
  created_at
) ON app.sessions TO app_auth;

GRANT INSERT (
  user_id,
  token_hash,
  expires_at,
  absolute_expires_at
) ON app.sessions TO app_auth;

GRANT UPDATE (
  expires_at,
  last_seen_at,
  revoked_at
) ON app.sessions TO app_auth;

-- No DELETE for any runtime role, and no table privilege of any kind for
-- `app_api` or `app_system`. DELETE has no column form, which is the whole
-- reason collection is a function rather than a grant.

-- Collection. `SECURITY DEFINER` because the caller holds no `DELETE`; owned by
-- `migration_owner` and pinned to `pg_catalog, app` so object resolution cannot
-- be redirected by a `search_path` set on the calling connection.
--
-- The predicate is the absolute deadline, not the sliding one: a revoked or
-- idle session keeps its row until the cap it was issued with, which bounds
-- retention at 90 days without letting activity extend it.
CREATE FUNCTION app.purge_expired_sessions()
RETURNS integer
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

-- The worker credential alone. A count of 0 is a successful run with nothing to
-- collect, not a failure.
GRANT EXECUTE ON FUNCTION app.purge_expired_sessions() TO app_system;
