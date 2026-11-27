import { describe, expect, it } from "vitest";

import type { Constraint } from "@agroclimate/contracts";

import {
  ConstraintRuleError,
  evaluateConstraint,
  summariseDimensions,
  thresholdOf,
} from "./constraint.js";

const constraint = (overrides: Partial<Constraint> = {}): Constraint => ({
  id: "0192f0aa-0000-7000-8000-000000000001",
  dimension: "climate",
  comparator: "max",
  thresholdLower: null,
  thresholdUpper: 100,
  thresholdCount: null,
  unit: "mm",
  growthStageId: null,
  grade: "A",
  severity: "hard",
  ...overrides,
});

describe("evaluateConstraint — an absent observation is never a value", () => {
  it("does not let a hard max pass on a missing observation", () => {
    // The classic defect: `observed ?? 0` would satisfy an upper bound of 100 and
    // turn an unmeasured window into a suitable one.
    expect(evaluateConstraint(constraint(), null)).toMatchObject({
      outcome: "insufficient_data",
      observed: null,
    });
  });

  it("still decides the same bound when the observation exists", () => {
    expect(evaluateConstraint(constraint(), 100).outcome).toBe("satisfied");
    expect(evaluateConstraint(constraint(), 100.1).outcome).toBe("violated");
  });

  it("treats a count as a floor, which is what every count in the reference matrix is", () => {
    const count = constraint({ comparator: "count", thresholdUpper: null, thresholdCount: 4 });
    expect(evaluateConstraint(count, 4).outcome).toBe("satisfied");
    expect(evaluateConstraint(count, 3.9).outcome).toBe("violated");
  });
});

describe("evaluateConstraint — evidence rules refuse rather than soften", () => {
  it("refuses a grade C hard gate instead of downgrading it", () => {
    const rule = constraint({ grade: "C" });
    expect(() => evaluateConstraint(rule, 50)).toThrow(ConstraintRuleError);
    try {
      evaluateConstraint(rule, 50);
    } catch (error) {
      expect(error).toBeInstanceOf(ConstraintRuleError);
      expect((error as ConstraintRuleError).reason).toBe("grade_c_hard_gate");
    }
  });

  it("refuses a grade D constraint outright, soft or hard", () => {
    try {
      evaluateConstraint(constraint({ grade: "D", severity: "soft" }), 50);
      expect.unreachable("a grade D constraint may not vote");
    } catch (error) {
      expect((error as ConstraintRuleError).reason).toBe("grade_d_excluded");
    }
  });

  it("separates a malformed threshold from an evidence violation", () => {
    try {
      thresholdOf(constraint({ unit: null }));
      expect.unreachable("a max constraint without a unit cannot be evaluated");
    } catch (error) {
      expect((error as ConstraintRuleError).reason).toBe("malformed_threshold");
    }
  });
});

describe("summariseDimensions — unmeasured and unjudged are different states", () => {
  it("emits all five dimensions in a fixed order", () => {
    expect(summariseDimensions([]).map((summary) => summary.dimension)).toEqual([
      "climate",
      "water",
      "soil",
      "timing",
      "risk",
    ]);
  });

  it("calls a dimension with no rule not_applicable and one with no observation unknown", () => {
    const summaries = summariseDimensions([evaluateConstraint(constraint(), null)]);
    const byDimension = new Map(summaries.map((summary) => [summary.dimension, summary]));

    expect(byDimension.get("climate")).toMatchObject({
      state: "unknown",
      hardGateUnknown: true,
      hardGateFailed: false,
    });
    expect(byDimension.get("soil")).toMatchObject({ state: "not_applicable", evaluations: [] });
  });

  it("does not mark a soft gap as a failed or unmeasured gate", () => {
    const summaries = summariseDimensions([
      evaluateConstraint(constraint({ severity: "soft" }), null),
    ]);
    const climate = summaries.find((summary) => summary.dimension === "climate");

    expect(climate).toMatchObject({ state: "unknown", hardGateUnknown: false, softFailures: 0 });
  });
});
