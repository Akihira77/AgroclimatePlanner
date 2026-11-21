import { z } from "zod";

import { isoInstantSchema, opaqueIdSchema } from "./enums.js";
import { pageMetaSchema } from "./page.js";
import { envelopeSchema } from "./response.js";

/**
 * Farm contracts (`docs/architecture/farm-field-domain-contracts.md` §6.2, §7).
 *
 * Ownership is absent from every request on purpose: the tenant is the session's
 * user, and `strictObject` makes a client-supplied `userId`, `deletedAt`, or
 * `areaHa` a `400` rather than a value that is silently ignored.
 *
 * Lengths are `Q6` (approved 2026-11-21): name 100, region 120, notes 2000.
 * `Q5` adds no minimum area rule and `Q8` adds no `If-Match`, so neither appears
 * here — an update is last-write-wins by design.
 */

/** Path parameter, validated before it can become a cast in SQL. */
export const farmIdSchema = z.uuid();
export type FarmId = z.infer<typeof farmIdSchema>;

/**
 * `name` is not nullable in an update either: a farm with no name cannot be
 * listed meaningfully. `region` and `notes` accept `null` to clear them, and an
 * absent key means "leave unchanged" — the only presence semantics that can
 * express a clear without a sentinel (`D3`).
 */
export const farmCreateSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  region: z.string().trim().max(120).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});
export type FarmCreateRequest = z.infer<typeof farmCreateSchema>;

/**
 * A partial with at least one key. The root refinement reports `(root)` in the
 * validation details rather than inventing a key the caller did not send.
 */
export const farmUpdateSchema = farmCreateSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: "at least one field" });
export type FarmUpdateRequest = z.infer<typeof farmUpdateSchema>;

/** The public resource. No `userId`, no `deletedAt`, no internal column. */
export const farmSchema = z.strictObject({
  id: opaqueIdSchema,
  name: z.string().min(1),
  region: z.string().nullable(),
  notes: z.string().nullable(),
  createdAt: isoInstantSchema,
  updatedAt: isoInstantSchema,
});
export type Farm = z.infer<typeof farmSchema>;

export const farmSortSchema = z.enum([
  "name",
  "-name",
  "createdAt",
  "-createdAt",
  "updatedAt",
  "-updatedAt",
]);
export type FarmSort = z.infer<typeof farmSortSchema>;

/**
 * `z.coerce` is the documented exception to "no coercion": query values arrive as
 * strings, and a page number is not a payload a caller can mistype into another
 * type. A non-numeric or fractional value still fails `int()`/`min()`, so the
 * coercion cannot turn garbage into page 1.
 *
 * `strictObject` is what turns an unknown filter parameter into a `400`
 * (`api-conventions.md` §5) instead of a query the server silently ignores.
 */
export const farmListQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  sort: farmSortSchema.default("-createdAt"),
});
export type FarmListQuery = z.infer<typeof farmListQuerySchema>;

export const farmEnvelopeSchema = envelopeSchema(farmSchema);
export const farmListEnvelopeSchema = envelopeSchema(z.array(farmSchema), pageMetaSchema);
