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
 * 2026-11-18) and is deliberately distinct from `PROVIDER_UNAVAILABLE`:
 * a weather provider having no usable value is a domain fact a client may route
 * around, while a session store or database being unreachable is infrastructure
 * failure. Both are `503`; collapsing them would make the weather code mean two
 * things.
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

/**
 * Error envelope. `code` is the machine-readable contract; `message` is
 * user-facing copy and may change wording without a version bump, so clients
 * must key on `code`.
 *
 * `details` is intentionally unconstrained by the envelope: the payload differs
 * per code (`{ path, issue }[]` for validation, `missingInputs[]` for
 * insufficient input, `retryAfter` for the two `503`s), and inventing one shape
 * for all of them would either drop fields or lie about them. Each code owns its
 * `details` shape; the envelope only guarantees the field is JSON.
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
