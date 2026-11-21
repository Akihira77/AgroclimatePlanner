import { describe, expect, it } from "vitest";
import {
  CellResolutionError,
  GridConfigurationError,
  SUPPORTED_GRID_ORIENTATIONS,
  assertGridSpecIntegrity,
  createGridRegistry,
  defineGridSpec,
  resolveGridCell,
  type GridSpecInput,
} from "../src/grid.js";

/**
 * Synthetic grids only. No vector below is a claim about a real provider; the
 * five provider configurations are still `BLOCKED_EXTERNAL_INPUT`
 * (`climate-data-foundation.md` §5.2.6).
 */
const BASE: GridSpecInput = {
  gridId: "synthetic-1deg",
  originLat: "0",
  originLon: "0",
  stepLat: "1",
  stepLon: "1",
  latRange: ["-90", "90"],
  lonDomain: "global",
  orientation: "south-west",
  spatialResolutionKm: 111,
};

const spec = (overrides: Partial<GridSpecInput>): ReturnType<typeof defineGridSpec> =>
  defineGridSpec({ ...BASE, ...overrides });

const bounded = (overrides: Partial<GridSpecInput>) =>
  spec({
    lonDomain: "bounded",
    latRange: ["-90", "90"],
    lonRange: ["-180", "180"],
    ...overrides,
  });

describe("GridSpec", () => {
  it("declares exactly one supported orientation", () => {
    expect(SUPPORTED_GRID_ORIENTATIONS).toEqual(["south-west"]);
  });

  it("rejects a north-to-south axis instead of reversing it with a negative step", () => {
    const attempt = () => spec({ orientation: "north-west" });
    expect(attempt).toThrow(GridConfigurationError);
    expect(attempt).toThrow(/unsupported_grid_orientation/);
  });

  it("rejects a negative step as an invalid step, not as an orientation", () => {
    const attempt = () => spec({ stepLat: "-1" });
    expect(attempt).toThrow(/invalid_step/);
  });

  it("requires a lonRange for a bounded grid", () => {
    expect(() => spec({ lonDomain: "bounded" })).toThrow(/invalid_domain/);
  });

  it("refuses a lonRange on a global grid", () => {
    expect(() => spec({ lonRange: ["0", "10"] })).toThrow(/invalid_domain/);
  });

  it("refuses a global step that does not divide 360°", () => {
    expect(() => spec({ stepLon: "0.7" })).toThrow(/invalid_step/);
  });

  it("refuses a range that is not a whole number of steps", () => {
    expect(() => spec({ latRange: ["-90", "90"], stepLat: "0.7" })).toThrow(/invalid_range/);
  });

  it("refuses a latitude range outside [-90, 90]", () => {
    expect(() => spec({ latRange: ["-91", "90"] })).toThrow(/invalid_range/);
  });

  it("refuses a decade string that is not canonical", () => {
    expect(() => spec({ originLat: "1e3" })).toThrow(/invalid_decimal/);
    expect(() => spec({ originLat: ".5" })).toThrow(/invalid_decimal/);
    expect(() => spec({ originLat: "0.1234567" })).toThrow(/invalid_decimal/);
  });

  it("detects an in-place edit through the committed hash", () => {
    const original = spec({ stepLat: "0.5" });
    const edited = { ...original, stepLat: "1" };
    expect(() => assertGridSpecIntegrity(edited)).toThrow(/grid_spec_hash_mismatch/);
  });

  it("accepts a spec whose hash was computed from the same fields", () => {
    expect(() => assertGridSpecIntegrity(spec({}))).not.toThrow();
  });
});

describe("resolveGridCell — golden vectors 1–12", () => {
  it.each<[string, string, string, number, number, string]>([
    ["1 interior point", "0.5", "0.5", 0, 0, "0.00,0.00"],
    ["2 lower edge is inclusive", "0", "0", 0, 0, "0.00,0.00"],
    ["3 an internal boundary starts the next cell", "1", "1", 1, 1, "1.00,1.00"],
    ["4 just below a boundary", "0.999999", "0.999999", 0, 0, "0.00,0.00"],
    ["5 just above a boundary", "1.000001", "1.000001", 1, 1, "1.00,1.00"],
  ])("vector %s", (_label, lat, lon, i, j, key) => {
    const cell = resolveGridCell(spec({}), { lat, lon });
    expect({ i: cell.i, j: cell.j, cellKey: cell.cellKey }).toEqual({ i, j, cellKey: key });
  });

  it("vector 6 — non-zero origin, negative latitude, floor not trunc", () => {
    const grid = bounded({
      gridId: "synthetic-0.05deg",
      originLat: "-90",
      originLon: "-180",
      stepLat: "0.05",
      stepLon: "0.05",
    });
    const cell = resolveGridCell(grid, { lat: "-6.21", lon: "106.79" });
    expect([cell.i, cell.j, cell.cellKey]).toEqual([1675, 5735, "-6.25,106.75"]);
  });

  it("vector 7 — a 0.25° resolution", () => {
    const grid = spec({ stepLat: "0.25", stepLon: "0.25" });
    const cell = resolveGridCell(grid, { lat: "-6.21", lon: "106.79" });
    expect([cell.i, cell.j, cell.cellKey]).toEqual([-25, 427, "-6.25,106.75"]);
  });

  it("vector 8 — a different resolution for the same input yields a different cell", () => {
    const grid = spec({ stepLat: "0.4", stepLon: "0.4" });
    const cell = resolveGridCell(grid, { lat: "-6.21", lon: "106.79" });
    expect([cell.i, cell.j, cell.cellKey]).toEqual([-16, 266, "-6.40,106.40"]);
  });

  it("vector 9 — truncation would give 0.00,0.00", () => {
    // Bounded, so the longitude is not wrapped into [0, 360) and the vector is
    // about floor division alone.
    const grid = bounded({});
    const cell = resolveGridCell(grid, { lat: "-0.1", lon: "-0.1" });
    expect([cell.i, cell.j, cell.cellKey]).toEqual([-1, -1, "-1.00,-1.00"]);
  });

  it("vector 10 — longitude wraps on a global grid, both representations agree", () => {
    const grid = spec({});
    const fromEast = resolveGridCell(grid, { lat: "0", lon: "359.5" });
    const fromWest = resolveGridCell(grid, { lat: "0", lon: "-0.5" });
    expect(fromWest.cellKey).toBe(fromEast.cellKey);
    expect(fromWest.cellKey).toBe("0.00,359.00");
  });

  it("vector 11 — invalid input produces no cell", () => {
    const grid = bounded({ lonRange: ["0", "10"], originLon: "0" });
    expect(() => resolveGridCell(grid, { lat: "91", lon: "0" })).toThrow(CellResolutionError);
    expect(() => resolveGridCell(grid, { lat: "0", lon: "400" })).toThrow(/out_of_grid/);
    expect(() => resolveGridCell(grid, { lat: "0", lon: "10" })).toThrow(/out_of_grid/);
  });

  it("vector 12 — a revision is a new model, not a new key format", () => {
    const first = spec({ gridId: "synthetic-1deg-rev-a" });
    const second = spec({ gridId: "synthetic-1deg-rev-b" });
    const left = resolveGridCell(first, { lat: "0.5", lon: "0.5" });
    const right = resolveGridCell(second, { lat: "0.5", lon: "0.5" });
    expect(right.cellKey).toBe(left.cellKey);
    expect(second.gridSpecHash).not.toBe(first.gridSpecHash);
  });

  it("rejects a coordinate that is not a canonical decimal", () => {
    const grid = spec({});
    for (const lat of ["1e3", ".5", "nan", "1.0000001", ""]) {
      expect(() => resolveGridCell(grid, { lat, lon: "0" })).toThrow(/invalid_coordinate/);
    }
  });

  it("never accepts a serialized key as input", () => {
    const grid = spec({});
    // The resolver takes a coordinate pair only; there is no key-based entry point
    // to reconstruct an anchor from.
    expect(() => resolveGridCell(grid, { lat: "0.00,0.00", lon: "0" })).toThrow(
      /invalid_coordinate/,
    );
  });
});

describe("serialization precision — F-01", () => {
  it("keeps an origin that needs more places than the step", () => {
    const grid = bounded({
      gridId: "synthetic-offset-origin",
      originLat: "0.123456",
      originLon: "0",
      stepLat: "0.25",
      stepLon: "0.25",
      latRange: ["0.123456", "10.123456"],
      lonRange: ["0", "10"],
    });
    const cell = resolveGridCell(grid, { lat: "0.2", lon: "0.2" });
    // The step alone needs two places; the origin needs six, so the key carries
    // six. Two decimals would have collapsed the anchor to "0.12".
    expect(cell.cellKey).toBe("0.123456,0.000000");
  });

  it("keeps a non-zero fractional origin exactly", () => {
    const grid = bounded({
      gridId: "synthetic-fractional-origin",
      originLat: "10.5",
      originLon: "10.5",
      stepLat: "0.25",
      stepLon: "0.25",
      latRange: ["10.5", "12.5"],
      lonRange: ["10.5", "12.5"],
    });
    const cell = resolveGridCell(grid, { lat: "10.6", lon: "10.6" });
    expect(cell.cellKey).toBe("10.50,10.50");
  });

  it("keeps a negative fractional origin and a negative anchor", () => {
    const grid = bounded({
      gridId: "synthetic-negative-origin",
      originLat: "-10.5",
      originLon: "-10.5",
      stepLat: "0.25",
      stepLon: "0.25",
      latRange: ["-10.5", "10.5"],
      lonRange: ["-10.5", "10.5"],
    });
    const cell = resolveGridCell(grid, { lat: "-0.6", lon: "-0.6" });
    expect([cell.i, cell.j, cell.cellKey]).toEqual([39, 39, "-0.75,-0.75"]);
  });

  it("round-trips: resolving an anchor returns the same cell and key", () => {
    const grid = bounded({
      gridId: "synthetic-0.05deg",
      originLat: "-90",
      originLon: "-180",
      stepLat: "0.05",
      stepLon: "0.05",
    });
    const first = resolveGridCell(grid, { lat: "-6.21", lon: "106.79" });
    const again = resolveGridCell(grid, { lat: first.nodeLat, lon: first.nodeLon });
    expect(again.cellKey).toBe(first.cellKey);
    expect([again.i, again.j]).toEqual([first.i, first.j]);
  });

  it("reports a node on the grid, never the requested coordinate", () => {
    const grid = spec({});
    const cell = resolveGridCell(grid, { lat: "0.9", lon: "0.9" });
    expect([cell.nodeLat, cell.nodeLon]).toEqual(["0.00", "0.00"]);
    expect(cell.cellKey).toBe(`${cell.nodeLat},${cell.nodeLon}`);
  });
});

describe("grid registry", () => {
  it("binds one spec per model", () => {
    const registry = createGridRegistry([
      { model: "synthetic-1", spec: spec({ gridId: "synthetic-1" }) },
      { model: "synthetic-2", spec: spec({ gridId: "synthetic-2" }) },
    ]);
    expect(registry.models()).toEqual(["synthetic-1", "synthetic-2"]);
    expect(registry.resolve("synthetic-1", { lat: "0.5", lon: "0.5" }).cellKey).toBe("0.00,0.00");
  });

  it("refuses two specs for one model, because a re-grid is a new model string", () => {
    expect(() =>
      createGridRegistry([
        { model: "synthetic-1", spec: spec({ gridId: "a" }) },
        { model: "synthetic-1", spec: spec({ gridId: "b" }) },
      ]),
    ).toThrow(/duplicate_grid_spec/);
  });

  it("refuses a model with no validated grid instead of guessing", () => {
    const registry = createGridRegistry([{ model: "synthetic-1", spec: spec({}) }]);
    expect(() => registry.resolve("ecmwf_ifs025", { lat: "0", lon: "0" })).toThrow(/unknown_model/);
  });
});
