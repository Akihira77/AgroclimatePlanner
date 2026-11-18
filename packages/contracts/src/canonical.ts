/**
 * Canonicalisation — the single implementation for canonical JSON and, via
 * hash.ts, for every artifact hash.
 *
 * docs/architecture/provenance-contract.md §4 is normative. The invariant is:
 *
 *   identical computation inputs  ⇒  identical bytes  ⇒  identical SHA-256
 *
 * regardless of object key insertion order or the order a producer emitted a
 * set-like array in.
 *
 * Three decisions are enforced here rather than left to callers:
 *
 *   1. Array ordering is applied by the canonicaliser. A caller that has to
 *      pre-sort is a caller that can forget.
 *   2. An array with no declared rule throws. Preserving unknown order silently
 *      is how a set becomes order-dependent.
 *   3. Unsupported values throw. `undefined`, `NaN`, `Infinity`, and functions
 *      are not quietly turned into null or dropped.
 */

export class CanonicalizationError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`canonicalisation failed at ${path}: ${message}`);
    this.name = "CanonicalizationError";
  }
}

interface SetRule {
  readonly kind: "set";
  /** Property names that form the identity tuple, in order. Absent for string sets. */
  readonly orderBy?: readonly string[];
  /** Append the ref's canonical first id as the last key (inputRefs only). */
  readonly firstId?: boolean;
  readonly dedupe: boolean;
}

interface SequenceRule {
  readonly kind: "sequence";
}

/**
 * Keyed by **field name**, applied at any depth. Every array reachable from
 * `FieldSnapshotPayload` or `DerivationDescriptor` must appear here; anything
 * else throws, so adding an array to a hashed type is a deliberate act.
 */
export const canonicalArrayRules: Readonly<Record<string, SetRule | SequenceRule>> = {
  // FieldSnapshotPayload
  resolvedCells: { kind: "set", orderBy: ["provider", "model", "cellKey"], dedupe: true },
  observationsUsed: { kind: "set", orderBy: ["observationId"], dedupe: true },

  // DerivationDescriptor / DerivationProvenance
  inputRefs: { kind: "set", orderBy: ["kind", "role", "purpose"], firstId: true, dedupe: false },
  sourceArtifactHashes: { kind: "set", dedupe: true },
  missingRanges: { kind: "set", orderBy: ["startDate", "endDate"], dedupe: false },

  // Nested id arrays. Sorted before their parent is sorted, so `firstRefId`
  // never reads a producer's emission order.
  forecastRunIds: { kind: "set", dedupe: true },
  ingestionRunIds: { kind: "set", dedupe: true },
  cellKeys: { kind: "set", dedupe: true },
  observationIds: { kind: "set", dedupe: true },

  // Ordered, not set-like: the partition invariant makes position meaningful
  // (segments are contiguous and chronological). Never sorted, never deduped.
  evidenceSegments: { kind: "sequence" },
};

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * ECMAScript `Number::toString` — shortest round-trip form — with `-0` folded
 * to `0`. Non-finite values are rejected rather than serialised as `null`,
 * which is what `JSON.stringify` would do.
 */
function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new CanonicalizationError("$", `non-finite number ${String(value)} is not serialisable`);
  }
  return Object.is(value, -0) ? "0" : String(value);
}

function emit(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return formatNumber(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(emit).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([key, entry]) => `${JSON.stringify(key)}:${emit(entry)}`,
    );
    return `{${entries.join(",")}}`;
  }
  throw new CanonicalizationError("$", `unsupported value of type ${typeof value}`);
}

/**
 * First identity id of a `DataInputRef`, used as the fourth sort key.
 *
 * "First" means first **after** the nested array is ordered, i.e. the
 * lexicographic minimum. Reading element zero would make `inputRefs` order
 * depend on the order the provider returned run ids in.
 */
function firstRefId(ref: Record<string, unknown>): string {
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
  throw new CanonicalizationError("$.inputRefs", "ref carries no identity id");
}

function identityOf(item: unknown, rule: SetRule, path: string): string[] {
  if (!rule.orderBy) {
    if (typeof item !== "string") {
      throw new CanonicalizationError(path, "a string set holds non-string entries");
    }
    return [item];
  }
  if (item === null || typeof item !== "object" || Array.isArray(item)) {
    throw new CanonicalizationError(path, "an object set holds a non-object entry");
  }
  const record = item as Record<string, unknown>;
  const identity = rule.orderBy.map((key) => {
    const value = record[key];
    if (value === undefined || value === null) {
      throw new CanonicalizationError(path, `entry has no identity key "${key}"`);
    }
    return String(value);
  });
  if (rule.firstId) identity.push(firstRefId(record));
  return identity;
}

function canonicalizeArray(
  values: readonly unknown[],
  path: string,
  fieldName: string,
  stack: Set<object>,
): unknown[] {
  const rule = canonicalArrayRules[fieldName];
  if (!rule) {
    throw new CanonicalizationError(
      path,
      `array "${fieldName}" has no canonicalisation rule — declare whether it is a set or a sequence`,
    );
  }

  const items = values.map((value, index) =>
    canonicalizeValue(value, `${path}[${index}]`, undefined, stack),
  );
  if (rule.kind === "sequence") return items;

  const scored = items.map((item) => ({
    item,
    serialized: emit(item),
    identity: identityOf(item, rule, path),
  }));

  scored.sort((left, right) => {
    const byIdentity = compareIdentities(left.identity, right.identity);
    if (byIdentity !== 0) return byIdentity;
    // Final deterministic tie-breaker: the stable canonical representation.
    return compareStrings(left.serialized, right.serialized);
  });

  if (!rule.dedupe) return scored.map((entry) => entry.item);

  const out: unknown[] = [];
  let previous: (typeof scored)[number] | undefined;
  for (const entry of scored) {
    if (previous && compareIdentities(previous.identity, entry.identity) === 0) {
      if (previous.serialized !== entry.serialized) {
        throw new CanonicalizationError(
          path,
          `duplicate identity [${entry.identity.join(", ")}] with conflicting content`,
        );
      }
      continue;
    }
    out.push(entry.item);
    previous = entry;
  }
  return out;
}

function compareIdentities(left: readonly string[], right: readonly string[]): number {
  for (let index = 0; index < left.length; index += 1) {
    const compared = compareStrings(left[index] ?? "", right[index] ?? "");
    if (compared !== 0) return compared;
  }
  return 0;
}

function canonicalizeValue(
  value: unknown,
  path: string,
  fieldName: string | undefined,
  stack: Set<object>,
): unknown {
  if (value === null) return null;
  const type = typeof value;
  if (type === "boolean" || type === "string") return value;
  if (type === "number") {
    if (!Number.isFinite(value)) {
      throw new CanonicalizationError(path, `non-finite number ${String(value)}`);
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (type === "undefined") {
    throw new CanonicalizationError(path, "undefined is not serialisable — omit the key instead");
  }
  if (type !== "object") {
    throw new CanonicalizationError(path, `unsupported value of type ${type}`);
  }

  const object = value as object;
  if (stack.has(object)) throw new CanonicalizationError(path, "circular reference");
  stack.add(object);
  try {
    if (Array.isArray(value)) {
      if (fieldName === undefined) {
        throw new CanonicalizationError(
          path,
          "array found without a field name to look up its rule",
        );
      }
      return canonicalizeArray(value, path, fieldName, stack);
    }
    const entries = Object.keys(value as Record<string, unknown>).sort(compareStrings);
    const out: Record<string, unknown> = {};
    for (const key of entries) {
      out[key] = canonicalizeValue(
        (value as Record<string, unknown>)[key],
        `${path}.${key}`,
        key,
        stack,
      );
    }
    return out;
  } finally {
    stack.delete(object);
  }
}

/**
 * Canonical JSON: sorted object keys (UTF-16 code-unit order, not locale),
 * documented array ordering, compact output, no trailing whitespace.
 *
 * Strings retain their exact representation — no timestamps are normalised, so
 * `…T00:00:00Z` and `…T00:00:00.000Z` hash differently by design.
 */
export function canonicalJson(value: unknown): string {
  return emit(canonicalizeValue(value, "$", undefined, new Set<object>()));
}
