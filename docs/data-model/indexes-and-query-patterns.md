# Indexes and Query Patterns

Every index in the model, justified by a named query. An index with no query is
either a liability to justify or a defect to drop.

Rule applied throughout: **the write path pays for every index, forever.** A
partial index is preferred when the query only ever touches live rows, because
soft-deleted and superseded rows accumulate and would otherwise bloat the index
without ever being read by the query that justifies it.

## 1. The queries

Named so the index table can cite them. `(T)` = tenant-scoped, always issued
inside `withTenant`.

| ID | Query | Frequency |
|---|---|---|
| Q1 (T) | list my live farms | every dashboard load |
| Q2 (T) | list my live fields, optionally for one farm | every dashboard load |
| Q3 (T) | open one field with its resolutions | every field page |
| Q4 (T) | recent observations for a field | field page, and the snapshot window |
| Q5 (T) | what is growing in this field | field page |
| Q6 (T) | harvest history for a planting | field page |
| Q7 (T) | active windows for a field, in date order | the primary dashboard answer |
| Q8 (T) | active windows overlapping a requested date range | date filter |
| Q9 (T) | current suitability run for a field | field page |
| Q10 (T) | "has this exact input set already been evaluated" | before every recompute |
| Q11 (T) | briefing for a field by input hash | `POST /v1/ai/briefing` cache hit |
| Q12 | daily series for one cell and variable | aggregation, engine input |
| Q13 | what a run produced | coverage accounting, verdict on an ingest |
| Q14 | the current run for a model | read path, stale detection |
| Q15 | 12 months of outlook for a cell | dashboard, outlook panel |
| Q16 | normals for a cell, one baseline | anomaly assembly |
| Q17 | normals for a cell, full year | baseline build and audit |
| Q18 | which fields does this cell serve | fan-out when a run lands — **see §5** |
| Q19 | stuck/queued ingests | maintenance |
| Q20 | re-ingest: find the rows an ingestion produced | supersede-on-reprocess |
| Q21 | version history for a variety | catalog admin |
| Q22 | a profile's rules by dimension | engine load |
| Q23 | a profile's stages in order | engine load |
| Q24 | credentials by email | login — **blocked, `OPEN-01`** |
| Q25 | check one cell identity exists | field creation |

## 2. Index inventory

### Identity and tenancy

| Index | Definition | Query | Note |
|---|---|---|---|
| `users_pkey` | `(id)` | every `withTenant` FK | |
| `users_email_key` | `UNIQUE (email)` | Q24 | the unique index is the lookup; blocked by grants, not by the index |
| `farms_pkey` | `(id)` | | |
| `farms_user_id_idx` | `(user_id) WHERE deleted_at IS NULL` | Q1 | partial: soft-deleted farms are never listed |
| `farms_id_user_id_key` | `UNIQUE (id, user_id)` | composite-FK target | not a query index; it is what makes `fields_farm_owner_fkey` possible |
| `fields_pkey` | `(id)` | | |
| `fields_id_user_id_key` | `UNIQUE (id, user_id)` | composite-FK target | same |
| `fields_user_id_idx` | `(user_id) WHERE deleted_at IS NULL` | Q2 (no farm filter) | |
| `fields_farm_id_idx` | `(farm_id) WHERE deleted_at IS NULL` | Q2 (farm filter) | a separate index because the farm filter is the common case and `(user_id, farm_id)` would not serve the no-filter case as well |
| `fields_geom_gist_idx` | `gist (geom)` | **none** | exists for a Phase 6 map viewport; `OPEN-22` |

### Field operations

| Index | Definition | Query |
|---|---|---|
| `field_outlook_cells_live_key` | `UNIQUE (field_id, provider, model) WHERE superseded_at IS NULL` | Q3, and the write-path upsert |
| `field_outlook_cells_cell_idx` | `(outlook_cell_id)` | Q18 |
| `field_outlook_cells_field_idx` | `(field_id)` | Q3 (all providers) |
| `field_observations_field_time_idx` | `(field_id, observed_at DESC)` | Q4 |
| `plantings_field_idx` | `(field_id, planted_at DESC)` | Q5 |
| `plantings_active_idx` | `(user_id, field_id) WHERE status = 'active'` | priority rule; **depends on `OPEN-09`** naming `active` |
| `plantings_id_user_id_key` | `UNIQUE (id, user_id)` | composite-FK target |
| `harvests_planting_idx` | `(planting_id, harvested_at DESC)` | Q6 |
| `harvests_user_time_idx` | `(user_id, harvested_at DESC)` | per-season totals |

### Catalog

| Index | Definition | Query |
|---|---|---|
| `crops_slug_key` | `UNIQUE (slug)` | URL resolution |
| `cultivars_crop_idx` | `(crop_id)` | "choose a variety" |
| `cultivars_crop_name_key` | `UNIQUE (crop_id, name)` | invariant |
| `crop_profile_versions_one_published_key` | `UNIQUE (cultivar_id) WHERE status = 'published'` | at most one live rulebook per variety |
| `crop_profile_versions_cultivar_idx` | `(cultivar_id, created_at DESC)` | Q21 |
| `crop_profile_versions_cultivar_rule_key` | `UNIQUE (cultivar_id, rule_version)` | invariant |
| `growth_stages_profile_idx` | `(profile_version_id, start_day_offset)` | Q23 |
| `growth_stages_one_critical_key` | `UNIQUE (profile_version_id) WHERE is_critical` | one critical stage; `primaryBasis` would otherwise be ambiguous |
| `constraints_profile_idx` | `(profile_version_id, dimension)` | Q22 |
| `source_refs_profile_idx` | `(profile_version_id)` | bibliography render |

### Weather plane

| Index | Definition | Query | Note |
|---|---|---|---|
| `outlook_cells_grid_key` | `UNIQUE (provider, model, cell_key)` | Q25, and every write-path upsert | the natural key; the only lookup that exists |
| `forecast_runs_natural_key` | `UNIQUE (provider, model, product, initialized_at)` | ingest upsert | |
| `forecast_runs_recent_idx` | `(provider, model, initialized_at DESC)` | Q14 | |
| `ingestion_runs_identity_key` | `UNIQUE (forecast_run_id, ingestion_version)` | reprocess upsert | |
| `ingestion_runs_run_idx` | `(forecast_run_id, started_at DESC)` | Q13 | |
| `ingestion_runs_running_idx` | `(status) WHERE status IN ('queued','running')` | Q19 | small partial index on a table that grows forever |
| `weather_records_live_key` | `UNIQUE NULLS NOT DISTINCT (forecast_run_id, cell_key, variable, valid_at, ensemble_member) WHERE superseded_at IS NULL` | ingest upsert | `NULLS NOT DISTINCT` is required, see §3 |
| `weather_records_series_idx` | `(cell_key, variable, valid_at) WHERE superseded_at IS NULL` | Q12 | the hot read |
| `weather_records_run_idx` | `(forecast_run_id) WHERE superseded_at IS NULL` | Q13 | |
| `weather_records_ingestion_idx` | `(ingestion_run_id)` | Q20 | **not** partial: a supersede operation must find rows already superseded |
| `monthly_outlooks_active_key` | `UNIQUE (outlook_cell_id, variable, month) WHERE status = 'active'` | one live answer per cell-month |
| `monthly_outlooks_cell_month_idx` | `(outlook_cell_id, month)` | Q15 | not partial — history is read for "what changed" |
| `monthly_outlooks_superseded_idx` | `(superseded_by_id) WHERE superseded_by_id IS NOT NULL` | trace a recompute chain |
| `climatology_normals_key` | `UNIQUE (baseline_version, outlook_cell_id, month)` | Q16 | |
| `climatology_normals_cell_idx` | `(outlook_cell_id, month)` | Q17 | |

### Derived artifacts

| Index | Definition | Query |
|---|---|---|
| `suitability_runs_live_key` | `UNIQUE (field_id) WHERE status = 'active'` | Q9 |
| `suitability_runs_field_idx` | `(field_id, computed_at DESC)` | run history |
| `suitability_runs_hash_idx` | `(field_id, input_snapshot_hash)` | Q10 — the recompute short-circuit |
| `suitability_runs_id_user_id_key` | `UNIQUE (id, user_id)` | composite-FK target |
| `planting_windows_live_idx` | `(field_id, crop_id, window_start) WHERE status = 'active'` | Q7 |
| `planting_windows_window_range_idx` | `(field_id, window_start, window_end) WHERE status = 'active'` | Q8 |
| `planting_windows_run_idx` | `(suitability_run_id)` | load a run's windows |
| `planting_windows_superseded_idx` | `(superseded_by_id) WHERE superseded_by_id IS NOT NULL` | chain |
| `ai_briefings_cache_key` | `UNIQUE (field_id, input_snapshot_hash) WHERE status = 'active'` | Q11 |
| `ai_briefings_field_idx` | `(field_id, computed_at DESC)` | history |
| `ai_briefings_run_idx` | `(suitability_run_id)` | narration for a run |

## 3. Decisions in the index design

**`NULLS NOT DISTINCT` on `weather_records_live_key`.** PostgreSQL treats `NULL`
as distinct in a unique index by default, so `ensemble_member IS NULL` rows would
never collide and every re-ingest of a deterministic product would append a full
duplicate set. `NULLS NOT DISTINCT` (PostgreSQL 15+) makes the deterministic case
behave like the ensemble case. Without it the table double-writes silently and
the series query returns each value twice.

**Partial indexes wherever the query filters a status.** `superseded_at IS NULL`
and `status = 'active'` appear in almost every read. History accumulates
monotonically — `weather_records` never deletes — so a non-partial index would
grow without bound while the query that needs it only ever looks at the live
slice.

**Two indexes on `planting_windows` that overlap.** `(field_id, crop_id,
window_start)` and `(field_id, window_start, window_end)`. The second cannot
serve Q7 because the crop filter is in the middle, and the first cannot serve Q8
because `window_end` is not in it. Both are `WHERE status = 'active'`, so both
stay small.

**`weather_records_ingestion_idx` is deliberately not partial.** The supersede-on-
reprocess operation must see rows that are *already* superseded, to avoid
double-superseding them. A partial index would make that query a sequential scan
on the largest table in the model.

**No index on `monthly_outlooks.month` alone.** Q15 always filters a cell first;
a standalone month index would be a low-cardinality index on a value that never
narrows anything on its own.

**No index on `evidence_segments`, `input_refs`, or any JSONB column.** No query
filters inside a document. If one ever needs to, the field should become a
column — a GIN index on a hashed preimage document would be an index on the thing
that must not be reconstructed.

**No `CREATE INDEX CONCURRENTLY` in Phase 3.** All tables are empty at creation,
so the non-concurrent form takes no lock that matters. The first index added to a
*live* table — most likely `weather_records` — must use `CONCURRENTLY`, and
`prisma migrate deploy` runs each migration in a transaction where
`CONCURRENTLY` is illegal. That is a real constraint on a future migration and is
recorded in `consistency-checklist.md` item 7.

## 4. Expected access shapes

| Table | Read:write | Why |
|---|---|---|
| `weather_records` | read-heavy, bulk-write | written once per run per cell per variable; read for every aggregation |
| `monthly_outlooks` | read-heavy, rewritten per run | the dashboard's primary source |
| `climatology_normals` | read-only after build | one build per baseline version |
| `forecast_runs`, `ingestion_runs` | append, rare read | operational metadata |
| tenant tables | small, per-user | a user has a handful of farms and fields |
| `planting_windows` | rewritten per recompute | supersede, never update |
| catalog | read-only after seed | immutable once published |

The asymmetry that drives the design: `weather_records` is the only table that
grows without bound in Phase 3, and it is read far more than written. Every
decision above that looks like over-indexing is on that table; the tenant tables
are indexed exactly for their one query each.

## 5. Q18 is not answerable yet

Q18 — "which fields does this cell serve?", the fan-out query when a new run
lands — reads `field_outlook_cells`, which is **tenant-owned and RLS-protected**,
while the job that needs the answer runs as `app_system`, which has **no grant**
on it (`ownership-and-rls.md` §2).

The index exists (`field_outlook_cells_cell_idx`) but the query cannot run under
the current privilege split. Three shapes are available and none is chosen here:

1. a narrow `SELECT` grant to `app_system` on `field_outlook_cells` only —
   but `app_system` has `BYPASSRLS`, so that grant reads **every tenant's**
   resolutions, which is a wider exposure than the fan-out needs;
2. a `SECURITY DEFINER` function `app.fields_for_cell(cell uuid)` returning only
   ids — one privileged entry point, narrow output;
3. a global projection table written on resolution change (the "who cares about
   this cell" index), which duplicates state and can drift.

This is `OPEN-27`, **P1**: it blocks the recompute trigger, not the schema.
Phase 3 can create every table and index above without resolving it; the
`recompute.windows` job cannot run until it is.

## 6. What is not indexed, and why

| Column | Why not |
|---|---|
| `farms.deleted_at`, `fields.deleted_at` | always used as an index predicate, never as a filter value |
| `users.created_at`, `farms.created_at` | nothing sorts accounts or farms |
| `weather_records.valid_at` alone | always filtered with `cell_key` + `variable` (Q12) |
| `weather_records.provider` / `.model` | denormalised for self-description, not for filtering; the run and cell carry that |
| `monthly_outlooks.data_class` | reporting, not a filter; the row is found by cell+month |
| `constraints.grade`, `.severity` | read as part of a profile load, never filtered |
| `source_refs.publication_year` | a bibliography is rendered whole |
| `ai_briefings.body` | a JSONB document, never queried |
| `planting_windows.suitability` | windows are fetched by field, then evaluated; a global "all unsuitable windows" query does not exist |
