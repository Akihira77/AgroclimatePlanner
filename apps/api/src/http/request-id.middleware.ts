import { randomUUID } from "node:crypto";

import { requestIdSchema } from "@agroclimate/contracts";
import type { NextFunction, Request, Response } from "express";

/** The header name, in both directions. Documented in `api-conventions.md` §1. */
export const REQUEST_ID_HEADER = "X-Request-Id";

/**
 * The Express request plus the field this middleware adds.
 *
 * An intersection rather than module augmentation: `@types/express-serve-static-core`
 * is a transitive type dependency here, so augmenting it is not resolvable from
 * this package, and a global augmentation would leak into every consumer. A
 * `Request` is assignable to this shape without a cast, which is the point.
 */
export type ApiRequest = Request & { requestId?: string };

export interface RequestIdOptions {
  /**
   * Honour a caller-supplied `X-Request-Id` when it is a UUID. Off by default:
   * trusting the header means an untrusted client chooses the correlation id,
   * which is a log-injection and log-confusion surface for no gain. A reverse
   * proxy that mints ids is the case where an operator turns this on.
   */
  readonly trustIncoming: boolean;
}

/**
 * Mints one UUID per request and pins it to the response header, so the id a
 * client is told and the id in the body of an error are the same string.
 */
export function requestIdMiddleware(
  options: RequestIdOptions,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    const api: ApiRequest = req;
    const incoming = options.trustIncoming ? req.header(REQUEST_ID_HEADER) : undefined;
    const parsed = incoming === undefined ? undefined : requestIdSchema.safeParse(incoming);
    const requestId = parsed?.success === true ? parsed.data : randomUUID();

    api.requestId = requestId;
    res.setHeader(REQUEST_ID_HEADER, requestId);
    next();
  };
}
