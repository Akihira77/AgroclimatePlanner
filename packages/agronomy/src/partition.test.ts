import { describe, expect, it } from "vitest";

import type { EvidenceSegment, MissingRange } from "@agroclimate/contracts";

import { validatePartition, type PartitionViolation } from "./partition.js";

const segment = (startDate: string, endDate: string, coveragePercent = 100): EvidenceSegment => ({
  startDate,
  endDate,
  evaluationBasis: "daily",
  evidenceClass: "weather_forecast",
  coveragePercent,
  provenance: {
    kind: "forecast",
    forecastRunIds: ["0192f0aa-0000-7000-8000-000000000001"],
    ingestionRunIds: ["0192f0aa-0000-7000-8000-000000000002"],
    initializedAt: "2026-11-01T00:00:00.000Z",
  },
});

const missing = (startDate: string, endDate: string): MissingRange => ({
  startDate,
  endDate,
  reason: "pending",
});

const codes = (violations: readonly PartitionViolation[]) =>
  violations.map((violation) => violation.code);

const window = {
  windowStart: "2026-11-01",
  windowEnd: "2026-11-10",
};

describe("validatePartition — coverage is a partition, not a list of claims", () => {
  it("accepts segments and declared holes that tile the window exactly", () => {
    expect(
      codes(
        validatePartition({
          ...window,
          segments: [segment("2026-11-01", "2026-11-07")],
          missingRanges: [missing("2026-11-08", "2026-11-10")],
        }),
      ),
    ).toEqual([]);
  });

  it("treats adjacency as legal and a shared day as an overlap", () => {
    expect(
      codes(
        validatePartition({
          ...window,
          segments: [segment("2026-11-01", "2026-11-05"), segment("2026-11-06", "2026-11-10")],
          missingRanges: [],
        }),
      ),
    ).toEqual([]);

    expect(
      codes(
        validatePartition({
          ...window,
          segments: [segment("2026-11-01", "2026-11-05"), segment("2026-11-05", "2026-11-10")],
          missingRanges: [],
        }),
      ),
    ).toContain("overlap");
  });

  it("flags an interval contained by a non-adjacent earlier one", () => {
    const violations = validatePartition({
      ...window,
      segments: [
        segment("2026-11-01", "2026-11-05"),
        segment("2026-11-02", "2026-11-03"),
        segment("2026-11-04", "2026-11-04"),
      ],
      missingRanges: [missing("2026-11-10", "2026-11-10")],
    });

    // Both 02–03 and 04–04 start inside 01–05, but the second one's immediate
    // predecessor ends on 03. Comparing only neighbours reported one of them.
    expect(violations.filter((violation) => violation.code === "overlap")).toHaveLength(2);
  });

  it("measures a gap from the farthest covered day, not from the previous interval", () => {
    const gap = validatePartition({
      ...window,
      segments: [
        segment("2026-11-01", "2026-11-05"),
        segment("2026-11-03", "2026-11-04"),
        segment("2026-11-07", "2026-11-10"),
      ],
      missingRanges: [],
    }).find((violation) => violation.code === "gap");

    // 11-05 is covered by the first segment, so the hole is one day, not three.
    expect(gap).toMatchObject({ startDate: "2026-11-06", endDate: "2026-11-06" });
  });

  it("flags coverage that does not reconcile, in either direction", () => {
    // 70 % of the window with nothing declared missing: the uncovered days would
    // render as evidence, which is the defect this check exists for.
    expect(
      codes(
        validatePartition({
          ...window,
          segments: [segment("2026-11-01", "2026-11-10", 70)],
          missingRanges: [],
        }),
      ),
    ).toEqual(["coverage_mismatch"]);

    // Full coverage of every segment plus declared holes reconciles.
    expect(
      codes(
        validatePartition({
          ...window,
          segments: [segment("2026-11-01", "2026-11-07")],
          missingRanges: [missing("2026-11-08", "2026-11-10")],
        }),
      ),
    ).toEqual([]);
  });

  it("does not reconcile coverage over a partition it already refused", () => {
    // Two defects as one number would name neither.
    const result = codes(
      validatePartition({
        ...window,
        segments: [segment("2026-11-01", "2026-11-09", 50)],
        missingRanges: [],
      }),
    );

    expect(result).toContain("span");
    expect(result).not.toContain("coverage_mismatch");
  });
});

describe("validatePartition — a refusal names what to fix", () => {
  it("refuses an impossible calendar day instead of normalising it", () => {
    expect(
      codes(
        validatePartition({
          windowStart: "2026-02-30",
          windowEnd: "2026-03-05",
          segments: [segment("2026-02-30", "2026-03-05")],
          missingRanges: [],
        }),
      ),
    ).toEqual(["invalid_range", "invalid_range"]);
  });

  it("distinguishes an empty window from one whose every interval was refused", () => {
    const empty = validatePartition({ ...window, segments: [], missingRanges: [] });
    const refused = validatePartition({
      ...window,
      segments: [segment("2026-11-05", "2026-11-01")],
      missingRanges: [],
    });

    expect(empty[0]?.detail).toBe("the window has no segments and no missing ranges");
    // The operator must not be told there was no data when there was malformed data.
    expect(refused.map((violation) => violation.code)).toEqual(["invalid_range", "span"]);
    expect(refused[1]?.detail).toContain("1 refused");
  });

  it("refuses a segment that reports evidence it does not have", () => {
    expect(
      codes(
        validatePartition({
          ...window,
          segments: [segment("2026-11-01", "2026-11-10", 0)],
          missingRanges: [],
        }),
      ),
    ).toContain("no_evidence_segment");
  });
});
