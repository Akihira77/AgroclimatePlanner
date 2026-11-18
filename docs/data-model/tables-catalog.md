# Tables — Crop Catalog

Six tables, all `reference` class: global content, no `user_id`, no RLS, written by
`migration_owner` (seed or a future admin path, `D13`), read by `app_api`.

The catalog is the reason a stored recommendation stays explainable. A window
points at a `crop_profile_version` id, never at "the cultivar's current profile",
so correcting a threshold cannot retroactively change a recommendation that was
already given (`domain-model.md` §3 invariant).

**No agronomic threshold is invented in this document.** Every value that appears
below is a *column definition*, not a number. The values themselves come from
`docs/research/agronomic-reference-matrix.md`, are graded A–D there, and are
seeded in Phase 3 with their `source_refs`.

---

## 1. `app.crops`

| | |
|---|---|
| Entity | `Crop` — species level |
| Class | reference |
| Purpose | the four v1 species: padi, jagung, kedelai, cabai |
| Lifecycle | seeded; a `slug` is permanent (it appears in URLs) |
| Exists | yes (Phase 3, `20261118030000_domain_tables`) |

| Column | Type | Null | Default | Meaning |
|---|---|---|---|---|
| `id` | `uuid` | no | `uuidv7()` | PK |
| `slug` | `text` | no | — | URL key, lower-case ASCII: `padi`, `jagung`, `kedelai`, `cabai` |
| `name_id` | `text` | no | — | Indonesian display name |
| `name_en` | `text` | no | — | English display name |
| `category` | `text` | no | — | vocabulary unsettled — `OPEN-10`; no `CHECK` until it is |
| `created_at` | `timestamptz(6)` | no | `now()` | — |
| `updated_at` | `timestamptz(6)` | no | `now()` | — |

Constraints:

| Name | Definition | Invalid state prevented |
|---|---|---|
| `crops_pkey` | `PRIMARY KEY (id)` | — |
| `crops_slug_key` | `UNIQUE (slug)` | two crops at one URL |
| `crops_slug_shape_check` | `slug ~ '^[a-z][a-z0-9-]*$'` | a slug needing URL-encoding |
| `crops_name_check` | `btrim(name_id) <> '' AND btrim(name_en) <> ''` | an untranslated crop in a bilingual UI |

Indexes: `crops_slug_key` only.

Notes:

- `category` is listed in `domain-model.md` §3 with no value set. It is not
  constrained and no code may branch on it until `OPEN-10` settles the vocabulary —
  a `CHECK` now would be an invented enum in a normative schema.
- Bilingual names are two columns, not a `jsonb {id, en}` document. They are
  queried, sorted, and searched; a JSONB name would make `ORDER BY name` require an
  expression index for no benefit.

---

## 2. `app.cultivars`

| | |
|---|---|
| Entity | `Cultivar` — variety level |
| Class | reference |
| Purpose | the variety actually planted: cycle length, cycle basis, nursery, altitude band |
| Lifecycle | seeded; a name is not renamed because `plantings` history refers to it |
| Exists | yes (Phase 3, `20261118030000_domain_tables`) |

| Column | Type | Null | Default | Meaning |
|---|---|---|---|---|
| `id` | `uuid` | no | `uuidv7()` | PK |
| `crop_id` | `uuid` | no | — | FK → `crops.id` |
| `name` | `text` | no | — | e.g. `Ciherang`, `Inpari 32`, `Lamuru`, `Grobogan`, `Hiyung` |
| `duration_days_min` | `integer` | no | — | `CHECK (> 0)` |
| `duration_days_typical` | `integer` | no | — | `CHECK (BETWEEN min AND max)` |
| `duration_days_max` | `integer` | no | — | `CHECK (>= min)` |
| `cycle_start` | `text` | no | — | `CHECK (IN ('sowing','transplant'))`; the default/supported basis |
| `nursery_days` | `integer` | yes | — | `CHECK (> 0)`; `NULL` for direct-sown varieties |
| `photoperiod_sensitivity` | `text` | yes | — | representation unsettled — `OPEN-06`; no `CHECK` |
| `altitude_min_m` | `integer` | yes | — | `CHECK (>= 0)`; `NULL` = not established for this variety |
| `altitude_max_m` | `integer` | yes | — | `CHECK (>= altitude_min_m)` |
| `created_at` | `timestamptz(6)` | no | `now()` | — |
| `updated_at` | `timestamptz(6)` | no | `now()` | — |

Constraints:

| Name | Definition | Invalid state prevented |
|---|---|---|
| `cultivars_pkey` | `PRIMARY KEY (id)` | — |
| `cultivars_crop_fkey` | `FOREIGN KEY (crop_id) REFERENCES app.crops (id)` | an orphan variety |
| `cultivars_crop_name_key` | `UNIQUE (crop_id, name)` | the same variety twice under one species |
| `cultivars_duration_order_check` | `duration_days_min <= duration_days_typical AND duration_days_typical <= duration_days_max` | a "typical" outside its own range, which would make every window critique meaningless |
| `cultivars_cycle_start_check` | `cycle_start IN ('sowing','transplant')` | a basis the duration model cannot apply |
| `cultivars_altitude_check` | `altitude_min_m IS NULL OR altitude_max_m IS NULL OR altitude_min_m <= altitude_max_m` | an inverted altitude band |

Indexes: `cultivars_crop_idx` on `(crop_id)` — "choose a variety for this crop".

Notes:

- `photoperiod_sensitivity` is a real agronomic property (rice varieties differ),
  but no document fixes its representation. Textual, unconstrained, `OPEN-06`. It
  cannot be used in a constraint evaluation until it is settled.
- `nursery_days` is `NULL` for direct-sown varieties and **not** `0`. `0` would mean
  "a nursery stage that lasts no time", which is a different claim.
- `cultivars.cycle_start` and `plantings.cycle_start_used` can disagree (a variety
  supports transplant, the user direct-seeded). v1 treats the pairing as an
  application invariant, not a database one, because they are not in the same row
  — `OPEN-23`.

---

## 3. `app.crop_profile_versions`

| | |
|---|---|
| Entity | `CropProfileVersion` — the versioned agronomic content |
| Class | reference |
| Purpose | the immutable rulebook a recommendation was evaluated against |
| Lifecycle | `draft` → `published` (once) → `retired`; a change produces a **new** row with `supersedes_id` set |
| Exists | yes (Phase 3, `20261118030000_domain_tables`) |

| Column | Type | Null | Default | Meaning |
|---|---|---|---|---|
| `id` | `uuid` | no | `uuidv7()` | PK; this is `profileVersionId` in every artifact |
| `cultivar_id` | `uuid` | no | — | FK → `cultivars.id` |
| `rule_version` | `text` | no | — | human-readable rule-set version, e.g. `padi-ciherang-2026.1` |
| `status` | `text` | no | `'draft'` | `CHECK (IN ('draft','published','retired'))` |
| `published_at` | `timestamptz(6)` | yes | — | set exactly once, when `status` becomes `published` |
| `supersedes_id` | `uuid` | yes | — | FK → self; the version this one replaces |
| `created_at` | `timestamptz(6)` | no | `now()` | — |
| `updated_at` | `timestamptz(6)` | no | `now()` | — |

Constraints:

| Name | Definition | Invalid state prevented |
|---|---|---|
| `crop_profile_versions_pkey` | `PRIMARY KEY (id)` | — |
| `crop_profile_versions_cultivar_fkey` | `FOREIGN KEY (cultivar_id) REFERENCES app.cultivars (id)` | a profile attached to nothing |
| `crop_profile_versions_supersedes_fkey` | `FOREIGN KEY (supersedes_id) REFERENCES app.crop_profile_versions (id)` | a dangling supersession chain |
| `crop_profile_versions_cultivar_rule_key` | `UNIQUE (cultivar_id, rule_version)` | the same rule set published twice |
| `crop_profile_versions_status_check` | `status IN ('draft','published','retired')` | an unauthorized lifecycle state |
| `crop_profile_versions_published_at_check` | `(status = 'draft') = (published_at IS NULL)` | a draft with a publication date, or a published profile that claims no publication |
| `crop_profile_versions_no_self_supersede_check` | `supersedes_id IS NULL OR supersedes_id <> id` | a version replacing itself |

Indexes:

| Name | Definition | Query |
|---|---|---|
| `crop_profile_versions_one_published_key` | `UNIQUE (cultivar_id) WHERE status = 'published'` | at most one live rulebook per variety — the "which profile applies now" query |
| `crop_profile_versions_cultivar_idx` | `(cultivar_id, created_at DESC)` | version history for a variety |

### Immutability after publication (`D5`)

A `CHECK` cannot express "this row may not change once published" — it is a
transition rule, not a row-state rule. Two mechanisms, both required:

1. **No `UPDATE`/`DELETE` grant to `app_api` on this table at all** (`D13`). The
   API reads the catalog; it never writes it. That alone blocks every runtime path.
2. **A `BEFORE UPDATE` trigger**, `crop_profile_versions_immutable`, raising
   `integrity_constraint_violation` when `OLD.status = 'published'` and either the
   row would change any column other than `status`, or `NEW.status` is `draft`.
   Allowed transitions are `published → retired` and nothing else.

The trigger is specified here and **not created** in this phase. It exists because
`migration_owner` can write the table: without it, a seed script correcting a typo
in place would silently change what every stored window was evaluated against,
while the windows still name this id.

Retiring does not rewrite history: a retired profile still serves every artifact
that references it. Retiring means "no new recommendation may choose this version".

---

## 4. `app.growth_stages`

| | |
|---|---|
| Entity | `GrowthStage` |
| Class | reference |
| Purpose | the phenological phases a profile defines, with day offsets from cycle start |
| Lifecycle | belongs to a profile version; immutable once that version is published (same trigger family) |
| Exists | yes (Phase 3, `20261118030000_domain_tables`) |

| Column | Type | Null | Default | Meaning |
|---|---|---|---|---|
| `id` | `uuid` | no | `uuidv7()` | PK |
| `profile_version_id` | `uuid` | no | — | FK → `crop_profile_versions.id` |
| `name` | `text` | no | — | e.g. `vegetative`, `reproductive`, `ripening` — vocabulary per profile, not global |
| `start_day_offset` | `integer` | no | — | `CHECK (>= 0)`; inclusive, days from the cycle start |
| `end_day_offset` | `integer` | no | — | `CHECK (>= start_day_offset)` |
| `is_critical` | `boolean` | no | `false` | the stage whose basis decides `primaryBasis` (`provenance-contract.md` §2) |
| `requirement_profile` | `text` | yes | — | unresolved — `OPEN-08`; no `CHECK` |
| `created_at` | `timestamptz(6)` | no | `now()` | — |

Constraints:

| Name | Definition | Invalid state prevented |
|---|---|---|
| `growth_stages_pkey` | `PRIMARY KEY (id)` | — |
| `growth_stages_profile_fkey` | `FOREIGN KEY (profile_version_id) REFERENCES app.crop_profile_versions (id)` | an orphan stage |
| `growth_stages_profile_name_key` | `UNIQUE (profile_version_id, name)` | two stages with one name in one profile |
| `growth_stages_offset_order_check` | `start_day_offset >= 0 AND end_day_offset >= start_day_offset` | a negative or inverted stage |
| `growth_stages_one_critical_key` | `UNIQUE (profile_version_id) WHERE is_critical` | two critical stages — `primaryBasis` would have no unique definition |

Indexes: `growth_stages_profile_idx` on `(profile_version_id, start_day_offset)` —
render a profile's phases in order.

Notes:

- **Stages are not required to be disjoint.** A nursery stage and a vegetative
  stage can overlap in the literature, and no document forbids it. Emitting a
  non-overlap `EXCLUDE` constraint would reject real profiles.
- `requirement_profile` is listed by `domain-model.md` §3 with no type. A `text`
  reference is the least-committing representation that can be seeded later; it is
  not read by any code until `OPEN-08` settles it.

---

## 5. `app.constraints`

| | |
|---|---|
| Entity | `Constraint` |
| Class | reference |
| Purpose | one agronomic rule, evaluable against a field and an outlook |
| Lifecycle | belongs to a profile version; immutable once published |
| Exists | yes (Phase 3, `20261118030000_domain_tables`) |

| Column | Type | Null | Default | Meaning |
|---|---|---|---|---|
| `id` | `uuid` | no | `uuidv7()` | PK |
| `profile_version_id` | `uuid` | no | — | FK → `crop_profile_versions.id` |
| `dimension` | `text` | no | — | `CHECK (IN ('climate','water','soil','timing','risk'))` |
| `comparator` | `text` | no | — | `CHECK (IN ('min','max','range','count','window'))` |
| `threshold_lower` | `numeric(10,2)` | yes | — | lower bound for `min`/`range` |
| `threshold_upper` | `numeric(10,2)` | yes | — | upper bound for `max`/`range` |
| `threshold_count` | `integer` | yes | — | count bound for `count` |
| `unit` | `text` | yes | — | `mm`, `°C`, `pH`, `days`, `dS/m` — required for every quantitative comparator |
| `growth_stage_id` | `uuid` | yes | — | FK → `growth_stages.id`; `NULL` = applies to the whole cycle |
| `grade` | `text` | no | — | `CHECK (IN ('A','B','C','D'))` — evidence quality, never displayed as a probability |
| `severity` | `text` | no | — | `CHECK (IN ('hard','soft','risk'))` |
| `created_at` | `timestamptz(6)` | no | `now()` | — |

Constraints:

| Name | Definition | Invalid state prevented |
|---|---|---|
| `constraints_pkey` | `PRIMARY KEY (id)` | — |
| `constraints_profile_fkey` | `FOREIGN KEY (profile_version_id) REFERENCES app.crop_profile_versions (id)` | an orphan rule |
| `constraints_stage_fkey` | `FOREIGN KEY (growth_stage_id) REFERENCES app.growth_stages (id)` | a rule attached to a stage of another profile |
| `constraints_dimension_check` | `dimension IN ('climate','water','soil','timing','risk')` | a dimension `dimensionCoverage` cannot report |
| `constraints_comparator_check` | `comparator IN ('min','max','range','count','window')` | — |
| `constraints_grade_check` | `grade IN ('A','B','C','D')` | — |
| `constraints_severity_check` | `severity IN ('hard','soft','risk')` | a severity the engine does not implement |
| `constraints_shape_check` | see below | a rule that cannot be evaluated, stored as if it could |
| `constraints_window_not_supported_check` | `comparator <> 'window'` | a comparator with no agreed semantics — `OPEN-07` |

`constraints_shape_check` — one predicate per comparator, so the row is always
evaluable:

```sql
(comparator = 'min'   AND threshold_lower IS NOT NULL AND threshold_upper IS NULL
                      AND threshold_count IS NULL AND unit IS NOT NULL)
OR (comparator = 'max'   AND threshold_upper IS NOT NULL AND threshold_lower IS NULL
                      AND threshold_count IS NULL AND unit IS NOT NULL)
OR (comparator = 'range' AND threshold_lower IS NOT NULL AND threshold_upper IS NOT NULL
                      AND threshold_lower <= threshold_upper
                      AND threshold_count IS NULL AND unit IS NOT NULL)
OR (comparator = 'count' AND threshold_count IS NOT NULL AND threshold_count >= 0
                      AND threshold_lower IS NULL AND threshold_upper IS NULL)
```

Indexes: `constraints_profile_idx` on `(profile_version_id, dimension)` — load a
profile's rules grouped by dimension.

Notes:

- **`threshold_lower` / `threshold_upper`, not a single `value` (`D6`).** The
  domain model writes `value` because it describes the concept; a `range` rule
  cannot be stored in one number, and a `count` rule is not a quantity. Three typed
  columns express all four supported comparators without a nullable-everything row.
- `comparator = 'window'` is *rejected by the database* until `OPEN-07` defines what
  a window comparator compares. Allowing it and hoping would put a rule in a
  published profile that the engine cannot evaluate — and a published profile is
  immutable, so the mistake would be permanent.
- `severity` is what produces `insufficient_data`: a `hard` constraint with an
  unknown input caps suitability at `conditional` and forbids a score
  (`domain-model.md` §5 invariant 2).
- `grade` is the *evidence* grade (A–D from the research matrix), not a
  probability. Nothing in this schema stores a confidence percentage, and nothing
  may derive one from `grade`.
- Water-dimension constraints for `kedelai` and `cabai` are expected to be absent
  in v1 because the matrix records their monthly-rainfall thresholds as
  `insufficient_data` (grade C). Absence is `dimensionCoverage.water =
  'unknown'`, which caps suitability — it is not a missing row to be filled by
  guessing.

---

## 6. `app.source_refs`

| | |
|---|---|
| Entity | `SourceRef` |
| Class | reference |
| Purpose | the citation that justifies a profile version's thresholds |
| Lifecycle | appended with a profile version; never edited after publication |
| Exists | yes (Phase 3, `20261118030000_domain_tables`) |

| Column | Type | Null | Default | Meaning |
|---|---|---|---|---|
| `id` | `uuid` | no | `uuidv7()` | PK |
| `profile_version_id` | `uuid` | no | — | FK → `crop_profile_versions.id` |
| `title` | `text` | no | — | work title |
| `authors` | `text` | yes | — | `NULL` when the source is institutional (FAO, IRRI, BPS) |
| `publication_year` | `integer` | no | — | `CHECK (BETWEEN 1900 AND 2100)` |
| `publisher` | `text` | no | — | journal, institution, or standards body |
| `url` | `text` | no | — | resolvable link; `CHECK (url ~ '^https?://')` |
| `accessed_at` | `date` | no | — | when the reference was retrieved |
| `grade` | `text` | no | — | `CHECK (IN ('A','B','C','D'))` — the evidence grade the matrix assigns |
| `created_at` | `timestamptz(6)` | no | `now()` | — |

Constraints:

| Name | Definition | Invalid state prevented |
|---|---|---|
| `source_refs_pkey` | `PRIMARY KEY (id)` | — |
| `source_refs_profile_fkey` | `FOREIGN KEY (profile_version_id) REFERENCES app.crop_profile_versions (id)` | an uncited rulebook |
| `source_refs_resolved_check` | `title`, `publisher`, `publication_year`, `url`, `accessed_at` all `NOT NULL` (enforced by the column definitions plus `btrim(...) <> ''`) | **an unresolved citation inside a published profile** — `domain-model.md` §3 forbids it |
| `source_refs_url_check` | `url ~ '^https?://'` | a citation that cannot be followed |
| `source_refs_grade_check` | `grade IN ('A','B','C','D')` | — |
| `source_refs_year_check` | `publication_year BETWEEN 1900 AND 2100` | a typo'd year that would render "est. 1024" |

Indexes: `source_refs_profile_idx` on `(profile_version_id)`.

Notes:

- The "only resolved references may be attached" rule is enforced by **column
  nullability**, not by a review habit. That is the whole point of it being a table
  instead of a markdown bibliography.
- Citations currently attach at profile-version level (one bibliography per
  rulebook), matching `domain-model.md`'s ERD arrow. Constraint-level evidence would
  be a `constraint_id` column later; it is not added now, because no document
  requires per-rule citations and the research matrix cites per crop, not per
  threshold.
- The research matrix records that several Indonesian sources (ITB/UB/Unhas/UNY/IPB
  items) still lack author/year/URL. Those thresholds cannot be seeded into a
  published profile until the citations resolve — the schema makes that failure
  loud instead of accepting a half-citation.
