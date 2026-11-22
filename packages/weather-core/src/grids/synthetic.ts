import { defineGridSpec, type GridRegistryEntry, type GridSpec } from "@agroclimate/contracts";

/**
 * The one synthetic grid, defined here so tests and future code do not each
 * invent their own identifiers.
 *
 * Nothing in this file describes a real provider. The provider and model strings
 * are marked `synthetic`, the lattice is a 20×20 one-degree patch around the
 * origin chosen for legibility, and `spatialResolutionKm` is the nominal
 * one-degree figure, not a measurement of any API. A real grid reaches
 * `packages/weather-core/src/grids/` only after it clears grade A + B evidence
 * (§5.2.6 of `climate-data-foundation.md`), and it lands as a `validated` entry,
 * never by editing this one.
 */
export const SYNTHETIC_GRID_PROVIDER = "synthetic";
export const SYNTHETIC_GRID_MODEL = "synthetic_1deg_20x20";
export const SYNTHETIC_GRID_ID = "synthetic-1deg-20x20";

/**
 * A bounded 20×20 lattice at one degree, south-west origin `(-10, -10)`.
 *
 * Bounded rather than global on purpose: the synthetic entry must not be read as
 * a statement about any provider's longitude convention, which is still open in
 * `OPEN-18`.
 */
export const SYNTHETIC_GRID_SPEC: GridSpec = defineGridSpec({
  gridId: SYNTHETIC_GRID_ID,
  originLat: "-10",
  originLon: "-10",
  stepLat: "1",
  stepLon: "1",
  latRange: ["-10", "10"],
  lonDomain: "bounded",
  lonRange: ["-10", "10"],
  orientation: "south-west",
  spatialResolutionKm: 111,
});

export const SYNTHETIC_GRID_ENTRY: GridRegistryEntry = Object.freeze({
  provider: SYNTHETIC_GRID_PROVIDER,
  model: SYNTHETIC_GRID_MODEL,
  spec: SYNTHETIC_GRID_SPEC,
  evidence: "synthetic",
});
