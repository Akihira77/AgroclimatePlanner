# OPEN-18 Empirical Probe Evidence — Open-Meteo Grids (Indonesia)

- **Probed at (UTC):** `2026-11-28T07:07:55.387Z`
- **Points tested:** `18` coordinates across Java, Sumatra, Sulawesi, Bali, highlands, coasts, small islands, exact grid nodes, and midpoint boundaries.
- **Resolver tested:** `ECMWF_IFS025_GRID_SPEC` (`0.25° × 0.25°`, `origin=(-90, -180)`, `orientation=south-west`, `cellSelection=nearest-centre`).

## Summary Findings

| Endpoint / Model / Selection | Exact Match (`0.000000°` delta) | Finding |
|---|---|---|
| `forecast` (`ecmwf_ifs025`, `cell_selection=nearest`) | **18/18** | Identical `0.25°` regular `nearest-centre` lattice (including half-way tie-breaking toward `+∞`). |
| `ensemble` (`ecmwf_ifs025`, `cell_selection=nearest`) | **18/18** | Identical `0.25°` regular `nearest-centre` lattice matching `forecast`. |
| `archive` (`era5`, `cell_selection=nearest`) | **18/18** | Identical `0.25°` regular `nearest-centre` lattice matching `ecmwf_ifs025`. |
| `forecast` (`ecmwf_ifs025`, default `cell_selection=land`) | 13/18 | Shifts coastal/highland cells by `0.25°` toward land mask; **must pin `cell_selection=nearest`** in adapter URLs. |
| `seasonal` (`ecmwf_seas5` & `ecmwf_ec46`) | 0/18 | Uses ECMWF Octahedral Reduced Gaussian Grid (`~0.28103°` non-regular lat, variable lon per ring). **Cannot** share `0.25°` regular spec; kept deferred. |

## Raw Probe Table

| Point | Kind | Input `(lat, lon)` | Expected `0.25°` | Forecast (`nearest`) | Ensemble (`nearest`) | ERA5 (`nearest`) | Forecast (`default`) | SEAS5 (Gaussian) |
|---|---|---|---|---|---|---|---|---|
| Subang (sentra padi) | `inland` | `-6.322, 107.752` | `-6.25, 107.75` | `-6.25, 107.75` (Δ=0.000000) | `-6.25, 107.75` (Δ=0.000000) | `-6.25, 107.75` (Δ=0.000000) | `-6.25, 107.75` (Δ=0.00) | `-6.3232, 107.8808` |
| Lembang (dataran tinggi) | `highland` | `-6.814, 107.618` | `-6.75, 107.5` | `-6.75, 107.5` (Δ=0.000000) | `-6.75, 107.5` (Δ=0.000000) | `-6.75, 107.5` (Δ=0.000000) | `-6.75, 107.5` (Δ=0.00) | `-6.8852, 107.7000` |
| Karawang (padi utara) | `inland` | `-6.305, 107.305` | `-6.25, 107.25` | `-6.25, 107.25` (Δ=0.000000) | `-6.25, 107.25` (Δ=0.000000) | `-6.25, 107.25` (Δ=0.000000) | `-6.25, 107.25` (Δ=0.00) | `-6.3232, 107.2848` |
| Garut (lembah gunung) | `highland` | `-7.216, 107.907` | `-7.25, 108` | `-7.25, 108` (Δ=0.000000) | `-7.25, 108` (Δ=0.000000) | `-7.25, 108` (Δ=0.000000) | `-7.25, 108` (Δ=0.00) | `-7.1663, 108.0602` |
| Bogor (hujan tinggi) | `inland` | `-6.4675, 106.795` | `-6.5, 106.75` | `-6.5, 106.75` (Δ=0.000000) | `-6.5, 106.75` (Δ=0.000000) | `-6.5, 106.75` (Δ=0.000000) | `-6.5, 106.75` (Δ=0.00) | `-6.3232, 106.6887` |
| Grid exact .00/.00 (Jawa Tengah) | `grid_exact` | `-7, 110` | `-7, 110` | `-7, 110` (Δ=0.000000) | `-7, 110` (Δ=0.000000) | `-7, 110` (Δ=0.000000) | `-7, 110` (Δ=0.00) | `-7.1663, 109.8662` |
| Grid exact .25/.25 (Jawa Timur) | `grid_exact` | `-7.25, 111.25` | `-7.25, 111.25` | `-7.25, 111.25` (Δ=0.000000) | `-7.25, 111.25` (Δ=0.000000) | `-7.25, 111.25` (Δ=0.000000) | `-7.25, 111.25` (Δ=0.00) | `-7.1663, 111.3712` |
| Grid midpoint .125/.125 (Jawa Barat) | `grid_mid` | `-6.125, 107.125` | `-6, 107.25` | `-6, 107.25` (Δ=0.000000) | `-6, 107.25` (Δ=0.000000) | `-6, 107.25` (Δ=0.000000) | `-6, 107.25` (Δ=0.00) | `-6.0422, 107.2277` |
| Grid midpoint .375/.625 (Jawa Tengah) | `grid_mid` | `-7.375, 109.625` | `-7.25, 109.75` | `-7.25, 109.75` (Δ=0.000000) | `-7.25, 109.75` (Δ=0.000000) | `-7.25, 109.75` (Δ=0.000000) | `-7.5, 109.5` (Δ=0.25) | `-7.4473, 109.6309` |
| Grid near-mid .124/.126 | `grid_near_mid` | `-6.124, 107.126` | `-6, 107.25` | `-6, 107.25` (Δ=0.000000) | `-6, 107.25` (Δ=0.000000) | `-6, 107.25` (Δ=0.000000) | `-6, 107.25` (Δ=0.00) | `-6.0422, 107.2277` |
| Dieng (dataran tinggi 2000m) | `highland` | `-7.206, 109.908` | `-7.25, 110` | `-7.25, 110` (Δ=0.000000) | `-7.25, 110` (Δ=0.000000) | `-7.25, 110` (Δ=0.000000) | `-7.25, 110` (Δ=0.00) | `-7.1663, 109.8662` |
| Batu Malang (dataran tinggi) | `highland` | `-7.87, 112.525` | `-7.75, 112.5` | `-7.75, 112.5` (Δ=0.000000) | `-7.75, 112.5` (Δ=0.000000) | `-7.75, 112.5` (Δ=0.000000) | `-8, 112.5` (Δ=0.25) | `-8.0094, 112.5000` |
| Pesisir Indramayu (pantai utara) | `coastal` | `-6.327, 108.32` | `-6.25, 108.25` | `-6.25, 108.25` (Δ=0.000000) | `-6.25, 108.25` (Δ=0.000000) | `-6.25, 108.25` (Δ=0.000000) | `-6.5, 108.25` (Δ=0.25) | `-6.6042, 108.2392` |
| Pesisir Pangandaran (pantai selatan) | `coastal` | `-7.684, 108.65` | `-7.75, 108.75` | `-7.75, 108.75` (Δ=0.000000) | `-7.75, 108.75` (Δ=0.000000) | `-7.75, 108.75` (Δ=0.000000) | `-7.75, 108.5` (Δ=0.25) | `-7.7283, 108.4848` |
| Pulau Seribu / Pramuka (pulau kecil) | `small_island` | `-5.746, 106.614` | `-5.75, 106.5` | `-5.75, 106.5` (Δ=0.000000) | `-5.75, 106.5` (Δ=0.000000) | `-5.75, 106.5` (Δ=0.000000) | `-5.75, 106.5` (Δ=0.00) | `-6.0422, 106.3366` |
| Nusa Penida Bali (pulau kecil) | `small_island` | `-8.727, 115.544` | `-8.75, 115.5` | `-8.75, 115.5` (Δ=0.000000) | `-8.75, 115.5` (Δ=0.000000) | `-8.75, 115.5` (Δ=0.000000) | `-8.75, 115.5` (Δ=0.00) | `-8.5714, 115.4082` |
| Medan / Deli Serdang (Sumatra) | `inland` | `3.595, 98.672` | `3.5, 98.75` | `3.5, 98.75` (Δ=0.000000) | `3.5, 98.75` (Δ=0.000000) | `3.5, 98.75` (Δ=0.000000) | `3.5, 98.75` (Δ=0.00) | `3.5129, 98.6539` |
| Maros Sulsel (Sulawesi) | `inland` | `-5.005, 119.572` | `-5, 119.5` | `-5, 119.5` (Δ=0.000000) | `-5, 119.5` (Δ=0.000000) | `-5, 119.5` (Δ=0.000000) | `-5.25, 119.5` (Δ=0.25) | `-4.9180, 119.6091` |

## Architectural Decision

1. **Validated (`OPEN-18` closed for regular `0.25°` grids):** `(open-meteo, ecmwf_ifs025)` and `(open-meteo, era5)` are promoted to `evidence: "validated"` with `cell_selection=nearest` explicitly pinned in every adapter URL.
2. **Deferred honestly:** `(open-meteo, ecmwf_seas5)` and `(open-meteo, ecmwf_ec46)` use ECMWF's Reduced Gaussian Grid rather than a regular lat/lon lattice; they are NOT forced onto `0.25°` and remain outside `validatedOpenMeteoGridRegistry`.
