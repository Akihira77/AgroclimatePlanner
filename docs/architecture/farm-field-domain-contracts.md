# Farm & Field — domain contracts (Phase 4.1), database layer (4.2), Farm CRUD (4.3) and Field CRUD (4.4)

**Status: the design is approved, the database layer is implemented (§10.2, §5), and both the
Farm and Field halves of the API surface are implemented and verified.**
`POST/GET/PATCH/DELETE /v1/farms` and `POST/GET/PATCH/DELETE /v1/fields` exist and are exercised
through the real HTTP pipeline against PostgreSQL, including geometry validation and the
Farm/Field deletion rule.
**Owner decisions:** `Q1`–`Q8` were answered on 2026-11-21 and are recorded as approved in
§12; they are not reinterpreted here.
**Authoritative for:** the Farm and Field API surface, contracts, invariants, and the
tenant-isolation rules those layers must obey.
**Not authoritative for:** the physical schema. `prisma/migrations/20261118020000_tenant_tables/`
is applied and is the source of truth for `app.farms` and `app.fields`; this document
describes the API surface over it and proposes no migration.

Supersedes nothing. `docs/architecture/domain-model.md` §2 remains the conceptual model;
`docs/data-model/tables-identity.md` §2–§3 remains the physical specification;
`docs/data-model/spatial-model.md` §1–§3 remains the normative account of `fields.geom` and
`area_ha`.

---

## 1. Scope and non-goals

### In scope

- Domain definitions and boundaries for `Farm` and `Field`, and the relationship between them.
- Explicit invariants, each assigned to the layer that enforces it.
- The initial API surface: ten endpoints, request/response contracts, status codes, errors.
- Pagination, filtering, and sorting for the two collection endpoints.
- Tenant isolation for every operation, including nested access.
- Contract schemas in TypeScript, proposed — not written to `packages/contracts` yet.
- A sequenced plan for Phase 4.2–4.6.

### Out of scope (explicit)

- Any Farm or Field CRUD implementation, controller, service, or SQL module.
- Any migration, Prisma schema change, RLS change, grant change, role change, or spatial
  function.
- Any contract source file: this was the 4.1 scope; 4.3 wrote `farm.ts` and `page.ts`, and 4.4
  wrote `geometry.ts` and `field.ts` (§7, §13).
- `POINT`-shaped fields, and therefore any resolution of `OPEN-17`.
- The eight agronomic columns on `app.fields` as an API surface (`soil_type`,
  `drainage_class`, `irrigation_availability`, `water_source`, …); `OPEN-21` has not
  chosen their vocabularies.
- Farm location as a geometry. `app.farms` has no spatial column and this phase adds none.
- Weather, crop, planting, observation, suitability, briefing, worker, and UI work.
- OpenAPI generation. `api-conventions.md` §11 claims it; nothing generates it.
- Optimistic concurrency (`If-Match`). The header is mentioned in `api-conventions.md` §1
  and implemented nowhere; §12 records the consequence.

### Naming collision, recorded

Older documents use "Phase 4" for background processing and the maintenance sweep
(`docs/architecture/background-processing.md`, `ADR-005` §7). This document uses
"Phase 4.1–4.6" for the Farm & Field track, as the milestone is currently scoped. The two
numberings describe different work and should not be cross-referenced.

---

## 2. Existing architecture findings (verified)

Everything in this section was read from the listed files. Nothing here is proposed.

### 2.1 The tables already exist

`app.farms` and `app.fields` were created in Phase 2.2.3
(`packages/database/prisma/migrations/20261118020000_tenant_tables/migration.sql`) and have
been applied. Prisma models `Farm` and `Field` exist in `packages/database/prisma/schema.prisma`
(:97-151), with `geom` and `area_ha` as `Unsupported(...)` — reachable by raw SQL only.

`app.farms`: `id uuid DEFAULT uuidv7()`, `user_id uuid NOT NULL → users(id)`, `name text NOT NULL`,
`region text`, `notes text`, `created_at`/`updated_at timestamptz NOT NULL DEFAULT now()`,
`deleted_at timestamptz`, `UNIQUE (id, user_id)`. No CHECK constraints. Index on
`(user_id) WHERE deleted_at IS NULL`. **No geometry, no description column.**

`app.fields`: `id`, `user_id uuid NOT NULL`, `farm_id uuid NOT NULL`, `name text NOT NULL`,
`geom geometry(Geometry,4326) NOT NULL`, `area_ha double precision GENERATED ALWAYS AS
(ST_Area(geom::geography)/10000.0) STORED`, eight nullable agronomic columns, timestamps,
`deleted_at`. Constraints: `UNIQUE (id, user_id)`; `FOREIGN KEY (farm_id, user_id) REFERENCES
farms (id, user_id)`; `GeometryType(geom) IN ('POINT','POLYGON','MULTIPOLYGON')`;
`ST_SRID(geom) = 4326`; `ST_IsValid(geom)`; `NOT ST_IsEmpty(geom)`; `length(btrim(name)) > 0`;
`elevation_m BETWEEN -500 AND 6000`; `soil_ph BETWEEN 3.0 AND 10.0`. Indexes on
`(user_id) WHERE deleted_at IS NULL`, `(farm_id) WHERE deleted_at IS NULL`, and GiST on `geom`.

### 2.2 Isolation is already enforced in the database

`ENABLE` + `FORCE ROW LEVEL SECURITY` on both tables, with the standard pair per table:

```sql
CREATE POLICY farms_tenant_isolation ON app.farms FOR ALL TO app_api
  USING      (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
CREATE POLICY farms_owner_full_access ON app.farms FOR ALL TO migration_owner
  USING (true) WITH CHECK (true);
```

`GRANT SELECT, INSERT, UPDATE, DELETE ON app.farms TO app_api` (and the same on `app.fields`).
`app_system` and `app_auth` hold nothing. There is no table-level privilege to
`app_system` by policy, not by oversight (`docs/data-model/ownership-and-rls.md` §2).

### 2.3 The tenant mechanism is transaction-scoped

`createTenantScope(prisma).withTenant(userId, fn)` (`packages/database/src/tenant.ts:61-79`)
opens one interactive transaction and runs
`select set_config('app.user_id', $1, true)`. The `true` makes it transaction-local; `SET` is
forbidden (`ADR-003` D2), nesting is rejected (`AsyncLocalStorage`), and a non-canonical UUID
throws `TenantContextError`. The id is validation-only — the GUC is a code-path assertion, not
a database-enforced identity (`ADR-003` D1).

### 2.4 Contracts and HTTP plumbing

- The envelope is `envelopeSchema(dataSchema, metaSchema?)` → `{ data }` or `{ data, meta }`;
  errors are `{ error: { code, message, details?, requestId } }`
  (`packages/contracts/src/response.ts`).
- Error codes are a closed singleton enum plus a **branded regex family** `*_NOT_FOUND`.
  `FARM_NOT_FOUND` and `FIELD_NOT_FOUND` therefore need no enum change — see §9.4.
- Every object schema is `z.strictObject`. Unknown keys are rejected, never stripped.
- Ids are UUIDv7; the contract does **not** re-validate cross-layer ids (`opaqueIdSchema =
  z.string().min(1)`), but does own the format where it mints one (`requestIdSchema = z.uuid()`).
- Timestamps cross the wire as ISO-8601 **strings in UTC with `Z`** (`isoInstantSchema =
  z.iso.datetime()`); offsets are rejected, not normalised.
- Validation is per-parameter, not global: `@Body(new ZodValidationPipe(schema))`. There is no
  global pipe, no `class-validator`, and no response serialiser — handlers return `{ data }`
  literally.
- One `@Catch()` filter chooses status; message text is fixed Indonesian copy in
  `api-error.ts`; 5xx logs `requestId status code exception env` and nothing else.
- CSRF is enforced inside `AuthGuard` for `POST`/`PUT`/`PATCH`/`DELETE` after authentication;
  `Origin` validation runs in middleware before body parsing. Both apply to every mutation in
  this document with no per-route work.
- Global prefix is `v1` (`app.factory.ts:123`).

### 2.5 Pagination exists only as a convention

`api-conventions.md` §5 specifies `?page=1&pageSize=20` (max 100), `?sort=-field` with a
per-resource whitelist, and "unknown query params are a `400`". §2 shows
`"meta": { "page": 1, "pageSize": 20, "total": 3 }`.

**No code implements any of it.** There is no `pageMetaSchema` export (only a local fixture in
`response.test.ts`), no list query schema, no sort/filter helper, and no paging query anywhere
in `apps/api` or `packages/database`. §6.3 proposes the shape; 4.2 implements it.

### 2.6 What does not exist

No `apps/api/src/farm/**` or `field/**`; no `@Patch`, `@Delete`, or `@Param` usage anywhere;
no `*_NOT_FOUND` thrower; no rate limiting outside auth; no `Location` helper despite the §7
convention; no `updated_at` trigger (`OPEN-19`) and no cascade anywhere (`ON DELETE` is
`NO ACTION` on every edge, by rule).

---

## 3. Domain definitions

### 3.1 Farm

| Aspect | Definition | Source |
|---|---|---|
| Identity | `id uuid`, UUIDv7, minted by the database | applied DDL |
| Owner | `user_id`, derived from the authenticated session; never accepted from a client | applied DDL, §9 |
| Name | Required, trimmed, 1–100 characters (proposed bound) | `farms.name NOT NULL`, no length bound in DB |
| Region | Optional free text, ≤120 characters (proposed) | `farms.region text`; `tables-identity.md` §2 records that it is deliberately **not** a geography |
| Notes | Optional free text, ≤2000 characters (proposed); this is the "description" the brief asks for | `farms.notes text` |
| Location | **None.** A farm is a container, not a shape. There is no farm geometry, and `region` is a label | applied DDL |
| Timestamps | `created_at`, `updated_at`, `timestamptz`, UTC | applied DDL |
| Lifecycle | Soft delete via `deleted_at`; a deleted farm is invisible through the API | `domain-model.md` §7 |

No `description`, `slug`, `code`, `address`, or `timezone` column is added. `users` carries the
timezone; a farm inherits it. A per-farm timezone would be a migration and a real requirement,
and neither exists.

### 3.2 Field

| Aspect | Definition | Source |
|---|---|---|
| Identity | `id uuid`, UUIDv7 | applied DDL |
| Parent | `farm_id`, required, and the pair `(farm_id, user_id)` must match a real farm row | composite FK, applied |
| Owner | `user_id`, denormalised from the session for the RLS predicate | applied DDL |
| Name | Required, trimmed, 1–100 characters (proposed) | DB enforces only non-blank |
| Geometry | Exactly one `POLYGON` in EPSG:4326, longitude first | contract (§7.1); DB accepts more |
| Area | `area_ha`, derived by the database, hectares, positive for every accepted polygon | generated column |
| Timestamps | `created_at`, `updated_at` | applied DDL |
| Lifecycle | Soft delete via `deleted_at`; hard delete is never used | `lifecycle-and-retention.md` |
| Agronomic columns | Present in the table, **not** exposed in 4.1 (`OPEN-21`) | applied DDL, §12 |

A field is the decision unit for everything downstream: a snapshot, a resolved cell, a
suitability run, a window. That is why its geometry is constrained at write time and why the
area is derived rather than supplied.

### 3.3 Why the contract is narrower than the database

The DB accepts `POINT`, `POLYGON`, and `MULTIPOLYGON`. Phase 4.1 accepts `POLYGON` only.

This is a deliberate, one-directional narrowing: a value the contract accepts is always
storable, so no accepted request can fail a database CHECK. The reverse is not true, and that
is `OPEN-17` — a `POINT` field stores `area_ha = 0`, which `FieldSnapshotPayload.areaHa`
(`z.number().positive()`) rejects, so every artifact derived from it is unbuildable. Narrowing
the API neither resolves nor hides `OPEN-17`: the database still accepts point rows, and no
document in this phase claims otherwise. `MULTIPOLYGON` is likewise not exposed, because the
brief scopes 4.1 to `POLYGON`; adding it later is additive.

---

## 4. Entity relationships

```
users 1 ──── * farms 1 ──── * fields
  │                              │
  └────────── user_id ───────────┘   (denormalised; RLS predicate)
```

- One farm contains zero or more fields. One field belongs to exactly one farm.
- A field cannot reference another tenant's farm: `(farm_id, user_id)` is a foreign key into
  `farms (id, user_id)`, so a mismatched pair is a `23503`, not a cross-tenant row.
- A user may own any number of farms. The product is "one farm at a time in the UI", not "one
  farm per account" (`domain-model.md` §2).

### 4.1 Deletion semantics

| Operation | Behaviour | Why |
|---|---|---|
| `DELETE /v1/farms/:farmId` with live fields | **`409 CONFLICT`**, nothing deleted | The FK is `NO ACTION` and there is no cascade anywhere in this model. Cascading a soft delete would make one request delete data the user did not name; refusing is honest and reversible |
| `DELETE /v1/farms/:farmId` with only deleted fields | `204`, sets `deleted_at` and `updated_at` | Deleted children are history, not live data |
| `DELETE /v1/fields/:fieldId` | `204`, sets `deleted_at` and `updated_at` | Soft delete, consistent with the model |
| Hard delete of a field with history | Never performed | Six tables reference `fields (id, user_id)` with `NO ACTION`; the database would refuse |
| Reading a soft-deleted row | `404` | The API filters `deleted_at IS NULL`; RLS alone does **not**, because the policy has no such predicate |

The farm-with-fields rule is the only deletion rule the brief could not settle from existing
decisions; it was `Q2` in §12 and is **approved**: refuse, `409 CONFLICT`. `softDeleteFarm`
(Phase 4.2) returns `has_live_fields` for that case and performs no write.

### 4.2 The farm-delete race

"Check for fields, then delete the farm" is two statements and a window: a field created
between them would survive its parent. The delete therefore runs in one transaction as

1. `SELECT id FROM app.farms WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`
2. `SELECT 1 FROM app.fields WHERE farm_id = $1 AND deleted_at IS NULL LIMIT 1`
3. `UPDATE app.farms SET deleted_at = now(), updated_at = now() WHERE id = $1`

A concurrent `INSERT` into `fields` takes `FOR KEY SHARE` on the referenced farm row, which
conflicts with step 1's `FOR UPDATE`. The insert therefore either commits before step 2 (and is
seen) or waits until the delete commits (and then fails its FK, because the farm's row still
exists — the conflict is on the lock, not on existence, so the outcome is "field created after
a refused delete" or "delete refused"). It cannot land between steps 2 and 3.

`app_api` already holds table-level `UPDATE` on `farms`, so `FOR UPDATE` needs no new grant.

---

## 5. Domain invariants

Each row names exactly one enforcing layer. "Contract" is `packages/contracts` validated by
`ZodValidationPipe`; "DB" is a constraint, policy, grant, or generated column; "derived" is a
value the server computes and the client never supplies.

| # | Invariant | Layer | Enforcement |
|---|---|---|---|
| I1 | A farm or field is owned by the authenticated user | DB | `user_id` from the session + RLS `USING`/`WITH CHECK`; contract never accepts `userId` |
| I2 | A field's farm belongs to the same user | DB | `FOREIGN KEY (farm_id, user_id) → farms (id, user_id)` |
| I3 | Farm name is non-empty after trimming | Contract | `z.string().trim().min(1).max(100)` |
| I4 | Farm name is non-blank **in the database too** | DB | **Not enforced.** `farms.name` has no CHECK; `fields.name` has one. Gap recorded in §10.3, not fixed in 4.1 |
| I5 | Field name is non-empty after trimming | Contract **and** DB | contract `min(1).max(100)`; `fields_name_not_blank_check` |
| I6 | Geometry is a `POLYGON` | Contract | `z.literal("Polygon")`; DB check is broader (`OPEN-17`) |
| I7 | Geometry is EPSG:4326, longitude then latitude | DB + Contract | `ST_SRID(geom) = 4326`; contract's GeoJSON has no `crs` member (RFC 7946 fixes WGS 84) and enforces lon ∈ [-180,180], lat ∈ [-90,90] |
| I8 | Every ring is closed and has ≥4 positions | Contract | Structural check on the coordinate array. Not duplicated in JS beyond this |
| I9 | The polygon is not self-intersecting and not empty | DB | `ST_IsValid(geom)`, `NOT ST_IsEmpty(geom)`. **No** JS/GEOS reimplementation |
| I10 | Area is positive for an accepted polygon | Derived | `ST_Area(geography)/10000.0`; a valid, non-empty polygon has positive area |
| I11 | Area is authoritative on the server | DB | `GENERATED ALWAYS … STORED`; no INSERT/UPDATE names it; contract has no `areaHa` in any request |
| I12 | Area unit is hectares, unrounded | DB + Contract | division by 10 000 in SQL; response is a JSON number with no server-side rounding |
| I13 | Soft-deleted rows are invisible | API | every read/update/delete adds `deleted_at IS NULL`; RLS does not filter it |
| I14 | `updated_at` moves on every write | API | the statement sets `updated_at = now()`; no trigger exists (`OPEN-19`) |
| I15 | Timestamps are UTC instants | Contract | `isoInstantSchema`; DB stores `timestamptz` |
| I16 | A listed collection is deterministically ordered | API | explicit `ORDER BY` with `id` as tie-break |

### 5.1 What is deliberately *not* validated in more than one place

- **Spatial validity.** `ST_IsValid` is the only implementation. Reimplementing GEOS rules in
  JavaScript would be a second source of truth that drifts and cannot match PostGIS exactly.
  The contract checks only what is cheap, deterministic, and structural: type, ring closure,
  ring length, coordinate bounds.
- **SRID.** The contract cannot express a CRS (GeoJSON removed `crs`; RFC 7946 fixes WGS 84),
  so it rejects any extra member with `strictObject` and the DB asserts `4326`.
- **Area.** Never computed in JavaScript. A contract that recomputed area would be a second
  definition and would disagree with the generated column at the edges (antimeridian,
  ellipsoid).
- **Ownership.** The contract has no `userId` field at all, so there is nothing to validate;
  the value comes from `request.auth.user.id`.

### 5.2 Precision

`area_ha` is `double precision` and is stored unrounded
(`physical-model.md`: "Rounding policy: none at the storage layer"). The response carries the
number as stored. Decimal formatting is a client concern; a server that rounded would make the
stored value and the served value two different numbers, and the stored one is what a snapshot
hash would be built from. Tiny fields therefore report tiny positive areas rather than `0`.

---

## 6. API surface

### 6.1 Endpoint matrix

All endpoints require an authenticated session (`AuthGuard`). `POST`, `PATCH`, and `DELETE`
also require `X-CSRF-Token` (§9.5) and pass `Origin` validation. No endpoint accepts a
`userId`, tenant id, or owner id in any position.

| # | Method | Path | Request | Success | Notes |
|---|---|---|---|---|---|
| 1 | `POST` | `/v1/farms` | `FarmCreate` | `201` `{ data: Farm }` + `Location` | |
| 2 | `GET` | `/v1/farms` | `?page&pageSize&sort` | `200` `{ data: Farm[], meta: PageMeta }` | |
| 3 | `GET` | `/v1/farms/:farmId` | — | `200` `{ data: Farm }` | |
| 4 | `PATCH` | `/v1/farms/:farmId` | `FarmUpdate` | `200` `{ data: Farm }` | returns the updated row |
| 5 | `DELETE` | `/v1/farms/:farmId` | — | `204` | `409` if live fields exist |
| 6 | `POST` | `/v1/farms/:farmId/fields` | `FieldCreate` | not routed — 4.4 ships the flat collection only (`Q3`) | |
| 7 | `GET` | `/v1/farms/:farmId/fields` | `?page&pageSize&sort` | not routed — `GET /v1/fields?farmId=` covers it | |
| 8 | `GET` | `/v1/fields/:fieldId` | — | `200` `{ data: Field }` | flat, per `api-conventions.md` §6 |
| 9 | `PATCH` | `/v1/fields/:fieldId` | `FieldUpdate` | `200` `{ data: Field }` | |
| 10 | `DELETE` | `/v1/fields/:fieldId` | — | `204` | |

Path parameter names are `:farmId` and `:fieldId` rather than the `:id` the convention document
uses. The wire is identical; the difference is only the name a `400` reports in
`details[].path`, and `farmId` is the honest one. Registered as `D2` in §11.

**Deviation from the brief, approved as `Q3`.** The brief proposes nested field detail paths
(`/v1/farms/:farmId/fields/:fieldId`). This design uses the flat `/v1/fields/:fieldId`, because
`api-conventions.md` §6 already publishes that surface, and because two other endpoint families
address a field the same flat way (`/v1/fields/:id/resolve-cell`, `?fieldId=` on weather and
agronomy reads). Two path shapes for one resource is the kind of drift a client cannot
reconcile. Nesting remains correct for the collection, where the parent is the scope.

### 6.2 Request and response bodies

Every body is a `strictObject`: an unknown key is a `400`, never silently dropped. No request
body carries `userId`, `farmId` (for field creation the parent is the path), `areaHa`,
`createdAt`, or `updatedAt`.

`FarmCreate` — `{ name: string, region?: string | null, notes?: string | null }`. Absent and
`null` are equivalent on create: both mean "not provided", stored as `NULL`.

`FarmUpdate` — a partial of the same keys, with at least one key required. `name` may not be
`null`; `region` and `notes` accept `null` to clear. Absent means "leave unchanged". This
presence semantics is chosen because it is the only one that can express "clear this field"
without a sentinel; it is recorded as `D3` because `api-conventions.md` does not specify PATCH.

`FieldCreate` — `{ name: string, geometry: PolygonGeometry }`.

`FieldUpdate` — `{ name?: string, geometry?: PolygonGeometry }`, at least one key. Replacing the
geometry recomputes `area_ha` in the database; there is nothing to keep in sync in the
application.

`Farm` — `{ id, name, region: string | null, notes: string | null, createdAt, updatedAt }`.
No `userId` (it is the caller), no `fieldCount` (a second query for a decorative number), no
`deletedAt` (a deleted row is `404`).

`Field` — `{ id, farmId, name, geometry, areaHa, createdAt, updatedAt }`, where `geometry` is
the stored polygon as GeoJSON and `areaHa` is the generated column. The response geometry is
the **stored** geometry, not a byte-for-byte echo of the request: PostGIS re-serialises it
(`ST_AsGeoJSON`), and a client that diffs strings will occasionally see a different but
equivalent ring order. Documented so it is not reported as a bug later.

### 6.3 Pagination, sorting, filtering

Consistent with `api-conventions.md` §5 — offset paging, page-numbered, no new abstraction:

- `page` — integer ≥ 1, default `1`.
- `pageSize` — integer 1–100, default `20`.
- `sort` — whitelist per resource. Farms: `name`, `createdAt`, `updatedAt`. Fields: `name`,
  `createdAt`, `updatedAt`, `areaHa`. A leading `-` means descending. Default `-createdAt` with
  `id` as the tie-break, so pages are stable.
- Any other query parameter is `400 VALIDATION_FAILED` — the documented rule, enforced by a
  strict query schema rather than by remembering to check.
- Filters: none in 4.1. The field collection is scoped by its path; a farm collection has no
  meaningful filter yet. Adding one is a query-schema change, not a new mechanism.

`meta` is `{ page: number, pageSize: number, total: number }`, `total` computed under the same
RLS scope and the same `deleted_at IS NULL` predicate. The implemented primitive counts in a
second statement (4.2), not with `count(*) OVER ()`: a window function cannot report a total for
a page past the last row, and an empty page still needs an accurate total. The cost is that a
concurrent insert can move `total` by one relative to the rows already returned; a page and its
total are the same snapshot only when nothing writes in between.

Index note, stated rather than implied: the default `ORDER BY created_at DESC, id DESC` is not
covered by an index — the partial indexes are on `user_id` and `farm_id`. Tenant row counts are
small by product design, so 4.1 accepts the sort. If a farm ever holds enough fields for that
to matter, the fix is a composite partial index, not a different pagination model.

### 6.4 Not in this surface

`PUT` (no replacement semantics: a field's identity and history would be erased), bulk
create/update, `If-Match`, `Idempotency-Key`, `?include=fields` (the nested collection exists),
and any farm-level geometry or map viewport query.

---

## 7. Contract schemas

All four files are written and exported from the barrel with colocated Vitest suites:
`page.ts` and `farm.ts` in 4.3 (`farm.test.ts`), `geometry.ts` and `field.ts` in 4.4
(`field.test.ts`). The shapes below are the ones that shipped; they follow the package's
conventions: `z` from `"zod"`, `.js` specifiers, `strictObject`, one schema plus one inferred type
per concept, doc comment naming the normative source.

```ts
// packages/contracts/src/geometry.ts
import { z } from "zod";

/**
 * GeoJSON `Polygon` in EPSG:4326, longitude first. RFC 7946 removed the `crs`
 * member and fixes WGS 84, which is exactly `fields.geom`'s SRID; `strictObject`
 * is what refuses a request that tries to declare another CRS.
 *
 * Structural only. Ring closure and position count are checked here because they
 * are cheap and deterministic; self-intersection is `ST_IsValid`'s job and is not
 * reimplemented (`docs/data-model/spatial-model.md` §1).
 */
const longitude = z.number().finite().gte(-180).lte(180);
const latitude = z.number().finite().gte(-90).lte(90);
const position = z.tuple([longitude, latitude]);

const linearRing = z
  .array(position)
  .min(4)
  .refine(
    (ring) =>
      ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1],
    { message: "ring must be closed" },
  );

export const polygonGeometrySchema = z.strictObject({
  type: z.literal("Polygon"),
  coordinates: z.array(linearRing).min(1),
});
export type PolygonGeometry = z.infer<typeof polygonGeometrySchema>;
```

```ts
// packages/contracts/src/page.ts
export const pageMetaSchema = z.strictObject({
  page: z.number().int().positive(),
  pageSize: z.number().int().positive().max(100),
  total: z.number().int().nonnegative(),
});
export type PageMeta = z.infer<typeof pageMetaSchema>;
```

```ts
// packages/contracts/src/farm.ts
export const farmCreateSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  region: z.string().trim().max(120).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

export const farmUpdateSchema = farmCreateSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: "at least one field" });

export const farmSchema = z.strictObject({
  id: opaqueIdSchema,
  name: z.string().min(1),
  region: z.string().nullable(),
  notes: z.string().nullable(),
  createdAt: isoInstantSchema,
  updatedAt: isoInstantSchema,
});

export const farmEnvelopeSchema = envelopeSchema(farmSchema);
export const farmListEnvelopeSchema = envelopeSchema(z.array(farmSchema), pageMetaSchema);
```

```ts
// packages/contracts/src/field.ts  (proposed)
export const fieldCreateSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  geometry: polygonGeometrySchema,
});

export const fieldUpdateSchema = fieldCreateSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: "at least one field" });

export const fieldSchema = z.strictObject({
  id: opaqueIdSchema,
  farmId: opaqueIdSchema,
  name: z.string().min(1),
  geometry: polygonGeometrySchema,
  areaHa: z.number().positive(),
  createdAt: isoInstantSchema,
  updatedAt: isoInstantSchema,
});

export const fieldEnvelopeSchema = envelopeSchema(fieldSchema);
export const fieldListEnvelopeSchema = envelopeSchema(z.array(fieldSchema), pageMetaSchema);
```

Path parameters are validated at the boundary as `z.uuid()` (`farmIdSchema`, `fieldIdSchema`),
by the same `ZodValidationPipe` used for bodies. Unlike a cross-layer id, the path parameter is
the API's own identifier for a row the database minted as UUIDv7, so pinning the format here is
correct — the same reasoning that gives `requestIdSchema = z.uuid()`.

Query schema (proposed):

```ts
export const farmListQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.enum(["name", "-name", "createdAt", "-createdAt", "updatedAt", "-updatedAt"])
    .default("-createdAt"),
});
```

Field list query adds `areaHa`/`-areaHa` to the enum. `z.coerce` is the documented exception:
query parameters arrive as strings (`api-conventions.md` §12).

---

## 8. Validation rules, by layer

| Rule | Contract (`400`) | Database | Derived |
|---|---|---|---|
| Farm name non-blank | yes, trimmed, 1–100 | no CHECK — gap | — |
| Field name non-blank | yes, trimmed, 1–100 | `btrim` length > 0 | — |
| Geometry type `Polygon` | yes | accepts `POINT`/`POLYGON`/`MULTIPOLYGON` | — |
| Positions are 2D | yes, two-element tuple | refuses a 3D position: the column typmod is two-dimensional, so PostGIS answers `22023` | — |
| Ring closed, ≥4 positions | yes, cheaper than a `23514` round trip | `ST_IsValid` refuses an unclosed ring (`23514`) — the parser does not close it | — |
| Lon/lat bounds | yes | no | — |
| SRID 4326 | implied: `strictObject` refuses a `crs` member | `ST_SRID(geom) = 4326`, and it is load-bearing — the parser **honours** a declared `crs` (§10.2) | — |
| Self-intersection | no | `ST_IsValid` | — |
| Empty geometry | no (array `min(1)` covers "no rings") | `NOT ST_IsEmpty` | — |
| Area | never accepted | generated column | positive for a valid polygon |
| Area unit/precision | response number | hectares, unrounded | — |
| Parent belongs to tenant | parent id from path + RLS | composite FK | — |
| `deleted_at IS NULL` | — | not enforced | API predicate |
| `updated_at` | — | `DEFAULT now()`, no trigger | statement sets `now()` |

Two asymmetries are deliberate and recorded: spatial validity is DB-only (no GEOS clone), and
`farms.name` has no database CHECK while `fields.name` does. The second is a real gap in the
applied schema; 4.1 does not fix it because that needs a migration and this phase adds none (§10.3).

---

## 9. Tenant isolation and security

### 9.1 Where the tenant comes from

`request.auth.user.id`, set by `AuthGuard` after `resolveSession` validated the cookie's
session. It is the only source. There is no `userId` in any body, query, or path, and no
`tenantId` header. A request cannot name a different tenant, so there is nothing to distrust.

### 9.2 One scope per request

Each handler opens exactly one `withTenant(userId, (tx) => …)` and does all of its database work
inside it. Nesting throws by design, so a service cannot open a second scope; a helper that
needs to participate receives `tx`. The GUC is transaction-local, so a pooled connection cannot
leak a tenant between requests.

### 9.3 Two predicates, not one

RLS is the backstop, not the query. Every statement also carries `user_id = $n` (or reaches the
row through `farm_id` after the parent was read in the same scope) and `deleted_at IS NULL`.
The reason is concrete: the policy on both tables has **no `deleted_at` predicate**, so RLS
alone would happily return a deleted row. Isolation and visibility are different questions and
each is answered explicitly.

### 9.4 Cross-tenant behaviour

`api-conventions.md` §8: "A `404` is returned for another user's resource — never `403`, which
leaks existence." Every row below is a `404` with a code from the existing `*_NOT_FOUND` family;
the brand is obtained by parsing the literal, no enum change is needed.

| Attempt | Response | Mechanism |
|---|---|---|
| Read another tenant's farm | `404 FARM_NOT_FOUND` | RLS returns zero rows; the API does not distinguish missing from foreign |
| Update another tenant's farm | `404 FARM_NOT_FOUND` | same read, then update inside the scope |
| Delete another tenant's farm | `404 FARM_NOT_FOUND` | same read with `FOR UPDATE` |
| Read another tenant's field | `404 FIELD_NOT_FOUND` | RLS returns zero rows |
| Update / delete another tenant's field | `404 FIELD_NOT_FOUND` | same |
| List fields of another tenant's farm | `404 FARM_NOT_FOUND` | the parent read happens first |
| Create a field under another tenant's farm | `404 FARM_NOT_FOUND` | parent read returns nothing; the composite FK would also refuse with `23503` |
| Address a field that belongs to a different farm in the **same** tenant | `404 FIELD_NOT_FOUND` | `WHERE id = $1 AND farm_id = $2`; a field is only addressable through its own parent |
| Present a valid CSRF token for another session | `403 FORBIDDEN` | guard, before any tenant work |

`23503` is never expected on the happy path: the parent is read in the same scope first. If it
ever surfaces, it is an invariant violation and becomes `500 INTERNAL_ERROR`, not a `404` —
mapping it to `404` would hide a bug in the handler that skipped the parent read.

Existence is not leaked by timing beyond what the database already implies: for a foreign id and
a missing id the API issues the same statement and gets the same zero rows.

### 9.5 CSRF, Origin, and privileges

`POST`/`PATCH`/`DELETE` are CSRF-protected by `AuthGuard` with no per-route work, and `Origin`
validation is unchanged. No handler touches either. The database privileges are the existing
ones: `app_api` RW on both tables, `app_auth` and `app_system` nothing, no `SECURITY DEFINER`
object, no new role, no policy change.

### 9.6 Logging

A 5xx logs `requestId`, status, code, exception name, and environment — never a message, SQL
text, DSN, geometry payload, or user-supplied name. 4xx does not log the body. The existing
filter already behaves this way; the new modules must not add logging that contradicts it.

---

## 10. Database and spatial design considerations

### 10.1 No migration in this phase

Everything the API needs already exists: the tables, the composite FK, the CHECKs, the RLS
policies, the grants, the indexes, and the generated area column. Phase 4.1 therefore ships no
DDL, and Phase 4.2–4.4 need none either. Any migration proposed below is a **later** phase and
requires its own approval.

### 10.2 How geometry crosses the boundary

Write:

Implemented in `packages/database/src/fields.ts` (`createField`, `updateField`):

```sql
INSERT INTO app.fields (user_id, farm_id, name, geom)
VALUES ($1, $2, $3, public.ST_GeomFromGeoJSON($4::text))
RETURNING id::text AS id, farm_id::text AS farm_id, name,
          public.ST_AsGeoJSON(geom)::jsonb AS geometry, area_ha, created_at, updated_at
```

Read uses `ST_AsGeoJSON(geom)::jsonb`; update replaces `geom` the same way and `area_ha`
follows automatically because the column is generated.

**There is no `ST_SetSRID(…, 4326)` around the parse, deliberately.** The `::text` cast is
required — PostGIS 3.6 overloads `ST_GeomFromGeoJSON` for `text`, `json`, and `jsonb`, so an
untyped parameter is ambiguous (`42725`). Three behaviours were measured against this database
on 2026-11-21, and the first version of this section got two of them wrong:

| Input | `ST_GeomFromGeoJSON` | Consequence |
|---|---|---|
| Unclosed ring | **stored unclosed**; `ST_IsValid` false | `fields_geom_valid_check` refuses it (`23514`). The parser does *not* repair the ring |
| `"crs"` member | **honoured**: `ST_SRID` becomes the declared value (measured `3857`) | `fields_geom_srid_check` refuses it (`23514`). Wrapping the call in `ST_SetSRID(…, 4326)` would overwrite the mismatch and store coordinates labelled 4326 with a wrong, still-positive area — which is why the layer does not |
| 3D position | parsed as `POLYGON Z` | **`22023`** at assignment: the column typmod is two-dimensional, so PostGIS refuses it (`Geometry has Z dimension but column does not`). Measured 2026-11-21, after an earlier version of this row wrongly claimed the database accepted it |

The database layer additionally refuses, before SQL, a non-`Polygon` `type` and any `crs`/`bbox`
member (`FieldGeometryError`), because the column accepts `POINT` and `MULTIPOLYGON` and would
otherwise return a shape the API cannot represent.

Topology is **not** validated by the parser; that is `ST_IsValid`'s job as a CHECK. Because the
contract and the layer reject everything structural before the query, a database geometry error
is a backstop for a caller that bypassed both, not a normal path.

No `SELECT *`: `geom` and `area_ha` are `Unsupported` in Prisma and both are read as explicit
raw columns, consistent with `auth-sessions.ts`'s column discipline.

### 10.3 Gaps in the applied schema

Recorded, not fixed in this phase:

1. `farms.name` has no blank or length CHECK while `fields.name` has a blank check. The API
   enforces both; raw SQL can still insert `''`. A later migration could add
   `CHECK (length(btrim(name)) > 0)` for symmetry.
2. No `updated_at` trigger (`OPEN-19`). Every statement that writes sets it explicitly.
3. `fields_geom_type_check` still allows `POINT` and `MULTIPOLYGON` — `OPEN-17`, `Q1`.
4. The GiST index is unused by any query in this design (`OPEN-22`).
5. No index supports the default sort (§6.3).

### 10.4 Spatial queries this phase does not need

No viewport query, no `ST_Intersects`, no centroid, no distance. Cell resolution is a later
milestone and uses the provider's rounding rule, not the GiST index
(`docs/data-model/spatial-model.md` §3, §5). Reading a field's geometry is a column read.

---

## 11. Decisions taken by this design (reviewable)

| # | Decision | Reason |
|---|---|---|
| D1 | Contract accepts `POLYGON` only; no database change | Satisfies the phase scope without touching an applied CHECK or pre-empting `OPEN-17` |
| D2 | Path parameters are `:farmId` / `:fieldId` | Only affects `details[].path`; a stable id name is worth more than matching `:id` textually |
| D3 | PATCH means partial-update-by-presence; `null` clears an optional field; at least one key | The convention documents PATCH verbs but no semantics; presence is the only shape that can express "clear" |
| D4 | `DELETE` is soft, returns `204`; the second delete returns `404` | A deleted row is not addressable; `404` is the same answer as never having existed, which is the documented policy |
| D5 | Farm delete with live fields is `409 CONFLICT` | No cascade exists; refusing is reversible and does not delete unnamed data (`Q2`) |
| D6 | Area is response-only, never accepted, never rounded, in hectares | The generated column is the single definition (§5) |
| D7 | Geometry is GeoJSON `Polygon`, lon/lat, 2D, no `crs` member | RFC 7946 is WGS 84 by construction, which is exactly `fields.geom`'s SRID; PostGIS parses it natively |
| D8 | List responses are `{ data, meta }` with `page/pageSize/total`, page-numbered, `pageSize ≤ 100` | Exactly what `api-conventions.md` §5 already specifies; cursor paging stays reserved for activity feeds |
| D9 | Unknown query parameters are `400` | Documented rule, enforced by a strict query schema |
| D10 | Response `geometry` is the stored geometry, not an echo | PostGIS re-serialises; documenting it prevents a false bug report |
| D11 | `409` is used only for the farm-with-fields rule; duplicate names are allowed | There is no unique constraint on `(user_id, name)` and no product rule against two fields sharing a name |
| D12 | No new ADR | CRS, type, area, and soft delete are already normative in `spatial-model.md`, `domain-model.md` §7, and the applied DDL. GeoJSON is an API-representation choice, and the phase's own document is its record |

---

## 12. Owner decisions and remaining questions

`Q1`–`Q4` were answered by the owner on 2026-11-21 and are final for Phase 4.x. They are
recorded verbatim in intent, not reinterpreted.

| # | Question | Decision applied | Consequence if changed |
|---|---|---|---|
| Q1 | `OPEN-17`: are point-shaped fields a v1 requirement? | **Approved: no.** v1 accepts `POLYGON` only; no `POINT` or `MULTIPOLYGON` API support. The database CHECK is untouched, so `OPEN-17` stays open | Reopening escalates `OPEN-17` to P0 and needs either a dropped `POINT`, a nullable `areaHa` (contract change + ADR), or a declared-radius area |
| Q2 | Deleting a farm that still has live fields: refuse, or cascade the soft delete? | **Approved: refuse.** The future API answers `409 CONFLICT`; `softDeleteFarm` returns `has_live_fields` and writes nothing | Cascading is one statement but deletes rows the user did not name; it also needs a decision on whether the response reports how many were deleted |
| Q3 | Field detail path: flat `/v1/fields/:fieldId` or nested `/v1/farms/:farmId/fields/:fieldId`? | **Approved: flat.** A field belongs to a farm in the data model; the route does not need to say so | Nested would be a documented-surface break for `/v1/fields/:id/resolve-cell` and for every `?fieldId=` read |
| Q4 | Are the eight agronomic columns (`soil_type`, `drainage_class`, `irrigation_availability`, `water_source`, …) in the 4.x API surface? | **Approved: no.** They are not exposed through Phase 4.x. `OPEN-21` keeps their vocabularies unowned | Exposing them earlier means inventing vocabulary the owner has not approved, and a later rename would be a breaking change |
| Q5 | Is there a minimum polygon area product rule (e.g. reject plots under 0.01 ha)? | None. Validity and positivity are enforced; a tiny valid polygon is accepted | A threshold is a product policy with no source in the repo; it would be a contract rule, not a database one |
| Q6 | Are name/metadata length bounds (100 / 120 / 2000) acceptable? | Applied as proposed; the DB has no bound to inherit | Smaller bounds are cheap to tighten before data exists; larger ones after 4.x data exist would be a breaking change only if lowered |
| Q7 | Should tenant routes be rate limited, and with which quota? | Not in 4.1; only auth routes are limited today | An unauthenticated-scraping risk does not exist here (authentication is required), but a write-flood does; adding it later is middleware, not contract |
| Q8 | Is `If-Match` optimistic concurrency required for PATCH? | No. Last write wins; `updatedAt` is observable but not conditional | Adding it later is additive (a header and a `409`), but a client that already relies on last-write-wins would see new conflicts |

`Q5`–`Q8` were answered by the owner on 2026-11-21 and are final for Phase 4.x:

| # | Question | Decision applied | Consequence if changed |
|---|---|---|---|
| Q5 | Is there a minimum polygon area product rule? | **Approved: none.** A valid `Polygon` with positive generated area is accepted | A threshold is a product policy with no source in the repo; it would be a contract rule, not a database one |
| Q6 | Are the name/metadata length bounds acceptable? | **Approved: name 100, region 120, notes 2000.** The database has no bound to inherit | Smaller bounds are cheap to tighten before data exists; lowering them after 4.x data exists is a breaking change |
| Q7 | Should tenant routes be rate limited? | **Approved: no additional Farm/Field limiter.** The existing authentication and infrastructure protections stay | A write flood is the remaining risk; adding a limiter later is middleware, not a contract change |
| Q8 | Is `If-Match` optimistic concurrency required for PATCH? | **Approved: no.** Updates are last-write-wins; `updatedAt` is observable but not conditional | Adding it later is additive (a header and a `409`), but a client relying on last-write-wins would start seeing conflicts |

No open question remains for Phase 4.x.

---

## 13. Phase sequence

Each phase ends with a checkable exit condition. No phase claims a later phase's work.

### 4.2 — Database layer — **implemented**

`packages/database/src/farms.ts` and `fields.ts`, following `auth-sessions.ts`: explicit column
lists, the tenant predicate read from `app.user_id`, `deleted_at IS NULL` on every statement,
`updated_at = now()`, geometry through PostGIS, and the lock pair that makes farm deletion safe
against a concurrent field insert (§4.2). `createTenantScope` stays the only entry point; the
functions take its transaction.

Exit, met: real-role integration tests in `test/integration/farm-field.test.mjs` — 26 assertions
covering tenant isolation, soft deletion, geometry and generated area, the composite FK,
transaction rollback, and both directions of the delete/create race. The two race tests were
shown to fail against a lock-free create and against a single-snapshot delete before being
accepted.

### 4.3 — Contracts and Farm CRUD — **implemented**

`packages/contracts/src/page.ts` (`pageMetaSchema`) and `farm.ts` (`farmCreateSchema`,
`farmUpdateSchema`, `farmSchema`, `farmSortSchema`, `farmListQuerySchema`, `farmIdSchema`, both
envelopes) are exported from the barrel with `farm.test.ts`. `apps/api/src/farm/**` adds
`FarmController`, `FarmService`, and `FarmModule`; `FarmModule` is registered in `AppModule`.

`geometry.ts` and `field.ts` belong to 4.4: the design above is written against `Field`, and the
Farm surface accepts no geometry, so nothing was created for them here. The exit criterion that
names a geometry round-trip therefore moves with them.

Exit, met for the Farm surface: `FARM_NOT_FOUND` is reachable only by parsing the branded family;
endpoint tests through the real pipeline cover `201` + `Location`, `200` list with `meta`,
`200`/`404` detail, `200` PATCH, `204`/`409`/`404` DELETE, `401` without a session, `403` without
a trusted `Origin` or without a valid `X-CSRF-Token`, `404` on every cross-tenant attempt, and
`400` for unknown keys, unknown query parameters, an unlisted `sort`, an out-of-range page, and a
non-UUID path parameter. A global `AuthGuard` applied per feature module is the mechanism; see
`apps/api/src/farm/farm.controller.ts`.

### 4.3.1 Deviations recorded while implementing 4.3

- **`AuthModule` is `global: true` and exports `AuthGuard`, `AuthService`, and `CsrfValidator`.**
  Nest resolves a class-reference enhancer in the consuming module, so `FarmModule` had to see
  the guard's dependencies. The alternative — importing `AuthModule.register(...)` again —
  creates a second `app_auth` pool and a second rate limiter, which the module's own comment
  forbids. The auth database client and the password hasher are still not exported.
- **`Location` is relative** (`/v1/farms/{id}`), not absolute. The API does not trust a `Host`
  header, and a relative `Location` is valid per RFC 9110 §10.2.2.
- **The offset is clamped to `2147483647`** in the service. `page` is any positive integer, and
  `(page - 1) * pageSize` can otherwise exceed PostgreSQL's `OFFSET` argument type. A page past
  the end is an empty `200`, not an error.
- **`farmUpdateSchema` uses `.partial()` plus a root refinement**, so an empty body is a `400`
  whose `details[].path` is `(root)`; no synthetic key is invented.

### 4.4 — Field CRUD — **implemented**

`packages/contracts/src/geometry.ts` (`polygonGeometrySchema`) and `field.ts` (`fieldCreateSchema`,
`fieldUpdateSchema`, `fieldSchema`, `fieldSortSchema`, `fieldListQuerySchema`, `fieldIdSchema`,
both envelopes) are exported from the barrel with `field.test.ts`. `apps/api/src/field/**` adds
`FieldController`, `FieldService`, `FieldModule`, and the geometry-error translation;
`FieldModule` is registered in `AppModule`.

The collection is flat only (`Q3`): `POST/GET /v1/fields`, `GET/PATCH/DELETE /v1/fields/:fieldId`.
The nested `POST/GET /v1/farms/:farmId/fields` route the earlier design sketched was **not**
routed, and the flat list carries an optional `farmId` filter instead, so a parent's not-found
semantics survive without a second URL shape.

Exit, met: `FIELD_NOT_FOUND` on every cross-tenant field attempt, identical to a missing or
deleted one; `FARM_NOT_FOUND` when the *parent* was named (create body, `farmId` filter);
`400 VALIDATION_FAILED` for a non-polygon type, a `crs`/`bbox` member, a third ordinate, an
unclosed or short ring, out-of-range coordinates, and out-of-bounds paging; `201` + relative
`Location`; `204` soft delete with the row preserved; `409 CONFLICT` when a farm still has live
fields and `204` once they are deleted; pagination metadata asserted on both collections.

#### 4.4.1 Deviations recorded while implementing 4.4

- **A `listAllFields(tx, options)` primitive was added next to `listFields`** in
  `packages/database/src/fields.ts`. The flat collection needs the tenant's fields across every
  farm, and `listFields` requires a `farmId`; the alternative was reimplementing the statement in
  the API service, which the phase forbids. It follows `listFarms`'s shape exactly — same
  `user_id` predicate, same `deleted_at IS NULL`, same second `count(*)` statement — and performs
  no write.
- **Geometry refusals are translated by SQLSTATE, not by constraint name.** The contract owns
  structure (type, dimension, ring closure, bounds, extra members); `ST_IsValid`/`ST_IsEmpty`
  own topology. A `FieldGeometryError` from the database layer and a `23514` from either write
  statement both become `400 VALIDATION_FAILED` with `details: [{ path: "geometry", issue:
  "invalid_geometry" }]`. `23503` and every other SQLSTATE keep propagating as a `500`. The
  mapping lives in `apps/api/src/field/field-errors.ts`.
- **`authenticatedUserId(request)` moved into `auth.guard.ts`** and the Farm controller was
  switched to it, so both controllers read the tenant from one function. It still throws the
  guard's `401`; it is not a second authentication check.
- **`location` is relative** for Field as it is for Farm (`/v1/fields/{id}`).

### 4.5 — Hardening — **not started**

Pagination boundaries (page 0, pageSize 101, unknown `sort`) and stable ordering across pages;
`updated_at` movement; soft-delete invisibility for reads *and* writes; statement inventory with
no `SELECT *`; reconcile `IMPLEMENTATION_STATUS.md` and `api-conventions.md` §6 with what
shipped.

Exit: the full workspace suite plus the real-role suites green, and the endpoint matrix in §6.1
implemented one-to-one with no extra route.

### 4.6 — Decision closure — **not started**

`Q5`–`Q8` are answered (§12). If `OPEN-17` or `OPEN-21` is reopened, extend the contract and, only then,
the database. Optional later work this design leaves out: viewport query (`OPEN-22`), field
metadata, farm geometry, `If-Match`. Each is additive.

Exit: every remaining `Q` has a recorded answer, and `IMPLEMENTATION_STATUS.md` distinguishes
`designed` / `implemented` / `verified` per phase.

---

## 14. Consequences and limits

- **The API is narrower than the database.** A `POINT` row can still be written by raw SQL and
  cannot be served by this API. That is `OPEN-17` made visible rather than hidden.
- **Soft delete is an API rule, not a database rule.** Any future code path that forgets
  `deleted_at IS NULL` will return deleted rows; RLS will not stop it. This is the single most
  likely place for a regression, and the 4.2 integration tests are the guard.
- **The delete/create pair is serialised by a lock, not by a constraint.** `softDeleteFarm`
  takes `FOR UPDATE` and `createField` takes `FOR SHARE` on the farm row; removing either
  reintroduces the race, which both integration tests demonstrate.
- **Farm deletion is refused, not cascaded.** Users must delete fields first. If that proves
  poor UX, `Q2` changes one service function, not the schema.
- **No optimistic concurrency.** Two tabs editing one field means the last `PATCH` wins.
- **No rate limit on tenant routes.**
- **`area_ha` for a polygon is computed on the ellipsoid through `geography`.** It will not
  match a planar GIS tool, and it is not meant to; that is the definition.
