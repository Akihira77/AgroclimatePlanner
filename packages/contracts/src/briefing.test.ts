import { describe, expect, it } from "vitest";

import {
  aiBriefingSchema,
  briefingGenerateRequestSchema,
  climateBriefingBodySchema,
} from "./briefing.js";

const HASH = "a".repeat(64);
const UUID_1 = "11111111-1111-4111-8111-111111111111";
const UUID_2 = "22222222-2222-4222-8222-222222222222";
const UUID_3 = "33333333-3333-4333-8333-333333333333";
const UUID_4 = "44444444-4444-4444-8444-444444444444";

const VALID_BODY = {
  summary: "Ringkasan kesesuaian tanam berdasarkan hasil deterministik.",
  weatherInterpretation: "Prakiraan jangka pendek menunjukkan curah hujan sedang.",
  suitabilityExplanation: "Evaluasi menunjukkan status bersyarat pada fase kritis.",
  riskHighlights: [
    {
      severity: "warning" as const,
      message: "Sebagian periode menggunakan baseline klimatologi.",
      evidenceSegmentIds: ["2026-12-01:2026-12-01..2026-12-10:weather_forecast"],
    },
  ],
  missingDataCaveats: ["Dimensi tanah belum memiliki data uji pH."],
  evidenceSegmentIds: ["2026-12-01:2026-12-01..2026-12-10:weather_forecast"],
  questionAnswer: null,
  sourceMode: "deterministic_fallback" as const,
};

const VALID_BRIEFING = {
  id: UUID_1,
  userId: UUID_2,
  fieldId: UUID_3,
  suitabilityRunId: UUID_4,
  body: VALID_BODY,
  narrationStatus: "generated" as const,
  modelId: "deterministic-template/1",
  promptVersion: "briefing-v1",
  derivationVersion: "1",
  inputRefs: [
    {
      kind: "baseline" as const,
      role: "climatology" as const,
      purpose: "input" as const,
      baselineVersion: "1991-2020-v1",
      baselineHash: HASH,
      cellKeys: ["cell-1"],
    },
  ],
  fieldSnapshotHash: HASH,
  sourceArtifactHashes: [HASH],
  inputSnapshotHash: HASH,
  computedAt: "2026-11-28T00:00:00.000Z",
  reproducible: false,
  unreproducibleReason: "fallback_template" as const,
  status: "active" as const,
  supersededById: null,
  createdAt: "2026-11-28T00:00:00.000Z",
};

describe("briefing contracts (OPEN-11)", () => {
  it("accepts a valid structured ClimateBriefingBody and AiBriefing row", () => {
    expect(climateBriefingBodySchema.parse(VALID_BODY)).toEqual(VALID_BODY);
    expect(aiBriefingSchema.parse(VALID_BRIEFING)).toEqual(VALID_BRIEFING);
  });

  it("rejects extra unknown keys and empty evidenceSegmentIds", () => {
    expect(() =>
      climateBriefingBodySchema.parse({
        ...VALID_BODY,
        suitability: "suitable",
      }),
    ).toThrow();

    expect(() =>
      climateBriefingBodySchema.parse({
        ...VALID_BODY,
        evidenceSegmentIds: [],
      }),
    ).toThrow();
  });

  it("rejects empty sourceArtifactHashes", () => {
    expect(() =>
      aiBriefingSchema.parse({
        ...VALID_BRIEFING,
        sourceArtifactHashes: [],
      }),
    ).toThrow();
  });

  it("enforces superseded/supersededById and reproducible invariants", () => {
    expect(() =>
      aiBriefingSchema.parse({
        ...VALID_BRIEFING,
        status: "superseded",
        supersededById: null,
      }),
    ).toThrow();

    expect(() =>
      aiBriefingSchema.parse({
        ...VALID_BRIEFING,
        status: "active",
        supersededById: UUID_4,
      }),
    ).toThrow();

    expect(() =>
      aiBriefingSchema.parse({
        ...VALID_BRIEFING,
        reproducible: false,
        unreproducibleReason: null,
      }),
    ).toThrow();

    expect(() =>
      aiBriefingSchema.parse({
        ...VALID_BRIEFING,
        reproducible: true,
        unreproducibleReason: "fallback_template",
      }),
    ).toThrow();
  });

  it("parses empty generate request with forceRegenerate=false default", () => {
    expect(briefingGenerateRequestSchema.parse({})).toEqual({
      forceRegenerate: false,
    });
    expect(
      briefingGenerateRequestSchema.parse({
        question: "  Kapan risiko hujan turun?  ",
        forceRegenerate: true,
      }),
    ).toEqual({
      question: "Kapan risiko hujan turun?",
      forceRegenerate: true,
    });
  });
});
