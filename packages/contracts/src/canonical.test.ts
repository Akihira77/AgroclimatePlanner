import { describe, expect, it } from "vitest";
import { CanonicalizationError, canonicalJson } from "../src/canonical.js";

const cell = (provider: string, cellKey: string) => ({
  provider,
  model: "ecmwf_ifs025",
  cellKey,
  servedLat: -6.32,
  servedLon: 106.68,
  distanceKm: 1.2,
});

describe("object keys", () => {
  it("sorts keys lexicographically at every depth", () => {
    expect(canonicalJson({ z: 1, a: { beta: true, alpha: null }, m: "text" })).toBe(
      '{"a":{"alpha":null,"beta":true},"m":"text","z":1}',
    );
  });

  it("is independent of insertion order", () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe(canonicalJson({ a: 1, b: 2 }));
  });

  it("emits no whitespace", () => {
    expect(canonicalJson({ a: 1, b: { c: 2 } })).toBe('{"a":1,"b":{"c":2}}');
  });
});

describe("array rules", () => {
  it("orders a set-like array and keeps its elements' keys sorted", () => {
    expect(canonicalJson({ resolvedCells: [cell("b", "k2"), cell("a", "k1")] })).toBe(
      '{"resolvedCells":[{"cellKey":"k1","distanceKm":1.2,"model":"ecmwf_ifs025","provider":"a","servedLat":-6.32,"servedLon":106.68},{"cellKey":"k2","distanceKm":1.2,"model":"ecmwf_ifs025","provider":"b","servedLat":-6.32,"servedLon":106.68}]}',
    );
  });

  it("is independent of the input permutation", () => {
    const forward = canonicalJson({ resolvedCells: [cell("a", "k1"), cell("b", "k2")] });
    const backward = canonicalJson({ resolvedCells: [cell("b", "k2"), cell("a", "k1")] });
    expect(forward).toBe(backward);
  });

  it("preserves the order of a declared sequence", () => {
    const segment = (startDate: string) => ({ startDate, endDate: "2027-01-31" });
    expect(
      canonicalJson({
        evidenceSegments: [segment("2027-02-01"), segment("2027-01-01")],
      }),
    ).toBe(
      '{"evidenceSegments":[{"endDate":"2027-01-31","startDate":"2027-02-01"},{"endDate":"2027-01-31","startDate":"2027-01-01"}]}',
    );
  });

  it("refuses an array with no declared rule", () => {
    expect(() => canonicalJson({ somethingNew: [1, 2] })).toThrow(CanonicalizationError);
  });

  it("collapses byte-identical duplicates where deduplication is permitted", () => {
    expect(canonicalJson({ sourceArtifactHashes: ["h2", "h1", "h2"] })).toBe(
      '{"sourceArtifactHashes":["h1","h2"]}',
    );
  });

  it("keeps every entry where deduplication is forbidden", () => {
    const range = { startDate: "2027-01-01", endDate: "2027-01-31", reason: "pending" };
    expect(canonicalJson({ missingRanges: [range, { ...range }] })).toBe(
      '{"missingRanges":[{"endDate":"2027-01-31","reason":"pending","startDate":"2027-01-01"},{"endDate":"2027-01-31","reason":"pending","startDate":"2027-01-01"}]}',
    );
  });

  it("throws on a duplicate identity with conflicting content", () => {
    expect(() =>
      canonicalJson({
        resolvedCells: [cell("a", "k1"), { ...cell("a", "k1"), distanceKm: 9.9 }],
      }),
    ).toThrow(/conflicting content/);
  });
});

describe("numbers", () => {
  it("serialises negative zero as zero", () => {
    expect(canonicalJson({ n: -0 })).toBe('{"n":0}');
  });

  it.each([
    [1, "1"],
    [-1, "-1"],
    [0, "0"],
    [1.5, "1.5"],
    [0.1, "0.1"],
    [1e21, "1e+21"],
    [1e-7, "1e-7"],
    [Number.MAX_SAFE_INTEGER, "9007199254740991"],
  ])("serialises %s as %s", (value, expected) => {
    expect(canonicalJson({ n: value })).toBe(`{"n":${expected}}`);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects the non-finite number %s",
    (value) => {
      expect(() => canonicalJson({ n: value })).toThrow(CanonicalizationError);
    },
  );
});

describe("unsupported values", () => {
  it("rejects an undefined property instead of dropping it", () => {
    expect(() => canonicalJson({ a: undefined })).toThrow(/omit the key/);
  });

  it("rejects undefined inside an array", () => {
    expect(() => canonicalJson({ sourceArtifactHashes: ["a", undefined] })).toThrow(
      CanonicalizationError,
    );
  });

  it("rejects a function", () => {
    expect(() => canonicalJson({ fn: () => 1 })).toThrow(CanonicalizationError);
  });

  it("rejects a circular reference", () => {
    const node: Record<string, unknown> = { a: 1 };
    node["self"] = node;
    expect(() => canonicalJson(node)).toThrow(/circular/);
  });

  it("rejects an array at the root, where no field name names its rule", () => {
    expect(() => canonicalJson([1, 2])).toThrow(/without a field name/);
  });
});

describe("scalars", () => {
  it("preserves null", () => {
    expect(canonicalJson({ a: null })).toBe('{"a":null}');
  });

  it("escapes strings without ascii-folding them", () => {
    expect(canonicalJson({ a: 'quote " backslash \\ newline \n unicode ✓' })).toBe(
      '{"a":"quote \\" backslash \\\\ newline \\n unicode ✓"}',
    );
  });

  it("keeps a timestamp string exactly as given", () => {
    expect(canonicalJson({ t: "2026-11-18T00:00:00Z" })).toBe('{"t":"2026-11-18T00:00:00Z"}');
  });
});
