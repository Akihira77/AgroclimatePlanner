import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BadRequestException } from "@nestjs/common";
import { errorResponseSchema } from "@agroclimate/contracts";
import { z } from "zod";

import { ApiExceptionFilter } from "../dist/http/api-exception.filter.js";
import { ZodValidationPipe } from "../dist/http/zod-validation.pipe.js";
import { testConfig } from "./helpers.mjs";

const metadata = { type: "query" };

/** Runs a schema through the pipe the way Nest would, returning `details` on failure. */
function issuesFrom(schema, value) {
  try {
    new ZodValidationPipe(schema).transform(value, metadata);
  } catch (error) {
    assert.ok(error instanceof BadRequestException, "a validation failure must be a 400");
    assert.equal(error.getStatus(), 400);
    const body = error.getResponse();
    return body.details;
  }
  assert.fail("expected the schema to reject the value");
}

describe("Zod request validation", () => {
  it("passes valid input and returns the parsed value", () => {
    const schema = z.strictObject({ fieldId: z.uuid(), limit: z.coerce.number().int() });
    const id = "0b1f5e2a-9d3c-4a5b-8c7d-6e5f4a3b2c1d";

    const parsed = new ZodValidationPipe(schema).transform({ fieldId: id, limit: "25" }, metadata);

    assert.deepEqual(parsed, { fieldId: id, limit: 25 });
    assert.equal(typeof parsed.limit, "number");
  });

  it("returns the schema's transformed output, not the raw input", () => {
    const schema = z
      .strictObject({ from: z.iso.date() })
      .transform((value) => ({ ...value, parsed: new Date(value.from) }));

    const parsed = new ZodValidationPipe(schema).transform({ from: "2026-11-18" }, metadata);

    assert.deepEqual(parsed.parsed.toISOString(), "2026-11-18T00:00:00.000Z");
  });

  it("rejects unknown properties instead of stripping them", () => {
    const schema = z.strictObject({ name: z.string() });
    const details = issuesFrom(schema, { name: "irigasi", isAdmin: "true" });

    assert.deepEqual(details, [{ path: "isAdmin", issue: "unrecognized_keys" }]);
  });

  it("reports every unknown property, sorted", () => {
    const schema = z.strictObject({ name: z.string() });
    const details = issuesFrom(schema, { name: "x", zebra: 1, alpha: 2 });

    assert.deepEqual(details, [
      { path: "alpha", issue: "unrecognized_keys" },
      { path: "zebra", issue: "unrecognized_keys" },
    ]);
  });

  it("converts only where the schema asks it to", () => {
    const coercing = z.strictObject({ limit: z.coerce.number().int() });
    assert.deepEqual(new ZodValidationPipe(coercing).transform({ limit: "3" }, metadata), {
      limit: 3,
    });

    // The same input against a plain number rule stays a string and fails.
    const strict = z.strictObject({ limit: z.number().int() });
    assert.deepEqual(issuesFrom(strict, { limit: "3" }), [
      { path: "limit", issue: "invalid_type" },
    ]);
  });

  it("validates nested objects and reports the nested path", () => {
    const schema = z.strictObject({
      filters: z.strictObject({ crop: z.string(), season: z.string() }),
    });

    assert.deepEqual(issuesFrom(schema, { filters: { crop: "padi", season: "hujan", extra: 1 } }), [
      { path: "filters.extra", issue: "unrecognized_keys" },
    ]);

    assert.deepEqual(issuesFrom(schema, { filters: { crop: 7 } }), [
      { path: "filters.crop", issue: "invalid_type" },
      { path: "filters.season", issue: "invalid_type" },
    ]);
  });

  it("rejects an invalid array element and indexes its path", () => {
    const schema = z.strictObject({
      items: z.array(z.strictObject({ id: z.uuid() })),
    });
    const id = "0b1f5e2a-9d3c-4a5b-8c7d-6e5f4a3b2c1d";

    const details = issuesFrom(schema, { items: [{ id }, { id: "not-a-uuid" }] });
    assert.deepEqual(details, [{ path: "items[1].id", issue: "invalid_format" }]);
  });

  it("returns paths and issue codes only", () => {
    const schema = z.strictObject({ limit: z.number().int().positive() });
    const details = issuesFrom(schema, { limit: -5 });

    assert.deepEqual(details, [{ path: "limit", issue: "too_small" }]);
    for (const entry of details) {
      assert.deepEqual(Object.keys(entry).sort(), ["issue", "path"]);
    }
  });

  it("never puts a submitted value in the details", () => {
    const schema = z.strictObject({
      password: z.string().min(12),
      apiKey: z.string().optional(),
    });

    const details = issuesFrom(schema, { password: "short-pw", apiKey: 42, smuggled: "hunter2" });
    const serialised = JSON.stringify(details);

    for (const value of ["short-pw", "hunter2", "42"]) {
      assert.equal(serialised.includes(value), false, `leaked ${value}`);
    }
  });

  it("handles empty and malformed input at the root path", () => {
    const schema = z.strictObject({ fieldId: z.uuid() });

    assert.deepEqual(issuesFrom(schema, undefined), [{ path: "(root)", issue: "invalid_type" }]);
    assert.deepEqual(issuesFrom(schema, "nope"), [{ path: "(root)", issue: "invalid_type" }]);
    assert.deepEqual(issuesFrom(schema, {}), [{ path: "fieldId", issue: "invalid_type" }]);
  });

  it("keeps the details usable through the exception filter", () => {
    const schema = z.strictObject({ fieldId: z.uuid() });
    const details = issuesFrom(schema, { fieldId: "nope" });

    const response = {
      statusCode: undefined,
      body: undefined,
      headers: {},
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        this.body = body;
        return this;
      },
      setHeader(name, value) {
        this.headers[name.toLowerCase()] = value;
      },
    };

    const exception = new BadRequestException({ details });
    new ApiExceptionFilter(testConfig(), { error: () => {} }).catch(exception, {
      switchToHttp: () => ({
        getRequest: () => ({ requestId: "0b1f5e2a-9d3c-4a5b-8c7d-6e5f4a3b2c1d" }),
        getResponse: () => response,
      }),
    });

    assert.equal(response.statusCode, 400);
    assert.equal(errorResponseSchema.safeParse(response.body).success, true);
    assert.equal(response.body.error.code, "VALIDATION_FAILED");
    assert.deepEqual(response.body.error.details, details);
  });
});
