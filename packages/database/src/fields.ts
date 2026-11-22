/**
 * Field rows (`docs/architecture/farm-field-domain-contracts.md` §3.2, §6, §10.2).
 *
 * Same three rules as `farms.ts`: the tenant is read from `app.user_id` and never
 * accepted as an argument, `deleted_at IS NULL` is written on every statement, and
 * `updated_at` is maintained by hand.
 *
 * Two rules are specific to this table:
 *
 * 1. **`area_ha` is never written.** It is `GENERATED ALWAYS … STORED` from
 *    `ST_Area(geom::geography) / 10000.0`, so a statement that names it is an
 *    error, not a preference. The value returned here is the database's.
 * 2. **Geometry is GeoJSON.** `ST_GeomFromGeoJSON` parses it and
 *    `ST_AsGeoJSON` renders it back, which keeps one geometry representation and no
 *    JavaScript conversion. The cast to `text` is required: PostGIS 3.6 overloads
 *    `ST_GeomFromGeoJSON` for `text`, `json`, and `jsonb`, so an untyped parameter is
 *    ambiguous (`42725`).
 *
 * `ST_GeomFromGeoJSON` is not a validator, and it is deliberately **not** wrapped in
 * `ST_SetSRID(…, 4326)`. Three behaviours were measured against PostGIS 3.6:
 *
 * | Input | Parser | What catches it |
 * |---|---|---|
 * | Unclosed ring | stored unclosed, `ST_IsValid` false | `fields_geom_valid_check` (`23514`) |
 * | `"crs": "EPSG:3857"` | **honoured**: `ST_SRID` becomes 3857 | `fields_geom_srid_check` (`23514`) — but only because this layer does not overwrite the SRID |
 * | 3D position | parsed as `POLYGON Z`, then **refused** by the column | the column typmod is two-dimensional, so PostGIS rejects the assignment with `22023` (`Geometry has Z dimension but column does not`); the contract's two-number position stays the first guard |
 *
 * The second row is why `ST_SetSRID` is absent. Setting the SRID after parsing turns a
 * client's declared projection into coordinates mislabelled 4326: the CHECK then passes
 * and the area is wrong rather than rejected. `polygonJson` refuses a `crs` member
 * before it reaches SQL, and the parser's own 4326 is what the column verifies.
 */
import { Prisma } from "./generated/prisma/client.js";

import type { TenantTransaction } from "./tenant.js";

/**
 * GeoJSON `Polygon`, EPSG:4326, longitude first, two numbers per position
 * (RFC 7946 removed the `crs` member and fixes WGS 84, which is `fields.geom`'s
 * SRID). Structural only: self-intersection and emptiness are the database's.
 */
export interface PolygonGeometry {
  readonly type: "Polygon";
  readonly coordinates: readonly (readonly (readonly [number, number])[])[];
}

/**
 * The caller passed something the API does not accept as a field shape. Thrown before
 * any statement runs, so the future API can answer `400` instead of translating
 * `23514` — the column accepts `POINT` and `MULTIPOLYGON` (`OPEN-17`), so the database
 * cannot be the only filter.
 */
export class FieldGeometryError extends Error {
  override readonly name = "FieldGeometryError";
}

export interface Field {
  readonly id: string;
  readonly farmId: string;
  readonly name: string;
  readonly geometry: PolygonGeometry;
  /** Hectares, from the generated column, unrounded. */
  readonly areaHa: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface FieldCreate {
  readonly name: string;
  readonly geometry: PolygonGeometry;
}

/** Absent means "leave unchanged"; there is no way to clear a field's name or shape. */
export interface FieldUpdate {
  readonly name?: string;
  readonly geometry?: PolygonGeometry;
}

export type FieldSort =
  "name" | "-name" | "createdAt" | "-createdAt" | "updatedAt" | "-updatedAt" | "areaHa" | "-areaHa";

export interface FieldListOptions {
  readonly limit: number;
  readonly offset: number;
  readonly sort: FieldSort;
}

export interface FieldPage {
  readonly items: readonly Field[];
  readonly total: number;
}

const FIELD_ORDER: Record<FieldSort, string> = {
  name: "name ASC, id ASC",
  "-name": "name DESC, id DESC",
  createdAt: "created_at ASC, id ASC",
  "-createdAt": "created_at DESC, id DESC",
  updatedAt: "updated_at ASC, id ASC",
  "-updatedAt": "updated_at DESC, id DESC",
  areaHa: "area_ha ASC, id ASC",
  "-areaHa": "area_ha DESC, id DESC",
};

/**
 * The columns every read returns, rendered into each statement so the shape cannot
 * drift between find, list, insert, and update. `geom` and `area_ha` are
 * `Unsupported(...)` in Prisma, which is why these are raw statements at all.
 */
const FIELD_COLUMNS = Prisma.raw(
  "id::text AS id, farm_id::text AS farm_id, name, " +
    "public.ST_AsGeoJSON(geom)::jsonb AS geometry, area_ha, created_at, updated_at",
);

/** One statement, so the returned row is the row that was written. */
export async function createField(
  tx: TenantTransaction,
  farmId: string,
  input: FieldCreate,
): Promise<Field | null> {
  // Refused before the lock is taken: a shape this layer cannot store is not worth
  // holding a row lock for, and the answer does not depend on the tenant.
  const geometry = polygonJson(input.geometry);

  // `FOR SHARE` is what makes farm deletion safe against this insert: it conflicts
  // with `softDeleteFarm`'s `FOR UPDATE`, so one of the two waits. When this
  // statement waits, READ COMMITTED re-checks `deleted_at IS NULL` against the
  // committed row and the insert is refused instead of landing on a dead farm.
  const parent = await tx.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id
      FROM app.farms
     WHERE id = ${farmId}::uuid
       AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
       AND deleted_at IS NULL
     FOR SHARE
  `;

  if (parent.length === 0) return null;

  const rows = await tx.$queryRaw<RawField[]>`
    INSERT INTO app.fields (user_id, farm_id, name, geom)
    VALUES (
      NULLIF(current_setting('app.user_id', true), '')::uuid,
      ${farmId}::uuid,
      ${input.name},
      public.ST_GeomFromGeoJSON(${geometry}::text)
    )
    RETURNING ${FIELD_COLUMNS}
  `;

  const row = rows[0];
  if (row === undefined) throw new Error("field insert returned no row");
  return toField(row);
}

/** `null` when the farm is not this tenant's or is soft-deleted: the list is not empty, the parent is gone. */
export async function listFields(
  tx: TenantTransaction,
  farmId: string,
  options: FieldListOptions,
): Promise<FieldPage | null> {
  const parent = await tx.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id
      FROM app.farms
     WHERE id = ${farmId}::uuid
       AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
       AND deleted_at IS NULL
  `;

  if (parent.length === 0) return null;

  const rows = await tx.$queryRaw<RawField[]>`
    SELECT ${FIELD_COLUMNS}
      FROM app.fields
     WHERE farm_id = ${farmId}::uuid
       AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
       AND deleted_at IS NULL
     ORDER BY ${rawOrder(options.sort)}
     LIMIT ${options.limit} OFFSET ${options.offset}
  `;

  const counted = await tx.$queryRaw<{ total: number }[]>`
    SELECT count(*)::int AS total
      FROM app.fields
     WHERE farm_id = ${farmId}::uuid
       AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
       AND deleted_at IS NULL
  `;

  return {
    items: rows.map(toField),
    total: counted[0]?.total ?? 0,
  };
}

/**
 * The tenant's live fields across every farm, for the flat collection
 * (`/v1/fields`, `Q3`). The parent check in `listFields` does not apply: a field
 * whose farm is soft-deleted is not reachable through this list either, because
 * the API soft-deletes fields before it allows the farm to go, and the field's own
 * `deleted_at IS NULL` predicate is the one that decides.
 *
 * `total` is counted in its own statement, with the same consequence documented on
 * `listFarms`: a concurrent insert can move the total by one.
 */
export async function listAllFields(
  tx: TenantTransaction,
  options: FieldListOptions,
): Promise<FieldPage> {
  const rows = await tx.$queryRaw<RawField[]>`
    SELECT ${FIELD_COLUMNS}
      FROM app.fields
     WHERE user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
       AND deleted_at IS NULL
     ORDER BY ${rawOrder(options.sort)}
     LIMIT ${options.limit} OFFSET ${options.offset}
  `;

  const counted = await tx.$queryRaw<{ total: number }[]>`
    SELECT count(*)::int AS total
      FROM app.fields
     WHERE user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
       AND deleted_at IS NULL
  `;

  return {
    items: rows.map(toField),
    total: counted[0]?.total ?? 0,
  };
}

/** Another tenant's field and a field that does not exist both return `null`. */
export async function findField(tx: TenantTransaction, fieldId: string): Promise<Field | null> {
  const rows = await tx.$queryRaw<RawField[]>`
    SELECT ${FIELD_COLUMNS}
      FROM app.fields
     WHERE id = ${fieldId}::uuid
       AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
       AND deleted_at IS NULL
  `;

  const row = rows[0];
  return row === undefined ? null : toField(row);
}

/**
 * Replacing `geom` recomputes `area_ha` in the same row version, because the column
 * is generated. Nothing in the application has to notice that it changed.
 */
export async function updateField(
  tx: TenantTransaction,
  fieldId: string,
  input: FieldUpdate,
): Promise<Field | null> {
  const geometry = input.geometry === undefined ? null : polygonJson(input.geometry);

  const rows = await tx.$queryRaw<RawField[]>`
    UPDATE app.fields
       SET name       = COALESCE(${input.name ?? null}, name),
           geom       = CASE WHEN ${input.geometry !== undefined}::boolean
                             THEN public.ST_GeomFromGeoJSON(${geometry}::text)
                             ELSE geom END,
           updated_at = now()
     WHERE id = ${fieldId}::uuid
       AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
       AND deleted_at IS NULL
    RETURNING ${FIELD_COLUMNS}
  `;

  const row = rows[0];
  return row === undefined ? null : toField(row);
}

/**
 * `false` when no live field matched — another tenant's, an already-deleted one, and
 * a nonexistent one are the same answer (`revokeSession` sets this precedent).
 */
export async function softDeleteField(tx: TenantTransaction, fieldId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    UPDATE app.fields
       SET deleted_at = now(), updated_at = now()
     WHERE id = ${fieldId}::uuid
       AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
       AND deleted_at IS NULL
    RETURNING id::text AS id
  `;

  return rows.length > 0;
}

/**
 * A field's geographic anchor: the centroid of its geometry, as six-decimal
 * strings. `lat`/`lon`, never one packed value, and never a served coordinate or
 * a grid-cell anchor — those are different concepts (§5.2.9.2).
 *
 * Strings, not numbers: `resolveGridCell` takes canonical decimal strings, and a
 * JavaScript number cannot carry `-6.150000` — it would arrive as `-6.15` and the
 * precision the SQL rounded to would be lost before the resolver saw it.
 */
export interface FieldAnchor {
  readonly lat: string;
  readonly lon: string;
}

/**
 * The centroid of one live, tenant-visible field (`climate-data-foundation.md`
 * §8.2 step 5.2.5).
 *
 * Rounding is PostgreSQL's: `round(ST_Y(...)::numeric, 6)` keeps a numeric scale
 * of six, so its text form is exactly six decimals. Formatting in JavaScript
 * would reintroduce the floating-point value the cast exists to avoid.
 *
 * `ST_X` is longitude and `ST_Y` is latitude; the statement names them that way
 * so the axes cannot be swapped silently. Another tenant's field, a soft-deleted
 * one, and a nonexistent one all return `null` — the same answer, so the call
 * cannot be used to probe for a field it may not see.
 */
export async function selectFieldAnchor(
  tx: TenantTransaction,
  fieldId: string,
): Promise<FieldAnchor | null> {
  const rows = await tx.$queryRaw<{ lat: string; lon: string }[]>`
    SELECT round(public.ST_Y(centroid)::numeric, 6)::text AS lat,
           round(public.ST_X(centroid)::numeric, 6)::text AS lon
      FROM (
        SELECT public.ST_Centroid(geom) AS centroid
          FROM app.fields
         WHERE id = ${fieldId}::uuid
           AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
           AND deleted_at IS NULL
      ) AS anchor
  `;

  const row = rows[0];
  return row === undefined ? null : { lat: row.lat, lon: row.lon };
}

interface RawField {
  readonly id: string;
  readonly farm_id: string;
  readonly name: string;
  readonly geometry: unknown;
  readonly area_ha: number | null;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

function toField(row: RawField): Field {
  if (typeof row.area_ha !== "number") {
    // Unreachable while `geom` is `NOT NULL` and valid: the generated column is
    // null only when its input is. Failing is better than serving `NaN`.
    throw new Error(`field ${row.id} has no generated area`);
  }

  return {
    id: row.id,
    farmId: row.farm_id,
    name: row.name,
    geometry: toPolygon(row.geometry),
    areaHa: row.area_ha,
    createdAt: asDate(row.created_at),
    updatedAt: asDate(row.updated_at),
  };
}

/**
 * Serialises the polygon, after refusing the two shapes the wire contract refuses and
 * the database cannot: a non-polygon type, and an RFC 7946 member that would change how
 * the coordinates are read.
 */
function polygonJson(geometry: PolygonGeometry): string {
  const candidate = geometry as {
    readonly type: string;
    readonly crs?: unknown;
    readonly bbox?: unknown;
  };

  if (candidate.type !== "Polygon") {
    throw new FieldGeometryError(`geometry type must be Polygon, received ${candidate.type}`);
  }
  if (candidate.crs !== undefined || candidate.bbox !== undefined) {
    throw new FieldGeometryError("geometry must be RFC 7946: crs and bbox are not accepted");
  }

  return JSON.stringify(geometry);
}

/**
 * A raw row may still be a `POINT` or `MULTIPOLYGON`: the column accepts both
 * (`OPEN-17`), and only the API refuses them. Returning such a value as a
 * `PolygonGeometry` would be a lie the type system cannot catch, so the shape is
 * checked here rather than cast away.
 */
function toPolygon(value: unknown): PolygonGeometry {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("type" in parsed) ||
    parsed.type !== "Polygon" ||
    !("coordinates" in parsed) ||
    !Array.isArray(parsed.coordinates)
  ) {
    throw new Error("field geometry is not a GeoJSON Polygon");
  }

  return { type: "Polygon", coordinates: parsed.coordinates as PolygonGeometry["coordinates"] };
}

/** `timestamptz` arrives as a `Date` through `pg`; a string is tolerated, not expected. */
function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/** The sort order is a whitelisted constant, never caller text. */
function rawOrder(sort: FieldSort): Prisma.Sql {
  return Prisma.raw(FIELD_ORDER[sort]);
}
