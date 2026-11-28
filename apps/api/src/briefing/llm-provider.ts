import type { AiBriefingProvider, BriefingContext } from "@agroclimate/agronomy";

export type LlmProviderKind = "none" | "gemini" | "openai_compatible";

export interface LlmAdapterConfig {
  readonly provider: LlmProviderKind;
  readonly apiKey?: string;
  readonly model?: string;
  readonly baseUrl?: string;
}

const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

function buildBriefingPrompt(context: BriefingContext): string {
  return [
    "Anda adalah asisten agronomi berbahasa Indonesia yang ramah untuk petani.",
    "Tugas Anda HANYA menjelaskan fakta dari konteks JSON deterministik berikut.",
    "ATURAN KERAS:",
    "1. Dilarang mengubah status suitability/kelayakan atau mengarang angka baru.",
    "2. Setiap evidenceSegmentIds yang dikutip HARUS berasal dari allowedSegmentIds.",
    "3. Kembalikan HANYA JSON valid dengan field: summary, weatherInterpretation, suitabilityExplanation, riskHighlights (array {severity, message, evidenceSegmentIds}), missingDataCaveats (array string), evidenceSegmentIds (array string), questionAnswer (string atau null).",
    `Konteks: ${JSON.stringify(context)}`,
  ].join("\n");
}

function parseJsonResponse(text: string): Record<string, unknown> {
  const cleaned = text
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  const parsed: unknown = JSON.parse(cleaned);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("LLM response is not a JSON object");
  }
  return { ...(parsed as Record<string, unknown>), sourceMode: "llm" };
}

/**
 * Creates a pluggable `AiBriefingProvider` from environment variables (`OPEN-11`).
 * Returns `undefined` when `LLM_PROVIDER=none` (default) or `LLM_API_KEY` is blank,
 * causing `generateGroundedBriefing` to use the deterministic fallback cleanly.
 */
export function createLlmBriefingProviderFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
  fetchFn: typeof fetch = fetch,
): AiBriefingProvider | undefined {
  const rawProvider = (env["LLM_PROVIDER"] ?? "none").trim().toLowerCase();
  if (rawProvider === "" || rawProvider === "none") return undefined;

  if (rawProvider !== "gemini" && rawProvider !== "openai_compatible") {
    throw new Error(
      `Invalid LLM_PROVIDER="${rawProvider}". Expected "none", "gemini", or "openai_compatible".`,
    );
  }

  const apiKey = env["LLM_API_KEY"]?.trim();
  if (!apiKey) return undefined;

  if (rawProvider === "gemini") {
    const model = env["LLM_MODEL"]?.trim() || DEFAULT_GEMINI_MODEL;
    const baseUrl = (
      env["LLM_BASE_URL"]?.trim() || "https://generativelanguage.googleapis.com/v1beta"
    ).replace(/\/$/, "");

    return {
      modelId: `gemini:${model}`,
      async generate(context, { signal, maxTokens }) {
        const url = `${baseUrl}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
        const response = await fetchFn(url, {
          method: "POST",
          signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: buildBriefingPrompt(context) }] }],
            generationConfig: {
              temperature: 0.2,
              maxOutputTokens: maxTokens,
              responseMimeType: "application/json",
            },
          }),
        });
        if (!response.ok) {
          throw new Error(`Gemini HTTP ${response.status}`);
        }
        const json = (await response.json()) as {
          candidates?: { content?: { parts?: { text?: string }[] } }[];
        };
        const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) throw new Error("Gemini returned empty text");
        return parseJsonResponse(text);
      },
    };
  }

  const model = env["LLM_MODEL"]?.trim() || DEFAULT_OPENAI_MODEL;
  const baseUrl = (env["LLM_BASE_URL"]?.trim() || DEFAULT_OPENAI_BASE_URL).replace(/\/$/, "");

  return {
    modelId: `openai_compatible:${model}`,
    async generate(context, { signal, maxTokens }) {
      const response = await fetchFn(`${baseUrl}/chat/completions`, {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          max_tokens: maxTokens,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content:
                "Anda adalah asisten agronomi yang hanya menjelaskan fakta dari JSON deterministik.",
            },
            { role: "user", content: buildBriefingPrompt(context) },
          ],
        }),
      });
      if (!response.ok) {
        throw new Error(`OpenAI-compatible HTTP ${response.status}`);
      }
      const json = (await response.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const text = json.choices?.[0]?.message?.content;
      if (!text) throw new Error("OpenAI-compatible provider returned empty text");
      return parseJsonResponse(text);
    },
  };
}
