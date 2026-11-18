-- S4 — the authentication boundary on app.users.
--
-- Login happens before a tenant context exists, so `app_api` cannot perform it:
-- its policy is keyed on `app.user_id`, which authentication is what produces.
-- ADR-004 answers that with a fourth role, `app_auth`, whose reach is a column
-- list rather than a table.
--
-- Four statements, no schema change, no data, one table. `created_at` and
-- `updated_at` are deliberately absent from both lists: nothing on the
-- authentication path reads them, and `updated_at` has no trigger (`OPEN-19`), so
-- a client-written value would be its only writer.

-- Identity lookup: the row that a login resolves, and the subject a session
-- names. `role` is authorisation input; `locale` and `timezone` are response
-- localisation.
GRANT SELECT (id, email, password_hash, role, locale, timezone)
ON app.users TO app_auth;

-- Registration writes the address and the hash. `id`, `role`, `locale`,
-- `timezone` and both timestamps are column defaults, so naming any of them in
-- an INSERT fails with 42501 — which is intended, not incidental.
GRANT INSERT (email, password_hash)
ON app.users TO app_auth;

-- One policy per capability. `FOR ALL` would document an UPDATE that the grants
-- do not permit, and would silently cover one added later by mistake.
--
-- `USING (true)` and `WITH CHECK (true)` add no filtering: `app_auth` reads every
-- row by design. That is the disclosed enumeration limitation of ADR-004
-- ("Explicit limitations"), accepted by the owner, not an oversight. The boundary
-- is the grant.
CREATE POLICY users_auth_lookup
ON app.users
FOR SELECT
TO app_auth
USING (true);

CREATE POLICY users_auth_register
ON app.users
FOR INSERT
TO app_auth
WITH CHECK (true);
