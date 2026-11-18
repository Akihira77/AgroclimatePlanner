-- Phase 3 — the nineteen remaining domain tables.
--
-- `docs/data-model/` is the specification; this file is its transcription into
-- hand-written SQL. The three tables that already exist (`app.users`,
-- `app.farms`, `app.fields`, migration 20261118020000) are not recreated and not
-- altered: every read path Phase 3 adds is served by an index on a new table,
-- and the existing three carry the keys their own migration created.
--
-- Ordering is dependency order, not cosmetic grouping: the catalog first because
-- `plantings` and every derived artifact point at a cultivar or a profile
-- version; the weather plane next because `field_outlook_cells` names a cell;
-- then the field operations; then the artifacts built on all three.
--
-- Applied with `prisma migrate deploy`, which wraps each migration in a single
-- transaction. Nothing here is `CONCURRENTLY` for that reason: the tables are
-- empty, so a plain `CREATE INDEX` builds instantly and takes no lock worth
-- avoiding. A later index on a grown `weather_records` would need the separate
-- non-transactional procedure described in `consistency-checklist.md` §7, which
-- does not exist yet.
--
-- Two things this file deliberately does not do, both decisions rather than
-- omissions:
--
-- 1. `plantings.status` ships with no `DEFAULT` and no `plantings_active_idx`
--    (`D26`, `OPEN-09`). The vocabulary is undecided, and a default would write
--    an unapproved value into every row a caller omitted the column for.
-- 2. The `crop_profile_versions_immutable` trigger is not created
--    (`tables-catalog.md` §3, `D5`): specified, deferred to its own migration.

-- Part: the reference catalog: six global tables, no tenant dimension.
--
-- `docs/data-model/tables-catalog.md` §1-6 is the normative column list; this file
-- transcribes it. Order is the dependency order the document already uses
-- (crops -> cultivars -> crop_profile_versions -> growth_stages -> constraints ->
-- source_refs); no FK required reordering.
--
-- Two things are deliberately absent:
--
-- 1. Row Level Security. The privilege matrix (`ownership-and-rls.md` §2, rows 8-13)
--    says `RLS: none` for all six: they are global content with no `user_id`, so a
--    policy would have nothing to compare against and FORCE would only lock
--    migration_owner out of its own seed. Contrast the tenant tables in
--    20261118020000_tenant_tables, where every table is ENABLE + FORCE.
-- 2. The `crop_profile_versions_immutable` trigger. `tables-catalog.md` §3 specifies
--    it *and* says it is not created in this phase. The half of `D5` that is
--    enforced here is the absence of any write grant to a runtime role plus
--    `crop_profile_versions_published_at_check`. The trigger is a later migration.
--
-- Shared grammar is `physical-model.md`: `uuidv7()` ids, `timestamptz(6)` instants,
-- text + named CHECK instead of enum types, `btrim(...) <> ''` for version strings.

CREATE TABLE app.crops (
  id         uuid          PRIMARY KEY DEFAULT uuidv7(),
  -- Permanent: it appears in URLs, so renaming a crop breaks every inbound link.
  slug       text          NOT NULL,
  name_id    text          NOT NULL,
  name_en    text          NOT NULL,
  -- OPEN-10: `domain-model.md` §3 lists the property with no value set. No CHECK
  -- until it settles — a vocabulary invented here would be a normative enum.
  category   text          NOT NULL,
  created_at timestamptz(6) NOT NULL DEFAULT now(),
  updated_at timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT crops_slug_key UNIQUE (slug),
  -- Shape, not reachability: a slug needing URL-encoding is already a broken link.
  CONSTRAINT crops_slug_shape_check CHECK (slug ~ '^[a-z][a-z0-9-]*$'),
  -- Bilingual UI: both names exist or neither does.
  CONSTRAINT crops_name_check CHECK (btrim(name_id) <> '' AND btrim(name_en) <> '')
);

CREATE TABLE app.cultivars (
  id                       uuid          PRIMARY KEY DEFAULT uuidv7(),
  crop_id                  uuid          NOT NULL,
  name                     text          NOT NULL,
  duration_days_min        integer       NOT NULL,
  duration_days_typical    integer       NOT NULL,
  duration_days_max        integer       NOT NULL,
  cycle_start              text          NOT NULL,
  -- NULL for direct-sown varieties. Not 0: zero would claim a nursery stage that
  -- lasts no time, which is a different agronomic statement.
  nursery_days             integer,
  -- OPEN-06: a real property (rice varieties differ) with no fixed representation.
  -- Unconstrained until the representation settles; no code may branch on it.
  photoperiod_sensitivity  text,
  altitude_min_m           integer,
  altitude_max_m           integer,
  created_at               timestamptz(6) NOT NULL DEFAULT now(),
  updated_at               timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT cultivars_crop_fkey FOREIGN KEY (crop_id) REFERENCES app.crops (id),
  CONSTRAINT cultivars_crop_name_key UNIQUE (crop_id, name),
  -- A "typical" outside its own range makes every window critique meaningless.
  CONSTRAINT cultivars_duration_order_check
    CHECK (duration_days_min <= duration_days_typical AND duration_days_typical <= duration_days_max),
  CONSTRAINT cultivars_cycle_start_check CHECK (cycle_start IN ('sowing', 'transplant')),
  -- An inverted altitude band. Either bound may be unknown; the ordering only has
  -- to hold when both are present.
  CONSTRAINT cultivars_altitude_check
    CHECK (altitude_min_m IS NULL OR altitude_max_m IS NULL OR altitude_min_m <= altitude_max_m),
  -- From the §2 column table, which states `CHECK (> 0)` / `CHECK (>= 0)` without
  -- naming the constraint; named here per physical-model §1.
  CONSTRAINT cultivars_duration_min_check CHECK (duration_days_min > 0),
  CONSTRAINT cultivars_nursery_days_check CHECK (nursery_days IS NULL OR nursery_days > 0),
  CONSTRAINT cultivars_altitude_min_check CHECK (altitude_min_m IS NULL OR altitude_min_m >= 0)
);

CREATE INDEX cultivars_crop_idx ON app.cultivars (crop_id);

CREATE TABLE app.crop_profile_versions (
  id           uuid          PRIMARY KEY DEFAULT uuidv7(),
  cultivar_id  uuid          NOT NULL,
  -- Human-readable rule-set version, e.g. `padi-ciherang-2026.1`. The scheme is not
  -- parsed here; physical-model §6 asks only that it be non-blank.
  rule_version text          NOT NULL,
  status       text          NOT NULL DEFAULT 'draft',
  -- Set exactly once, when status becomes published.
  published_at timestamptz(6),
  -- The version this one replaces. Supersession points backward and a correction
  -- always produces a new row, so a published row is never edited.
  supersedes_id uuid,
  created_at   timestamptz(6) NOT NULL DEFAULT now(),
  updated_at   timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT crop_profile_versions_cultivar_fkey FOREIGN KEY (cultivar_id)
    REFERENCES app.cultivars (id),
  CONSTRAINT crop_profile_versions_supersedes_fkey FOREIGN KEY (supersedes_id)
    REFERENCES app.crop_profile_versions (id),
  CONSTRAINT crop_profile_versions_cultivar_rule_key UNIQUE (cultivar_id, rule_version),
  CONSTRAINT crop_profile_versions_status_check
    CHECK (status IN ('draft', 'published', 'retired')),
  -- A draft carrying a publication date, or a published profile claiming none.
  -- This is the row-state half of D5; the transition half is the trigger below,
  -- which this phase does not create.
  CONSTRAINT crop_profile_versions_published_at_check
    CHECK ((status = 'draft') = (published_at IS NULL)),
  CONSTRAINT crop_profile_versions_no_self_supersede_check
    CHECK (supersedes_id IS NULL OR supersedes_id <> id),
  CONSTRAINT crop_profile_versions_rule_version_check CHECK (btrim(rule_version) <> '')
);

-- At most one live rulebook per variety — "which profile applies now".
CREATE UNIQUE INDEX crop_profile_versions_one_published_key
  ON app.crop_profile_versions (cultivar_id) WHERE status = 'published';
CREATE INDEX crop_profile_versions_cultivar_idx
  ON app.crop_profile_versions (cultivar_id, created_at DESC);

-- D5, transition half — NOT created in this phase, by `tables-catalog.md` §3:
--
--   BEFORE UPDATE ON app.crop_profile_versions, raising integrity_constraint_violation
--   when OLD.status = 'published' and either the row changes any column other than
--   status, or NEW.status is 'draft'. Only published -> retired is allowed.
--
-- It is needed because migration_owner can write the table, and a typo corrected in
-- place would silently change what every stored window was evaluated against.
-- UNRESOLVED: trigger deferred to a later migration (tables-catalog.md §3, D5).

CREATE TABLE app.growth_stages (
  id                  uuid          PRIMARY KEY DEFAULT uuidv7(),
  profile_version_id  uuid          NOT NULL,
  -- Vocabulary is per profile, not global: no CHECK, no enum.
  name                text          NOT NULL,
  -- Inclusive day offsets from the cycle start.
  start_day_offset    integer       NOT NULL,
  end_day_offset      integer       NOT NULL,
  -- The stage whose basis decides `primaryBasis` (provenance-contract.md §2).
  is_critical         boolean       NOT NULL DEFAULT false,
  -- OPEN-08: listed by `domain-model.md` §3 with no type. Least-committing
  -- representation that can be seeded later; unconstrained and unread until then.
  requirement_profile text,
  created_at          timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT growth_stages_profile_fkey FOREIGN KEY (profile_version_id)
    REFERENCES app.crop_profile_versions (id),
  CONSTRAINT growth_stages_profile_name_key UNIQUE (profile_version_id, name),
  CONSTRAINT growth_stages_offset_order_check
    CHECK (start_day_offset >= 0 AND end_day_offset >= start_day_offset)
);

-- Two critical stages would leave `primaryBasis` with no unique definition.
CREATE UNIQUE INDEX growth_stages_one_critical_key
  ON app.growth_stages (profile_version_id) WHERE is_critical;
-- Stages are deliberately not required to be disjoint: nursery and vegetative
-- stages overlap in the literature, and an EXCLUDE constraint would reject real
-- profiles.
CREATE INDEX growth_stages_profile_idx
  ON app.growth_stages (profile_version_id, start_day_offset);

CREATE TABLE app.constraints (
  id                 uuid          PRIMARY KEY DEFAULT uuidv7(),
  profile_version_id uuid          NOT NULL,
  dimension          text          NOT NULL,
  comparator         text          NOT NULL,
  -- Three typed columns instead of the domain model's single `value` (D6): a range
  -- cannot be stored in one number and a count is not a quantity.
  threshold_lower    numeric(10, 2),
  threshold_upper    numeric(10, 2),
  threshold_count    integer,
  unit               text,
  -- NULL = the rule applies to the whole cycle.
  growth_stage_id    uuid,
  -- Evidence quality from the research matrix. Never a probability, and nothing
  -- may derive one from it.
  grade              text          NOT NULL,
  severity           text          NOT NULL,
  created_at         timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT constraints_profile_fkey FOREIGN KEY (profile_version_id)
    REFERENCES app.crop_profile_versions (id),
  -- Proves the stage exists, not that it belongs to the same profile: that needs a
  -- composite FK and an extra unique key, recorded as OPEN-24 and not added.
  CONSTRAINT constraints_stage_fkey FOREIGN KEY (growth_stage_id)
    REFERENCES app.growth_stages (id),
  CONSTRAINT constraints_dimension_check
    CHECK (dimension IN ('climate', 'water', 'soil', 'timing', 'risk')),
  CONSTRAINT constraints_comparator_check
    CHECK (comparator IN ('min', 'max', 'range', 'count', 'window')),
  CONSTRAINT constraints_grade_check CHECK (grade IN ('A', 'B', 'C', 'D')),
  CONSTRAINT constraints_severity_check CHECK (severity IN ('hard', 'soft', 'risk')),
  -- One predicate per comparator, so every stored row is evaluable.
  CONSTRAINT constraints_shape_check CHECK (
    (comparator = 'min'   AND threshold_lower IS NOT NULL AND threshold_upper IS NULL
                          AND threshold_count IS NULL AND unit IS NOT NULL)
    OR (comparator = 'max'   AND threshold_upper IS NOT NULL AND threshold_lower IS NULL
                          AND threshold_count IS NULL AND unit IS NOT NULL)
    OR (comparator = 'range' AND threshold_lower IS NOT NULL AND threshold_upper IS NOT NULL
                          AND threshold_lower <= threshold_upper
                          AND threshold_count IS NULL AND unit IS NOT NULL)
    OR (comparator = 'count' AND threshold_count IS NOT NULL AND threshold_count >= 0
                          AND threshold_lower IS NULL AND threshold_upper IS NULL)
  ),
  -- OPEN-07: the window comparator has no agreed semantics, so it is rejected at
  -- write time. A published profile is immutable, so allowing it would make the
  -- mistake permanent.
  CONSTRAINT constraints_window_not_supported_check CHECK (comparator <> 'window')
);

CREATE INDEX constraints_profile_idx ON app.constraints (profile_version_id, dimension);

CREATE TABLE app.source_refs (
  id                 uuid          PRIMARY KEY DEFAULT uuidv7(),
  profile_version_id uuid          NOT NULL,
  title              text          NOT NULL,
  -- NULL when the source is institutional (FAO, IRRI, BPS).
  authors            text,
  publication_year   integer       NOT NULL,
  publisher          text          NOT NULL,
  url                text          NOT NULL,
  accessed_at        date          NOT NULL,
  grade              text          NOT NULL,
  created_at         timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT source_refs_profile_fkey FOREIGN KEY (profile_version_id)
    REFERENCES app.crop_profile_versions (id),
  -- "Only resolved references may be attached" is enforced by nullability and by
  -- blanks, not by a review habit: an unresolved citation cannot enter a published
  -- profile (domain-model.md §3).
  CONSTRAINT source_refs_resolved_check
    CHECK (btrim(title) <> '' AND btrim(publisher) <> '' AND btrim(url) <> ''),
  CONSTRAINT source_refs_url_check CHECK (url ~ '^https?://'),
  CONSTRAINT source_refs_grade_check CHECK (grade IN ('A', 'B', 'C', 'D')),
  CONSTRAINT source_refs_year_check CHECK (publication_year BETWEEN 1900 AND 2100)
);

CREATE INDEX source_refs_profile_idx ON app.source_refs (profile_version_id);

-- Runtime privileges --------------------------------------------------------
--
-- Read only, and that is the whole grant: `ownership-and-rls.md` §2 rows 8-13 give
-- `app_api` R and nothing else, and §4 restates it. The catalog is seeded by
-- migration_owner, so no runtime role needs INSERT/UPDATE/DELETE — and the absence
-- of an UPDATE grant is half of the D5 immutability guarantee for published
-- profiles. app_system gets nothing: it has no catalog read path.
--
-- No `GRANT ALL`, no `GRANT ... ON ALL TABLES`, no `ALTER DEFAULT PRIVILEGES`; the
-- default-deny baseline holds and each table opts in explicitly. No sequences exist
-- to grant — ids come from uuidv7().

GRANT SELECT ON
  app.crops, app.cultivars, app.crop_profile_versions,
  app.growth_stages, app.constraints, app.source_refs
  TO app_api;

-- Part: the weather and climate data plane: six global tables, in
-- dependency order.
--
-- Not one of them carries a user_id, an RLS policy or a tenant dimension, and
-- that is the specification rather than an omission: a forecast for a grid cell
-- is the same forecast for every tenant (tables-climate intro;
-- ownership-and-rls §2, rows 14-19, all `global` / `RLS none`). Enabling RLS
-- here would be a policy on a table that has no owner column to compare.
--
-- app_api therefore reads and cannot write — except for one column-level INSERT
-- on outlook_cells, so field creation can mint a cell identity before any ingest
-- exists (D14, ownership-and-rls §2 "why the column grant"). app_system writes.
--
-- Nothing here is ever deleted. Supersession is the only mutation, which is why
-- every FK is ON DELETE NO ACTION (relationships §3) and why the unique key that
-- drives the upsert is a partial index on the live slice.
--
-- Instants are timestamptz(6) per physical-model §3; the 2.2.3 file predates
-- that precision being stated and used bare timestamptz.

-- Provider grid identity ------------------------------------------------------
--
-- The identity of a provider's grid node and the coordinate it actually serves.
-- Created on first reference, never deleted; the served coordinate is filled by
-- the first successful ingest and only by app_system.
--
-- cell_key is text, not a tuple of integers: the rounding rule is per model and
-- its documented form is still OPEN (tables-climate §1 notes, open-decisions).

CREATE TABLE app.outlook_cells (
  id                    uuid             PRIMARY KEY DEFAULT uuidv7(),
  provider              text             NOT NULL,
  -- Provider's own model name, no local aliasing (`ecmwf_ifs025`,
  -- `ecmwf_seas5`, `bmkg_cuaca`, …). No CHECK: the set is a provider fact, not
  -- a contract enum.
  model                 text             NOT NULL,
  cell_key              text             NOT NULL,
  -- The last value observed for this cell, not the authoritative per-record
  -- coordinate: weather_records carries requested/served per value, and a
  -- disagreement between the two is expected (tables-climate §1 notes).
  served_lat            double precision,
  served_lon            double precision,
  elevation_m           double precision,
  spatial_resolution_km double precision,
  created_at            timestamptz(6)   NOT NULL DEFAULT now(),
  served_updated_at     timestamptz(6),
  -- The natural key, and the only lookup that exists: it is also the target of
  -- `INSERT … ON CONFLICT (provider, model, cell_key) DO NOTHING` (Q25).
  CONSTRAINT outlook_cells_grid_key UNIQUE (provider, model, cell_key),
  CONSTRAINT outlook_cells_provider_check
    CHECK (provider IN ('bmkg', 'open-meteo', 'ecmwf')),
  -- Half a coordinate is not a coordinate.
  CONSTRAINT outlook_cells_coordinates_check
    CHECK ((served_lat IS NULL) = (served_lon IS NULL)),
  CONSTRAINT outlook_cells_served_lat_check
    CHECK (served_lat BETWEEN -90 AND 90),
  CONSTRAINT outlook_cells_served_lon_check
    CHECK (served_lon BETWEEN -180 AND 180)
);

-- Model run identity ---------------------------------------------------------
--
-- "Which model output" — the thing a user-facing "initialized 5 November"
-- refers to. Upserted by natural key; never deleted, never mutated except by a
-- corrective migration.
--
-- model_version is deliberately outside the natural key: no integrated provider
-- publishes one that changes mid-run, so including it would mint a new identity
-- on a relabel (tables-climate §2 notes, provenance-contract §3).

CREATE TABLE app.forecast_runs (
  id             uuid           PRIMARY KEY DEFAULT uuidv7(),
  provider       text           NOT NULL,
  model          text           NOT NULL,
  model_version  text,
  product        text           NOT NULL,
  initialized_at timestamptz(6) NOT NULL,
  horizon_end    timestamptz(6) NOT NULL,
  received_at    timestamptz(6) NOT NULL,
  created_at     timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT forecast_runs_natural_key
    UNIQUE (provider, model, product, initialized_at),
  CONSTRAINT forecast_runs_product_check
    CHECK (product IN ('forecast', 'ensemble', 'seasonal', 'archive')),
  CONSTRAINT forecast_runs_horizon_check CHECK (horizon_end > initialized_at)
);

-- "The current run for this model" (Q14), for the read path and stale detection.
CREATE INDEX forecast_runs_recent_idx
  ON app.forecast_runs (provider, model, initialized_at DESC);

-- Normalization provenance ---------------------------------------------------
--
-- One logical ingest of one run. One row per (forecast_run_id,
-- ingestion_version); a BullMQ retry bumps `attempt` in place, and a
-- re-normalization changes ingestion_version and so creates a new row under the
-- same run — a normalization fix must never surface as a new forecast
-- (tables-climate §3 notes).

CREATE TABLE app.ingestion_runs (
  id                   uuid             PRIMARY KEY DEFAULT uuidv7(),
  forecast_run_id      uuid             NOT NULL,
  adapter_version      text             NOT NULL,
  normalizer_version   text             NOT NULL,
  target_selector_hash text             NOT NULL,
  -- sha256(adapter_version, normalizer_version, target_selector_hash), and the
  -- identity component of a reprocess (tables-climate §3).
  ingestion_version    text             NOT NULL,
  status               text             NOT NULL DEFAULT 'queued',
  attempt              integer          NOT NULL DEFAULT 1,
  started_at           timestamptz(6)   NOT NULL DEFAULT now(),
  finished_at          timestamptz(6),
  record_count         integer          NOT NULL DEFAULT 0,
  coverage_percent     double precision NOT NULL DEFAULT 0,
  -- {code, message, payloadRef?}; shape-checked only, the Zod schema owns the rest.
  error                jsonb,
  raw_payload_ref      text,
  created_at           timestamptz(6)   NOT NULL DEFAULT now(),
  CONSTRAINT ingestion_runs_run_fkey FOREIGN KEY (forecast_run_id)
    REFERENCES app.forecast_runs (id),
  -- A retry must not mint a row; the unique key deliberately excludes `attempt`.
  CONSTRAINT ingestion_runs_identity_key UNIQUE (forecast_run_id, ingestion_version),
  CONSTRAINT ingestion_runs_status_check
    CHECK (status IN ('queued', 'running', 'partial', 'succeeded', 'failed')),
  CONSTRAINT ingestion_runs_attempt_check CHECK (attempt >= 1),
  CONSTRAINT ingestion_runs_record_count_check CHECK (record_count >= 0),
  CONSTRAINT ingestion_runs_coverage_check CHECK (coverage_percent BETWEEN 0 AND 100),
  -- A finished run with no finish time, or a finish time on a run still going.
  CONSTRAINT ingestion_runs_finished_check
    CHECK ((status IN ('succeeded', 'failed', 'partial')) = (finished_at IS NOT NULL)),
  CONSTRAINT ingestion_runs_hash_check
    CHECK (ingestion_version ~ '^[0-9a-f]{64}$'
       AND target_selector_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ingestion_runs_error_shape_check
    CHECK (error IS NULL OR jsonb_typeof(error) = 'object'),
  -- Version columns are opaque but must say something (physical-model §6).
  CONSTRAINT ingestion_runs_adapter_version_check CHECK (btrim(adapter_version) <> ''),
  CONSTRAINT ingestion_runs_normalizer_version_check CHECK (btrim(normalizer_version) <> '')
);

-- Q13: "what did we run for this forecast".
CREATE INDEX ingestion_runs_run_idx
  ON app.ingestion_runs (forecast_run_id, started_at DESC);
-- Q19: dead-letter and stuck-job detection. Partial, because the table grows
-- forever while the query only ever looks at these two statuses.
CREATE INDEX ingestion_runs_running_idx
  ON app.ingestion_runs (status) WHERE status IN ('queued', 'running');

-- The values -----------------------------------------------------------------
--
-- One normalized value: one variable, one validity time, one grid cell, one
-- run. The largest table in the model; appended per run, superseded on a
-- re-normalization, never deleted (tables-climate §4, lifecycle-and-retention §4).

CREATE TABLE app.weather_records (
  id                         uuid             PRIMARY KEY DEFAULT uuidv7(),
  forecast_run_id            uuid             NOT NULL,
  ingestion_run_id           uuid             NOT NULL,
  outlook_cell_id            uuid             NOT NULL,
  -- Denormalised so the uniqueness key and the record are self-describing.
  cell_key                   text             NOT NULL,
  provider                   text             NOT NULL,
  model                      text             NOT NULL,
  data_class                 text             NOT NULL,
  variable                   text             NOT NULL,
  -- NULL only when the provider published a null for this instant; never
  -- interpolated, never filled forward, never defaulted to 0 — a zero is a
  -- measurement, absence is not (temporal §6; a stored null is horizon
  -- evidence, an absent row is not).
  value                      double precision,
  unit                       text             NOT NULL,
  -- The instant the value describes, not when we fetched it (temporal §1).
  valid_at                   timestamptz(6)   NOT NULL,
  -- Copied from the run for range scans; immutable upstream (temporal §1).
  initialized_at             timestamptz(6)   NOT NULL,
  ingested_at                timestamptz(6)   NOT NULL DEFAULT now(),
  requested_lat              double precision NOT NULL,
  requested_lon              double precision NOT NULL,
  served_lat                 double precision,
  served_lon                 double precision,
  -- Must be shown: a served point is not a cell centre.
  served_value_is_interpolated boolean        NOT NULL,
  spatial_resolution_km      double precision,
  -- OPEN-14: the temporal vocabulary is unsettled, so no CHECK. Values in use
  -- are hourly | three_hourly | daily | monthly.
  temporal_resolution        text,
  ensemble_member            integer,
  ensemble_size              integer,
  -- v1 never corrects; `true` would be an unimplemented claim in a provenance
  -- record (D3, temporal §7).
  bias_corrected             boolean          NOT NULL DEFAULT false,
  -- OPEN-14 again: instant | daily_sum | daily_mean | monthly_sum | monthly_mean.
  aggregation_level          text,
  source_url                 text,
  attribution                text,
  normalizer_version         text             NOT NULL,
  supersedes_id              uuid,
  superseded_by_id           uuid,
  -- NULL = live. Only these two markers are ever mutated on this table.
  superseded_at              timestamptz(6),
  created_at                 timestamptz(6)   NOT NULL DEFAULT now(),
  CONSTRAINT weather_records_run_fkey FOREIGN KEY (forecast_run_id)
    REFERENCES app.forecast_runs (id),
  -- Two run identities, both independent: which model output, and which
  -- normalization (relationships §3).
  CONSTRAINT weather_records_ingestion_fkey FOREIGN KEY (ingestion_run_id)
    REFERENCES app.ingestion_runs (id),
  CONSTRAINT weather_records_cell_fkey FOREIGN KEY (outlook_cell_id)
    REFERENCES app.outlook_cells (id),
  CONSTRAINT weather_records_supersedes_fkey FOREIGN KEY (supersedes_id)
    REFERENCES app.weather_records (id),
  CONSTRAINT weather_records_superseded_by_fkey FOREIGN KEY (superseded_by_id)
    REFERENCES app.weather_records (id),
  -- Only the four forecast classes. reanalysis, satellite_estimate,
  -- station_observation, field_observation and climatology have different homes,
  -- so "climatology never masquerades as a forecast" is a schema property (D24).
  CONSTRAINT weather_records_data_class_check
    CHECK (data_class IN ('weather_forecast', 'subseasonal_forecast',
                          'seasonal_forecast', 'annual_outlook')),
  CONSTRAINT weather_records_bias_check CHECK (bias_corrected = false),
  CONSTRAINT weather_records_supersession_check
    CHECK ((superseded_by_id IS NULL) = (superseded_at IS NULL)),
  CONSTRAINT weather_records_ensemble_check
    CHECK (ensemble_member IS NULL
           OR (ensemble_size IS NOT NULL AND ensemble_member < ensemble_size)),
  CONSTRAINT weather_records_coordinates_check
    CHECK ((served_lat IS NULL) = (served_lon IS NULL)),
  CONSTRAINT weather_records_unit_check CHECK (btrim(unit) <> ''),
  CONSTRAINT weather_records_ensemble_member_check CHECK (ensemble_member >= 0),
  CONSTRAINT weather_records_ensemble_size_check CHECK (ensemble_size >= 1),
  CONSTRAINT weather_records_normalizer_version_check
    CHECK (btrim(normalizer_version) <> '')
);

-- The upsert target (Q12/D18). NULLS NOT DISTINCT is load-bearing: PostgreSQL
-- treats NULL as distinct by default, so ensemble_member = NULL rows would never
-- collide and every re-ingest of a deterministic product would append a full
-- duplicate set (indexes §3).
CREATE UNIQUE INDEX weather_records_live_key
  ON app.weather_records (forecast_run_id, cell_key, variable, valid_at, ensemble_member)
  NULLS NOT DISTINCT
  WHERE superseded_at IS NULL;

-- Q12, the hot read: a daily/weekly series for one cell and variable.
CREATE INDEX weather_records_series_idx
  ON app.weather_records (cell_key, variable, valid_at)
  WHERE superseded_at IS NULL;
-- Q13: what did this run produce, for coverage accounting.
CREATE INDEX weather_records_run_idx
  ON app.weather_records (forecast_run_id)
  WHERE superseded_at IS NULL;
-- Q20: supersede-on-reprocess. NOT partial on purpose — the operation must see
-- rows that are already superseded, to avoid double-superseding them.
CREATE INDEX weather_records_ingestion_idx
  ON app.weather_records (ingestion_run_id);

-- The monthly read model -----------------------------------------------------
--
-- One month of one variable for one cell, resolved to a single dataClass, with
-- its anomaly and provenance. Global and keyed by cell, not tenant-owned (D2):
-- nothing here names a field, so a new run never touches a tenant row.
--
-- Recomputed per cell, superseded by status change, never deleted; a failed
-- attempt leaves the previous active row untouched.

CREATE TABLE app.monthly_outlooks (
  id                         uuid             PRIMARY KEY DEFAULT uuidv7(),
  outlook_cell_id            uuid             NOT NULL,
  variable                   text             NOT NULL,
  -- First day of the month, Asia/Jakarta calendar (temporal §2).
  month                      date             NOT NULL,
  -- WeatherDataClass. All nine values are legal here, including the four
  -- weather_records refuses and climatology: an outlook month is a presentation
  -- decision, and climatology is a legitimate labelled answer (tables-climate §5
  -- notes, D24). The CHECK mirrors the contract enum (physical-model §5) rather
  -- than narrowing it, so it cannot reject a valid contract value.
  data_class                 text,
  evaluation_basis           text             NOT NULL,
  -- NULL when nothing may be claimed, on the state table below.
  value_mm                   double precision,
  -- MissingReason. Describes the forecast axis only: a beyond_horizon month
  -- carries a real climatology value and this reason at once.
  missing_reason             text,
  anomaly_kind               text,
  anomaly_mm                 double precision,
  anomaly_percent            double precision,
  baseline_version           text,
  -- Disclosed offset, only for a baseline_difference (ADR-001 D3).
  model_climate_offset_mm    double precision,
  data_coverage_percent      double precision,
  ensemble_spread_mm         double precision,
  spread_unavailable_reason  text,
  derivation_version         text             NOT NULL,
  -- DataInputRef[]; a hashed contract document, so JSONB and not shreddered.
  input_refs                 jsonb            NOT NULL,
  input_snapshot_hash        text             NOT NULL,
  computed_at                timestamptz(6)   NOT NULL DEFAULT now(),
  status                     text             NOT NULL DEFAULT 'active',
  superseded_by_id           uuid,
  created_at                 timestamptz(6)   NOT NULL DEFAULT now(),
  CONSTRAINT monthly_outlooks_cell_fkey FOREIGN KEY (outlook_cell_id)
    REFERENCES app.outlook_cells (id),
  CONSTRAINT monthly_outlooks_superseded_fkey FOREIGN KEY (superseded_by_id)
    REFERENCES app.monthly_outlooks (id),
  CONSTRAINT monthly_outlooks_month_check CHECK (EXTRACT(DAY FROM month) = 1),
  -- The only assembled variable in v1.
  CONSTRAINT monthly_outlooks_variable_check CHECK (variable = 'precipitation'),
  CONSTRAINT monthly_outlooks_evaluation_basis_check
    CHECK (evaluation_basis IN ('monthly', 'climatology')),
  -- MissingReason, in contract order (physical-model §5).
  CONSTRAINT monthly_outlooks_data_class_check
    CHECK (data_class IS NULL
           OR data_class IN ('field_observation', 'station_observation',
                             'satellite_estimate', 'reanalysis', 'weather_forecast',
                             'subseasonal_forecast', 'seasonal_forecast',
                             'annual_outlook', 'climatology')),
  CONSTRAINT monthly_outlooks_missing_reason_check
    CHECK (missing_reason IS NULL
           OR missing_reason IN ('beyond_horizon', 'not_requested', 'pending',
                                 'ingest_failed', 'provider_unavailable',
                                 'insufficient_history', 'below_coverage_threshold')),
  CONSTRAINT monthly_outlooks_anomaly_kind_check
    CHECK (anomaly_kind IS NULL
           OR anomaly_kind IN ('model_anomaly', 'baseline_difference')),
  -- The month state table (tables-climate §5, temporal §6): a value is present
  -- exactly when a data class is present; the six no-value reasons imply both are
  -- absent. beyond_horizon is the one reason that travels with a value, and the
  -- constraint below forces it to carry one.
  --
  -- Written as an implication, not a disjunction over "reason is one of these OR
  -- value is present": that form is a tautology whenever the value is present and
  -- would let `pending` sit next to a number — the exact rendering this constraint
  -- exists to prevent.
  CONSTRAINT monthly_outlooks_value_state_check
    CHECK ((value_mm IS NULL) = (data_class IS NULL)
           AND (missing_reason IS NULL
                OR missing_reason = 'beyond_horizon'
                OR (value_mm IS NULL AND data_class IS NULL))),
  -- The single most important constraint here: climatology substituted for a
  -- failed ingest is unrepresentable, because a failure has no value at all.
  CONSTRAINT monthly_outlooks_beyond_horizon_check
    CHECK (missing_reason <> 'beyond_horizon'
           OR data_class = 'climatology'),
  -- beyond_horizon implies a value, so the two state rows that carry it (a real
  -- climatology month, and the horizon genuinely ending) both render a number.
  CONSTRAINT monthly_outlooks_beyond_horizon_value_check
    CHECK (missing_reason <> 'beyond_horizon' OR value_mm IS NOT NULL),
  -- A climatology month carries no initialisation-derived anomaly, and needs a
  -- baseline to exist at all.
  CONSTRAINT monthly_outlooks_climatology_check
    CHECK (data_class <> 'climatology'
           OR (baseline_version IS NOT NULL AND anomaly_kind IS NULL)),
  -- A baseline difference without a disclosed offset is the ADR-001 D3 failure;
  -- a model anomaly must not carry an offset.
  CONSTRAINT monthly_outlooks_anomaly_check
    CHECK ((anomaly_kind IS DISTINCT FROM 'baseline_difference'
            OR (baseline_version IS NOT NULL AND model_climate_offset_mm IS NOT NULL))
       AND (anomaly_kind IS DISTINCT FROM 'model_anomaly'
            OR model_climate_offset_mm IS NULL)),
  -- A silent missing spread is a defect; the reason is required when it is NULL.
  CONSTRAINT monthly_outlooks_spread_check
    CHECK ((ensemble_spread_mm IS NULL) = (spread_unavailable_reason IS NOT NULL)),
  CONSTRAINT monthly_outlooks_value_check CHECK (value_mm >= 0),
  CONSTRAINT monthly_outlooks_coverage_check
    CHECK (data_coverage_percent BETWEEN 0 AND 100),
  CONSTRAINT monthly_outlooks_spread_value_check CHECK (ensemble_spread_mm >= 0),
  CONSTRAINT monthly_outlooks_hash_check
    CHECK (input_snapshot_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT monthly_outlooks_input_refs_shape_check
    CHECK (jsonb_typeof(input_refs) = 'array'),
  CONSTRAINT monthly_outlooks_status_check
    CHECK (status IN ('active', 'superseded', 'failed')),
  -- A superseded row with no successor, or a successor on a live row.
  CONSTRAINT monthly_outlooks_superseded_state_check
    CHECK ((status = 'superseded') = (superseded_by_id IS NOT NULL)),
  CONSTRAINT monthly_outlooks_derivation_version_check
    CHECK (btrim(derivation_version) <> '')
);

-- One live answer per cell-month; the recompute upsert target.
CREATE UNIQUE INDEX monthly_outlooks_active_key
  ON app.monthly_outlooks (outlook_cell_id, variable, month)
  WHERE status = 'active';
-- Q15: render a 12-month outlook for a cell. Not partial — history is read.
CREATE INDEX monthly_outlooks_cell_month_idx
  ON app.monthly_outlooks (outlook_cell_id, month);
-- Trace a recompute chain.
CREATE INDEX monthly_outlooks_superseded_idx
  ON app.monthly_outlooks (superseded_by_id)
  WHERE superseded_by_id IS NOT NULL;

-- Climatology baseline -------------------------------------------------------
--
-- The 1991-2020 monthly normal for a cell, per baseline version. Built once per
-- baseline_version; a rebuild is a new version, never an edit, because editing
-- in place would silently change every stored anomaly while still claiming the
-- same version string (provenance-contract §4 rule 3).
--
-- baseline_version is free text that embeds dataset and period by convention;
-- it is not validated against baseline_dataset/period_* on purpose — the string
-- is what appears in every artifact's input_refs (tables-climate §6 notes).
-- baseline_hash is not a column: it depends on the subset consumed.

CREATE TABLE app.climatology_normals (
  id               uuid             PRIMARY KEY DEFAULT uuidv7(),
  baseline_version text             NOT NULL,
  baseline_dataset text             NOT NULL,
  period_from      date             NOT NULL,
  period_to        date             NOT NULL,
  outlook_cell_id  uuid             NOT NULL,
  month            date             NOT NULL,
  value_mm         double precision NOT NULL,
  -- NULL when the builder did not record how many years contributed.
  sample_years     integer,
  computed_at      timestamptz(6)   NOT NULL DEFAULT now(),
  created_at       timestamptz(6)   NOT NULL DEFAULT now(),
  CONSTRAINT climatology_normals_cell_fkey FOREIGN KEY (outlook_cell_id)
    REFERENCES app.outlook_cells (id),
  -- Two normals for one month leave an anomaly with no answer.
  CONSTRAINT climatology_normals_key
    UNIQUE (baseline_version, outlook_cell_id, month),
  CONSTRAINT climatology_normals_month_check CHECK (EXTRACT(DAY FROM month) = 1),
  CONSTRAINT climatology_normals_period_check CHECK (period_to > period_from),
  CONSTRAINT climatology_normals_dataset_check
    CHECK (baseline_dataset IN ('era5', 'chirps_v3', 'nasa_power')),
  CONSTRAINT climatology_normals_value_check CHECK (value_mm >= 0),
  CONSTRAINT climatology_normals_sample_years_check CHECK (sample_years > 0),
  CONSTRAINT climatology_normals_version_check CHECK (btrim(baseline_version) <> '')
);

-- Q17: a full year of normals for a cell.
CREATE INDEX climatology_normals_cell_idx
  ON app.climatology_normals (outlook_cell_id, month);

-- Row security ---------------------------------------------------------------
--
-- None. All six tables are `global` in ownership-and-rls §2 (rows 14-19), the
-- matrix's RLS column is `none` for each, and there is no user_id to compare a
-- policy against. ENABLE/FORCE here would add a policy on a table with no owner
-- column and would document a tenancy that the data does not have.

-- Runtime privileges ---------------------------------------------------------
--
-- Explicit, per table, per operation. No `GRANT ALL`, no
-- `GRANT … ON ALL TABLES`, no `ALTER DEFAULT PRIVILEGES` (ownership-and-rls §2
-- rule 1, ownership-and-rls §4).
--
-- app_api reads provider data and cannot write it: ingestion runs as app_system,
-- so a compromised request path cannot fabricate a forecast a tenant plants
-- against (ownership-and-rls §2 rule 4).
--
-- app_api's one write is the identity triple on outlook_cells. The grant is
-- column-level, so a future bug cannot set a served coordinate; the served
-- coordinate is a provider fact only app_system observes (D14).

GRANT SELECT ON
  app.outlook_cells, app.forecast_runs, app.ingestion_runs,
  app.weather_records, app.monthly_outlooks, app.climatology_normals
  TO app_api;

GRANT INSERT (provider, model, cell_key) ON app.outlook_cells TO app_api;

-- app_system writes the plane. UPDATE on weather_records because supersession is
-- an update (superseded_by_id/superseded_at), not a delete.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  app.outlook_cells, app.forecast_runs, app.ingestion_runs,
  app.weather_records, app.monthly_outlooks, app.climatology_normals
  TO app_system;

-- Part: field operations: resolution, observation, planting, harvest.
--
-- Four tenant tables, in dependency order. `app.users`, `app.farms` and
-- `app.fields` already exist (Phase 2.2.3); `app.outlook_cells` and
-- `app.cultivars` are created by their own Phase 3 fragments and are referenced
-- here, not restated.
--
-- Conventions are those of 20261118020000_tenant_tables: types aligned in the
-- column list, one rationale comment per non-obvious column or constraint,
-- policies and grants written explicitly per table. Instants are timestamptz(6)
-- (physical-model §3) — the 2.2.3 file predates that precision being stated and
-- used bare timestamptz.
--
-- Nothing here is cascading. Tenant rows are soft-deleted (farms, fields) or
-- retained as history (resolutions, observations, harvests), so ON DELETE NO
-- ACTION everywhere is the rule, not an omission (relationships §2).

-- Field → cell resolution ----------------------------------------------------
--
-- Which provider cell serves which field, stored rather than recomputed: a
-- superseded row's distance is what was true when the old snapshot hash was
-- computed, and overwriting it would make that hash unexplainable.
--
-- provider and model are denormalised from the cell so the live-uniqueness index
-- can be a partial unique index on this table alone (tables-identity §4, D1).

CREATE TABLE app.field_outlook_cells (
  id                uuid             PRIMARY KEY DEFAULT uuidv7(),
  user_id           uuid             NOT NULL,
  field_id          uuid             NOT NULL,
  outlook_cell_id   uuid             NOT NULL,
  provider          text             NOT NULL,
  model             text             NOT NULL,
  extraction_policy text             NOT NULL,
  distance_km       double precision NOT NULL,
  -- NULL when either the served cell elevation or fields.elevation_m is unknown;
  -- unknown is not zero.
  elevation_delta_m double precision,
  -- resolved_at is this row's creation instant. `D11` says "created_at everywhere";
  -- this table's column list (§4) names the instant `resolved_at` instead, and a
  -- second column holding the same value would be a second answer. No created_at.
  resolved_at       timestamptz(6)   NOT NULL DEFAULT now(),
  -- Set when the field geometry changed. Rows are kept, never hard-deleted
  -- while the field exists.
  superseded_at     timestamptz(6),
  -- No (id, user_id) unique key: nothing references this table, so it would be an
  -- index with no query behind it. Added by the migration that needs it as a
  -- composite-FK target, not speculatively.
  -- Ownership travels with the reference (physical-model §10): a tenant cannot
  -- resolve another tenant's field, and the failure is 23503, not 42501.
  CONSTRAINT field_outlook_cells_field_owner_fkey FOREIGN KEY (field_id, user_id)
    REFERENCES app.fields (id, user_id),
  -- The only tenant→global edge in the model (relationships §3). Single column,
  -- not composite: a cell has no owner and holds no tenant data.
  CONSTRAINT field_outlook_cells_cell_fkey FOREIGN KEY (outlook_cell_id)
    REFERENCES app.outlook_cells (id),
  CONSTRAINT field_outlook_cells_extraction_policy_check
    CHECK (extraction_policy IN ('centroid', 'area_weighted')),
  CONSTRAINT field_outlook_cells_distance_check CHECK (distance_km >= 0)
);

-- At most one live cell per provider grid per field. Partial because history is
-- retained; the write path upserts against exactly this predicate.
CREATE UNIQUE INDEX field_outlook_cells_live_key
  ON app.field_outlook_cells (field_id, provider, model) WHERE superseded_at IS NULL;
-- Q18: which fields does this cell serve. Still unanswerable by app_system
-- (OPEN-27); the index exists so the answer is cheap once the access shape is
-- decided.
CREATE INDEX field_outlook_cells_cell_idx ON app.field_outlook_cells (outlook_cell_id);
CREATE INDEX field_outlook_cells_field_idx ON app.field_outlook_cells (field_id);

-- Field observations ---------------------------------------------------------
--
-- The only source that may be displayed as an observation: user-entered
-- measurements, never provider data. Deliberately no unique constraint on
-- (field_id, observed_at, kind) — two rain gauges read at 10:00 are two
-- observations.

CREATE TABLE app.field_observations (
  id          uuid             PRIMARY KEY DEFAULT uuidv7(),
  user_id     uuid             NOT NULL,
  field_id    uuid             NOT NULL,
  kind        text             NOT NULL,
  -- Both NULL for kind = 'note', both NOT NULL otherwise; enforced below.
  value       double precision,
  unit        text,
  -- When the measurement was taken, not when it was entered.
  observed_at timestamptz(6)   NOT NULL,
  method      text,
  -- The acting account. Equal to user_id in v1 (D7); the two columns diverge
  -- only when shared access exists, which is also the migration that drops the
  -- check below.
  entered_by  uuid             NOT NULL,
  created_at  timestamptz(6)   NOT NULL DEFAULT now(),
  updated_at  timestamptz(6)   NOT NULL DEFAULT now(),
  -- No (id, user_id) unique key: the snapshot refers to an observation by id and
  -- nothing foreign-keys this table (see field_outlook_cells for the same rule).
  CONSTRAINT field_observations_field_owner_fkey FOREIGN KEY (field_id, user_id)
    REFERENCES app.fields (id, user_id),
  CONSTRAINT field_observations_kind_check
    CHECK (kind IN ('rainfall', 'soil_moisture', 'temperature', 'note')),
  -- A measurement without a unit is uninterpretable; a note with a number is
  -- unreadable. One constraint rather than two so the pairing cannot drift.
  CONSTRAINT field_observations_value_presence_check CHECK (
    (kind = 'note' AND value IS NULL AND unit IS NULL)
    OR (kind <> 'note' AND value IS NOT NULL AND unit IS NOT NULL)
  ),
  CONSTRAINT field_observations_entered_by_check CHECK (entered_by = user_id),
  -- One day of slack for clock skew and a measurement entered just after
  -- midnight; anything further ahead is a typo.
  CONSTRAINT field_observations_observed_at_check
    CHECK (observed_at <= now() + interval '1 day')
);

-- Q4: recent observations for a field, and the snapshot's observationsUsed
-- window. Descending because every read wants the newest first.
CREATE INDEX field_observations_field_time_idx
  ON app.field_observations (field_id, observed_at DESC);

-- Plantings ------------------------------------------------------------------
--
-- What is actually growing, from when, on which cycle basis. expectedHarvestAt is
-- absent on purpose: it is derived from cultivars.duration_days_* and planted_at
-- at read time, and a stored copy goes stale when a cultivar is corrected.

CREATE TABLE app.plantings (
  id               uuid             PRIMARY KEY DEFAULT uuidv7(),
  user_id          uuid             NOT NULL,
  field_id         uuid             NOT NULL,
  -- Global catalog row: plain single-column FK, no ownership to carry.
  cultivar_id      uuid             NOT NULL,
  -- Sowing or transplant date, whichever cycle_start_used names.
  planted_at       date             NOT NULL,
  cycle_start_used text             NOT NULL,
  -- May be smaller than fields.area_ha: a farmer may plant part of a plot.
  area_planted_ha  double precision NOT NULL,
  -- Vocabulary is unsettled (OPEN-09), so this column carries no default and no
  -- CHECK, and no index is created on any status literal.
  -- Deferred: DEFAULT 'active', and plantings_active_idx ON (user_id, field_id)
  -- WHERE status = 'active' (Q5 priority rule). Both wait on OPEN-09 naming the
  -- value; guessing now would put an unapproved enum in the schema and in the
  -- index predicate.
  status           text             NOT NULL,
  created_at       timestamptz(6)   NOT NULL DEFAULT now(),
  updated_at       timestamptz(6)   NOT NULL DEFAULT now(),
  CONSTRAINT plantings_id_user_id_key UNIQUE (id, user_id),
  CONSTRAINT plantings_field_owner_fkey FOREIGN KEY (field_id, user_id)
    REFERENCES app.fields (id, user_id),
  CONSTRAINT plantings_cultivar_fkey FOREIGN KEY (cultivar_id)
    REFERENCES app.cultivars (id),
  CONSTRAINT plantings_cycle_start_check
    CHECK (cycle_start_used IN ('sowing', 'transplant')),
  CONSTRAINT plantings_area_check CHECK (area_planted_ha > 0)
);

-- Q5: what is growing in this field.
CREATE INDEX plantings_field_idx ON app.plantings (field_id, planted_at DESC);

-- Harvests -------------------------------------------------------------------
--
-- Realised yield per picking event. Many rows per planting: cabai is picked
-- repeatedly over weeks, so there is no UNIQUE (planting_id).

CREATE TABLE app.harvests (
  id           uuid           PRIMARY KEY DEFAULT uuidv7(),
  user_id      uuid           NOT NULL,
  planting_id  uuid           NOT NULL,
  harvested_at date           NOT NULL,
  -- numeric, not double precision: summed and averaged for reporting, and no
  -- hash covers it. 0 is legal — a failed picking is data.
  yield_kg     numeric(10, 2) NOT NULL,
  notes        text,
  created_at   timestamptz(6) NOT NULL DEFAULT now(),
  updated_at   timestamptz(6) NOT NULL DEFAULT now(),
  -- No (id, user_id) unique key: harvests are terminal in the model; nothing
  -- references a harvest row.
  CONSTRAINT harvests_planting_owner_fkey FOREIGN KEY (planting_id, user_id)
    REFERENCES app.plantings (id, user_id),
  CONSTRAINT harvests_yield_check CHECK (yield_kg >= 0)
);

-- Q6: yield history for a planting; and per-season totals across a tenant.
CREATE INDEX harvests_planting_idx ON app.harvests (planting_id, harvested_at DESC);
CREATE INDEX harvests_user_time_idx ON app.harvests (user_id, harvested_at DESC);

-- Row isolation -------------------------------------------------------------
--
-- Same shape as 2.2.3, per table. FORCE matters because migration_owner owns
-- these tables, and the predicate is fail-closed on an unset GUC, an empty
-- string, and a non-uuid value. FOR ALL rather than four policies: the ownership
-- predicate is identical for every verb, and UPDATE needs the WITH CHECK half or
-- a tenant could move a row to another owner.

ALTER TABLE app.field_outlook_cells ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.field_outlook_cells FORCE ROW LEVEL SECURITY;
CREATE POLICY field_outlook_cells_tenant_isolation ON app.field_outlook_cells
  FOR ALL TO app_api
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

ALTER TABLE app.field_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.field_observations FORCE ROW LEVEL SECURITY;
CREATE POLICY field_observations_tenant_isolation ON app.field_observations
  FOR ALL TO app_api
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

ALTER TABLE app.plantings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.plantings FORCE ROW LEVEL SECURITY;
CREATE POLICY plantings_tenant_isolation ON app.plantings
  FOR ALL TO app_api
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

ALTER TABLE app.harvests ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.harvests FORCE ROW LEVEL SECURITY;
CREATE POLICY harvests_tenant_isolation ON app.harvests
  FOR ALL TO app_api
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

-- FORCE denies the owner too, so without these the owner cannot insert a
-- fixture or run a data migration. Not a widening: owning the table already
-- means DROP and ALTER.
CREATE POLICY field_outlook_cells_owner_full_access ON app.field_outlook_cells
  FOR ALL TO migration_owner USING (true) WITH CHECK (true);
CREATE POLICY field_observations_owner_full_access ON app.field_observations
  FOR ALL TO migration_owner USING (true) WITH CHECK (true);
CREATE POLICY plantings_owner_full_access ON app.plantings
  FOR ALL TO migration_owner USING (true) WITH CHECK (true);
CREATE POLICY harvests_owner_full_access ON app.harvests
  FOR ALL TO migration_owner USING (true) WITH CHECK (true);

-- Runtime privileges --------------------------------------------------------
--
-- ownership-and-rls §2: all four are 'tenant', app_api RW, app_system nothing,
-- migration_owner RW. No GRANT ALL, no ALTER DEFAULT PRIVILEGES, no PUBLIC.
--
-- app_system is granted nothing: the fan-out query (Q18) that would want a read
-- on field_outlook_cells is OPEN-27, and the grant belongs in the migration that
-- resolves it, not here.

GRANT SELECT, INSERT, UPDATE, DELETE ON app.field_outlook_cells TO app_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.field_observations TO app_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.plantings TO app_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.harvests TO app_api;

-- Part: derived agronomic and AI artifacts.
--
-- Three tenant-derived tables, in dependency order: a run produces windows and a
-- briefing. Every one is append-and-supersede, tenant-owned, and carries its own
-- provenance. Column and constraint specs: docs/data-model/tables-derived.md §1-3;
-- privilege matrix: docs/data-model/ownership-and-rls.md §2 and §4.
--
-- Nothing here is validated beyond document shape. `evidence_segments` and
-- `missing_ranges` are hash preimages; the partition invariant over them
-- (provenance-contract.md §2, six checks) is a write-path property and is NOT
-- expressible here (OPEN-26, tables-derived.md §2).

-- 1. suitability_runs --------------------------------------------------------

CREATE TABLE app.suitability_runs (
  id                    uuid          PRIMARY KEY DEFAULT uuidv7(),
  -- Denormalised from fields for the same reason fields.user_id is: the policy
  -- compares a column instead of joining through another RLS-protected table.
  user_id               uuid          NOT NULL,
  field_id              uuid          NOT NULL,
  profile_version_id    uuid          NOT NULL,
  computed_at           timestamptz(6) NOT NULL DEFAULT now(),
  engine_version        text          NOT NULL,
  derivation_version    text          NOT NULL,
  -- [{dimension, state}]. Five closed dimensions; a table would add a join to a
  -- read that happens on every field page (tables-derived.md §1 notes).
  dimension_coverage    jsonb         NOT NULL,
  -- NULL, not 'D', when no dimension is `known`: 'D' would be a claim.
  max_achievable_level  text,
  input_refs            jsonb         NOT NULL,
  -- The body is stored whole, on this table only. A window or briefing carries
  -- the hash, not the snapshot (provenance-storage.md §3).
  field_snapshot        jsonb         NOT NULL,
  field_snapshot_hash   text          NOT NULL,
  input_snapshot_hash   text          NOT NULL,
  reproducible          boolean       NOT NULL DEFAULT true,
  unreproducible_reason text,
  status                text          NOT NULL DEFAULT 'active',
  supersedes_id         uuid,
  superseded_by_id      uuid,
  created_at            timestamptz(6) NOT NULL DEFAULT now(),
  -- Composite-FK target for planting_windows and ai_briefings.
  CONSTRAINT suitability_runs_id_user_id_key UNIQUE (id, user_id),
  CONSTRAINT suitability_runs_field_owner_fkey FOREIGN KEY (field_id, user_id)
    REFERENCES app.fields (id, user_id),
  CONSTRAINT suitability_runs_profile_fkey FOREIGN KEY (profile_version_id)
    REFERENCES app.crop_profile_versions (id),
  CONSTRAINT suitability_runs_supersedes_fkey FOREIGN KEY (supersedes_id)
    REFERENCES app.suitability_runs (id),
  CONSTRAINT suitability_runs_superseded_by_fkey FOREIGN KEY (superseded_by_id)
    REFERENCES app.suitability_runs (id),
  CONSTRAINT suitability_runs_status_check
    CHECK (status IN ('active', 'superseded', 'failed')),
  -- Successor and status cannot disagree: a superseded run with no successor is
  -- a broken chain, and an active run with a successor is two live rows.
  CONSTRAINT suitability_runs_superseded_state_check
    CHECK ((status = 'superseded') = (superseded_by_id IS NOT NULL)),
  -- Unreproducibility is a stored claim with a stored reason, never silent
  -- (provenance-storage.md §7).
  CONSTRAINT suitability_runs_reproducible_check
    CHECK (reproducible OR unreproducible_reason IS NOT NULL),
  CONSTRAINT suitability_runs_level_check
    CHECK (max_achievable_level IS NULL OR max_achievable_level IN ('A', 'B', 'C', 'D')),
  CONSTRAINT suitability_runs_hash_check
    CHECK (field_snapshot_hash ~ '^[0-9a-f]{64}$'
       AND input_snapshot_hash ~ '^[0-9a-f]{64}$'),
  -- Shape only. Per-dimension states are validated by the Zod schema.
  CONSTRAINT suitability_runs_coverage_check
    CHECK (jsonb_typeof(dimension_coverage) = 'array')
);

-- Q9: one live evaluation per field.
CREATE UNIQUE INDEX suitability_runs_live_key
  ON app.suitability_runs (field_id) WHERE status = 'active';
CREATE INDEX suitability_runs_field_idx
  ON app.suitability_runs (field_id, computed_at DESC);
-- Q10: "has this exact input set already been evaluated".
CREATE INDEX suitability_runs_hash_idx
  ON app.suitability_runs (field_id, input_snapshot_hash);

-- 2. planting_windows --------------------------------------------------------

CREATE TABLE app.planting_windows (
  id                        uuid          PRIMARY KEY DEFAULT uuidv7(),
  user_id                   uuid          NOT NULL,
  suitability_run_id        uuid          NOT NULL,
  field_id                  uuid          NOT NULL,
  -- Duplicates cultivars.crop_id on purpose: every list query filters by crop.
  crop_id                   uuid          NOT NULL,
  cultivar_id               uuid          NOT NULL,
  -- Mandatory on the window as well as on the run, so a window read alone is
  -- self-describing (provenance-contract.md §4 rule 4).
  profile_version_id        uuid          NOT NULL,
  window_start              date          NOT NULL,
  window_end                date          NOT NULL,
  evaluation_basis          text          NOT NULL,
  primary_basis             text          NOT NULL,
  mixed_evidence            boolean       NOT NULL,
  weakest_evidence_class    text          NOT NULL,
  -- Ordered array; position is semantic and the canonicaliser does not sort it.
  evidence_segments         jsonb         NOT NULL,
  -- A set, not a sequence; the difference is why canonicalArrayRules is per-field.
  missing_ranges            jsonb         NOT NULL,
  suitability               text          NOT NULL,
  score                     numeric(5, 2),
  risks                     jsonb         NOT NULL DEFAULT '[]'::jsonb,
  explanations              jsonb         NOT NULL DEFAULT '[]'::jsonb,
  constraints_evaluated     jsonb         NOT NULL DEFAULT '[]'::jsonb,
  missing_inputs            jsonb         NOT NULL DEFAULT '[]'::jsonb,
  input_refs                jsonb         NOT NULL,
  field_snapshot_hash       text          NOT NULL,
  input_snapshot_hash       text          NOT NULL,
  reproducible              boolean       NOT NULL DEFAULT true,
  unreproducible_reason     text,
  computed_at               timestamptz(6) NOT NULL DEFAULT now(),
  status                    text          NOT NULL DEFAULT 'active',
  superseded_by_id          uuid,
  created_at                timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT planting_windows_run_owner_fkey FOREIGN KEY (suitability_run_id, user_id)
    REFERENCES app.suitability_runs (id, user_id),
  CONSTRAINT planting_windows_field_owner_fkey FOREIGN KEY (field_id, user_id)
    REFERENCES app.fields (id, user_id),
  CONSTRAINT planting_windows_crop_fkey FOREIGN KEY (crop_id)
    REFERENCES app.crops (id),
  CONSTRAINT planting_windows_cultivar_fkey FOREIGN KEY (cultivar_id)
    REFERENCES app.cultivars (id),
  CONSTRAINT planting_windows_profile_fkey FOREIGN KEY (profile_version_id)
    REFERENCES app.crop_profile_versions (id),
  CONSTRAINT planting_windows_span_check CHECK (window_end >= window_start),
  CONSTRAINT planting_windows_suitability_check
    CHECK (suitability IN ('suitable', 'conditional', 'unsuitable', 'insufficient_data')),
  -- Invariant 1 of domain-model §5: no numeric score on unknown inputs.
  CONSTRAINT planting_windows_no_score_without_data_check
    CHECK (suitability <> 'insufficient_data' OR score IS NULL),
  -- A "suitable" verdict whose critical stage rests on climatology is a claim the
  -- evidence does not support.
  CONSTRAINT planting_windows_climatology_primary_check
    CHECK (NOT (primary_basis = 'climatology' AND suitability = 'suitable')),
  -- `mixed` is container-level only and may not leak into primary_basis.
  CONSTRAINT planting_windows_basis_check
    CHECK (evaluation_basis IN ('daily', 'weekly', 'monthly', 'climatology', 'mixed')
       AND primary_basis IN ('daily', 'weekly', 'monthly', 'climatology')),
  CONSTRAINT planting_windows_weakest_class_check
    CHECK (weakest_evidence_class IN ('field_observation', 'station_observation',
      'satellite_estimate', 'reanalysis', 'weather_forecast', 'subseasonal_forecast',
      'seasonal_forecast', 'annual_outlook', 'climatology')),
  CONSTRAINT planting_windows_score_range_check CHECK (score BETWEEN 0 AND 100),
  CONSTRAINT planting_windows_reproducible_check
    CHECK (reproducible OR unreproducible_reason IS NOT NULL),
  CONSTRAINT planting_windows_status_check
    CHECK (status IN ('active', 'superseded', 'failed')),
  CONSTRAINT planting_windows_superseded_state_check
    CHECK ((status = 'superseded') = (superseded_by_id IS NOT NULL)),
  -- Array shape only. The partition invariant over these two documents is not
  -- enforced here and this check must not be read as enforcing it.
  CONSTRAINT planting_windows_documents_check
    CHECK (jsonb_typeof(evidence_segments) = 'array'
       AND jsonb_typeof(missing_ranges) = 'array'),
  CONSTRAINT planting_windows_hash_check
    CHECK (field_snapshot_hash ~ '^[0-9a-f]{64}$'
       AND input_snapshot_hash ~ '^[0-9a-f]{64}$')
);

-- Q7: windows for a field and crop, in date order.
CREATE INDEX planting_windows_live_idx
  ON app.planting_windows (field_id, crop_id, window_start) WHERE status = 'active';
CREATE INDEX planting_windows_run_idx ON app.planting_windows (suitability_run_id);
-- Q8: overlap tests for a requested range. Cannot serve Q7 (crop filter in the
-- middle) and is not served by it (window_end absent).
CREATE INDEX planting_windows_window_range_idx
  ON app.planting_windows (field_id, window_start, window_end) WHERE status = 'active';
CREATE INDEX planting_windows_superseded_idx
  ON app.planting_windows (superseded_by_id) WHERE superseded_by_id IS NOT NULL;

-- 3. ai_briefings ------------------------------------------------------------

CREATE TABLE app.ai_briefings (
  id                     uuid          PRIMARY KEY DEFAULT uuidv7(),
  user_id                uuid          NOT NULL,
  field_id               uuid          NOT NULL,
  suitability_run_id     uuid          NOT NULL,
  -- User-facing generated content, regenerated rather than edited. No suitability
  -- field of its own: AI is not a decision source (tables-derived.md §3 notes).
  body                   jsonb         NOT NULL,
  narration_status       text          NOT NULL DEFAULT 'generated',
  model_id               text          NOT NULL,
  prompt_version         text          NOT NULL,
  derivation_version     text          NOT NULL,
  input_refs             jsonb         NOT NULL,
  -- The snapshot body lives on the run this briefing explains.
  field_snapshot_hash    text          NOT NULL,
  source_artifact_hashes text[]        NOT NULL,
  input_snapshot_hash    text          NOT NULL,
  computed_at            timestamptz(6) NOT NULL DEFAULT now(),
  -- A model call is not replayable by construction; defaulting to true would be a
  -- false claim (provenance-storage.md §7).
  reproducible           boolean       NOT NULL DEFAULT false,
  unreproducible_reason  text,
  status                 text          NOT NULL DEFAULT 'active',
  superseded_by_id       uuid,
  created_at             timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT ai_briefings_field_owner_fkey FOREIGN KEY (field_id, user_id)
    REFERENCES app.fields (id, user_id),
  CONSTRAINT ai_briefings_run_owner_fkey FOREIGN KEY (suitability_run_id, user_id)
    REFERENCES app.suitability_runs (id, user_id),
  CONSTRAINT ai_briefings_superseded_fkey FOREIGN KEY (superseded_by_id)
    REFERENCES app.ai_briefings (id),
  CONSTRAINT ai_briefings_narration_check
    CHECK (narration_status IN ('generated', 'unavailable')),
  CONSTRAINT ai_briefings_body_check CHECK (jsonb_typeof(body) = 'object'),
  -- A briefing that summarised nothing is the fabricated-summary case.
  CONSTRAINT ai_briefings_sources_check
    CHECK (cardinality(source_artifact_hashes) > 0),
  CONSTRAINT ai_briefings_hash_check
    CHECK (field_snapshot_hash ~ '^[0-9a-f]{64}$'
       AND input_snapshot_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ai_briefings_reproducible_check
    CHECK (reproducible OR unreproducible_reason IS NOT NULL),
  CONSTRAINT ai_briefings_status_check
    CHECK (status IN ('active', 'superseded', 'failed')),
  CONSTRAINT ai_briefings_superseded_state_check
    CHECK ((status = 'superseded') = (superseded_by_id IS NOT NULL))
);

-- Q11: briefing cached per input hash; a changed input makes the row unreachable
-- rather than wrong.
CREATE UNIQUE INDEX ai_briefings_cache_key
  ON app.ai_briefings (field_id, input_snapshot_hash) WHERE status = 'active';
CREATE INDEX ai_briefings_field_idx ON app.ai_briefings (field_id, computed_at DESC);
CREATE INDEX ai_briefings_run_idx ON app.ai_briefings (suitability_run_id);

-- Row isolation -------------------------------------------------------------
--
-- Same three statements as the existing tenant tables: FORCE, because
-- migration_owner owns these tables and would otherwise bypass them; FOR ALL
-- with both USING and WITH CHECK, because a USING-only policy lets a tenant
-- UPDATE a row into another tenant's ownership. All three tables are owned via
-- user_id — including suitability_runs, whose user_id is denormalised from
-- fields but is the row's own column (ownership-and-rls.md §3).

ALTER TABLE app.suitability_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.suitability_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY suitability_runs_tenant_isolation ON app.suitability_runs
  FOR ALL TO app_api
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
CREATE POLICY suitability_runs_owner_full_access ON app.suitability_runs
  FOR ALL TO migration_owner USING (true) WITH CHECK (true);

ALTER TABLE app.planting_windows ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.planting_windows FORCE ROW LEVEL SECURITY;
CREATE POLICY planting_windows_tenant_isolation ON app.planting_windows
  FOR ALL TO app_api
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
CREATE POLICY planting_windows_owner_full_access ON app.planting_windows
  FOR ALL TO migration_owner USING (true) WITH CHECK (true);

ALTER TABLE app.ai_briefings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ai_briefings FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_briefings_tenant_isolation ON app.ai_briefings
  FOR ALL TO app_api
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
CREATE POLICY ai_briefings_owner_full_access ON app.ai_briefings
  FOR ALL TO migration_owner USING (true) WITH CHECK (true);

-- Runtime privileges --------------------------------------------------------
--
-- Explicit, per table, per operation. app_system is granted nothing: it holds no
-- privilege on any tenant-owned table, and a sweep that needs one gets a named
-- grant in the migration that adds the sweep (ownership-and-rls.md §2 rule 2).

GRANT SELECT, INSERT, UPDATE, DELETE ON app.suitability_runs TO app_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.planting_windows TO app_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.ai_briefings TO app_api;
