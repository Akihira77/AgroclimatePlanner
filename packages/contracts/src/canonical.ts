/**
 * Canonicalisation contract — the single designated home for array ordering,
 * deduplication, and (from Phase 2.6) JSON serialisation + hashing.
 *
 * docs/architecture/provenance-contract.md §4 is normative. Two rules from it
 * drive everything here:
 *
 *   1. Ordering is applied by the canonicaliser, never by the caller. A caller
 *      that has to remember to sort an array is the bug this module exists to
 *      prevent.
 *   2. Deduplication must never silently discard a conflicting record. Equal
 *      identity + different content throws instead of picking a winner.
 *
 * What is NOT here yet: SHA-256, number formatting, and the golden vectors.
 * Those land with the hash implementation; shipping a hash now would lock in
 * serialisation before the permutation fixture exists to prove it.
 */

export class CanonicalOrderError extends Error {
  constructor(
    readonly arrayName: string,
    message: string,
  ) {
    super(`canonical order violation in "${arrayName}": ${message}`);
    this.name = "CanonicalOrderError";
  }
}

export type ObjectArrayName = "resolvedCells" | "observationsUsed" | "inputRefs" | "missingRanges";

export type StringArrayName =
  "sourceArtifactHashes" | "forecastRunIds" | "ingestionRunIds" | "cellKeys" | "observationIds";

/**
 * `dedupe: false` is a decision, not an omission:
 *  - `inputRefs`: two refs of the same role for different cells are both real.
 *  - `missingRanges`: adjacent ranges are not duplicates.
 */
export const objectArrayRules: Record<
  ObjectArrayName,
  { readonly orderBy: readonly string[]; readonly dedupe: boolean }
> = {
  resolvedCells: { orderBy: ["provider", "model", "cellKey"], dedupe: true },
  observationsUsed: { orderBy: ["observationId"], dedupe: true },
  inputRefs: { orderBy: ["kind", "role", "purpose"], dedupe: false },
  missingRanges: { orderBy: ["startDate", "endDate"], dedupe: false },
};

/**
 * `inputRefs` needs a fourth key the table cannot express as a plain property:
 * the doc orders by "(kind, role, purpose, first id)", and the first id depends
 * on which variant the ref is.
 */
const extraIdentityKeys: Partial<
  Record<ObjectArrayName, (item: Record<string, unknown>) => string>
> = { inputRefs: firstRefId };

export const stringArrayRules: Record<StringArrayName, { readonly dedupe: boolean }> = {
  sourceArtifactHashes: { dedupe: true },
  forecastRunIds: { dedupe: true },
  ingestionRunIds: { dedupe: true },
  cellKeys: { dedupe: true },
  observationIds: { dedupe: true },
};

/**
 * Stable JSON for equality comparison only — not the hash preimage format.
 * Keys sorted recursively so two structurally equal values serialise the same
 * regardless of insertion order.
 */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
}

function compareTuples(a: readonly unknown[], b: readonly unknown[]): number {
  for (let i = 0; i < a.length; i += 1) {
    const left = String(a[i] ?? "");
    const right = String(b[i] ?? "");
    if (left < right) return -1;
    if (left > right) return 1;
  }
  return 0;
}

function identityOf(
  arrayName: ObjectArrayName,
  item: Record<string, unknown>,
  orderBy: readonly string[],
): string[] {
  const keys = orderBy.map((key) => {
    const value = item[key];
    if (value === undefined || value === null) {
      throw new CanonicalOrderError(
        arrayName,
        `missing identity key "${key}" — ordering cannot be total`,
      );
    }
    return String(value);
  });
  const extra = extraIdentityKeys[arrayName];
  if (extra) keys.push(extra(item));
  return keys;
}

/**
 * Sort (and optionally deduplicate) a set-like array of objects.
 *
 * Ties beyond the documented key tuple are broken by the full stable JSON of
 * the entry. Without a total order, two runs could produce different orders for
 * the same content and therefore different hashes.
 */
export function orderObjectArray<T extends Record<string, unknown>>(
  arrayName: ObjectArrayName,
  values: readonly T[],
): T[] {
  const rule = objectArrayRules[arrayName];
  const keyed = values.map((value) => ({
    value,
    identity: identityOf(arrayName, value, rule.orderBy),
    ser: stableJson(value),
  }));

  keyed.sort((a, b) => {
    const byKey = compareTuples(a.identity, b.identity);
    if (byKey !== 0) return byKey;
    return a.ser < b.ser ? -1 : a.ser > b.ser ? 1 : 0;
  });

  if (!rule.dedupe) return keyed.map((entry) => entry.value);

  const out: T[] = [];
  for (const entry of keyed) {
    const previous = out.at(-1);
    if (previous === undefined) {
      out.push(entry.value);
      continue;
    }
    const previousIdentity = identityOf(arrayName, previous, rule.orderBy);
    if (compareTuples(previousIdentity, entry.identity) !== 0) {
      out.push(entry.value);
      continue;
    }
    if (stableJson(previous) !== entry.ser) {
      throw new CanonicalOrderError(
        arrayName,
        `duplicate identity [${entry.identity.join(", ")}] with conflicting content`,
      );
    }
  }
  return out;
}

/** Sort (and optionally deduplicate) a set-like array of strings. */
export function orderStringArray(arrayName: StringArrayName, values: readonly string[]): string[] {
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (!stringArrayRules[arrayName].dedupe) return sorted;
  return sorted.filter((value, index) => index === 0 || value !== sorted[index - 1]);
}

/**
 * First identity id of a `DataInputRef`, used as the fourth sort key.
 *
 * "First" means first **after canonical ordering of the nested array**, i.e.
 * the lexicographic minimum — not `array[0]`. A ref carrying
 * `forecastRunIds: ["run-b", "run-a"]` must sort identically to one carrying
 * `["run-a", "run-b"]`, otherwise the parent order depends on the order the
 * producer happened to emit.
 */
export function firstRefId(ref: Record<string, unknown>): string {
  for (const key of ["forecastRunIds", "observationIds", "cellKeys"] as const) {
    const value = ref[key];
    if (!Array.isArray(value)) continue;
    const ids = value.filter((entry): entry is string => typeof entry === "string");
    if (ids.length > 0) return ids.reduce((min, id) => (id < min ? id : min));
  }
  for (const key of [
    "baselineVersion",
    "datasetVersion",
    "recordSetHash",
    "baselineHash",
  ] as const) {
    const value = ref[key];
    if (typeof value === "string") return value;
  }
  throw new CanonicalOrderError("inputRefs", "ref carries no identity id");
}
