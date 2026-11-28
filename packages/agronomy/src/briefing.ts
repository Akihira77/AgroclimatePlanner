import type {
  BriefingRiskHighlight,
  BriefingUnreproducibleReason,
  ClimateBriefingBody,
  EvidenceSegment,
  NarrationStatus,
  PlantingWindow,
  SuitabilityRunWithWindows,
  SuitabilityVerdict,
} from "@agroclimate/contracts";
import { climateBriefingBodySchema } from "@agroclimate/contracts";

export const BRIEFING_PROMPT_VERSION = "briefing-v1";
export const BRIEFING_DERIVATION_VERSION = "1";
export const DETERMINISTIC_FALLBACK_MODEL_ID = "deterministic-template/1";

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_TOKENS = 1200;

export class BriefingContextError extends Error {
  readonly code: "no_windows" | "no_evidence_segments";

  constructor(code: BriefingContextError["code"], message: string) {
    super(message);
    this.name = "BriefingContextError";
    this.code = code;
  }
}

export class BriefingGroundingError extends Error {
  readonly code: "schema_invalid" | "unknown_segment_ref" | "numeric_score_on_insufficient_data";

  constructor(code: BriefingGroundingError["code"], message: string) {
    super(message);
    this.name = "BriefingGroundingError";
    this.code = code;
  }
}

export interface BriefingSegmentSummary {
  readonly evidenceSegmentId: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly evaluationBasis: EvidenceSegment["evaluationBasis"];
  readonly evidenceClass: EvidenceSegment["evidenceClass"];
  readonly coveragePercent: number;
}

export interface BriefingWindowSummary {
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly suitability: SuitabilityVerdict;
  readonly evaluationBasis: PlantingWindow["evaluationBasis"];
  readonly primaryBasis: PlantingWindow["primaryBasis"];
  readonly mixedEvidence: boolean;
  readonly weakestEvidenceClass: PlantingWindow["weakestEvidenceClass"];
  readonly segments: readonly BriefingSegmentSummary[];
  readonly missingRanges: PlantingWindow["missingRanges"];
  readonly missingInputs: readonly string[];
  readonly explanations: readonly string[];
}

export interface BriefingContext {
  readonly fieldId: string;
  readonly suitabilityRunId: string;
  readonly computedAt: string;
  readonly maxAchievableLevel: SuitabilityRunWithWindows["maxAchievableLevel"];
  readonly unknownDimensions: readonly string[];
  readonly windows: readonly BriefingWindowSummary[];
  readonly allowedSegmentIds: readonly string[];
  readonly question: string | null;
}

export interface AiBriefingProvider {
  readonly modelId: string;
  generate(
    context: BriefingContext,
    options: { readonly signal: AbortSignal; readonly maxTokens: number },
  ): Promise<unknown>;
}

export interface GenerateGroundedBriefingInput {
  readonly run: SuitabilityRunWithWindows;
  readonly question?: string;
  readonly provider?: AiBriefingProvider;
  readonly timeoutMs?: number;
  readonly maxTokens?: number;
}

export interface GeneratedBriefingResult {
  readonly body: ClimateBriefingBody;
  readonly narrationStatus: NarrationStatus;
  readonly modelId: string;
  readonly promptVersion: string;
  readonly derivationVersion: string;
  readonly sourceArtifactHashes: readonly string[];
  readonly reproducible: false;
  readonly unreproducibleReason: BriefingUnreproducibleReason;
  readonly fallbackReason: string | null;
}

export function buildEvidenceSegmentId(windowStart: string, segment: EvidenceSegment): string {
  return `${windowStart}:${segment.startDate}..${segment.endDate}:${segment.evidenceClass}`;
}

function sanitizeQuestion(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const withoutControls = Array.from(raw, (ch) => {
    const code = ch.charCodeAt(0);
    return code < 0x20 || code === 0x7f ? " " : ch;
  }).join("");
  const cleaned = withoutControls.replace(/\s+/g, " ").trim().slice(0, 500);
  return cleaned === "" ? null : cleaned;
}

export function buildBriefingContext(
  run: SuitabilityRunWithWindows,
  question?: string,
): BriefingContext {
  if (run.plantingWindows.length === 0) {
    throw new BriefingContextError(
      "no_windows",
      "cannot build briefing context without at least one planting window",
    );
  }

  const allowedSet = new Set<string>();
  const windows: BriefingWindowSummary[] = run.plantingWindows.map((w) => {
    const segments: BriefingSegmentSummary[] = w.evidenceSegments.map((seg) => {
      const id = buildEvidenceSegmentId(w.windowStart, seg);
      allowedSet.add(id);
      return {
        evidenceSegmentId: id,
        startDate: seg.startDate,
        endDate: seg.endDate,
        evaluationBasis: seg.evaluationBasis,
        evidenceClass: seg.evidenceClass,
        coveragePercent: seg.coveragePercent,
      };
    });

    const missingInputs = w.missingInputs
      .map((entry) => {
        const dim = entry["dimension"];
        return typeof dim === "string" && dim.length > 0 ? dim : null;
      })
      .filter((dim): dim is string => dim !== null);

    const explanations = w.explanations
      .map((entry) => {
        const detail = entry["detail"];
        return typeof detail === "string" && detail.length > 0 ? detail : null;
      })
      .filter((detail): detail is string => detail !== null);

    return {
      windowStart: w.windowStart,
      windowEnd: w.windowEnd,
      suitability: w.suitability,
      evaluationBasis: w.evaluationBasis,
      primaryBasis: w.primaryBasis,
      mixedEvidence: w.mixedEvidence,
      weakestEvidenceClass: w.weakestEvidenceClass,
      segments,
      missingRanges: w.missingRanges,
      missingInputs,
      explanations,
    };
  });

  if (allowedSet.size === 0) {
    throw new BriefingContextError(
      "no_evidence_segments",
      "cannot build briefing context without any evidence segments",
    );
  }

  const unknownDimensions = run.dimensionCoverage
    .filter((entry) => entry.state === "unknown")
    .map((entry) => entry.dimension);

  return {
    fieldId: run.fieldId,
    suitabilityRunId: run.id,
    computedAt: run.computedAt,
    maxAchievableLevel: run.maxAchievableLevel,
    unknownDimensions,
    windows,
    allowedSegmentIds: [...allowedSet].sort(),
    question: sanitizeQuestion(question),
  };
}

const FABRICATED_NUMERIC_SCORE_PATTERNS = [
  /skor\s*(kesesuaian)?\s*[:=]?\s*\d+/i,
  /\b\d{1,3}\s*%\s*(cocok|sesuai|suitable)/i,
] as const;

export function validateGroundedBriefing(
  raw: unknown,
  context: BriefingContext,
): ClimateBriefingBody {
  const parsed = climateBriefingBodySchema.safeParse(raw);
  if (!parsed.success) {
    throw new BriefingGroundingError(
      "schema_invalid",
      `briefing body failed schema validation: ${parsed.error.issues[0]?.message ?? "invalid"}`,
    );
  }

  const allowed = new Set(context.allowedSegmentIds);
  for (const ref of parsed.data.evidenceSegmentIds) {
    if (!allowed.has(ref)) {
      throw new BriefingGroundingError(
        "unknown_segment_ref",
        `briefing cited unknown evidence segment: ${ref}`,
      );
    }
  }
  for (const highlight of parsed.data.riskHighlights) {
    for (const ref of highlight.evidenceSegmentIds) {
      if (!allowed.has(ref)) {
        throw new BriefingGroundingError(
          "unknown_segment_ref",
          `risk highlight cited unknown evidence segment: ${ref}`,
        );
      }
    }
  }

  const allInsufficient = context.windows.every((w) => w.suitability === "insufficient_data");
  if (allInsufficient) {
    const texts = [
      parsed.data.summary,
      parsed.data.suitabilityExplanation,
      parsed.data.questionAnswer ?? "",
    ];
    for (const text of texts) {
      if (FABRICATED_NUMERIC_SCORE_PATTERNS.some((pattern) => pattern.test(text))) {
        throw new BriefingGroundingError(
          "numeric_score_on_insufficient_data",
          "briefing claimed a numeric suitability score despite insufficient_data",
        );
      }
    }
  }

  return parsed.data;
}

function verdictLabelId(verdict: SuitabilityVerdict): string {
  switch (verdict) {
    case "suitable":
      return "sesuai";
    case "conditional":
      return "bersyarat";
    case "unsuitable":
      return "tidak sesuai";
    case "insufficient_data":
      return "data tidak cukup";
  }
}

function basisLabelId(basis: PlantingWindow["evaluationBasis"]): string {
  switch (basis) {
    case "daily":
      return "harian";
    case "weekly":
      return "mingguan";
    case "monthly":
      return "bulanan";
    case "climatology":
      return "klimatologi";
    case "mixed":
      return "campuran (prakiraan dan klimatologi)";
  }
}

export function buildDeterministicBriefing(context: BriefingContext): ClimateBriefingBody {
  const lead = context.windows[0];
  if (lead === undefined) {
    throw new BriefingContextError("no_windows", "no windows available");
  }

  const hasClimatology = context.windows.some((w) =>
    w.segments.some((s) => s.evidenceClass === "climatology"),
  );
  const hasForecast = context.windows.some((w) =>
    w.segments.some(
      (s) =>
        s.evidenceClass === "weather_forecast" ||
        s.evidenceClass === "subseasonal_forecast" ||
        s.evidenceClass === "seasonal_forecast",
    ),
  );

  const summary = `Evaluasi deterministik untuk ${context.windows.length} jendela tanam menempatkan jendela utama ${lead.windowStart} s.d. ${lead.windowEnd} pada status ${verdictLabelId(lead.suitability)} dengan basis ${basisLabelId(lead.evaluationBasis)}.`;

  const weatherParts: string[] = [
    `Bukti cuaca terlemah pada jendela utama berasal dari kelas ${lead.weakestEvidenceClass} (${lead.segments.length} segmen).`,
  ];
  if (hasClimatology && hasForecast) {
    weatherParts.push(
      "Sebagian periode menggunakan baseline klimatologi historis (bukan prakiraan langsung) bersama data prakiraan.",
    );
  } else if (hasClimatology) {
    weatherParts.push(
      "Seluruh segmen saat ini bertumpu pada baseline klimatologi historis, bukan prakiraan cuaca aktif.",
    );
  }
  const weatherInterpretation = weatherParts.join(" ");

  const reasonDetail =
    lead.explanations.length > 0
      ? `Alasan utama mesin agronomi: ${lead.explanations.slice(0, 3).join("; ")}.`
      : "Tidak ada pelanggaran kendala tambahan yang tercatat pada jendela utama.";
  const suitabilityExplanation = `Status ${verdictLabelId(lead.suitability)} ditetapkan oleh mesin aturan deterministik (bukan penilaian AI) dengan basis kritis ${lead.primaryBasis}. ${reasonDetail}`;

  const riskHighlights: BriefingRiskHighlight[] = [];
  const leadSegmentIds = lead.segments.map((s) => s.evidenceSegmentId);
  const fallbackRefs = leadSegmentIds.length > 0 ? leadSegmentIds : context.allowedSegmentIds;

  if (lead.suitability === "unsuitable" || lead.suitability === "conditional") {
    riskHighlights.push({
      severity: lead.suitability === "unsuitable" ? "high" : "warning",
      message: `Jendela ${lead.windowStart} s.d. ${lead.windowEnd} berstatus ${verdictLabelId(lead.suitability)}; tinjau kendala sebelum menanam.`,
      evidenceSegmentIds: fallbackRefs.slice(0, 5),
    });
  }
  if (hasClimatology) {
    const climatologyRefs = context.windows
      .flatMap((w) => w.segments)
      .filter((s) => s.evidenceClass === "climatology")
      .map((s) => s.evidenceSegmentId)
      .slice(0, 5);
    if (climatologyRefs.length > 0) {
      riskHighlights.push({
        severity: "info",
        message:
          "Terdapat segmen berbasis klimatologi historis; ketidakpastian jangka menengah perlu dipantau saat prakiraan baru tersedia.",
        evidenceSegmentIds: climatologyRefs,
      });
    }
  }

  const missingDataCaveats: string[] = [];
  if (context.unknownDimensions.length > 0) {
    missingDataCaveats.push(
      `Dimensi lahan dengan data belum lengkap: ${context.unknownDimensions.join(", ")}.`,
    );
  }
  for (const w of context.windows) {
    for (const range of w.missingRanges) {
      missingDataCaveats.push(
        `Rentang tanggal ${range.startDate} s.d. ${range.endDate} tidak memiliki data lengkap (${range.reason}).`,
      );
    }
  }
  const boundedCaveats = missingDataCaveats.slice(0, 10);

  const questionAnswer =
    context.question === null
      ? null
      : `Pertanyaan "${context.question}" dijawab berdasarkan fakta run deterministik: jendela utama ${lead.windowStart} s.d. ${lead.windowEnd} berstatus ${verdictLabelId(lead.suitability)} (${basisLabelId(lead.evaluationBasis)}), dengan kelas bukti terlemah ${lead.weakestEvidenceClass}. Penilaian kesesuaian tetap ditentukan sepenuhnya oleh mesin agronomi deterministik.`;

  return {
    summary,
    weatherInterpretation,
    suitabilityExplanation,
    riskHighlights: riskHighlights.slice(0, 10),
    missingDataCaveats: boundedCaveats,
    evidenceSegmentIds: [...context.allowedSegmentIds],
    questionAnswer,
    sourceMode: "deterministic_fallback",
  };
}

export async function generateGroundedBriefing(
  input: GenerateGroundedBriefingInput,
): Promise<GeneratedBriefingResult> {
  const context = buildBriefingContext(input.run, input.question);
  const sourceArtifactHashes = Array.from(
    new Set([
      input.run.inputSnapshotHash,
      ...input.run.plantingWindows.map((w) => w.inputSnapshotHash),
    ]),
  ).sort();

  if (input.provider === undefined) {
    return {
      body: buildDeterministicBriefing(context),
      narrationStatus: "generated",
      modelId: DETERMINISTIC_FALLBACK_MODEL_ID,
      promptVersion: BRIEFING_PROMPT_VERSION,
      derivationVersion: BRIEFING_DERIVATION_VERSION,
      sourceArtifactHashes,
      reproducible: false,
      unreproducibleReason: "fallback_template",
      fallbackReason: "provider_not_configured",
    };
  }

  const controller = new AbortController();
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxTokens = input.maxTokens ?? DEFAULT_MAX_TOKENS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const raw = await input.provider.generate(context, {
      signal: controller.signal,
      maxTokens,
    });
    const validated = validateGroundedBriefing(raw, context);
    return {
      body: { ...validated, sourceMode: "llm" },
      narrationStatus: "generated",
      modelId: input.provider.modelId,
      promptVersion: BRIEFING_PROMPT_VERSION,
      derivationVersion: BRIEFING_DERIVATION_VERSION,
      sourceArtifactHashes,
      reproducible: false,
      unreproducibleReason: "model_nondeterministic",
      fallbackReason: null,
    };
  } catch (error) {
    const reason =
      error instanceof BriefingGroundingError
        ? error.code
        : controller.signal.aborted
          ? "provider_timeout"
          : "provider_error";
    return {
      body: buildDeterministicBriefing(context),
      narrationStatus: "unavailable",
      modelId: DETERMINISTIC_FALLBACK_MODEL_ID,
      promptVersion: BRIEFING_PROMPT_VERSION,
      derivationVersion: BRIEFING_DERIVATION_VERSION,
      sourceArtifactHashes,
      reproducible: false,
      unreproducibleReason: "fallback_template",
      fallbackReason: reason,
    };
  } finally {
    clearTimeout(timer);
  }
}
