import { z } from "zod";

import type { SpatialResolution } from "./grid.js";

/**
 * `POST /v1/fields/:fieldId/resolve-cell` — the HTTP shape of §5.2.9.2
 * (`docs/architecture/climate-data-foundation.md`).
 *
 * The request carries the registry key and **nothing else**. A coordinate, a
 * `cellKey`, a `gridId`, a hash, an evidence string, or an algorithm version
 * supplied by a client would have to be either ignored or trusted, and both are
 * worse than refusing it: the centroid comes from the field's geometry, and every
 * other value comes from the registry and the resolver. `strictObject` is what
 * turns "ignored" into `VALIDATION_FAILED`.
 */
export const cellResolutionRequestSchema = z.strictObject({
  provider: z.string().min(1),
  model: z.string().min(1),
});

export type CellResolutionRequest = z.infer<typeof cellResolutionRequestSchema>;

/**
 * The response body. `resolution` is the resolver's own object, unflattened, so a
 * client cannot mistake `anchor` for something the provider served.
 *
 * `servedCoordinate` is always `null` and is written here on purpose: the resolver
 * has no provider response, and a field that omits the key entirely invites the
 * reader to treat `anchor` as the served position.
 *
 * Absent by design — `distanceKm` (unknowable before a served coordinate exists),
 * `extractionPolicy` (a field-mapping decision 5.2 defers), any `field_outlook_cells`
 * row, and any weather value.
 */
export interface CellResolution {
  readonly cellId: string;
  readonly servedCoordinate: null;
  readonly resolution: SpatialResolution;
}
