import { describe, expect, it } from "vitest";

import {
  farmCreateSchema,
  farmListEnvelopeSchema,
  farmListQuerySchema,
  farmSchema,
  farmUpdateSchema,
} from "./farm.js";

describe("farmCreateSchema", () => {
  it("trims text and keeps null distinct from absent", () => {
    expect(farmCreateSchema.parse({ name: "  Block A " })).toEqual({ name: "Block A" });
    expect(farmCreateSchema.parse({ name: "A", region: null })).toEqual({
      name: "A",
      region: null,
    });
  });

  it("enforces the approved lengths (Q6)", () => {
    expect(farmCreateSchema.safeParse({ name: "a".repeat(100) }).success).toBe(true);
    expect(farmCreateSchema.safeParse({ name: "a".repeat(101) }).success).toBe(false);
    expect(farmCreateSchema.safeParse({ name: "A", region: "r".repeat(120) }).success).toBe(true);
    expect(farmCreateSchema.safeParse({ name: "A", region: "r".repeat(121) }).success).toBe(false);
    expect(farmCreateSchema.safeParse({ name: "A", notes: "n".repeat(2000) }).success).toBe(true);
    expect(farmCreateSchema.safeParse({ name: "A", notes: "n".repeat(2001) }).success).toBe(false);
  });

  it("rejects a blank name and unknown keys", () => {
    expect(farmCreateSchema.safeParse({ name: "   " }).success).toBe(false);
    expect(farmCreateSchema.safeParse({ name: "A", userId: "x" }).success).toBe(false);
    expect(farmCreateSchema.safeParse({ name: "A", deletedAt: null }).success).toBe(false);
  });
});

describe("farmUpdateSchema", () => {
  it("requires at least one key", () => {
    expect(farmUpdateSchema.safeParse({}).success).toBe(false);
    expect(farmUpdateSchema.safeParse({ notes: null }).success).toBe(true);
  });

  it("keeps name non-nullable and refuses unknown keys", () => {
    expect(farmUpdateSchema.safeParse({ name: null }).success).toBe(false);
    expect(farmUpdateSchema.parse({ name: "  B  " })).toEqual({ name: "B" });
    expect(farmUpdateSchema.safeParse({ areaHa: 1 }).success).toBe(false);
  });
});

describe("farmListQuerySchema", () => {
  it("defaults page, pageSize and sort", () => {
    expect(farmListQuerySchema.parse({})).toEqual({ page: 1, pageSize: 20, sort: "-createdAt" });
  });

  it("coerces numeric strings and rejects values outside the bounds", () => {
    expect(farmListQuerySchema.parse({ page: "2", pageSize: "100" })).toEqual({
      page: 2,
      pageSize: 100,
      sort: "-createdAt",
    });
    for (const value of [{ page: "0" }, { page: "1.5" }, { page: "x" }, { pageSize: "101" }]) {
      expect(farmListQuerySchema.safeParse(value).success).toBe(false);
    }
  });

  it("refuses an unknown parameter and an unlisted sort", () => {
    expect(farmListQuerySchema.safeParse({ filter: "x" }).success).toBe(false);
    expect(farmListQuerySchema.safeParse({ sort: "areaHa" }).success).toBe(false);
  });
});

describe("farmSchema and its envelopes", () => {
  const farm = {
    id: "01a1fd05-e72e-7a18-828c-e47aecc81efa",
    name: "Block A",
    region: null,
    notes: null,
    createdAt: "2026-11-21T00:00:00.000Z",
    updatedAt: "2026-11-21T00:00:00.000Z",
  };

  it("accepts the public representation only", () => {
    expect(farmSchema.safeParse(farm).success).toBe(true);
    expect(farmSchema.safeParse({ ...farm, userId: farm.id }).success).toBe(false);
    expect(farmSchema.safeParse({ ...farm, createdAt: "2026-11-21" }).success).toBe(false);
  });

  it("carries the page meta the convention shows", () => {
    expect(
      farmListEnvelopeSchema.safeParse({
        data: [farm],
        meta: { page: 1, pageSize: 20, total: 1 },
      }).success,
    ).toBe(true);
    expect(
      farmListEnvelopeSchema.safeParse({ data: [], meta: { page: 1, pageSize: 20 } }).success,
    ).toBe(false);
  });
});
