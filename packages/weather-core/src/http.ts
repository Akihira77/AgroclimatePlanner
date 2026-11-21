/**
 * The HTTP boundary, deliberately smaller than a client.
 *
 * It turns bytes into a status and a body, caps the body size, and applies a
 * timeout. It does **not** classify a 4xx, retry, parse JSON, or know a provider
 * exists — the adapter does the first, the queue does the second.
 */
export interface TransportRequest {
  readonly url: string;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly signal?: AbortSignal;
}

export interface TransportResponse {
  readonly status: number;
  readonly bodyText: string;
  /** Seconds from `Retry-After`, when the provider sent an integer one. */
  readonly retryAfterSeconds?: number;
}

export type TransportResult =
  | { readonly ok: true; readonly response: TransportResponse }
  | { readonly ok: false; readonly kind: "transport"; readonly message: string };

export interface Transport {
  get(request: TransportRequest): Promise<TransportResult>;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

export function transportTimeoutMs(value = DEFAULT_TIMEOUT_MS): number {
  return value;
}

export function transportMaxBytes(value = DEFAULT_MAX_BYTES): number {
  return value;
}

function retryAfterOf(headers: Headers): number | undefined {
  const raw = headers.get("retry-after");
  if (raw === null) return undefined;
  const seconds = Number(raw);
  return Number.isInteger(seconds) && seconds >= 0 ? seconds : undefined;
}

/**
 * The default transport. `fetchImpl` is a parameter so a test can supply a
 * response without a network, and so a caller can pin an Agent later without
 * changing the adapter.
 */
export function createFetchTransport(fetchImpl: typeof fetch = fetch): Transport {
  return {
    async get(request: TransportRequest): Promise<TransportResult> {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error("timeout")), request.timeoutMs);
      const signals = request.signal ? [controller.signal, request.signal] : [controller.signal];
      try {
        const response = await fetchImpl(request.url, {
          method: "GET",
          headers: { accept: "application/json" },
          signal: AbortSignal.any(signals),
        });
        const bodyText = await readCapped(response, request.maxBytes);
        const retryAfterSeconds = retryAfterOf(response.headers);
        return {
          ok: true,
          response: {
            status: response.status,
            bodyText,
            ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
          },
        };
      } catch (error) {
        // Name only: a URL can carry a query secret, and a stack is not metadata.
        const name = error instanceof Error ? error.name : "Error";
        const message =
          error instanceof Error && error.message.startsWith("response exceeded")
            ? error.message
            : `network request failed (${name})`;
        return { ok: false, kind: "transport", message };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const body = response.body;
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw new Error(`response exceeded ${maxBytes} bytes`);
    }
    text += decoder.decode(value, { stream: true });
  }
}
