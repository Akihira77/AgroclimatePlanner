import type { Transport, TransportRequest } from "@agroclimate/weather-core";

/**
 * Wraps an HTTP Transport with a polite minimum interval between outbound
 * requests (`OPEN-03`), ensuring the worker never bursts Open-Meteo's free tier.
 */
export function createThrottledTransport(
  inner: Transport,
  minIntervalMs = 250,
): Transport {
  let nextAllowedAt = 0;
  let chain: Promise<void> = Promise.resolve();

  return {
    get(request: TransportRequest): ReturnType<Transport["get"]> {
      const waitTurn = chain.then(async () => {
        const now = Date.now();
        if (now < nextAllowedAt) {
          await new Promise((resolve) => setTimeout(resolve, nextAllowedAt - now));
        }
        nextAllowedAt = Date.now() + Math.max(0, minIntervalMs);
      });
      chain = waitTurn.catch(() => undefined);
      return waitTurn.then(() => inner.get(request));
    },
  };
}
