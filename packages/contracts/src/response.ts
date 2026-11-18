import { z } from "zod";

/**
 * HTTP response envelopes (`docs/architecture/api-conventions.md` §2–§3).
 *
 * Two shapes, and only two. A success response carries `data`; an error
 * response carries `error` and never `data`. Keeping them in one module is what
 * stops a controller from inventing a third.
 */

/**
 * Canonical request correlation id.
 *
 * UUID string, not ULID. `api-conventions.md` §1 rejects ULID for resource ids
 * and the example requestId (`"01J…"`) is ULID-shaped only by accident — it
 * predates this contract. A UUID keeps one id family in the API, and
 * `crypto.randomUUID()` mints one without a dependency (generation itself is
 * S2's middleware, not this contract).
 *
 * Versions are not pinned: a v7 supplied by a proxy is as valid a correlation
 * id as a v4, and pinning would turn an unrelated id-scheme change into a
 * contract break.
 */
export const requestIdSchema = z.uuid();
export type RequestId = z.infer<typeof requestIdSchema>;

/**
 * Singleton codes from `api-conventions.md` §3. The fixity is the point: a code
 * that is not here cannot be returned, so a client can exhaustively switch on
 * the closed set.
 *
 * `DEPENDENCY_UNAVAILABLE` is the only addition (owner decision `IG-5`, C-1,
 * 2026-11-18) and is deliberately distinct from `PROVIDER_UNAVAILABLE`: a
 * weather provider having no usable value is a domain fact a client may route
 * around, while a session store or database being unreachable is infrastructure
 * failure. Both are `503`; collapsing them would make the weather code mean two
 * things.
 *
 * `INTERNAL_ERROR` was added by owner decision on 2026-11-18 for S2, and for the
 * opposite reason: an unexpected exception must fail closed with `500`, and the
 * set above had no code that could honestly describe it. Reporting a bug as
 * `DEPENDENCY_UNAVAILABLE` would tell every client to retry something that will
 * fail identically next time.
 */
export const singletonErrorCodeSchema = z.enum([
  "VALIDATION_FAILED",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "CONFLICT",
  "INSUFFICIENT_DATA",
  "RATE_LIMITED",
  "PROVIDER_UNAVAILABLE",
  "DEPENDENCY_UNAVAILABLE",
  "INTERNAL_ERROR",
]);
export type SingletonErrorCode = z.infer<typeof singletonErrorCodeSchema>;

/**
 * The `404` family. `api-conventions.md` §3 specifies `*_NOT_FOUND` and says a
 * missing resource and a foreign one must never be distinguished, so the
 * contract pins the suffix rather than enumerating every resource noun.
 *
 * A closed enumeration was rejected here: it would have to grow with every new
 * resource, and a forgotten member turns "not found" into "invalid contract" at
 * exactly the moment a client is handling an absence.
 *
 * The brand is what stops the type from collapsing back to `string`. A regex
 * schema infers `string`, so without it `ErrorCode` would be
 * `SingletonErrorCode | string` — every arbitrary string assignable in
 * TypeScript while still being rejected at runtime. The brand is compile-time
 * only: `parse` still returns the plain string value, and no runtime behaviour
 * changes. A member of this family can therefore only be obtained by parsing it,
 * which is the validation the type is supposed to represent.
 */
export const notFoundErrorCodeSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_NOT_FOUND$/, "expected a <RESOURCE>_NOT_FOUND code")
  .brand<"NotFoundErrorCode">();
export type NotFoundErrorCode = z.infer<typeof notFoundErrorCodeSchema>;

export const errorCodeSchema = z.union([singletonErrorCodeSchema, notFoundErrorCodeSchema]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

/**
 * Success envelope: `{ data }` for one resource, `{ data, meta }` for a list or
 * any response that needs paging or coverage metadata.
 *
 * One generic schema covers both, because the single-resource shape in
 * `api-conventions.md` §2 (`{ "data": { … } }`) *is* the envelope without
 * `meta` — a separate schema would be the same object with a different name.
 *
 * ```ts
 * const farmEnvelope = envelopeSchema(farmSchema);
 * const farmListEnvelope = envelopeSchema(z.array(farmSchema), pageMetaSchema);
 * ```
 */
export function envelopeSchema<T extends z.ZodType, M extends z.ZodType = z.ZodNever>(
  dataSchema: T,
  metaSchema?: M,
) {
  return z.strictObject(
    metaSchema === undefined ? { data: dataSchema } : { data: dataSchema, meta: metaSchema },
  );
}

/** `Envelope<Farm>` is `{ data: Farm }`; `Envelope<Farm[], PageMeta>` adds `meta`. */
export type Envelope<T, M = undefined> = M extends undefined ? { data: T } : { data: T; meta: M };

/** A path with no segments: the whole value was rejected. */
export const VALIDATION_ROOT_PATH = "(root)";

/**
 * Terminates a path that outgrew `MAX_VALIDATION_PATH_LENGTH`. It marks the cut
 * itself rather than leaving a half-written segment behind: a path is only useful
 * if it can be read back unambiguously, and a mid-token cut cannot.
 */
export const VALIDATION_TRUNCATION_MARKER = "[…]";

/**
 * The one identifier rule, shared by the producer and the contract. `[^\p{L}_]`
 * means a segment can never start with a digit, a dot, or a bracket, which is what
 * keeps `field2` distinguishable from `field[2]`.
 */
const IDENTIFIER_SEGMENT = /^[\p{L}_][\p{L}\p{N}_]{0,63}$/u;

/** One Unicode code point that may appear inside an identifier. Sticky, so it advances. */
const WORD_CHARACTER = /[_\p{L}\p{N}]/uy;

/** No leading zeros: `[0]` and `[10]` are indexes, `[007]` is neither one thing nor the other. */
const CANONICAL_INDEX = /^(0|[1-9][0-9]{0,9})$/;

export function isSafeIdentifierSegment(segment: string): boolean {
  return IDENTIFIER_SEGMENT.test(segment);
}

/**
 * Accepts exactly the grammar the producer emits, and nothing adjacent to it:
 *
 * ```
 * path      = "(root)" | segment { separator segment } [ "…" ]
 * separator = "." | "[" index "]" | "[…" ordinal "]"
 * segment   = identifier            ; Unicode letter or "_", then letters, digits, "_"
 * ```
 *
 * Written as a parser rather than one regular expression because the parts are
 * not independent: an identifier may not start with a digit, an index must be
 * canonical, and the truncation marker is only legal as the last token.
 *
 * This is the boundary, not a courtesy. `ValidationFailedException` is a public
 * class inside `apps/api`, so a caller that never went through the Zod pipe can
 * still construct one; the schema is what makes its payload safe rather than the
 * assumption that only the pipe does.
 */
export function isSafeValidationPath(path: string): boolean {
  if (path === VALIDATION_ROOT_PATH) return true;
  if (path.length === 0 || path.length > MAX_VALIDATION_PATH_LENGTH) return false;

  let index = 0;
  let first = true;

  while (index < path.length) {
    if (path.startsWith(VALIDATION_TRUNCATION_MARKER, index)) {
      return index + VALIDATION_TRUNCATION_MARKER.length === path.length;
    }

    if (path[index] === "[") {
      const ordinal = path.startsWith("[…", index);
      const digitsStart = index + (ordinal ? 2 : 1);
      let cursor = digitsStart;

      while (cursor < path.length) {
        const code = path.charCodeAt(cursor);
        if (code < 48 || code > 57) break;
        cursor += 1;
      }

      if (cursor === digitsStart || path[cursor] !== "]") return false;
      if (!CANONICAL_INDEX.test(path.slice(digitsStart, cursor))) return false;

      index = cursor + 1;
      first = false;
      continue;
    }

    if (!first) {
      if (path[index] !== ".") return false;
      index += 1;
    }

    const segmentStart = index;
    index = readWord(path, index);
    if (!isSafeIdentifierSegment(path.slice(segmentStart, index))) return false;

    first = false;
  }

  return true;
}

/** Advances over the identifier tail, one code point at a time. */
function readWord(path: string, start: number): number {
  let cursor = start;

  for (;;) {
    WORD_CHARACTER.lastIndex = cursor;
    if (!WORD_CHARACTER.test(path)) return cursor;
    cursor = WORD_CHARACTER.lastIndex;
  }
}

/**
 * One validation failure. Both fields are bounded by this contract, not by the
 * producer: an unbounded `path` is how a rejected payload's own text gets
 * reflected back, and an unbounded `issue` is free text by another name.
 *
 * The object is strict, so a producer cannot attach the submitted value next to
 * the diagnosis. `path` is the encoded form `api-conventions.md` §12 defines;
 * ordinary field names appear unchanged, anything that is not an identifier is
 * replaced by an ordinal marker rather than echoed, and `isSafeValidationPath`
 * refuses anything that is neither.
 */
export const MAX_VALIDATION_PATH_LENGTH = 200;
export const MAX_VALIDATION_ISSUE_LENGTH = 64;

export const validationIssueSchema = z.strictObject({
  path: z
    .string()
    .min(1)
    .max(MAX_VALIDATION_PATH_LENGTH)
    .refine(isSafeValidationPath, "expected the encoded validation path grammar"),
  issue: z
    .string()
    .min(1)
    .max(MAX_VALIDATION_ISSUE_LENGTH)
    .regex(/^[a-z0-9_]+$/, "expected a lower_snake_case issue code"),
});
export type ValidationIssue = z.infer<typeof validationIssueSchema>;

/**
 * A bounded list, in a fixed order. The cap is part of the contract so one
 * oversized payload cannot turn a `400` into a multi-megabyte response.
 */
export const MAX_VALIDATION_ISSUES = 100;

export const validationDetailsSchema = z.array(validationIssueSchema).max(MAX_VALIDATION_ISSUES);
export type ValidationDetails = z.infer<typeof validationDetailsSchema>;

/**
 * Error envelope. `code` is the machine-readable contract; `message` is
 * user-facing copy and may change wording without a version bump, so clients
 * must key on `code`.
 *
 * `details` is intentionally unconstrained by the envelope: the payload differs
 * per code (`validationDetailsSchema` for validation, `missingInputs[]` for
 * insufficient input, `retryAfter` for the two `503`s), and inventing one shape
 * for all of them would either drop fields or lie about them. Each code owns its
 * `details` shape; the envelope only guarantees the field is JSON.
 *
 * The envelope cannot tell a code-owned payload from an arbitrary one, so the
 * server's exception filter is what decides which producer may attach details at
 * all — see `api-conventions.md` §3.
 */
export const errorResponseSchema = z.strictObject({
  error: z.strictObject({
    code: errorCodeSchema,
    message: z.string().min(1),
    details: z.unknown().optional(),
    requestId: requestIdSchema,
  }),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
export type ErrorBody = ErrorResponse["error"];
