-- Baseline source metadata — Phase 5.5 corrective pass (F-02).
--
-- `app.climatology_normals` stores the numbers, but it has nowhere to record
-- which route produced them, under which licence, or when they were retrieved.
-- A baseline is not a run (`provenance-contract.md` §4), so inventing a
-- `forecast_runs`/`ingestion_runs` row to carry that metadata is forbidden.
--
-- One row per `baseline_version`, not one per normal: the source identity is
-- shared by every cell-month of a version, and repeating a URL and an
-- attribution on 12 rows per cell would be duplication that can drift.
--
-- No foreign key from `climatology_normals.baseline_version`: the string is a
-- free-form identity across two tables, and existing rows have no metadata to
-- back-fill. The writer inserts this row first in the same transaction, so a
-- version without metadata cannot be produced by this code path.
--
-- The table is global: no tenant id and no RLS (`ownership-and-rls.md` §2).

CREATE TABLE app.climatology_baselines (
  baseline_version  text             PRIMARY KEY,
  baseline_dataset  text             NOT NULL,
  -- Provider/model identity of the source, not the local adapter name.
  provider          text             NOT NULL,
  model             text             NOT NULL,
  -- Adapter release that produced the payload. Audit only: a patch release that
  -- changes no source identity and no value does not force a version bump.
  adapter_version   text             NOT NULL,
  -- Deterministic, coordinate-free route reference (endpoint + pinned
  -- parameters). The per-cell requested/served coordinates stay on
  -- `outlook_cells`; embedding a latitude in one URL for a multi-cell baseline
  -- would be false.
  source_reference  text             NOT NULL,
  attribution       text             NOT NULL,
  retrieved_at      timestamptz(6)   NOT NULL,
  period_from       date             NOT NULL,
  period_to         date             NOT NULL,
  -- The calculation revision embedded in `baseline_version` (the `v1` token).
  algorithm_version text             NOT NULL,
  computed_at       timestamptz(6)   NOT NULL,
  created_at        timestamptz(6)   NOT NULL DEFAULT now(),
  CONSTRAINT climatology_baselines_dataset_check
    CHECK (baseline_dataset IN ('era5', 'chirps_v3', 'nasa_power')),
  CONSTRAINT climatology_baselines_period_check CHECK (period_to > period_from),
  CONSTRAINT climatology_baselines_source_check
    CHECK (source_reference ~ '^https://'),
  CONSTRAINT climatology_baselines_text_check
    CHECK (
      btrim(baseline_version) <> ''
      AND btrim(provider) <> ''
      AND btrim(model) <> ''
      AND btrim(adapter_version) <> ''
      AND btrim(attribution) <> ''
      AND btrim(algorithm_version) <> ''
    )
);

-- Runtime privileges ---------------------------------------------------------
--
-- `app_api` reads: a future outlook response must be able to render the
-- attribution of the baseline it used without a hard-coded constant. Writing is
-- the worker's job, as it is for every weather-plane table.
GRANT SELECT ON app.climatology_baselines TO app_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.climatology_baselines TO app_system;
