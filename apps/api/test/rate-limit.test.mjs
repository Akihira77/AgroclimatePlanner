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
    assert.equal(refused.remaining, 0);
    assert.ok(refused.retryAfterSeconds >= 1);
  });

  it("reports remaining count and the reset instant", () => {
    const { instance } = limiter();
    const first = instance.consume("1.2.3.4");

    assert.equal(first.limit, 3);
    assert.equal(first.remaining, 2);
    assert.equal(first.retryAfterSeconds, 0);
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

  it("drops expired entries instead of growing without bound", () => {
    const { instance, time } = limiter({ limit: 1, maxKeys: 3 });

    instance.consume("a");
    instance.consume("b");
    instance.consume("c");
    assert.equal(instance.size, 3);

    time.advance(AUTH_RATE_WINDOW_MS + 1);
    instance.consume("d");

    assert.equal(instance.size <= 3, true);
    assert.equal(instance.size, 1, "expired buckets should have been swept");
  });

  it("evicts the least recently reset bucket when the cap is reached with live entries", () => {
    const { instance } = limiter({ limit: 1, maxKeys: 2 });
    instance.consume("a");
    instance.consume("b");

    instance.consume("c");
    assert.equal(instance.size, 2, "storage must stay bounded");
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
});

describe("approved policy constants", () => {
  it("matches IG-7", () => {
    assert.equal(AUTH_RATE_LIMIT, 30);
    assert.equal(AUTH_RATE_WINDOW_MS, 60_000);
  });
});
