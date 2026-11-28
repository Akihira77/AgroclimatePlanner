import { describe, expect, it } from "vitest";

import type { DimensionSummary } from "./constraint.js";
import { classifyVerdict } from "./verdict.js";

const summary = (overrides: Partial<DimensionSummary> = {}): DimensionSummary => ({
  dimension: "climate",
  state: "known",
  hardGateFailed: false,
  hardGateUnknown: false,
  softFailures: 0,
  evaluations: [],
  ...overrides,
});

describe("classifyVerdict — precedence is the policy", () => {
  it("calls a window unsuitable when a hard gate failed, even beside an unmeasured gate", () => {
    const result = classifyVerdict({
      summaries: [
        summary({ dimension: "climate", hardGateFailed: true }),
        summary({ dimension: "water", state: "unknown", hardGateUnknown: true }),
      ],
      primaryBasis: "daily",
      hardGateDimensions: ["climate", "water"],
    });

    // "Unsuitable" is a decision; "insufficient_data" would invite an operator to
    // wait for data that cannot change the answer.
    expect(result.verdict).toBe("unsuitable");
    expect(result.reasons.map((reason) => reason.code)).toEqual(["hard_gate_failed"]);
  });

  it("refuses to call a window suitable when a hard-gated dimension has no summary", () => {
    const result = classifyVerdict({
      summaries: [summary({ dimension: "climate" })],
      primaryBasis: "daily",
      hardGateDimensions: ["climate", "water"],
    });

    expect(result.verdict).toBe("insufficient_data");
    expect(result.reasons).toEqual([
      {
        code: "hard_gate_unknown",
        dimension: "water",
        detail: "the profile hard-gates water and no summary mentions it",
      },
    ]);
  });

  it("treats a hard-gated dimension with no evaluated rule as a missing gate", () => {
    const result = classifyVerdict({
      summaries: [summary({ dimension: "water", state: "not_applicable" })],
      primaryBasis: "daily",
      hardGateDimensions: ["water"],
    });

    expect(result.verdict).toBe("insufficient_data");
    expect(result.reasons[0]?.code).toBe("hard_gate_unknown");
  });

  it("caps a climatological critical stage at conditional", () => {
    // The contract refuses `suitable` on a climatological basis, so refusing it
    // here beats letting the row fail its own CHECK.
    const result = classifyVerdict({
      summaries: [summary()],
      primaryBasis: "climatology",
      hardGateDimensions: [],
    });

    expect(result.verdict).toBe("conditional");
    expect(result.reasons.map((reason) => reason.code)).toEqual(["critical_stage_climatology"]);
  });

  it("does not cap a dimension the rulebook does not judge", () => {
    const result = classifyVerdict({
      summaries: [summary(), summary({ dimension: "risk", state: "not_applicable" })],
      primaryBasis: "daily",
      hardGateDimensions: [],
    });

    expect(result).toEqual({ verdict: "suitable", reasons: [] });
  });

  it("records a soft failure and an unobserved judged dimension as caveats", () => {
    const result = classifyVerdict({
      summaries: [
        summary({ dimension: "climate", softFailures: 2 }),
        summary({ dimension: "timing", state: "unknown" }),
      ],
      primaryBasis: "daily",
      hardGateDimensions: [],
    });

    expect(result.verdict).toBe("conditional");
    expect(result.reasons.map((reason) => reason.code)).toEqual([
      "soft_failure",
      "dimension_unknown",
    ]);
  });

  it("is deterministic for the same input", () => {
    const input = {
      summaries: [
        summary({ dimension: "climate" }),
        summary({ dimension: "soil", state: "unknown" as const }),
      ],
      primaryBasis: "daily" as const,
      hardGateDimensions: ["climate"] as const,
    };

    expect(classifyVerdict(input)).toEqual(classifyVerdict(input));
  });

  it("caps verdict at conditional when critical stage is uncovered, beyond daily horizon, or single-observation proxy", () => {
    const uncovered = classifyVerdict({
      summaries: [summary()],
      primaryBasis: "daily",
      hardGateDimensions: [],
      criticalStageUncovered: true,
    });
    expect(uncovered.verdict).toBe("conditional");
    expect(uncovered.reasons.map((r) => r.code)).toEqual(["critical_stage_uncovered"]);

    const beyond = classifyVerdict({
      summaries: [summary()],
      primaryBasis: "daily",
      hardGateDimensions: [],
      criticalStageBeyondDailyHorizon: true,
    });
    expect(beyond.verdict).toBe("conditional");
    expect(beyond.reasons.map((r) => r.code)).toEqual(["critical_stage_beyond_daily_horizon"]);

    const proxy = classifyVerdict({
      summaries: [summary()],
      primaryBasis: "daily",
      hardGateDimensions: [],
      singlePointClimateProxy: true,
    });
    expect(proxy.verdict).toBe("conditional");
    expect(proxy.reasons.map((r) => r.code)).toEqual(["single_observation_climate_proxy"]);
  });
});
