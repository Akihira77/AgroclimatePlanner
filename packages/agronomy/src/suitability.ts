import type {
  Constraint,
  DimensionCoverageEntry,
  EvidenceGrade,
  SingleValueEvaluationBasis,
} from "@agroclimate/contracts";

import { DIMENSIONS, evaluateConstraint, summariseDimensions } from "./constraint.js";
import type { ConstraintEvaluation, DimensionSummary } from "./constraint.js";
import { classifyVerdict } from "./verdict.js";
import type { VerdictReason } from "./verdict.js";

/**
 * Suitability assembly — Phase 6.4, the step between "one rule, one observation"
 * and "one verdict a row can store".
 *
 * Pure, like everything below it: no clock, no I/O, no locale. The caller supplies
 * the observations, keyed by `constraint.id`.
 *
 * **Why the caller supplies them.** Nothing in the schema says which series or
 * aggregate answers which rule: `constraints` carries a dimension, a comparator, a
 * bound and a unit, but no metric name. Deciding that "water" means `total_mm` over
 * the critical stage is an agronomic mapping with a citation, not an inference an
 * engine may make from a unit string. So the mapping lives in the rulebook that
 * `OPEN-20` seeds, and this module refuses to guess: a constraint with no
 * observation is `insufficient_data`, never a default.
 *
 * `OPEN-26` does not apply here: an assessment is not a window, and nothing in this
 * module persists one.
 */

/** A caller defect, with a code a service can branch on instead of parsing a message. */
export class SuitabilityInputError extends RangeError {
  readonly code: "empty_rulebook" | "duplicate_constraint_id" | "unknown_observation_id";

  constructor(code: SuitabilityInputError["code"], message: string) {
    super(message);
    this.name = "SuitabilityInputError";
    this.code = code;
  }
}

export interface SuitabilityInput {
  /** One profile version's rules. Duplicate ids are refused, not merged. */
  readonly constraints: readonly Constraint[];
  /**
   * Observed value per `constraint.id`. A missing key and an explicit `null` mean
   * the same thing — not measured — because both are cases where nobody knows.
   *
   * Unit agreement is the caller's contract: the engine compares a number to the
   * rule's bound and cannot tell 140 mm from 140 °C.
   */
  readonly observations: ReadonlyMap<string, number | null>;
  /** The basis over the critical stage alone; never `mixed` (`D25`). */
  readonly primaryBasis: SingleValueEvaluationBasis;
  /** True when the critical stage is missing weather coverage or overlaps missingRanges. */
  readonly criticalStageUncovered?: boolean;
  /** True when a short-range daily forecast claims to cover a critical stage >16 days out. */
  readonly criticalStageBeyondDailyHorizon?: boolean;
  /** True when climate thresholds were evaluated only from a single point-in-time observation. */
  readonly singlePointClimateProxy?: boolean;
}

/** Exactly the fields a `suitability_runs` row keeps from the evaluation. */
export interface SuitabilityAssessment {
  readonly verdict: "suitable" | "conditional" | "unsuitable" | "insufficient_data";
  /** Empty only for `suitable`; otherwise at least one reason, for the explanation. */
  readonly reasons: readonly VerdictReason[];
  /** One entry per dimension, in fixed order, including dimensions with no rule. */
  readonly dimensionCoverage: readonly DimensionCoverageEntry[];
  /**
   * The weakest evidence grade in a **fully observed** dimension, or `null` when no
   * dimension is `known`. That is the reading `tables-derived.md` §1 gives the
   * column: an unknown dimension contributes no level, because its grade would
   * describe evidence the run does not have. A caveat raised by a partly unknown
   * dimension is therefore not reflected here — `reasons` carries it.
   */
  readonly maxAchievableLevel: EvidenceGrade | null;
  /** Every evaluation, so a caller can render each threshold with its outcome. */
  readonly evaluations: readonly ConstraintEvaluation[];
}

export function assessSuitability(input: SuitabilityInput): SuitabilityAssessment {
  // A profile with no rules would classify `suitable`: nothing gates, nothing
  // judges, so every branch passes. That is the false pass `audit.ts` refuses for
  // an empty expectation — an unseeded profile is not a clean one. The catalogue
  // cannot publish an empty version (`OPEN-20`), so this is a caller defect.
  if (input.constraints.length === 0) {
    throw new SuitabilityInputError(
      "empty_rulebook",
      "a profile with no constraints cannot be assessed",
    );
  }
  // Input defects are reported before rule defects: a profile that cannot describe
  // its own observations is the earlier mistake to fix.
  assertUniqueIds(input.constraints);
  assertKnownObservations(input.constraints, input.observations);

  const evaluations = input.constraints.map((constraint) =>
    evaluateConstraint(constraint, input.observations.get(constraint.id) ?? null),
  );

  const summaries = summariseDimensions(evaluations);

  const hardGateDimensions = DIMENSIONS.filter((dimension) =>
    input.constraints.some(
      (constraint) => constraint.severity === "hard" && constraint.dimension === dimension,
    ),
  );

  const verdict = classifyVerdict({
    summaries,
    primaryBasis: input.primaryBasis,
    hardGateDimensions,
    ...(input.criticalStageUncovered === undefined
      ? {}
      : { criticalStageUncovered: input.criticalStageUncovered }),
    ...(input.criticalStageBeyondDailyHorizon === undefined
      ? {}
      : { criticalStageBeyondDailyHorizon: input.criticalStageBeyondDailyHorizon }),
    ...(input.singlePointClimateProxy === undefined
      ? {}
      : { singlePointClimateProxy: input.singlePointClimateProxy }),
  });

  return {
    verdict: verdict.verdict,
    reasons: verdict.reasons,
    dimensionCoverage: summaries.map((summary) => ({
      dimension: summary.dimension,
      state: summary.state,
    })),
    maxAchievableLevel: maxAchievableLevel(summaries),
    evaluations,
  };
}

/**
 * A missing key and a `null` are the same answer, but an id that matches no
 * constraint is a caller defect: silently dropping it would hide a mapping that
 * nothing ever checks.
 */
function assertKnownObservations(
  constraints: readonly Constraint[],
  observations: ReadonlyMap<string, number | null>,
): void {
  const known = new Set(constraints.map((constraint) => constraint.id));
  for (const id of observations.keys()) {
    if (!known.has(id)) {
      throw new SuitabilityInputError(
        "unknown_observation_id",
        `observation for a constraint that is not in the profile: ${id}`,
      );
    }
  }
}

function assertUniqueIds(constraints: readonly Constraint[]): void {
  const seen = new Set<string>();
  for (const constraint of constraints) {
    if (seen.has(constraint.id)) {
      throw new SuitabilityInputError(
        "duplicate_constraint_id",
        `constraint id appears twice: ${constraint.id}`,
      );
    }
    seen.add(constraint.id);
  }
}

const GRADE_ORDER: readonly EvidenceGrade[] = ["A", "B", "C", "D"];

/**
 * A grade added to the contract without a rank here would make `indexOf` return
 * `-1`, which reads as "stronger than A" and silently publishes the new, weakest
 * evidence as the strongest. Failing loudly is the only safe direction.
 */
function rank(grade: EvidenceGrade): number {
  const index = GRADE_ORDER.indexOf(grade);
  if (index < 0) throw new RangeError(`evidence grade has no rank: ${String(grade)}`);
  return index;
}

/**
 * `known` means every rule in that dimension was observed, so a partly observed
 * dimension contributes nothing here — its grade would describe evidence the run
 * does not have, and `null` is the column's documented value for that state
 * (`tables-derived.md` §1: "`NULL` — not `D` — when nothing is `known`").
 */
function maxAchievableLevel(summaries: readonly DimensionSummary[]): EvidenceGrade | null {
  const grades = summaries
    .filter((summary) => summary.state === "known")
    .flatMap((summary) => summary.evaluations.map((evaluation) => evaluation.grade));

  if (grades.length === 0) return null;

  return grades.reduce<EvidenceGrade>(
    (weakest, grade) => (rank(grade) > rank(weakest) ? grade : weakest),
    "A",
  );
}
