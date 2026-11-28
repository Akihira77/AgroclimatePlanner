/**
 * Pure forecast verification metrics (Phase 9 / PRD §12.5).
 *
 * Refuses to emit accuracy metrics whenever sample size or coverage falls below
 * the configured threshold so small-sample runs never masquerade as validated skill.
 */

export const DEFAULT_MIN_SAMPLE_SIZE = 30;
export const DEFAULT_MIN_COVERAGE_RATIO = 0.8;

export class VerificationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerificationInputError";
  }
}

export interface VerificationPair {
  readonly date: string;
  readonly forecastMm: number | null;
  readonly observedMm: number | null;
  readonly climatologyMm?: number | null;
}

export interface VerificationOptions {
  readonly minSampleSize?: number;
  readonly minCoverageRatio?: number;
}

export interface ForecastVerificationMetrics {
  readonly maeMm: number;
  readonly rmseMm: number;
  readonly biasMm: number;
  readonly climatologyMaeMm: number | null;
  readonly skillScoreVsClimatology: number | null;
}

export type VerificationOutcome =
  | {
      readonly status: "verified";
      readonly totalPairs: number;
      readonly validPairs: number;
      readonly coverageRatio: number;
      readonly minSampleSize: number;
      readonly minCoverageRatio: number;
      readonly metrics: ForecastVerificationMetrics;
    }
  | {
      readonly status: "insufficient_samples";
      readonly totalPairs: number;
      readonly validPairs: number;
      readonly coverageRatio: number;
      readonly minSampleSize: number;
      readonly minCoverageRatio: number;
      readonly metrics: null;
      readonly reason: "empty_input" | "below_min_sample_size" | "below_min_coverage_ratio";
    };

function assertFiniteOptional(value: number | null | undefined, label: string): void {
  if (value !== null && value !== undefined && !Number.isFinite(value)) {
    throw new VerificationInputError(`${label} must be finite when provided`);
  }
}

export function evaluateForecastVerification(
  pairs: readonly VerificationPair[],
  options: VerificationOptions = {},
): VerificationOutcome {
  const minSampleSize = options.minSampleSize ?? DEFAULT_MIN_SAMPLE_SIZE;
  const minCoverageRatio = options.minCoverageRatio ?? DEFAULT_MIN_COVERAGE_RATIO;

  if (!Number.isInteger(minSampleSize) || minSampleSize < 1) {
    throw new VerificationInputError("minSampleSize must be a positive integer");
  }
  if (!Number.isFinite(minCoverageRatio) || minCoverageRatio <= 0 || minCoverageRatio > 1) {
    throw new VerificationInputError("minCoverageRatio must be in (0, 1]");
  }

  for (const pair of pairs) {
    assertFiniteOptional(pair.forecastMm, `forecastMm (${pair.date})`);
    assertFiniteOptional(pair.observedMm, `observedMm (${pair.date})`);
    assertFiniteOptional(pair.climatologyMm, `climatologyMm (${pair.date})`);
  }

  const totalPairs = pairs.length;
  const paired = pairs.filter(
    (p): p is VerificationPair & { readonly forecastMm: number; readonly observedMm: number } =>
      p.forecastMm !== null && p.observedMm !== null,
  );
  const validPairs = paired.length;
  const coverageRatio = totalPairs === 0 ? 0 : validPairs / totalPairs;

  if (totalPairs === 0) {
    return {
      status: "insufficient_samples",
      totalPairs,
      validPairs,
      coverageRatio,
      minSampleSize,
      minCoverageRatio,
      metrics: null,
      reason: "empty_input",
    };
  }
  if (validPairs < minSampleSize) {
    return {
      status: "insufficient_samples",
      totalPairs,
      validPairs,
      coverageRatio,
      minSampleSize,
      minCoverageRatio,
      metrics: null,
      reason: "below_min_sample_size",
    };
  }
  if (coverageRatio < minCoverageRatio) {
    return {
      status: "insufficient_samples",
      totalPairs,
      validPairs,
      coverageRatio,
      minSampleSize,
      minCoverageRatio,
      metrics: null,
      reason: "below_min_coverage_ratio",
    };
  }

  let absErrorSum = 0;
  let sqErrorSum = 0;
  let biasSum = 0;

  for (const pair of paired) {
    const diff = pair.forecastMm - pair.observedMm;
    absErrorSum += Math.abs(diff);
    sqErrorSum += diff * diff;
    biasSum += diff;
  }

  const maeMm = absErrorSum / validPairs;
  const rmseMm = Math.sqrt(sqErrorSum / validPairs);
  const biasMm = biasSum / validPairs;

  const hasAllClimatology = paired.every(
    (p): p is typeof p & { readonly climatologyMm: number } =>
      p.climatologyMm !== null && p.climatologyMm !== undefined,
  );

  let climatologyMaeMm: number | null = null;
  let skillScoreVsClimatology: number | null = null;

  if (hasAllClimatology) {
    let climAbsSum = 0;
    for (const pair of paired) {
      climAbsSum += Math.abs(pair.climatologyMm - pair.observedMm);
    }
    climatologyMaeMm = climAbsSum / validPairs;
    skillScoreVsClimatology = climatologyMaeMm > 0 ? 1 - maeMm / climatologyMaeMm : null;
  }

  return {
    status: "verified",
    totalPairs,
    validPairs,
    coverageRatio,
    minSampleSize,
    minCoverageRatio,
    metrics: {
      maeMm,
      rmseMm,
      biasMm,
      climatologyMaeMm,
      skillScoreVsClimatology,
    },
  };
}
