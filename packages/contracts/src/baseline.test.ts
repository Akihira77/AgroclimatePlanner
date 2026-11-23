import { describe, expect, it } from "vitest";

import { CanonicalizationError } from "./canonical.js";
import { baselineNormalsPayloadSchema, type BaselineNormalsPayload } from "./climate.js";
import { hashBaselineNormals } from "./hash.js";

/**
 * The baseline hash is over the **consumed subset**, not the table. These cases
 * prove the three properties a derivation depends on: order independence,
 * version identity, and a conflict being visible rather than dropped.
 */

const NORMALS = [
  { cellKey: "b", month: "1991-01-01", valueMm: 310.5, sampleYears: 30 },
  { cellKey: "a", month: "1991-01-01", valueMm: 220.25, sampleYears: 30 },
  { cellKey: "a", month: "1991-02-01", valueMm: 180, sampleYears: 29 },
] as const;

function payload(overrides: Partial<BaselineNormalsPayload> = {}): BaselineNormalsPayload {
  return {
    baselineVersion: "ERA5:1991-2020:v1",
    baselineDataset: "era5",
    monthlyNormals: [...NORMALS],
    ...overrides,
  };
}

describe("hashBaselineNormals", () => {
  it("hashes the same subset identically regardless of emission order", () => {
    const forward = payload();
    const reversed = payload({ monthlyNormals: [...NORMALS].reverse() });
    expect(hashBaselineNormals(forward)).toBe(hashBaselineNormals(reversed));
    expect(hashBaselineNormals(forward)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when the baseline version or the value changes", () => {
    const base = hashBaselineNormals(payload());
    expect(hashBaselineNormals(payload({ baselineVersion: "ERA5:1991-2020:v2" }))).not.toBe(base);
    expect(
      hashBaselineNormals(
        payload({
          monthlyNormals: [
            { cellKey: "b", month: "1991-01-01", valueMm: 310.5, sampleYears: 30 },
            { cellKey: "a", month: "1991-01-01", valueMm: 220.26, sampleYears: 30 },
            { cellKey: "a", month: "1991-02-01", valueMm: 180, sampleYears: 29 },
          ],
        }),
      ),
    ).not.toBe(base);
  });

  it("refuses two normals for one (cellKey, month) with conflicting content", () => {
    expect(() =>
      hashBaselineNormals(
        payload({
          monthlyNormals: [
            { cellKey: "a", month: "1991-01-01", valueMm: 220, sampleYears: 30 },
            { cellKey: "a", month: "1991-01-01", valueMm: 221, sampleYears: 30 },
          ],
        }),
      ),
    ).toThrow(CanonicalizationError);
  });
});

describe("baselineNormalsPayloadSchema", () => {
  it("rejects a month that is not the first of a calendar month", () => {
    expect(
      baselineNormalsPayloadSchema.safeParse({
        ...payload(),
        monthlyNormals: [{ cellKey: "a", month: "1991-01-02", valueMm: 1, sampleYears: 30 }],
      }).success,
    ).toBe(false);
  });

  it("rejects a sample-year count outside the 30-year baseline", () => {
    expect(
      baselineNormalsPayloadSchema.safeParse({
        ...payload(),
        monthlyNormals: [{ cellKey: "a", month: "1991-01-01", valueMm: 1, sampleYears: 31 }],
      }).success,
    ).toBe(false);
  });
});
