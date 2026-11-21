import { randomUUID } from "node:crypto";

import type { ArgumentsHost, ExceptionFilter } from "@nestjs/common";
import { Catch, HttpException, Logger } from "@nestjs/common";
import type { ErrorCode, ErrorResponse, ValidationIssue } from "@agroclimate/contracts";
import {
  errorCodeSchema,
  errorResponseSchema,
  notFoundErrorCodeSchema,
  validationDetailsSchema,
} from "@agroclimate/contracts";
import type { Response } from "express";

import type { RuntimeConfig } from "../config/runtime-config.js";
import type { ApiRequest } from "./request-id.middleware.js";
import { REQUEST_ID_HEADER } from "./request-id.middleware.js";
import { ValidationFailedException } from "./validation-failed.exception.js";

/**
 * Fixed copy per code. Taking the message from the exception would mean an
 * arbitrary `Error` — or a Prisma error whose text contains the failing SQL —
 * could reach a client, so the message is ours and the exception contributes
 * nothing unless the code itself validated.
 */
const MESSAGES: Readonly<Record<string, string>> = {
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
 * The status each singleton code implies. Used to reject an explicit code whose
 * meaning contradicts the status the handler chose — a handler cannot turn an
 * `INTERNAL_ERROR` into a `200`, and cannot report a `409` as a rate limit.
 */
const SINGLETON_STATUS: Readonly<Record<string, number>> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  CONFLICT: 409,
  INSUFFICIENT_DATA: 422,
  RATE_LIMITED: 429,
  PROVIDER_UNAVAILABLE: 503,
  DEPENDENCY_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
};

/** Status → code, for exceptions that carry no code of their own. */
const STATUS_TO_CODE: Readonly<Record<number, ErrorCode>> = {
  400: "VALIDATION_FAILED",
  401: "UNAUTHENTICATED",
  403: "FORBIDDEN",
  409: "CONFLICT",
  422: "INSUFFICIENT_DATA",
  429: "RATE_LIMITED",
  503: "DEPENDENCY_UNAVAILABLE",
};

/** Family code used when a route or resource simply does not exist. */
const RESOURCE_NOT_FOUND = notFoundErrorCodeSchema.parse("RESOURCE_NOT_FOUND");

/**
 * 4xx statuses Nest or `body-parser` raise before a handler runs — wrong method,
 * unacceptable response encoding, an oversized body, unsupported request media
 * type.
 *
 * The status is kept because it is the precise transport reason, and the code is
 * `VALIDATION_FAILED` because that is the closed-set member meaning "the request
 * itself was unusable". `api-conventions.md` §3 documents that pairing explicitly:
 * the code names the category, the status refines it, and `400` is merely the
 * common case. Collapsing these to `400` would delete information the transport
 * already knows; inventing three codes would grow a contract nobody asked to grow.
 */
const PASS_THROUGH_4XX = new Set([405, 406, 413, 415]);

/**
 * A single log line's worth of a failure. Deliberately a fixed field list rather
 * than free text: the response is sanitised, and the log must not become the leak
 * path it was cleaned out of the response.
 */
type LogField = string | number;

/** The only logger method this filter uses, so a test can pass a recorder. */
interface MinimalLogger {
  error(message: string): void;
}

interface Resolved {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: readonly ValidationIssue[];
}

/**
 * The only place an HTTP status is chosen. Controllers throw; this decides what a
 * client sees.
 *
 * Two rules keep it honest:
 *
 * 1. The body is built from the code, then parsed by `errorResponseSchema` before
 *    it is sent. A shape mismatch cannot reach a client.
 * 2. An exception that is not an `HttpException`, or whose status is not one the
 *    contract maps, becomes `500 INTERNAL_ERROR`. Failing closed is cheaper than
 *    deciding that an unfamiliar exception is really a `503`.
 *
 * A third keeps the log from undoing the second: only correlation, status, code,
 * and exception class name are written. See `logFailure`.
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger: MinimalLogger;

  constructor(
    private readonly config: RuntimeConfig,
    logger: MinimalLogger = new Logger(ApiExceptionFilter.name),
  ) {
    this.logger = logger;
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<ApiRequest>();
    const response = http.getResponse<Response>();

    const requestId = request.requestId ?? randomUUID();
    if (request.requestId === undefined) response.setHeader(REQUEST_ID_HEADER, requestId);

    const resolved = this.resolve(exception);

    if (resolved.status >= 500) {
      this.logFailure(requestId, resolved.status, resolved, exception);
    }

    response.status(resolved.status).json(this.body(resolved, requestId));
  }

  /**
   * Logs four fields and nothing else: correlation, status, contract code, and a
   * coarse exception category. `exception.message` is not in that list because it
   * is unbounded text a library wrote — a Prisma error carries the failing SQL,
   * and a driver error carries the DSN. `stack` is not either: frames name
   * internal paths and inline values. `exception.name` is not either, even though
   * it is only a name: it is a mutable property, so `error.name = "x\nstatus=200"`
   * is a log-injection primitive and `error.name = token` is a disclosure one.
   * The sanitised response and this line must not disagree about what may leave
   * the process, so production and development log the same fields; debugging
   * uses the request id to correlate with the client's report, not a leaked stack.
   */
  private logFailure(
    requestId: string,
    status: number,
    resolved: Resolved,
    exception: unknown,
  ): void {
    const fields: Record<string, LogField> = {
      requestId,
      status,
      code: resolved.code,
      exception: category(exception),
      env: this.config.nodeEnv,
    };

    const line = Object.entries(fields)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(" ");

    this.logger.error(line);
  }

  private body(resolved: Resolved, requestId: string): ErrorResponse {
    const error: Record<string, unknown> = {
      code: resolved.code,
      message: MESSAGES[resolved.code] ?? MESSAGES["INTERNAL_ERROR"],
      requestId,
    };
    if (resolved.details !== undefined) error.details = resolved.details;

    const parsed = errorResponseSchema.safeParse({ error });
    if (parsed.success) return parsed.data;

    // Unreachable by construction: every field above is already validated. Kept
    // because sending an invalid envelope is worse than sending a plain one.
    return {
      error: {
        code: "INTERNAL_ERROR",
        message: MESSAGES["INTERNAL_ERROR"] ?? "Internal error",
        requestId,
      },
    };
  }

  private resolve(exception: unknown): Resolved {
    if (!(exception instanceof HttpException)) {
      return { status: 500, code: "INTERNAL_ERROR" };
    }

    const status = exception.getStatus();
    const declared = this.declaredCode(exception);

    if (declared !== undefined && impliedStatus(declared) === status) {
      return { status, code: declared, ...this.details(exception, status) };
    }

    if (status === 404) {
      return { status, code: RESOURCE_NOT_FOUND };
    }

    const mapped = STATUS_TO_CODE[status];
    if (mapped !== undefined) {
      return { status, code: mapped, ...this.details(exception, status) };
    }

    // A 4xx Nest raised itself (405/406/415) keeps its status; anything else
    // unmapped is a bug and fails closed at 500 rather than inventing a code for
    // a status the contract never defined.
    return status < 500 && PASS_THROUGH_4XX.has(status)
      ? { status, code: "VALIDATION_FAILED" }
      : { status: 500, code: "INTERNAL_ERROR" };
  }

  /**
   * A code the handler chose deliberately, accepted only if it is in the closed
   * set. This is how `PROVIDER_UNAVAILABLE` survives the `503` default without
   * either code being able to impersonate the other.
   */
  private declaredCode(exception: HttpException): ErrorCode | undefined {
    const payload: unknown = exception.getResponse();
    if (typeof payload !== "object" || payload === null || !("code" in payload)) return undefined;

    const candidate = payload.code;
    if (typeof candidate !== "string") return undefined;

    const parsed = errorCodeSchema.safeParse(candidate);
    return parsed.success ? parsed.data : undefined;
  }

  /**
   * Details are forwarded for a `400`, and only from `ValidationFailedException`.
   *
   * A `BadRequestException` is public API: a future controller, guard, or
   * interceptor can throw one carrying a password, a SQL fragment, or a raw
   * provider response, and the envelope's `details: z.unknown()` would happily
   * transmit it. The marker type proves where the payload came from, and it is
   * parsed against `validationDetailsSchema` before it leaves — so a malformed
   * payload costs its details, not the status.
   *
   * Code-owned payloads for other statuses (`missingInputs[]` on `422`,
   * `retryAfter` on either `503`) arrive with the endpoints that own them; until
   * then this filter has no shape to validate them against and forwards nothing.
   */
  private details(exception: HttpException, status: number): { details?: ValidationIssue[] } {
    if (status !== 400 || !(exception instanceof ValidationFailedException)) return {};

    const parsed = validationDetailsSchema.safeParse(exception.issues);
    return parsed.success ? { details: parsed.data } : {};
  }
}

function impliedStatus(code: ErrorCode): number | undefined {
  if (typeof code === "string" && code.endsWith("_NOT_FOUND")) return 404;
  return SINGLETON_STATUS[code];
}

/**
 * Three labels and no fourth. The class name is not consulted because it is not
 * data — it is a string the throwing code can set — and because the useful part of
 * it is already in `status` and `code`: `exception=HttpException status=503
 * code=DEPENDENCY_UNAVAILABLE` separates a classified refusal from
 * `exception=Error status=500 code=INTERNAL_ERROR`, which is the distinction an
 * operator acts on.
 */
function category(exception: unknown): string {
  if (exception instanceof HttpException) return "HttpException";
  if (exception instanceof Error) return "Error";
  return "Unknown";
}
