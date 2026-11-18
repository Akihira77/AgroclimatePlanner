import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ConfigurationError, parseRuntimeConfig } from "../dist/config/runtime-config.js";

const MINIMUM = { APP_API_PASSWORD: "devsecret" };

function parse(overrides) {
  return parseRuntimeConfig({ NODE_ENV: "development", ...MINIMUM, ...overrides });
}

describe("runtime configuration", () => {
  it("derives a development url for the app_api role", () => {
    const config = parse({});
    const url = new URL(config.databaseUrl);

    assert.equal(url.username, "app_api");
    assert.equal(url.port, "5442");
    assert.equal(url.pathname, "/agroclimate");
    assert.equal(url.searchParams.get("schema"), "app");
  });

  it("never falls back to a migration credential", () => {
    assert.throws(
      () =>
        parseRuntimeConfig({
          NODE_ENV: "production",
          MIGRATION_DATABASE_URL: "postgresql://migration_owner:x@db/app",
        }),
      ConfigurationError,
    );
  });

  it("prefers an explicit runtime url and requires one in production", () => {
    const explicit = parse({ APP_API_DATABASE_URL: "postgresql://app_api:x@db:5432/app" });
    assert.equal(explicit.databaseUrl, "postgresql://app_api:x@db:5432/app");

    assert.throws(() => parse({ NODE_ENV: "production" }), ConfigurationError);
    assert.throws(
      () => parse({ NODE_ENV: "production", APP_API_DATABASE_URL: "mysql://x" }),
      ConfigurationError,
    );
  });

  it("refuses to guess a database password", () => {
    assert.throws(() => parse({ APP_API_PASSWORD: "" }), ConfigurationError);
  });

  it("validates the port", () => {
    assert.equal(parse({ PORT: "8080" }).port, 8080);
    assert.throws(() => parse({ PORT: "0" }), ConfigurationError);
    assert.throws(() => parse({ PORT: "http" }), ConfigurationError);
  });

  it("defaults cors to the development origin and requires an allowlist in production", () => {
    assert.deepEqual(parse({}).corsOrigins, ["http://localhost:5173"]);
    assert.throws(
      () => parse({ NODE_ENV: "production", APP_API_DATABASE_URL: "postgresql://a@b/c" }),
      ConfigurationError,
    );

    const listed = parse({ CORS_ORIGINS: "https://app.example, https://admin.example" });
    assert.deepEqual(listed.corsOrigins, ["https://app.example", "https://admin.example"]);
  });

  it("rejects a wildcard or malformed origin", () => {
    assert.throws(() => parse({ CORS_ORIGINS: "*" }), ConfigurationError);
    assert.throws(() => parse({ CORS_ORIGINS: "https://app.example/path" }), ConfigurationError);
    assert.throws(() => parse({ CORS_ORIGINS: "app.example" }), ConfigurationError);
  });

  it("refuses trust proxy true and accepts explicit proxies", () => {
    assert.equal(parse({}).trustProxy, false);
    assert.deepEqual(parse({ TRUST_PROXY: "loopback" }).trustProxy, ["loopback"]);
    assert.deepEqual(parse({ TRUST_PROXY: "loopback,10.0.0.0/8" }).trustProxy, [
      "loopback",
      "10.0.0.0/8",
    ]);

    assert.throws(() => parse({ TRUST_PROXY: "true" }), ConfigurationError);
    assert.throws(() => parse({ TRUST_PROXY: "internet" }), ConfigurationError);
  });

  it("treats request-id trust as opt-in and rejects a non-boolean", () => {
    assert.equal(parse({}).trustRequestIdHeader, false);
    assert.equal(parse({ TRUST_REQUEST_ID_HEADER: "true" }).trustRequestIdHeader, true);
    assert.throws(() => parse({ TRUST_REQUEST_ID_HEADER: "yes" }), ConfigurationError);
  });

  it("rejects an unknown NODE_ENV", () => {
    assert.throws(() => parse({ NODE_ENV: "staging" }), ConfigurationError);
  });
});
