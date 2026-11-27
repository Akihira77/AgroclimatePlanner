import { ConstraintRuleError } from "./constraint.js";
import { SuitabilityInputError, assessSuitability } from "./suitability.js";
import type { SuitabilityInput } from "./suitability.js";
import { describe, expect, it } from "vitest";

import type { Constraint } from "@agroclimate/contracts";

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const rule = (overrides: Partial<Constraint> & Pick<Constraint, "id">): Constraint => ({
  dimension: "water",
  comparator: "min",
  thresholdLower: 100,
  thresholdUpper: null,
  thresholdCount: null,
  unit: "mm",
  growthStageId: null,
  grade: "A",
  severity: "hard",
  ...overrides,
});

const waterHard = rule({ id: id(1) });
const soilSoft = rule({
  id: id(2),
  dimension: "soil",
  thresholdLower: 40,
  grade: "B",
  severity: "soft",
});

const observations = (
  entries: readonly (readonly [string, number | null])[],
): Map<string, number | null> => new Map(entries);

const assess = (input: Partial<SuitabilityInput> & Pick<SuitabilityInput, "constraints">) =>
  assessSuitability({ observations: observations([]), primaryBasis: "daily", ...input });

const dimensions = (assessment: ReturnType<typeof assessSuitability>) =>
  assessment.dimensionCoverage.map((entry) => `${entry.dimension}:${entry.state}`);

const inputErrorCode = (run: () => unknown): string | undefined => {
  try {
    run();
  } catch (error) {
    return error instanceof SuitabilityInputError
      ? error.code
      : `not an input error: ${String(error)}`;
  }
  return undefined;
};

describe("assessSuitability — one profile, one observation each, one verdict", () => {
  it("calls a fully satisfied, grade-A-gated window suitable", () => {
    const result = assess({
      constraints: [waterHard],
      observations: observations([[waterHard.id, 140]]),
    });

    expect(result.verdict).toBe("suitable");
    expect(result.maxAchievableLevel).toBe("A");
    expect(result.reasons).toEqual([]);
    expect(dimensions(result)).toEqual([
      "climate:not_applicable",
      "water:known",
      "soil:not_applicable",
      "timing:not_applicable",
      "risk:not_applicable",
    ]);
    expect(result.evaluations[0]?.observed).toBe(140);
  });

  it("lets a violated hard gate outrank a satisfied soft rule", () => {
    const result = assess({
      constraints: [waterHard, soilSoft],
      observations: observations([
        [waterHard.id, 10],
        [soilSoft.id, 90],
      ]),
    });

    expect(result.verdict).toBe("unsuitable");
    expect(result.reasons.map((reason) => reason.code)).toEqual(["hard_gate_failed"]);
  });

  it("refuses to decide when a hard gate was never observed", () => {
    const result = assess({ constraints: [waterHard] });

    expect(result.verdict).toBe("insufficient_data");
    expect(result.reasons.map((reason) => reason.code)).toEqual(["hard_gate_unknown"]);
    expect(result.maxAchievableLevel).toBeNull();
    expect(dimensions(result)[1]).toBe("water:unknown");
  });

  it("caps a satisfied window at conditional when a soft rule fails, and reports the grade behind it", () => {
    const result = assess({
      constraints: [waterHard, soilSoft],
      observations: observations([
        [waterHard.id, 140],
        [soilSoft.id, 10],
      ]),
      primaryBasis: "weekly",
    });

    expect(result.verdict).toBe("conditional");
    expect(result.maxAchievableLevel).toBe("B");
    expect(result.reasons.map((reason) => reason.code)).toEqual(["soft_failure"]);
  });

  it("refuses a suitable verdict on a climatological critical stage", () => {
    const result = assess({
      constraints: [waterHard],
      observations: observations([[waterHard.id, 140]]),
      primaryBasis: "climatology",
    });

    expect(result.verdict).toBe("conditional");
    expect(result.reasons.map((reason) => reason.code)).toEqual(["critical_stage_climatology"]);
  });

  it("treats a judged dimension with no observation as conditional, with no evidence level", () => {
    const result = assess({ constraints: [soilSoft] });

    expect(result.verdict).toBe("conditional");
    expect(result.maxAchievableLevel).toBeNull();
    expect(result.reasons.map((reason) => reason.code)).toEqual(["dimension_unknown"]);
  });

  it("does not let a recorded risk gate or cap the verdict", () => {
    // `risk` is a third severity: it is recorded, never an exclusion. Treating it
    // as a gate would turn a caveat into `unsuitable`.
    const frostRisk = rule({
      id: id(3),
      dimension: "risk",
      comparator: "max",
      thresholdLower: null,
      thresholdUpper: 5,
      grade: "A",
      severity: "risk",
    });

    const result = assess({
      constraints: [waterHard, frostRisk],
      observations: observations([
        [waterHard.id, 140],
        [frostRisk.id, 30],
      ]),
    });

    expect(result.verdict).toBe("suitable");
    expect(dimensions(result)).toContain("risk:known");
  });

  it("does not turn an unobserved risk rule into a missing gate", () => {
    const frostRisk = rule({
      id: id(4),
      dimension: "risk",
      comparator: "max",
      thresholdLower: null,
      thresholdUpper: 5,
      severity: "risk",
    });

    const result = assess({
      constraints: [waterHard, frostRisk],
      observations: observations([[waterHard.id, 140]]),
    });

    // A caveat nobody measured is a caveat, not an exclusion and not a refusal.
    expect(result.verdict).toBe("conditional");
    expect(result.reasons.map((reason) => reason.code)).toEqual(["dimension_unknown"]);
    expect(result.maxAchievableLevel).toBe("A");
    expect(dimensions(result)).toContain("risk:unknown");
  });

  it("orders coverage by the contract's dimensions, not by the rulebook's order", () => {
    const climateRule = rule({ id: id(5), dimension: "climate", thresholdLower: 20 });

    const result = assess({
      constraints: [soilSoft, climateRule],
      observations: observations([
        [soilSoft.id, 90],
        [climateRule.id, 25],
      ]),
    });

    expect(result.dimensionCoverage.map((entry) => entry.dimension)).toEqual([
      "climate",
      "water",
      "soil",
      "timing",
      "risk",
    ]);
    expect(dimensions(result)).toEqual([
      "climate:known",
      "water:not_applicable",
      "soil:known",
      "timing:not_applicable",
      "risk:not_applicable",
    ]);
  });

  it("reports the weakest grade among the fully observed dimensions", () => {
    // The grade-B gate is unobserved, so water is unknown and contributes no level;
    // the grade-A climate rule was observed.
    const gradeBHard = rule({ id: id(6), grade: "B" });
    const gradeASoft = rule({ id: id(7), dimension: "climate", grade: "A", severity: "soft" });

    const result = assess({
      constraints: [gradeBHard, gradeASoft],
      observations: observations([[gradeASoft.id, 25]]),
    });

    expect(result.verdict).toBe("insufficient_data");
    expect(result.maxAchievableLevel).toBe("A");
  });

  it("reports no level when the only judged dimension is only partly observed", () => {
    // The column means "no dimension is known", not "no rule was observed": a
    // half-measured dimension cannot lend its grade to a run that does not have it.
    const secondSoilRule = rule({
      id: id(8),
      dimension: "soil",
      thresholdLower: 60,
      grade: "A",
      severity: "soft",
    });

    const result = assess({
      constraints: [soilSoft, secondSoilRule],
      observations: observations([[soilSoft.id, 90]]),
    });

    expect(result.verdict).toBe("conditional");
    expect(result.maxAchievableLevel).toBeNull();
    expect(dimensions(result)).toContain("soil:unknown");
  });

  it("counts a violated rule's grade as evidence quality", () => {
    const gradeCSoft = rule({ id: id(9), grade: "C", severity: "soft" });

    const result = assess({
      constraints: [gradeCSoft],
      observations: observations([[gradeCSoft.id, 10]]),
    });

    expect(result.verdict).toBe("conditional");
    expect(result.maxAchievableLevel).toBe("C");
  });

  it("reads a missing key and an explicit null as the same unmeasured answer", () => {
    const withNull = assess({
      constraints: [soilSoft],
      observations: observations([[soilSoft.id, null]]),
    });
    const withNothing = assess({ constraints: [soilSoft] });

    expect(withNull).toEqual(withNothing);
    expect(withNothing.maxAchievableLevel).toBeNull();
  });

  it("refuses an observation that belongs to no constraint in the profile", () => {
    expect(
      inputErrorCode(() =>
        assess({ constraints: [waterHard], observations: observations([[id(99), 1]]) }),
      ),
    ).toBe("unknown_observation_id");
  });

  it("refuses a duplicated constraint id instead of double-counting it", () => {
    expect(
      inputErrorCode(() =>
        assess({
          constraints: [waterHard, waterHard],
          observations: observations([[waterHard.id, 140]]),
        }),
      ),
    ).toBe("duplicate_constraint_id");
  });

  it("refuses an empty rulebook rather than calling every dimension suitable", () => {
    expect(inputErrorCode(() => assess({ constraints: [] }))).toBe("empty_rulebook");
  });

  it("fails loudly when a grade has no rank, instead of publishing it as the strongest", () => {
    const unranked = { ...rule({ id: id(10) }), grade: "E" } as unknown as Constraint;

    expect(() =>
      assess({ constraints: [unranked], observations: observations([[unranked.id, 140]]) }),
    ).toThrow(/no rank/);
  });

  it("still refuses a grade C hard gate instead of silently gating on it", () => {
    expect(() =>
      assess({
        constraints: [rule({ id: id(11), grade: "C" })],
        observations: observations([[id(11), 140]]),
      }),
    ).toThrow(ConstraintRuleError);
  });
});
