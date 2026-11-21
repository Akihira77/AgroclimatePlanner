import type { Transport } from "./http.js";

/**
 * What every adapter is given: a transport, a clock, and the two limits it must
 * pass to the transport. The clock is injected because `receivedAt` is
 * provenance — a test must be able to pin it.
 */
export interface AdapterRuntime {
  readonly transport: Transport;
  readonly now: () => Date;
  readonly timeoutMs: number;
  readonly maxBytes: number;
}
