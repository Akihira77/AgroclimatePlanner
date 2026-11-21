import type { AdapterResult } from "@agroclimate/contracts";

/**
 * Adapter and normalizer failures, one type, no exceptions.
 *
 * The four shared kinds are not re-spelled here — they are read off the
 * contract's own `AdapterResult`, so renaming one there breaks this package at
 * compile time instead of letting two unions drift.
 *
 * The contract's `partial` counts **cells** and demands observations plus a
 * coverage figure; a monthly series has no cells. A short monthly axis is
 * therefore `incomplete_horizon`, which the ingestion layer records as
 * `ingestion_runs.status = 'partial'` (`climate-data-foundation.md` §5.1.1).
 * `invalid_config` means the caller asked for something the adapter cannot
 * honour and no request was made. `invalid_payload` and `unsupported_unit` are
 * the normalizer's two refusals: a value it cannot represent, and a unit with no
 * approved conversion.
 *
 * This is the adapter's internal outcome, not the persisted record: the
 * ingestion layer is what stamps `receivedAt` and builds an `AdapterResult`.
 *
 * Retry policy is deliberately absent: it belongs to the queue, not here.
 */
type ContractFailureKind = Extract<
  AdapterResult,
  { kind: "transport" | "rate_limited" | "request_invalid" | "provider_changed" }
>["kind"];

export type AdapterFailureKind =
  | ContractFailureKind
  | "incomplete_horizon"
  | "invalid_config"
  | "invalid_payload"
  | "unsupported_unit";

export interface AdapterFailure {
  readonly ok: false;
  readonly kind: AdapterFailureKind;
  readonly message: string;
  /** HTTP status when one was received. Never a header dump. */
  readonly status?: number;
  readonly retryAfterSeconds?: number;
}

export interface AdapterSuccess<T> {
  readonly ok: true;
  readonly value: T;
}

export type AdapterOutcome<T> = AdapterSuccess<T> | AdapterFailure;

export function failure(
  kind: AdapterFailureKind,
  message: string,
  extra: { status?: number; retryAfterSeconds?: number } = {},
): AdapterFailure {
  return Object.freeze({
    ok: false,
    kind,
    message,
    ...(extra.status === undefined ? {} : { status: extra.status }),
    ...(extra.retryAfterSeconds === undefined
      ? {}
      : { retryAfterSeconds: extra.retryAfterSeconds }),
  });
}

/** The same shape, reused by the normalizer so one union describes both layers. */
export type NormalizationFailure = AdapterFailure;
