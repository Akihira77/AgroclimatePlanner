import { describe, expect, it } from "vitest";
import { GridConfigurationError } from "@agroclimate/contracts";

import { validatedOpenMeteoGridRegistry } from "./registry.js";

/**
 * Golden coordinate pairs from the 2026-11-28 empirical Open-Meteo probe
 * (`docs/review/open-18-open-meteo-ifs025-evidence.md`).
 * Every coordinate matched both `ecmwf_ifs025` and `era5` with `0.000000°` delta
 * when `cell_selection=nearest` is pinned.
 */
const GOLDEN_INDONESIA_POINTS: readonly {
  readonly label: string;
  readonly lat: string;
  readonly lon: string;
  readonly expectedCellKey: string;
}[] = [
  { label: "Subang", lat: "-6.322000", lon: "107.752000", expectedCellKey: "-6.25,107.75" },
  { label: "Lembang", lat: "-6.814000", lon: "107.618000", expectedCellKey: "-6.75,107.50" },
  { label: "Karawang", lat: "-6.305000", lon: "107.305000", expectedCellKey: "-6.25,107.25" },
  { label: "Garut", lat: "-7.216000", lon: "107.907000", expectedCellKey: "-7.25,108.00" },
  { label: "Bogor", lat: "-6.467500", lon: "106.795000", expectedCellKey: "-6.50,106.75" },
  { label: "Exact .00/.00", lat: "-7.000000", lon: "110.000000", expectedCellKey: "-7.00,110.00" },
  { label: "Exact .25/.25", lat: "-7.250000", lon: "111.250000", expectedCellKey: "-7.25,111.25" },
  { label: "Midpoint .125/.125", lat: "-6.125000", lon: "107.125000", expectedCellKey: "-6.00,107.25" },
  { label: "Midpoint .375/.625", lat: "-7.375000", lon: "109.625000", expectedCellKey: "-7.25,109.75" },
  { label: "Near-mid .124/.126", lat: "-6.124000", lon: "107.126000", expectedCellKey: "-6.00,107.25" },
  { label: "Dieng", lat: "-7.206000", lon: "109.908000", expectedCellKey: "-7.25,110.00" },
  { label: "Batu Malang", lat: "-7.870000", lon: "112.525000", expectedCellKey: "-7.75,112.50" },
  { label: "Indramayu coast", lat: "-6.327000", lon: "108.320000", expectedCellKey: "-6.25,108.25" },
  { label: "Pangandaran coast", lat: "-7.684000", lon: "108.650000", expectedCellKey: "-7.75,108.75" },
  { label: "Pulau Pramuka", lat: "-5.746000", lon: "106.614000", expectedCellKey: "-5.75,106.50" },
  { label: "Nusa Penida", lat: "-8.727000", lon: "115.544000", expectedCellKey: "-8.75,115.50" },
  { label: "Medan", lat: "3.595000", lon: "98.672000", expectedCellKey: "3.50,98.75" },
  { label: "Maros", lat: "-5.005000", lon: "119.572000", expectedCellKey: "-5.00,119.50" },
];

describe("OPEN-18 golden tests — validatedOpenMeteoGridRegistry", () => {
  it("permits requireValidated for ecmwf_ifs025 and era5 while refusing synthetic and seas5", () => {
    expect(
      validatedOpenMeteoGridRegistry.requireValidated({
        provider: "open-meteo",
        model: "ecmwf_ifs025",
      }).gridId,
    ).toBe("open-meteo-ecmwf-ifs025-v1");

    expect(
      validatedOpenMeteoGridRegistry.requireValidated({
        provider: "open-meteo",
        model: "era5",
      }).gridId,
    ).toBe("open-meteo-era5-v1");

    expect(() =>
      validatedOpenMeteoGridRegistry.requireValidated({
        provider: "synthetic",
        model: "synthetic_1deg_20x20",
      }),
    ).toThrow(GridConfigurationError);

    expect(() =>
      validatedOpenMeteoGridRegistry.requireValidated({
        provider: "open-meteo",
        model: "ecmwf_seas5",
      }),
    ).toThrow(GridConfigurationError);
  });

  it("matches all 18 empirically probed Indonesian coordinates for ecmwf_ifs025 and era5", () => {
    for (const pt of GOLDEN_INDONESIA_POINTS) {
      const ifs = validatedOpenMeteoGridRegistry.resolve(
        { provider: "open-meteo", model: "ecmwf_ifs025" },
        { lat: pt.lat, lon: pt.lon },
      );
      const era = validatedOpenMeteoGridRegistry.resolve(
        { provider: "open-meteo", model: "era5" },
        { lat: pt.lat, lon: pt.lon },
      );
      expect(ifs.cellKey, `${pt.label} ecmwf_ifs025`).toBe(pt.expectedCellKey);
      expect(era.cellKey, `${pt.label} era5`).toBe(pt.expectedCellKey);
    }
  });
});
