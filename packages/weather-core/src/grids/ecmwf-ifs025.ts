import { defineGridSpec, type GridRegistryEntry, type GridSpec } from "@agroclimate/contracts";

/**
 * Open-Meteo `ecmwf_ifs025` grid configuration (`ADR-008` / `OPEN-18`).
 *
 * Geometry is grade B measured (`nearest-centre`, global 0.25° regular lattice).
 * Product-identifier mapping remains grade C, so `evidence` is `"unvalidated"`:
 * `requireValidated` refuses it for production ingest claims.
 */
export const ECMWF_IFS025_GRID_SPEC: GridSpec = defineGridSpec({
  gridId: "open-meteo-ecmwf-ifs025-v1",
  originLat: "-90",
  originLon: "-180",
  stepLat: "0.25",
  stepLon: "0.25",
  latRange: ["-90", "90"],
  lonDomain: "global",
  orientation: "south-west",
  cellSelection: "nearest-centre",
  spatialResolutionKm: 25,
});

export const ECMWF_IFS025_GRID_ENTRY: GridRegistryEntry = Object.freeze({
  provider: "open-meteo",
  model: "ecmwf_ifs025",
  spec: ECMWF_IFS025_GRID_SPEC,
  evidence: "unvalidated",
});
