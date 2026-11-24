import { CellResolutionError, GridConfigurationError } from "@agroclimate/contracts";
import { NotFoundException } from "@nestjs/common";

/**
 * Translates the two ways a resolution can legitimately find nothing into the
 * documented `404` family, and nothing else.
 *
 * Both codes are nouns from `api-conventions.md` §3's `*_NOT_FOUND` family, which
 * exists precisely so a new resource can say "absent" without growing the closed
 * singleton set. Neither distinguishes anything a client must not learn, and
 * neither is `FIELD_NOT_FOUND`: the field was found, which is why resolution got
 * this far.
 *
 * | Failure | Answer | Why not something else |
 * |---|---|---|
 * | `unknown_model` | `404 GRID_NOT_FOUND` | No grid is configured for that pair. A `400` would blame a body that is well-formed; a `503` would promise a retry that cannot help |
 * | `out_of_grid` | `404 CELL_NOT_FOUND` | The grid exists and has no node for this position. Minting nothing is the point — no nearest match, no neighbouring cell |
 *
 * Everything else propagates and becomes the `500` it is: a `grid_spec_hash_mismatch`
 * means a registered spec no longer describes itself, `grid_not_validated` cannot
 * be reached here (this route never asks for ingestion eligibility), and a
 * PostgreSQL CHECK refusing `synthetic` is a configuration bug, not a client
 * problem. `invalid_coordinate` is unreachable from a stored field — six-decimal
 * centroid — and would also be a server defect.
 */
export function rethrowCellResolutionError(error: unknown): never {
  if (error instanceof GridConfigurationError && error.code === "unknown_model") {
    throw new NotFoundException({ code: "GRID_NOT_FOUND" });
  }
  if (error instanceof CellResolutionError && error.code === "out_of_grid") {
    throw new NotFoundException({ code: "CELL_NOT_FOUND" });
  }
  throw error;
}
