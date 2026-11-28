import { describe, expect, it } from "vitest";

import { fieldEvaluateRequestSchema, plantingWindowSchema } from "../src/agronomy.js";

const uuidA = "0192f0aa-0000-7000-8000-000000000001";
const uuidB = "0192f0aa-0000-7000-8000-000000000002";
const uuidC = "0192f0aa-0000-7000-8000-000000000003";
const hashA = "a".repeat(64);
const hashB = "b".repeat(64);

const segment = {
  startDate: "2026-12-01",
  endDate: "2027-03-25",
  evaluationBasis: "monthly",
  evidenceClass: "seasonal_forecast",
  coveragePercent: 100,
  provenance: {
    kind: "forecast",
    forecastRunIds: [uuidA],
    ingestionRunIds: [uuidB],
    initializedAt: "2026-11-28T00:00:00Z",
  },
} as const;

describe("fieldEvaluateRequestSchema", () => {
  it("accepts a valid field evaluation request", () => {
    const parsed = fieldEvaluateRequestSchema.safeParse({
      profileVersionId: uuidA,
      irrigationAvailability: "partial_irrigation",
      inputRefs: [
        {
          kind: "forecast",
          role: "seasonal",
          purpose: "input",
          forecastRunIds: [uuidA],
          ingestionRunIds: [uuidB],
          recordSetHash: hashA,
        },
      ],
      candidates: [
        {
          startDate: "2026-12-01",
          observations: { [uuidC]: 120 },
          primaryBasis: "monthly",
          evidenceSegments: [segment],
          missingRanges: [],
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects empty candidates or unknown properties", () => {
    expect(
      fieldEvaluateRequestSchema.safeParse({
        profileVersionId: uuidA,
        inputRefs: [
          {
            kind: "baseline",
            role: "climatology",
            purpose: "input",
            baselineVersion: "ERA5:v1",
            baselineHash: hashA,
            cellKeys: ["cell-1"],
          },
        ],
        candidates: [],
      }).success,
    ).toBe(false);
  });
});

describe("plantingWindowSchema invariants", () => {
  const baseWindow = {
    id: uuidA,
    userId: uuidB,
    suitabilityRunId: uuidC,
    fieldId: uuidA,
    cropId: uuidB,
    cultivarId: uuidC,
    profileVersionId: uuidA,
    windowStart: "2026-12-01",
    windowEnd: "2027-03-25",
    evaluationBasis: "monthly",
    primaryBasis: "monthly",
    mixedEvidence: false,
    weakestEvidenceClass: "seasonal_forecast",
    evidenceSegments: [segment],
    missingRanges: [],
    suitability: "suitable",
    score: null,
    risks: [],
    explanations: [],
    constraintsEvaluated: [],
    missingInputs: [],
    inputRefs: [
      {
        kind: "forecast",
        role: "seasonal",
        purpose: "input",
        forecastRunIds: [uuidA],
        ingestionRunIds: [uuidB],
        recordSetHash: hashA,
      },
    ],
    fieldSnapshotHash: hashA,
    inputSnapshotHash: hashB,
    computedAt: "2026-11-28T00:00:00Z",
    reproducible: false,
    unreproducibleReason: "raw_payload_not_retained",
    status: "active",
    supersedesId: null,
    supersededById: null,
  } as const;

  it("accepts a valid planting window row", () => {
    expect(plantingWindowSchema.safeParse(baseWindow).success).toBe(true);
  });

  it("refuses suitable when primaryBasis is climatology", () => {
    expect(
      plantingWindowSchema.safeParse({
        ...baseWindow,
        primaryBasis: "climatology",
        suitability: "suitable",
      }).success,
    ).toBe(false);
  });

  it("refuses mixedEvidence mismatch", () => {
    expect(
      plantingWindowSchema.safeParse({
        ...baseWindow,
        mixedEvidence: true,
      }).success,
    ).toBe(false);
  });
});
