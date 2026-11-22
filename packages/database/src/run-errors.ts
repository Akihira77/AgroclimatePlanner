/**
 * Domain errors of the run lifecycle and the queue.
 *
 * The distinctions are load-bearing — each one asks the caller for a different
 * action, and collapsing any two of them produces a bug that only appears under
 * contention:
 *
 *   LeaseLostError            you no longer own this job: discard the result.
 *   IngestionAlreadyOwned     someone else owns this IngestionRun: never retry.
 *   IngestionTerminalError    the run is finished: there is nothing to do.
 *   IngestionRunMissing       identity points at nothing: a programming error.
 *   JobRetryExhaustedError    the attempt budget is spent: go terminal.
 *   TransientTransactionError serialisation/deadlock: retry the transaction.
 *   InvariantViolationError   a value the schema forbids: never retry.
 *
 * Raw PostgreSQL errors are mapped at the persistence boundary, never leaked as
 * the queue's public contract.
 */

export class LeaseLostError extends Error {
  override readonly name = "LeaseLostError";
}

export class IngestionTerminalError extends Error {
  override readonly name = "IngestionTerminalError";

  constructor(readonly status: string) {
    super(`the ingestion run is already terminal (status "${status}")`);
  }
}

/**
 * The partial unique index `jobs_active_ingestion_idx` refused the assignment:
 * another running job already owns this IngestionRun.
 *
 * This is not a retryable failure and must not be reported as `LeaseLostError`.
 * The current worker owns its job perfectly well; the run belongs to someone
 * else, and the correct response is to leave both alone and let the reaper
 * settle the abandoned lease.
 */
export class IngestionAlreadyOwnedError extends Error {
  override readonly name = "IngestionAlreadyOwnedError";
}

export class IngestionRunMissingError extends Error {
  override readonly name = "IngestionRunMissingError";
}

/** Raised by `fail()` when a retryable outcome has no attempt left. */
export class JobRetryExhaustedError extends Error {
  override readonly name = "JobRetryExhaustedError";

  constructor(readonly attempt: number) {
    super(`attempt ${attempt} is the last permitted execution; the job must go dead`);
  }
}

export class TransientTransactionError extends Error {
  override readonly name = "TransientTransactionError";
}

export class InvariantViolationError extends Error {
  override readonly name = "InvariantViolationError";
}

/* ------------------------------------------------------------------ *
 * PostgreSQL error classification
 * ------------------------------------------------------------------ */

/** unique_violation */
export const PG_UNIQUE_VIOLATION = "23505";
/** foreign_key_violation */
export const PG_FOREIGN_KEY_VIOLATION = "23503";
/** check_violation */
export const PG_CHECK_VIOLATION = "23514";
/** not_null_violation */
export const PG_NOT_NULL_VIOLATION = "23502";
/** serialization_failure */
export const PG_SERIALIZATION_FAILURE = "40001";
/** deadlock_detected */
export const PG_DEADLOCK_DETECTED = "40P01";

interface PgAdapterCause {
  readonly originalCode?: unknown;
  readonly originalMessage?: unknown;
  readonly constraint?: { readonly index?: unknown } | null;
}

interface PgErrorShape {
  readonly code?: unknown;
  readonly meta?: {
    readonly code?: unknown;
    readonly message?: unknown;
    readonly driverAdapterError?: { readonly cause?: PgAdapterCause };
  };
  readonly message?: unknown;
}

/**
 * Prisma wraps a raw-query failure as `P2010` and puts the server's SQLSTATE in
 * `meta.driverAdapterError.cause.originalCode` (driver adapters) or
 * `meta.code` (older shapes). Reading all three places keeps the mapping
 * correct regardless of which layer surfaced the PostgreSQL error.
 */
export function pgErrorInfo(error: unknown): {
  code?: string | undefined;
  message?: string | undefined;
  constraint?: string | undefined;
} {
  if (typeof error !== "object" || error === null) return {};
  const shape = error as PgErrorShape;
  const cause = shape.meta?.driverAdapterError?.cause;
  const metaCode = typeof shape.meta?.code === "string" ? shape.meta.code : undefined;
  const causeCode = typeof cause?.originalCode === "string" ? cause.originalCode : undefined;
  const directCode = typeof shape.code === "string" ? shape.code : undefined;
  const metaMessage = typeof shape.meta?.message === "string" ? shape.meta.message : undefined;
  const causeMessage =
    typeof cause?.originalMessage === "string" ? cause.originalMessage : undefined;
  const directMessage = typeof shape.message === "string" ? shape.message : undefined;
  const constraint =
    typeof cause?.constraint?.index === "string" ? cause.constraint.index : undefined;
  const code = causeCode ?? metaCode ?? directCode;
  const message = causeMessage ?? metaMessage ?? directMessage;
  return {
    ...(code === undefined ? {} : { code }),
    ...(message === undefined ? {} : { message }),
    ...(constraint === undefined ? {} : { constraint }),
  };
}

export function isUniqueViolationOn(error: unknown, constraint: string): boolean {
  const info = pgErrorInfo(error);
  if (info.code !== PG_UNIQUE_VIOLATION) return false;
  return info.constraint === constraint || (info.message ?? "").includes(constraint);
}

export function isTransientTransactionError(error: unknown): boolean {
  const { code } = pgErrorInfo(error);
  return code === PG_SERIALIZATION_FAILURE || code === PG_DEADLOCK_DETECTED;
}

export function isCheckViolation(error: unknown): boolean {
  const { code } = pgErrorInfo(error);
  return code === PG_CHECK_VIOLATION || code === PG_NOT_NULL_VIOLATION;
}
