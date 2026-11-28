import { describe, expect, it } from "vitest";

import {
  fieldObservationCreateSchema,
  harvestCreateSchema,
  plantingCreateSchema,
  plantingStatusSchema,
  plantingUpdateSchema,
} from "../src/activity.js";

const uuidA = "0192f0aa-0000-7000-8000-000000000001";
const uuidB = "0192f0aa-0000-7000-8000-000000000002";

describe("planting contracts", () => {
  it("accepts a valid planting creation payload", () => {
    const parsed = plantingCreateSchema.safeParse({
      fieldId: uuidA,
      cultivarId: uuidB,
      plantedAt: "2026-11-28",
      cycleStartUsed: "transplant",
      areaPlantedHa: 1.25,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects non-positive area, impossible date, and unknown keys", () => {
    expect(
      plantingCreateSchema.safeParse({
        fieldId: uuidA,
        cultivarId: uuidB,
        plantedAt: "2026-02-30",
        cycleStartUsed: "sowing",
        areaPlantedHa: 1,
      }).success,
    ).toBe(false);

    expect(
      plantingCreateSchema.safeParse({
        fieldId: uuidA,
        cultivarId: uuidB,
        plantedAt: "2026-11-28",
        cycleStartUsed: "sowing",
        areaPlantedHa: 0,
      }).success,
    ).toBe(false);

    expect(
      plantingCreateSchema.safeParse({
        fieldId: uuidA,
        cultivarId: uuidB,
        plantedAt: "2026-11-28",
        cycleStartUsed: "sowing",
        areaPlantedHa: 1,
        status: "active",
      }).success,
    ).toBe(false);
  });

  it("accepts all four OPEN-09 planting statuses and rejects 'planned'", () => {
    for (const status of ["active", "harvested", "failed", "abandoned"] as const) {
      expect(plantingStatusSchema.safeParse(status).success).toBe(true);
      expect(plantingUpdateSchema.safeParse({ status }).success).toBe(true);
    }
    expect(plantingStatusSchema.safeParse("planned").success).toBe(false);
  });
});

describe("harvest contracts", () => {
  it("accepts zero yieldKg (failed picking) and optional notes", () => {
    expect(
      harvestCreateSchema.safeParse({
        harvestedAt: "2026-11-28",
        yieldKg: 0,
        notes: null,
      }).success,
    ).toBe(true);
  });

  it("rejects negative yieldKg and unknown keys", () => {
    expect(
      harvestCreateSchema.safeParse({
        harvestedAt: "2026-11-28",
        yieldKg: -0.1,
      }).success,
    ).toBe(false);

    expect(
      harvestCreateSchema.safeParse({
        harvestedAt: "2026-11-28",
        yieldKg: 10,
        plantingId: uuidA,
      }).success,
    ).toBe(false);
  });
});

describe("field observation contracts", () => {
  it("accepts measurement observations with value and unit", () => {
    expect(
      fieldObservationCreateSchema.safeParse({
        kind: "rainfall",
        value: 14.5,
        unit: "mm",
        observedAt: "2026-11-28T06:00:00Z",
        method: "rain gauge",
      }).success,
    ).toBe(true);
  });

  it("accepts note observations without value or unit, and rejects note with value/unit", () => {
    expect(
      fieldObservationCreateSchema.safeParse({
        kind: "note",
        observedAt: "2026-11-28T06:00:00Z",
        method: "visual check",
      }).success,
    ).toBe(true);

    expect(
      fieldObservationCreateSchema.safeParse({
        kind: "note",
        value: 5,
        observedAt: "2026-11-28T06:00:00Z",
      }).success,
    ).toBe(false);

    expect(
      fieldObservationCreateSchema.safeParse({
        kind: "note",
        unit: "mm",
        observedAt: "2026-11-28T06:00:00Z",
      }).success,
    ).toBe(false);
  });

  it("rejects measurement observations missing value or unit", () => {
    expect(
      fieldObservationCreateSchema.safeParse({
        kind: "soil_moisture",
        unit: "%",
        observedAt: "2026-11-28T06:00:00Z",
      }).success,
    ).toBe(false);

    expect(
      fieldObservationCreateSchema.safeParse({
        kind: "temperature",
        value: 29.2,
        observedAt: "2026-11-28T06:00:00Z",
      }).success,
    ).toBe(false);
  });
});
