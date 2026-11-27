-- The supersession pointer gets the constraint it was documented as having.
--
-- `20261118030000_domain_tables` created `planting_windows.superseded_by_id` and
-- the check that keeps `status = 'superseded'` and a non-null pointer in step,
-- and gave the column an index — but the self-referencing foreign key was never
-- written, unlike the five other tables with the same column (`weather_records`,
-- `monthly_outlooks`, `suitability_runs`, `ai_briefings`, and
-- `crop_profile_versions.supersedes_id`). A window could name a superseding row
-- that does not exist, which is the one thing the chain is for.
--
-- The rule matches its neighbours: `NO ACTION` on delete, so removing a row that
-- another row points at fails rather than silently rewriting an audit chain.
ALTER TABLE app.planting_windows
  ADD CONSTRAINT planting_windows_superseded_by_fkey
  FOREIGN KEY (superseded_by_id) REFERENCES app.planting_windows (id);
