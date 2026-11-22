import { randomUUID } from "node:crypto";

import type { ErrorCode, ErrorResponse, ValidationIssue } from "@agroclimate/contracts";
import { errorResponseSchema } from "@agroclimate/contracts";

/**
 * The error envelope, in one place.
 *
 * The exception filter and the `Origin` middleware both answer with it. The
 * middleware runs before Nest's routers, so it cannot throw an `HttpException` and
 * hope the filter catches it — it has to write the response itself, and writing a
 * second, slightly different error body is how a client ends up parsing two
 * shapes.
 */

/**
 * Fixed copy per code. Taking the message from an exception would let an arbitrary
 * `Error` — or a Prisma error whose text contains the failing SQL — reach a client,
 * so the message is ours.
 */
export const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  VALIDATION_FAILED: "Permintaan tidak valid.",
  UNAUTHENTICATED: "Sesi tidak ditemukan atau sudah berakhir.",
  FORBIDDEN: "Tidak diizinkan.",
  CONFLICT: "Permintaan bertabrakan dengan keadaan data saat ini.",
  INSUFFICIENT_DATA: "Data yang dibutuhkan belum mencukupi.",
  RATE_LIMITED: "Batas permintaan terlampaui.",
  PROVIDER_UNAVAILABLE: "Nilai cuaca tidak tersedia dan tidak ada cadangan yang diizinkan.",
  DEPENDENCY_UNAVAILABLE: "Ketergantungan layanan tidak tersedia.",
  INTERNAL_ERROR: "Terjadi kesalahan pada server.",
};

/**
 * The `404` family is open (`*_NOT_FOUND`), so it cannot have a table entry per
 * member — but a `404` answering with the internal-error text is a contract lie:
 * the resource is absent, the server is fine. One message covers the family, and
 * a code with its own entry still wins.
 */
const NOT_FOUND_MESSAGE = "Sumber daya tidak ditemukan.";

function messageFor(code: ErrorCode): string {
  const own = ERROR_MESSAGES[code];
  if (own !== undefined) return own;
  return code.endsWith("_NOT_FOUND") ? NOT_FOUND_MESSAGE : ERROR_MESSAGES["INTERNAL_ERROR"]!;
}

/** Builds the envelope, then parses it, so a contract mismatch cannot be sent. */
export function errorResponseBody(
  code: ErrorCode,
  requestId: string,
  details?: readonly ValidationIssue[],
): ErrorResponse {
  const error: Record<string, unknown> = {
    code,
    message: messageFor(code),
    requestId,
  };
  if (details !== undefined) error.details = details;

  const parsed = errorResponseSchema.safeParse({ error });
  if (parsed.success) return parsed.data;

  // Unreachable by construction: every field above is already validated. Kept
  // because sending an invalid envelope is worse than sending a plain one.
  return {
    error: {
      code: "INTERNAL_ERROR",
      message: ERROR_MESSAGES["INTERNAL_ERROR"] ?? "Internal error",
      requestId,
    },
  };
}

/** A request that never passed the request-id middleware still needs a correlation id. */
export function requestIdOf(requestId: string | undefined): string {
  return requestId === undefined ? randomUUID() : requestId;
}
