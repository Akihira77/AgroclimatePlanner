import { describe, expect, it } from "vitest";
import {
  CanonicalOrderError,
  firstRefId,
  orderObjectArray,
  orderStringArray,
  objectArrayRules,
} from "../src/canonical.js";

const cellA = {
  provider: "open-meteo",
  model: "ecmwf_ifs025",
  cellKey: "cell-a",
  servedLat: -6.32,
  servedLon: 106.68,
  distanceKm: 1.2,
};
const cellB = {
  provider: "ecmwf",
  model: "ecmwf_seas5",
  cellKey: "cell-b",
  servedLat: -6.22,
  servedLon: 106.78,
  distanceKm: 2.9,
};

describe("canonical array ordering", () => {
  it("is independent of the input permutation", () => {
    const forward = orderObjectArray("resolvedCells", [cellA, cellB]);
    const backward = orderObjectArray("resolvedCells", [cellB, cellA]);
    expect(forward).toEqual(backward);
    expect(forward.map((cell) => cell.cellKey)).toEqual(["cell-b", "cell-a"]);
  });

  it("drops a duplicate that agrees with its predecessor", () => {
    const ordered = orderObjectArray("resolvedCells", [cellA, { ...cellA }, cellB]);
    expect(ordered).toHaveLength(2);
  });

  it("refuses a duplicate identity with conflicting content", () => {
    expect(() => orderObjectArray("resolvedCells", [cellA, { ...cellA, distanceKm: 9.9 }])).toThrow(
      CanonicalOrderError,
    );
  });

  it("rejects an entry with no identity key", () => {
    expect(() =>
      orderObjectArray("resolvedCells", [{ provider: "open-meteo", cellKey: "x" }]),
    ).toThrow(CanonicalOrderError);
  });

  it("does not deduplicate inputRefs — two roles for two cells are both real", () => {
    const ref = {
      kind: "forecast",
      role: "seasonal",
      purpose: "input",
      forecastRunIds: ["run-1"],
      ingestionRunIds: ["ingest-1"],
      recordSetHash: "a".repeat(64),
    };
    const other = { ...ref, forecastRunIds: ["run-2"], ingestionRunIds: ["ingest-2"] };
    expect(orderObjectArray("inputRefs", [ref, other])).toHaveLength(2);
    expect(objectArrayRules.inputRefs.dedupe).toBe(false);
  });

  it("orders inputRefs by first id when kind/role/purpose tie", () => {
    const ref = {
      kind: "forecast",
      role: "seasonal",
      purpose: "input",
      forecastRunIds: ["run-b"],
      ingestionRunIds: ["ingest-b"],
      recordSetHash: "a".repeat(64),
    };
    const earlier = { ...ref, forecastRunIds: ["run-a"], ingestionRunIds: ["ingest-a"] };
    expect(
      orderObjectArray("inputRefs", [ref, earlier]).map((entry) => entry.forecastRunIds),
    ).toEqual([["run-a"], ["run-b"]]);
  });

  it("derives the first id from the canonicalised array, not from element zero", () => {
    expect(firstRefId({ forecastRunIds: ["run-b", "run-a"] })).toBe("run-a");
    expect(firstRefId({ cellKeys: ["cell-z", "cell-a"] })).toBe("cell-a");

    const unsorted = {
      kind: "forecast",
      role: "seasonal",
      purpose: "input",
      forecastRunIds: ["run-b", "run-a"],
      ingestionRunIds: ["ingest-1"],
      recordSetHash: "a".repeat(64),
    };
    const sorted = { ...unsorted, forecastRunIds: ["run-a", "run-b"] };
    const earlier = {
      ...unsorted,
      forecastRunIds: ["run-0"],
      recordSetHash: "b".repeat(64),
    };

    const fromUnsorted = orderObjectArray("inputRefs", [unsorted, earlier]).map(firstRefId);
    const fromSorted = orderObjectArray("inputRefs", [sorted, earlier]).map(firstRefId);
    expect(fromUnsorted).toEqual(["run-0", "run-a"]);
    expect(fromUnsorted).toEqual(fromSorted);
  });

  it("keeps adjacent missing ranges, ordered by date", () => {
    const ranges = [
      { startDate: "2027-02-01", endDate: "2027-02-28", reason: "pending" },
      { startDate: "2027-01-01", endDate: "2027-01-31", reason: "pending" },
    ];
    expect(orderObjectArray("missingRanges", ranges).map((r) => r.startDate)).toEqual([
      "2027-01-01",
      "2027-02-01",
    ]);
  });

  it("sorts and deduplicates hash arrays lexicographically", () => {
    expect(orderStringArray("sourceArtifactHashes", ["c", "a", "c", "b"])).toEqual(["a", "b", "c"]);
  });
});
