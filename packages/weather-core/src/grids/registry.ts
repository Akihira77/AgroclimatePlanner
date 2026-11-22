import { createGridRegistry, type GridRegistry } from "@agroclimate/contracts";
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
