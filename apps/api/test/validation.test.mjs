import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BadRequestException } from "@nestjs/common";
import { errorResponseSchema, validationDetailsSchema } from "@agroclimate/contracts";
import { z } from "zod";

import { ApiExceptionFilter } from "../dist/http/api-exception.filter.js";
import { ValidationFailedException } from "../dist/http/validation-failed.exception.js";
import { toIssues, ZodValidationPipe } from "../dist/http/zod-validation.pipe.js";
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

    const exception = new ValidationFailedException(details);
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

describe("validation path safety", () => {
  it("does not reflect a property name that is not a plain identifier", () => {
    const schema = z.strictObject({ name: z.string() });
    const details = issuesFrom(schema, { name: "x", "password=super-secret-value": 1 });
    const serialised = JSON.stringify(details);

    // Neither the secret-looking value nor the field name it was smuggled under
    // appears: the name is the caller's text, and echoing it is the disclosure.
    assert.equal(serialised.includes("super-secret-value"), false);
    assert.equal(serialised.includes("password"), false);
    assert.deepEqual(details, [{ path: "[…1]", issue: "unrecognized_keys" }]);
  });

  it("keeps the path unambiguous when a name carries dots or brackets", () => {
    const schema = z.strictObject({ filters: z.strictObject({ crop: z.string() }) });
    const details = issuesFrom(schema, {
      filters: { crop: "padi", "a.b[0]": 1, "c]d": 2 },
    });

    // `filters.a.b[0]` would be indistinguishable from real nesting.
    assert.deepEqual(details, [
      { path: "filters[…1]", issue: "unrecognized_keys" },
      { path: "filters[…2]", issue: "unrecognized_keys" },
    ]);
  });

  it("strips newlines and control characters from a reflected name", () => {
    const schema = z.strictObject({ name: z.string() });
    const details = issuesFrom(schema, { name: "x", "a\nb\u0000c": 1 });
    const serialised = JSON.stringify(details);

    assert.equal(serialised.includes("\\n"), false);
    assert.equal(serialised.includes("0000"), false);
    assert.deepEqual(details, [{ path: "[…1]", issue: "unrecognized_keys" }]);
  });

  it("bounds the length of a name and of the whole path", () => {
    const schema = z.strictObject({ name: z.string() });
    const longName = "x".repeat(500);

    const [unknown] = issuesFrom(schema, { name: "x", [longName]: 1 });
    assert.equal(unknown.path, "[…1]");

    // A legitimately nested path is cut at a segment boundary, never mid-token: a
    // half-written segment is not a path the contract could accept.
    const nested = toIssues([
      { code: "invalid_type", path: Array.from({ length: 40 }, () => "abcdefghij"), message: "m" },
    ]);
    assert.equal(nested[0].path.length, 200);
    assert.equal(nested[0].path.endsWith("[…]"), true);
  });

  it("reflects ordinary identifiers, including unicode letters, verbatim", () => {
    const schema = z.strictObject({
      nama_petak: z.string(),
      luas: z.string(),
    });
    const parsed = new ZodValidationPipe(schema).transform(
      { nama_petak: "x", luas: "1" },
      metadata,
    );
    assert.deepEqual(parsed, { nama_petak: "x", luas: "1" });

    const unicode = issuesFrom(z.strictObject({ kebun: z.strictObject({ luas: z.number() }) }), {
      kebun: { luas: "3" },
    });
    assert.deepEqual(unicode, [{ path: "kebun.luas", issue: "invalid_type" }]);

    // `é` is a letter, so that name stays readable instead of being replaced.
    assert.deepEqual(issuesFrom(z.strictObject({ é: z.number() }), { é: "3" }), [
      { path: "é", issue: "invalid_type" },
    ]);
  });

  it("orders issues by code unit, not by locale, and is repeatable", () => {
    const schema = z.strictObject({ name: z.string() });
    const value = { name: "x", a: 1, B: 2 };

    // Code-unit order puts `B` before `a`; a locale collator puts `a` first.
    assert.deepEqual(issuesFrom(schema, value), [
      { path: "B", issue: "unrecognized_keys" },
      { path: "a", issue: "unrecognized_keys" },
    ]);

    for (let run = 0; run < 5; run += 1) {
      assert.deepEqual(issuesFrom(schema, value), issuesFrom(schema, value));
    }
  });

  it("emits paths the shared contract accepts, including its truncation marker", () => {
    const schema = z.strictObject({
      name: z.string(),
      filters: z.strictObject({ crop: z.string() }),
      items: z.array(z.strictObject({ id: z.uuid() })),
    });

    const outputs = [
      issuesFrom(schema, undefined),
      issuesFrom(schema, { name: 1, filters: { crop: 2 }, items: [{ id: "x" }] }),
      issuesFrom(schema, { name: "x", filters: { crop: "p", "a.b": 1 }, "weird key": 2 }),
      toIssues([
        {
          code: "invalid_type",
          path: Array.from({ length: 40 }, () => "abcdefghij"),
          message: "m",
        },
      ]),
    ];

    for (const details of outputs) {
      assert.equal(
        validationDetailsSchema.safeParse(details).success,
        true,
        JSON.stringify(details),
      );
    }
  });

  it("breaks a tie on the same path with the issue code", () => {
    const mapped = toIssues([
      { code: "custom", path: ["b"], message: "m" },
      { code: "invalid_type", path: ["b"], message: "m" },
      { code: "invalid_type", path: ["a"], message: "m" },
    ]);

    assert.deepEqual(mapped, [
      { path: "a", issue: "invalid_type" },
      { path: "b", issue: "custom" },
      { path: "b", issue: "invalid_type" },
    ]);
  });
});

describe("producer and contract agree on numeric segments", () => {
  const rendered = (path) => toIssues([{ code: "invalid_type", path, message: "m" }]);

  it("renders canonical indexes as array indexes", () => {
    assert.equal(rendered([0])[0].path, "[0]");
    assert.equal(rendered([1])[0].path, "[1]");
    assert.equal(rendered([12])[0].path, "[12]");
    assert.equal(rendered([0, 1])[0].path, "[0][1]");
    assert.equal(rendered(["items", 0, "id"])[0].path, "items[0].id");
  });

  it("never interpolates a number the contract would refuse", () => {
    // `toIssues` is exported, so the segment is not necessarily one Zod produced.
    const cases = [
      [-1, "[…1]"],
      [1.5, "[…1]"],
      [Number.NaN, "[…1]"],
      [Number.POSITIVE_INFINITY, "[…1]"],
      [Number.NEGATIVE_INFINITY, "[…1]"],
      [1_000_000_000_000, "[…1]"],
    ];

    for (const [segment, expected] of cases) {
      const details = rendered([segment]);

      assert.equal(details[0].path, expected, String(segment));
      assert.equal(details[0].path.includes(String(segment)), false, `leaked ${segment}`);
      assert.equal(validationDetailsSchema.safeParse(details).success, true);
    }
  });

  it("keeps mixed and adjacent segments renderable", () => {
    assert.equal(rendered(["a", -1, "b"])[0].path, "a[…1].b");
    assert.equal(rendered([-1, 0, Number.NaN])[0].path, "[…1][0][…2]");
    assert.equal(validationDetailsSchema.safeParse(rendered([-1, 0, Number.NaN])).success, true);
  });

  it("still truncates at a token boundary once a path outgrows the limit", () => {
    const long = rendered(Array.from({ length: 40 }, () => "abcdefghij"));
    assert.equal(long[0].path.length, 200);
    assert.equal(long[0].path.endsWith("[…]"), true);
    assert.equal(validationDetailsSchema.safeParse(long).success, true);
  });
});
