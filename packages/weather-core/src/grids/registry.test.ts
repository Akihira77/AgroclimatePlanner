import { describe, expect, it } from "vitest";
import {
  GRID_RESOLUTION_ALGORITHM_VERSION,
  GridConfigurationError,
  createSpatialResolution,
  defineGridSpec,
} from "@agroclimate/contracts";
import { syntheticGridRegistry } from "./registry.js";
import {
  SYNTHETIC_GRID_ENTRY,
  SYNTHETIC_GRID_ID,
  SYNTHETIC_GRID_MODEL,
  SYNTHETIC_GRID_PROVIDER,
  SYNTHETIC_GRID_SPEC,
} from "./synthetic.js";

/**
 * The pinned hash of the synthetic configuration.
 *
 * Editing `synthetic.ts` — a step, an origin, a range, the resolution figure, or
 * the hash preimage — changes this value, and the suite fails until the new hash
 * is reviewed and written here. Recomputing the hash from the same fields only
 * proves the function is deterministic; it never proves the configuration is the
 * one that was reviewed.
 */
const SYNTHETIC_GRID_HASH = "494d8e41fdac7d18193f8df78fe52f9d25c7a188f6f602482210d7580a9a8726";

/**
 * The registry in this package holds one synthetic grid and nothing else. No
 * assertion below is a claim about a real provider, and none reaches the network.
 */
const key = { provider: SYNTHETIC_GRID_PROVIDER, model: SYNTHETIC_GRID_MODEL };

describe("synthetic grid entry", () => {
  it("is labelled synthetic and declares no provider evidence", () => {
    expect(SYNTHETIC_GRID_ENTRY.evidence).toBe("synthetic");
    expect(SYNTHETIC_GRID_PROVIDER).toBe("synthetic");
    expect(SYNTHETIC_GRID_ID).toBe("synthetic-1deg-20x20");
    expect(SYNTHETIC_GRID_SPEC.gridId).toBe(SYNTHETIC_GRID_ID);
  });

  it("pins gridSpecHash with a literal fixture", () => {
    expect(SYNTHETIC_GRID_SPEC.gridSpecHash).toBe(SYNTHETIC_GRID_HASH);
  });

  it("recomputes that literal from the same reviewed fields", () => {
    const recomputed = defineGridSpec({
      gridId: SYNTHETIC_GRID_SPEC.gridId,
      originLat: SYNTHETIC_GRID_SPEC.originLat,
      originLon: SYNTHETIC_GRID_SPEC.originLon,
      stepLat: SYNTHETIC_GRID_SPEC.stepLat,
      stepLon: SYNTHETIC_GRID_SPEC.stepLon,
      latRange: SYNTHETIC_GRID_SPEC.latRange,
      lonDomain: SYNTHETIC_GRID_SPEC.lonDomain,
      lonRange: SYNTHETIC_GRID_SPEC.lonRange ?? ["-10", "10"],
      orientation: SYNTHETIC_GRID_SPEC.orientation,
      spatialResolutionKm: SYNTHETIC_GRID_SPEC.spatialResolutionKm,
    });
    expect(recomputed.gridSpecHash).toBe(SYNTHETIC_GRID_HASH);
    expect(SYNTHETIC_GRID_HASH).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is immutable at runtime", () => {
    expect(Object.isFrozen(SYNTHETIC_GRID_SPEC)).toBe(true);
    expect(Object.isFrozen(SYNTHETIC_GRID_ENTRY)).toBe(true);
    expect(() => {
      (SYNTHETIC_GRID_SPEC as { gridId: string }).gridId = "edited";
    }).toThrow(TypeError);
    expect(() => {
      (SYNTHETIC_GRID_SPEC.latRange as [string, string])[0] = "-11";
    }).toThrow(TypeError);
  });
});

describe("syntheticGridRegistry — known pair", () => {
  it("returns the registered spec for the exact (provider, model) pair", () => {
    expect(syntheticGridRegistry.specFor(key).gridId).toBe(SYNTHETIC_GRID_ID);
    expect(syntheticGridRegistry.specFor(key).gridSpecHash).toBe(SYNTHETIC_GRID_SPEC.gridSpecHash);
  });

  it("resolves deterministically through the contracts resolver", () => {
    const request = { lat: "-3.4", lon: "8.25" };
    const first = syntheticGridRegistry.resolve(key, request);
    const second = syntheticGridRegistry.resolve(key, request);
    expect(first).toEqual(second);
    expect(first.cellKey).toBe("-4.00,8.00");
  });

  it("reports the declared evidence without upgrading it", () => {
    expect(syntheticGridRegistry.evidenceFor(key)).toBe("synthetic");
  });
});

describe("syntheticGridRegistry — unknown pairs", () => {
  it("fails with unknown_model for an unknown provider holding a known model string", () => {
    const attempt = () =>
      syntheticGridRegistry.specFor({ provider: "not-a-provider", model: SYNTHETIC_GRID_MODEL });
    expect(attempt).toThrow(GridConfigurationError);
    expect(attempt).toThrow(/unknown_model/);
    expect(attempt).toThrow(/not-a-provider/);
    expect(attempt).toThrow(new RegExp(SYNTHETIC_GRID_MODEL));
  });

  it("fails with unknown_model for a known provider and an unknown model", () => {
    const attempt = () =>
      syntheticGridRegistry.specFor({ provider: SYNTHETIC_GRID_PROVIDER, model: "no-such-model" });
    expect(attempt).toThrow(/unknown_model/);
    expect(attempt).toThrow(/no-such-model/);
  });

  it("fails with unknown_model for a completely unknown pair", () => {
    expect(() =>
      syntheticGridRegistry.resolve({ provider: "ecmwf", model: "ifs025" }, { lat: "0", lon: "0" }),
    ).toThrow(/unknown_model/);
  });

  it("never falls back to the synthetic entry", () => {
    const attempt = () => syntheticGridRegistry.specFor({ provider: "synthetic", model: "other" });
    expect(attempt).toThrow(/unknown_model/);
    expect(syntheticGridRegistry.specFor(key).gridId).toBe(SYNTHETIC_GRID_ID);
  });

  it("offers no model-only lookup", () => {
    // @ts-expect-error — a bare model string is not a GridKey
    expect(() => syntheticGridRegistry.specFor(SYNTHETIC_GRID_MODEL)).toThrow(/unknown_model/);
  });
});

describe("syntheticGridRegistry — ingestion eligibility", () => {
  it("refuses the synthetic entry with grid_not_validated", () => {
    const attempt = () => syntheticGridRegistry.requireValidated(key);
    expect(attempt).toThrow(GridConfigurationError);
    expect(attempt).toThrow(/grid_not_validated/);
  });

  it("keeps the declared evidence synthetic after a refused ingest attempt", () => {
    expect(() => syntheticGridRegistry.requireValidated(key)).toThrow();
    expect(syntheticGridRegistry.evidenceFor(key)).toBe("synthetic");
  });
});

describe("syntheticGridRegistry — SpatialResolution integration", () => {
  it("produces a resolution that keeps every field the contract promises", () => {
    const request = { lat: "-3.40", lon: "8.25" };
    const resolution = createSpatialResolution(SYNTHETIC_GRID_ENTRY, request);
    expect(resolution.provider).toBe(SYNTHETIC_GRID_PROVIDER);
    expect(resolution.model).toBe(SYNTHETIC_GRID_MODEL);
    expect(resolution.gridId).toBe(SYNTHETIC_GRID_ID);
    expect(resolution.gridSpecHash).toBe(SYNTHETIC_GRID_SPEC.gridSpecHash);
    expect(resolution.resolutionAlgorithmVersion).toBe(GRID_RESOLUTION_ALGORITHM_VERSION);
    expect(resolution.evidence).toBe("synthetic");
    expect(resolution.requested).toEqual({ lat: "-3.40", lon: "8.25" });
    expect(resolution.anchor).toEqual({ lat: "-4.00", lon: "8.00" });
    expect(resolution.cellKey).toBe("-4.00,8.00");
  });

  it("invents no served coordinate and no distance", () => {
    const resolution = createSpatialResolution(SYNTHETIC_GRID_ENTRY, { lat: "0", lon: "0" });
    expect(resolution).not.toHaveProperty("servedCoordinate");
    expect(resolution).not.toHaveProperty("distanceKm");
    expect(Object.isFrozen(resolution)).toBe(true);
  });
});
