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
 * Four decisions are enforced here rather than left to callers:
 *
 *   1. Array ordering is applied by the canonicaliser. A caller that has to
 *      pre-sort is a caller that can forget.
 *   2. An array with no declared rule throws. Preserving unknown order silently
 *      is how a set becomes order-dependent.
 *   3. Unsupported values throw. `undefined`, `NaN`, `Infinity`, sparse arrays,
 *      and non-plain objects are not quietly turned into null, dropped, or `{}`.
 *   4. Key order is carried by an explicit sorted entry list, never by
 *      JavaScript object enumeration — which hoists integer-like keys into
 *      numeric order and would silently contradict the documented comparator.
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

  // Nested id arrays. Sorted before their parent is sorted, so the ref's first
  // id never reads a producer's emission order.
  forecastRunIds: { kind: "set", dedupe: true },
  ingestionRunIds: { kind: "set", dedupe: true },
  cellKeys: { kind: "set", dedupe: true },
  observationIds: { kind: "set", dedupe: true },

  // Ordered, not set-like: the temporal partition invariant makes position
  // meaningful. Canonicalisation neither sorts nor repairs this collection —
  // the domain validator owns chronology, overlap, and coverage.
  evidenceSegments: { kind: "sequence" },
};

/**
 * Canonicalised forms. Objects keep a sorted entry list instead of being
 * rebuilt as a plain object, because assignment into `{}` both loses an own
 * `__proto__` key and lets enumeration reorder integer-like keys.
 */
class ObjectNode {
  constructor(readonly entries: ReadonlyArray<readonly [string, Node]>) {}
}

class ArrayNode {
  constructor(readonly items: readonly Node[]) {}
}

type Node = null | boolean | number | string | ObjectNode | ArrayNode;

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * ECMAScript `Number::toString` — shortest round-trip form — with `-0` folded
 * to `0`. Non-finite values are rejected earlier, so this is defensive only.
 */
function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new CanonicalizationError("$", `non-finite number ${String(value)} is not serialisable`);
  }
  return Object.is(value, -0) ? "0" : String(value);
}

function emit(node: Node): string {
  if (node === null) return "null";
  if (typeof node === "boolean") return node ? "true" : "false";
  if (typeof node === "number") return formatNumber(node);
  if (typeof node === "string") return JSON.stringify(node);
  if (node instanceof ArrayNode) return `[${node.items.map(emit).join(",")}]`;
  const entries = node.entries.map(([key, value]) => `${JSON.stringify(key)}:${emit(value)}`);
  return `{${entries.join(",")}}`;
}

function describeObject(value: object): string {
  const prototype = Object.getPrototypeOf(value) as { constructor?: { name?: string } } | null;
  return prototype?.constructor?.name ?? "null-prototype object";
}

function fieldOf(node: ObjectNode, key: string): Node | undefined {
  return node.entries.find(([entryKey]) => entryKey === key)?.[1];
}

function requireString(node: Node | undefined, path: string, what: string): string {
  if (typeof node !== "string") {
    throw new CanonicalizationError(path, `${what} must be a string`);
  }
  return node;
}

/**
 * First identity id of a `DataInputRef`, used as the fourth sort key.
 *
 * "First" means first **after** the nested array is ordered, i.e. the
 * lexicographic minimum. Reading element zero would make `inputRefs` order
 * depend on the order the provider returned run ids in.
 */
function firstRefId(ref: ObjectNode, path: string): string {
  for (const key of ["forecastRunIds", "observationIds", "cellKeys"] as const) {
    const value = fieldOf(ref, key);
    if (!(value instanceof ArrayNode)) continue;
    const ids = value.items.map((item) => requireString(item, path, `${key} entry`));
    if (ids.length > 0) return ids.reduce((min, id) => (id < min ? id : min));
  }
  for (const key of [
    "baselineVersion",
    "datasetVersion",
    "recordSetHash",
    "baselineHash",
  ] as const) {
    const value = fieldOf(ref, key);
    if (typeof value === "string") return value;
  }
  throw new CanonicalizationError(path, "ref carries no identity id");
}

function identityOf(item: Node, rule: SetRule, path: string): string[] {
  if (!rule.orderBy) {
    if (typeof item !== "string") {
      throw new CanonicalizationError(path, "a string set holds non-string entries");
    }
    return [item];
  }
  if (!(item instanceof ObjectNode)) {
    throw new CanonicalizationError(path, "an object set holds a non-object entry");
  }
  const identity = rule.orderBy.map((key) => {
    const value = fieldOf(item, key);
    if (value === undefined || value === null) {
      throw new CanonicalizationError(path, `entry has no identity key "${key}"`);
    }
    if (typeof value === "object") {
      throw new CanonicalizationError(path, `identity key "${key}" must be a scalar`);
    }
    return String(value);
  });
  if (rule.firstId) identity.push(firstRefId(item, path));
  return identity;
}

function compareIdentities(left: readonly string[], right: readonly string[]): number {
  for (let index = 0; index < left.length; index += 1) {
    const compared = compareStrings(left[index] ?? "", right[index] ?? "");
    if (compared !== 0) return compared;
  }
  return 0;
}

/**
 * Builds the element list with an explicit loop instead of `map()`.
 *
 * Two reasons, both observable: `map()` preserves holes (so a sparse array
 * would emit `[,"x"]`, which is not JSON), and it *invokes* a getter defined at
 * an index. A canonicaliser that calls an accessor is executing caller code and
 * hashing a value that was never passed to it.
 */
function canonicalizeElements(
  values: readonly unknown[],
  path: string,
  stack: Set<object>,
): Node[] {
  const items: Node[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(values, index);
    if (!descriptor) {
      throw new CanonicalizationError(path, `sparse array: index ${index} is missing`);
    }
    if (!("value" in descriptor)) {
      throw new CanonicalizationError(
        `${path}[${index}]`,
        "accessor at an array index is not serialisable",
      );
    }
    items.push(canonicalizeValue(descriptor.value, `${path}[${index}]`, undefined, stack));
  }
  return items;
}

function canonicalizeArray(
  values: readonly unknown[],
  path: string,
  fieldName: string,
  stack: Set<object>,
): ArrayNode {
  const rule = canonicalArrayRules[fieldName];
  if (!rule) {
    throw new CanonicalizationError(
      path,
      `array "${fieldName}" has no canonicalisation rule — declare whether it is a set or a sequence`,
    );
  }

  const items = canonicalizeElements(values, path, stack);
  if (rule.kind === "sequence") return new ArrayNode(items);

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

  if (!rule.dedupe) return new ArrayNode(scored.map((entry) => entry.item));

  const out: Node[] = [];
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
  return new ArrayNode(out);
}

function canonicalizeObject(
  value: Record<string, unknown>,
  path: string,
  stack: Set<object>,
): ObjectNode {
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CanonicalizationError(
      path,
      `unsupported object type ${describeObject(value)} — convert it to a plain object explicitly`,
    );
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new CanonicalizationError(path, "symbol-keyed properties are not serialisable");
  }

  // Own enumerable string keys, then sorted with the documented comparator.
  // The result is an entry list, so nothing downstream can re-order it.
  const keys = Object.keys(value).sort(compareStrings);
  const entries: Array<readonly [string, Node]> = keys.map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) {
      throw new CanonicalizationError(path, `accessor property "${key}" is not serialisable`);
    }
    return [key, canonicalizeValue(descriptor.value, `${path}.${key}`, key, stack)] as const;
  });
  return new ObjectNode(entries);
}

function canonicalizeValue(
  value: unknown,
  path: string,
  fieldName: string | undefined,
  stack: Set<object>,
): Node {
  if (value === null) return null;
  if (typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new CanonicalizationError(path, `non-finite number ${String(value)}`);
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "undefined") {
    throw new CanonicalizationError(path, "undefined is not serialisable — omit the key instead");
  }
  if (typeof value !== "object") {
    throw new CanonicalizationError(path, `unsupported value of type ${typeof value}`);
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
    return canonicalizeObject(value as Record<string, unknown>, path, stack);
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
