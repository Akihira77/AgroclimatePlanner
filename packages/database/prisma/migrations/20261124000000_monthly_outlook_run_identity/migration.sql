-- Phase 5.7D — enforceable run identity for `app.monthly_outlooks`.
--
-- A seasonal outlook month is derived from exactly one ForecastRun and one
-- IngestionRun. Until now that identity lived only inside `input_refs` (JSONB,
-- unvalidated, no foreign key), so supersession could compare ranks only by
-- parsing a document nothing enforced.
--
-- Both columns are nullable on purpose: a climatology month has neither run, and
-- existing climatology rows must survive this migration unchanged. The run
-- columns supplement `input_refs`/`input_snapshot_hash`; they do not replace them.
--
-- Additive only: no table rewrite, no row touched, no constraint on existing data
-- that could fail. A nullable column with no default is a catalogue-only change.
ALTER TABLE app.monthly_outlooks
  ADD COLUMN forecast_run_id  uuid,
  ADD COLUMN ingestion_run_id uuid;

ALTER TABLE app.monthly_outlooks
  -- NO ACTION, matching every other climate-plane FK: a run with derived
  -- outlooks is retained for provenance, never cascaded away.
  ADD CONSTRAINT monthly_outlooks_forecast_run_fkey
    FOREIGN KEY (forecast_run_id) REFERENCES app.forecast_runs (id),
  ADD CONSTRAINT monthly_outlooks_ingestion_run_fkey
    FOREIGN KEY (ingestion_run_id) REFERENCES app.ingestion_runs (id);

-- "Which outlook months did this run produce?" — the maintenance/audit query.
-- Partial because a climatology row has no run and the table is append-only, so
-- the index stays smaller than the history it indexes.
CREATE INDEX monthly_outlooks_forecast_run_idx
  ON app.monthly_outlooks (forecast_run_id)
  WHERE forecast_run_id IS NOT NULL;
