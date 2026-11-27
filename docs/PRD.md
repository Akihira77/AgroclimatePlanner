# AGROCLIMATE PLANNER
## Product Requirements Document (PRD)

**Version:** 1.0 — Product Baseline & Implementation Reconciliation  
**Document date:** 27 November 2026  
**Repository:** [Akihira77/AgroclimatePlanner](https://github.com/Akihira77/AgroclimatePlanner)  
**Verified repository baseline:** `973aca923be9a94f1f0dd7f3cd8f0a696fd23cef`  
**Product category:** Agricultural Weather & Climate Planning Platform  
**Primary market:** Indonesia  
**Primary language:** Bahasa Indonesia  
**Product status:** Under development

---

# 1. Executive Summary

## 1.1 Product Vision

Agroclimate Planner adalah platform perencanaan pertanian berbasis data cuaca, iklim, karakteristik lahan, dan kebutuhan agronomis tanaman.

Tujuan utamanya adalah membantu pemilik atau pengelola lahan menjawab tiga pertanyaan:

1. Saya sebaiknya menanam apa?
2. Kapan waktu yang tepat untuk menanam?
3. Apa risiko cuaca dan iklim yang mungkin memengaruhi tanaman saya?

Agroclimate Planner bukan aplikasi prakiraan cuaca konvensional.

Aplikasi cuaca biasa menjawab:

> Apakah besok akan hujan?

Agroclimate Planner harus mampu menjawab:

> Apakah petak lahan saya cocok ditanami jagung sekarang, kapan fase pembungaan akan terjadi, dan apakah periode tersebut berisiko mengalami kekeringan atau suhu ekstrem?

Jawaban harus didasarkan pada data yang dapat ditelusuri, perhitungan agronomis yang deterministik, serta informasi ketidakpastian yang transparan.

## 1.2 Product Principles

Lima prinsip utama yang tidak boleh dilanggar:

1. **No unsourced numbers.** Tidak boleh menampilkan angka cuaca atau iklim yang tidak memiliki sumber dan provenance.
2. **No false precision.** Data bulanan tidak boleh ditampilkan seolah-olah merupakan prakiraan harian.
3. **Climatology is not forecast.** Normal historis harus selalu dibedakan dari prakiraan.
4. **Unknown agronomic inputs remain unknown.** Data tanah, air, atau kebutuhan tanaman yang tidak tersedia tidak boleh digantikan dengan asumsi buatan.
5. **Deterministic engine decides; AI explains.** AI hanya boleh menjelaskan hasil perhitungan yang telah dihasilkan oleh engine deterministik.

## 1.3 Target Product Outcome

Pengguna dapat:

- Membuat dan mengelola beberapa farm.
- Membuat beberapa petak lahan di setiap farm.
- Mencatat karakteristik tanah, air, dan kondisi lahan.
- Melihat cuaca aktual dan prakiraan yang tersedia.
- Memahami prospek iklim selama 12 bulan.
- Mengelola katalog tanaman dan varietas.
- Mengetahui kesesuaian tanaman terhadap suatu petak.
- Mendapatkan jendela waktu tanam.
- Melihat risiko pada fase pertumbuhan tanaman.
- Memantau seluruh rencana pertanian melalui kalender.
- Mendapatkan briefing berbahasa Indonesia dari AI yang bersumber pada data terverifikasi.
- Mengetahui kualitas, kebaruan, dan keterbatasan data yang digunakan.

---

# 2. Product Scope

## 2.1 Primary User

**Owner-operator**

Pemilik atau pengelola lahan yang:
- Memiliki atau mengelola satu atau lebih farm.
- Memiliki beberapa petak dengan kondisi berbeda.
- Menentukan jenis tanaman dan waktu tanam.
- Tidak harus memiliki latar belakang meteorologi atau ilmu data.
- Membutuhkan penjelasan yang mudah dipahami dalam Bahasa Indonesia.
- Menggunakan laptop untuk perencanaan dan ponsel ketika berada di lahan.

V1 tidak ditujukan untuk agronomist profesional atau organisasi pertanian berskala besar sebagai pengguna utama.

## 2.2 User Jobs

| ID | Job | Desired outcome |
|---|---|---|
| JOB-01 | Mengetahui kondisi setiap lahan | Memahami karakteristik dan batasan lahan |
| JOB-02 | Memahami cuaca dan iklim | Mengetahui kondisi yang relevan untuk pertanian |
| JOB-03 | Memilih tanaman | Mengetahui tanaman yang sesuai dengan kondisi lahan |
| JOB-04 | Menentukan waktu tanam | Mendapatkan jendela tanam yang dapat dipertanggungjawabkan |
| JOB-05 | Memahami risiko | Mengetahui fase pertumbuhan yang berpotensi terdampak |
| JOB-06 | Merencanakan aktivitas | Mengelola penanaman dan panen melalui kalender |
| JOB-07 | Memahami rekomendasi | Mendapatkan penjelasan berbasis data, bukan sekadar skor |

## 2.3 Product Boundary

### In Scope — V1

- Satu owner-operator.
- Multiple farms dan fields.
- Pengelolaan karakteristik lahan.
- Katalog empat tanaman awal.
- Weather data ingestion.
- Forecast dan climate outlook.
- Rolling 12-month outlook.
- Agronomic suitability engine.
- Planting window engine.
- Planting calendar.
- AI agricultural briefing.
- Source monitoring.
- Forecast provenance.
- Historical forecast verification.

### Explicitly Out of Scope — V1

- Yield prediction.
- Commodity prices dan market intelligence.
- Pest dan disease diagnosis.
- Pesticide scheduling.
- Fertilizer scheduling.
- IoT device integration.
- Native Android/iOS application.
- Multi-tenant organization management.
- Automatic irrigation control.
- Unverified annual daily forecasts.
- BMKG commercial republication without written permission.

---

# 3. Product Modules

| ID | Module | Responsibility | Priority |
|---|---|---|---|
| MOD-01 | Identity & Access | Registration, login, sessions, authorization | P0 |
| MOD-02 | Farm Management | Mengelola farm | P0 |
| MOD-03 | Field Management | Mengelola petak dan geometri | P0 |
| MOD-04 | Crop Catalog | Tanaman, varietas, dan profil agronomi | P0 |
| MOD-05 | Weather Data | Ingestion, normalization, persistence | P0 |
| MOD-06 | Climate Outlook | Rolling 12-month climate outlook | P0 |
| MOD-07 | Agronomic Engine | Evaluasi kesesuaian tanaman | P0 |
| MOD-08 | Planting Window Engine | Perhitungan jendela tanam | P0 |
| MOD-09 | Agricultural Calendar | Kalender aktivitas dan peluang tanam | P1 |
| MOD-10 | AI Analyst | Penjelasan dan briefing pertanian | P1 |
| MOD-11 | Monitoring | Monitoring data, ingestion, dan kualitas | P1 |
| MOD-12 | Forecast Verification | Evaluasi akurasi historis | P2 |
| MOD-13 | Local Observations | Catatan pengamatan aktual di lahan | P2 |
| MOD-14 | Historical Activities | Riwayat tanam dan panen | P1 |

Priority:
- P0: Essential for the core product.
- P1: Required for a useful complete experience.
- P2: Important extension after the main product works reliably.

---

# 4. Functional Requirements

## 4.1 Identity & Access Management

**Status repository: Implemented, with documentation reconciliation still outstanding.**

### Functional requirements

| ID | Requirement | Priority |
|---|---|---|
| AUTH-01 | User dapat melakukan registrasi | P0 |
| AUTH-02 | User dapat login menggunakan email dan password | P0 |
| AUTH-03 | Password disimpan menggunakan Argon2id | P0 |
| AUTH-04 | Session disimpan di PostgreSQL | P0 |
| AUTH-05 | Session menggunakan secure cookie | P0 |
| AUTH-06 | User dapat logout | P0 |
| AUTH-07 | User dapat melihat identitas melalui `/me` | P0 |
| AUTH-08 | Authenticated mutation harus memiliki CSRF protection | P0 |
| AUTH-09 | Request harus memvalidasi Origin | P0 |
| AUTH-10 | Rate limit untuk autentikasi | P0 |
| AUTH-11 | User hanya dapat mengakses resource miliknya | P0 |
| AUTH-12 | Session memiliki expiry dan revocation | P0 |
| AUTH-13 | Mendukung account recovery | P1 |
| AUTH-14 | Mendukung perubahan password | P1 |
| AUTH-15 | Mendukung penghapusan akun | P2 |

### Implemented

- Registration.
- Login.
- Logout.
- AuthGuard.
- `/me`.
- PostgreSQL sessions.
- Argon2id.
- CSRF synchronizer token.
- Origin validation.
- Rate limiting.
- Dedicated `app_auth` database role.
- Tenant identity boundary.
- Real-role database integration tests.

### Remaining

- Account recovery.
- Password reset.
- Account deletion policy.
- Final authentication documentation reconciliation.

---

## 4.2 Farm Management

**Status repository: Implemented and verified.**

### Functional requirements

| ID | Requirement | Priority |
|---|---|---|
| FARM-01 | Membuat farm | P0 |
| FARM-02 | Melihat seluruh farm milik user | P0 |
| FARM-03 | Melihat detail farm | P0 |
| FARM-04 | Memperbarui informasi farm | P0 |
| FARM-05 | Soft delete farm | P0 |
| FARM-06 | Pagination | P0 |
| FARM-07 | Sorting | P0 |
| FARM-08 | Mencegah penghapusan farm yang memiliki field aktif | P0 |
| FARM-09 | Menampilkan ringkasan farm | P1 |
| FARM-10 | Menampilkan jumlah field dan aktivitas | P1 |

### Data

- Farm ID.
- Owner ID.
- Name.
- Description.
- Location metadata.
- Timestamps.
- Deleted timestamp.

### Implemented API

- `POST /v1/farms`
- `GET /v1/farms`
- `GET /v1/farms/:farmId`
- `PATCH /v1/farms/:farmId`
- `DELETE /v1/farms/:farmId`

### Remaining

- Farm dashboard.
- Map overview.
- Aggregate statistics.
- UI implementation.

---

## 4.3 Field Management

**Status repository: Backend CRUD implemented and verified.**

Field merupakan unit utama analisis agronomi.

Setiap field dapat memiliki karakteristik yang berbeda walaupun berada di farm yang sama.

### Functional requirements

| ID | Requirement | Priority |
|---|---|---|
| FIELD-01 | Membuat field di farm | P0 |
| FIELD-02 | Mendukung Polygon GeoJSON | P0 |
| FIELD-03 | Menampilkan field | P0 |
| FIELD-04 | Memperbarui field | P0 |
| FIELD-05 | Soft delete field | P0 |
| FIELD-06 | Menentukan luas lahan | P0 |
| FIELD-07 | Validasi geometri | P0 |
| FIELD-08 | Mendukung soil type | P0 |
| FIELD-09 | Mendukung soil pH | P0 |
| FIELD-10 | Mendukung drainage condition | P0 |
| FIELD-11 | Mendukung irrigation availability | P0 |
| FIELD-12 | Mendukung elevation | P1 |
| FIELD-13 | Mendukung water source | P1 |
| FIELD-14 | Mendukung agricultural notes | P1 |
| FIELD-15 | Field history | P1 |
| FIELD-16 | Map visualization | P1 |

### Implemented API

- `POST /v1/fields`
- `GET /v1/fields`
- `GET /v1/fields/:fieldId`
- `PATCH /v1/fields/:fieldId`
- `DELETE /v1/fields/:fieldId`

### Implemented technical capabilities

- Polygon GeoJSON validation.
- PostGIS geometry.
- Automatic area calculation.
- Tenant-scoped access.
- Database-level ownership constraints.
- Geometry response validation.
- Stored geometry consistency checks.

### Partial / Missing

- Soil attributes are represented in the broader domain model but are not yet exposed through a complete field editing workflow.
- Irrigation and drainage semantics remain subject to unresolved domain decisions.
- Elevation enrichment.
- Field-to-provider-grid production mapping.
- Frontend map and field editor.

### Important open decisions

- `OPEN-17`: Point-shaped field handling. V1 does not require point fields.
- `OPEN-21`: Mapping of field text vocabularies to agronomic snapshot values.
- `OPEN-18`: Production grid selection and field-to-cell mapping.

---

## 4.4 Crop Catalog & Agronomic Profiles

**Status repository: Database schema and domain contracts exist; functional catalog and agronomic engine are not implemented.**

### Functional requirements

| ID | Requirement | Priority |
|---|---|---|
| CROP-01 | Menyediakan daftar tanaman | P0 |
| CROP-02 | Menyediakan varietas tanaman | P0 |
| CROP-03 | Menyediakan crop profile | P0 |
| CROP-04 | Mengelola growth stages | P0 |
| CROP-05 | Menyimpan kebutuhan temperatur | P0 |
| CROP-06 | Menyimpan kebutuhan air | P0 |
| CROP-07 | Menyimpan kebutuhan curah hujan | P0 |
| CROP-08 | Menyimpan kebutuhan tanah | P0 |
| CROP-09 | Menyimpan toleransi banjir dan kekeringan | P0 |
| CROP-10 | Menyimpan critical growth stages | P0 |
| CROP-11 | Menyimpan referensi ilmiah setiap threshold | P0 |
| CROP-12 | Versioning crop profile | P0 |
| CROP-13 | Mengelola cultivar | P1 |
| CROP-14 | Duplikasi profile | P1 |
| CROP-15 | Import/export catalog | P2 |

### Initial V1 crop catalog

Empat tanaman awal:

1. Padi.
2. Jagung.
3. Kedelai.
4. Cabai.

Setiap tanaman dapat memiliki banyak varietas.

### Agronomic profile requirements

Setiap profile harus mendukung:

- Crop identity.
- Cultivar identity.
- Growth duration range.
- Growth stage definitions.
- Critical stages.
- Temperature constraints.
- Water requirements.
- Rainfall requirements.
- Soil pH requirements.
- Drainage requirements.
- Flood tolerance.
- Drought tolerance.
- Altitude constraints.
- Source references.
- Evidence grade.
- Version identity.

### Scientific evidence rules

Source grades:

| Grade | Source | Allowed use |
|---|---|---|
| A | Official institution / primary authoritative research | Hard constraints or soft factors |
| B | Peer-reviewed research | Soft factors |
| C | Thesis or secondary institutional reference | Soft factors with caveat |
| D | Unverifiable secondary source | Not used |

Hard constraints require grade A evidence.

Unknown values must remain `null`.

### Initial crop evidence limitations

| Crop | Known strengths | Important gaps |
|---|---|---|
| Padi | Growth stages, water and soil references | Site-specific water balance |
| Jagung | Growth duration, temperature and critical flowering stage | Some local salinity and rainfall thresholds |
| Kedelai | Growth duration and flowering information | ETc, heat threshold and some water constraints |
| Cabai | Growth cycle, temperature and drainage information | Monthly rainfall and total water requirement |

Approved initial limitation:

- Kedelai: water dimension = `insufficient_data`.
- Cabai: water dimension = `insufficient_data`.

Their maximum suitability is therefore `conditional` until defensible evidence is available.

This is intentional, not an implementation bug.

### Implemented

- Database tables for crops, cultivars, crop profile versions, growth stages, constraints and source references.
- Domain data-model specifications.
- Agronomic reference matrix.
- Profile versioning design.

### Not implemented

- Crop CRUD API.
- Catalog seeding.
- Crop management UI.
- Agronomic profile editor.
- Functional profile validation.
- Agronomic calculation engine.

---

## 4.5 Weather Data Ingestion

**Status repository: Partially implemented; production operation blocked by external gates.**

### Functional requirements

| ID | Requirement | Priority |
|---|---|---|
| WX-01 | Provider adapter interface | P0 |
| WX-02 | Fetch daily forecasts | P0 |
| WX-03 | Fetch subseasonal forecasts | P0 |
| WX-04 | Fetch seasonal forecasts | P0 |
| WX-05 | Fetch historical climate data | P0 |
| WX-06 | Normalize units and temporal semantics | P0 |
| WX-07 | Persist source and model identity | P0 |
| WX-08 | Persist ForecastRun | P0 |
| WX-09 | Persist IngestionRun | P0 |
| WX-10 | Support retries | P0 |
| WX-11 | Support idempotency | P0 |
| WX-12 | Handle partial data | P0 |
| WX-13 | Handle provider schema changes | P0 |
| WX-14 | Handle provider rate limits | P0 |
| WX-15 | Record provenance | P0 |
| WX-16 | Monitor ingestion status | P1 |
| WX-17 | Budget and rate-limit controls | P1 |
| WX-18 | Automated scheduling | P1 |

### Initial provider strategy

Potential providers:

- BMKG.
- Open-Meteo Forecast API.
- Open-Meteo Seasonal API.
- Open-Meteo Historical Archive.
- ECMWF models.
- ERA5.

CHIRPS and NASA POWER were investigated as additional sources but are not part of the current implemented ingestion path.

### Implemented

- Provider HTTP transport abstraction.
- Failure taxonomy.
- Open-Meteo seasonal adapter.
- Open-Meteo daily adapter.
- Open-Meteo EC46 adapter.
- SEAS5 member daily adapter.
- ERA5 historical archive adapter.
- Daily precipitation normalization.
- Monthly member-total aggregation.
- PostgreSQL job queue.
- Worker runner.
- Lease and retry handling.
- ForecastRun and IngestionRun lifecycle.
- Forecast persistence.
- Weather-record supersession.
- Climatology baseline persistence.
- Seasonal member aggregate persistence.

### Not implemented or incomplete

- BMKG adapter.
- Production provider grid.
- Automated scheduler.
- Production fan-out.
- Budget management.
- Raw provider payload retention.
- General weather-source monitoring UI.
- Production operational pipeline.

### External gates

- `OPEN-03`: Commercial-use licensing / Open-Meteo plan.
- `OPEN-18`: Validated provider grid and cell identity.
- `OPEN-05`: Raw payload retention and reproducibility constraints.
- `OPEN-02`: BMKG commercial permission.

A successful fixture-based integration test does not mean production provider ingestion is enabled.

---

## 4.6 Weather Forecast & Climate Outlook

**Status repository: Partial. Climatology materialization and read API exist; seasonal outlook materialization remains incomplete.**

### Product requirement

The system must provide a rolling 12-month horizon.

Each month must preserve its actual data class and source identity.

### Approved horizon semantics

| Horizon | Evaluation basis | Data class |
|---|---|---|
| Lead days 0–14 | Daily | Weather forecast |
| Lead days 15–45 | Daily | Subseasonal forecast |
| Lead months 1–6 | Monthly | Seasonal forecast |
| Lead months 7–12 | Climatological monthly | Climatology |

The lead-month anchor is the next calendar month after forecast initialization.

The seasonal horizon above reflects the approved product decision: SEAS5 begins in the initialization month, so it supplies at most six future lead months under this definition.

### Monthly outlook semantics

`monthly_outlooks.value_mm` means:

Estimated precipitation accumulation for one calendar month, in millimetres.

Estimator:

| Data class | Estimator |
|---|---|
| `seasonal_forecast` | Mean of 50 complete member monthly totals |
| `climatology` | Mean of historical monthly totals |

The provider's `precipitation_mean` is not automatically the monthly accumulation value.

### Functional requirements

| ID | Requirement | Priority |
|---|---|---|
| CLIM-01 | Rolling 12-month outlook | P0 |
| CLIM-02 | Monthly precipitation accumulation | P0 |
| CLIM-03 | Seasonal ensemble mean | P0 |
| CLIM-04 | Historical monthly normal | P0 |
| CLIM-05 | Forecast initialization metadata | P0 |
| CLIM-06 | Data class distinction | P0 |
| CLIM-07 | Per-source freshness | P0 |
| CLIM-08 | Missing-data representation | P0 |
| CLIM-09 | Monthly anomaly | P1 |
| CLIM-10 | Seasonal ensemble spread | P2 |
| CLIM-11 | Probability / tercile products | P2 |
| CLIM-12 | Forecast verification | P2 |
| CLIM-13 | Temperature outlook | P2 |

### Implemented

- Climatology builder.
- ERA5 1991–2020 monthly normals.
- Baseline versioning.
- Baseline provenance.
- Climatology persistence.
- Climatology outlook assembler.
- Monthly outlook persistence.
- Fixed 12-month response contract.
- `GET /v1/climate/outlook`.
- Read-only API path.
- Strict response validation.
- Missing month handling.
- Active/superseded row handling.

### Still incomplete

- Seasonal outlook writer.
- Seasonal value materialization.
- Seasonal run identity on monthly outlook rows.
- Seasonal supersession.
- Freshness representation for the seasonal read response.
- Production grid resolution.
- Automated scheduling.
- Anomaly calculation.
- Ensemble spread.
- Probability and tercile outputs.

### Phase 5.7 breakdown

| Sub-phase | Status |
|---|---|
| 5.7A — Climatology materialization | Implemented |
| 5.7B — Climatology read API | Implemented |
| 5.7C — Seasonal source-selection contract | Documentation implemented |
| 5.7D — Seasonal materialization | Not started at verified baseline |
| 5.8 — Data quality and operations | Not started |

---

## 4.7 Agronomic Suitability Engine

**Status repository: Not started. Domain and physical data-model foundations exist.**

### Objective

Evaluate whether a crop and cultivar are suitable for a particular field and planting period.

This is the core product differentiator.

### Functional requirements

| ID | Requirement | Priority |
|---|---|---|
| AGR-01 | Evaluate crop-field compatibility | P0 |
| AGR-02 | Evaluate soil compatibility | P0 |
| AGR-03 | Evaluate water availability | P0 |
| AGR-04 | Evaluate rainfall suitability | P0 |
| AGR-05 | Evaluate temperature suitability | P0 |
| AGR-06 | Evaluate growth-stage weather | P0 |
| AGR-07 | Evaluate drought risk | P0 |
| AGR-08 | Evaluate flooding risk | P0 |
| AGR-09 | Evaluate heat stress | P0 |
| AGR-10 | Explain every dimension | P0 |
| AGR-11 | Report insufficient inputs | P0 |
| AGR-12 | Version engine and input data | P0 |
| AGR-13 | Compare multiple crops | P1 |
| AGR-14 | Compare cultivars | P1 |
| AGR-15 | Explain suitability changes | P1 |

### Suitability categories

- `excellent`
- `good`
- `conditional`
- `poor`
- `insufficient_data`

Do not assume that a single numerical score is sufficient.

### Dimension model

At minimum:

- Climate.
- Water.
- Soil.
- Timing.
- Risk.

Each dimension must report:

- Known.
- Unknown.
- Not applicable.

Unknown data cannot be silently treated as average or neutral.

A missing input that blocks a hard constraint must produce an insufficient-data result.

### Engine requirements

- Pure deterministic calculations.
- No database access inside the core calculation.
- No AI-generated thresholds.
- Versioned crop profiles.
- Versioned engine.
- Explicit input snapshot.
- Provenance for all consumed climate inputs.
- Reproducible output.
- Stage-aligned evaluation.

### Not implemented

- `packages/agronomy`.
- Suitability calculation.
- Crop comparison.
- Suitability API.
- Suitability UI.
- Agronomic validation suite.

### Important blockers

- `OPEN-18`: Production climate cell mapping.
- `OPEN-26`: EvidenceSegment partition validator.
- `OPEN-27`: Secure worker field-to-cell discovery.
- Crop catalog seeding.
- Agronomist review.

---

## 4.8 Planting Window Engine

**Status repository: Not started. Database tables and domain contracts exist.**

### Objective

Calculate practical periods when a crop can be planted, accounting for its entire growth cycle.

A planting window is a date range, not a single date, whenever forecast resolution does not justify a precise date.

### Functional requirements

| ID | Requirement | Priority |
|---|---|---|
| PW-01 | Generate candidate planting windows | P0 |
| PW-02 | Evaluate crop duration range | P0 |
| PW-03 | Align growth stages with weather periods | P0 |
| PW-04 | Evaluate critical stages | P0 |
| PW-05 | Calculate dimension coverage | P0 |
| PW-06 | Attach evidence segments | P0 |
| PW-07 | Explain risks and missing inputs | P0 |
| PW-08 | Persist suitability runs | P0 |
| PW-09 | Version planting windows | P0 |
| PW-10 | Compare planting windows | P1 |
| PW-11 | Detect improved planting opportunities | P1 |
| PW-12 | Recompute after input changes | P1 |

### Critical rule

A crop must be evaluated across its complete growth cycle.

Example:

For maize, it is insufficient to evaluate only rainfall on the planting date. The engine must also evaluate the flowering/silking period because that is a critical stage.

### Evaluation basis

| Period | Evaluation |
|---|---|
| 0–14 days | Daily |
| 15–45 days | Subseasonal |
| 46 days onward through seasonal coverage | Monthly |
| Beyond seasonal coverage | Climatology |

Do not claim daily precision for monthly climatology.

### Evidence segments

A planting window can cross multiple data classes.

It must preserve segments that explain which data source and resolution informed each portion of the crop cycle.

### Not implemented

- Planting window calculation.
- EvidenceSegment runtime validator.
- Suitability run orchestration.
- Recompute worker.
- Window persistence workflow.
- Planting window API.

---

## 4.9 Agricultural Calendar & Dashboard

**Status repository: Not started.**

### Objective

Provide a visual planning surface that combines farms, fields, crops, planting windows, risks, and agricultural activities.

### Functional requirements

| ID | Requirement | Priority |
|---|---|---|
| CAL-01 | Annual calendar | P1 |
| CAL-02 | Monthly calendar | P1 |
| CAL-03 | Daily detail | P1 |
| CAL-04 | Crop planting markers | P1 |
| CAL-05 | Harvest markers | P1 |
| CAL-06 | Suitability indicators | P1 |
| CAL-07 | Weather and climate overlays | P1 |
| CAL-08 | Risk markers | P1 |
| CAL-09 | Overflow handling | P1 |
| CAL-10 | Filter by farm and field | P1 |
| CAL-11 | Compare planting windows | P1 |
| CAL-12 | Show source and freshness | P1 |

### Dashboard overview

The dashboard should answer:

- What is happening across my farms?
- Which fields have suitable planting windows?
- Which opportunities are approaching?
- Which fields have elevated climate risks?
- Which data sources are stale or unavailable?
- Which activities are planned or overdue?

### Not implemented

No functional dashboard screens, calendar UI, or visualization components have been found in the verified repository.

---

## 4.10 AI Agricultural Analyst

**Status repository: Not started. Database schema and provenance design exist.**

### Objective

Provide natural-language explanations of weather, climate, crop suitability, and planting opportunities.

AI is an explanation layer, not the source of agricultural truth.

### Functional requirements

| ID | Requirement | Priority |
|---|---|---|
| AI-01 | Summarize climate outlook | P1 |
| AI-02 | Explain planting recommendations | P1 |
| AI-03 | Explain crop risks | P1 |
| AI-04 | Answer questions about a field | P1 |
| AI-05 | Explain why suitability changed | P1 |
| AI-06 | Explain missing data | P1 |
| AI-07 | Generate Indonesian briefings | P1 |
| AI-08 | Cite structured evidence | P0 |
| AI-09 | Validate AI output against schema | P0 |
| AI-10 | Persist briefing provenance | P0 |
| AI-11 | Refuse unsupported numerical claims | P0 |

### AI context

AI may receive:
- Weather forecast summaries.
- Seasonal outlook.
- Climatology.
- Suitability results.
- Planting windows.
- Field attributes.
- Source metadata.
- Data availability and freshness.

AI must not receive:
- Database credentials.
- Other users' data.
- Unnormalized provider payloads.
- Arbitrary data that has not passed the domain contract.

### Required behavior

If the deterministic engine says `insufficient_data`, AI must explain the missing input.

It must not generate a confident recommendation to compensate.

If the engine has not calculated a planting date, AI cannot invent one.

### Not implemented

- `packages/ai`.
- LLM provider integration.
- Prompt/version management.
- Briefing generation.
- Briefing API.
- AI chat interface.
- Output verification.
- Briefing persistence workflow.

---

## 4.11 Source Monitoring & Data Quality

**Status repository: Foundation partially implemented; monitoring product not implemented.**

### Functional requirements

| ID | Requirement | Priority |
|---|---|---|
| MON-01 | Show last successful ingestion | P1 |
| MON-02 | Show source and model | P1 |
| MON-03 | Show forecast initialization | P1 |
| MON-04 | Show freshness | P1 |
| MON-05 | Show spatial coverage | P1 |
| MON-06 | Show temporal coverage | P1 |
| MON-07 | Show failed ingestion | P1 |
| MON-08 | Show retry status | P1 |
| MON-09 | Detect abnormal source changes | P1 |
| MON-10 | Detect missing forecast runs | P1 |
| MON-11 | Show baseline version | P1 |
| MON-12 | Provide operational audit | P1 |

### Existing foundation

- PostgreSQL job queue.
- Lease and retry mechanisms.
- ForecastRun.
- IngestionRun.
- Structured failure taxonomy.
- Idempotent persistence.
- Source provenance.
- Baseline versioning.

### Missing

- Monitoring API.
- Operational dashboard.
- Scheduled source audit.
- Data quality audit package.
- Alerting.
- Operations runbook.
- Long-running scheduled verification.

### Phase 5.8

Phase 5.8 must audit and operate the completed Phase 5 data pipeline.

It is not a substitute for implementing seasonal materialization.

---

## 4.12 Historical Forecast Verification

**Status repository: Not started.**

### Objective

Measure forecast performance against independent historical truth.

The product must not claim that a provider or model is accurate without evidence.

### Functional requirements

| ID | Requirement | Priority |
|---|---|---|
| VER-01 | Store verification truth | P2 |
| VER-02 | Match forecast with observed/historical data | P2 |
| VER-03 | Evaluate by forecast horizon | P2 |
| VER-04 | Evaluate by model | P2 |
| VER-05 | Evaluate by variable | P2 |
| VER-06 | Calculate appropriate error metrics | P2 |
| VER-07 | Track sample size | P2 |
| VER-08 | Report spatial limitations | P2 |
| VER-09 | Expose model skill | P2 |

### Important rules

- Verification truth must be independent of the forecast being evaluated.
- The metric must be appropriate for the data class and temporal resolution.
- Sample size and coverage must be reported.
- Do not claim skill where verification evidence is absent.

### Not implemented

No verification worker, scoring engine, API, or UI.

---

## 4.13 Local Observations & Agricultural Activities

**Status repository: Database foundation exists; application workflows are not implemented.**

### Local observations

Users should eventually be able to record:

- Manual rainfall observations.
- Temperature observations.
- Soil moisture.
- Field conditions.
- Water availability.
- Agricultural notes.

### Agricultural activities

Users should eventually be able to manage:

- Planting records.
- Harvest records.
- Crop rotation history.
- Planned planting.
- Actual planting.
- Field history.

These records should support future forecast verification and agricultural decision improvement.

---

# 5. Non-Functional Requirements

## 5.1 Scientific Integrity

- Every weather value must have traceable provenance.
- Forecast and climatology must be distinguishable.
- Every derived artifact must identify its input snapshot.
- Unknown values must remain unknown.
- Forecast accuracy must not be asserted without verification.
- Every agronomic threshold must have a source grade.
- Every algorithm must be versioned where its output can change.

## 5.2 Security

- Tenant isolation enforced at PostgreSQL level.
- RLS on tenant-owned tables.
- Separate database roles.
- API authorization.
- Secure sessions.
- CSRF protection.
- Origin validation.
- Input validation.
- Least-privilege grants.
- No secrets in AI context.
- No cross-tenant information exposure.

## 5.3 Data Integrity

- Explicit ForecastRun and IngestionRun identities.
- Idempotent ingestion.
- Deterministic normalization.
- Transactional persistence.
- Explicit supersession.
- No silent replacement of valid data with incomplete data.
- Canonical serialization and hashing.
- Immutable or versioned source artifacts where required.

## 5.4 Performance

- Avoid N+1 provider and database queries.
- Reuse geographic grid data.
- Use bounded job selectors.
- Index high-frequency read paths.
- Use pagination for collections.
- Cache only where invalidation semantics are explicit.
- Avoid microservices until measured bottlenecks justify them.

## 5.5 Reliability

- Background job retries.
- Lease recovery.
- Idempotency keys.
- Explicit terminal and retryable failures.
- Transaction rollback.
- Bounded shutdown.
- Provider timeouts.
- Structured logs.
- Health and readiness checks.

## 5.6 Usability

- Bahasa Indonesia as the primary UI language.
- Technical source details accessible without overwhelming users.
- Mobile-responsive web interface.
- Clear empty states.
- Clear stale-data indicators.
- Explicit insufficient-data states.
- Visual distinction between forecast and historical climatology.
- Explanations understandable by non-specialists.

---

# 6. System Architecture Requirements

## 6.1 Architecture Style

Modular monolith with three deployable applications:

- `apps/web`
- `apps/api`
- `apps/worker`

Shared packages:

| Package | Responsibility | Repository status |
|---|---|---|
| `packages/contracts` | Zod contracts and types | Implemented |
| `packages/database` | Prisma, SQL, persistence, RLS | Implemented |
| `packages/weather-core` | Provider adapters and normalization | Implemented, partial coverage |
| `packages/climate-core` | Climate aggregation and outlook | Implemented, partial |
| `packages/agronomy` | Agronomic calculations | Not started |
| `packages/ai` | AI context and narration | Not started |
| `packages/ui` | Shared UI components | Not started |
| `packages/config` | Shared configuration | Not established as a dedicated package |
| `packages/utils` | Shared utilities | Not established as a dedicated package |

The absence of a dedicated package is not automatically a defect. Add one only when a real domain responsibility requires it.

## 6.2 Technology Stack

| Layer | Technology | Status |
|---|---|---|
| Monorepo | pnpm + Turborepo | Implemented |
| Frontend | React + Vite + TypeScript | Scaffold |
| Backend | NestJS + Express | Implemented |
| API validation | Zod | Implemented |
| Database | PostgreSQL 18 | Implemented |
| Spatial database | PostGIS 3.6 | Implemented |
| ORM | Prisma 7 | Implemented |
| Database migrations | Hand-written SQL | Implemented |
| Background worker | Independent Node.js worker | Implemented |
| Queue | PostgreSQL-first queue | Implemented |
| Cache | Redis | Not currently required by implemented queue |
| Testing | Node test runner and package-specific suites | Implemented |
| Frontend E2E | Playwright | Not implemented |
| API documentation | OpenAPI architecture requirement | Full product API documentation not established |

## 6.3 Architecture Constraints

- No premature microservices.
- PostgreSQL is the primary system of record.
- Database security is enforced independently of application filtering.
- Domain calculations must be deterministic and pure.
- Worker and API responsibilities must remain separated.
- Provider integrations must use explicit adapters.
- API contracts must be strict and versioned.
- Provenance must be preserved end-to-end.

---

# 7. Data Model Requirements

## 7.1 Identity and Tenant

- Users.
- Sessions.
- Farms.
- Fields.

## 7.2 Agricultural Domain

- Crops.
- Cultivars.
- Crop profile versions.
- Growth stages.
- Agronomic constraints.
- Source references.
- Plantings.
- Harvests.
- Field observations.

## 7.3 Climate Domain

- Outlook cells.
- Field-to-cell mapping.
- Forecast runs.
- Ingestion runs.
- Weather records.
- Climatology baselines.
- Climatology normals.
- Monthly outlooks.

## 7.4 Derived Artifacts

- Suitability runs.
- Planting windows.
- AI briefings.

## 7.5 Provenance

Each derived artifact must be traceable to:
- Input source.
- Provider/model.
- Forecast initialization.
- Ingestion identity.
- Baseline version where applicable.
- Input references.
- Input snapshot hash.
- Algorithm/derivation version.
- Computation timestamp.

---

# 8. User Experience Requirements

## 8.1 Main Navigation

Proposed navigation:

1. Dashboard.
2. Farms.
3. Fields.
4. Crop Catalog.
5. Climate Outlook.
6. Planting Planner.
7. Agricultural Calendar.
8. AI Analyst.
9. Data Sources.
10. Settings.

Navigation is a product target, not a claim that those screens already exist.

## 8.2 Dashboard

The dashboard should present:

- Total farms.
- Total fields.
- Current weather summary.
- Climate outlook summary.
- Upcoming planting windows.
- Risk alerts.
- Recent agricultural activities.
- Data freshness and source status.

## 8.3 Field Detail

Each field detail page should include:

- Field geometry.
- Area.
- Soil properties.
- Irrigation.
- Drainage.
- Elevation.
- Weather overview.
- Climate outlook.
- Crop suitability.
- Planting opportunities.
- Historical activities.

## 8.4 Climate Outlook UI

Must clearly distinguish:

- Daily forecast.
- Subseasonal forecast.
- Seasonal forecast.
- Historical climatology.

Every chart should disclose:
- Data class.
- Source.
- Model.
- Initialization date.
- Unit.
- Temporal resolution.
- Freshness.
- Coverage.
- Missing data.

## 8.5 Planting Planner UI

Must allow users to:

- Select a field.
- Select crop and cultivar.
- Compare planting windows.
- Inspect growth stages.
- Understand climate risk.
- Understand insufficient data.
- Inspect evidence behind a recommendation.

## 8.6 Responsive Design

- Desktop-first planning experience.
- Mobile-friendly field detail.
- Mobile-friendly weather summary.
- Touch-friendly calendar.
- No critical information hidden exclusively in hover interactions.

---

# 9. API Requirements

All application APIs use `/v1`.

### Existing API surface

Authentication:
- `POST /v1/auth/register`
- `POST /v1/auth/login`
- `GET /v1/auth/me`
- `POST /v1/auth/logout`
- `GET /v1/auth/csrf`

Farm:
- `POST /v1/farms`
- `GET /v1/farms`
- `GET /v1/farms/:farmId`
- `PATCH /v1/farms/:farmId`
- `DELETE /v1/farms/:farmId`

Field:
- `POST /v1/fields`
- `GET /v1/fields`
- `GET /v1/fields/:fieldId`
- `PATCH /v1/fields/:fieldId`
- `DELETE /v1/fields/:fieldId`
- `POST /v1/fields/:fieldId/resolve-cell`

Climate:
- `GET /v1/climate/outlook`

### Future API groups

Crop:
- `/v1/crops`
- `/v1/cultivars`
- `/v1/crop-profiles`

Agronomy:
- `/v1/suitability`
- `/v1/fields/:fieldId/suitability`

Planting:
- `/v1/planting-windows`
- `/v1/plantings`
- `/v1/harvests`

Calendar:
- `/v1/calendar`

AI:
- `/v1/ai/briefings`
- `/v1/ai/assistant`

Monitoring:
- `/v1/sources`
- `/v1/ingestions`
- `/v1/data-quality`

These future routes are proposed API requirements, not verified existing endpoints.

---

# 10. Roadmap & Implementation Status

Status below is based on actual repository inspection at the stated baseline, not solely on the original implementation prompt.

## Phase 0 — Research & Data Source Validation

<badge color="success">Implemented</badge>

Deliverables:
- Weather source matrix.
- Agronomic reference matrix.
- Forecast horizon capabilities.
- Licensing and attribution research.
- ADR-001.
- UI reference analysis.
- Adversarial review.

Important limitations:
- Live provider probes were concentrated on one location (Jakarta).
- Provider licensing remains a production constraint.
- Production spatial grid validation remains unresolved.
- Several agronomic thresholds remain incomplete.

## Phase 1 — Product Requirements & Architecture

<badge color="success">Implemented</badge>

Deliverables:
- Product definition.
- System architecture.
- Domain model.
- Data flow.
- Background processing.
- API conventions.
- Provenance contract.
- ADR-002.
- Architecture review.

The current PRD expands this product definition and reconciles it with implementation.

## Phase 2 — Monorepo & Database Foundation

<badge color="success">Implemented</badge>

Deliverables:
- pnpm workspaces.
- Turborepo.
- React/Vite application scaffold.
- NestJS API.
- Worker application.
- PostgreSQL/PostGIS.
- Prisma.
- Shared contracts.
- Canonical JSON.
- SHA-256.
- Database roles.
- RLS.
- SQL migrations.
- Database verification.

Important: physical data-model specification and actual physical implementation are separate deliverables. The current domain schema has been implemented, while some future write-path validators remain outstanding.

## Phase 3 — Domain Model & Core Administration

<badge color="warning">Partial</badge>

| Sub-phase | Status |
|---|---|
| Physical domain tables | Implemented |
| Crop/cultivar schema | Implemented |
| Agronomic profile schema | Implemented |
| Authentication | Implemented |
| User sessions | Implemented |
| Farm database layer | Implemented |
| Farm CRUD API | Implemented |
| Field database layer | Implemented |
| Field CRUD API | Implemented |
| Crop CRUD | Not started |
| Cultivar CRUD | Not started |
| Agronomic profile management | Not started |
| Planting/harvest workflow | Not started |
| Local observations workflow | Not started |
| Additional security hardening | Partial / open |
| Frontend administration | Not started |

## Phase 4 — Farm & Field Completion

<badge color="warning">Partial</badge>

| Sub-phase | Status |
|---|---|
| 4.1 Domain contracts | Design complete |
| 4.2 Database layer | Implemented |
| 4.3 Farm CRUD | Implemented |
| 4.4 Field CRUD | Implemented |
| 4.4.1 Geometry validation | Implemented |
| 4.4.2 Geometry/transaction consistency | Implemented |
| 4.5 Security hardening | Not started |
| 4.6 Frontend | Not started |

Important open decisions:
- `OPEN-17`: Point-shaped field semantics.
- `OPEN-21`: Field vocabulary and irrigation mapping.
- `OPEN-26`: EvidenceSegment validator.
- `OPEN-27`: Secure field-to-cell worker mechanism.

## Phase 5 — Climate Data Foundation

<badge color="warning">Partial</badge>

| Sub-phase | Status |
|---|---|
| 5.0 Contracts and grid resolver | Implemented |
| 5.1 Provider adapter foundation | Partially implemented |
| 5.2 Spatial resolution foundation | Implemented |
| 5.3 Worker runtime and run lifecycle | Implemented |
| 5.4 Short-range ingestion | Implemented behind gates |
| 5.5 Climatology baseline | Implemented behind gates |
| 5.6 EC46 and SEAS5 ingestion | Implemented behind gates |
| 5.7A Climatology materialization | Implemented |
| 5.7B Climatology read API | Implemented |
| 5.7C Seasonal contract | Documentation implemented |
| 5.7D Seasonal materialization | Not started at verified baseline |
| 5.8 Data quality and operations | Not started |

Important implementation details:
- 50 SEAS5 member monthly totals are already persisted in `weather_records`.
- The seasonal monthly outlook writer does not yet exist.
- Ensemble spread is deferred.
- The climate read API exists, but its seasonal half remains incomplete.
- No production provider grid has been admitted.

### Approved 5.7D product decisions

The implementation must follow these decisions:

- Lead month 1 = next calendar month after initialization.
- Seasonal band = lead 1–6.
- Climatology band = lead 7–12.
- All 50 required member indices must be complete.
- Seasonal value = arithmetic mean of member monthly totals.
- Incomplete population does not supersede a valid answer.
- Newer ForecastRun initialization wins.
- Newer qualifying IngestionRun breaks ties.
- Run identity uses explicit nullable FK columns.
- Freshness is soft TTL, evaluated at read time.
- Stale values remain servable.
- Member count belongs in the canonical record-set hash.
- Spread and probability remain deferred.

These decisions supersede older documentation that still says seasonal 1–7 and climatology 8–12.

## Phase 6 — Agronomic Suitability & Planting Window Engine

<badge color="secondary">Not started</badge>

Planned sub-phases:

| Sub-phase | Deliverable |
|---|---|
| 6.1 | Agronomic domain contracts and profile versioning |
| 6.2 | Crop catalog and seed data |
| 6.3 | Pure deterministic suitability engine |
| 6.4 | Growth-stage alignment |
| 6.5 | Planting window generation |
| 6.6 | EvidenceSegment validation and persistence |
| 6.7 | API and recomputation integration |

Dependencies:
- `OPEN-18`
- `OPEN-26`
- `OPEN-27`
- Agronomic catalog seeding.
- Agronomist review.

Some pure engine work and synthetic-fixture tests can proceed independently of production data gates.

## Phase 7 — Frontend & Agricultural Calendar

<badge color="secondary">Not started</badge>

Planned:
- Application shell.
- Farm and field screens.
- Crop catalog.
- Climate dashboard.
- Climate charts.
- Planting planner.
- Annual/monthly calendar.
- Daily detail.
- Risk visualization.
- Responsive UX.
- Frontend integration tests.
- E2E flows.

The current `apps/web` is only a scaffold.

## Phase 8 — AI Agricultural Analyst

<badge color="secondary">Not started</badge>

Planned:
- AI context builder.
- Structured briefing schema.
- LLM provider adapter.
- Prompt/version management.
- Evidence-grounded explanations.
- Briefing persistence.
- AI interface.
- Output validation.
- Hallucination safeguards.

The AI layer must remain optional. The application must still function when AI is disabled.

## Phase 9 — Monitoring, Forecast Verification & Production Readiness

<badge color="secondary">Not started</badge>

Planned:
- Scheduled data ingestion.
- Source monitoring.
- Data quality audits.
- Operational runbook.
- Failure alerts.
- Forecast verification.
- Historical performance metrics.
- Provider coverage evaluation.
- Load and reliability tests.
- Production deployment.
- Licensing and attribution review.

Phase 5.8 is the initial climate-data quality and operations milestone. Phase 9 is the broader product verification and operational maturity milestone.

---

# 11. External Gates & Open Decisions

These are not ordinary implementation tasks. They require evidence, product decisions, or external authorization.

| ID | Issue | Impact |
|---|---|---|
| OPEN-03 | Open-Meteo commercial licensing/plan | Production ingestion |
| OPEN-18 | Validated provider grid and cell mapping | Real field-level weather/climate resolution |
| OPEN-05 | Raw provider payload retention | Reproducibility claims |
| OPEN-02 | BMKG commercial integration permission | BMKG provider usage |
| OPEN-26 | EvidenceSegment partition validator | Safe planting-window persistence |
| OPEN-27 | Secure field-to-cell discovery for workers | Recompute fan-out |
| OPEN-17 | Point-shaped field semantics | Point field snapshots |
| OPEN-21 | Soil/drainage/irrigation vocabulary mapping | Agronomic input correctness |

No implementation should silently resolve these by guessing.

---

# 12. Product Success Metrics

## 12.1 Core usability

- A user can create a farm and field.
- A user can select a crop and cultivar.
- A user can inspect a planting window.
- Every recommendation can be explained dimension by dimension.
- Missing information is visible.

## 12.2 Data integrity

- 100% of rendered weather values have source identity.
- 100% of monthly outlooks have an approved estimator.
- No climatology month is labelled as a forecast.
- No unsupported daily forecast is fabricated.
- Incomplete ensemble populations never become valid seasonal values.

## 12.3 Agronomic transparency

- Every hard constraint has grade A evidence.
- Unknown required inputs produce insufficient-data behavior.
- Every planting window carries its evidence segments.
- Every derived artifact has an input snapshot hash and derivation version.

## 12.4 Reliability

- No cross-tenant access.
- No partial persistence after transaction failure.
- No older forecast superseding a newer valid forecast.
- Retry and idempotency behavior is deterministic.
- Production data coverage and provider freshness are measurable.

## 12.5 Forecast verification

- Forecast skill must be measured by model and horizon.
- Every metric includes sample size and coverage.
- No accuracy claim without independent truth.

---

# 13. Release Strategy

## Release 0 — Technical Foundation

Goal:
Secure and maintainable backend foundation.

Includes:
- Authentication.
- Farm and field management.
- Database.
- Tenant isolation.
- Shared contracts.

Repository status: Mostly implemented.

## Release 1 — Trustworthy Climate Data

Goal:
Serve a scientifically honest climate outlook.

Includes:
- Daily forecast.
- Subseasonal data.
- Seasonal outlook.
- Climatology.
- Source provenance.
- Freshness.
- Data-quality monitoring.

Repository status: Partial. Seasonal materialization and production provider gates remain.

## Release 2 — Agronomic Decision Engine

Goal:
Translate weather and climate into explainable planting decisions.

Includes:
- Crop catalog.
- Agronomic profiles.
- Suitability engine.
- Planting window engine.
- Evidence segments.

Repository status: Not started.

## Release 3 — Planning Experience

Goal:
Make recommendations actionable.

Includes:
- Dashboard.
- Calendar.
- Field detail.
- Planting planner.
- Risk visualization.
- Activity history.

Repository status: Not started.

## Release 4 — AI Analyst

Goal:
Make the platform easier to understand and use.

Includes:
- AI briefing.
- Natural-language questions.
- Evidence-grounded explanation.
- Context versioning.

Repository status: Not started.

## Release 5 — Operational Intelligence

Goal:
Make the system measurable and production-ready.

Includes:
- Monitoring.
- Forecast verification.
- Automated quality checks.
- Operational runbooks.
- Production licensing and data coverage.

Repository status: Not started.

---

# 14. Acceptance Criteria for the Complete Product

Agroclimate Planner should not be considered complete merely because its backend builds or its database migrations pass.

The product is complete when all of the following are true:

1. Users can register, authenticate, and securely manage their data.
2. Users can manage farms and fields through the actual frontend.
3. Users can manage crops and cultivars.
4. Weather data is ingested through validated providers.
5. Every climate value is traceable to its source.
6. A rolling 12-month outlook is served with honest data classes.
7. Seasonal and climatology data are correctly materialized and superseded.
8. Users can evaluate crop suitability against their field conditions.
9. Planting windows account for the entire crop growth cycle.
10. Missing agronomic inputs are handled explicitly.
11. Planting recommendations can be audited.
12. Users can plan agricultural activities using the calendar.
13. AI can explain structured results without inventing data.
14. Data freshness and source quality are visible.
15. Forecast skill is measured before accuracy claims are made.
16. Security, regression, reliability, and operational checks pass.
17. Production provider licensing and grid validation are resolved.

---

# 15. Product Direction and Engineering Guardrails

The project must avoid two opposite mistakes.

### Mistake A — Overbuilding infrastructure

Do not spend indefinitely improving:
- Generic abstractions.
- Queue frameworks.
- Database utilities.
- Unused AI infrastructure.
- Unnecessary package boundaries.

Every foundational improvement should unlock a concrete product capability or close a demonstrable correctness/security risk.

### Mistake B — Shipping attractive but scientifically unreliable features

Do not rush to build:
- A dashboard showing fabricated forecast values.
- A crop suitability score with invented thresholds.
- A planting date without full-cycle evaluation.
- AI-generated recommendations that bypass the deterministic engine.
- A forecast chart that hides climatology or stale data.

### Prioritization rule

When choosing between engineering work:

1. Resolve correctness and security risks that block product functionality.
2. Complete the climate data path needed for agronomic calculations.
3. Build the deterministic agronomic engine.
4. Deliver the usable frontend experience.
5. Add AI narration.
6. Improve monitoring and forecast verification.

The objective is a useful agricultural planning product, not a technically elaborate backend without a working user experience.

---

# 16. Repository Traceability & Source of Truth

The following documents are authoritative references for their respective domains:

| Document | Authority |
|---|---|
| `docs/PROJECT.md` | Product vision, user, product scope |
| `BRAINSTORM.md` | Original concept and implementation planning history |
| `docs/IMPLEMENTATION_STATUS.md` | Historical implementation status and evidence |
| `docs/architecture/system-architecture.md` | System boundaries and dependency direction |
| `docs/architecture/domain-model.md` | Domain concepts |
| `docs/architecture/data-flow.md` | Data flow |
| `docs/architecture/provenance-contract.md` | Provenance semantics |
| `docs/architecture/climate-data-foundation.md` | Climate data implementation contract |
| `docs/adr/` | Accepted architecture decisions |
| `docs/research/` | Scientific, provider, and licensing evidence |
| `docs/data-model/` | Physical data model and integrity contracts |

This PRD is the consolidated product-level specification.

It does not silently override an accepted ADR or an explicit owner decision. When a product decision changes, its corresponding contracts, ADRs, implementation, and tests must be reconciled.

---

# 17. Current Overall Assessment

At the verified repository baseline:

| Dimension | Assessment |
|---|---|
| Product definition | Established |
| Scientific research | Established, with known gaps |
| Architecture foundation | Implemented |
| Database foundation | Implemented |
| Authentication | Implemented |
| Farm and Field backend | Implemented |
| Crop catalog | Schema only |
| Weather ingestion | Partially implemented |
| Climate outlook | Partially implemented |
| Seasonal materialization | Not implemented |
| Agronomic engine | Not implemented |
| Planting window engine | Not implemented |
| Frontend | Scaffold only |
| Calendar | Not implemented |
| AI analyst | Not implemented |
| Monitoring | Foundation only |
| Forecast verification | Not implemented |
| Production readiness | Not achieved |

**The most important product milestone after completing the current Phase 5 work is Phase 6: Agronomic Suitability & Planting Window Engine.**

That is where Agroclimate Planner begins delivering its defining product value: turning climate data into explainable agricultural decisions.

However, Phase 7 frontend work must not be postponed indefinitely. The product needs a usable interface, not only a complete backend.

---

**End of PRD — Version 1.0**
