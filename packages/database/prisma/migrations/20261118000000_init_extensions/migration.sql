-- Phase 2.2.1 — PostgreSQL 18 + PostGIS 3.6 baseline.
--
-- Nothing domain-specific is created here. This migration exists to make two
-- assumptions fail loudly instead of silently degrading later:
--
--   1. PostGIS is present, so geometry columns and ST_* functions will work.
--   2. uuidv7() is the platform's own, not a hand-rolled generator. PostgreSQL
--      18 added it natively; on an older server this migration stops instead of
--      leaving a schema whose id default quietly does not exist.

CREATE EXTENSION IF NOT EXISTS postgis;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'uuidv7' AND pronargs = 0) THEN
    RAISE EXCEPTION
      'uuidv7() is required (PostgreSQL 18+) and was not found; server is %',
      current_setting('server_version');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'postgis') THEN
    RAISE EXCEPTION 'postgis extension is required but is not installed';
  END IF;
END
$$;
