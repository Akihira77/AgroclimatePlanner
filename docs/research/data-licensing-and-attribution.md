# Data Licensing and Attribution

Phase 0 deliverable. Evidence date: **2026-11-18**.
This document is an engineering summary of provider terms, not legal advice. Where terms were read verbatim the quote is given. Anything uncertain is flagged and must be confirmed before commercial launch.

---

## 1. Summary matrix

| Source | Free for commercial product? | Licence | Attribution required | Blocker |
|---|---|---|---|---|
| BMKG `api.bmkg.go.id/publik/*` (weather) | **No, not automatically** | BMKG Ketentuan Penggunaan (site ToU, last updated 2026-07-08) | "Sumber: BMKG" + logo + content title, access date, link | §9.3: commercial integration needs **written permission** |
| BMKG climate products (monthly/seasonal/ZOM/ENSO maps) | **No** | same ToU | same | no machine interface; §8.1 bans scraping |
| Open-Meteo free API | **No** (non-commercial only, verbatim) | CC BY 4.0 (data) + Terms (service) | "Weather data by Open-Meteo.com" link | paid plan required for commercial use |
| Open-Meteo paid API | Yes | CC BY 4.0 data | Open-Meteo link next to data | cost, not permission |
| Open-Meteo self-host | depends | AGPLv3 (software), data retains upstream licences | Open-Meteo + upstream | AGPL obligations if modified and offered over network; upstream bucket terms undocumented |
| ECMWF SEAS5 / EC46 data | Yes (via licensed distributor) | CC BY 4.0 + ECMWF Terms of Use | ECMWF attribution string | none for CC-BY products |
| Copernicus CDS (ERA5, SEAS5 hindcast) | **Yes** | Licence to Use Copernicus Products | "Contains modified Copernicus Climate Change Service information [year]" | none |
| CHIRPS | **Yes** | public domain **and** CC BY 4.0 | required (CC BY) — cite Funk et al. | none |
| NASA POWER | Yes | NASA open data policy | attribution per NASA guidance | none |
| GPM IMERG | Yes | US Government work | citation requested | none |

---

## 2. BMKG — the binding constraint

**Verbatim, `https://www.bmkg.go.id/ketentuan-penggunaan`:**

- §4.5 — "Pengaksesan layanan ... secara otomatis atau menggunakan metode machine-to-machine **wajib melalui jalur API resmi**."
- §8.1 — scraping with bots/scripts on the website interface is **prohibited**.
- §9.1 — attribution string required: **"Sumber: BMKG"**, plus logo per BMKG rules, plus a citation (content title, access date, author, original link).
- §9.3 — "Pengemasan ulang, integrasi ke aplikasi pihak ketiga, atau penggunaan data untuk tujuan **komersial wajib melalui izin tertulis resmi dari BMKG**."
- §3.2 — default access right is "penggunaan pribadi dan nonkomersial".

Data-page text ("format terbuka dan mudah digunakan kembali") conflicts with the ToU. The ToU is newer and controlling.

### Engineering consequences

1. The platform may call `api.bmkg.go.id/publik/prakiraan-cuaca` with attribution and ≤60 req/min/IP.
2. **It may not scrape** `bmkg.go.id` or `visklim.bmkg.go.id` for monthly/seasonal products. The "controlled import pathway" in BRAINSTORM Phase 4 must therefore be a **manual, admin-initiated upload of an officially obtained artifact** with provenance recorded — not an automated scrape.
3. A written cooperation request to BMKG (Biro Hukum/Humas/Kerja Sama) is a prerequisite for any commercial feature that republishes BMKG climate products. Until granted, BMKG climate products are **disabled by default** in the product.
4. Attribution must be rendered in the UI next to the data, not buried in a footer.

---

## 3. Open-Meteo — commercial use is not free

**Verbatim, `https://open-meteo.com/en/terms`:**

- Free tier: "Less than 10'000 API calls per day, 5'000 per hour and 600 per minute." Monthly: 300 000.
- "You may only use the free API services for **non-commercial purposes**."
- Commercial use includes "Websites or apps that have subscriptions or display advertisements."
- Data licence: CC BY 4.0. Attribution: link to `https://open-meteo.com/`.
- Paid tiers: Standard 1M calls/month, Professional 5M, Enterprise >50M; commercial use permitted on all paid tiers.
- Terms governed by Swiss law; liability capped at 12 months of fees.

### Engineering consequences

1. Development / demo / non-commercial use: free tier is fine, but a 10 000/day cap means **aggressive caching is mandatory**, not optional. Grid-cell reuse keyed by rounded coordinates and day is the required design (BRAINSTORM Phase 4 already demands this).
2. Any commercial launch requires either a paid plan or self-hosting.
3. Self-hosting: software is AGPLv3; running it unmodified is permissible, but modifications offered as a network service must be released. Upstream data licences still apply. Self-host pulls from Open-Meteo's data bucket — **volume/terms undocumented, must be confirmed before relying on it**.
4. Two attributions are required wherever ECMWF-derived data is shown: Open-Meteo **and** ECMWF.

---

## 4. ECMWF

**Verbatim, `https://apps.ecmwf.int/datasets/licences/general/`:**

- "ECMWF retains all Intellectual Property Rights and copyright over its data."
- Required wording: "this document/data/output/Results is/are based on data and products of the European Centre for Medium-Range Weather Forecasts (ECMWF)" with the prescribed copyright notice, licence statement and disclaimer.
- "You are free to: Share ... Adapt ... for any purpose, even commercially."

Real-time data at ≥0.4° resolution is open under CC BY 4.0 since July 2024. Seasonal raw fields are **not** in the Open Data portal. Commercial redistribution is allowed with attribution and no-warranty disclaimer; no member-state restriction for CC-BY products.

ECMWF also disclaims liability for errors or availability — the product must not imply ECMWF endorses it.

---

## 5. Copernicus / C3S

Licence to Use Copernicus Products: free, commercial use permitted, no endorsement implied, attribution "Copernicus Climate Change Service (C3S) implemented by ECMWF" / "Contains modified Copernicus Climate Change Service information [year]". The exact Rev. 12 clause text was **not fetched in full — confirm before ship**.

---

## 6. CHIRPS, NASA POWER, IMERG

- **CHIRPS v3.0** — **both** "in the public domain, as registered with Creative Commons" **and** licensed **CC BY 4.0** (verbatim, `chc.ucsb.edu/data/chirps3`), i.e. copyright waived but attribution expected. Citation: Funk et al. No commercial restriction. Prefer v3.0 (2025); v2 production ends after December 2026. `data.chc.ucsb.edu` timed out from this environment while `www.chc.ucsb.edu` responded — so the download host, not the project, is the problem; use GEE or a mirror, and attribute regardless.
- **NASA POWER** — NASA open data, commercial use allowed, attribution per NASA guidance. `community=AG` provides agronomic parameters.
- **GPM IMERG V07** — US Government work, effectively public domain; Final product ~3.5 months behind, so NRT use relies on Early/Late runs.

---

## 7. Attribution strings to implement (exact)

```
Sumber: BMKG
Weather data by Open-Meteo.com
Based on data and products of the European Centre for Medium-Range Weather Forecasts (ECMWF)
Contains modified Copernicus Climate Change Service information [YEAR]
Climate Hazards Center CHIRPS (Funk et al.)
NASA POWER (NASA Langley Research Center)
```

Rules:
1. Attribution lives inside the component that displays the data (chart footer, card caption), and again on a permanent `/data-sources` page with per-source terms text.
2. Every stored record keeps `provider`, `model`, `attribution`, `sourceUrl`, `licenceId` — provenance is data, not UI decoration.
3. If the user is told an anomaly is "versus normal", the baseline dataset must be named in the same view.

---

## 8. Open legal questions that block commercial launch

1. Written BMKG permission — status: **not obtained**. Feature flag required.
2. Open-Meteo paid plan purchase — status: **undecided** (cost vs self-host).
3. Self-host legality at commercial scale including upstream bucket terms — **unverified**.
4. Copernicus Licence Rev. 12 verbatim text — **not fully read**.
5. Whether an Indonesian legal entity is needed for the BMKG cooperation request — **unknown**.
6. Google Earth Engine (CHIRPS/IMERG) terms for commercial use of derived products — **not evaluated**; use direct HTTP/FTP instead if uncertain.
