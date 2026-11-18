import { randomUUID } from "node:crypto";

import type { ArgumentsHost, ExceptionFilter } from "@nestjs/common";
import { Catch, HttpException, Logger } from "@nestjs/common";
import type { ErrorCode, ErrorResponse } from "@agroclimate/contracts";
import {
  errorCodeSchema,
  errorResponseSchema,
  notFoundErrorCodeSchema,
} from "@agroclimate/contracts";
import type { Response } from "express";

import type { RuntimeConfig } from "../config/runtime-config.js";
import type { ApiRequest } from "./request-id.middleware.js";
import { REQUEST_ID_HEADER } from "./request-id.middleware.js";

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
 * 4xx statuses Nest itself raises before any handler runs — wrong method, wrong
 * media type, unacceptable response encoding. The status is the precise meaning,
 * and `VALIDATION_FAILED` is the closest closed-set member: the request, not the
 * server, was unacceptable.
 */
const PASS_THROUGH_4XX = new Set([405, 406, 415]);

interface Resolved {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: unknown;
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
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  constructor(private readonly config: RuntimeConfig) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<ApiRequest>();
    const response = http.getResponse<Response>();

    const requestId = request.requestId ?? randomUUID();
    if (request.requestId === undefined) response.setHeader(REQUEST_ID_HEADER, requestId);

    const resolved = this.resolve(exception);

    if (resolved.status >= 500) {
      // Name and request id only: a message can carry SQL, a connection string,
      // or a value from the request body. The stack is a development affordance.
      const name = exception instanceof Error ? exception.name : typeof exception;
      const suffix = this.config.nodeEnv === "production" ? "" : ` ${String(exception)}`;
      this.logger.error(`[${requestId}] ${resolved.code} ${name}${suffix}`);
    }

    response.status(resolved.status).json(this.body(resolved, requestId));
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

  /** Details are only forwarded for a `400`, and only if the handler supplied an object. */
  private details(exception: HttpException, status: number): { details?: unknown } {
    if (status !== 400) return {};

    const payload: unknown = exception.getResponse();
    if (typeof payload !== "object" || payload === null || !("details" in payload)) return {};

    const details = payload.details;
    return details === undefined ? {} : { details };
  }
}

function impliedStatus(code: ErrorCode): number | undefined {
  if (typeof code === "string" && code.endsWith("_NOT_FOUND")) return 404;
  return SINGLETON_STATUS[code];
}
