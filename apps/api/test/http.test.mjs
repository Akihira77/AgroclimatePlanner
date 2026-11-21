import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { startApp } from "./helpers.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("request id, headers, CORS, cookies, proxy trust", () => {
  let app;
  let base;

  before(async () => {
    ({ app, base } = await startApp());
  });

  after(async () => {
    await app.close();
  });

  it("mints a UUID per request and returns it in the header", async () => {
    const first = await fetch(`${base}/health`);
    const second = await fetch(`${base}/health`);

    const firstId = first.headers.get("x-request-id");
    const secondId = second.headers.get("x-request-id");

    assert.match(firstId ?? "", UUID);
    assert.match(secondId ?? "", UUID);
    assert.notEqual(firstId, secondId);
  });

  it("ignores a caller-supplied request id by default", async () => {
    const supplied = "4f8f0b7a-3a1e-4d4f-9a4b-1c2d3e4f5a6b";
    const response = await fetch(`${base}/health`, {
      headers: { "x-request-id": supplied },
    });

    const returned = response.headers.get("x-request-id");
    assert.match(returned ?? "", UUID);
    assert.notEqual(returned, supplied);
  });

  it("sends baseline security headers", async () => {
    const response = await fetch(`${base}/health`);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-powered-by"), null);
    assert.notEqual(response.headers.get("content-security-policy"), null);
  });

  it("allows credentials for the configured origin only", async () => {
    // The web app is a separate origin (`ADR-006`), so the session cookie is sent
    // only when the preflight grants credentials — and never for a wildcard or an
    // unlisted origin.
    const allowed = await fetch(`${base}/health`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:5173",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,x-csrf-token",
      },
    });

    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers.get("access-control-allow-origin"), "http://localhost:5173");
    assert.equal(allowed.headers.get("access-control-allow-credentials"), "true");
    assert.notEqual(allowed.headers.get("access-control-allow-origin"), "*", "never a wildcard");

    const allowedHeaders = (
      allowed.headers.get("access-control-allow-headers") ?? ""
    ).toLowerCase();
    assert.ok(allowedHeaders.includes("x-csrf-token"), allowedHeaders);

    const exposed = (allowed.headers.get("access-control-expose-headers") ?? "").toLowerCase();
    for (const header of ["x-request-id", "ratelimit-limit", "retry-after"]) {
      assert.ok(exposed.includes(header), `${header} should be readable by the browser`);
    }
  });

  it("allows a configured origin and refuses an unlisted one", async () => {
    const allowed = await fetch(`${base}/health`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:5173",
        "Access-Control-Request-Method": "GET",
      },
    });
    assert.equal(allowed.headers.get("access-control-allow-origin"), "http://localhost:5173");

    const refused = await fetch(`${base}/health`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil.example",
        "Access-Control-Request-Method": "GET",
      },
    });
    assert.equal(refused.headers.get("access-control-allow-origin"), null);
  });

  it("parses cookies onto the request", async () => {
    const response = await fetch(`${base}/__probe/cookies`, {
      headers: { Cookie: "session=abc123; theme=dark" },
    });

    assert.deepEqual(await response.json(), {
      cookies: { session: "abc123", theme: "dark" },
    });
  });

  it("does not trust forwarded headers unless configured", async () => {
    const response = await fetch(`${base}/__probe/ip`, {
      headers: { "x-forwarded-for": "203.0.113.9" },
    });

    const body = await response.json();
    assert.notEqual(body.ip, "203.0.113.9");
  });

  it("trusts forwarded headers from a declared loopback proxy", async () => {
    const trusted = await startApp({ config: { trustProxy: ["loopback"] } });
    try {
      const response = await fetch(`${trusted.base}/__probe/ip`, {
        headers: { "x-forwarded-for": "203.0.113.9" },
      });

      const body = await response.json();
      assert.equal(body.ip, "203.0.113.9");
    } finally {
      await trusted.app.close();
    }
  });

  it("accepts an upstream request id only when explicitly told to", async () => {
    const trusted = await startApp({ config: { trustRequestIdHeader: true } });
    try {
      const supplied = "4f8f0b7a-3a1e-4d4f-9a4b-1c2d3e4f5a6b";
      const response = await fetch(`${trusted.base}/health`, {
        headers: { "x-request-id": supplied },
      });
      assert.equal(response.headers.get("x-request-id"), supplied);
    } finally {
      await trusted.app.close();
    }
  });
});
