import { z } from "zod";

/**
 * GeoJSON geometry for the Field API (`docs/architecture/farm-field-domain-contracts.md`
 * §7, `docs/data-model/spatial-model.md` §1).
 *
 * The contract is the *cheap* structural half of geometry validation, and only
 * that: type, dimension, ring closure, ring length, and coordinate bounds. Spatial
 * topology (self-intersection, emptiness) is `ST_IsValid`/`ST_IsEmpty`'s job in
 * PostgreSQL and is deliberately not reimplemented — a JavaScript copy of GEOS
 * would be a second source of truth that disagrees at the edges.
 *
 * Four properties are load-bearing:
 *
 * - `z.literal("Polygon")` refuses `POINT`, `MULTIPOLYGON`, and every other type.
 *   The column itself accepts them (`OPEN-17`), so the API is the only filter.
 * - `z.tuple` of exactly two numbers refuses a third ordinate. `POLYGON Z` is
 *   accepted by PostGIS with no database objection, so this is the only guard.
 * - `strictObject` refuses `crs`, `bbox`, and any other member. RFC 7946 removed
 *   `crs` and fixes WGS 84; PostGIS actually honours a declared `crs` (measured:
 *   SRID 3857), so silently accepting one would store coordinates under the wrong
 *   label.
 * - The ring is checked for closure here because a `400` is cheaper than a
 *   `23514` round trip, and because PostGIS does not repair it.
 */

/** Degrees east, inclusive of the antimeridian pair the RFC allows. */
const longitude = z.number().finite().gte(-180).lte(180);

/** Degrees north. */
const latitude = z.number().finite().gte(-90).lte(90);

/** `[longitude, latitude]` — no altitude, no M value, no third element. */
const position = z.tuple([longitude, latitude]);

const linearRing = z
  .array(position)
  .min(4)
  .refine(
    (ring) =>
      ring.length >= 4 &&
      ring[0]?.[0] === ring[ring.length - 1]?.[0] &&
      ring[0]?.[1] === ring[ring.length - 1]?.[1],
    { message: "ring must be closed" },
  );

export const polygonGeometrySchema = z.strictObject({
  type: z.literal("Polygon"),
  coordinates: z.array(linearRing).min(1),
});
export type PolygonGeometry = z.infer<typeof polygonGeometrySchema>;
