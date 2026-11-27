-- No runtime role deletes.
--
-- Seventeen tables carried `GRANT ... DELETE` from the migrations of 2026-11-18
-- through 2026-11-23, and no runtime code ever issued a `DELETE`: the API
-- soft-deletes (`deleted_at`), the worker settles jobs by `UPDATE`, and every test
-- that removes a row does so as `migration_owner`. The grant was therefore a
-- standing capability nobody used, and the difference between "we do not delete"
-- as a convention and as a permission.
--
-- The nine tenant tables were the less exposed half: forced RLS with a `FOR ALL`
-- policy on `app.user_id` bounds an application bug, but not a leaked credential,
-- because the tenant id the policy compares is set by whoever holds `app_api`.
-- The eight global tables had no bound at all — they have no owner column and so
-- no policy, and `app_system` carries `BYPASSRLS` regardless.
--
-- Nothing depends on these grants. `app.purge_expired_sessions()` is
-- `SECURITY DEFINER` owned by `migration_owner`, so the reaper needs `EXECUTE`,
-- not table `DELETE`. No `ON DELETE CASCADE` exists in the schema, so no cascade
-- semantics change. A row that must survive is a row an `UPDATE` marks.
REVOKE DELETE ON
  app.farms,
  app.fields,
  app.field_outlook_cells,
  app.field_observations,
  app.plantings,
  app.harvests,
  app.suitability_runs,
  app.planting_windows,
  app.ai_briefings
FROM app_api;

REVOKE DELETE ON
  app.outlook_cells,
  app.forecast_runs,
  app.ingestion_runs,
  app.weather_records,
  app.monthly_outlooks,
  app.climatology_normals,
  app.climatology_baselines,
  app.jobs
FROM app_system;

-- Stated as one rule rather than as two lists, and checked by
-- `verify-privileges.mjs`: no runtime role holds `DELETE`, `TRUNCATE` or `CREATE`
-- on anything in `app`. The role that may delete is `migration_owner`, and it
-- deletes only in a migration a human wrote.
