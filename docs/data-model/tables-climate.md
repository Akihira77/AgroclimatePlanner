# Tables — Weather and Climate Data Plane

Eight global tables. No `user_id`, no RLS, no tenant dimension: a forecast for a grid
cell is the same forecast for every tenant. That is why `app_api` may read the seven
climate tables directly while `app_system` owns the writes — and, for the eighth
(`app.jobs`, §7), `app_api` holds nothing at all.

They are also the tables where "global" is a claim that must stay true. A row in
`weather_records` that names a field would make provider data tenant-owned and
break the privilege model — so no column here references a tenant.

---

## 1. `app.outlook_cells`

| | |
|---|---|
| Entity | `OutlookCell` — one cell of one provider grid |
| Class | global |
| Purpose | the identity of a provider's grid node, and the coordinate it actually serves |
| Lifecycle | created on first reference; `served_lat`/`served_lon` filled by the first successful ingest; never deleted |
| Exists | yes (Phase 3, `20261118030000_domain_tables`) |

| Column | Type | Null | Default | Meaning |
|---|---|---|---|---|
| `id` | `uuid` | no | `uuidv7()` | PK |
| `provider` | `text` | no | — | `CHECK (IN ('bmkg','open-meteo','ecmwf'))` |
| `model` | `text` | no | — | `ecmwf_ifs025`, `ecmwf_ec46`, `ecmwf_seas5`, `bmkg_cuaca`, … — provider's own name, no local aliasing |
| `cell_key` | `text` | no | — | the documented rounding key for this grid, e.g. `-6.25,106.75`; format is per model |
| `served_lat` | `double precision` | yes | — | coordinate the provider reported for this cell (`CHECK (BETWEEN -90 AND 90)`); `NULL` until first ingest |
| `served_lon` | `double precision` | yes | — | same (`CHECK (BETWEEN -180 AND 180)`) |
| `elevation_m` | `double precision` | yes | — | grid elevation as published by the provider; `NULL` if not published |
| `spatial_resolution_km` | `double precision` | yes | — | 36 for EC46/SEAS5, ≈28 for ERA5, ≈5.5 for CHIRPS, …; `NULL` if not established |
| `created_at` | `timestamptz(6)` | no | `now()` | — |
| `served_updated_at` | `timestamptz(6)` | yes | — | set whenever the served coordinate is written |

Constraints:

| Name | Definition | Invalid state prevented |
|---|---|---|
| `outlook_cells_pkey` | `PRIMARY KEY (id)` | — |
| `outlook_cells_grid_key` | `UNIQUE (provider, model, cell_key)` | two identities for one grid node — every downstream join would then miss half the data |
| `outlook_cells_provider_check` | `provider IN ('bmkg','open-meteo','ecmwf')` | a provider string no adapter matches |
| `outlook_cells_coordinates_check` | `(served_lat IS NULL) = (served_lon IS NULL)` | half a coordinate |

Indexes: `outlook_cells_grid_key` covers every lookup (by grid triple).

Notes:

- `cell_key` is `text` because the grid rule is per model and unchanged from what
  the resolver computes. Storing it as a tuple of integers would freeze one rule
  for grids that do not share it. The generic resolver is implemented and tested
  (2026-11-21) and writes `"<lat>,<lon>"` with enough decimal places to preserve
  both the origin and the step; the provider grid configuration for each model is
  still `OPEN` (no model has a published grid origin, spacing, and axis).
- `served_lat`/`served_lon` are *the last value observed for this cell*. The
  authoritative per-record coordinate is on `weather_records`
  (`requested_lat`/`requested_lon`, `served_lat`/`served_lon`), which is why a
  disagreement between the two is not a data-loss event: the cell column exists to
  compute `field_outlook_cells.distance_km` without a network call.
- `app_api` may `INSERT` identity rows (provider, model, cell_key) and nothing
  else; only `app_system` fills the served coordinate (`D14`). The column-grant
  shape for that is specified in `ownership-and-rls.md` §4.

---

## 2. `app.forecast_runs`

| | |
|---|---|
| Entity | `ForecastRun` (`provenance-contract.md` §3) — the identity of a model output |
| Class | global |
| Purpose | "which model output" — the thing a user-facing "initialized 5 November" refers to |
| Lifecycle | upserted by natural key; never deleted, never mutated except by a corrective migration |
| Exists | yes (Phase 3, `20261118030000_domain_tables`) |

| Column | Type | Null | Default | Meaning |
|---|---|---|---|---|
| `id` | `uuid` | no | `uuidv7()` | PK; the value carried in every `forecastRunIds` array |
| `provider` | `text` | no | — | `bmkg` \| `open-meteo` \| `ecmwf` |
| `model` | `text` | no | — | provider model identifier |
| `model_version` | `text` | yes | — | only where the provider publishes one that can change mid-run; otherwise descriptive metadata, not identity |
| `product` | `text` | no | — | `CHECK (IN ('forecast','ensemble','seasonal','archive'))` |
| `initialized_at` | `timestamptz(6)` | no | — | provider initialization time, UTC |
| `horizon_end` | `timestamptz(6)` | no | — | last valid instant this run covers |
| `received_at` | `timestamptz(6)` | no | — | when we first had it |
| `created_at` | `timestamptz(6)` | no | `now()` | — |

Constraints:

| Name | Definition | Invalid state prevented |
|---|---|---|
| `forecast_runs_pkey` | `PRIMARY KEY (id)` | — |
| `forecast_runs_natural_key` | `UNIQUE (provider, model, product, initialized_at)` | fetching the same run twice creating a second identity, which would invalidate every derived artifact |
| `forecast_runs_product_check` | `product IN ('forecast','ensemble','seasonal','archive')` | a product string no queue maps to |
| `forecast_runs_horizon_check` | `horizon_end > initialized_at` | a run that ends before it starts |

Indexes: `forecast_runs_natural_key` (unique) is the upsert target;
`forecast_runs_recent_idx` on `(provider, model, initialized_at DESC)` — "the
current run for this model", used by the read path and by stale detection.

Notes:

- **`model_version` is intentionally outside the natural key.** `provenance-contract.md`
  §3 states it participates in identity only where the provider publishes one that
  changes mid-run. No such provider is integrated in v1, so including it would mint
  a new identity whenever a provider relabelled the same output.
- The natural key is a `UNIQUE` constraint and nothing else — it is never used as an
  id, never concatenated into a string, and never appears in a URL.
- `product = 'archive'` exists for the ERA5 fetch window. Archive rows are not
  forecast runs in the semantic sense, but a `weather_records` row must have a run
  identity, and `products` is where the difference belongs. See §4 for why no
  reanalysis row is stored in Phase 3 at all.

---

## 3. `app.ingestion_runs`

| | |
|---|---|
| Entity | `IngestionRun` (`provenance-contract.md` §3) — one *logical* ingest of one run |
| Class | global |
| Purpose | "which normalization produced the numbers actually shown" |
| Lifecycle | one row per `(forecast_run_id, ingestion_version)`; `attempt` increments in place; never deleted |
| Exists | yes (Phase 3, `20261118030000_domain_tables`) |

| Column | Type | Null | Default | Meaning |
|---|---|---|---|---|
| `id` | `uuid` | no | `uuidv7()` | PK |
| `forecast_run_id` | `uuid` | no | — | FK → `forecast_runs.id` |
| `adapter_version` | `text` | no | — | weather-core adapter semver |
| `normalizer_version` | `text` | no | — | weather-core normalizer semver |
| `target_selector_hash` | `text` | no | — | `^[0-9a-f]{64}$`; hash of the cells/variables requested |
| `ingestion_version` | `text` | no | — | `sha256(adapter_version, normalizer_version, target_selector_hash)`; `^[0-9a-f]{64}$` |
| `status` | `text` | no | `'queued'` | `CHECK (IN ('queued','running','partial','succeeded','failed'))` |
| `attempt` | `integer` | no | `1` | physical retry counter; `CHECK (>= 1)`; **not** part of identity |
| `started_at` | `timestamptz(6)` | no | `now()` | — |
| `finished_at` | `timestamptz(6)` | yes | — | set on terminal status |
| `record_count` | `integer` | no | `0` | `CHECK (>= 0)`; rows accepted |
| `coverage_percent` | `double precision` | no | `0` | `CHECK (BETWEEN 0 AND 100)`; fewer rows than the horizon is `partial`, never extrapolated |
| `error` | `jsonb` | yes | — | `{code, message, payloadRef?}`; `CHECK (jsonb_typeof(error) = 'object')` |
| `raw_payload_ref` | `text` | yes | — | object-store key when retention is permitted (`D12`) |
| `created_at` | `timestamptz(6)` | no | `now()` | — |

Constraints:

| Name | Definition | Invalid state prevented |
|---|---|---|
| `ingestion_runs_pkey` | `PRIMARY KEY (id)` | — |
| `ingestion_runs_run_fkey` | `FOREIGN KEY (forecast_run_id) REFERENCES app.forecast_runs (id)` | an ingest of nothing |
| `ingestion_runs_identity_key` | `UNIQUE (forecast_run_id, ingestion_version)` | a retry minting a new row — the exact defect `provenance-contract.md` §3 forbids |
| `ingestion_runs_status_check` | `status IN ('queued','running','partial','succeeded','failed')` | a status the API cannot render |
| `ingestion_runs_attempt_check` | `attempt >= 1` | an attempt count that cannot be counted |
| `ingestion_runs_coverage_check` | `coverage_percent BETWEEN 0 AND 100` | a coverage figure that would make `below_coverage_threshold` meaningless |
| `ingestion_runs_finished_check` | `(status IN ('succeeded','failed','partial')) = (finished_at IS NOT NULL)` | a finished run with no finish time |
| `ingestion_runs_hash_check` | `ingestion_version ~ '^[0-9a-f]{64}$' AND target_selector_hash ~ '^[0-9a-f]{64}$'` | a version that is not the hash it claims to be |

Indexes:

| Name | Definition | Query |
|---|---|---|
| `ingestion_runs_identity_key` | `UNIQUE (forecast_run_id, ingestion_version)` | upsert target on reprocess |
| `ingestion_runs_run_idx` | `(forecast_run_id, started_at DESC)` | "what did we run for this forecast" |
| `ingestion_runs_running_idx` | `(status) WHERE status IN ('queued','running')` | dead-letter and stuck-job detection for `maintenance` |

Notes:

- `attempt` is updated **in place** on the row: a retry is the same logical
  ingest. The unique key deliberately excludes it.
- Re-normalising stored payloads bumps `normalizer_version`, which changes
  `ingestion_version` and therefore creates a new row under the **same**
  `forecast_run_id`. A normalization fix must never surface as a new forecast.
- No `dataset_version` column. Phase 3 ingests forecast products only; a
  dataset-shaped ingest (CHIRPS, ERA5 daily, IMERG) becomes necessary only when
  verification truth exists, which is `OPEN-12`. Adding the column now would create
  a nullable identity component with no consumer.

---

## 4. `app.weather_records`

| | |
|---|---|
| Entity | `WeatherRecord` (`domain-model.md` §4) |
| Class | global |
| Purpose | one normalized value: one variable, one validity time, one grid cell, one run |
| Lifecycle | upserted per supersession key; a normalizer change supersedes rows; **never deleted** |
| Exists | yes (Phase 3, `20261118030000_domain_tables`) |

| Column | Type | Null | Default | Meaning |
|---|---|---|---|---|
| `id` | `uuid` | no | `uuidv7()` | PK |
| `forecast_run_id` | `uuid` | no | — | FK → `forecast_runs.id` |
| `ingestion_run_id` | `uuid` | no | — | FK → `ingestion_runs.id`; which normalization produced this value |
| `outlook_cell_id` | `uuid` | no | — | FK → `outlook_cells.id` |
| `cell_key` | `text` | no | — | denormalised from the cell so the uniqueness key and the record are self-describing |
| `provider` | `text` | no | — | denormalised; a record carries what the user is shown |
| `model` | `text` | no | — | denormalised |
| `data_class` | `text` | no | — | `WeatherDataClass`; **restricted to the four forecast classes** — see below |
| `variable` | `text` | no | — | `precipitation` \| `temperature_2m` \| `wind_speed_10m` \| … |
| `value` | `double precision` | yes | — | `NULL` only when the provider published a null for this instant; never interpolated |
| `unit` | `text` | no | — | `mm`, `°C`, `m/s`; stored as normalized, per `data-flow.md` §1 |
| `valid_at` | `timestamptz(6)` | no | — | the instant this value describes |
| `initialized_at` | `timestamptz(6)` | no | — | copied from the run, denormalised for range scans |
| `ingested_at` | `timestamptz(6)` | no | `now()` | — |
| `requested_lat` | `double precision` | no | — | the coordinate we asked for |
| `requested_lon` | `double precision` | no | — | — |
| `served_lat` | `double precision` | yes | — | the coordinate the provider answered for |
| `served_lon` | `double precision` | yes | — | — |
| `served_value_is_interpolated` | `boolean` | no | — | `true` when the provider interpolated; **must be shown**, because a served point is not a cell centre |
| `spatial_resolution_km` | `double precision` | yes | — | grid spacing for this model |
| `temporal_resolution` | `text` | yes | — | `hourly` \| `three_hourly` \| `daily` \| `monthly` — `OPEN-14` |
| `ensemble_member` | `integer` | yes | — | `NULL` for a deterministic product; `CHECK (>= 0)` |
| `ensemble_size` | `integer` | yes | — | `CHECK (>= 1)` |
| `bias_corrected` | `boolean` | no | `false` | v1 never corrects; a `true` value would be an unimplemented claim |
| `aggregation_level` | `text` | yes | — | `instant` \| `daily_sum` \| `daily_mean` \| `monthly_sum` \| `monthly_mean` — `OPEN-14` |
| `source_url` | `text` | yes | — | exact request URL, for attribution and debugging |
| `attribution` | `text` | yes | — | required attribution string (`data-licensing-and-attribution.md`) |
| `normalizer_version` | `text` | no | — | the transformation that produced the row: the ingest's normalizer by default, or a row-level derived step (e.g. `monthly-member-aggregation@1.0.0` for a SEAS5 member total). Provenance only — not part of the live key or the supersession match |
| `supersedes_id` | `uuid` | yes | — | the row this one replaced |
| `superseded_by_id` | `uuid` | yes | — | set when a later normalization replaced this row |
| `superseded_at` | `timestamptz(6)` | yes | — | `NULL` = live |
| `created_at` | `timestamptz(6)` | no | `now()` | — |

Constraints:

| Name | Definition | Invalid state prevented |
|---|---|---|
| `weather_records_pkey` | `PRIMARY KEY (id)` | — |
| `weather_records_run_fkey` | `FOREIGN KEY (forecast_run_id) REFERENCES app.forecast_runs (id)` | an orphan value |
| `weather_records_ingestion_fkey` | `FOREIGN KEY (ingestion_run_id) REFERENCES app.ingestion_runs (id)` | a value with no normalization provenance |
| `weather_records_cell_fkey` | `FOREIGN KEY (outlook_cell_id) REFERENCES app.outlook_cells (id)` | a value for no cell |
| `weather_records_supersedes_fkey` | `FOREIGN KEY (supersedes_id) REFERENCES app.weather_records (id)` | a dangling supersession chain |
| `weather_records_superseded_by_fkey` | `FOREIGN KEY (superseded_by_id) REFERENCES app.weather_records (id)` | same |
| `weather_records_data_class_check` | `data_class IN ('weather_forecast','subseasonal_forecast','seasonal_forecast','annual_outlook')` | see the note below — the table refuses the four classes it does not Own |
| `weather_records_bias_check` | `bias_corrected = false` | a bias-correction claim no code implements |
| `weather_records_supersession_check` | `(superseded_by_id IS NULL) = (superseded_at IS NULL)` | a half-superseded row |
| `weather_records_ensemble_check` | `(ensemble_member IS NULL) OR (ensemble_size IS NOT NULL AND ensemble_member < ensemble_size)` | a member index outside its own ensemble |
| `weather_records_coordinates_check` | `(served_lat IS NULL) = (served_lon IS NULL)` | half a coordinate |
| `weather_records_unit_check` | `btrim(unit) <> ''` | a value with no unit |

Indexes:

| Name | Definition | Query |
|---|---|---|
| `weather_records_live_key` | `UNIQUE NULLS NOT DISTINCT (forecast_run_id, cell_key, variable, valid_at, ensemble_member) WHERE superseded_at IS NULL` | the upsert target; `NULLS NOT DISTINCT` so two deterministic rows for one instant collide instead of both surviving |
| `weather_records_series_idx` | `(cell_key, variable, valid_at) WHERE superseded_at IS NULL` | build a daily/weekly series for one cell — the aggregation input |
| `weather_records_run_idx` | `(forecast_run_id) WHERE superseded_at IS NULL` | "what did this run produce", coverage accounting |
| `weather_records_ingestion_idx` | `(ingestion_run_id)` | supersede-all-rows-of-an-ingest on reprocess |

Notes:

- **`NULLS NOT DISTINCT` is load-bearing.** PostgreSQL treats `NULL` as distinct in
  a unique index, so `ensemble_member = NULL` rows would never collide and every
  re-ingest of a deterministic product would append a duplicate. The observed
  Phase 1 behaviour — 35 ensemble rows returning nulls after day 14 — is the same
  family of problem seen from the other side.
- **Only the four forecast classes are stored here** (`D24`). `reanalysis`,
  `satellite_estimate`, `station_observation`, `field_observation`, and
  `climatology` are refused by the `CHECK`, because each has a different home:
  observations live in `field_observations`, climatology in `climatology_normals`,
  and verification truth has no table yet (`OPEN-12`). This makes "climatology
  never masquerades as a forecast" a schema property rather than a rule someone
  remembers.
- `value` is nullable because a provider publishing `null` for a day past its
  ensemble horizon is real information: the horizon ends there. A stored `NULL`
  with `coverage_percent < 100` on the ingestion is `beyond_horizon` evidence;
  an *absent row* is not, and the difference matters (`data-flow.md` §8).
- Nothing here is ever deleted. Supersession is the only mutation, so a historical
  `recordSetHash` stays explainable. Growth is addressed in
  `lifecycle-and-retention.md` §4 and `OPEN-16`.
- No `user_id` and no RLS: this table is provider data. `app_api` gets `SELECT`
  only.

---

## 5. `app.monthly_outlooks`

| | |
|---|---|
| Entity | `MonthlyOutlook` (`domain-model.md` §4) — the materialised read model |
| Class | global, keyed by cell — **not** tenant-owned (`D2`) |
| Purpose | one month of one variable for one cell, resolved to a single `dataClass`, with its anomaly and provenance |
| Lifecycle | recomputed per cell; superseded by status change; never deleted; a `failed` attempt leaves the previous `active` row untouched |
| Exists | yes (Phase 3, `20261118030000_domain_tables`) |

| Column | Type | Null | Default | Meaning |
|---|---|---|---|---|
| `id` | `uuid` | no | `uuidv7()` | PK |
| `outlook_cell_id` | `uuid` | no | — | FK → `outlook_cells.id` |
| `variable` | `text` | no | — | `CHECK (variable = 'precipitation')` — the only assembled variable in v1 |
| `month` | `date` | no | — | first day of the month, `CHECK (EXTRACT(DAY FROM month) = 1)`; Asia/Jakarta calendar |
| `data_class` | `text` | yes | — | `WeatherDataClass`; `NULL` only for a month with no value |
| `evaluation_basis` | `text` | no | — | `CHECK (IN ('monthly','climatology'))` |
| `value_mm` | `double precision` | yes | — | estimated precipitation **accumulation for one calendar month, in mm** (`Q-P5-7`, resolved 2026-11-24). The estimator follows from `data_class`: `seasonal_forecast` → `ensemble_mean` (mean of the 50 members' monthly totals), `climatology` → `climatological_mean` (mean of the baseline years' monthly totals). Neither is a realised total, and no daily aggregate mean is ever stored as one. `CHECK (>= 0)`; `NULL` when nothing may be claimed |
| `missing_reason` | `text` | yes | — | `MissingReason`; see the state table below |
| `anomaly_kind` | `text` | yes | — | `CHECK (IN ('model_anomaly','baseline_difference'))` |
| `anomaly_mm` | `double precision` | yes | — | primary anomaly, mm (ADR-001 D3) |
| `anomaly_percent` | `double precision` | yes | — | same anomaly as a percentage of the comparison base |
| `baseline_version` | `text` | yes | — | e.g. `ERA5:1991-2020:v1`; required when a baseline was used at all |
| `model_climate_offset_mm` | `double precision` | yes | — | disclosed offset, **only** for `baseline_difference` |
| `data_coverage_percent` | `double precision` | yes | — | `CHECK (BETWEEN 0 AND 100)`; share of days with a genuine value. **`NULL` in 5.0** — a month comes from a provider monthly quantity, not from assembled days (`Q-P5-6`) |
| `ensemble_spread_mm` | `double precision` | yes | — | `CHECK (>= 0)`; `NULL` when unavailable |
| `spread_unavailable_reason` | `text` | yes | — | required when spread is `NULL` and members were expected |
| `derivation_version` | `text` | no | — | assembly rule-set version |
| `input_refs` | `jsonb` | no | — | `DataInputRef[]`; `CHECK (jsonb_typeof(input_refs) = 'array')` |
| `input_snapshot_hash` | `text` | no | — | `^[0-9a-f]{64}$`; over the `monthly_outlook` descriptor variant |
| `computed_at` | `timestamptz(6)` | no | `now()` | — |
| `status` | `text` | no | `'active'` | `CHECK (IN ('active','superseded','failed'))` |
| `superseded_by_id` | `uuid` | yes | — | FK → self |
| `created_at` | `timestamptz(6)` | no | `now()` | — |

### The month state table, as constraints

`provenance-contract.md` §6 says a `beyond_horizon` month and an `ingest_failed`
month are different rows with different reasons. Encoded:

| State | `value_mm` | `data_class` | `missing_reason` |
|---|---|---|---|
| a real forecast value | set | `seasonal_forecast` / `subseasonal_forecast` / `weather_forecast` | `NULL` |
| horizon genuinely ends | set (the climatology value) | `climatology` | `beyond_horizon` |
| a climatology month with no forecast axis at all | set | `climatology` | `beyond_horizon` |
| ingest pending | `NULL` | `NULL` | `pending` |
| ingest failed / provider down | `NULL` | `NULL` | `ingest_failed` / `provider_unavailable` |
| cell not in scope | `NULL` | `NULL` | `not_requested` |
| baseline missing | `NULL` | `NULL` | `insufficient_history` |
| coverage too low to claim a month | `NULL` | `NULL` | `below_coverage_threshold` |

Constraints:

| Name | Definition | Invalid state prevented |
|---|---|---|
| `monthly_outlooks_pkey` | `PRIMARY KEY (id)` | — |
| `monthly_outlooks_cell_fkey` | `FOREIGN KEY (outlook_cell_id) REFERENCES app.outlook_cells (id)` | an outlook for no cell |
| `monthly_outlooks_superseded_fkey` | `FOREIGN KEY (superseded_by_id) REFERENCES app.monthly_outlooks (id)` | a broken audit chain |
| `monthly_outlooks_month_check` | `EXTRACT(DAY FROM month) = 1` | a month key that is not a month |
| `monthly_outlooks_variable_check` | `variable = 'precipitation'` | an assembled variable with no approved assembly |
| `monthly_outlooks_missing_reason_check` | `missing_reason IS NULL OR missing_reason IN (…)` — the `MissingReason` enum | a reason the API cannot map to a rendering |
| `monthly_outlooks_value_state_check` | the table above: value present ⟺ `data_class` present; `missing_reason` in the five no-value cases ⟹ `value_mm IS NULL AND data_class IS NULL` | a month that renders a value and claims it has none |
| `monthly_outlooks_beyond_horizon_check` | `missing_reason <> 'beyond_horizon' OR data_class = 'climatology'` | climatology substituted for a failure — the single most important constraint in this table |
| `monthly_outlooks_climatology_check` | `data_class <> 'climatology' OR (baseline_version IS NOT NULL AND anomaly_kind IS NULL)` | a climatology month carrying an initialization-derived anomaly, or no baseline |
| `monthly_outlooks_anomaly_check` | `anomaly_kind = 'baseline_difference' → (baseline_version IS NOT NULL AND model_climate_offset_mm IS NOT NULL)`; `anomaly_kind = 'model_anomaly' → model_climate_offset_mm IS NULL` | a baseline difference with an undisclosed offset — ADR-001 D3 |
| `monthly_outlooks_spread_check` | `(ensemble_spread_mm IS NULL) = (spread_unavailable_reason IS NOT NULL)` | a silent missing spread |
| `monthly_outlooks_hash_check` | `input_snapshot_hash ~ '^[0-9a-f]{64}$'` | — |
| `monthly_outlooks_status_check` | `status IN ('active','superseded','failed')` | — |
| `monthly_outlooks_superseded_state_check` | `(status = 'superseded') = (superseded_by_id IS NOT NULL)` | a superseded row with no successor, or a successor on a live row |

Indexes:

| Name | Definition | Query |
|---|---|---|
| `monthly_outlooks_active_key` | `UNIQUE (outlook_cell_id, variable, month) WHERE status = 'active'` | one live answer per cell-month |
| `monthly_outlooks_cell_month_idx` | `(outlook_cell_id, month)` | render a 12-month outlook for a cell |
| `monthly_outlooks_superseded_idx` | `(superseded_by_id) WHERE superseded_by_id IS NOT NULL` | trace a recompute chain |

Notes:

- **`data_class = 'climatology'` is allowed here but not in `weather_records`.**
  That asymmetry is intentional: an outlook month is a *presentation* decision
  about which class answered that month, and climatology is a legitimate answer,
  labelled as itself. A climatology number in the record table would be a
  fabricated forecast.
- `missing_reason` describes the **forecast axis**. A `beyond_horizon` month
  carries a real climatology value *and* that reason, which is exactly the two-axis
  report in `provenance-contract.md` §6.
- No `data_availability` column: availability is computed at read time
  (`temporal-and-weather-semantics.md` §5). Storing it would let a stale value
  persist as `available`.
- **`value_mm` is a monthly accumulation estimated by a named rule, not a provider
  column copied across.** `Q-P5-7` settled the quantity on 2026-11-24: mm per
  calendar month, with the estimator determined by `data_class` through
  `estimatorForDataClass` in `packages/contracts/src/climate.ts`. There is
  deliberately no `estimator` column — the mapping is total over the classes v1 can
  write, and a stored copy could only drift from the contract. A second estimator
  for one class would be the change that needs the column. `precipitation_mean`
  keeps its own name in `weather_records`; it is the provider's cross-check, never
  the stored outlook value.
- Not tenant-owned. Nothing here names a field: the field→month join is
  `field_outlook_cells` + `monthly_outlooks`, resolved at read time, so a new run
  does not need to touch any tenant row.

### 5.1 The climatology write path (Phase 5.7A)

The first writer of this table is `packages/database/src/outlook.ts`
(`persistClimatologyOutlook`, called by the `aggregate` worker handler). Four rules
shape which rows exist:

| Rule | Consequence |
|---|---|
| A row needs real provenance | `input_refs` is `NOT NULL`, array-shaped, and the contract requires **≥ 1** ref. A month with no input has no honest ref, so it has **no row** |
| Only climatology months are materialised | Lead months 8–12. Lead 1–7 exist as no-value entries in the assembled horizon (`packages/climate-core/src/aggregate.ts`) and are synthesised by the read path, not stored |
| A missing normal is a horizon gap, not a row | A cell-baseline with no normal for that calendar month emits `insufficient_history` in the in-memory horizon. No `pending` / `not_requested` row is written to stand for it |
| The baseline is an explicit input | `baselineVersion` comes from the job payload. No `latest` query exists, and an unknown version is a terminal `baseline_unknown`, never a silent fallback (`Q-P5-8`) |

Write order, forced by this table's own constraints:

1. `monthly_outlooks_active_key` forbids inserting a new active row while the old
   one is active.
2. `monthly_outlooks_superseded_fkey` forbids retiring the old row before its
   successor exists.
3. So the new row is inserted as `status = 'failed'` (a status that needs no
   successor and no `superseded_by_id`), the old active row is set to
   `superseded` pointing at it, then the new row is promoted to `active`. All of
   it is one transaction, so no intermediate state is ever visible.

Lock order is global, not per cell. The complete footprint set of a job is
acquired in **one** `lockForecastFootprint` call, which sorts and de-duplicates
the keys; a per-cell call would make the order a property of the selector array,
and two jobs holding the same cells in opposite order would deadlock (`40P01`)
on the second key each. The job row is still locked first, and only then the
footprints.

Idempotency is by identity, not by timestamp: `(outlook_cell_id, variable, month)`
plus `derivation_version`, `input_snapshot_hash` and `baseline_version`. An
identical recompute writes nothing (`unchanged`); changed inputs or a changed
baseline produce a new derivation that supersedes the old one. A failed
recompute rolls the whole transaction back and leaves the previous active row
intact.

---

## 6. `app.climatology_normals`

| | |
|---|---|
| Entity | climatology baseline (`provenance-contract.md` §4, `kind: "baseline"`) |
| Class | global |
| Purpose | the 1991–2020 monthly normal for a cell, per baseline version |
| Lifecycle | built once per `(baseline_version)`; a rebuild is a **new version**, never an edit |
| Exists | yes (Phase 3, `20261118030000_domain_tables`) |

| Column | Type | Null | Default | Meaning |
|---|---|---|---|---|
| `id` | `uuid` | no | `uuidv7()` | PK |
| `baseline_version` | `text` | no | — | `ERA5:1991-2020:v1`, `CHIRPS:1991-2020:v1` — the string every artifact repeats |
| `baseline_dataset` | `text` | no | — | `era5` \| `chirps_v3` \| `nasa_power` |
| `period_from` | `date` | no | — | `1991-01-01` |
| `period_to` | `date` | no | — | `2020-12-31` |
| `outlook_cell_id` | `uuid` | no | — | FK → `outlook_cells.id` |
| `month` | `date` | no | — | first day of month, `CHECK (EXTRACT(DAY FROM month) = 1)` |
| `value_mm` | `double precision` | no | — | `CHECK (>= 0)`; the monthly normal |
| `sample_years` | `integer` | yes | — | how many years contributed; `CHECK (> 0)`; `NULL` when not recorded |
| `computed_at` | `timestamptz(6)` | no | `now()` | — |
| `created_at` | `timestamptz(6)` | no | `now()` | — |

Constraints:

| Name | Definition | Invalid state prevented |
|---|---|---|
| `climatology_normals_pkey` | `PRIMARY KEY (id)` | — |
| `climatology_normals_cell_fkey` | `FOREIGN KEY (outlook_cell_id) REFERENCES app.outlook_cells (id)` | an orphan normal |
| `climatology_normals_key` | `UNIQUE (baseline_version, outlook_cell_id, month)` | two normals for one month — which one would an anomaly use? |
| `climatology_normals_month_check` | `EXTRACT(DAY FROM month) = 1` | — |
| `climatology_normals_period_check` | `period_to > period_from` | an inverted baseline window |
| `climatology_normals_dataset_check` | `baseline_dataset IN ('era5','chirps_v3','nasa_power')` | a baseline from a dataset no builder produces |
| `climatology_normals_version_check` | `baseline_version = baseline_dataset || ':' || …` is **not** enforced | — see note |

Indexes: `climatology_normals_key` (unique) is the lookup;
`climatology_normals_cell_idx` on `(outlook_cell_id, month)` for a full-year read.

Notes:

- `baseline_version` is a free `text` that embeds the dataset and period by
  convention (`ERA5:1991-2020:v1`). It is **not** decomposed into columns or
  validated against `baseline_dataset`/`period_*`, because the string is what
  appears in every artifact's `input_refs` and in the API payload; a `CHECK`
  enforcing the format would break the moment a builder names a version differently
  and would have to be dropped in a migration. The columns exist so the string is
  auditable, not so it can be reconstructed.
- `baseline_hash` is **not** a column. It is `sha256(canonicalJson(…))` over the
  stored normals for the exact `cellKeys` a derivation consumed
  (`provenance-contract.md` §4), so it depends on the *subset* used, not on the
  table. Storing one hash per row would be a hash of the wrong thing.
- A rebuild with a different dataset is a new `baseline_version`. Editing rows in
  place would silently change every stored anomaly that referenced the old one
  while still claiming the same version string — the reproducibility failure
  `provenance-contract.md` §4 rule 3 exists to prevent.
- The writer (`packages/database/src/climatology.ts`) is **insert-only**: an
  identical rebuild inserts nothing and verifies the stored value and
  `sample_years` match, while a different value under an existing version throws
  a conflict instead of overwriting. All cells and all 12 months are written in
  one transaction, so an 11-row baseline cannot be observed. The same call
  records the version's source row (§6.1) *before* the first normal; a conflict
  rolls both back together.
- Cache-key note from `ADR-001` D6: the monthly-init seasonal cache key omits a
  `day` component. `climatology_normals` follows the same idea — identity is
  `(baseline_version, cell, month)`, never a request timestamp.

---

## 6.1 `app.climatology_baselines`

| | |
|---|---|
| Entity | source metadata for one climatology baseline version |
| Class | global |
| Purpose | the durable route, attribution and retrieval facts a normal row cannot carry |
| Lifecycle | one row per `baseline_version`; insert-only; a conflicting identity is refused, never updated |
| Exists | yes (Phase 5.5 corrective pass, `20261123010000_climatology_baselines`) |

| Column | Type | Null | Default | Meaning |
|---|---|---|---|---|
| `baseline_version` | `text` | no | — | PK; the same string `climatology_normals` repeats |
| `baseline_dataset` | `text` | no | — | `era5 \| chirps_v3 \| nasa_power` |
| `provider` | `text` | no | — | source provider (`open-meteo`), not the local adapter name |
| `model` | `text` | no | — | provider model (`era5`) |
| `adapter_version` | `text` | no | — | adapter release that produced the payload; audit only |
| `source_reference` | `text` | no | — | deterministic, coordinate-free route and pinned parameters (`https://…`) |
| `attribution` | `text` | no | — | licence/attribution string, stored verbatim |
| `retrieved_at` | `timestamptz(6)` | no | — | when the provider response for the version was received |
| `period_from` | `date` | no | — | baseline window start |
| `period_to` | `date` | no | — | baseline window end |
| `algorithm_version` | `text` | no | — | the `v1` token embedded in `baseline_version` |
| `computed_at` | `timestamptz(6)` | no | — | when the build ran |
| `created_at` | `timestamptz(6)` | no | `now()` | — |

Constraints:

| Name | Definition | Invalid state prevented |
|---|---|---|
| `climatology_baselines_pkey` | `PRIMARY KEY (baseline_version)` | two source rows for one version |
| `climatology_baselines_dataset_check` | `baseline_dataset IN ('era5','chirps_v3','nasa_power')` | a dataset no builder produces |
| `climatology_baselines_period_check` | `period_to > period_from` | an inverted baseline window |
| `climatology_baselines_source_check` | `source_reference ~ '^https://'` | a plaintext or unverifiable route |
| `climatology_baselines_text_check` | version, provider, model, adapter, attribution and algorithm non-blank | a metadata row that explains nothing |

Privileges: `app_api` holds `SELECT`; `app_system` holds `SELECT, INSERT, UPDATE,
DELETE`. No RLS and no tenant column.

Notes:

- **Why a separate table.** The source identity is shared by every cell-month of a
  version. Repeating a URL and an attribution on 12 rows per cell would be
  duplication that can drift, and the correction was explicitly not to overload
  `climatology_normals`.
- **No foreign key** from `climatology_normals.baseline_version`: the string is a
  free-form identity across two tables, and existing rows have no metadata to
  back-fill. The writer inserts the metadata row first in the same transaction,
  so this code path cannot produce normals without their source row.
- **`adapter_version` and `attribution` are not identity.** A patch release or an
  attribution-year change that leaves the source route and the numbers unchanged
  is accepted on a repeat write and the first stored values are kept. Dataset,
  provider, model, `source_reference`, period and `algorithm_version` are identity;
  a disagreement throws `ClimatologySourceConflictError`, which is the version-bump
  rule in code.
- `source_reference` omits latitude, longitude and dates by design. The exact
  per-cell request URL and the served coordinate are provider facts; the
  coordinate-free reference is what one version can truthfully claim for a
  multi-cell build. Per-cell requested/served coordinates remain on
  `outlook_cells`.
- `retrieved_at` and `computed_at` describe the **first** successful build of the
  version. A later incremental or identical write does not move them; per-cell
  last-serving time is `outlook_cells.served_updated_at`.
- A future read API renders the attribution by joining this table on
  `baseline_version`, not from a hard-coded year string.

---

## 7. `app.jobs`

| | |
|---|---|
| Entity | the queue row (`background-processing.md` §2.1) |
| Class | global |
| Purpose | one unit of background work, identified by a deterministic idempotency key |
| Lifecycle | `queued → running → (queued \| succeeded \| dead)`; a dead row is kept, never deleted |
| Exists | yes (Phase 5.3, `20261122000000_jobs`) |

| Column | Type | Null | Default | Meaning |
|---|---|---|---|---|
| `id` | `uuid` | no | `uuidv7()` | PK |
| `kind` | `text` | no | — | one of the six queue names; `CHECK` pinned to the list |
| `idempotency_key` | `text` | no | — | `ingest:{queue}:{forecastRunId}:{ingestionVersion}` for ingestion jobs |
| `payload` | `jsonb` | no | `'{}'` | handler-owned; validated by the handler, not by a `CHECK` |
| `status` | `text` | no | `'queued'` | `queued \| running \| succeeded \| dead` — no `failed` |
| `attempt` | `integer` | no | `0` | successful claims; `0` = never claimed |
| `max_attempts` | `integer` | no | `5` | `CHECK (BETWEEN 1 AND 20)` |
| `run_at` | `timestamptz(6)` | no | `now()` | earliest claim time; retry pushes it forward |
| `lease_token` | `uuid` | yes | — | ownership token; set exactly while running |
| `lease_expires_at` | `timestamptz(6)` | yes | — | when the reaper may recover the row |
| `ingestion_run_id` | `uuid` | yes | — | the run this job executes; `NULL` until a handler begins |
| `last_error` | `jsonb` | yes | — | `{code, message, retryable}`; the last failure, not a history |
| `finished_at` | `timestamptz(6)` | yes | — | set exactly at `succeeded` or `dead` |
| `created_at` | `timestamptz(6)` | no | `now()` | — |
| `updated_at` | `timestamptz(6)` | no | `now()` | — |

Constraints:

| Name | Definition | Invalid state prevented |
|---|---|---|
| `jobs_pkey` | `PRIMARY KEY (id)` | — |
| `jobs_identity_key` | `UNIQUE (kind, idempotency_key)` | a duplicate enqueue minting a second job for one logical ingest |
| `jobs_ingestion_run_fkey` | `FOREIGN KEY (ingestion_run_id) REFERENCES app.ingestion_runs (id) ON DELETE RESTRICT` | deleting a run out from under the job that records it |
| `jobs_kind_check` | `kind IN (…six…)` | a kind no worker claims |
| `jobs_status_check` | `status IN ('queued','running','succeeded','dead')` | a `failed` row, which would be a second failure vocabulary |
| `jobs_attempt_check` | `attempt BETWEEN 0 AND max_attempts` | an attempt count past the budget |
| `jobs_max_attempts_check` | `max_attempts BETWEEN 1 AND 20` | a job that can never run, or one that hammers a provider |
| `jobs_lease_check` | `(status = 'running') = (lease_token IS NOT NULL)` | a half-written lease in either direction |
| `jobs_lease_expiry_check` | `lease_token IS NULL OR lease_expires_at IS NOT NULL` | a lease with no expiry, which the reaper can never recover |
| `jobs_finished_check` | `(status IN ('succeeded','dead')) = (finished_at IS NOT NULL)` | a terminal row without a finish time, or a running one with it |
| `jobs_error_check` | `last_error IS NULL OR jsonb_typeof(last_error) = 'object'` | a scalar error record |

Indexes: `jobs_claim_idx` on `(kind, run_at, id) WHERE status = 'queued'` (the claim
path); `jobs_lease_idx` on `(lease_expires_at) WHERE status = 'running'` (the reaper);
`jobs_created_idx` on `(kind, status, created_at)` (depth and oldest-waiting);
`jobs_ingestion_run_idx` on `(ingestion_run_id)` (required by the FK, and used by the
ownership lookup); `jobs_active_ingestion_idx`, unique partial on `(ingestion_run_id)
WHERE status = 'running' AND ingestion_run_id IS NOT NULL`, which makes two running
jobs owning one `IngestionRun` impossible to persist.

Notes:

- The six queues of `background-processing.md` §2 are `kind` values, not tables. A
  queue is a predicate, so the whole backlog is one query and a backing swap replaces
  one module (`apps/worker/src/queue/types.ts`).
- `attempt` counts claims, not failures: it rises exactly once per successful claim
  and never resets. `ingestion_runs.attempt` counts handler starts. They are two
  counters over one execution and are deliberately **not** synchronised — a claimed
  job whose handler never began has no run to count. Such a claim is released:
  requeued while a claim remains, `dead` at `max_attempts`, since the next claim
  would violate `jobs_attempt_check`. No `IngestionRun` is created in either case.
- `ingestion_run_id` is `NULL` at enqueue because the run row is created when a
  handler starts (`climate-data-foundation.md` §8.3). The FK is `RESTRICT`, not
  `SET NULL`: the reference is provenance, so deleting the run must fail loudly
  rather than silently leave a dead job unable to name what it executed.
- `app_system` holds `SELECT/INSERT/UPDATE/DELETE`; `app_api` holds no grant. Users
  read ingestion state from `app.ingestion_runs`, so a request-path grant here would
  widen the blast radius for no reader.
