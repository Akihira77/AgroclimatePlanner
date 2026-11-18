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
      () => parse({ NODE_ENV: "production", APP_API_DATABASE_URL: "postgresql://app_api@db/app" }),
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

describe("runtime credential boundary", () => {
  const url = (user, password = "s3cretp4ss") => `postgresql://${user}:${password}@db:5432/app`;

  it("accepts only the app_api role", () => {
    const config = parse({ APP_API_DATABASE_URL: url("app_api") });
    assert.equal(new URL(config.databaseUrl).username, "app_api");
  });

  it("rejects every privileged or unrelated role", () => {
    for (const role of ["migration_owner", "postgres", "app_system", "app_auth", "someone"]) {
      assert.throws(
        () => parse({ APP_API_DATABASE_URL: url(role) }),
        ConfigurationError,
        `${role} must be rejected`,
      );
    }
  });

  it("decodes a percent-encoded username before comparing", () => {
    // `%5F` is `_`. The same role written differently is the same role.
    const config = parse({ APP_API_DATABASE_URL: "postgresql://app%5Fapi:pa%40ss@db:5432/app" });
    assert.equal(new URL(config.databaseUrl).username, "app%5Fapi");
  });

  it("does not echo the password or the connection string when rejecting", () => {
    for (const role of ["migration_owner", "someone"]) {
      try {
        parse({ APP_API_DATABASE_URL: url(role) });
        assert.fail("expected a ConfigurationError");
      } catch (error) {
        assert.ok(error instanceof ConfigurationError);
        assert.equal(error.message.includes("s3cretp4ss"), false, "password leaked");
        assert.equal(error.message.includes("@db:5432"), false, "connection string leaked");
        if (role === "someone") {
          assert.equal(error.message.includes("someone"), false, "arbitrary username echoed");
        }
      }
    }
  });

  it("derives a development url for app_api and never for a privileged role", () => {
    const config = parse({});
    const derived = new URL(config.databaseUrl);
    assert.equal(derived.username, "app_api");
    assert.equal(derived.password, "devsecret");

    // A migration credential lying around does not become the runtime one.
    assert.throws(
      () =>
        parseRuntimeConfig({
          NODE_ENV: "development",
          MIGRATION_DATABASE_URL: "postgresql://migration_owner:x@db:5432/app",
        }),
      ConfigurationError,
    );
  });
});
