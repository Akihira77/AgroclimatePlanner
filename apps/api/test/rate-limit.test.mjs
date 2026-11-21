import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AUTH_RATE_LIMIT,
  AUTH_RATE_WINDOW_MS,
  AuthRateLimitGuard,
  FixedWindowRateLimiter,
} from "../dist/auth/rate-limit.guard.js";

/** A clock the test moves by hand, so no assertion sleeps. */
function clock(start = 1_700_000_000_000) {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

function limiter(overrides = {}) {
  const time = clock();
  return {
    time,
    instance: new FixedWindowRateLimiter({
      limit: 3,
      windowMs: 60_000,
      maxKeys: 100,
      now: time.now,
      ...overrides,
    }),
  };
}

/** Minimal ExecutionContext for the guard, with a recording response. */
function context(ip, headers = new Map()) {
  const response = {
    headers,
    setHeader(name, value) {
      this.headers.set(name, value);
    },
  };
  return {
    response,
    switchToHttp: () => ({
      getRequest: () => ({ ip }),
      getResponse: () => response,
    }),
  };
}

describe("FixedWindowRateLimiter", () => {
  it("allows exactly the limit and refuses the next request", () => {
    const { instance } = limiter();

    for (let index = 0; index < 3; index += 1) {
      const decision = instance.consume("1.2.3.4");
      assert.equal(decision.allowed, true, `request ${index + 1} should be allowed`);
    }

    const refused = instance.consume("1.2.3.4");
    assert.equal(refused.allowed, false);
    assert.equal(refused.refusal, "quota");
    assert.equal(refused.remaining, 0);
    assert.ok(refused.retryAfterSeconds >= 1);
  });

  it("reports remaining count and the reset instant", () => {
    const { instance } = limiter();
    const first = instance.consume("1.2.3.4");

    assert.equal(first.limit, 3);
    assert.equal(first.remaining, 2);
    assert.equal(first.retryAfterSeconds, 0);
    assert.equal(first.refusal, null);
    assert.ok(first.resetAtEpochSeconds > 0);
  });

  it("starts a new window when the old one expires", () => {
    const { instance, time } = limiter();
    instance.consume("1.2.3.4");
    instance.consume("1.2.3.4");
    instance.consume("1.2.3.4");
    assert.equal(instance.consume("1.2.3.4").allowed, false);

    time.advance(AUTH_RATE_WINDOW_MS);
    const afterReset = instance.consume("1.2.3.4");
    assert.equal(afterReset.allowed, true);
    assert.equal(afterReset.remaining, 2);
  });

  it("keeps separate buckets per client", () => {
    const { instance } = limiter();
    instance.consume("1.1.1.1");
    instance.consume("1.1.1.1");
    instance.consume("1.1.1.1");

    assert.equal(instance.consume("2.2.2.2").allowed, true);
  });

  it("keeps an existing client's counter when the map is full", () => {
    const { instance, time } = limiter({ limit: 2, maxKeys: 2 });
    instance.consume("a");
    instance.consume("b");
    assert.equal(instance.size, 2);

    // `a` already has a bucket: it is served from it, and stays refused on quota
    // rather than being re-admitted as a new client.
    instance.consume("a");
    const third = instance.consume("a");
    assert.equal(third.allowed, false);
    assert.equal(third.refusal, "quota");
    assert.equal(instance.size, 2);

    // The counter is intact: a fresh window is the only thing that resets it.
    time.advance(AUTH_RATE_WINDOW_MS);
    const afterReset = instance.consume("a");
    assert.equal(afterReset.allowed, true);
    assert.equal(afterReset.remaining, 1);
  });

  it("cannot be reset by hammering it while the map is full", () => {
    const { instance } = limiter({ limit: 1, maxKeys: 2 });
    instance.consume("victim");
    instance.consume("other");

    for (let index = 0; index < 50; index += 1) {
      const decision = instance.consume("victim");
      assert.equal(decision.allowed, false);
      assert.equal(decision.refusal, "quota");
    }

    assert.equal(instance.size, 2);
  });

  it("refuses an unseen client instead of evicting an active one", () => {
    const { instance } = limiter({ limit: 1, maxKeys: 2 });
    instance.consume("a");
    instance.consume("b");

    const refused = instance.consume("c");
    assert.equal(refused.allowed, false);
    assert.equal(refused.refusal, "capacity");
    assert.equal(refused.remaining, 0);
    assert.ok(refused.retryAfterSeconds >= 1);
    assert.equal(instance.size, 2);

    // `a` and `b` still own their slots and their counts.
    assert.equal(instance.consume("a").refusal, "quota");
    assert.equal(instance.consume("b").refusal, "quota");
  });

  it("reclaims expired buckets when capacity is needed", () => {
    const { instance, time } = limiter({ limit: 1, maxKeys: 2 });
    instance.consume("a");
    instance.consume("b");
    assert.equal(instance.consume("c").refusal, "capacity");

    time.advance(AUTH_RATE_WINDOW_MS + 1);
    const admitted = instance.consume("c");
    assert.equal(admitted.allowed, true);
    assert.equal(instance.size, 1, "expired buckets should have been swept");
  });

  it("never exceeds maxKeys", () => {
    const { instance } = limiter({ limit: 1, maxKeys: 3 });
    for (let index = 0; index < 100; index += 1) instance.consume(`client-${index}`);
    assert.equal(instance.size, 3);
  });

  it("counts a burst of synchronous calls deterministically", () => {
    const { instance } = limiter({ limit: 10, maxKeys: 100 });
    const decisions = Array.from({ length: 12 }, () => instance.consume("9.9.9.9"));
    assert.equal(decisions.filter((decision) => decision.allowed).length, 10);
  });
});

describe("AuthRateLimitGuard", () => {
  it("sets the documented RateLimit headers on an allowed request", () => {
    const instance = new FixedWindowRateLimiter({ limit: 30, windowMs: 60_000, maxKeys: 10 });
    const guard = new AuthRateLimitGuard(instance);
    const execution = context("1.2.3.4");

    assert.equal(guard.canActivate(execution), true);
    assert.equal(execution.response.headers.get("RateLimit-Limit"), "30");
    assert.equal(execution.response.headers.get("RateLimit-Remaining"), "29");
    assert.ok(execution.response.headers.get("RateLimit-Reset"));
  });

  it("refuses with 429, RATE_LIMITED, and Retry-After once the limit is spent", () => {
    const instance = new FixedWindowRateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 10 });
    const guard = new AuthRateLimitGuard(instance);

    assert.equal(guard.canActivate(context("1.2.3.4")), true);
    const refused = context("1.2.3.4");

    assert.throws(
      () => guard.canActivate(refused),
      (error) => {
        assert.equal(error.getStatus(), 429);
        assert.equal(error.getResponse().code, "RATE_LIMITED");
        return true;
      },
    );
    assert.ok(Number(refused.response.headers.get("Retry-After")) >= 1);
  });

  it("uses the socket address, not X-Forwarded-For, when proxy trust is off", () => {
    const instance = new FixedWindowRateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 10 });
    const guard = new AuthRateLimitGuard(instance);

    // `req.ip` is the socket address because the app never enables trust proxy.
    // Spoofed headers are invisible to the key, so a caller cannot mint a fresh
    // bucket by varying them.
    const first = context("203.0.113.7");
    assert.equal(guard.canActivate(first), true);

    const second = context("203.0.113.7");
    assert.throws(() => guard.canActivate(second));
  });

  it("shares one bucket for requests with no address", () => {
    const instance = new FixedWindowRateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 10 });
    const guard = new AuthRateLimitGuard(instance);

    assert.equal(guard.canActivate(context(undefined)), true);
    assert.throws(() => guard.canActivate(context(undefined)));
  });

  it("refuses a new client at capacity with the same 429 and a Retry-After", () => {
    // Capacity is an overload safeguard, not a quota. The public answer is the
    // same `RATE_LIMITED` the exception filter already maps, because "not now" is
    // the only thing the client can act on.
    const instance = new FixedWindowRateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 1 });
    const guard = new AuthRateLimitGuard(instance);

    assert.equal(guard.canActivate(context("10.0.0.1")), true);

    const refused = context("10.0.0.2");
    assert.throws(
      () => guard.canActivate(refused),
      (error) => {
        assert.equal(error.getStatus(), 429);
        assert.equal(error.getResponse().code, "RATE_LIMITED");
        return true;
      },
    );
    assert.ok(Number(refused.response.headers.get("Retry-After")) >= 1);
    assert.equal(refused.response.headers.get("RateLimit-Remaining"), "0");
    assert.equal(instance.size, 1);
  });
});

describe("approved policy constants", () => {
  it("matches IG-7", () => {
    assert.equal(AUTH_RATE_LIMIT, 30);
    assert.equal(AUTH_RATE_WINDOW_MS, 60_000);
  });
});
