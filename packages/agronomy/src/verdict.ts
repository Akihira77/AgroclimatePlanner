import type {
  ConstraintDimension,
  SingleValueEvaluationBasis,
  SuitabilityVerdict,
} from "@agroclimate/contracts";

import type { DimensionSummary } from "./constraint.js";

/**
 * Verdict classification — the `D25` vocabulary, derived from the evidence rules.
 *
 * `suitable | conditional | unsuitable | insufficient_data` are the four values the
 * database accepts. `excellent`, `good` and `poor` appear in older planning text and
 * are not verdicts; producing one would be a rejected write.
 *
 * Precedence is fixed and ordered by consequence, because the order *is* the policy:
 *
 * 1. a failed hard gate → `unsuitable`. Nothing softer can undo an exclusion.
 * 2. an unmeasured hard-gated dimension → `insufficient_data`. An exclusion that
 *    could not be checked is not a pass, and a number computed over the known
 *    dimensions alone would hide the missing one.
 * 3. climatology over the critical stage → at most `conditional`. The contract
 *    refuses a `suitable` verdict on a climatological basis, so this refuses it
 *    here rather than letting the row fail its own `CHECK`.
 * 4. any soft failure, or any unknown dimension the rulebook does judge →
 *    `conditional`. A caveat is not a pass.
 * 5. otherwise `suitable`.
 *
 * `not_applicable` never caps: it means the rulebook does not judge that dimension,
 * not that something is missing.
 */

export type VerdictReasonCode =
  | "hard_gate_failed"
  | "hard_gate_unknown"
  | "critical_stage_climatology"
  | "soft_failure"
  | "dimension_unknown";

export interface VerdictReason {
  readonly code: VerdictReasonCode;
  readonly dimension?: ConstraintDimension;
  /** One sentence, quotable by an explanation without re-deriving it. */
  readonly detail: string;
}

export interface VerdictInput {
  /** Exactly the shape `summariseDimensions` returns. */
  readonly summaries: readonly DimensionSummary[];
  /** The basis over the critical stage alone, never `mixed`. */
  readonly primaryBasis: SingleValueEvaluationBasis;
  /**
   * The dimensions the profile hard-gates. Passed in rather than read from the
   * summary so that "this dimension has a hard rule" stays a property of the
   * rulebook, not an inference from whichever rules happened to be evaluated.
   */
  readonly hardGateDimensions: readonly ConstraintDimension[];
}

export interface Verdict {
  readonly verdict: SuitabilityVerdict;
  /** Empty for `suitable`; otherwise at least one, naming what capped it. */
  readonly reasons: readonly VerdictReason[];
}

export function classifyVerdict(input: VerdictInput): Verdict {
  const reasons: VerdictReason[] = [];

  const byDimension = new Map(input.summaries.map((summary) => [summary.dimension, summary]));

  for (const dimension of input.hardGateDimensions) {
    const summary = byDimension.get(dimension);
    if (summary === undefined) continue;
    if (summary.hardGateFailed) {
      reasons.push({
        code: "hard_gate_failed",
        dimension,
        detail: `a hard ${dimension} constraint was observed and violated`,
      });
    }
  }
  if (reasons.length > 0) return { verdict: "unsuitable", reasons };

  for (const dimension of input.hardGateDimensions) {
    const summary = byDimension.get(dimension);
    if (summary === undefined) continue;
    if (summary.hardGateUnknown) {
      reasons.push({
        code: "hard_gate_unknown",
        dimension,
        detail: `a hard ${dimension} constraint has no observation`,
      });
    } else if (summary.state === "not_applicable") {
      // The profile says this dimension gates, so "no rule was evaluated" is a
      // missing gate, not an open one.
      reasons.push({
        code: "hard_gate_unknown",
        dimension,
        detail: `the profile hard-gates ${dimension} and no constraint was evaluated`,
      });
    }
  }
  if (reasons.length > 0) return { verdict: "insufficient_data", reasons };

  for (const summary of input.summaries) {
    if (summary.softFailures > 0) {
      reasons.push({
        code: "soft_failure",
        dimension: summary.dimension,
        detail: `${summary.softFailures} soft ${summary.dimension} constraint(s) were violated`,
      });
    } else if (summary.state === "unknown") {
      reasons.push({
        code: "dimension_unknown",
        dimension: summary.dimension,
        detail: `${summary.dimension} is judged by the rulebook but was not observed`,
      });
    }
  }

  if (input.primaryBasis === "climatology") {
    reasons.push({
      code: "critical_stage_climatology",
      detail: "the critical stage rests on climatology, which cannot support a suitable verdict",
    });
  }

  if (reasons.length > 0) return { verdict: "conditional", reasons };

  return { verdict: "suitable", reasons: [] };
}
