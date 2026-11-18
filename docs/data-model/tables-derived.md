# Tables — Agronomic and AI Derived Artifacts

Three tables. All tenant-derived: they carry `user_id`, they are RLS-isolated, and
they are **append-and-supersede**, never edited in place once `active`.

They are the tables a recommendation is served from, so the rule they encode is the
one clause that matters most: a stored artifact must be explainable after the
inputs have moved on (`provenance-contract.md` §4).

---

## 1. `app.suitability_runs`

| | |
|---|---|
| Entity | `SuitabilityRun` (`domain-model.md` §5) |
| Class | tenant-derived |
| Ownership key | `user_id`, denormalised from `fields` |
| Purpose | one evaluation of one field against one profile version, aggregating the windows it produced |
| Lifecycle | created by `recompute.windows` inside `withTenant(ownerId)`; superseded by a later run; never deleted |
| Exists | no (Phase 3) |

| Column | Type | Null | Default | Meaning |
|---|---|---|---|---|
| `id` | `uuid` | no | `uuidv7()` | PK |
| `user_id` | `uuid` | no | — | owner; RLS predicate |
| `field_id` | `uuid` | no | — | composite FK with `user_id` |
| `profile_version_id` | `uuid` | no | — | FK → `crop_profile_versions.id`; the rulebook used |
| `computed_at` | `timestamptz(6)` | no | `now()` | when the engine ran |
| `engine_version` | `text` | no | — | agronomy engine semver |
| `derivation_version` | `text` | no | — | rule-set version above the engine |
| `dimension_coverage` | `jsonb` | no | — | `[{dimension, state}]`, `state ∈ known\|unknown\|not_applicable`; `CHECK (jsonb_typeof = 'array')` |
| `max_achievable_level` | `text` | yes | — | `CHECK (IN ('A','B','C','D'))`; `NULL` when no dimension is `known` |
| `input_refs` | `jsonb` | no | — | `DataInputRef[]`; **every** input, including the climatology baseline when used |
| `field_snapshot` | `jsonb` | no | — | the exact `FieldSnapshot` the engine saw, `fieldSnapshotHash` included |
| `field_snapshot_hash` | `text` | no | — | `^[0-9a-f]{64}$`; duplicated out of the document so it can be indexed and compared |
| `input_snapshot_hash` | `text` | no | — | `^[0-9a-f]{64}$`; over the `suitability_run` descriptor variant |
| `reproducible` | `boolean` | no | `true` | `false` requires `unreproducible_reason` |
| `unreproducible_reason` | `text` | yes | — | e.g. `raw_payload_not_retained`, `field_edited_without_history` |
| `status` | `text` | no | `'active'` | `CHECK (IN ('active','superseded','failed'))` |
| `supersedes_id` | `uuid` | yes | — | FK → self |
| `superseded_by_id` | `uuid` | yes | — | FK → self |
| `created_at` | `timestamptz(6)` | no | `now()` | — |

Constraints:

| Name | Definition | Invalid state prevented |
|---|---|---|
| `suitability_runs_pkey` | `PRIMARY KEY (id)` | — |
| `suitability_runs_id_user_id_key` | `UNIQUE (id, user_id)` | composite-FK target for `planting_windows` |
| `suitability_runs_field_owner_fkey` | `FOREIGN KEY (field_id, user_id) REFERENCES app.fields (id, user_id)` | evaluating another tenant's field |
| `suitability_runs_profile_fkey` | `FOREIGN KEY (profile_version_id) REFERENCES app.crop_profile_versions (id)` | a result with no rulebook |
| `suitability_runs_supersedes_fkey` | `FOREIGN KEY (supersedes_id) REFERENCES app.suitability_runs (id)` | a broken chain |
| `suitability_runs_superseded_by_fkey` | `FOREIGN KEY (superseded_by_id) REFERENCES app.suitability_runs (id)` | a broken chain |
| `suitability_runs_status_check` | `status IN ('active','superseded','failed')` | — |
| `suitability_runs_superseded_state_check` | `(status = 'superseded') = (superseded_by_id IS NOT NULL)` | a superseded run with no successor |
| `suitability_runs_reproducible_check` | `reproducible OR unreproducible_reason IS NOT NULL` | **silent** unreproducibility |
| `suitability_runs_level_check` | `max_achievable_level IS NULL OR max_achievable_level IN ('A','B','C','D')` | a level the catalog cannot justify |
| `suitability_runs_hash_check` | both hash columns `~ '^[0-9a-f]{64}$'` | — |
| `suitability_runs_coverage_check` | `jsonb_typeof(dimension_coverage) = 'array'` | a document shaped unlike the contract |

Indexes:

| Name | Definition | Query |
|---|---|---|
| `suitability_runs_live_key` | `UNIQUE (field_id) WHERE status = 'active'` | one live run per field — "what is the current evaluation" |
| `suitability_runs_field_idx` | `(field_id, computed_at DESC)` | run history for a field |
| `suitability_runs_hash_idx` | `(field_id, input_snapshot_hash)` | "has this exact input set already been evaluated" |

Notes:

- **`max_achievable_level` shares the `A`–`D` vocabulary with
  `constraints.grade`**, so a level is traceable to the evidence behind it. It is
  `NULL` — not `D` — when nothing is `known`, because `D` would be a claim.
- The five dimensions are `climate`, `water`, `soil`, `timing`, `risk`
  (`domain-model.md` §5 + the constraint dimension enum). `state` has no column
  because the set is closed and small; the Zod schema validates it, and
  `database` stores the document. Shredding five values into five rows would add a
  join to a read that happens on every field page.
- The `field_snapshot` document is stored **whole**, not referenced. A field edit
  after the run would otherwise change what the run claims it evaluated, and
  `fieldSnapshotHash` would no longer describe the row it sits on.
- `reproducible = false` is a legal, stored state with a reason. It exists because
  raw provider payload retention is a licensing decision that is still open
  (`OPEN-05`), and pretending every run is replayable would be a false claim in the
  provenance record.

---

## 2. `app.planting_windows`

| | |
|---|---|
| Entity | `PlantingWindow` (`domain-model.md` §5) |
| Class | tenant-derived |
| Ownership key | `user_id` |
| Purpose | one recommended interval for one crop/variety on one field, with the evidence partition that justifies it |
| Lifecycle | created with its run; superseded by a later recompute; a failed recompute leaves the previous window `active` |
| Exists | no (Phase 3) |

| Column | Type | Null | Default | Meaning |
|---|---|---|---|---|
| `id` | `uuid` | no | `uuidv7()` | PK |
| `user_id` | `uuid` | no | — | owner; RLS predicate |
| `suitability_run_id` | `uuid` | no | — | composite FK with `user_id`; the run that produced this window |
| `field_id` | `uuid` | no | — | composite FK with `user_id` |
| `crop_id` | `uuid` | no | — | FK → `crops.id`; denormalised from the cultivar so the crop filter is one column |
| `cultivar_id` | `uuid` | no | — | FK → `cultivars.id` |
| `profile_version_id` | `uuid` | no | — | FK → `crop_profile_versions.id`; **mandatory** (`provenance-contract.md` §4 rule 4) |
| `window_start` | `date` | no | — | inclusive, Asia/Jakarta calendar |
| `window_end` | `date` | no | — | inclusive; `CHECK (window_end >= window_start)` |
| `evaluation_basis` | `text` | no | — | `EvaluationBasis`, `mixed` permitted |
| `primary_basis` | `text` | no | — | `SingleValueEvaluationBasis`; the basis over the **critical stage** |
| `mixed_evidence` | `boolean` | no | — | true iff the segments contain ≥ 2 classes |
| `weakest_evidence_class` | `text` | no | — | `WeatherDataClass` |
| `evidence_segments` | `jsonb` | no | — | `EvidenceSegment[]` in chronological order — `CHECK (jsonb_typeof = 'array')` |
| `missing_ranges` | `jsonb` | no | — | `MissingRange[]` — `CHECK (jsonb_typeof = 'array')` |
| `suitability` | `text` | no | — | `CHECK (IN ('suitable','conditional','unsuitable','insufficient_data'))` — `D25` |
| `score` | `numeric(5,2)` | yes | — | `CHECK (BETWEEN 0 AND 100)`; absent whenever a dimension is unknown |
| `risks` | `jsonb` | no | `'[]'` | array of risk descriptors produced from `severity = 'risk'` constraints |
| `explanations` | `jsonb` | no | `'[]'` | array of `{constraintId, dimension, outcome}` — the "why" behind the verdict |
| `constraints_evaluated` | `jsonb` | no | `'[]'` | ids + grades of the constraints that participated |
| `missing_inputs` | `jsonb` | no | `'[]'` | which dimensions/inputs were unknown, mirroring `dimensionCoverage` |
| `input_refs` | `jsonb` | no | — | `DataInputRef[]` for this window |
| `field_snapshot_hash` | `text` | no | — | `^[0-9a-f]{64}$` |
| `input_snapshot_hash` | `text` | no | — | `^[0-9a-f]{64}$`; the `planting_window` descriptor variant |
| `reproducible` | `boolean` | no | `true` | `false` requires a reason |
| `unreproducible_reason` | `text` | yes | — | — |
| `computed_at` | `timestamptz(6)` | no | `now()` | — |
| `status` | `text` | no | `'active'` | `CHECK (IN ('active','superseded','failed'))` |
| `superseded_by_id` | `uuid` | yes | — | FK → self |
| `created_at` | `timestamptz(6)` | no | `now()` | — |

Constraints:

| Name | Definition | Invalid state prevented |
|---|---|---|
| `planting_windows_pkey` | `PRIMARY KEY (id)` | — |
| `planting_windows_run_owner_fkey` | `FOREIGN KEY (suitability_run_id, user_id) REFERENCES app.suitability_runs (id, user_id)` | a window hung on another tenant's run |
| `planting_windows_field_owner_fkey` | `FOREIGN KEY (field_id, user_id) REFERENCES app.fields (id, user_id)` | a window for another tenant's field |
| `planting_windows_crop_fkey` / `_cultivar_fkey` / `_profile_fkey` | plain FKs to the catalog | an unexplained recommendation |
| `planting_windows_span_check` | `window_end >= window_start` | an empty or inverted window |
| `planting_windows_suitability_check` | `suitability IN ('suitable','conditional','unsuitable','insufficient_data')` | a verdict vocabulary the UI cannot render |
| `planting_windows_no_score_without_data_check` | `suitability <> 'insufficient_data' OR score IS NULL` | a numeric score on unknown inputs — invariant 1 of `domain-model.md` §5 |
| `planting_windows_climatology_primary_check` | `NOT (primary_basis = 'climatology' AND suitability = 'suitable')` | a "suitable" verdict whose critical stage rests on climatology |
| `planting_windows_basis_check` | `evaluation_basis IN (…)` and `primary_basis IN (…)` (the single-value enum) | `mixed` leaking into `primary_basis` |
| `planting_windows_reproducible_check` | `reproducible OR unreproducible_reason IS NOT NULL` | silent unreproducibility |
| `planting_windows_status_check` | `status IN ('active','superseded','failed')` | — |
| `planting_windows_superseded_state_check` | `(status = 'superseded') = (superseded_by_id IS NOT NULL)` | a broken audit chain |
| `planting_windows_documents_check` | `jsonb_typeof(evidence_segments) = 'array' AND jsonb_typeof(missing_ranges) = 'array'` | a document shaped unlike the contract |
| `planting_windows_hash_check` | both hash columns `~ '^[0-9a-f]{64}$'` | — |

Indexes:

| Name | Definition | Query |
|---|---|---|
| `planting_windows_live_idx` | `(field_id, crop_id, window_start) WHERE status = 'active'` | "windows for this field and crop, in date order" — the dashboard query |
| `planting_windows_run_idx` | `(suitability_run_id)` | load a run's windows |
| `planting_windows_window_range_idx` | `(field_id, window_start, window_end) WHERE status = 'active'` | overlap tests for a requested date range |
| `planting_windows_superseded_idx` | `(superseded_by_id) WHERE superseded_by_id IS NOT NULL` | trace a recompute chain |

### The partition invariant is **not** a database constraint

`provenance-contract.md` §2 requires that `evidence_segments ∪ missing_ranges`
covers `[window_start, window_end]` exactly once. That is a multi-row interval
algebra over a document array; PostgreSQL enforces none of it, and this
specification will not pretend otherwise.

The six checks that must exist (no overlap, no gap, full span, internal
contiguity, reason presence, coverage reconciliation) live in a domain validator
that **does not exist yet** — `provenance-contract.md` §4 says so explicitly.
Until it does, nothing prevents an invalid partition from being stored, and
`OPEN-26` tracks it as a Phase 3 blocker for the write path rather than a schema
change.

What the database does enforce is the part it can: the window is non-empty
(`span_check`), the documents are arrays, and a climatology-critical window cannot
be called `suitable`.

Notes:

- `crop_id` duplicates `cultivars.crop_id` on purpose. Every list query filters by
  crop; joining to `cultivars` to learn a column that cannot change is a join for
  nothing.
- `profile_version_id` is on the window as well as on the run, so a window is
  self-describing when read alone — the same reasoning that puts run ids on both
  the segment and the descriptor in `provenance-contract.md` §2.
- `suitability = 'insufficient_data'` is the required verdict when a **hard**
  constraint's input is unknown. `'poor'` is not in the enum: it was the value the
  earlier design used for "unknown", which conflated "the weather is bad" with "we
  do not know". `'unsuitable'` now means the former only.
- Windows are superseded, not updated. A dashboard reading a stale window sees an
  `active` row with an old `computed_at` and a freshness derived from its inputs —
  never two live windows for the same field and crop interval.

---

## 3. `app.ai_briefings`

| | |
|---|---|
| Entity | `AiBriefing` |
| Class | tenant-derived |
| Ownership key | `user_id` |
| Purpose | natural-language narration of a structured result; it explains, it never decides |
| Lifecycle | generated on request, cached by `input_snapshot_hash`; invalidated by input identity, never by a clock; superseded, never deleted |
| Exists | no (Phase 3) |

| Column | Type | Null | Default | Meaning |
|---|---|---|---|---|
| `id` | `uuid` | no | `uuidv7()` | PK |
| `user_id` | `uuid` | no | — | owner; RLS predicate |
| `field_id` | `uuid` | no | — | composite FK with `user_id` |
| `suitability_run_id` | `uuid` | no | — | composite FK with `user_id`; the run this briefing explains |
| `body` | `jsonb` | no | — | the briefing document validated against the `ClimateBriefing` contract (`OPEN-11`) |
| `narration_status` | `text` | no | `'generated'` | `CHECK (IN ('generated','unavailable'))`; `unavailable` when the model failed and the deterministic skeleton is stored instead |
| `model_id` | `text` | no | — | e.g. `deepseek-v4.1-flash`; part of the descriptor, because changing it changes the narration |
| `prompt_version` | `text` | no | — | prompt template version |
| `derivation_version` | `text` | no | — | briefing assembly version |
| `input_refs` | `jsonb` | no | — | `DataInputRef[]`; what the model was told about |
| `field_snapshot_hash` | `text` | no | — | `^[0-9a-f]{64}$`; the snapshot body lives on the run it explains |
| `source_artifact_hashes` | `text[]` | no | — | sorted `inputSnapshotHash` values of the outlook/windows summarised; `CHECK (cardinality(source_artifact_hashes) > 0)` |
| `input_snapshot_hash` | `text` | no | — | `^[0-9a-f]{64}$`; the `ai_briefing` descriptor variant |
| `computed_at` | `timestamptz(6)` | no | `now()` | — |
| `reproducible` | `boolean` | no | `false` | a model call is not replayable by construction |
| `unreproducible_reason` | `text` | yes | — | — |
| `status` | `text` | no | `'active'` | `CHECK (IN ('active','superseded','failed'))` |
| `superseded_by_id` | `uuid` | yes | — | FK → self |
| `created_at` | `timestamptz(6)` | no | `now()` | — |

Constraints:

| Name | Definition | Invalid state prevented |
|---|---|---|
| `ai_briefings_pkey` | `PRIMARY KEY (id)` | — |
| `ai_briefings_field_owner_fkey` | `FOREIGN KEY (field_id, user_id) REFERENCES app.fields (id, user_id)` | a briefing about another tenant's field |
| `ai_briefings_run_owner_fkey` | `FOREIGN KEY (suitability_run_id, user_id) REFERENCES app.suitability_runs (id, user_id)` | a briefing explaining another tenant's run |
| `ai_briefings_superseded_fkey` | `FOREIGN KEY (superseded_by_id) REFERENCES app.ai_briefings (id)` | a broken chain |
| `ai_briefings_narration_check` | `narration_status IN ('generated','unavailable')` | an unrenderable narration state |
| `ai_briefings_body_check` | `jsonb_typeof(body) = 'object'` | a bare string where a structured document is promised |
| `ai_briefings_sources_check` | `cardinality(source_artifact_hashes) > 0` | **a briefing that summarised nothing** — the fabricated-summary case |
| `ai_briefings_hash_check` | `field_snapshot_hash ~ '^[0-9a-f]{64}$' AND input_snapshot_hash ~ '^[0-9a-f]{64}$'` | — |
| `ai_briefings_reproducible_check` | `reproducible OR unreproducible_reason IS NOT NULL` | — |
| `ai_briefings_status_check` | `status IN ('active','superseded','failed')` | — |
| `ai_briefings_superseded_state_check` | `(status = 'superseded') = (superseded_by_id IS NOT NULL)` | — |

Indexes:

| Name | Definition | Query |
|---|---|---|
| `ai_briefings_cache_key` | `UNIQUE (field_id, input_snapshot_hash) WHERE status = 'active'` | `POST /v1/ai/briefing?fieldId=…` is cached per input hash (`api-conventions.md` §5) |
| `ai_briefings_field_idx` | `(field_id, computed_at DESC)` | briefing history — "recommendation update time" |
| `ai_briefings_run_idx` | `(suitability_run_id)` | load the narration for a run |

Notes:

- **AI is not a decision source.** `body` has no suitability field of its own; a
  briefing that contradicts the run it references is a contract violation, not an
  alternative opinion, and `CLIMATEBRIEFING` validation is where it is rejected.
  There is no `ai` column on `planting_windows`, and no code path reads a briefing
  to compute anything.
- `reproducible` defaults to **`false`** here, unlike the other two artifacts. A
  model call is not deterministic, so claiming replayability by default would be a
  false claim; the reason is recorded alongside.
- `source_artifact_hashes` is what makes the briefing's invalidation rule
  ("any `inputRefs` entry changed") meaningful: a new season's windows change their
  `inputSnapshotHash`, which changes the hash this briefing computed over its
  sources, which makes the cached row unreachable rather than wrong.
- There is no separate `context_hash`. The context *is* the input set; a second hash
  over the same material would be a second thing to keep in sync
  (`data-flow.md` §6).
- `body` is the only user-facing generated content in the schema, and it is
  regenerated rather than edited. Nothing in `app_api` ever writes `body` after
  insert.
