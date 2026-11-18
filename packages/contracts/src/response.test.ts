import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  envelopeSchema,
  errorCodeSchema,
  errorResponseSchema,
  notFoundErrorCodeSchema,
  requestIdSchema,
  singletonErrorCodeSchema,
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
