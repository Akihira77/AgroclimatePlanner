# Spatial Model

One geometry column in the whole model: `app.fields.geom`. Everything else that
is spatial is derived from it, or is a coordinate pair in `double precision`.

The reason for so little geometry is the same reason for the tight constraints on
it: a field's geometry decides which forecast cell serves it, and that decision is
frozen into every artifact computed from it. A geometry that is silently wrong
produces recommendations that are confidently wrong.

## 1. `fields.geom`

```sql
geom public.geometry(Geometry, 4326) NOT NULL
  CONSTRAINT fields_geom_type_check
    CHECK (public.GeometryType(geom) IN ('POINT','POLYGON','MULTIPOLYGON'))
  CONSTRAINT fields_geom_srid_check
    CHECK (public.ST_SRID(geom) = 4326)
  CONSTRAINT fields_geom_valid_check
    CHECK (public.ST_IsValid(geom))
  CONSTRAINT fields_geom_not_empty_check
    CHECK (NOT public.ST_IsEmpty(geom))
```

| Decision | Value | Reason |
|---|---|---|
| CRS | EPSG:4326 (WGS 84 lon/lat) | every provider serves 4326; storing a projected CRS would require conversion on every provider comparison |
| declared type | `geometry` (generic) with a `CHECK` | a `geometry(Point,4326)` column cannot hold a polygon, and a `geometry(Geometry,4326)` column alone would accept a `LINESTRING` |
| allowed types | `POINT`, `POLYGON`, `MULTIPOLYGON` | a point is a field whose extent the user does not know; a line is not a field |
| axis order | longitude first (`x = lon`, `y = lat`) | EWKB and every PostGIS function assume it; a lat/lon swap puts Indonesian fields in the Indian Ocean, and `ST_IsValid` will not complain |
| validity | `ST_IsValid` at write time | a self-intersecting polygon has an undefined area — and `area_ha` is generated from it |

**Why the generic type plus a `CHECK`, not three columns.** `ADR-002` D3 says
"every geometry column is `geometry(Point|Polygon, 4326)`"; the implementation
uses the generic type with a `GeometryType` check, which is strictly stronger
(it also refuses `LINESTRING`, `GEOMETRYCOLLECTION`, and `CURVE`). The difference
is recorded in `consistency-checklist.md` item 3 — the code is right and the ADR
sentence is narrower than the code.

`MULTIPOLYGON` is allowed because a farm plot split by a road is one field to the
user. No document forbids it.

### Schema qualification is mandatory in migrations

The migration connection's `search_path` is `app`, and PostGIS lives in `public`.
A migration that writes `geometry(...)` or `ST_Area(...)` unqualified fails with
`type "geometry" does not exist` in a fresh database — it only appears to work in
a session where `public` happens to be on the path. Every PostGIS type and
function in a migration is written `public.geometry`, `public.ST_Area`,
`public.ST_SRID`, `public.ST_IsValid`, `public.ST_IsEmpty`, `public.GeometryType`.
This was a real failure in Phase 2.2.3 and is now a review rule, not a habit.

## 2. `area_ha` — generated, and wrong for a point

```sql
area_ha double precision
  GENERATED ALWAYS AS (public.ST_Area(geom::public.geography) / 10000.0) STORED
```

- `STORED`, not `VIRTUAL`, because it is indexed-adjacent and read on every field
  list; PostgreSQL 18 supports both and `STORED` is the one with a stable plan.
- Cast to `geography` before `ST_Area` so the result is **square metres on the
  ellipsoid**, not square degrees. `ST_Area(geometry)` in 4326 returns degrees²,
  which for a 1 km² field near Jakarta is `0.0000…` — the classic silent unit bug.
- Divided by `10 000` → hectares, one definition, not re-rounded anywhere
  (`physical-model.md` §4).
- The application never writes it. A raw `INSERT` that names it is an error.
- The column declares **no `NOT NULL`**: it is nullable in the DDL and is non-null
  only because `geom` is `NOT NULL` and valid. `tables-identity.md` §3 separates
  the three claims (declared, always present, always meaningful) with the
  measurement behind them.

**A `POINT` field has `area_ha = 0`.** PostGIS returns 0 for the area of a point,
and the generated column faithfully stores 0. `FieldSnapshotPayload.areaHa` is
`z.number().positive()`, so a point-shaped field cannot produce a valid field
snapshot at all — the contract rejects it. That is `OPEN-17` (**P1**, and P0 if
point fields become a v1 requirement; scope in
`open-decisions.md` §1.1): either point fields are disallowed (and the
`GeometryType` check drops `POINT`), or `areaHa` becomes nullable for them, or a
point gets an assumed area from a declared radius. **No option is chosen here,
and no estimated area is assumed.** Until it is, the schema accepts a field shape
the provenance contract cannot describe, which is a defect in one of the two.
A `POLYGON`/`MULTIPOLYGON` field is unaffected: its area is positive.

## 3. Indexes

| Index | Definition | Status |
|---|---|---|
| `fields_geom_gist_idx` | `USING gist (geom)` | exists (Phase 2.2.3) — **currently unused by any query** |

No query in this model performs a spatial predicate. Field resolution uses the
provider's rounding rule (arithmetic on coordinates), not a spatial index; the
"which fields are in this cell" direction reads `field_outlook_cells`, which is a
`uuid` join.

The index therefore exists for a query that is planned, not written:
`ST_Intersects(fields.geom, <polygon>)` for a map viewport, in Phase 6. It is
recorded as `OPEN-22` rather than justified retroactively — an index whose
justification is "we will probably need it" is how write amplification gets
added to a table for no measured reason. The cost is real: every field write
maintains a GiST entry.

**Decision if Phase 6 slips:** drop it. Adding it back is one migration; carrying
it is permanent write cost.

## 4. Coordinates that are not geometry

Every other spatial quantity is a scalar, because it is a *measurement* rather
than a shape:

| Column | Table | Meaning |
|---|---|---|
| `served_lat`, `served_lon` | `outlook_cells` | the coordinate the provider reported for that grid node |
| `requested_lat`, `requested_lon` | `weather_records` | the coordinate we asked for |
| `served_lat`, `served_lon` | `weather_records` | the coordinate the provider answered for |
| `served_value_is_interpolated` | `weather_records` | `true` when the answer is an interpolation, not a node value |

A `geometry(Point)` column for these would invite `ST_Distance` between a served
coordinate and a field centroid — which computes a geodesic distance that is
*not* the number the model uses, because the model's distance is defined on the
resolution row. Two ways to compute one number is how they disagree.

`served_lat`/`served_lon` are nullable on both tables because they are only known
after the first successful ingest; the pair is constrained to be both-null or
both-present (`(served_lat IS NULL) = (served_lon IS NULL)`).

Measured spread from Phase 1, which is why interpolation is a displayed fact
rather than an implementation detail: for one Jakarta point the providers
returned `-6.323185/106.68874` (seasonal), `-6.221441/106.78094` (ERA5) and
`-6.25/106.75` (IFS ENS) — up to **15.2 km** apart. A user told "the forecast for
your field" is being told about a point up to 15 km away, and
`served_value_is_interpolated` is what makes that honest.

## 5. Field → cell resolution

`app.field_outlook_cells` (specified in `tables-identity.md` §4) is the join
between the only geometry in the model and the global weather plane.

| Property | Rule |
|---|---|
| cardinality | at most one **live** row per `(field_id, provider, model)`; enforced by a partial unique index on `superseded_at IS NULL` |
| anchor | the field's geometry reduced to a point by `extraction_policy` |
| `extraction_policy = 'centroid'` | `ST_Centroid(geom)` (or the point itself for a `POINT` field) |
| `extraction_policy = 'area_weighted'` | multiple cells weighted by intersecting area; the row records the **nearest/primary** cell and the engine reads the rest from the weight set |
| `distance_km` | geodesic distance from the anchor to the served coordinate, computed once and stored |
| `elevation_delta_m` | `outlook_cells.elevation_m - fields.elevation_m`, `NULL` when either is unknown |
| recomputation | on geometry edit only — a new provider or a new run does **not** re-resolve the field; the cell identity is stable and the values change under it |

`area_weighted` is specified as an enum value but has no algorithm in any
document. It is not `OPEN` because nothing selects it: `centroid` is the v1
policy, and the second value exists so the `CHECK` can name it when the engine
grows the capability (`OPEN-15` tracks the weight-set table that would be
required — the resolution row alone cannot describe it).

## 6. Geometry change invalidates artifacts

`FieldSnapshotPayload.geometryHash` is **SHA-256 of the stored EWKB
representation, without geometry normalization** (`provenance-contract.md` §4
states the preimage as "geometry in canonical EWKB"; this directory specifies
what "canonical" can only mean here — see the note below). Concretely:

```sql
SELECT encode(sha256(public.ST_AsEWKB(geom)), 'hex') FROM app.fields WHERE id = $1;
```

(`sha256(bytea)` is PostgreSQL 18's built-in; the hex encoding is lowercase and
matches the `^[0-9a-f]{64}$` check every hash column carries.)

**"Without normalization" is the load-bearing part, and it means the hash is not
a topological identity.** Consequences that are decisions:

1. **The hash is over the stored geometry as PostGIS serialises it**, not over a
   re-normalised form. `ST_AsEWKB` preserves ring orientation and vertex order,
   so two geometrically identical polygons drawn in different directions hash
   differently. That is acceptable and deliberate: the preimage must be
   reproducible from the stored row, and a normalisation step would be a second
   serializer whose output nobody has golden vectors for.
2. **A geometry edit changes `geometryHash`, therefore `fieldSnapshotHash`,
   therefore the input hash of every artifact that used it.** The artifacts are
   not updated — they are superseded by a recompute, and the old ones remain
   explainable because they carry the snapshot they were computed from.
3. **A cosmetic edit still invalidates.** Dragging one vertex by a metre changes
   the hash and costs a recompute. This is the correct trade: the alternative is
   a tolerance, and a tolerance is a rule about how wrong a field may be before
   the recommendation notices.
4. Phase 3 must expose `geometryHash` computation from the database, not from the
   application: the application holding a copy of the polygon would be a second
   representation that can disagree with the stored one.

### On the word "canonical"

`provenance-contract.md` §4 writes the preimage as "geometry in canonical EWKB".
That phrase is preserved there (the document is out of scope for this correction
pass) but it is easy to misread as "normalized", which the design does **not** do.
Precisely:

| Claim | True? |
|---|---|
| the preimage is deterministic for one stored row | **yes** — `ST_AsEWKB` on the same stored geometry returns the same bytes |
| the preimage is the same for two topologically equivalent polygons | **no** |
| the preimage is the same for the same polygon with reversed ring orientation | **no** |
| the preimage is the same for the same ring with a rotated vertex start | **no** |
| the hash therefore identifies a *representation*, not a shape | **yes** |

Recorded as a documentation discrepancy in `consistency-checklist.md` item 6.5
rather than by editing `provenance-contract.md`, because a normative architecture
document is not corrected by a data-model pass.

## 7. What is deliberately absent

| Absent | Why |
|---|---|
| a `regions` / administrative boundary table | `farms.region` is free text; BMKG's `adm4` code is provider-side and its master list is unpublished (`weather-source-matrix.md`) |
| elevation raster / DEM | `fields.elevation_m` is user-supplied or provider-supplied; a DEM is a dataset the model does not own |
| geometry history | supersession is on the resolution rows and on the artifacts, not on the field row; a full geometry audit trail is `OPEN-04`-adjacent and not requested |
| a geography-typed copy of `geom` | the cast is cheap and a stored copy can drift |
| spatial index on `outlook_cells` | a cell has no geometry — only a coordinate pair and a `cell_key` |
| H3/S2 cell ids | the provider grids are not ours to re-index; tying storage to a tiling is a one-way decision |
