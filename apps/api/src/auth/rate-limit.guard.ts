import type { CanActivate, ExecutionContext } from "@nestjs/common";
import { HttpException, Inject, Injectable } from "@nestjs/common";
import type { Response } from "express";

import { AUTH_RATE_LIMITER } from "../tokens.js";
import type { ApiRequest } from "../http/request-id.middleware.js";

/**
 * The approved v1 limiter (`IG-7`): 30 requests per minute per client IP,
 * in-process, enforced before hashing and before the database lookup.
 *
 * Deliberate limitations, recorded rather than implied: state is lost on restart,
 * each replica enforces an independent quota, distributed credential stuffing is
 * not mitigated, and per-account throttling is deferred. Redis is not part of v1.
 */

export const AUTH_RATE_LIMIT = 30;
export const AUTH_RATE_WINDOW_MS = 60_000;

/**
 * Upper bound on tracked clients. Without it, a stream of distinct source
 * addresses grows the map for as long as the process lives, which turns a
 * brute-force attempt into a memory-exhaustion vector.
 */
const MAX_TRACKED_CLIENTS = 10_000;

export { MAX_TRACKED_CLIENTS };

export interface FixedWindowOptions {
  readonly limit: number;
  readonly windowMs: number;
  readonly maxKeys: number;
  /** Injected so tests control time instead of sleeping. */
  readonly now?: () => number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly limit: number;
  /** Requests still available in the current window, never negative. */
  readonly remaining: number;
  readonly resetAtEpochSeconds: number;
  /** `0` when allowed; at least `1` when refused, because `Retry-After: 0` reads as retry now. */
  readonly retryAfterSeconds: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * A fixed window per key. Fixed rather than sliding because the approved policy
 * is a count per minute, and a sliding window would need per-request timestamps
 * in memory for no security gain at this volume.
 *
 * `consume` is synchronous and therefore atomic with respect to other requests in
 * the same process: Node runs it to completion before yielding, so two concurrent
 * requests cannot both read the same count.
 */
export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly now: () => number;

  constructor(private readonly options: FixedWindowOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Visible for tests: the tracked client count after cleanup. */
  get size(): number {
    return this.buckets.size;
  }

  consume(key: string): RateLimitDecision {
    const now = this.now();
    this.makeRoom(now);

    let bucket = this.buckets.get(key);
    if (bucket === undefined || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + this.options.windowMs };
      this.buckets.set(key, bucket);
    }

    bucket.count += 1;

    const allowed = bucket.count <= this.options.limit;
    return {
      allowed,
      limit: this.options.limit,
      remaining: Math.max(0, this.options.limit - bucket.count),
      resetAtEpochSeconds: Math.ceil(bucket.resetAt / 1000),
      retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    };
  }

  /**
   * Keeps the map bounded. Expired entries go first because they carry no state;
   * if that is still not enough, the entry closest to expiry is dropped, which is
   * the least costly one to forget.
   */
  private makeRoom(now: number): void {
    if (this.buckets.size < this.options.maxKeys) return;

    for (const [key, bucket] of this.buckets) {
      if (now >= bucket.resetAt) this.buckets.delete(key);
    }

    while (this.buckets.size >= this.options.maxKeys) {
      let oldestKey: string | undefined;
      let oldestReset = Number.POSITIVE_INFINITY;

      for (const [key, bucket] of this.buckets) {
        if (bucket.resetAt < oldestReset) {
          oldestReset = bucket.resetAt;
          oldestKey = key;
        }
      }

      if (oldestKey === undefined) return;
      this.buckets.delete(oldestKey);
    }
  }
}

/**
 * Applies the limiter to the routes it is bound to.
 *
 * The key is `req.ip`. Express derives it from the socket unless `trust proxy` is
 * configured, and `app.factory.ts` refuses `TRUST_PROXY=true`, so by default a
 * caller cannot choose their own address with `X-Forwarded-For`. The header is
 * honoured only for the explicitly configured proxy ranges, which is the operator
 * asserting that those hops overwrite it.
 */
@Injectable()
export class AuthRateLimitGuard implements CanActivate {
  constructor(@Inject(AUTH_RATE_LIMITER) private readonly limiter: FixedWindowRateLimiter) {}

  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const request = http.getRequest<ApiRequest>();
    const response = http.getResponse<Response>();

    const decision = this.limiter.consume(clientKey(request));

    response.setHeader("RateLimit-Limit", String(decision.limit));
    response.setHeader("RateLimit-Remaining", String(decision.remaining));
    response.setHeader("RateLimit-Reset", String(decision.resetAtEpochSeconds));

    if (decision.allowed) return true;

    response.setHeader("Retry-After", String(decision.retryAfterSeconds));
    // The existing bounded code set already carries RATE_LIMITED, so no contract
    // change is needed and no detail about the counter is exposed.
    throw new HttpException({ code: "RATE_LIMITED" }, 429);
  }
}

/**
 * `req.ip` is typed `string | undefined`; a request without a socket address
 * cannot be attributed, so it shares one bucket rather than bypassing the limit.
 */
function clientKey(request: ApiRequest): string {
  return request.ip === undefined || request.ip === "" ? "unknown" : request.ip;
}
