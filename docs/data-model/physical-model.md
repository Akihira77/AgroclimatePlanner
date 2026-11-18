# Physical Model — Shared Conventions

These rules apply to all 22 tables. The per-table documents state columns and
constraints; this document states the grammar they are written in. A table that
deviates without a recorded decision is a defect.

## 1. Naming

| Element | Convention | Example |
|---|---|---|
| schema | `app`, always, never `public` | `app.fields` |
| table | plural `snake_case` | `planting_windows` |
| column | singular `snake_case` | `window_start` |
| primary key | `id` | `app.farms.id` |
| foreign key column | `<referent singular>_id` | `suitability_run_id` |
| composite FK | every participating column named after its target | `(farm_id, user_id)` |
| constraint | `<table>_<purpose>_<suffix>`, suffix ∈ `key` `fkey` `check` | `fields_farm_owner_fkey` |
| index | `<table>_<columns>_idx` | `weather_records_lookup_idx` |
| policy | `<table>_<purpose>` | `fields_tenant_isolation` |
| trigger | `<table>_<purpose>` | `crop_profile_versions_immutable` |
| sequence | none — identifiers are `uuidv7()`, never `serial` | — |

Quoted identifiers are forbidden: every name here is lower-case `snake_case` and
needs no quoting. That is one fewer class of bug in every hand-written migration.

## 2. Identifiers

```sql
id uuid PRIMARY KEY DEFAULT uuidv7()
```

- Native `uuidv7()` (PostgreSQL 18), guarded by the existing
  `to_regprocedure('pg_catalog.uuidv7()')` check in the baseline migration. No
  application-generated ids, no ULID, no sequence.
- Time-ordered, so the primary key index has insertion locality; that is why the
  same type is used for the URL and for `app.user_id` (`api-conventions.md` §1).
- Natural keys (`forecast_runs`' four-tuple, `crops.slug`, `outlook_cells`'
  three-tuple) are **unique constraints, not primary keys**. Persisting a natural
  key as an id duplicates what the unique constraint already guarantees and puts
  a mutable-looking string into every provenance record
  (`provenance-contract.md` §3).
- Cross-table references always use the `uuid`. A `cell_key` or `slug` is joined
  by value only where the natural key *is* the identity, and even there the
  referencing column is a foreign key to the id (`field_outlook_cells` →
  `outlook_cells.id`, not to `cell_key`).

## 3. Time

| Meaning | Type | Notes |
|---|---|---|
| an instant (observation, initialisation, computation) | `timestamptz(6)` | stored UTC; column default `now()` |
| a calendar day (window start, planting date, month key) | `date` | interpreted in `Asia/Jakarta` by every consumer |
| a duration or lead time | `integer` + unit suffix in the name (`_days`) | never a text interval |

`timestamptz(6)` rather than `timestamptz` (microsecond precision is the default
anyway, stated explicitly so it survives a future server default change). There is
no `timestamp` without time zone anywhere: a naive timestamp is a bug that only
shows up in a timezone with a half-hour offset.

Month keys are `date` constrained to the first day of the month
(`CHECK (EXTRACT(DAY FROM month) = 1)`) rather than `text` `YYYY-MM` or an integer
`YYYYMM`. It sorts correctly, it validates itself, and it cannot disagree with
`date_trunc`.

### Timestamp representation is preserved, not normalised

`provenance-contract.md` §4 requires that `2026-11-18T00:00:00Z` and
`2026-11-18T00:00:00.000Z` hash differently — the provenance record says what the
provider published. A `timestamptz` column cannot preserve that distinction: both
spellings become the same microsecond value.

Consequence, and it is deliberate: **any timestamp that participates in a hash
preimage is carried inside a JSONB contract document as the original string**, and
the `timestamptz` column beside it is for querying only. `input_refs`,
`field_snapshot`, and `evidence_segments` all carry their own ISO strings
(`provenance-storage.md` §5). A hash computed from the column would be a hash of a
normalised value, and the golden vectors would fail.

## 4. Numbers, units, and precision

| Kind | Type | Why |
|---|---|---|
| measured provider value (`weather_records.value_mm`, `monthly_outlooks.value_mm`) | `double precision` | must round-trip exactly as received; `numeric` would rewrite `0.30000000000000004` into `0.3` and change a `recordSetHash` |
| agronomic threshold (`constraints.value_min`) | `numeric(6,2)` | curated by a human, compared with tolerance, needs exact decimal semantics |
| derived quantity (`fields.area_ha`) | `double precision` | computed by PostGIS from the geometry; there is one definition and it is not re-rounded |
| coordinate (`served_lat`, `requested_lon`) | `double precision` | never `numeric`: providers publish floats and a served coordinate is a measurement |
| money, ids, durations | not present | — |

Every quantity column carries its unit in the name: `_mm`, `_m`, `_ha`, `_kg`,
`_km`, `_percent`, `_days`, `_celsius`, `_ph`. A column called `value` exists only
in the JSONB contracts, where the sibling `unit` field says what it is.

**Rounding policy: none at the storage layer.** Nothing rounds, truncates, or
pads on write. Rounding is a presentation decision and belongs to the API formatter,
because a rounded database cannot reproduce a `recordSetHash` computed from the
unrounded payload.

## 5. Enumerations

Enums are `text` columns with a named `CHECK (column IN (…))`, not PostgreSQL
`enum` types.

Rationale: the contract enums live in `packages/contracts/src/enums.ts` and are the
single source of truth. A PostgreSQL enum would be a second copy that `ALTER TYPE …
ADD VALUE` can only append to (inside a transaction it cannot be removed, reordered,
or renamed), so a corrected union in TypeScript would require a migration that
cannot be rolled back. A `CHECK` is drop-and-recreate.

The `CHECK` list must equal the contract list **exactly and in the same order as
written in the contract file**, so a diff of the two is a mechanical review. Where
a column stores a contract enum, the table specification names the contract symbol
(e.g. `WeatherDataClass`) rather than re-listing the values.

Two additional rules:

1. Adding a value to a contract enum requires a migration in the same change.
   Otherwise the database rejects data the types declare valid — a failing write is
   better than a silently unrepresentable value, but both are defects.
2. A `CHECK` never contains a value the contract does not have. No "legacy" value
   is kept for old rows; the migration that adds one is also the migration that
   backfills.

## 6. Hash and version columns

```sql
input_snapshot_hash text NOT NULL
  CHECK (input_snapshot_hash ~ '^[0-9a-f]{64}$')
```

- `text`, lowercase hex, exactly 64 characters. Not `bytea`: the value is
  compared for equality, joined against, and pasted into logs and support
  conversations; hex is the representation the contract already defines
  (`provenance-contract.md` §4, "lowercase hexadecimal, 64 characters").
- Version columns (`derivation_version`, `engine_version`, `rule_version`,
  `prompt_version`, `model_id`, `adapter_version`, `normalizer_version`,
  `baseline_version`, `dataset_version`) are `text NOT NULL` with
  `CHECK (btrim(x) <> '')`. Their *scheme* is a semver or provider string; the
  database does not parse them, because a version scheme that the database
  enforces is a version scheme nobody can change.
- `ingestion_version` is one of these, and is the identity component of
  `ingestion_runs` — see `tables-climate.md` §3.

## 7. JSONB: when it is allowed, and when it is not

JSONB is used for **contract documents that are hashed as a whole** and for
nothing else. The test is mechanical:

> If a field inside the document participates in a canonical-JSON hash preimage,
> it must be stored as a document, because shredding it creates a second
> serialiser and the hash would then be computed from a reconstruction rather
> than from the bytes that were hashed.

The seven JSONB columns in this model, and the justification for each:

| Column | Table | Why not relational |
|---|---|---|
| `input_refs` | `monthly_outlooks`, `suitability_runs`, `planting_windows`, `ai_briefings` | a four-variant discriminated union; flattening it produces nullable columns that can express states the union forbids (`provenance-contract.md` §4) |
| `field_snapshot` | `suitability_runs`, `planting_windows`, `ai_briefings` | the exact preimage of `fieldSnapshotHash`; a reconstruction would not hash identically |
| `evidence_segments` | `planting_windows` | ordered sequence whose position is semantic; a child table would need an explicit ordinal that the canonicaliser must not sort (`provenance-contract.md` §4) |
| `missing_ranges` | `planting_windows`, `monthly_outlooks` | same partition invariant, small, never queried by range |
| `dimension_coverage` | `suitability_runs` | a five-element closed set; a table would add a join to read five values |
| `body` | `ai_briefings` | generated natural-language structure validated against a contract schema; its shape changes with `prompt_version` |
| `error` | `ingestion_runs` | `{ code, message, payloadRef }`, only read when a run failed |

Everything else is a typed column. In particular these are **not** JSONB:
`variables`, crop thresholds, geometry, attribution, provider metadata, or any
value a query filters on. A JSONB column is never indexed with GIN in this model,
because no query in `indexes-and-query-patterns.md` filters inside one — if a
future query needs that, the field should become a column instead.

Every JSONB document is validated against its Zod schema at the application
boundary before write. The database stores it; it does not re-implement the
schema as a check constraint beyond `jsonb_typeof(...) = 'object'` or `'array'`.

## 8. Standard columns

| Column | Applies to | Definition |
|---|---|---|
| `created_at` | every table | `timestamptz(6) NOT NULL DEFAULT now()` |
| `updated_at` | mutable tables only | `timestamptz(6) NOT NULL DEFAULT now()`, maintained by the application |
| `deleted_at` | `farms`, `fields` only | `timestamptz(6)`, soft delete |

`updated_at` is **not** maintained by a trigger in Phase 3. Prisma's `@updatedAt`
fills it on ORM writes; a raw SQL write must set it explicitly, and the review
checklist for any raw write includes that. A trigger would be more robust and is
the better answer — it is deferred because it silently changes behaviour for
existing raw paths (including the fixture inserts in the test suite) and deserves
its own decision rather than riding along here. Thence `OPEN-19`.

Immutable tables (`weather_records` apart from its supersession markers,
`source_refs`, published profile versions) carry `created_at` only. A column that
claims to record modification on a row nobody may modify is a lie the schema tells.

## 9. Nullability

`NOT NULL` is the default posture; every nullable column in this model is listed
with the reason it is nullable, in the table specification. Three categories are
never nullable:

- ownership (`user_id`), identifiers, and foreign keys;
- anything in a hash preimage that the contract requires;
- `recorded_at`/`computed_at`/`created_at`.

`NULL` inside a JSONB document means "unknown" and is preserved as `null`, never
normalised to a default — `provenance-contract.md` §4 is explicit that the agronomy
engine distinguishes "unknown" from "known to be neutral", and that distinction is
what produces `insufficient_data` instead of a fabricated score.

Conversely, a nullable column whose `NULL` would be interpreted as "zero" or
"neutral" by any consumer is a modelling error. `fields.soil_ph` is nullable and
means unknown; `fields.elevation_m` is nullable and means unknown. Neither is ever
read as a default value.

## 10. Referential integrity with ownership

Every relationship between two tenant-owned tables uses a composite key that
carries ownership:

```sql
UNIQUE (id, user_id)                                     -- on the parent
FOREIGN KEY (parent_id, user_id) REFERENCES parent (id, user_id)
```

`fields` already does this (`fields_farm_owner_fkey`). Every new tenant-owned
child follows it. The two effects:

1. A tenant cannot attach a child to another tenant's parent by writing its own
   `user_id` — the pair must exist in the parent.
2. The failure is a **referential integrity** violation (`23503`), which is a
   different SQLSTATE from an RLS denial (`42501`). Tests assert the specific one,
   because reporting both as "rejected" hides which boundary failed
   (`provenance-contract.md` §2 and the Phase 2.2.3 suite).

The redundant `user_id` on the child is intentional and is the reason RLS compares
a column instead of joining (`system-architecture.md` §8).

## 11. Ownership column

Every tenant table has exactly one `user_id uuid NOT NULL` that:

- is the RLS predicate (`user_id = NULLIF(current_setting('app.user_id', true), '')::uuid`);
- participates in every composite foreign key to another tenant table;
- is never updated. `CHECK`-free but review-enforced: an ownership transfer is a
  delete-and-insert, not an update, because it changes who may read history. No
  policy grants `UPDATE` on `user_id` in practice — the `WITH CHECK` clause would
  reject the result unless the new value equals the current context, which makes a
  transfer impossible by construction rather than by convention.

## 12. Charset and case

`text` columns are UTF-8, no `citext`, no case folding. Email uniqueness is on the
lower-cased value written by the application (`users_email_key` on `email`), and
the email is validated for shape only (`position('@' in email) > 1 AND email !~ '\s'`)
— deliverability is the verification-mail flow's job, not the database's.
