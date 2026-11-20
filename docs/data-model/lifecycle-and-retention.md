# Lifecycle and Retention

For every entity group: how a row is created, how it is replaced, how it is
removed, and what is deliberately never removed.

The model has exactly three removal mechanisms and no others:

| Mechanism | Applies to | Reversible |
|---|---|---|
| **supersession** (`status = 'superseded'`, `superseded_by_id`) | derived artifacts, weather values, outlooks | yes — the old row is intact |
| **soft delete** (`deleted_at`) | `farms`, `fields` | yes — `deleted_at = NULL` |
| **nothing** | catalog, runs, cells, normals, observations, plantings, harvests | n/a |

`ON DELETE CASCADE` appears nowhere. A cascade is a data-loss path that fires on
a mistake, and no product requirement asks for one.

## 1. Identity and tenancy

| Entity | Created by | Replaced by | Removed by |
|---|---|---|---|
| `users` | registration (Phase 3 auth) | `role` / `locale` / `timezone` update in place | **nothing** — `OPEN-04` |
| `farms` | user action | update in place | soft delete |
| `fields` | user action | update in place; a geometry change supersedes its resolutions | soft delete |
| `field_outlook_cells` | field create/edit, inside `withTenant` | geometry edit → new rows, old ones `superseded_at` | never while the field exists |
| `field_observations` | user entry | edit or delete, both allowed while the field is live | hard delete by the user |
| `plantings` | user action | status change | never — history is the point |
| `harvests` | user action | correction edit | hard delete with the user's intent |

### Account deletion — `OPEN-04`, P1

`users` has no `deleted_at` and no deletion policy. The three options each have a
different cost, and no document chooses:

| Option | Consequence |
|---|---|
| soft delete + partial unique on email | re-registration with the same address becomes possible; every `SELECT` on `users` grows a filter |
| hard delete through an application-managed workflow — dependent rows removed explicitly, never by `ON DELETE CASCADE` (`D16`) | destroys the provenance chain of every artifact the account produced; a stored `inputSnapshotHash` becomes unexplainable |
| anonymise (strip email/hash, keep id) | preserves provenance; the account cannot log in; the email is freed; needs a partial unique index anyway |

The last is the only option compatible with this model's own reproducibility
rule, but it is a policy decision about user data, not a schema convenience. It
is not pre-shaped by a nullable column, because that column would then need a
partial unique index that presumes the answer.

### Soft-delete consequences that are already decided

- `farms.deleted_at` and `fields.deleted_at` are `timestamptz`, `NULL` = live.
- Every partial index on those tables carries `WHERE deleted_at IS NULL`, so the
  index does not accumulate dead weight.
- **A soft-deleted field is still readable by the tenant** (the policy does not
  filter `deleted_at`). Deletion is a UI concept; the row is still the tenant's.
  A hard `DELETE` is also permitted by the grant — RLS does not prevent a tenant
  from deleting their own field, and a derived artifact referencing it would then
  fail the composite FK (`23503`), which is the intended refusal rather than a
  cascade.
- `fields` deletion does **not** delete `suitability_runs` or `planting_windows`.
  That is why their FK is `NO ACTION`: history survives the field's removal only
  if the field row does. Since deletion is soft by default, this holds in
  practice; a hard delete of a field with history is refused by the database.

## 2. Weather plane

| Entity | Created by | Replaced by | Removed by |
|---|---|---|---|
| `outlook_cells` | field creation (identity triple) or first ingest (served coordinate) | `served_lat`/`served_lon`/`elevation_m`/`served_updated_at` updated in place | never |
| `forecast_runs` | ingest, upserted on the natural key | nothing — a run is immutable | never |
| `ingestion_runs` | ingest; one per `(forecast_run_id, ingestion_version)` | `attempt` increments in place; `status`, `finished_at`, `record_count`, `coverage_percent` update | never |
| `weather_records` | ingest | supersession on a normalizer change | never |
| `monthly_outlooks` | aggregation | superseded by a recompute | never |
| `climatology_normals` | baseline build | a new `baseline_version` — never an in-place edit | never |

### Why `weather_records` is never deleted

Three reasons, in order of weight:

1. **A stored `recordSetHash` must stay checkable.** Deleting the rows behind it
   turns every artifact that referenced them into an unverifiable claim.
2. **Supersession is sufficient.** A re-normalisation marks the old rows
   `superseded_at`; every live read filters them out, so correctness does not
   require removal.
3. **The cost is storage, and storage is the cheap resource** compared with a
   provenance record that cannot be audited.

Growth is `OPEN-16`, P2, and it is a real problem: one cell × one variable ×
hourly × 46 days × 51 ensemble members is ~56 000 rows per run, and
`ingest.forecast` runs hourly. Phase 3 will not hit it; Phase 4 will. The
resolution is a retention policy per `dataClass` (seasonal and subseasonal keep
their superseded rows; deterministic short-range may not need to), and it is
**not** decided here, because deleting rows is the one operation that can
retroactively falsify a stored hash.

### Raw provider payloads — `D12`, `OPEN-05`

`ingestion_runs.raw_payload_ref` is a `text` object-store key, nullable. It is
populated only when retention is permitted:

| Provider | Retention permitted | Source |
|---|---|---|
| BMKG | only with written permission; commercial integration is gated | `data-licensing-and-attribution.md` |
| Open-Meteo | data is CC BY 4.0; the free tier is non-commercial, so the plan choice gates commercial use | same |
| ECMWF | CC BY 4.0 with prescribed attribution; seasonal raw fields are not Open Data | same |
| CHIRPS | public domain / CC BY 4.0 | same |

Consequence: `reproducible = false` with reason `raw_payload_not_retained` is a
legal, expected state for artifacts built on a provider whose payload was not
retained. The model stores the claim and the reason rather than pretending
replayability it cannot deliver.

The object store itself is optional in the architecture and has no table. A
dangling `raw_payload_ref` (key with no object) is not detectable by the
database and is checked by the Phase 5 audit.

## 3. Catalog

| Entity | Created by | Replaced by | Removed by |
|---|---|---|---|
| `crops` | seed | update in place (name, category) — a `slug` never changes | never |
| `cultivars` | seed | update in place; a name is not renamed because `plantings` history refers to it | never |
| `crop_profile_versions` | admin draft | **a new row** with `supersedes_id`; the published row becomes `retired` | never |
| `growth_stages` | with its profile version | new version | never |
| `constraints` | with its profile version | new version | never |
| `source_refs` | with its profile version | new version | never |

Rules:

1. **Publication is one-way.** `draft → published → retired`. `published →
   draft` is refused by the immutability trigger (`D5`), which is specified and
   not yet created.
2. **Retiring does not rewrite history.** A retired profile still serves every
   artifact that names it. Retiring means "no new recommendation may choose this
   version" — enforced by the partial unique index on
   `cultivar_id WHERE status = 'published'`.
3. **Correcting a threshold means publishing a new version**, which changes
   `profile_version_id` in the next recompute's `inputSnapshotHash` and makes
   every older artifact's evaluation explainable rather than retroactively wrong.
4. **Nothing in the catalog is deleted.** A row that disappears takes the
   justification of every artifact that cited it.
5. **`migration_owner` is the only writer.** No runtime role holds an `INSERT`,
   `UPDATE`, or `DELETE` grant. That is half of the immutability enforcement and
   the whole of the seeding path (`D13`).

## 4. Derived artifacts

| Entity | Created by | Replaced by | Removed by |
|---|---|---|---|
| `suitability_runs` | `recompute.windows`, inside `withTenant(ownerId)` | superseded by a later run; the previous one becomes `superseded` | never |
| `planting_windows` | with its run | superseded by a later recompute | never |
| `ai_briefings` | `POST /v1/ai/briefing`, cached on `(field_id, input_snapshot_hash)` | superseded when the input hash changes | never |

### Append-and-supersede, never update

The sequence for one recompute, in order:

1. compute the new artifacts **outside** the transaction;
2. open `withTenant(ownerId)`;
3. insert the new `suitability_runs` row with `status = 'active'`;
4. update the previously active run to `status = 'superseded'`,
   `superseded_by_id = <new>`;
5. insert the windows with `status = 'active'`;
6. supersede the previous active windows the same way;
7. commit.

Steps 3–7 are one transaction, so a dashboard never observes two active runs for
a field: the partial unique index `suitability_runs_live_key` would reject the
second `INSERT` if the first were not demoted, which makes the ordering a
constraint rather than a convention.

**A failed recompute leaves the previous artifacts untouched.** Step 3 failing
rolls the whole transaction back; the previous `active` rows are still active. If
the failure happens before step 2 (in the compute step), nothing was written at
all. There is no state in which a field has no active run *because* a recompute
failed — it keeps the old one, with an old `computed_at` and a freshness derived
from its inputs, which is exactly what the freshness rules express.

### `status = 'failed'` exists but is not how failures are recorded

The three derived tables carry `CHECK (status IN ('active','superseded','failed'))`.
A `failed` row is only inserted when the engine produced a *result* that is
itself a failure (e.g. `insufficient_data` is a verdict, not a failed row — it is
`status = 'active'` with `suitability = 'insufficient_data'`). An exception
rolls back and writes nothing. `failed` exists for the case where an artifact was
attempted, the attempt is worth keeping (a model call that returned an
unparseable body), and no `active` row may be created.

`ai_briefings` uses it for `narration_status = 'unavailable'`-adjacent cases,
where the deterministic skeleton is stored as a row rather than an error.

### Why nothing in this group is ever deleted

Each row is the answer to "why did the system say that?". A user who sees
"plant in the first week of November" six weeks ago must be able to see what
evidence it rested on, even after the data moved on. Deletion destroys that; a
`superseded` row costs a few hundred bytes.

## 5. Retention summary

| Data | Retention | Rationale |
|---|---|---|
| tenant rows (farms, fields, observations, plantings, harvests) | while the account exists | user-owned data |
| `weather_records` | indefinite in Phase 3, policy pending (`OPEN-16`) | hash auditability |
| `forecast_runs`, `ingestion_runs` | indefinite | operational history; small |
| `monthly_outlooks`, `suitability_runs`, `planting_windows`, `ai_briefings` | indefinite, superseded | explainability |
| `climatology_normals` | per `baseline_version`, never edited | reproducibility of anomalies |
| raw payloads | per provider licence (`OPEN-05`) | licensing |
| logs / queue payloads | not part of this model | — |

No table in this model has a `TTL`, a `expires_at`, or a scheduled purge. A purge
is a destructive operation on a provenance record, and it does not exist as a
capability in Phase 3.

## 6. Lifecycle events that need a trigger, and do not have one

| Event | Mechanism now | Gap |
|---|---|---|
| `updated_at` maintenance | application (Prisma `@updatedAt`) | raw SQL bypasses it — `OPEN-19` |
| `crop_profile_versions` immutability | no `UPDATE` grant; trigger **specified, not created** | `migration_owner` can still edit a published row by typo |
| supersession ordering | partial unique index + single transaction | a writer that violates the order gets a unique violation, which is the intended failure |
| `served_updated_at` | writer's responsibility | a direct `UPDATE` of `served_lat` without the timestamp is possible; the column is metadata, not an invariant |
| partition invariant on `evidence_segments` | nothing | `OPEN-26` |

Only the second is a data-integrity gap with a specified fix. The rest are
review-enforced or tracked.
