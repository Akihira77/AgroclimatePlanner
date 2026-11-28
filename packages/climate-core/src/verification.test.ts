import { describe, expect, it } from "vitest";

import {
  VerificationInputError,
  evaluateForecastVerification,
  type VerificationPair,
} from "./verification.js";

function makePairs(count: number): VerificationPair[] {
  return Array.from({ length: count }, (_, i) => ({
    date: `2026-11-${String((i % 28) + 1).padStart(2, "0")}`,
    forecastMm: 12,
    observedMm: 10,
    climatologyMm: 14,
  }));
}

describe("forecast verification metrics", () => {
  it("computes exact MAE, RMSE, bias, and positive climatology skill score", () => {
    const result = evaluateForecastVerification(makePairs(30));
    expect(result.status).toBe("verified");
    if (result.status !== "verified") return;

    expect(result.metrics.maeMm).toBe(2);
    expect(result.metrics.rmseMm).toBe(2);
    expect(result.metrics.biasMm).toBe(2);
    expect(result.metrics.climatologyMaeMm).toBe(4);
    expect(result.metrics.skillScoreVsClimatology).toBe(0.5);
  });

  it("returns skillScoreVsClimatology = null when climatology error is zero", () => {
    const pairs = Array.from({ length: 30 }, (_, i) => ({
      date: `2026-11-${String((i % 28) + 1).padStart(2, "0")}`,
      forecastMm: 12,
      observedMm: 10,
      climatologyMm: 10,
    }));
    const result = evaluateForecastVerification(pairs);
    expect(result.status).toBe("verified");
    if (result.status !== "verified") return;

    expect(result.metrics.climatologyMaeMm).toBe(0);
    expect(result.metrics.skillScoreVsClimatology).toBeNull();
  });

  it("refuses accuracy claims when sample size or coverage is below threshold", () => {
    const empty = evaluateForecastVerification([]);
    expect(empty.status).toBe("insufficient_samples");
    if (empty.status === "insufficient_samples") {
      expect(empty.reason).toBe("empty_input");
    }

    const tooSmall = evaluateForecastVerification(makePairs(10));
    expect(tooSmall.status).toBe("insufficient_samples");
    if (tooSmall.status === "insufficient_samples") {
      expect(tooSmall.reason).toBe("below_min_sample_size");
      expect(tooSmall.metrics).toBeNull();
    }

    const lowCoverage = evaluateForecastVerification([
      ...makePairs(30),
      ...Array.from({ length: 20 }, (_, i) => ({
        date: `2026-12-${String((i % 28) + 1).padStart(2, "0")}`,
        forecastMm: null,
        observedMm: 10,
      })),
    ]);
    expect(lowCoverage.status).toBe("insufficient_samples");
    if (lowCoverage.status === "insufficient_samples") {
      expect(lowCoverage.reason).toBe("below_min_coverage_ratio");
    }
  });

  it("rejects non-finite values and invalid thresholds", () => {
    expect(() =>
      evaluateForecastVerification([
        { date: "2026-11-01", forecastMm: Number.NaN, observedMm: 10 },
      ]),
    ).toThrow(VerificationInputError);

    expect(() => evaluateForecastVerification([], { minSampleSize: 0 })).toThrow(
      VerificationInputError,
    );
    expect(() => evaluateForecastVerification([], { minCoverageRatio: 1.5 })).toThrow(
      VerificationInputError,
    );
  });
});
