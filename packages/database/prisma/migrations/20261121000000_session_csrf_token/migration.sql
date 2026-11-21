-- S8 — session-bound CSRF synchronizer token.
--
-- *Amendment 4* of `docs/review/phase-3.2-owner-decisions.md` approves exactly four
-- things, and this migration is the fourth: one nullable column, one shape CHECK,
-- one SELECT grant, one UPDATE grant. Nothing else changes — no backfill, no
-- `NOT NULL`, no generated column, no `SECURITY DEFINER`, no RLS change.
--
-- Nullable is the whole point. `NULL` means "not issued yet", which is a state a
-- live session can legitimately be in: the token is generated on the first
-- retrieval (`GET /v1/auth/csrf`) and never rotated. Every session that exists when
-- this runs keeps a `NULL` token and stays valid, so this migration cannot
-- invalidate anybody's session and needs no data migration at all.
--
-- The column is plaintext, deliberately. It is not a bearer credential: it
-- authenticates nothing without the `HttpOnly` session cookie, and it must be
-- re-served on every retrieval so a second tab or a reload keeps working. A hash
-- cannot be re-served, and reissuing on retrieval would be rotation — which the
-- approved lifecycle explicitly does not have. `ADR-005` §8's hash-only rule is
-- about the session token, which remains unchanged.
--
-- The CHECK mirrors `sessions_token_hash_shape_check`: column grants can express
-- *which* column a credential may write, never *what shape* it may write, so the
-- shape is the database's business. `NULL` is allowed because the value is absent
-- until first use; `43` characters is 32 bytes of base64url with no padding.

ALTER TABLE app.sessions ADD COLUMN csrf_token text;

ALTER TABLE app.sessions
  ADD CONSTRAINT sessions_csrf_token_shape_check
  CHECK (csrf_token IS NULL OR csrf_token ~ '^[A-Za-z0-9_-]{43}$');

-- Two column grants, additive to the eight SELECT / four INSERT / three UPDATE
-- columns already held. No table-level privilege is introduced, so the existing
-- "never becomes a table privilege" guarantee still holds.
--
-- SELECT is required by validation: the guard compares the `X-CSRF-Token` header
-- against this value on every authenticated state-changing request. UPDATE is
-- required only by the lazy first retrieval, whose predicate is
-- `csrf_token IS NULL`, so it can never overwrite a token that already exists.
--
-- `app_api` and `app_system` gain nothing: no table privilege, no column privilege,
-- and the RLS policies on `app.sessions` still name only `app_auth` and
-- `migration_owner`.
GRANT SELECT (csrf_token) ON app.sessions TO app_auth;
GRANT UPDATE (csrf_token) ON app.sessions TO app_auth;
