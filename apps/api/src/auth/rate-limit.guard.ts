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
export const MAX_TRACKED_CLIENTS = 10_000;

export interface FixedWindowOptions {
  readonly limit: number;
  readonly windowMs: number;
  readonly maxKeys: number;
  /** Injected so tests control time instead of sleeping. */
  readonly now?: () => number;
}

/** Why a request was refused. Not serialised; the client sees `RATE_LIMITED` either way. */
export type RefusalReason = "quota" | "capacity";

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly limit: number;
  /** Requests still available in the current window, never negative. */
  readonly remaining: number;
  readonly resetAtEpochSeconds: number;
  /** `0` when allowed; at least `1` when refused, because `Retry-After: 0` reads as retry now. */
  readonly retryAfterSeconds: number;
  /** `null` when allowed. */
  readonly refusal: RefusalReason | null;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * A fixed window per key. Fixed rather than sliding because the approved policy is
 * a count per minute, and a sliding window would need per-request timestamps in
 * memory for no security gain at this volume.
 *
 * `consume` is synchronous and therefore atomic with respect to other requests in
 * the same process: Node runs it to completion before yielding, so two concurrent
 * requests cannot both read the same count.
 *
 * **Capacity is an overload safeguard, not a quota.** Two behaviours are separate
 * on purpose:
 *
 * - A key that already has a bucket is always served from it. Its counter is
 *   incremented, and its refusal is the ordinary `quota` refusal.
 * - A key with no bucket is admitted only if a slot is free after expired buckets
 *   are swept. When the map is full of live entries, an unseen key is refused with
 *   `capacity` — fail closed, because the alternative is evicting somebody's live
 *   counter.
 *
 * The earlier version called `makeRoom` first and evicted the entry closest to
 * expiry, which could drop the requesting client's own bucket (resetting its
 * counter) or another client's, letting an attacker buy fresh quota by flooding
 * distinct addresses. Evicting nothing is the only behaviour that cannot reset a
 * counter.
 */
export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly now: () => number;

  constructor(private readonly options: FixedWindowOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Visible for tests: the tracked client count. */
  get size(): number {
    return this.buckets.size;
  }

  consume(key: string): RateLimitDecision {
    const now = this.now();
    const existing = this.buckets.get(key);

    if (existing !== undefined) {
      if (now >= existing.resetAt) {
        // The window closed: this client starts a fresh one, and no capacity is
        // needed because the slot was already theirs.
        existing.count = 1;
        existing.resetAt = now + this.options.windowMs;
        return this.decision(existing, now, true);
      }

      existing.count += 1;
      return this.decision(existing, now, existing.count <= this.options.limit);
    }

    this.sweepExpired(now);

    if (this.buckets.size >= this.options.maxKeys) {
      return this.capacityRefusal(now);
    }

    const bucket: Bucket = { count: 1, resetAt: now + this.options.windowMs };
    this.buckets.set(key, bucket);
    return this.decision(bucket, now, true);
  }

  private decision(bucket: Bucket, now: number, allowed: boolean): RateLimitDecision {
    return {
      allowed,
      limit: this.options.limit,
      remaining: Math.max(0, this.options.limit - bucket.count),
      resetAtEpochSeconds: Math.ceil(bucket.resetAt / 1000),
      retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
      refusal: allowed ? null : "quota",
    };
  }

  /**
   * When the map is full of live buckets, no capacity is granted. `Retry-After`
   * points at the soonest moment any slot frees — the earliest reset among the
   * tracked buckets — so the client is told something true rather than a guess.
   */
  private capacityRefusal(now: number): RateLimitDecision {
    let earliestReset = Number.POSITIVE_INFINITY;
    for (const bucket of this.buckets.values()) {
      if (bucket.resetAt < earliestReset) earliestReset = bucket.resetAt;
    }

    return {
      allowed: false,
      limit: this.options.limit,
      remaining: 0,
      resetAtEpochSeconds: Number.isFinite(earliestReset)
        ? Math.ceil(earliestReset / 1000)
        : Math.ceil((now + this.options.windowMs) / 1000),
      retryAfterSeconds: Number.isFinite(earliestReset)
        ? Math.max(1, Math.ceil((earliestReset - now) / 1000))
        : Math.ceil(this.options.windowMs / 1000),
      refusal: "capacity",
    };
  }

  /**
   * Expired buckets carry no state, so reclaiming them is free. Live ones are never
   * removed: a full map refuses new clients instead.
   */
  private sweepExpired(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (now >= bucket.resetAt) this.buckets.delete(key);
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
 *
 * A capacity refusal is reported exactly like a quota refusal — `429`,
 * `RATE_LIMITED`, `Retry-After` — because both mean "not now". The `RateLimit-*`
 * headers stay honest in both cases; nothing about the difference helps a client.
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
