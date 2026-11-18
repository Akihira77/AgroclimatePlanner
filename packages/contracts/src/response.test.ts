import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  envelopeSchema,
  errorCodeSchema,
  errorResponseSchema,
  isCanonicalArrayIndex,
  MAX_VALIDATION_ISSUES,
  MAX_VALIDATION_PATH_LENGTH,
  notFoundErrorCodeSchema,
  requestIdSchema,
  singletonErrorCodeSchema,
  validationDetailsSchema,
  validationIssueSchema,
} from "./response.js";

const validRequestId = "018f5b7e-6f3a-7c2b-9d1e-4a5b6c7d8e9f";

const pageMetaSchema = z.strictObject({ page: z.number().int().positive() });

describe("envelopeSchema", () => {
  it("accepts a payload without meta", () => {
    const schema = envelopeSchema(z.strictObject({ id: z.string() }));
    expect(schema.parse({ data: { id: "a" } })).toEqual({ data: { id: "a" } });
  });

  it("accepts a payload with meta", () => {
    const schema = envelopeSchema(z.array(z.string()), pageMetaSchema);
    const parsed = schema.parse({ data: ["x"], meta: { page: 2 } });
    expect(parsed).toEqual({ data: ["x"], meta: { page: 2 } });
  });

  it("rejects a response with no data, even when meta is present", () => {
    const schema = envelopeSchema(z.string(), pageMetaSchema);
    expect(schema.safeParse({ meta: { page: 1 } }).success).toBe(false);
  });

  it("rejects meta that does not match its schema", () => {
    const schema = envelopeSchema(z.string(), pageMetaSchema);
    expect(schema.safeParse({ data: "x", meta: { page: "first" } }).success).toBe(false);
  });

  it("rejects meta when the envelope declares none", () => {
    const schema = envelopeSchema(z.string());
    expect(schema.safeParse({ data: "x", meta: { page: 1 } }).success).toBe(false);
  });

  it("rejects an unknown top-level key instead of stripping it silently", () => {
    const schema = envelopeSchema(z.string());
    expect(schema.safeParse({ data: "x", errors: [] }).success).toBe(false);
  });
});

describe("errorResponseSchema", () => {
  it("accepts a minimal error", () => {
    const parsed = errorResponseSchema.parse({
      error: { code: "UNAUTHENTICATED", message: "Sesi tidak valid.", requestId: validRequestId },
    });
    expect(parsed.error.code).toBe("UNAUTHENTICATED");
    expect(parsed.error.details).toBeUndefined();
  });

  it("accepts details of a code-specific shape", () => {
    const parsed = errorResponseSchema.parse({
      error: {
        code: "VALIDATION_FAILED",
        message: "Permintaan tidak valid.",
        details: [{ path: "email", issue: "invalid_format" }],
        requestId: validRequestId,
      },
    });
    expect(parsed.error.details).toEqual([{ path: "email", issue: "invalid_format" }]);
  });

  it("rejects an error with no code", () => {
    expect(
      errorResponseSchema.safeParse({
        error: { message: "x", requestId: validRequestId },
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown code", () => {
    expect(
      errorResponseSchema.safeParse({
        error: { code: "SOMETHING_ELSE", message: "x", requestId: validRequestId },
      }).success,
    ).toBe(false);
  });

  it("rejects an empty message", () => {
    expect(
      errorResponseSchema.safeParse({
        error: { code: "FORBIDDEN", message: "", requestId: validRequestId },
      }).success,
    ).toBe(false);
  });

  it("rejects an error with no requestId", () => {
    expect(
      errorResponseSchema.safeParse({ error: { code: "FORBIDDEN", message: "x" } }).success,
    ).toBe(false);
  });

  it("rejects a requestId that is not a UUID", () => {
    expect(
      errorResponseSchema.safeParse({
        error: { code: "FORBIDDEN", message: "x", requestId: "01J8Z9K3M4" },
      }).success,
    ).toBe(false);
  });

  it("rejects a response that carries data alongside an error", () => {
    expect(
      errorResponseSchema.safeParse({
        data: null,
        error: { code: "FORBIDDEN", message: "x", requestId: validRequestId },
      }).success,
    ).toBe(false);
  });
});

describe("errorCodeSchema", () => {
  it("accepts every documented singleton code", () => {
    const documented = [
      "VALIDATION_FAILED",
      "UNAUTHENTICATED",
      "FORBIDDEN",
      "CONFLICT",
      "INSUFFICIENT_DATA",
      "RATE_LIMITED",
      "PROVIDER_UNAVAILABLE",
      "DEPENDENCY_UNAVAILABLE",
      "INTERNAL_ERROR",
    ];

    for (const code of documented)
      expect(singletonErrorCodeSchema.safeParse(code).success).toBe(true);
  });

  it("accepts DEPENDENCY_UNAVAILABLE", () => {
    expect(errorCodeSchema.parse("DEPENDENCY_UNAVAILABLE")).toBe("DEPENDENCY_UNAVAILABLE");
  });

  it("keeps PROVIDER_UNAVAILABLE distinct and available", () => {
    expect(errorCodeSchema.parse("PROVIDER_UNAVAILABLE")).toBe("PROVIDER_UNAVAILABLE");
    expect(errorCodeSchema.safeParse("DEPENDENCY_UNAVAILABLE").success).toBe(true);
    expect(
      singletonErrorCodeSchema.safeParse("PROVIDER_UNAVAILABLE").success &&
        singletonErrorCodeSchema.safeParse("DEPENDENCY_UNAVAILABLE").success,
    ).toBe(true);
  });

  it("accepts the documented not-found family", () => {
    for (const code of ["FIELD_NOT_FOUND", "FARM_NOT_FOUND", "PLANTING_NOT_FOUND"]) {
      expect(errorCodeSchema.safeParse(code).success).toBe(true);
    }
  });

  it("rejects a code outside the closed set and outside the family", () => {
    for (const code of ["BANANA", "NOT_FOUND", "field_not_found", "FIELD_NOTFOUND"]) {
      expect(errorCodeSchema.safeParse(code).success).toBe(false);
    }
  });

  it("rejects a lowercase or malformed not-found code", () => {
    expect(notFoundErrorCodeSchema.safeParse("field_NOT_FOUND").success).toBe(false);
    expect(notFoundErrorCodeSchema.safeParse("_NOT_FOUND").success).toBe(false);
  });
});

describe("requestIdSchema", () => {
  it("accepts a UUID", () => {
    expect(requestIdSchema.parse(validRequestId)).toBe(validRequestId);
  });

  it("rejects a ULID, so the contract has one id family", () => {
    expect(requestIdSchema.safeParse("01J8Z9K3M4N5P6Q7R8S9T0V1W2").success).toBe(false);
  });

  it("rejects an empty or free-form string", () => {
    expect(requestIdSchema.safeParse("").success).toBe(false);
    expect(requestIdSchema.safeParse("req-1").success).toBe(false);
  });
});

describe("validationDetailsSchema", () => {
  it("accepts the shape the pipe produces", () => {
    expect(
      validationDetailsSchema.parse([{ path: "items[1].id", issue: "invalid_format" }]),
    ).toEqual([{ path: "items[1].id", issue: "invalid_format" }]);
  });

  it("accepts every form the encoded grammar allows", () => {
    const valid = [
      "(root)",
      "fieldName",
      "kebun.luas",
      "items[0].id",
      "items[12]",
      "[0]",
      "filters[…1]",
      "filters[…2].crop",
      "a[…1].b[3].c",
      "é",
      "kebun_é.luas2",
      "a[…]",
      "[…]",
    ];

    for (const path of valid) {
      const result = validationIssueSchema.safeParse({ path, issue: "invalid_type" });
      expect(result.success, JSON.stringify(path)).toBe(true);
    }
  });

  it("allows adjacent bracket tokens, which the producer emits for nested arrays", () => {
    for (const path of ["items[0][1]", "a[…1][2]", "[0][1]", "items[0][1].id", "[0][1][2]"]) {
      const result = validationIssueSchema.safeParse({ path, issue: "invalid_type" });
      expect(result.success, JSON.stringify(path)).toBe(true);
    }
  });

  it("does not let a dot introduce a bracket token", () => {
    // A dot separates two identifiers. `a.[0]` would claim the array index is a
    // member name, which the producer never emits and the reader cannot interpret.
    for (const path of ["[0].", "[0]..a", "a.[0]", "a.[…1]", "items[0].", "items[0]..id"]) {
      const result = validationIssueSchema.safeParse({ path, issue: "invalid_type" });
      expect(result.success, JSON.stringify(path)).toBe(false);
    }
  });

  it("accepts a path at the length limit and rejects one past it", () => {
    const atLimit = Array.from({ length: 67 }, () => "ab").join(".");
    expect(atLimit).toHaveLength(MAX_VALIDATION_PATH_LENGTH);
    expect(validationIssueSchema.safeParse({ path: atLimit, issue: "invalid_type" }).success).toBe(
      true,
    );

    const pastLimit = Array.from({ length: 68 }, () => "ab").join(".");
    expect(
      validationIssueSchema.safeParse({ path: pastLimit, issue: "invalid_type" }).success,
    ).toBe(false);
  });

  it("rejects a path that is not the encoded grammar", () => {
    const invalid = [
      // Free text a caller might mistake for a field name.
      "password=hunter2",
      "apiKey=secret-value",
      "field name",
      "a+b",
      "a,b",
      "a;b",
      // Characters that would break a log line or a parser.
      "field\nname",
      "field\rname",
      "field\u0000name",
      "field\u001Bname",
      "field\u202Ename",
      // Structural ambiguity.
      "a..b",
      ".leading",
      "a.",
      "..",
      "a[…]b",
      "a[…1]b",
      "items[007].id",
      "items[-1]",
      "items[]",
      "items[a]",
      "items[0",
      "[0]x",
      "(root)x",
      "a(root)",
      "a b",
      "",
    ];

    for (const path of invalid) {
      const result = validationIssueSchema.safeParse({ path, issue: "invalid_type" });
      expect(result.success, JSON.stringify(path)).toBe(false);
    }
  });

  it("rejects a value smuggled alongside the diagnosis", () => {
    // A strict object is the point: `input` is where the submitted value would go.
    expect(
      validationIssueSchema.safeParse({ path: "email", issue: "invalid_format", input: "a@b.c" })
        .success,
    ).toBe(false);
  });

  it("rejects an unbounded path or issue", () => {
    expect(
      validationIssueSchema.safeParse({
        path: "x".repeat(MAX_VALIDATION_PATH_LENGTH + 1),
        issue: "invalid_type",
      }).success,
    ).toBe(false);
    expect(validationIssueSchema.safeParse({ path: "a", issue: "x".repeat(200) }).success).toBe(
      false,
    );
  });

  it("rejects an issue code that is free text", () => {
    expect(
      validationIssueSchema.safeParse({ path: "a", issue: "bad thing: hunter2" }).success,
    ).toBe(false);
  });

  it("rejects more entries than the cap", () => {
    const tooMany = Array.from({ length: MAX_VALIDATION_ISSUES + 1 }, () => ({
      path: "a",
      issue: "invalid_type",
    }));
    expect(validationDetailsSchema.safeParse(tooMany).success).toBe(false);
  });
});

describe("isCanonicalArrayIndex", () => {
  it("accepts the indexes the grammar can spell", () => {
    for (const value of [0, 1, 12, 1234567890, 9_999_999_999]) {
      expect(isCanonicalArrayIndex(value), String(value)).toBe(true);
    }
  });

  it("rejects numbers that would render outside the grammar", () => {
    for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(isCanonicalArrayIndex(value), String(value)).toBe(false);
    }
  });

  it("rejects a value past the ten-digit limit, before `String()` turns it into an exponent", () => {
    expect(isCanonicalArrayIndex(10_000_000_000)).toBe(false);
    expect(isCanonicalArrayIndex(1e21)).toBe(false);
    expect(String(1e21)).toBe("1e+21");
  });
});
