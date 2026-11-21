import { z } from "zod";

/**
 * Pagination metadata for a list response (`docs/architecture/api-conventions.md`
 * §2 and §5).
 *
 * Offset paging, page-numbered: `page` starts at 1, `pageSize` is the size the
 * server actually used (never the raw query string), and `total` is the count
 * under the same tenant and `deleted_at IS NULL` predicates as the page.
 *
 * `pageSize` carries the same 100 maximum as the query schema. A response that
 * claimed a page larger than the contract allows would be a server bug the
 * client cannot distinguish from a hostile one, so the bound is stated twice
 * rather than inherited from one place.
 */
export const pageMetaSchema = z.strictObject({
  page: z.number().int().positive(),
  pageSize: z.number().int().positive().max(100),
  total: z.number().int().nonnegative(),
});
export type PageMeta = z.infer<typeof pageMetaSchema>;
