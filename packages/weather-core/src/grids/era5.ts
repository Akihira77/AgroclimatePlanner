import { defineGridSpec, type GridRegistryEntry, type GridSpec } from "@agroclimate/contracts";

/**
 * Open-Meteo `era5` archive grid configuration (`OPEN-18`).
 *
 * Verified empirically across 18 Indonesian coordinates on 2026-11-28 against
 * `archive-api.open-meteo.com/v1/archive?models=era5&cell_selection=nearest`:
 * 18/18 returned exact 0.000000° coordinate match on the 0.25° regular lattice.
 */
export const ERA5_GRID_SPEC: GridSpec = defineGridSpec({
  gridId: "open-meteo-era5-v1",
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

export const ERA5_VALIDATED_GRID_ENTRY: GridRegistryEntry = Object.freeze({
  provider: "open-meteo",
  model: "era5",
  spec: ERA5_GRID_SPEC,
  evidence: "validated",
});
