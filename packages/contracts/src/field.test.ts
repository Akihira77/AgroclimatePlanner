import { describe, expect, it } from "vitest";

import {
  fieldAgronomyUpdateSchema,
  fieldCreateSchema,
  fieldListQuerySchema,
  fieldSchema,
  fieldUpdateSchema,
} from "./field.js";
import type { PolygonGeometry } from "./geometry.js";
import { polygonGeometrySchema } from "./geometry.js";

const SQUARE: PolygonGeometry = {
  type: "Polygon",
  coordinates: [
    [
      [106.8, -6.2],
      [106.9, -6.2],
      [106.9, -6.1],
      [106.8, -6.1],
      [106.8, -6.2],
    ],
  ],
};

const BOWTIE = {
  type: "Polygon",
  coordinates: [
    [
      [106.8, -6.2],
      [106.9, -6.1],
      [106.9, -6.2],
      [106.8, -6.1],
      [106.8, -6.2],
    ],
  ],
};

/** The outer ring, already typed: `noUncheckedIndexedAccess` makes `[0]` optional. */
const RING = SQUARE.coordinates[0]!;

describe("polygonGeometrySchema", () => {
  it("accepts a closed 2D polygon and keeps it unchanged", () => {
    expect(polygonGeometrySchema.parse(SQUARE)).toEqual(SQUARE);
  });

  it("accepts a self-intersecting ring: topology is PostgreSQL's job", () => {
    // ST_IsValid is the only implementation. Duplicating GEOS here would let the
    // two disagree at exactly the polygons that matter.
    expect(polygonGeometrySchema.safeParse(BOWTIE).success).toBe(true);
  });

  it("refuses every non-Polygon type", () => {
    for (const type of [
      "Point",
      "MultiPoint",
      "LineString",
      "MultiLineString",
      "MultiPolygon",
      "GeometryCollection",
      "polygon",
      "Unknown",
    ]) {
      expect(polygonGeometrySchema.safeParse({ type, coordinates: [] }).success).toBe(false);
    }
  });

  it("refuses a three-dimensional position", () => {
    const geometry = {
      type: "Polygon",
      coordinates: [RING.map(([x, y]) => [x, y, 0])],
    };
    expect(polygonGeometrySchema.safeParse(geometry).success).toBe(false);
  });

  it("refuses an empty polygon, a short ring and an unclosed ring", () => {
    expect(polygonGeometrySchema.safeParse({ type: "Polygon", coordinates: [] }).success).toBe(
      false,
    );
    expect(
      polygonGeometrySchema.safeParse({
        type: "Polygon",
        coordinates: [[RING[0]!, RING[1]!, RING[0]!]],
      }).success,
    ).toBe(false);
    expect(
      polygonGeometrySchema.safeParse({
        type: "Polygon",
        coordinates: [RING.slice(0, -1)],
      }).success,
    ).toBe(false);
  });

  it("refuses crs, bbox and any other member", () => {
    for (const extra of [
      { crs: { type: "name", properties: { name: "EPSG:3857" } } },
      { bbox: [106.8, -6.2, 106.9, -6.1] },
      { name: "field" },
    ]) {
      expect(polygonGeometrySchema.safeParse({ ...SQUARE, ...extra }).success).toBe(false);
    }
  });

  it("refuses coordinates outside WGS 84 and non-numeric ordinates", () => {
    const edge = (position: [number, number]) => ({
      type: "Polygon",
      coordinates: [[position, [106.9, -6.2], [106.9, -6.1], position]],
    });

    expect(polygonGeometrySchema.safeParse(edge([181, -6.2])).success).toBe(false);
    expect(polygonGeometrySchema.safeParse(edge([106.8, -91])).success).toBe(false);
    expect(
      polygonGeometrySchema.safeParse(edge(["106.8", -6.2] as unknown as [number, number])).success,
    ).toBe(false);
    expect(polygonGeometrySchema.safeParse(edge([106.8, -6.2])).success).toBe(true);
  });
});

describe("fieldCreateSchema", () => {
  it("requires a UUID parent and a Polygon, and trims the name", () => {
    expect(
      fieldCreateSchema.parse({
        farmId: "01a1fd05-e72e-7a18-828c-e47aecc81efa",
        name: "  North plot ",
        geometry: SQUARE,
      }).name,
    ).toBe("North plot");

    expect(
      fieldCreateSchema.safeParse({ farmId: "not-a-uuid", name: "a", geometry: SQUARE }).success,
    ).toBe(false);
    expect(
      fieldCreateSchema.safeParse({
        farmId: "01a1fd05-e72e-7a18-828c-e47aecc81efa",
        name: "  ",
        geometry: SQUARE,
      }).success,
    ).toBe(false);
    expect(
      fieldCreateSchema.safeParse({
        farmId: "01a1fd05-e72e-7a18-828c-e47aecc81efa",
        name: "a",
        geometry: BOWTIE,
      }).success,
    ).toBe(true);
  });

  it("refuses server-managed and agronomic properties", () => {
    const base = {
      farmId: "01a1fd05-e72e-7a18-828c-e47aecc81efa",
      name: "a",
      geometry: SQUARE,
    };
    for (const extra of [
      { areaHa: 1 },
      { userId: "01a1fd05-e72e-7a18-828c-e47aecc81efa" },
      { deletedAt: null },
      { soilType: "clay" },
      { elevationM: 10 },
    ]) {
      expect(fieldCreateSchema.safeParse({ ...base, ...extra }).success).toBe(false);
    }
  });
});

describe("fieldUpdateSchema", () => {
  it("accepts one writable property and refuses an empty body", () => {
    expect(fieldUpdateSchema.safeParse({ name: "B" }).success).toBe(true);
    expect(fieldUpdateSchema.safeParse({ geometry: SQUARE }).success).toBe(true);
    expect(fieldUpdateSchema.safeParse({}).success).toBe(false);
  });

  it("refuses re-parenting, generated values and null names", () => {
    for (const body of [
      { farmId: "01a1fd05-e72e-7a18-828c-e47aecc81efa" },
      { areaHa: 2 },
      { name: null },
      { extra: true },
    ]) {
      expect(fieldUpdateSchema.safeParse(body).success).toBe(false);
    }
  });
});

describe("fieldListQuerySchema", () => {
  it("defaults the page and leaves farmId absent", () => {
    expect(fieldListQuerySchema.parse({})).toEqual({
      page: 1,
      pageSize: 20,
      sort: "-createdAt",
    });
  });

  it("accepts area sorting and a farmId filter", () => {
    const parsed = fieldListQuerySchema.parse({
      sort: "-areaHa",
      farmId: "01a1fd05-e72e-7a18-828c-e47aecc81efa",
    });
    expect(parsed.sort).toBe("-areaHa");
    expect(parsed.farmId).toBe("01a1fd05-e72e-7a18-828c-e47aecc81efa");
  });

  it("refuses an unknown parameter and a non-UUID filter", () => {
    expect(fieldListQuerySchema.safeParse({ filter: "x" }).success).toBe(false);
    expect(fieldListQuerySchema.safeParse({ farmId: "nope" }).success).toBe(false);
    expect(fieldListQuerySchema.safeParse({ pageSize: "101" }).success).toBe(false);
  });
});

describe("fieldSchema", () => {
  const field = {
    id: "01a1fd05-e72e-7a18-828c-e47aecc81efa",
    farmId: "01b1fd05-e72e-7a18-828c-e47aecc81efa",
    name: "North plot",
    geometry: SQUARE,
    areaHa: 123.45,
    createdAt: "2026-11-21T00:00:00.000Z",
    updatedAt: "2026-11-21T00:00:00.000Z",
  };

  it("accepts the public representation", () => {
    expect(fieldSchema.safeParse(field).success).toBe(true);
  });

  it("refuses tenant, deletion and agronomic properties, and a non-positive area", () => {
    for (const extra of [
      { userId: field.id },
      { deletedAt: null },
      { soilType: "clay" },
      { areaHa: 0 },
    ]) {
      expect(fieldSchema.safeParse({ ...field, ...extra }).success).toBe(false);
    }
  });
});

describe("fieldAgronomyUpdateSchema (OPEN-21)", () => {
  it("accepts valid agronomic properties and nullable clears, rejects empty or out-of-range", () => {
    expect(
      fieldAgronomyUpdateSchema.safeParse({
        soilType: "volcanic",
        drainageClass: "well",
        soilPh: 6.2,
        elevationM: 450,
        irrigationAvailability: "partial_irrigation",
      }).success,
    ).toBe(true);

    expect(fieldAgronomyUpdateSchema.safeParse({ soilType: null }).success).toBe(true);
    expect(fieldAgronomyUpdateSchema.safeParse({}).success).toBe(false);
    expect(fieldAgronomyUpdateSchema.safeParse({ soilType: "granite" }).success).toBe(false);
    expect(fieldAgronomyUpdateSchema.safeParse({ soilPh: 12 }).success).toBe(false);
    expect(fieldAgronomyUpdateSchema.safeParse({ elevationM: 7000 }).success).toBe(false);
  });
});
