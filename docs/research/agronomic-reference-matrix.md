# Agronomic Reference Matrix

Phase 0 deliverable. Evidence date: **2026-11-18**.

Source quality grades used throughout:

- **A** — official institutional or international research institution: Kementerian Pertanian RI / BRMP / Balitsa / BBSDLP / SOP, IRRI, FAO-56, CIMMYT, NSW DPI. (This line was previously narrower and contradicted its own usage in §2.)
- **B** — peer-reviewed journal
- **C** — thesis / university repository / government extension page quoting a primary source
- **D** — secondary, popular, or unverifiable (recorded only to be rejected)

Rule for the engine: a threshold is only eligible for a **hard constraint** when it has an **A** source. **B** may support a soft score. **C** may enter as a *soft* factor with a recorded caveat, never as a hard gate. **D** is never used. Anything absent is stored as `null` and produces `insufficient_data`, never a default.

Consequence, stated plainly because the earlier draft of §6.1 violated this rule: **all four crops' monthly-rainfall thresholds are grade C** (see §5), so no crop has a v1 hard rainfall gate. Hard constraints in v1 are limited to what has an A source: soil pH bands, flooding/drainage, paddy standing-water requirement, and the temperature stress windows in §1–§4 that cite IRRI/FAO/NSW DPI.

No number below was invented. Every "unverified" is a real gap found during research.

---

## 1. Padi / Rice (*Oryza sativa*) — lowland/paddy

| Property | Value | Grade | Source |
|---|---|---|---|
| Duration | 110–120 HST (Ciherang, Inpari 32); IR64 ~110–115 d in tropics | A/C | IRRI Rice Knowledge Bank; BBPP Ketindan |
| Vegetative phase | ±45–65 d (germination → panicle initiation) | A | IRRI RKB "Growth stages of the rice plant" |
| Reproductive phase | ±35 d (PI → flowering) | A | IRRI RKB |
| Ripening | ±30 d | A | IRRI RKB |
| Seasonal ETc (paddy) | 450–700 mm | A | FAO Land & Water 4 (s2022e) — "450–700 mm" |
| Total irrigated water use (Asia) | ~1300–1500 mm | A | IRRI RKB water management |
| Kc (FAO-56) | ini 1.05 · mid 1.20 · end 0.60–0.90 | A | FAO-56 Table 12 |
| Rainfed requirement | ET 3–7 mm/d + perkolasi 1–2 mm/d | A | Jurnal Sumberdaya Lahan (Kementan e-publikasi) |
| Optimum monthly rainfall | ~200 mm/month; 1500–2000 mm/yr, ≥4 wet months | C | ITB dissertation; Oldeman wet-month criterion (>200 mm) |
| Temperature optimum | 25–30 °C (lowland 22–27, highland 19–23); range 15–38 °C | C | ITB dissertation |
| Heat stress | anthesis >33–35 °C for 4–5 d → spikelet sterility | B | Jagadish et al., J. Exp. Bot. 58(7) 2007 |
| Cold stress | <20–22 °C for 10–14 d before heading → sterility | B | Indonesian agrotek review (Unsika) |
| Soil pH | 5.5–6.5 optimum; tolerates 4.0–7.0 | A/C | IRRI; UB thesis quoting IRRI 2007 |
| Flooding | standing water 5–10 cm, puddled; tolerant in vegetative, sensitive at flowering | A | IRRI RKB |
| Salinity | very sensitive at seedling; growth loss at EC 5–6 dS/m | A | Gregorio et al. (IRRI) salinity paper |
| Critical stage | **flowering/anthesis** for both drought and heat | A | IRRI RKB + Jagadish 2007 |
| Altitude | 0–650 m intensive; up to 1500 m in highlands | C | UPN Jatim thesis; var. Inpari 32 ≤600 m (BBPP Ketindan) |

Paddy-specific: water availability is a **hard** constraint — paddy requires standing water or assured irrigation. A paddy profile without irrigation status must return `insufficient_data`, not "poor".

---

## 2. Jagung / Maize (*Zea mays*)

| Property | Value | Grade | Source |
|---|---|---|---|
| Duration | Lamuru 90–95 HST; Bima 7 85; Gumarang 82; BISI-18 ~105 | A/C | BRMP Banten (Lamuru); J. Agronomi IPB; Univ. Bale Bandung journal |
| Phase split | vegetative 0–~50 HST; anthesis/silking ±58–61; grain fill → physiological maturity 90–110 | C | UB/Brawijaya & Unhas theses |
| Seasonal need | 500–800 mm | A | FAO Land & Water 4 |
| Kc (FAO-56) | ini 0.30 · mid 1.20 · end 0.60→0.35 | A | FAO-56 Table 12 / AQUASTAT staged 0.30/0.75/1.20/0.60 |
| Optimum monthly rainfall | 85–200 mm/month, evenly distributed; palawija threshold ≥100 mm (Oldeman) | C | Unhas thesis; ITB; JSL Kementan |
| Temperature | 21–34 °C, optimum 23–30 °C (germination ~30) | A/C | Kapuslitbangtan 2018 (ebook); NSW DPI Procrop |
| Heat stress | >38 °C water-transport failure; pollen lethal >40 °C if dry | A | NSW DPI Procrop (maize growth & development) |
| Critical stage | **silking/tasseling**, 10–14 d around flowering; yield loss 6–8 %/day of stress | A | NSW DPI Procrop; CIMMYT ASI literature |
| Drought loss at flowering | tasseling −20–41 %, silking −32–64 % | B | Field Crops Research / ScienceDirect 2025 |
| Soil pH | 5.0–7.5, optimum ~6.8; **not** waterlogged | A/C | Kapuslitbangtan 2018 |
| Salinity | yield decline above ECe ~1.7 dS/m (moderately sensitive) | A (general) | FAO/USDA-ERTH — **no Indonesian source found; flagged** |
| Altitude | 0–1200 m; mid-altitude 1000–1600 m with adapted material | C | Kapuslitbangtan; UB thesis |

Maize is the most climate-robust of the four in the engine sense: wide pH, wide rainfall band, short cycle — but its **flowering window is short and fragile**, so the engine must align the projected flowering date with the forecast, not just the planting date.

---

## 3. Kedelai / Soybean (*Glycine max*)

| Property | Value | Grade | Source |
|---|---|---|---|
| Duration | Grobogan ~76 HST; Anjasmoro 82.5–92.5; Wilis 85–90; general 75–100 | A | BRMP variety descriptions 2024; UNY soybean manual |
| Flowering onset | Anjasmoro 35.7–39.4 HST; Grobogan 30–32; Wilis ~39 | A | BRMP variety descriptions |
| Phase lengths (FAO-56 tropics, Dec planting) | init 15 + dev 15 + mid 40 + late 15 = 85 d | A | FAO-56 Table 11 |
| Kc (FAO-56, legumes) | ini 0.40 · mid 1.15 · end 0.50 | A | FAO-56 Table 12 |
| Seasonal ETc | **unverified** — commonly quoted 450–650 mm but not confirmed on the FAO-56 page; not used | — | — |
| Optimum monthly rainfall | 100–200 mm/month | C | UNY manual quoting Sumarno 2016 |
| Temperature | 21–34 °C, optimum 23–27 °C; germination slow <15 °C, soil optimum 30 °C | C | UNY manual (Sumarno 2016; Adisarwanto 2005) |
| High-temperature stress threshold | **unverified** | — | — |
| Soil pH | 6.0–6.8 optimum; <5.5 severe Al toxicity, very slow growth | C | UNY manual (Sofia 2007) |
| Drainage | must be well drained, never waterlogged; 30–40 cm furrows | C | UNY manual |
| Critical stage | **flowering → pod filling**; water deficit causes flower/pod abortion, largest impact at pod fill | C | UNY manual |
| Flood sensitivity per stage | **unverified** | — | — |
| Altitude | **unverified** (no official figure found); Grobogan described as widely adaptive | — | BRMP |

---

## 4. Cabai / Chili (*Capsicum annuum*)

| Property | Value | Grade | Source |
|---|---|---|---|
| First harvest | 90–110 HST (SOP Balitsa, red chili); hybrids 65–110; rawit Hiyung 100–115; Prima Agrihorti 115–149 | A | SOP Cabai Merah 2014 (Balitsa/BPTP Jabar); Ditjen Hortikultura variety list |
| Cycle | semai 3–4 wk → field vegetative ~1–45 HST → flowering 44–71 HST → continuous harvest for months | A/C | SOP Balitsa; Demak extension (Balitsa researcher) |
| Phase lengths (FAO-56 pepper) | init 25–30 + dev 35 + mid 40 + late 20 ≈ 125 d | A | FAO-56 Table 11 |
| Kc (FAO-56, Solanaceae) | ini 0.60 · mid 1.05 (1.15 with staking) · end 0.90 | A | FAO-56 Table 12 |
| Seasonal water | **unverified** total mm | — | — |
| Annual rainfall | red chili 600–1200 mm/yr, wet climate unsuitable; rawit 600–1250 mm/yr, 0–5 wet months / 4–6 dry months (Oldeman D3/E3) | A | SOP Balitsa; Kementan rawit book |
| Monthly optimum | **unverified** | — | — |
| Temperature | day 25–27 °C, night 18–20 °C (SOP) | A | SOP Balitsa |
| Heat stress threshold (flower drop >32 °C) | **unverified** — no official source found | — | — |
| Soil pH | 6–7; lime if <6 (dolomite 1–2 months pre-plant) | A | SOP Balitsa |
| Drainage | good drainage + aeration mandatory; prolonged flooding → disease/wilt; cv. Kencana tolerant ~5 d submergence | A | SOP Balitsa; Balitsa researcher via Demak |
| Critical stage | **flowering → fruit set**; rainy season = highest failure risk | A/B | Rawit book; Demak/Balitsa |
| Altitude | red chili ≤1400 m (variety classes 100–500 / 500–750 / 750–1000 / >1000 m); rawit 0.5–1250 m | A | SOP Balitsa; rawit book |

Chili is the most divergent profile: long cycle, continuous harvest, low flood tolerance, and a rainfall ceiling rather than floor. Applying one rainfall band formula across all four crops would be a modelling error — the engine needs per-crop constraint types (floor, band, ceiling, or stage-indexed).

---

## 5. Cross-crop summary

| Crop | Duration (HST) | Seasonal ETc | Opt. monthly rainfall | pH | Critical stage | Flood tolerance |
|---|---|---|---|---|---|---|
| Padi | 110–120 | 450–700 mm (+ percolation) | ~200 mm | 5.5–6.5 | flowering | high (paddy) |
| Jagung | 82–105 | 500–800 mm | 85–200 mm | 5.0–7.5 | silking | low |
| Kedelai | 76–100 | unverified | 100–200 mm | 6.0–6.8 | flowering–pod fill | very low |
| Cabai | 90–110 to first harvest, months of harvest | unverified | 600–1200 mm/yr **band** (annual, not monthly) | 6.0–7.0 | flowering–fruit set | very low (Kencana ~5 d) |

---

## 6. Structural implications for the agronomic engine (Phase 6)

1. **Constraint types differ per crop, and most are not hard-eligible yet.** Expressed as data, not prose, each crop profile needs a list of `{dimension, comparator ∈ {min,max,range,count,window}, value×unit, stage?, grade, severity}`. By grade, v1 can hard-gate only pH, drainage/flooding, and paddy standing-water. Rainfall differs in *shape* per crop (rice floor-heavy, maize even band, soybean band + strict drainage, chili upper-bounded band), but those numbers are grade C, so in v1 they contribute to a soft score with a caveat, not to exclusion. A single suitability formula is still invalid — but the invalidity is in the dimensions and stages, not in a three-letter label.
1b. **`insufficient_data` is per dimension, and an unknown dimension must never satisfy a constraint.** Required contract: `dimensionCoverage` = known / unknown / not-applicable for each of climate, water, soil, timing, risk; unknown contributes nothing and caps the maximum achievable level (e.g. at "conditional"); an unknown dimension that gates a hard constraint ⇒ `insufficient_data` for the whole window; no `score` is emitted when any dimension is unknown (a normalised score over known dimensions silently treats the missing one as average, which is a fabricated recommendation).
1c. **The engine is four computations, not one with a precision switch.** Stage alignment is only meaningful where the data has sub-monthly resolution: (a) days 0–14 — stage-aligned daily evaluation; (b) days 15–45 — stage-aligned weekly vs weekly climatology; (c) lead months 1–6 — the stage requirement restated as a **monthly** aggregate, compared to a monthly forecast; (d) lead months 7–12 — climatology comparison, which is a statement about the crop and the site, not about the coming season. `precision: daily | dekadal | monthly` cannot express this; the API needs `evaluationBasis`.
1d. **Cycle start must be defined per crop.** Rice and chili windows must state sowing vs transplant; `criticalStages[]` day offsets are meaningless otherwise, and a 9-day cultivar spread (Grobogan 30–32 HST to flowering vs Anjasmoro 35.7–39.4) is enough to move the critical stage into a different forecast month.
2. **Critical-stage alignment is the core computation, not planting-date weather.** Every profile must expose `criticalStages[]` with day offsets from planting, so the engine can test the forecast against the *right calendar slice*.
3. **Several thresholds are genuinely missing** (soybean ETc, chili monthly rainfall, soybean heat threshold, soybean altitude). Those must be `null` in v1 profiles and produce `insufficient_data` for the affected dimension — not a guessed number.
4. **`Kc` is available and citable** for all four from FAO-56. ET₀ comes from the weather layer. This makes a defensible ETc computation possible where providers expose ET₀ (Open-Meteo does).
5. **Variety duration is a range, not a scalar.** Profiles need `durationDays: { min, max, typical }` and the engine must evaluate the cycle at both extremes.
6. **Photo/icon identity is independent of agronomy.** Icons are deterministic generated assets (BRAINSTORM Phase 6), not sourced crop photography.

## 7. Open items

- **Citations are not yet resolvable.** Several figures rest on "ITB dissertation", "UB thesis", "Unhas thesis", "UNY manual", "J. Agronomi IPB" without author/year/URL. Phase 3 requires an agronomic-source entity with per-threshold references, so every threshold kept in a profile must first be resolved to a citable row (title, publisher, year, URL, accessed date, grade).
- **v1 catalog decision (decided 2026-11-18):** all four crops ship in v1, but soybean and chili carry **water = `insufficient_data`** (no verifiable monthly threshold / no ETc). Consequence: their suitability caps at `conditional`, and both must state the missing dimension in the reason list. This is the honest option and it must not be softened by a proxy until a graded threshold exists.
- Paddy water balance needs percolation + irrigation assumptions that are site-specific; the correct v1 answer is to require the plot's irrigation/drainage fields and refuse the water dimension when absent.
- No Indonesian source found for salinity thresholds of maize/soybean/chili under local conditions.
- Shallots (bawang merah) and mung bean (kacang hijau) not yet researched; add only when the catalog needs them.
- All four profiles need a Phase 6 review by an agronomist before being used for real planting decisions. `council` is not available in this environment.
