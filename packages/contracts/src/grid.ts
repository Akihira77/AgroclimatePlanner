import { canonicalJson } from "./canonical.js";
import { sha256Hex } from "./hash.js";

/**
 * Grid resolution and cell identity — `docs/architecture/climate-data-foundation.md`
 * §5.2.2–§5.2.7.
 *
 * Six things stay separate, because merging them is the defect this module exists
 * to prevent: the requested coordinate, the grid definition, the selected cell,
 * the served coordinate, the interpolation flag, and the serialized `cellKey`.
 * This module knows the first three. It never sees a served coordinate and it
 * cannot rebuild one from a key.
 *
 * Every identity computation is integer micro-degrees. A `number` appears only in
 * the returned `i`/`j` indices and in `spatialResolutionKm`, never as a
 * coordinate.
 */

const MICRO = 1_000_000;
const GLOBAL_SPAN_MICRO = 360 * MICRO;
/** Five integer digits ≈ 99 999°, enough for any longitude representation. */
const MAX_INTEGER_DIGITS = 5;

/**
 * A canonical decimal string: `0`, `-90`, `0.25`, `-6.210000`. No exponent, no
 * leading `+`, no bare `.5`, at most six fractional digits.
 */
const DECIMAL_PATTERN = /^-?(0|[1-9]\d*)(?:\.(\d{1,6}))?$/;

/**
 * v1 supports one orientation only: rows grow northward and columns grow
 * eastward from the south-west anchor of cell `(0, 0)`. A north-to-south or
 * east-to-west axis is a different resolver, not a negative step, because a
 * negative step would silently reverse the half-open interval rule as well.
 */
export const SUPPORTED_GRID_ORIENTATIONS = ["south-west"] as const;
export type GridOrientation = (typeof SUPPORTED_GRID_ORIENTATIONS)[number];

export type GridDomain = "global" | "bounded";

export interface GridSpecInput {
  readonly gridId: string;
  readonly originLat: string;
  readonly originLon: string;
  readonly stepLat: string;
  readonly stepLon: string;
  readonly latRange: readonly [string, string];
  readonly lonDomain: GridDomain;
  readonly lonRange?: readonly [string, string];
  readonly orientation: string;
  readonly spatialResolutionKm: number;
}

export interface GridSpec {
  readonly gridId: string;
  readonly originLat: string;
  readonly originLon: string;
  readonly stepLat: string;
  readonly stepLon: string;
  readonly latRange: readonly [string, string];
  readonly lonDomain: GridDomain;
  readonly lonRange?: readonly [string, string];
  readonly orientation: GridOrientation;
  readonly rowCount: number;
  readonly colCount: number;
  readonly spatialResolutionKm: number;
  readonly gridSpecHash: string;
}

export type GridConfigurationErrorCode =
  | "unsupported_grid_orientation"
  | "invalid_decimal"
  | "invalid_step"
  | "invalid_range"
  | "invalid_domain"
  | "precision_exceeds_grid"
  | "grid_spec_hash_mismatch"
  | "duplicate_grid_spec"
  | "unknown_model"
  | "grid_not_validated";

export class GridConfigurationError extends Error {
  constructor(
    readonly code: GridConfigurationErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "GridConfigurationError";
  }
}

export type CellResolutionErrorCode = "invalid_coordinate" | "out_of_grid";

export class CellResolutionError extends Error {
  constructor(
    readonly code: CellResolutionErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "CellResolutionError";
  }
}

export interface ResolvedGridCell {
  readonly gridId: string;
  readonly gridSpecHash: string;
  readonly i: number;
  readonly j: number;
  /** Anchor node of the cell, as a decimal string. Never a served coordinate. */
  readonly nodeLat: string;
  readonly nodeLon: string;
  readonly cellKey: string;
}

interface Decimal {
  readonly micro: number;
  readonly decimals: number;
}

function readDecimal(value: string, code: GridConfigurationErrorCode): Decimal {
  const match = DECIMAL_PATTERN.exec(value);
  if (!match) {
    throw new GridConfigurationError(code, `"${value}" is not a canonical decimal string`);
  }
  const fraction = match[2] ?? "";
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [integerPart = ""] = unsigned.split(".");
  if (integerPart.length > MAX_INTEGER_DIGITS) {
    throw new GridConfigurationError(code, `"${value}" is out of the supported range`);
  }
  const unsignedMicro = Number(integerPart) * MICRO + Number(fraction.padEnd(6, "0"));
  return {
    micro: negative ? -unsignedMicro : unsignedMicro,
    decimals: fraction.length,
  };
}

function formatDecimal(micro: number, decimals: number): string {
  const unit = 10 ** (6 - decimals);
  if (micro % unit !== 0) {
    throw new GridConfigurationError(
      "precision_exceeds_grid",
      `${micro}µ° cannot be written with ${decimals} decimal places`,
    );
  }
  const negative = micro < 0;
  const absolute = Math.abs(micro);
  const integerPart = Math.trunc(absolute / MICRO);
  const fractionPart = String(Math.trunc((absolute % MICRO) / unit)).padStart(decimals, "0");
  return `${negative ? "-" : ""}${integerPart}.${fractionPart}`;
}

/**
 * Mathematical floor division. `Math.floor(a / b)` is not used: it routes through
 * a float, and an exact grid boundary is the one input where rounding must not
 * decide the cell.
 */
function floorDiv(a: number, b: number): number {
  const quotient = Math.trunc(a / b);
  return a % b !== 0 && a < 0 !== b < 0 ? quotient - 1 : quotient;
}

interface GridPreimage {
  readonly cellAnchor: GridOrientation;
  readonly colCount: number;
  readonly gridId: string;
  readonly latMax: string;
  readonly latMin: string;
  readonly lonDomain: GridDomain;
  readonly lonMax?: string;
  readonly lonMin?: string;
  readonly originLat: string;
  readonly originLon: string;
  readonly rowCount: number;
  readonly spatialResolutionKm: number;
  readonly stepLat: string;
  readonly stepLon: string;
}

/**
 * Hash input, deliberately flat. `canonicalJson` refuses an array with no declared
 * ordering rule, and a grid range is ordered data, not a set — flattening avoids
 * teaching the shared canonicaliser about a new array kind for one hash.
 */
function preimageOf(spec: Omit<GridSpec, "gridSpecHash">): GridPreimage {
  return spec.lonDomain === "bounded"
    ? {
        cellAnchor: spec.orientation,
        colCount: spec.colCount,
        gridId: spec.gridId,
        latMax: spec.latRange[1],
        latMin: spec.latRange[0],
        lonDomain: spec.lonDomain,
        lonMax: spec.lonRange?.[1] ?? "",
        lonMin: spec.lonRange?.[0] ?? "",
        originLat: spec.originLat,
        originLon: spec.originLon,
        rowCount: spec.rowCount,
        spatialResolutionKm: spec.spatialResolutionKm,
        stepLat: spec.stepLat,
        stepLon: spec.stepLon,
      }
    : {
        cellAnchor: spec.orientation,
        colCount: spec.colCount,
        gridId: spec.gridId,
        latMax: spec.latRange[1],
        latMin: spec.latRange[0],
        lonDomain: spec.lonDomain,
        originLat: spec.originLat,
        originLon: spec.originLon,
        rowCount: spec.rowCount,
        spatialResolutionKm: spec.spatialResolutionKm,
        stepLat: spec.stepLat,
        stepLon: spec.stepLon,
      };
}

/** A frozen copy: callers keep their arrays, and the spec keeps its own. */
function frozenRange(range: readonly [string, string]): readonly [string, string] {
  return Object.freeze([range[0], range[1]]) as readonly [string, string];
}

function requireLatticePoint(delta: number, step: number, what: string): void {
  if (delta % step !== 0) {
    throw new GridConfigurationError("invalid_range", `${what} is not on the grid lattice`);
  }
}

function requireMultipleOf(
  span: number,
  step: number,
  code: GridConfigurationErrorCode,
  what: string,
): number {
  if (span <= 0 || step <= 0 || span % step !== 0) {
    throw new GridConfigurationError(code, `${what} must be a positive whole number of steps`);
  }
  return span / step;
}

/**
 * Validates a grid definition and freezes its identity.
 *
 * The orientation check runs first, so a provider whose axis is not yet supported
 * fails as `unsupported_grid_orientation` and not as a confusing range error.
 */
export function defineGridSpec(input: GridSpecInput): GridSpec {
  const orientation = SUPPORTED_GRID_ORIENTATIONS.find(
    (supported) => supported === input.orientation,
  );
  if (!orientation) {
    throw new GridConfigurationError(
      "unsupported_grid_orientation",
      `"${input.orientation}" is not supported; v1 supports ${SUPPORTED_GRID_ORIENTATIONS.join(", ")}`,
    );
  }
  if (input.gridId.trim().length === 0) {
    throw new GridConfigurationError("invalid_domain", "gridId must not be empty");
  }
  if (!(input.spatialResolutionKm > 0) || !Number.isFinite(input.spatialResolutionKm)) {
    throw new GridConfigurationError("invalid_range", "spatialResolutionKm must be positive");
  }

  const originLat = readDecimal(input.originLat, "invalid_decimal");
  const originLon = readDecimal(input.originLon, "invalid_decimal");
  const stepLat = readDecimal(input.stepLat, "invalid_decimal");
  const stepLon = readDecimal(input.stepLon, "invalid_decimal");
  const latMin = readDecimal(input.latRange[0], "invalid_decimal");
  const latMax = readDecimal(input.latRange[1], "invalid_decimal");

  if (stepLat.micro <= 0 || stepLon.micro <= 0) {
    throw new GridConfigurationError(
      "invalid_step",
      "stepLat and stepLon must be positive; a reversed axis is an unsupported orientation",
    );
  }
  if (latMin.micro < -90 * MICRO || latMax.micro > 90 * MICRO || latMax.micro <= latMin.micro) {
    throw new GridConfigurationError("invalid_range", "latRange must be inside [-90, 90]");
  }
  // Both bounds must be lattice points of the origin. Any lattice point is
  // allowed, not only the origin: a grid anchored at 0° can legitimately cover
  // -90°, and its row indices are then negative rather than invalid.
  requireLatticePoint(latMin.micro - originLat.micro, stepLat.micro, "latRange lower bound");
  requireLatticePoint(latMax.micro - originLat.micro, stepLat.micro, "latRange upper bound");
  const rowCount = requireMultipleOf(
    latMax.micro - latMin.micro,
    stepLat.micro,
    "invalid_range",
    "latRange span",
  );

  let lonRange: readonly [string, string] | undefined;
  let colCount: number;
  if (input.lonDomain === "bounded") {
    if (!input.lonRange) {
      throw new GridConfigurationError("invalid_domain", "a bounded grid requires lonRange");
    }
    const lonMin = readDecimal(input.lonRange[0], "invalid_decimal");
    const lonMax = readDecimal(input.lonRange[1], "invalid_decimal");
    requireLatticePoint(lonMin.micro - originLon.micro, stepLon.micro, "lonRange lower bound");
    requireLatticePoint(lonMax.micro - originLon.micro, stepLon.micro, "lonRange upper bound");
    colCount = requireMultipleOf(
      lonMax.micro - lonMin.micro,
      stepLon.micro,
      "invalid_range",
      "lonRange span",
    );
    lonRange = frozenRange(input.lonRange);
  } else if (input.lonDomain === "global") {
    if (input.lonRange) {
      throw new GridConfigurationError("invalid_domain", "a global grid does not take lonRange");
    }
    colCount = requireMultipleOf(GLOBAL_SPAN_MICRO, stepLon.micro, "invalid_step", "a global step");
  } else {
    throw new GridConfigurationError(
      "invalid_domain",
      `"${String(input.lonDomain)}" is not a longitude domain`,
    );
  }

  const withoutHash: Omit<GridSpec, "gridSpecHash"> = {
    gridId: input.gridId,
    originLat: input.originLat,
    originLon: input.originLon,
    stepLat: input.stepLat,
    stepLon: input.stepLon,
    latRange: frozenRange(input.latRange),
    lonDomain: input.lonDomain,
    ...(lonRange ? { lonRange } : {}),
    orientation,
    rowCount,
    colCount,
    spatialResolutionKm: input.spatialResolutionKm,
  };

  return Object.freeze({
    ...withoutHash,
    gridSpecHash: sha256Hex(canonicalJson(preimageOf(withoutHash))),
  });
}

/** Fails when a persisted or hand-written spec no longer matches its own hash. */
export function assertGridSpecIntegrity(spec: GridSpec): void {
  const recomputed = defineGridSpec({
    gridId: spec.gridId,
    originLat: spec.originLat,
    originLon: spec.originLon,
    stepLat: spec.stepLat,
    stepLon: spec.stepLon,
    latRange: spec.latRange,
    lonDomain: spec.lonDomain,
    ...(spec.lonRange ? { lonRange: spec.lonRange } : {}),
    orientation: spec.orientation,
    spatialResolutionKm: spec.spatialResolutionKm,
  });
  if (recomputed.gridSpecHash !== spec.gridSpecHash) {
    throw new GridConfigurationError(
      "grid_spec_hash_mismatch",
      `gridId "${spec.gridId}" was edited in place; a re-grid is a new model`,
    );
  }
}

export interface GridResolutionRequest {
  readonly lat: string;
  readonly lon: string;
}

/**
 * Maps a **requested** coordinate to a cell. The returned anchor is computed from
 * the cell indices; it is never the requested coordinate rounded to display
 * precision, and it is never the served coordinate.
 *
 * `decimals` covers the origin as well as the step: an origin of `0.123456` on a
 * `0.25` grid needs six places, and deriving precision from the step alone would
 * collapse distinct cells onto one key.
 */
export function resolveGridCell(spec: GridSpec, request: GridResolutionRequest): ResolvedGridCell {
  const lat = readCoordinate(request.lat);
  const lon = readCoordinate(request.lon);

  if (lat.micro < microOf(spec.latRange[0]) || lat.micro > microOf(spec.latRange[1])) {
    throw new CellResolutionError(
      "out_of_grid",
      `latitude ${request.lat} is outside ${spec.latRange[0]}..${spec.latRange[1]}`,
    );
  }

  const originLatMicro = microOf(spec.originLat);
  const originLonMicro = microOf(spec.originLon);
  const stepLatMicro = microOf(spec.stepLat);
  const stepLonMicro = microOf(spec.stepLon);

  let lonMicro = lon.micro;
  if (spec.lonDomain === "global") {
    // Longitude wraps only around a global grid's own origin. Latitude never wraps.
    while (lonMicro < originLonMicro) lonMicro += GLOBAL_SPAN_MICRO;
    while (lonMicro >= originLonMicro + GLOBAL_SPAN_MICRO) lonMicro -= GLOBAL_SPAN_MICRO;
  } else {
    const lonMin = microOf(spec.lonRange?.[0] ?? spec.originLon);
    const lonMax = microOf(spec.lonRange?.[1] ?? spec.originLon);
    if (lonMicro < lonMin || lonMicro > lonMax) {
      throw new CellResolutionError(
        "out_of_grid",
        `longitude ${request.lon} is outside ${spec.lonRange?.[0]}..${spec.lonRange?.[1]}`,
      );
    }
  }

  const rowStart = (microOf(spec.latRange[0]) - originLatMicro) / stepLatMicro;
  const colStart =
    spec.lonDomain === "bounded"
      ? (microOf(spec.lonRange?.[0] ?? spec.originLon) - originLonMicro) / stepLonMicro
      : 0;

  const i = floorDiv(lat.micro - originLatMicro, stepLatMicro);
  const j = floorDiv(lonMicro - originLonMicro, stepLonMicro);
  if (
    i < rowStart ||
    i >= rowStart + spec.rowCount ||
    j < colStart ||
    j >= colStart + spec.colCount
  ) {
    throw new CellResolutionError(
      "out_of_grid",
      `cell (${i}, ${j}) is outside the ${spec.rowCount}×${spec.colCount} grid`,
    );
  }

  const nodeLatMicro = originLatMicro + i * stepLatMicro;
  const nodeLonMicro = originLonMicro + j * stepLonMicro;
  const decimals = Math.max(
    2,
    decimalsOf(spec.originLat),
    decimalsOf(spec.originLon),
    decimalsOf(spec.stepLat),
    decimalsOf(spec.stepLon),
  );
  const nodeLat = formatDecimal(nodeLatMicro, decimals);
  const nodeLon = formatDecimal(nodeLonMicro, decimals);

  return Object.freeze({
    gridId: spec.gridId,
    gridSpecHash: spec.gridSpecHash,
    i,
    j,
    nodeLat,
    nodeLon,
    cellKey: `${nodeLat},${nodeLon}`,
  });
}

function readCoordinate(value: string): Decimal {
  const match = DECIMAL_PATTERN.exec(value);
  const integerPart = (value.startsWith("-") ? value.slice(1) : value).split(".")[0] ?? "";
  if (!match || integerPart.length > MAX_INTEGER_DIGITS) {
    throw new CellResolutionError(
      "invalid_coordinate",
      `"${value}" is not a coordinate decimal with at most six places`,
    );
  }
  return readDecimal(value, "invalid_decimal");
}

function microOf(value: string): number {
  return readDecimal(value, "invalid_decimal").micro;
}

function decimalsOf(value: string): number {
  const match = DECIMAL_PATTERN.exec(value);
  return match?.[2]?.length ?? 0;
}

/**
 * Registry identity. A `model` string is a provider's own label, so neither name
 * alone addresses a configuration: two providers may expose the same string with
 * different grids (ADR-007 D1).
 */
export interface GridKey {
  readonly provider: string;
  readonly model: string;
}

/**
 * How much is known about a configuration. `validated` requires grade A and B
 * evidence (a documented grid definition plus a measured protocol that separates
 * snapping from interpolation); anything less is `synthetic`. It is declared, never
 * inferred from a name, a resolution figure, or a passing test.
 */
export type GridEvidence = "synthetic" | "validated";

export interface GridRegistryEntry {
  readonly provider: string;
  readonly model: string;
  readonly spec: GridSpec;
  readonly evidence: GridEvidence;
}

export interface GridRegistry {
  specFor(key: GridKey): GridSpec;
  resolve(key: GridKey, request: GridResolutionRequest): ResolvedGridCell;
  evidenceFor(key: GridKey): GridEvidence;
  /** Ingest paths only. Returns the spec or throws for anything not `validated`. */
  requireValidated(key: GridKey): GridSpec;
}

interface RegisteredGrid {
  readonly spec: GridSpec;
  readonly evidence: GridEvidence;
}

function unknownGrid(key: GridKey): GridConfigurationError {
  return new GridConfigurationError(
    "unknown_model",
    `no grid spec for provider "${key.provider}" model "${key.model}"`,
  );
}

/**
 * One `GridSpec` per `(provider, model)`, enforced at registration. A second spec
 * for a pair that already has one is a re-grid, and a re-grid is a new `model`
 * string inside the same provider — not an in-place edit (5.2.5).
 *
 * Provider and model are stored as two nested maps rather than one joined string:
 * any delimiter can appear inside a name, and a collision there would resolve a
 * request against another configuration.
 */
export function createGridRegistry(entries: readonly GridRegistryEntry[]): GridRegistry {
  const byProvider = new Map<string, Map<string, RegisteredGrid>>();

  for (const entry of entries) {
    assertGridSpecIntegrity(entry.spec);
    let byModel = byProvider.get(entry.provider);
    if (!byModel) {
      byModel = new Map();
      byProvider.set(entry.provider, byModel);
    }
    if (byModel.has(entry.model)) {
      throw new GridConfigurationError(
        "duplicate_grid_spec",
        `provider "${entry.provider}" model "${entry.model}" already has a grid spec; a re-grid needs a new model string`,
      );
    }
    // Store a re-defined spec, not the caller's object: a hand-built spec with a
    // matching hash is otherwise mutable state inside the registry.
    byModel.set(entry.model, {
      spec: defineGridSpec({
        gridId: entry.spec.gridId,
        originLat: entry.spec.originLat,
        originLon: entry.spec.originLon,
        stepLat: entry.spec.stepLat,
        stepLon: entry.spec.stepLon,
        latRange: entry.spec.latRange,
        lonDomain: entry.spec.lonDomain,
        ...(entry.spec.lonRange ? { lonRange: entry.spec.lonRange } : {}),
        orientation: entry.spec.orientation,
        spatialResolutionKm: entry.spec.spatialResolutionKm,
      }),
      evidence: entry.evidence,
    });
  }

  const find = (key: GridKey): RegisteredGrid => {
    const found = byProvider.get(key.provider)?.get(key.model);
    if (!found) throw unknownGrid(key);
    return found;
  };

  // Closures, not `this`: a detached `resolve` must behave like `registry.resolve`.
  const specFor = (key: GridKey): GridSpec => find(key).spec;

  return Object.freeze({
    specFor,
    resolve(key: GridKey, request: GridResolutionRequest): ResolvedGridCell {
      return resolveGridCell(specFor(key), request);
    },
    evidenceFor(key: GridKey): GridEvidence {
      return find(key).evidence;
    },
    requireValidated(key: GridKey): GridSpec {
      const found = find(key);
      if (found.evidence !== "validated") {
        throw new GridConfigurationError(
          "grid_not_validated",
          `provider "${key.provider}" model "${key.model}" is ${found.evidence}; only a validated grid may reach an ingest path`,
        );
      }
      return found.spec;
    },
  });
}

/**
 * Semantics version of cell resolution — `docs/architecture/climate-data-foundation.md`
 * §5.2.9.2, `ADR-007` D3.
 *
 * Bump it when a change can move a request to a different cell, or change how a
 * result reproduces: the index arithmetic, the coordinate domain and wrapping rules,
 * the anchor derivation, or the `cellKey` format. It is deliberately **not** the
 * package version — a dependency bump that leaves cells alone must not re-point
 * stored identities — and it is deliberately **not** `gridSpecHash`, which pins a
 * configuration rather than the algorithm reading it.
 */
export const GRID_RESOLUTION_ALGORITHM_VERSION = "grid-resolve/1";

export type GridResolutionAlgorithmVersion = typeof GRID_RESOLUTION_ALGORITHM_VERSION;

/**
 * The reproducible result of mapping one requested coordinate to a cell.
 *
 * `requested` is the caller's coordinate, unchanged — never the anchor and never a
 * normalized form. `anchor` is the cell node the resolver computed. There is no
 * served coordinate and no `distanceKm`: neither exists before the first ingest, and
 * `0` is not a placeholder for an unknown distance (`ADR-007` D4).
 */
export interface SpatialResolution {
  readonly provider: string;
  readonly model: string;
  readonly gridId: string;
  readonly gridSpecHash: string;
  readonly resolutionAlgorithmVersion: GridResolutionAlgorithmVersion;
  readonly evidence: GridEvidence;
  readonly requested: {
    readonly lat: string;
    readonly lon: string;
  };
  readonly anchor: {
    readonly lat: string;
    readonly lon: string;
  };
  readonly i: number;
  readonly j: number;
  readonly cellKey: string;
}

/**
 * Assembles the result from a registry entry.
 *
 * It re-checks the entry's own `gridSpecHash` before resolving, because an entry
 * built by hand — or a spec mutated in place — need not have passed through
 * `createGridRegistry`, and a resolution minted from an edited lattice would carry
 * a hash that no longer describes it. The check costs one hash and fails with
 * `grid_spec_hash_mismatch`, the same typed error registration raises.
 *
 * Beyond that it adds no validation: `resolveGridCell` rejects an unparseable or
 * out-of-grid request, so a failed resolution throws and mints nothing. The
 * evidence is copied as declared; this function does not decide whether a grid is
 * fit to ingest.
 */
export function createSpatialResolution(
  entry: GridRegistryEntry,
  request: GridResolutionRequest,
): SpatialResolution {
  assertGridSpecIntegrity(entry.spec);
  const cell = resolveGridCell(entry.spec, request);
  return Object.freeze({
    provider: entry.provider,
    model: entry.model,
    gridId: cell.gridId,
    gridSpecHash: cell.gridSpecHash,
    resolutionAlgorithmVersion: GRID_RESOLUTION_ALGORITHM_VERSION,
    evidence: entry.evidence,
    requested: Object.freeze({ lat: request.lat, lon: request.lon }),
    anchor: Object.freeze({ lat: cell.nodeLat, lon: cell.nodeLon }),
    i: cell.i,
    j: cell.j,
    cellKey: cell.cellKey,
  });
}
