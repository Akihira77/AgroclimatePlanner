import { createGridRegistry, type GridRegistry } from "@agroclimate/contracts";
import {
  ECMWF_IFS025_GRID_ENTRY,
  ECMWF_IFS025_VALIDATED_GRID_ENTRY,
} from "./ecmwf-ifs025.js";
import { ERA5_VALIDATED_GRID_ENTRY } from "./era5.js";
import { SYNTHETIC_GRID_ENTRY } from "./synthetic.js";

/**
 * The weather-core grid registry. It contains exactly one entry, and that entry
 * is synthetic.
 *
 * The name says so, because a caller who reads `syntheticGridRegistry` cannot
 * mistake it for provider coverage. No real grid is registered here, so every
 * real `(provider, model)` pair fails with `unknown_model` rather than borrowing
 * a lattice — and `requireValidated` refuses the only entry that exists, so no
 * ingest path can reach a cell through it.
 *
 * There is no model-only lookup, no default provider and no fallback: the
 * registry is `createGridRegistry` itself, not a second implementation of it.
 */
export const syntheticGridRegistry: GridRegistry = createGridRegistry([SYNTHETIC_GRID_ENTRY]);

/**
 * Registry including `open-meteo / ecmwf_ifs025` marked `unvalidated` (`ADR-008` /
 * `OPEN-18`). Useful for non-production cell resolution; `requireValidated` still
 * refuses every entry here.
 */
export const unvalidatedGridRegistry: GridRegistry = createGridRegistry([
  SYNTHETIC_GRID_ENTRY,
  ECMWF_IFS025_GRID_ENTRY,
]);

/**
 * Validated Open-Meteo regular 0.25° registry (`OPEN-18` empirical proof:
 * 18/18 exact Indonesian coordinate matches for `ecmwf_ifs025` & `era5`
 * with `cell_selection=nearest`). Excludes `ecmwf_seas5` (Reduced Gaussian Grid).
 */
export const validatedOpenMeteoGridRegistry: GridRegistry = createGridRegistry([
  SYNTHETIC_GRID_ENTRY,
  ECMWF_IFS025_VALIDATED_GRID_ENTRY,
  ERA5_VALIDATED_GRID_ENTRY,
]);
