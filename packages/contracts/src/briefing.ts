import { z } from "zod";

import { runStatusSchema } from "./agronomy.js";
import { isoInstantSchema, opaqueIdSchema } from "./enums.js";
import { dataInputRefSchema } from "./provenance.js";
import { envelopeSchema } from "./response.js";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

export const narrationStatusSchema = z.enum(["generated", "unavailable"]);
export type NarrationStatus = z.infer<typeof narrationStatusSchema>;

export const briefingSourceModeSchema = z.enum(["llm", "deterministic_fallback"]);
export type BriefingSourceMode = z.infer<typeof briefingSourceModeSchema>;

export const briefingUnreproducibleReasonSchema = z.enum([
  "model_nondeterministic",
  "fallback_template",
  "raw_payload_not_retained",
]);
export type BriefingUnreproducibleReason = z.infer<typeof briefingUnreproducibleReasonSchema>;

export const briefingRiskHighlightSchema = z.strictObject({
  severity: z.enum(["info", "warning", "high"]),
  message: z.string().min(1).max(500),
  evidenceSegmentIds: z.array(z.string().min(1)).min(1),
});
export type BriefingRiskHighlight = z.infer<typeof briefingRiskHighlightSchema>;

/**
 * OPEN-11: bounded structured JSON body for `app.ai_briefings`.
 * Every briefing cites non-empty deterministic `evidenceSegmentIds` and never
 * carries an independent suitability verdict.
 */
export const climateBriefingBodySchema = z.strictObject({
  summary: z.string().min(1).max(1000),
  weatherInterpretation: z.string().min(1).max(1500),
  suitabilityExplanation: z.string().min(1).max(1500),
  riskHighlights: z.array(briefingRiskHighlightSchema).max(10),
  missingDataCaveats: z.array(z.string().min(1).max(500)).max(10),
  evidenceSegmentIds: z.array(z.string().min(1)).min(1),
  questionAnswer: z.string().min(1).max(1000).nullable(),
  sourceMode: briefingSourceModeSchema,
});
export type ClimateBriefingBody = z.infer<typeof climateBriefingBodySchema>;

export const aiBriefingSchema = z
  .strictObject({
    id: opaqueIdSchema,
    userId: opaqueIdSchema,
    fieldId: opaqueIdSchema,
    suitabilityRunId: opaqueIdSchema,
    body: climateBriefingBodySchema,
    narrationStatus: narrationStatusSchema,
    modelId: z.string().min(1),
    promptVersion: z.string().min(1),
    derivationVersion: z.string().min(1),
    inputRefs: z.array(dataInputRefSchema).min(1),
    fieldSnapshotHash: sha256Schema,
    sourceArtifactHashes: z.array(sha256Schema).min(1),
    inputSnapshotHash: sha256Schema,
    computedAt: isoInstantSchema,
    reproducible: z.boolean(),
    unreproducibleReason: briefingUnreproducibleReasonSchema.nullable(),
    status: runStatusSchema,
    supersededById: opaqueIdSchema.nullable(),
    createdAt: isoInstantSchema,
  })
  .superRefine((briefing, ctx) => {
    const fail = (path: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message });

    if (briefing.status === "superseded" && briefing.supersededById === null) {
      fail("supersededById", "a superseded briefing names its successor");
    }
    if (briefing.status !== "superseded" && briefing.supersededById !== null) {
      fail("supersededById", "only a superseded briefing carries a successor");
    }
    if (!briefing.reproducible && briefing.unreproducibleReason === null) {
      fail("unreproducibleReason", "an unreproducible briefing states why");
    }
    if (briefing.reproducible && briefing.unreproducibleReason !== null) {
      fail("unreproducibleReason", "a reproducible briefing has no reason to state");
    }
  });
export type AiBriefing = z.infer<typeof aiBriefingSchema>;

export const briefingGenerateRequestSchema = z.strictObject({
  question: z.string().trim().min(1).max(500).optional(),
  forceRegenerate: z.boolean().default(false),
});
export type BriefingGenerateRequest = z.infer<typeof briefingGenerateRequestSchema>;

export const aiBriefingEnvelopeSchema = envelopeSchema(aiBriefingSchema);
