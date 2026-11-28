import type {
  Constraint,
  EvaluationBasis,
  EvidenceSegment,
  GrowthStage,
  MissingRange,
  SingleValueEvaluationBasis,
  SuitabilityVerdict,
  WeatherDataClass,
} from "@agroclimate/contracts";

import { validatePartition } from "./partition.js";
import type { PartitionViolation } from "./partition.js";
import { addDays, criticalStageWindows } from "./stages.js";
import type { CriticalStageWindow } from "./stages.js";
import { SuitabilityInputError, assessSuitability } from "./suitability.js";
import type { SuitabilityAssessment } from "./suitability.js";

/**
 * Pure planting-window generation & deterministic ranking — Phase 6.5.
 *
 * Reuses `assessSuitability`, `criticalStageWindows`, and `validatePartition`
 * without duplicating any suitability or partition logic. No clock, no I/O,
 * no database writes (`OPEN-27` gates persistence, not pure generation).
 */

export class WindowGenerationError extends RangeError {
  readonly code:
    | "invalid_duration"
    | "duplicate_candidate_start"
    | "invalid_start_date"
    | "no_evidence_segments"
    | "inconsistent_primary_basis";

  constructor(code: WindowGenerationError["code"], message: string) {
    super(message);
    this.name = "WindowGenerationError";
    this.code = code;
  }
}

export class WindowPartitionError extends RangeError {
  readonly code = "invalid_partition" as const;
  readonly startDate: string;
  readonly violations: readonly PartitionViolation[];

  constructor(startDate: string, violations: readonly PartitionViolation[]) {
    super(
      `invalid evidence partition for window starting ${startDate}: ${violations.map((v) => v.code).join(", ")}`,
    );
    this.name = "WindowPartitionError";
    this.startDate = startDate;
    this.violations = violations;
  }
}

export interface PlantingWindowCandidate {
  readonly startDate: string;
  readonly observations: ReadonlyMap<string, number | null>;
  readonly primaryBasis: SingleValueEvaluationBasis;
  readonly evidenceSegments: readonly EvidenceSegment[];
  readonly missingRanges: readonly MissingRange[];
  /** True when climate constraints were resolved from a single point-in-time field observation. */
  readonly singlePointClimateProxy?: boolean;
}

export interface GeneratePlantingWindowsInput {
  readonly constraints: readonly Constraint[];
  readonly stages: readonly GrowthStage[];
  readonly durationDays: number;
  readonly candidates: readonly PlantingWindowCandidate[];
}

export interface GeneratedPlantingWindow {
  readonly rank: number;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly evaluationBasis: EvaluationBasis;
  readonly primaryBasis: SingleValueEvaluationBasis;
  readonly mixedEvidence: boolean;
  readonly weakestEvidenceClass: WeatherDataClass;
  readonly assessment: SuitabilityAssessment;
  readonly criticalStages: readonly CriticalStageWindow[];
  readonly evidenceSegments: readonly EvidenceSegment[];
  readonly missingRanges: readonly MissingRange[];
}

const VERDICT_RANK: Readonly<Record<SuitabilityVerdict, number>> = {
  suitable: 0,
  conditional: 1,
  insufficient_data: 2,
  unsuitable: 3,
};

const BASIS_RANK: Readonly<Record<SingleValueEvaluationBasis, number>> = {
  daily: 0,
  weekly: 1,
  monthly: 2,
  climatology: 3,
};

const EVIDENCE_CLASS_RANK: Readonly<Record<WeatherDataClass, number>> = {
  field_observation: 0,
  station_observation: 1,
  satellite_estimate: 2,
  reanalysis: 3,
  weather_forecast: 4,
  subseasonal_forecast: 5,
  seasonal_forecast: 6,
  annual_outlook: 7,
  climatology: 8,
};

function evidenceClassRank(cls: WeatherDataClass): number {
  const rank = EVIDENCE_CLASS_RANK[cls];
  if (rank === undefined) {
    throw new RangeError(`evidence class has no rank: ${String(cls)}`);
  }
  return rank;
}

function compareIntervals(
  a: { readonly startDate: string; readonly endDate: string },
  b: { readonly startDate: string; readonly endDate: string },
): number {
  if (a.startDate !== b.startDate) return a.startDate < b.startDate ? -1 : 1;
  if (a.endDate !== b.endDate) return a.endDate < b.endDate ? -1 : 1;
  return 0;
}

function computeWindowEnd(startDate: string, durationDays: number): string {
  try {
    return addDays(startDate, durationDays - 1);
  } catch (error) {
    throw new WindowGenerationError(
      "invalid_start_date",
      error instanceof Error ? error.message : `invalid startDate: ${startDate}`,
    );
  }
}

function compareWindows(
  a: Omit<GeneratedPlantingWindow, "rank">,
  b: Omit<GeneratedPlantingWindow, "rank">,
): number {
  const verdictDiff = VERDICT_RANK[a.assessment.verdict] - VERDICT_RANK[b.assessment.verdict];
  if (verdictDiff !== 0) return verdictDiff;

  const reasonDiff = a.assessment.reasons.length - b.assessment.reasons.length;
  if (reasonDiff !== 0) return reasonDiff;

  const softFailA = a.assessment.evaluations.filter(
    (e) => e.severity === "soft" && e.outcome === "violated",
  ).length;
  const softFailB = b.assessment.evaluations.filter(
    (e) => e.severity === "soft" && e.outcome === "violated",
  ).length;
  if (softFailA !== softFailB) return softFailA - softFailB;

  const unknownDimsA = a.assessment.dimensionCoverage.filter((d) => d.state === "unknown").length;
  const unknownDimsB = b.assessment.dimensionCoverage.filter((d) => d.state === "unknown").length;
  if (unknownDimsA !== unknownDimsB) return unknownDimsA - unknownDimsB;

  const basisDiff = BASIS_RANK[a.primaryBasis] - BASIS_RANK[b.primaryBasis];
  if (basisDiff !== 0) return basisDiff;

  const classDiff =
    evidenceClassRank(a.weakestEvidenceClass) - evidenceClassRank(b.weakestEvidenceClass);
  if (classDiff !== 0) return classDiff;

  return a.windowStart < b.windowStart ? -1 : a.windowStart > b.windowStart ? 1 : 0;
}

export function generatePlantingWindows(
  input: GeneratePlantingWindowsInput,
): readonly GeneratedPlantingWindow[] {
  const { constraints, stages, durationDays, candidates } = input;

  if (!Number.isInteger(durationDays) || durationDays <= 0) {
    throw new WindowGenerationError(
      "invalid_duration",
      `durationDays must be a positive integer: ${durationDays}`,
    );
  }

  if (constraints.length === 0) {
    throw new SuitabilityInputError(
      "empty_rulebook",
      "a profile with no constraints cannot be assessed",
    );
  }

  if (candidates.length === 0) return [];

  const seenStarts = new Set<string>();
  const evaluated: Array<Omit<GeneratedPlantingWindow, "rank">> = [];

  for (const candidate of candidates) {
    if (seenStarts.has(candidate.startDate)) {
      throw new WindowGenerationError(
        "duplicate_candidate_start",
        `candidate startDate appears twice: ${candidate.startDate}`,
      );
    }
    seenStarts.add(candidate.startDate);

    // Day 0 is candidate.startDate, so an n-day cycle ends at offset n - 1.
    const windowEnd = computeWindowEnd(candidate.startDate, durationDays);

    const violations = validatePartition({
      windowStart: candidate.startDate,
      windowEnd,
      segments: candidate.evidenceSegments,
      missingRanges: candidate.missingRanges,
    });
    if (violations.length > 0) {
      throw new WindowPartitionError(candidate.startDate, violations);
    }

    if (candidate.evidenceSegments.length === 0) {
      throw new WindowGenerationError(
        "no_evidence_segments",
        `window starting ${candidate.startDate} has no evidence segments`,
      );
    }

    const sortedSegments = [...candidate.evidenceSegments].sort(compareIntervals);
    const sortedMissingRanges = [...candidate.missingRanges].sort(compareIntervals);

    const criticalStages = criticalStageWindows(stages, candidate.startDate, durationDays);
    let criticalStageUncovered = false;
    let criticalStageBeyondDailyHorizon = false;
    const dailyHorizonLimit = addDays(candidate.startDate, 16);

    if (criticalStages.length > 0) {
      const overlappingCriticalSegments = sortedSegments.filter((seg) =>
        criticalStages.some((cs) => seg.startDate <= cs.endDate && seg.endDate >= cs.startDate),
      );
      const overlappingMissing = sortedMissingRanges.some((mr) =>
        criticalStages.some((cs) => mr.startDate <= cs.endDate && mr.endDate >= cs.startDate),
      );
      if (overlappingCriticalSegments.length === 0 || overlappingMissing) {
        criticalStageUncovered = true;
      }
      if (overlappingCriticalSegments.length > 0) {
        const coarsestCriticalRank = Math.max(
          ...overlappingCriticalSegments.map((seg) => BASIS_RANK[seg.evaluationBasis]),
        );
        if (BASIS_RANK[candidate.primaryBasis] < coarsestCriticalRank) {
          throw new WindowGenerationError(
            "inconsistent_primary_basis",
            `primaryBasis ${candidate.primaryBasis} is finer than critical-stage evidence for window starting ${candidate.startDate}`,
          );
        }
        const allDailyForecast = overlappingCriticalSegments.every(
          (seg) =>
            seg.evaluationBasis === "daily" || seg.evidenceClass === "weather_forecast",
        );
        const endsPastHorizon = criticalStages.some((cs) => cs.endDate > dailyHorizonLimit);
        if (allDailyForecast && endsPastHorizon) {
          criticalStageBeyondDailyHorizon = true;
        }
      }
    }

    const assessment = assessSuitability({
      constraints,
      observations: candidate.observations,
      primaryBasis: candidate.primaryBasis,
      criticalStageUncovered,
      criticalStageBeyondDailyHorizon,
      ...(candidate.singlePointClimateProxy === undefined
        ? {}
        : { singlePointClimateProxy: candidate.singlePointClimateProxy }),
    });

    const bases = new Set(sortedSegments.map((s) => s.evaluationBasis));
    const evaluationBasis: EvaluationBasis =
      bases.size === 1 ? sortedSegments[0]!.evaluationBasis : "mixed";

    const classes = new Set(sortedSegments.map((s) => s.evidenceClass));
    const mixedEvidence = classes.size > 1;

    let weakestEvidenceClass = sortedSegments[0]!.evidenceClass;
    let weakestRank = evidenceClassRank(weakestEvidenceClass);
    for (const seg of sortedSegments) {
      const rank = evidenceClassRank(seg.evidenceClass);
      if (rank > weakestRank) {
        weakestRank = rank;
        weakestEvidenceClass = seg.evidenceClass;
      }
    }

    evaluated.push({
      windowStart: candidate.startDate,
      windowEnd,
      evaluationBasis,
      primaryBasis: candidate.primaryBasis,
      mixedEvidence,
      weakestEvidenceClass,
      assessment,
      criticalStages,
      evidenceSegments: sortedSegments,
      missingRanges: sortedMissingRanges,
    });
  }

  evaluated.sort(compareWindows);

  return evaluated.map((item, index) => ({
    rank: index + 1,
    ...item,
  }));
}
