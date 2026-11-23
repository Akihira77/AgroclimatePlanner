-- Supersession write order — Phase 5.4.
--
-- Re-normalising the *same* forecast run must replace its live rows, and the
-- live uniqueness key includes `forecast_run_id` (`weather_records_live_key`).
-- The new row therefore cannot be inserted while the old one is still live, and
-- the old one cannot be marked superseded before the new row exists:
--
--   * `weather_records_supersession_check` requires `superseded_by_id` and
--     `superseded_at` to move together, so a half-written supersession is
--     already rejected.
--   * `superseded_by_id` was an immediate FK, so naming the replacement before
--     inserting it raised 23503.
--
-- Deferring only that one FK to COMMIT makes the legal order expressible:
--
--   UPDATE old SET superseded_by_id = <replacement id>, superseded_at = now();
--   INSERT new (id = <replacement id>);
--
-- `supersedes_id` stays immediate: it points backwards at a row that already
-- exists, and there is no reason to relax it.
--
-- Ordering is by construction: a row may only be superseded by a row from a
-- newer ingestion of the same product, so a cycle would require two ingestions
-- to be newer than each other. The write-path queries enforce that; the CHECK
-- below closes the degenerate self-reference, which construction alone cannot
-- express because both ids are supplied by the caller.

-- Precondition: no existing row may violate the new rules. Both are no-ops on a
-- valid database and a hard stop on a broken one. `weather_records` is empty in
-- the 5.4 baseline, so these are cheap; they exist so the migration is safe to
-- apply to a database that has ingested.
DO $$
DECLARE
  self_refs bigint;
  dangling bigint;
  unpaired bigint;
BEGIN
  SELECT count(*) INTO self_refs
    FROM app.weather_records
   WHERE superseded_by_id = id;

  SELECT count(*) INTO dangling
    FROM app.weather_records w
   WHERE w.superseded_by_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM app.weather_records r WHERE r.id = w.superseded_by_id);

  SELECT count(*) INTO unpaired
    FROM app.weather_records
   WHERE (superseded_by_id IS NULL) <> (superseded_at IS NULL);

  IF self_refs <> 0 OR dangling <> 0 OR unpaired <> 0 THEN
    RAISE EXCEPTION
      'weather_records cannot accept the supersession rules: % self-references, % dangling, % unpaired',
      self_refs, dangling, unpaired;
  END IF;
END
$$;

ALTER TABLE app.weather_records
  DROP CONSTRAINT weather_records_superseded_by_fkey;

ALTER TABLE app.weather_records
  ADD CONSTRAINT weather_records_superseded_by_fkey FOREIGN KEY (superseded_by_id)
    REFERENCES app.weather_records (id)
    DEFERRABLE INITIALLY DEFERRED;

-- A row is not its own replacement. This is the only cycle shape a single
-- statement can express; longer cycles are prevented by the write path
-- (newer-ingestion-only) and asserted by the integration suite.
ALTER TABLE app.weather_records
  ADD CONSTRAINT weather_records_no_self_supersession
    CHECK (superseded_by_id IS DISTINCT FROM id) NOT VALID;

ALTER TABLE app.weather_records
  VALIDATE CONSTRAINT weather_records_no_self_supersession;
