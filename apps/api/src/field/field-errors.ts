import { FieldGeometryError } from "@agroclimate/database";

import { ValidationFailedException } from "../http/validation-failed.exception.js";

/**
 * Translates the two ways a Field write can be refused for its shape into the
 * standard `400 VALIDATION_FAILED`, and nothing else.
 *
 * `FieldGeometryError` is thrown by the database layer before any statement runs:
 * a non-`Polygon` type or a `crs`/`bbox` member. The contract already refuses
 * those, so reaching this is a contract bug — but it is still the caller's input
 * that was wrong, and a `500` would blame the server for it.
 *
 * The CHECK violation is the interesting one. A self-intersecting or degenerate
 * polygon is structurally valid GeoJSON and only `ST_IsValid`/`ST_IsEmpty` can
 * detect it, so PostgreSQL raises `23514` on a request that passed validation.
 * Attaching that SQLSTATE to `geometry` is safe *on these two statements* because
 * they write exactly two columns: `name`, which the contract has already
 * constrained to a non-blank string, and `geom`. Every other CHECK on
 * `app.fields` covers a column this layer never writes. A `23514` from anywhere
 * else is therefore not this helper's to translate — but there is no other
 * reachable source, and if one appears the fix is to add the condition, not to
 * broaden this one.
 *
 * Nothing here catches a `23503` (composite FK), a `23502` (NOT NULL), or an
 * infrastructure error: those keep propagating as the `500` they are.
 */
export function rethrowFieldWriteError(error: unknown): never {
  if (error instanceof FieldGeometryError || isFieldsCheckViolation(error)) {
    throw new ValidationFailedException([{ path: "geometry", issue: "invalid_geometry" }]);
  }
  throw error;
}

const CHECK_VIOLATION = "23514";

/**
 * Walks the wrapper chain the driver adapter builds — `PrismaClientKnownRequestError`
 * → `meta.driverAdapterError` → `cause` — and matches the SQLSTATE only. The
 * constraint name is not read: Prisma 7's adapter carries it inside the human
 * `message` string, and parsing that is exactly the fragility `isEmailUniqueViolation`
 * was written to avoid. Bounded depth, because an unbounded walk is a cycle risk.
 */
function isFieldsCheckViolation(error: unknown, depth = 0): boolean {
  if (depth > 5 || typeof error !== "object" || error === null) return false;

  const record = error as Record<string, unknown>;
  for (const key of ["code", "originalCode", "sqlState"] as const) {
    if (record[key] === CHECK_VIOLATION) return true;
  }

  for (const key of ["cause", "meta", "driverAdapterError"] as const) {
    if (isFieldsCheckViolation(record[key], depth + 1)) return true;
  }
  return false;
}
