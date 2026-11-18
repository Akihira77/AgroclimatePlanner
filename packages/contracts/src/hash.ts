import { createHash } from "node:crypto";
import { CanonicalizationError, canonicalJson } from "./canonical.js";
import type { DerivationDescriptor, FieldSnapshotPayload } from "./provenance.js";

/**
 * SHA-256 over the UTF-8 bytes of the given string, lowercase hex.
 *
 * One primitive, one output format. Every artifact hash in the system is this
 * function applied to `canonicalJson(...)` — there is no per-artifact hashing
 * implementation to drift.
 */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * `fieldSnapshotHash = SHA256(canonicalJson(FieldSnapshotPayload))`.
 *
 * The payload type already excludes `fieldSnapshotHash`; the runtime guard is
 * here because a structural type cannot stop an untyped caller from passing the
 * persisted row, and a hash whose preimage contains its own output is not a
 * hash at all.
 */
export function hashFieldSnapshot(payload: FieldSnapshotPayload): string {
  if (Object.hasOwn(payload, "fieldSnapshotHash")) {
    throw new CanonicalizationError(
      "$.fieldSnapshotHash",
      "the snapshot hash is the output; it cannot be part of its own preimage",
    );
  }
  return sha256Hex(canonicalJson(payload));
}

/**
 * `inputSnapshotHash = SHA256(canonicalJson(DerivationDescriptor))`.
 *
 * Exactly one of the four descriptor variants. `artifact` is inside the hash, so
 * a suitability run and a window with identical inputs still differ.
 */
export function hashDerivationDescriptor(descriptor: DerivationDescriptor): string {
  return sha256Hex(canonicalJson(descriptor));
}
