import type {
  Constraint,
  ConstraintDimension,
  ConstraintSeverity,
  EvidenceGrade,
} from "@agroclimate/contracts";

/**
 * Deterministic constraint evaluation — Phase 6.2.
 *
 * Pure: no I/O, no clock, no locale, no random. The same constraint and the same
 * observation always produce the same result, which is the property the engine's
 * reproducibility claim rests on.
 *
 * Two rules from `docs/research/agronomic-reference-matrix.md` §6 are enforced here
 * rather than assumed, and neither is softened into a warning:
 *
 * - **grade C is never a hard gate.** A `hard` constraint backed by grade C cannot
 *   exclude anything, so the row contradicts its own evidence. Downgrading it to
 *   `soft` silently would turn a data defect into a recommendation, so it throws.
 * - **grade D is excluded.** A secondary or unverifiable source may not vote at
 *   all. A stored grade-D constraint is refused the same way.
 *
 * `OPEN-26` does not apply here: nothing in this module writes a window.
 */

/** A rulebook row the engine refuses to evaluate, with the reason a caller can log. */
export class ConstraintRuleError extends Error {
  readonly constraintId: string;
  readonly reason: "grade_c_hard_gate" | "grade_d_excluded" | "malformed_threshold";

  constructor(constraintId: string, reason: ConstraintRuleError["reason"], message: string) {
    super(message);
    this.name = "ConstraintRuleError";
    this.constraintId = constraintId;
    this.reason = reason;
  }
}

/**
 * The comparison the rulebook states, restated as a value so an explanation can
 * quote it without re-reading the row. `count` is a floor: every count in the
 * reference matrix is a minimum ("≥4 wet months"), and the DDL has no way to
 * express a ceiling count.
 */
export type ConstraintThreshold =
  | { readonly kind: "min"; readonly lower: number; readonly unit: string }
  | { readonly kind: "max"; readonly upper: number; readonly unit: string }
  | {
      readonly kind: "range";
      readonly lower: number;
      readonly upper: number;
      readonly unit: string;
    }
  | { readonly kind: "count"; readonly count: number };

export type ConstraintOutcome = "satisfied" | "violated" | "insufficient_data";

export interface ConstraintEvaluation {
  readonly constraintId: string;
  readonly dimension: ConstraintDimension;
  readonly severity: ConstraintSeverity;
  readonly grade: EvidenceGrade;
  readonly outcome: ConstraintOutcome;
  /** `null` only when nothing was observed — never a substitute value. */
  readonly observed: number | null;
  readonly threshold: ConstraintThreshold;
}

/** Read the threshold out of a validated row without re-deriving its meaning. */
export function thresholdOf(constraint: Constraint): ConstraintThreshold {
  switch (constraint.comparator) {
    case "min":
      if (constraint.thresholdLower === null || constraint.unit === null) {
        throw new ConstraintRuleError(
          constraint.id,
          "malformed_threshold",
          "a min constraint without its lower bound and unit cannot be evaluated",
        );
      }
      return {
        kind: "min",
        lower: finiteBound(constraint.thresholdLower, constraint.id, "thresholdLower"),
        unit: constraint.unit,
      };
    case "max":
      if (constraint.thresholdUpper === null || constraint.unit === null) {
        throw new ConstraintRuleError(
          constraint.id,
          "malformed_threshold",
          "a max constraint without its upper bound and unit cannot be evaluated",
        );
      }
      return {
        kind: "max",
        upper: finiteBound(constraint.thresholdUpper, constraint.id, "thresholdUpper"),
        unit: constraint.unit,
      };
    case "range":
      if (
        constraint.thresholdLower === null ||
        constraint.thresholdUpper === null ||
        constraint.unit === null
      ) {
        throw new ConstraintRuleError(
          constraint.id,
          "malformed_threshold",
          "a range constraint without both bounds and a unit cannot be evaluated",
        );
      }
      return {
        kind: "range",
        lower: finiteBound(constraint.thresholdLower, constraint.id, "thresholdLower"),
        upper: finiteBound(constraint.thresholdUpper, constraint.id, "thresholdUpper"),
        unit: constraint.unit,
      };
    case "count":
      if (constraint.thresholdCount === null) {
        throw new ConstraintRuleError(
          constraint.id,
          "malformed_threshold",
          "a count constraint without its count cannot be evaluated",
        );
      }
      return {
        kind: "count",
        count: finiteBound(constraint.thresholdCount, constraint.id, "thresholdCount"),
      };
  }
}

/**
 * A non-finite bound is not a bound: `observed >= NaN` is false, so a hard gate
 * would exclude every field without ever being evaluated, and `<= Infinity` would
 * accept every one. The boundary schema already refuses these; the engine does not
 * rely on it, for the same reason it refuses a null observation rather than
 * trusting the caller.
 */
function finiteBound(value: number, constraintId: string, field: string): number {
  if (!Number.isFinite(value)) {
    throw new ConstraintRuleError(
      constraintId,
      "malformed_threshold",
      `${field} is not a finite number`,
    );
  }
  return value;
}

/**
 * One constraint against one observation.
 *
 * `observed: null` means the dimension was not measured. It is not zero, not an
 * average, and not "no violation": the outcome is `insufficient_data`, which the
 * caller must propagate as coverage rather than as a pass. A non-finite number is
 * the same case — `NaN` compares false against every bound (a fabricated
 * exclusion) and `Infinity` satisfies any one-sided bound (a fabricated pass), so
 * it is recorded as `observed: null` rather than allowed to vote.
 */
export function evaluateConstraint(
  constraint: Constraint,
  observed: number | null,
): ConstraintEvaluation {
  assertEvaluable(constraint);

  const threshold = thresholdOf(constraint);
  const usable = observed !== null && Number.isFinite(observed) ? observed : null;
  const base = {
    constraintId: constraint.id,
    dimension: constraint.dimension,
    severity: constraint.severity,
    grade: constraint.grade,
    observed: usable,
    threshold,
  } as const;

  if (usable === null) return { ...base, outcome: "insufficient_data" };

  return { ...base, outcome: satisfies(threshold, usable) ? "satisfied" : "violated" };
}

function satisfies(threshold: ConstraintThreshold, observed: number): boolean {
  switch (threshold.kind) {
    case "min":
      return observed >= threshold.lower;
    case "max":
      return observed <= threshold.upper;
    case "range":
      return observed >= threshold.lower && observed <= threshold.upper;
    case "count":
      return observed >= threshold.count;
  }
}

function assertEvaluable(constraint: Constraint): void {
  if (constraint.grade === "D") {
    throw new ConstraintRuleError(
      constraint.id,
      "grade_d_excluded",
      "a grade D constraint may not vote: the source is secondary or unverifiable",
    );
  }
  if (constraint.grade === "C" && constraint.severity === "hard") {
    throw new ConstraintRuleError(
      constraint.id,
      "grade_c_hard_gate",
      "a grade C constraint may contribute a caveat, never exclude a window",
    );
  }
}

/**
 * Per-dimension coverage (`tables-derived.md` §1).
 *
 * `not_applicable` is the rulebook's own statement that it does not judge the
 * dimension. `unknown` is different: the rulebook judges it and the observation is
 * missing. Collapsing the two would make an unmeasured field look unconstrained.
 */
export interface DimensionSummary {
  readonly dimension: ConstraintDimension;
  readonly state: "known" | "unknown" | "not_applicable";
  /** A hard constraint was observed and failed. The window is not suitable. */
  readonly hardGateFailed: boolean;
  /** A hard constraint exists and has no observation. The window is not evaluable. */
  readonly hardGateUnknown: boolean;
  readonly softFailures: number;
  readonly evaluations: readonly ConstraintEvaluation[];
}

export const DIMENSIONS: readonly ConstraintDimension[] = [
  "climate",
  "water",
  "soil",
  "timing",
  "risk",
];

/** One summary per dimension, in a fixed order, including dimensions with no rule. */
export function summariseDimensions(
  evaluations: readonly ConstraintEvaluation[],
): readonly DimensionSummary[] {
  return DIMENSIONS.map((dimension) => {
    const own = evaluations.filter((evaluation) => evaluation.dimension === dimension);

    if (own.length === 0) {
      return {
        dimension,
        state: "not_applicable",
        hardGateFailed: false,
        hardGateUnknown: false,
        softFailures: 0,
        evaluations: own,
      };
    }

    const unknown = own.some((evaluation) => evaluation.outcome === "insufficient_data");
    const hardGateUnknown = own.some(
      (evaluation) => evaluation.severity === "hard" && evaluation.outcome === "insufficient_data",
    );
    const hardGateFailed = own.some(
      (evaluation) => evaluation.severity === "hard" && evaluation.outcome === "violated",
    );
    const softFailures = own.filter(
      (evaluation) => evaluation.severity === "soft" && evaluation.outcome === "violated",
    ).length;

    return {
      dimension,
      state: unknown ? "unknown" : "known",
      hardGateFailed,
      hardGateUnknown,
      softFailures,
      evaluations: own,
    };
  });
}
