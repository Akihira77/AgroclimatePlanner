# Tables — Identity, Tenancy, and Field Operations

Seven tables. Three exist already (`users`, `farms`, `fields`, Phase 2.2.3) and are
specified here exactly as implemented; four are specified for Phase 3.

All seven are tenant-owned except `users`, which *is* the tenant. Every one of them
carries `ENABLE` + `FORCE ROW LEVEL SECURITY` and the same policy shape
(`ownership-and-rls.md` §3).

---

## 1. `app.users`

| | |
|---|---|
| Entity | `User` (`domain-model.md` §2) |
| Class | identity |
| Ownership key | `id` — the row is the tenant |
| Purpose | the account: credentials, locale, and the id every tenant-owned row points at |
| Lifecycle | created by registration; never deleted in v1 (`OPEN-04`); `role` mutable by an admin |
| Exists | yes (Phase 2.2.3) |

| Column | Type | Null | Default | Meaning |
|---|---|---|---|---|
| `id` | `uuid` | no | `uuidv7()` | PK; the tenant id used in `app.user_id` |
| `email` | `text` | no | — | login identifier, stored lower-cased by the application |
| `password_hash` | `text` | no | — | argon2id encoded string (`domain-model.md` §2) |
| `locale` | `text` | no | `'id'` | BCP 47 tag for UI copy |
| `timezone` | `text` | no | `'Asia/Jakarta'` | IANA zone used for every calendar-date interpretation belonging to this user |
| `role` | `text` | no | `'owner'` | `CHECK (role IN ('owner','admin'))` |
| `created_at` | `timestamptz(6)` | no | `now()` | — |
| `updated_at` | `timestamptz(6)` | no | `now()` | — |

Constraints:

| Name | Definition | Invalid state prevented |
|---|---|---|
| `users_pkey` | `PRIMARY KEY (id)` | duplicate identity |
| `users_email_key` | `UNIQUE (email)` | two accounts, one mailbox |
| `users_email_shape_check` | `position('@' IN email) > 1 AND email !~ '\s'` | a stored non-address; deliverability is not the database's claim |
| `users_role_check` | `role IN ('owner','admin')` | a role no code path authorizes |

Indexes: `users_email_key` (unique) is the only one. No index on `created_at` —
nothing sorts accounts.

Notes:

- `timezone` is per-user but every derived calendar date in this model is
  interpreted in `Asia/Jakarta` (`temporal-and-weather-semantics.md` §2). The
  column exists because a user may move; v1 has no second zone in which windows
  are *computed*.
- No `deleted_at`. A soft-deleted account with a unique email would block
  re-registration forever; account deletion is `OPEN-04` and is not pre-shaped
  here by a nullable column that would then need a partial unique index.
- `app_api` has **no** grant on this table. The login lookup is `OPEN-01`;
  `ownership-and-rls.md` §5 evaluates the options and implements none of them.

---

## 2. `app.farms`

| | |
|---|---|
| Entity | `Farm` (`domain-model.md` §2) |
| Class | tenant |
| Ownership key | `user_id` |
| Purpose | a grouping of fields — the UI's unit of navigation, not a decision unit |
| Lifecycle | created/edited freely; soft-deleted; its fields are decision units and survive it until individually deleted |
| Exists | yes (Phase 2.2.3) |

| Column | Type | Null | Default | Meaning |
|---|---|---|---|---|
| `id` | `uuid` | no | `uuidv7()` | PK |
| `user_id` | `uuid` | no | — | owner; FK → `users.id` |
| `name` | `text` | no | — | display name |
| `region` | `text` | **yes** | — | free-text administrative area, e.g. `"Kec. Ciawi, Bogor"`; not a normalized region table (v1). Nullable as implemented — no check requires a region |
| `notes` | `text` | yes | — | free text |
| `created_at` | `timestamptz(6)` | no | `now()` | — |
| `updated_at` | `timestamptz(6)` | no | `now()` | — |
| `deleted_at` | `timestamptz(6)` | yes | — | soft delete; `NULL` = live |

Constraints:

| Name | Definition | Invalid state prevented |
|---|---|---|
| `farms_pkey` | `PRIMARY KEY (id)` | — |
| `farms_user_id_fkey` | `FOREIGN KEY (user_id) REFERENCES app.users (id)` | a farm owned by nobody |
| `farms_id_user_id_key` | `UNIQUE (id, user_id)` | the composite-FK target `fields_farm_owner_fkey` requires |

Indexes: `farms_user_id_idx` on `(user_id) WHERE deleted_at IS NULL` — the only
query is "list my live farms".

Notes:

- No unique constraint on `(user_id, name)`. Two farms may share a name; enforcing
  uniqueness on a display string is a support ticket, not an invariant.
- `region` is deliberately not a geography column. Farm location is not a decision
  input; the field geometry is (`spatial-model.md` §1).

---

## 3. `app.fields`

| | |
|---|---|
| Entity | `Field` (`domain-model.md` §2) — **the decision unit** |
| Class | tenant |
| Ownership key | `user_id`, denormalised from `farms` |
| Purpose | the plot a recommendation is computed for: geometry, soil, irrigation |
| Lifecycle | soft-deleted; geometry edits supersede its resolution rows and invalidate derived artifacts via `fieldSnapshotHash` |
| Exists | yes (Phase 2.2.3) |

| Column | Type | Null | Default | Meaning |
|---|---|---|---|---|
| `id` | `uuid` | no | `uuidv7()` | PK |
| `user_id` | `uuid` | no | — | owner; denormalised so RLS compares a column |
| `farm_id` | `uuid` | no | — | parent farm; composite FK with `user_id` |
| `name` | `text` | no | — | display name; `CHECK (length(btrim(name)) > 0)` |
| `geom` | `geometry(Geometry, 4326)` | no | — | the plot; see `spatial-model.md` |
| `area_ha` | `double precision` | **yes** | generated | `GENERATED ALWAYS AS (ST_Area(geom::geography) / 10000.0) STORED`; see footnote |
| `elevation_m` | `numeric(7,2)` | yes | — | `CHECK (BETWEEN -500 AND 6000)`; unknown ≠ 0 |
| `soil_type` | `text` | yes | — | vocabulary unsettled, `OPEN-21` |
| `soil_ph` | `numeric(3,1)` | yes | — | `CHECK (BETWEEN 3.0 AND 10.0)`; unknown ≠ neutral |
| `drainage_class` | `text` | yes | — | vocabulary unsettled, `OPEN-21` |
| `irrigation_availability` | `text` | yes | — | vocabulary unsettled, `OPEN-21`; see note below |
| `water_source` | `text` | yes | — | free text (`"irrigation canal"`, `"rainfed"`, `"well"`) |
| `cropping_history_notes` | `text` | yes | — | free text; the structured history is `plantings` |
| `created_at` | `timestamptz(6)` | no | `now()` | — |
| `updated_at` | `timestamptz(6)` | no | `now()` | — |
| `deleted_at` | `timestamptz(6)` | yes | — | soft delete |

### `area_ha` nullability — what is declared and what merely follows

The migration declares:

```sql
area_ha double precision GENERATED ALWAYS AS (public.ST_Area(geom::public.geography) / 10000.0) STORED
```

There is **no `NOT NULL` on this column.** Measured against the running database:

```sql
select column_name, is_nullable, is_generated, generation_expression
from information_schema.columns
where table_schema = 'app' and table_name = 'fields' and column_name = 'area_ha';
-- area_ha | YES | ALWAYS | (st_area((geom)::geography) / (10000.0)::double precision)

select attnotnull from pg_attribute
where attrelid = 'app.fields'::regclass and attname = 'area_ha';
-- f
```

Three distinct facts, which the earlier version of this document conflated:

| Claim | Status |
|---|---|
| the column is `NOT NULL` in the DDL | **false** — `is_nullable = YES`, `attnotnull = false` |
| a stored value is always present | **true in practice** — `geom` is `NOT NULL` and constrained valid and non-empty, and `ST_Area` of such a geometry returns a number |
| the value is always *meaningful* | **false for a `POINT`** — it is `0`, which is exactly `OPEN-17` |

The difference matters for a consumer: a client reading `area_ha` cannot treat
"non-null" as "a real area". Nullability is a DDL property, and this column has
none — its non-nullness is a consequence of its input, not a constraint.

Note also that PostgreSQL stores the parsed expression without schema
qualification (`st_area((geom)::geography)`), even though the migration **must**
write `public.ST_Area` / `public.geometry` because the migration connection's
`search_path` is `app` (`spatial-model.md` §1). The qualification is a migration
requirement, not a stored property.

Constraints:

| Name | Definition | Invalid state prevented |
|---|---|---|
| `fields_pkey` | `PRIMARY KEY (id)` | — |
| `fields_id_user_id_key` | `UNIQUE (id, user_id)` | composite-FK target for children |
| `fields_farm_owner_fkey` | `FOREIGN KEY (farm_id, user_id) REFERENCES app.farms (id, user_id)` | a field attached to another tenant's farm |
| `fields_geom_type_check` | `GeometryType(geom) IN ('POINT','POLYGON','MULTIPOLYGON')` | a geometry type no code path can evaluate |
| `fields_geom_srid_check` | `ST_SRID(geom) = 4326` | a plot in a projected CRS, silently 100 000× the wrong size |
| `fields_geom_valid_check` | `ST_IsValid(geom)` | a self-intersecting polygon whose area is undefined |
| `fields_geom_not_empty_check` | `NOT ST_IsEmpty(geom)` | a field with no location |
| `fields_name_not_blank_check` | `length(btrim(name)) > 0` | an unnamed plot in every dropdown |
| `fields_elevation_range_check` | `elevation_m BETWEEN -500 AND 6000` | a unit error (feet pasted into metres) |
| `fields_soil_ph_range_check` | `soil_ph BETWEEN 3.0 AND 10.0` | a pH that is not a pH |

Indexes: `fields_user_id_idx` on `(user_id) WHERE deleted_at IS NULL`;
`fields_farm_id_idx` on `(farm_id) WHERE deleted_at IS NULL`;
`fields_geom_gist_idx` using `gist (geom)` — the last one is currently unused by any
query and exists because spatial predicates are planned in Phase 6; recorded as
`OPEN-22` rather than justified retroactively (`indexes-and-query-patterns.md` §4).

Notes:

- **`irrigation_availability` is text and `FieldSnapshot.irrigationAvailable` is
  boolean.** No document defines the mapping, so it is `OPEN-21` and this
  specification does not invent one. `field_snapshot` stores the boolean the
  contract requires; the conversion lives in the application and must be reviewed
  once the vocabulary is agreed. This is the single most consequential open item in
  the identity group, because a wrong conversion silently changes every window's
  `fieldSnapshotHash` and every suitability verdict that depends on water.
- `water_source` is the physical home of `FieldSnapshot.irrigationSource`.
- No `user_id` update path: the policy's `WITH CHECK` makes a transfer impossible.

---

## 4. `app.field_outlook_cells`

| | |
|---|---|
| Entity | field → cell resolution (`domain-model.md` §2 invariant, `data-flow.md` §2) |
| Class | tenant (it names a tenant's field) |
| Ownership key | `user_id` |
| Purpose | which provider cell serves which field, with the distance and the extraction policy used — stored, not recomputed on read |
| Lifecycle | one live row per `(field_id, provider, model)`; a geometry edit supersedes them and inserts replacements; never hard-deleted while the field exists |
| Exists | no (Phase 3) |

| Column | Type | Null | Default | Meaning |
|---|---|---|---|---|
| `id` | `uuid` | no | `uuidv7()` | PK |
| `user_id` | `uuid` | no | — | owner, denormalised |
| `field_id` | `uuid` | no | — | composite FK with `user_id` |
| `outlook_cell_id` | `uuid` | no | — | FK → `outlook_cells.id` |
| `provider` | `text` | no | — | denormalised from the cell so the live-uniqueness index can exist |
| `model` | `text` | no | — | same |
| `extraction_policy` | `text` | no | — | `CHECK (IN ('centroid','area_weighted'))` |
| `distance_km` | `double precision` | no | — | `CHECK (>= 0)`; field anchor to served coordinate |
| `elevation_delta_m` | `double precision` | yes | — | served cell elevation minus `fields.elevation_m`; `NULL` when either is unknown |
| `resolved_at` | `timestamptz(6)` | no | `now()` | when this resolution was computed |
| `superseded_at` | `timestamptz(6)` | yes | — | set when the field geometry changed |

Constraints:

| Name | Definition | Invalid state prevented |
|---|---|---|
| `field_outlook_cells_pkey` | `PRIMARY KEY (id)` | — |
| `field_outlook_cells_field_owner_fkey` | `FOREIGN KEY (field_id, user_id) REFERENCES app.fields (id, user_id)` | resolving another tenant's field |
| `field_outlook_cells_cell_fkey` | `FOREIGN KEY (outlook_cell_id) REFERENCES app.outlook_cells (id)` | a dangling resolution |
| `field_outlook_cells_extraction_policy_check` | `extraction_policy IN ('centroid','area_weighted')` | an unhandled policy name reaching the engine |
| `field_outlook_cells_distance_check` | `distance_km >= 0` | a sign error that would hide a 900 km mismatch |

Indexes:

| Name | Definition | Query |
|---|---|---|
| `field_outlook_cells_live_key` | `UNIQUE (field_id, provider, model) WHERE superseded_at IS NULL` | at most one live cell per provider grid per field |
| `field_outlook_cells_cell_idx` | `(outlook_cell_id)` | "which fields does this cell serve" — the fan-out query in `background-processing.md` §7 |
| `field_outlook_cells_field_idx` | `(field_id)` | loading a field's resolutions |

Notes:

- **This table is the normalised form of the tuple in `data-flow.md` §2**
  (`fieldId, provider, model, cellKey, servedLat, servedLon, distanceKm,
  elevationDeltaM`). Decision `D1`: the provider-grid half belongs to the cell and
  is shared by every field in it, so it lives in `outlook_cells`; only the
  field-specific half lives here. Keeping `servedLat`/`servedLon` on this row would
  duplicate a provider fact once per field and let two fields in the same cell
  disagree about where the cell is.
- The deviation matters for `ResolvedCell` in `field_snapshot`, which carries
  `servedLat`/`servedLon` **and** `distanceKm` in one object. The snapshot is built
  by joining the two tables at compute time, and the join is the reason
  `outlook_cells.served_lat` must be `NOT NULL` once a run has been ingested
  (`tables-climate.md` §1 records the two-phase fill).
- Live uniqueness is a partial index because history is retained. A superseded
  row's `distance_km` records what was true then; overwriting it would make an old
  `fieldSnapshotHash` unexplainable.
- Nothing here is written by `app_system`. Resolution is computed on the write path
  from the rounding rule, inside `withTenant`, so a field creation costs one
  `INSERT … ON CONFLICT DO NOTHING` and no provider call.

---

## 5. `app.field_observations`

| | |
|---|---|
| Entity | `FieldObservation` (`domain-model.md` §6) |
| Class | tenant |
| Ownership key | `user_id` |
| Purpose | the only source that may be displayed as an observation — user-entered measurements, never provider data |
| Lifecycle | created by the user; editable and deletable while the field is live; feeds `fieldSnapshot.observationsUsed` |
| Exists | no (Phase 3) |

| Column | Type | Null | Default | Meaning |
|---|---|---|---|---|
| `id` | `uuid` | no | `uuidv7()` | PK; appears as `observationId` in provenance |
| `user_id` | `uuid` | no | — | owner, denormalised |
| `field_id` | `uuid` | no | — | composite FK with `user_id` |
| `kind` | `text` | no | — | `CHECK (IN ('rainfall','soil_moisture','temperature','note'))` |
| `value` | `double precision` | yes | — | measurement; `NULL` only when `kind = 'note'` |
| `unit` | `text` | yes | — | e.g. `mm`, `°C`, `%`; `NULL` only when `kind = 'note'` |
| `observed_at` | `timestamptz(6)` | no | — | when the measurement was taken — not when it was entered |
| `method` | `text` | yes | — | `"manual gauge"`, `"soil probe"`, `"estimate"`; free text |
| `entered_by` | `uuid` | no | — | the acting account |
| `created_at` | `timestamptz(6)` | no | `now()` | — |
| `updated_at` | `timestamptz(6)` | no | `now()` | — |

Constraints:

| Name | Definition | Invalid state prevented |
|---|---|---|
| `field_observations_pkey` | `PRIMARY KEY (id)` | — |
| `field_observations_field_owner_fkey` | `FOREIGN KEY (field_id, user_id) REFERENCES app.fields (id, user_id)` | observing another tenant's field |
| `field_observations_kind_check` | `kind IN ('rainfall','soil_moisture','temperature','note')` | a kind the snapshot cannot classify |
| `field_observations_value_presence_check` | `(kind = 'note' AND value IS NULL AND unit IS NULL) OR (kind <> 'note' AND value IS NOT NULL AND unit IS NOT NULL)` | a measurement without a unit (uninterpretable), or a note with a number (unreadable) |
| `field_observations_entered_by_check` | `entered_by = user_id` | v1 has no shared access, so a second actor is a modelling error — `D7` |
| `field_observations_observed_at_check` | `observed_at <= now() + interval '1 day'` | a future measurement entered by typo |

Indexes:

| Name | Definition | Query |
|---|---|---|
| `field_observations_field_time_idx` | `(field_id, observed_at DESC)` | "recent observations for this field", and the snapshot's `observationsUsed` window |

Notes:

- `entered_by` becomes meaningful when shared access exists. The `CHECK` is v1-only
  and its removal is the migration that introduces a second actor — which is also
  the change that makes `user_id` (owner) and `entered_by` (actor) genuinely
  different columns.
- No unique constraint on `(field_id, observed_at, kind)`. Two rain gauges read at
  10:00 are two observations, and `observationsUsed` dedupes by id, not by tuple.
- `value` is `double precision` for the same reason provider values are: a
  user-read gauge value is a measurement, and a `recordSetHash`/`fieldSnapshotHash`
  over it must reproduce exactly.

---

## 6. `app.plantings`

| | |
|---|---|
| Entity | `Planting` (`domain-model.md` §6) |
| Class | tenant |
| Ownership key | `user_id` |
| Purpose | what is actually growing, when it started, and on which cycle basis — the input that makes a recommendation specific to a season |
| Lifecycle | created at sowing/transplant; status advances; never deleted while history matters |
| Exists | no (Phase 3) |

| Column | Type | Null | Default | Meaning |
|---|---|---|---|---|
| `id` | `uuid` | no | `uuidv7()` | PK |
| `user_id` | `uuid` | no | — | owner, denormalised |
| `field_id` | `uuid` | no | — | composite FK with `user_id` |
| `cultivar_id` | `uuid` | no | — | FK → `cultivars.id` (global) |
| `planted_at` | `date` | no | — | sowing or transplant date, whichever `cycle_start_used` says |
| `cycle_start_used` | `text` | no | — | `CHECK (IN ('sowing','transplant'))`; a cultivar may allow both, the row records which |
| `area_planted_ha` | `double precision` | no | — | `CHECK (> 0)`; may be smaller than `fields.area_ha` |
| `status` | `text` | no | `'active'` | vocabulary unsettled — `OPEN-09`; **not** checked until it is |
| `created_at` | `timestamptz(6)` | no | `now()` | — |
| `updated_at` | `timestamptz(6)` | no | `now()` | — |

Constraints:

| Name | Definition | Invalid state prevented |
|---|---|---|
| `plantings_pkey` | `PRIMARY KEY (id)` | — |
| `plantings_id_user_id_key` | `UNIQUE (id, user_id)` | composite-FK target for `harvests` |
| `plantings_field_owner_fkey` | `FOREIGN KEY (field_id, user_id) REFERENCES app.fields (id, user_id)` | planting in another tenant's field |
| `plantings_cultivar_fkey` | `FOREIGN KEY (cultivar_id) REFERENCES app.cultivars (id)` | an anonymous variety |
| `plantings_cycle_start_check` | `cycle_start_used IN ('sowing','transplant')` | a cycle basis the duration model cannot apply |
| `plantings_area_check` | `area_planted_ha > 0` | a zero-area planting |

Indexes:

| Name | Definition | Query |
|---|---|---|
| `plantings_field_idx` | `(field_id, planted_at DESC)` | "what is growing here" and the priority rule in `background-processing.md` §7 |
| `plantings_active_idx` | `(user_id, field_id) WHERE status = 'active'` | near-term field prioritisation — depends on `OPEN-09` naming `active` |

Notes:

- **`expectedHarvestAt` is deliberately absent.** `domain-model.md` §6 lists it as
  "derived, not stored as truth". It is computed from `cultivars.duration_days_*`
  and `planted_at` at read time. Storing it would create a second answer that goes
  stale the moment a cultivar's duration is corrected.
- `status` has no `CHECK` because its vocabulary is not established. Adding one
  later is a migration; guessing now would put an unapproved enum into the schema
  and into the partial index above.

---

## 7. `app.harvests`

| | |
|---|---|
| Entity | `Harvest` (`domain-model.md` §6) |
| Class | tenant |
| Ownership key | `user_id` |
| Purpose | realised yield per picking event |
| Lifecycle | appended per picking; edited only to correct an entry; hard-deleted with its planting |
| Exists | no (Phase 3) |

| Column | Type | Null | Default | Meaning |
|---|---|---|---|---|
| `id` | `uuid` | no | `uuidv7()` | PK |
| `user_id` | `uuid` | no | — | owner, denormalised |
| `planting_id` | `uuid` | no | — | composite FK with `user_id` |
| `harvested_at` | `date` | no | — | picking date |
| `yield_kg` | `numeric(10,2)` | no | — | `CHECK (>= 0)`; 0 is legal (a failed picking is data) |
| `notes` | `text` | yes | — | free text |
| `created_at` | `timestamptz(6)` | no | `now()` | — |
| `updated_at` | `timestamptz(6)` | no | `now()` | — |

Constraints:

| Name | Definition | Invalid state prevented |
|---|---|---|
| `harvests_pkey` | `PRIMARY KEY (id)` | — |
| `harvests_planting_owner_fkey` | `FOREIGN KEY (planting_id, user_id) REFERENCES app.plantings (id, user_id)` | harvesting another tenant's planting |
| `harvests_yield_check` | `yield_kg >= 0` | a negative yield |

Indexes:

| Name | Definition | Query |
|---|---|---|
| `harvests_planting_idx` | `(planting_id, harvested_at DESC)` | yield history for a planting |
| `harvests_user_time_idx` | `(user_id, harvested_at DESC)` | per-season totals — `D23` |

Notes:

- **Many harvests per planting**, no `UNIQUE (planting_id)`. Cabai is picked
  repeatedly over weeks (first harvest 90–110 HST, then ongoing); a one-to-one rule
  would make the model unusable for one of the four v1 crops.
- `yield_kg` is `numeric`, not `double precision`: it is aggregated (sum, mean per
  season) and reported to the user as a figure, so decimal semantics beat binary
  round-tripping. Nothing hashes it.
