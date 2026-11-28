import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { generateGroundedBriefing } from "@agroclimate/agronomy";
import { createLlmBriefingProviderFromEnv } from "../dist/briefing/llm-provider.js";

const BASE_RUN = {
  id: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  fieldId: "33333333-3333-4333-8333-333333333333",
  profileVersionId: "44444444-4444-4444-8444-444444444444",
  computedAt: "2026-11-28T00:00:00.000Z",
  engineVersion: "0.1.0",
  derivationVersion: "1",
  dimensionCoverage: [
    { dimension: "climate", state: "known" },
    { dimension: "soil", state: "known" },
    { dimension: "water", state: "not_applicable" },
    { dimension: "timing", state: "not_applicable" },
    { dimension: "risk", state: "not_applicable" },
  ],
  maxAchievableLevel: "A",
  inputRefs: [],
  fieldSnapshot: {
    fieldId: "33333333-3333-4333-8333-333333333333",
    geometryHash: "a".repeat(64),
    areaHa: 24.84,
    elevationM: 1240,
    soilType: "volcanic",
    soilPh: 6.4,
    drainageClass: "well",
    irrigationAvailability: "partial_irrigation",
    irrigationSource: null,
    extractionPolicy: "centroid",
    resolvedCells: [],
    observationsUsed: [],
    fieldSnapshotHash: "b".repeat(64),
  },
  fieldSnapshotHash: "b".repeat(64),
  inputSnapshotHash: "c".repeat(64),
  reproducible: false,
  unreproducibleReason: "raw_payload_not_retained",
  status: "active",
  supersedesId: null,
  supersededById: null,
  plantingWindows: [
    {
      id: "55555555-5555-4555-8555-555555555555",
      userId: "22222222-2222-4222-8222-222222222222",
      suitabilityRunId: "11111111-1111-4111-8111-111111111111",
      fieldId: "33333333-3333-4333-8333-333333333333",
      cropId: "66666666-6666-4666-8666-666666666666",
      cultivarId: "77777777-7777-4777-8777-777777777777",
      profileVersionId: "44444444-4444-4444-8444-444444444444",
      windowStart: "2026-11-28",
      windowEnd: "2027-04-06",
      evaluationBasis: "mixed",
      primaryBasis: "climatology",
      mixedEvidence: true,
      weakestEvidenceClass: "climatology",
      evidenceSegments: [
        {
          startDate: "2026-11-28",
          endDate: "2027-04-06",
          evaluationBasis: "climatology",
          evidenceClass: "climatology",
          coveragePercent: 100,
          provenance: { kind: "climatology", baselineVersion: "1991-2020-v1" },
        },
      ],
      missingRanges: [],
      suitability: "conditional",
      score: null,
      risks: [],
      explanations: [
        {
          code: "critical_stage_climatology",
          detail: "the critical stage rests on climatology, which cannot support a suitable verdict",
        },
      ],
      constraintsEvaluated: [],
      missingInputs: [],
      inputRefs: [],
      fieldSnapshotHash: "b".repeat(64),
      inputSnapshotHash: "c".repeat(64),
      computedAt: "2026-11-28T00:00:00.000Z",
      reproducible: false,
      unreproducibleReason: "raw_payload_not_retained",
      status: "active",
      supersedesId: null,
      supersededById: null,
    },
  ],
};

describe("createLlmBriefingProviderFromEnv & grounding (OPEN-11)", () => {
  it("returns undefined and falls back deterministically when LLM_PROVIDER=none or key is blank", async () => {
    assert.equal(createLlmBriefingProviderFromEnv({}), undefined);
    assert.equal(
      createLlmBriefingProviderFromEnv({ LLM_PROVIDER: "gemini", LLM_API_KEY: "   " }),
      undefined,
    );
    const res = await generateGroundedBriefing({ run: BASE_RUN });
    assert.equal(res.body.sourceMode, "deterministic_fallback");
    assert.equal(res.narrationStatus, "generated");
    assert.ok(!res.body.weatherInterpretation.includes("1 segmen"));
  });

  it("validates a grounded openai_compatible response as sourceMode=llm", async () => {
    const provider = createLlmBriefingProviderFromEnv(
      {
        LLM_PROVIDER: "openai_compatible",
        LLM_API_KEY: "test-key",
        LLM_MODEL: "gpt-4o-mini",
      },
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    summary: "Status Sesuai bersyarat untuk periode 2026-11-28 s.d. 2027-04-06.",
                    weatherInterpretation: "Menggunakan acuan rata-rata iklim historis.",
                    suitabilityExplanation: "Status Sesuai bersyarat ditetapkan oleh mesin agronomi.",
                    riskHighlights: [
                      {
                        severity: "warning",
                        message: "Fase kritis masih mengandalkan data klimatologi.",
                        evidenceSegmentIds: ["2026-11-28:2026-11-28..2027-04-06:climatology"],
                      },
                    ],
                    missingDataCaveats: [],
                    evidenceSegmentIds: ["2026-11-28:2026-11-28..2027-04-06:climatology"],
                    questionAnswer: null,
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        ),
    );
    const res = await generateGroundedBriefing({ run: BASE_RUN, provider });
    assert.equal(res.body.sourceMode, "llm");
    assert.equal(res.modelId, "openai_compatible:gpt-4o-mini");
  });

  it("falls back safely to deterministic_fallback when Gemini hallucinates unknown segment IDs", async () => {
    const provider = createLlmBriefingProviderFromEnv(
      { LLM_PROVIDER: "gemini", LLM_API_KEY: "test-key" },
      async () =>
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        summary: "Status Sesuai bersyarat.",
                        weatherInterpretation: "Cuaca aman.",
                        suitabilityExplanation: "Status Sesuai bersyarat.",
                        riskHighlights: [],
                        missingDataCaveats: [],
                        evidenceSegmentIds: ["seg-hallucinated-999"],
                        questionAnswer: null,
                      }),
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        ),
    );
    const res = await generateGroundedBriefing({ run: BASE_RUN, provider });
    assert.equal(res.body.sourceMode, "deterministic_fallback");
    assert.equal(res.narrationStatus, "unavailable");
    assert.equal(res.fallbackReason, "unknown_segment_ref");
  });
});
