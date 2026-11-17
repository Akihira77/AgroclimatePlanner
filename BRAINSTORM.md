# AGROCLIMATE PLANNER — OPENCODE IMPLEMENTATION PROMPT PACK

## GLOBAL PROJECT CONTEXT

You are building a production-oriented, AI-powered Agricultural Weather & Climate Planning Platform.

This is NOT a conventional weather application.

The primary objective is to help a landowner understand local weather, seasonal climate patterns, agricultural risks, and identify suitable planting windows for multiple crops across a continuously rolling 12-month horizon.

The application must prioritize scientific validity, transparent forecast provenance, explainable agricultural recommendations, and practical usability.

### Product objectives

1. Monitor actual and forecasted weather for user-defined agricultural locations.
2. Provide a rolling 12-month climate outlook.
3. Maintain an extensible catalog of crops, cultivars, and their agronomic requirements.
4. Calculate crop-specific planting suitability windows.
5. Display planting opportunities in a rich annual/monthly/daily calendar.
6. Provide AI-generated climate and agricultural briefings grounded in structured data.
7. Manage multiple farms and agricultural plots.
8. Track forecast sources, updates, historical observations, and prediction accuracy.

### Critical scientific rules

These rules are non-negotiable.

- Never represent a 12-month climate outlook as a precise daily weather forecast.
- Never invent weather observations, probability values, forecast variables, or data sources.
- Clearly distinguish observations, short-range forecasts, subseasonal forecasts, seasonal forecasts, annual outlooks, and historical climatology.
- Preserve source provenance and forecast initialization dates.
- Long-range recommendations must be probabilistic and uncertainty-aware.
- A crop suitability decision must account for the complete crop growth cycle, not only the planting date.
- Missing agronomic information must produce an insufficient-data state instead of a fabricated recommendation.
- Do not claim a provider is accurate without appropriate historical verification.
- Never expose stale data as current data.
- Never silently replace a forecast with historical climatology.
- Historical climatology must be explicitly labeled as climatology, not forecast.

### Forecast horizon

The application must support a rolling 12-month horizon.

Use the following conceptual ranges, but validate the actual available data before implementation:

| Range | Data interpretation |
|---|---|
| 0–3 days | Official local weather forecast |
| 4–15 days | Short-range numerical/ensemble forecast |
| 16–46 days | Subseasonal forecast |
| 2–6 months | Seasonal climate forecast |
| 7–12 months | Annual outlook where genuinely available, otherwise historical climate baseline and seasonal context |

The exact resolution, update frequency, and coverage must come from verified provider capabilities.

### Preferred stack

- Monorepo: pnpm workspaces + Turborepo
- Frontend: React + Vite + TypeScript
- Routing: TanStack Router
- Data fetching: TanStack Query
- Styling: Tailwind CSS
- Components: shadcn/ui with custom design system
- Charts: Recharts
- Backend: NestJS + Express + Zod validator
- API: REST + OpenAPI
- Database: PostgreSQL + PostGIS
- ORM: Prisma, with raw SQL where appropriate for PostGIS
- Background jobs: Redis + BullMQ
- Testing: Vitest, React Testing Library, Playwright, and suitable backend integration tests
- Infrastructure: Docker Compose initially

Avoid premature microservices. Keep a modular monolith with an independent background worker.

### Agent utilization

Use the configured agents selectively.

- librarian: research official weather data, model documentation, agronomic references, licensing, and API limitations.
- oracle: architecture decisions, data-model review, forecasting integrity, and high-risk technical decisions.
- explorer: repository exploration and dependency investigation.
- designer: UI architecture and design-system work.
- council: adversarial design and scientific-validity review.
- fixer: implementation.
- observer: independent testing and review.
- orchestrator: coordinate tasks and resolve conflicting recommendations.

Do not ask multiple agents to edit the same files concurrently.

### Working agreement

For every phase:

1. Inspect the current repository and previous phase documentation.
2. Identify completed work and remaining gaps.
3. Prepare a concise implementation plan.
4. Delegate bounded work to relevant agents.
5. Implement only the scope of the current phase.
6. Run the appropriate tests, lint, typecheck, and build.
7. Review the implementation for regressions and architectural consistency.
8. Update documentation and implementation status.
9. Report completed work, known limitations, and next-phase prerequisites.

Do not mark work complete merely because files were generated.

Do not invent successful API integration when a real provider request has not been verified.

Maintain these project documents throughout development:

- `docs/PROJECT.md`
- `docs/IMPLEMENTATION_STATUS.md`
- `docs/architecture/`
- `docs/adr/`
- `docs/research/`
- `docs/data-model/`
- `docs/operations/`

---

# PHASE 0 — SCIENTIFIC RESEARCH & DATA SOURCE VALIDATION

## Objective

Establish a verified weather and climate data architecture before writing the production application.

This phase is research-heavy. Do not implement the complete application yet.

## Research requirements

### A. BMKG

Investigate the official BMKG data services:

- Village/subdistrict weather forecasts.
- Short-range weather forecast data.
- Monthly rainfall forecasts.
- Probabilistic rainfall forecasts.
- Seasonal rainfall outlooks.
- Rainy and dry season predictions.
- Rainfall availability for crops.
- Drought and excessive rainfall early warnings.
- ENSO and IOD information.

Official references to investigate:

- https://data.bmkg.go.id/prakiraan-cuaca/
- https://www.bmkg.go.id/iklim/prediksi-hujan-bulanan
- https://www.bmkg.go.id/iklim/

Important: determine which data is available as machine-readable JSON/API, and which data is only published as maps, documents, or other downloadable artifacts.

Do not assume every published BMKG climate product has a public API.

Record attribution, usage requirements, update frequency, access limitations, and geographic coverage.

### B. ECMWF

Investigate:

- ECMWF IFS short-range forecasts.
- ECMWF EC46 extended/subseasonal forecasts.
- ECMWF SEAS5 seasonal forecasts.
- ECMWF annual outlook.
- Ensemble members and ensemble spread.
- Forecast anomalies and tercile probabilities.
- Historical hindcasts and forecast verification.

Official documentation:

https://www.ecmwf.int/en/forecasts/documentation-and-support/seasonal

### C. Open-Meteo

Investigate the following services:

- Standard Forecast API.
- Ensemble API.
- Seasonal Forecast API.
- Historical Weather API.
- Historical Forecast API.
- Geocoding API.
- Elevation API, if useful.

Seasonal documentation:

https://open-meteo.com/en/docs/seasonal-forecast-api

Verify actual available models, variables, temporal resolutions, forecast limits, data retention, licensing, rate limits, and commercial-use requirements.

Do not blindly trust a third-party provider simply because it exposes ECMWF model data.

### D. Historical climate data

Research suitable historical rainfall and weather sources.

Investigate possible ERA5/ERA5-Land, CHIRPS, NASA POWER, or other reputable datasets.

Evaluate:

- Spatial resolution.
- Temporal resolution.
- Historical coverage.
- Availability in Indonesia.
- Licensing.
- Suitability for local calibration.
- Limitations for agricultural field-level analysis.

Do not choose a provider without documenting why it is suitable.

### E. Agricultural reference data

Investigate authoritative agricultural references for:

- Rice.
- Corn.
- Soybean.
- Chili.
- Other crops likely to be planted in Indonesia.

Find references for crop duration, growth phases, water demand, rainfall tolerance, temperature requirements, and relevant soil constraints.

Prefer authoritative Indonesian agricultural research, agricultural extension resources, and credible scientific references.

Avoid inventing universal thresholds for crop suitability.

## Important 12-month requirement

Investigate how to provide a continuously rolling 12-month climate outlook.

For months beyond reliable detailed seasonal coverage:

- Use a verified annual outlook if its actual spatial and temporal data is accessible.
- Otherwise use historical climatology and seasonal context.
- Explicitly label climatology-based information.
- Never manufacture daily forecasts to fill the calendar.

Determine whether field-level coordinates can genuinely receive usable forecasts at each horizon.

## Deliverables

Create:

1. `docs/research/weather-source-matrix.md`
2. `docs/research/agronomic-reference-matrix.md`
3. `docs/research/forecast-horizon-capabilities.md`
4. `docs/research/data-licensing-and-attribution.md`
5. `docs/adr/ADR-001-weather-data-provider-strategy.md`

The source matrix must include provider, model, variables, forecast horizon, resolution, update frequency, licensing, limitations, and implementation feasibility.

Ask `oracle` and `council` to independently review whether the proposed data strategy is scientifically defensible.

Do not continue to Phase 1 until these documents exist and major data-source limitations are documented.

---

# PHASE 1 — PRODUCT REQUIREMENTS & SYSTEM ARCHITECTURE

## Objective

Convert the research findings into a complete product specification and a technically defensible application architecture.

## Product definition

Define the main domains:

1. Farm and field management.
2. Crop catalog and agronomic profiles.
3. Weather observations.
4. Weather forecasting.
5. Climate outlook.
6. Crop suitability engine.
7. Planting calendar.
8. AI climate assistant.
9. Weather-source monitoring.
10. Historical forecast verification.

## Important domain considerations

A farm may contain multiple plots.

Each plot may have its own:

- Coordinates or polygon boundary.
- Area.
- Elevation.
- Soil type.
- Soil pH, if known.
- Drainage condition.
- Irrigation availability.
- Water source.
- Agricultural history.

Each crop must support multiple cultivars.

Each cultivar may have different growth durations and agronomic requirements.

A crop recommendation must evaluate weather conditions throughout the expected growth cycle.

## Architecture requirements

Design a modular monolith with three applications:

- `apps/web`
- `apps/api`
- `apps/worker`

Design reusable domain packages:

- `packages/contracts`
- `packages/database`
- `packages/weather-core`
- `packages/climate-core`
- `packages/agronomy`
- `packages/ai`
- `packages/ui`
- `packages/config`
- `packages/utils`

Define clear module boundaries.

Define how weather providers, normalization, climate aggregation, agricultural calculation, and AI narration communicate.

Define REST API conventions and error handling.

Use OpenAPI as the API contract.

Define authentication, authorization, roles, and administrative permissions.

## Required architecture documents

Create:

- `docs/PROJECT.md`
- `docs/architecture/system-architecture.md`
- `docs/architecture/domain-model.md`
- `docs/architecture/data-flow.md`
- `docs/architecture/background-processing.md`
- `docs/architecture/api-conventions.md`
- `docs/adr/ADR-002-monorepo-and-backend-architecture.md`

Ask `oracle` for architecture review.

Ask `council` to identify complexity, scalability, and reliability risks.

Produce a Mermaid architecture diagram.

Do not implement application features in this phase.

---

# PHASE 2 — MONOREPO FOUNDATION & DESIGN SYSTEM

## Objective

Create a maintainable and production-ready monorepo foundation.

## Repository setup

Implement:

- pnpm workspaces.
- Turborepo.
- React + Vite application.
- NestJS API with Express.
- Independent BullMQ worker.
- PostgreSQL with PostGIS extension.
- Redis.
- Prisma.
- Shared TypeScript configuration.
- Shared ESLint and formatting configuration.
- Environment validation.
- Docker Compose.

Create suitable development scripts.

Implement:

- `dev`
- `build`
- `lint`
- `typecheck`
- `test`
- `format`
- `db:migrate`
- `db:generate`

Create Docker health checks.

Prepare a clean initial CI workflow.

## Frontend foundation

Configure:

- React.
- TanStack Router.
- TanStack Query.
- Tailwind.
- shadcn/ui.
- Recharts.
- Lucide icons.

Create a reusable application shell with sidebar and top navigation.

## Design direction

Create a premium agricultural intelligence dashboard.

Visual direction:

- Clean, sophisticated, information-dense SaaS.
- Light theme as default.
- Forest green as primary brand color.
- Muted botanical green for agricultural suitability.
- Warm amber for caution.
- Muted red for critical risk.
- Neutral backgrounds.
- Readable typography.
- Subtle borders and restrained shadows.

Suggested palette:

- Primary: `#1D4938`
- Primary light: `#E7F0E9`
- Secondary: `#729B71`
- Background: `#F7F8F5`
- Surface: `#FFFFFF`
- Text: `#202B26`
- Muted: `#758078`
- Warning: `#D69B37`
- Danger: `#C85B50`

Do not use bright gradients everywhere.

Avoid excessive rounded cards, enormous typography, and unnecessary whitespace.

The dashboard must feel like a real professional agricultural intelligence platform.

Create:

- `packages/ui`
- Design tokens.
- Typography system.
- Buttons.
- Inputs.
- Dialogs.
- Dropdowns.
- Tooltips.
- Tables.
- Badges.
- Tabs.
- Charts containers.
- Skeleton loading states.
- Empty states.
- Error states.

## Deliverables

A runnable monorepo with basic health endpoints, working frontend shell, database connection, and reusable UI foundation.

No fake application data presented as real weather data.

---

# PHASE 3 — DOMAIN MODEL, ADMINISTRATION & CRUD

## Objective

Implement the core data model and administrative management features.

## Database domains

Design normalized schemas for:

### Users and permissions

- Users.
- Sessions or authentication records.
- Roles.
- Permissions.

### Farms and fields

- Farms.
- Fields or plots.
- Field geometry.
- Elevation.
- Soil properties.
- Irrigation and drainage.
- Field-specific agricultural notes.

Use PostGIS where spatial operations are required.

### Crops

- Crop categories.
- Crop species.
- Cultivars.
- Crop profile.
- Growth stages.
- Growth stage durations.
- Temperature requirements.
- Rainfall requirements.
- Water requirements.
- Soil suitability.
- Flood and drought tolerance.
- Agronomic source references.
- Profile versioning.

Make agronomic profiles configurable.

Do not hardcode all crop requirements in source code.

### Farming activities

Support:

- Planting records.
- Harvest records.
- Field history.
- Crop rotation history.
- Planned planting activities.
- Actual agricultural observations.

### Local measurements

Prepare data models for:

- Manual rainfall observations.
- Soil moisture observations.
- Temperature observations.
- Field notes.
- Optional sensor measurements.

## Backend

Implement proper NestJS modules, DTOs, validation, services, repository boundaries, permissions, pagination, filtering, and API documentation.

## Admin frontend

Build management interfaces for:

1. Farm management.
2. Field management.
3. Crop catalog.
4. Cultivar management.
5. Agronomic profile editor.
6. Historical planting records.
7. Local observation entry.

## Crop creation UX

When creating a crop, provide:

- Basic information.
- Cultivar.
- Growth duration.
- Growth stages.
- Climate requirements.
- Soil requirements.
- Water requirements.
- Reference documentation.

Allow profile duplication and reusable templates.

Support import/export where practical.

## Deliverables

Functional CRUD, database migrations, API tests, validation, and responsive administration UI.

Create `docs/data-model/` with ER diagrams and field descriptions.

---

# PHASE 4 — WEATHER PROVIDERS & DATA INGESTION PIPELINE

## Objective

Build a resilient weather and climate data ingestion system.

This is a high-priority phase because all later agricultural calculations depend on the quality of this layer.

## Architecture

Implement provider adapters with explicit interfaces.

Suggested structure:

- `WeatherProvider`
- `ObservationProvider`
- `ShortRangeForecastProvider`
- `SubseasonalForecastProvider`
- `SeasonalForecastProvider`
- `ClimateHistoryProvider`

Implement only providers validated in Phase 0.

Potential integrations include:

- BMKG.
- Open-Meteo standard forecast.
- Open-Meteo seasonal forecast.
- Approved historical climate datasets.

## Data normalization

Normalize data into a consistent internal representation.

Support relevant variables:

- Precipitation.
- Minimum temperature.
- Maximum temperature.
- Average temperature.
- Relative humidity.
- Wind speed.
- Wind gust.
- Solar radiation.
- Evapotranspiration.
- Soil temperature.
- Soil moisture.

Only store variables actually provided by the relevant model.

## Forecast metadata

Every ingested record must preserve:

- Provider.
- Model.
- Model version, where available.
- Forecast initialization time.
- Valid time.
- Ingestion time.
- Spatial resolution.
- Temporal resolution.
- Ensemble member information.
- Bias-correction status.
- Source URL.
- Attribution.
- Forecast horizon.

## Pipeline requirements

Implement BullMQ jobs for:

- Fetching data.
- Parsing and validating.
- Normalization.
- Deduplication.
- Persistence.
- Retry.
- Stale-data detection.
- Forecast aggregation.
- Failed job recovery.

Use appropriate timeouts, exponential backoff, idempotency, concurrency limits, and provider-specific rate limits.

Do not fetch the same dataset unnecessarily for every request.

Implement caching and geographic/grid-cell reuse where appropriate.

Keep original provider payloads or source snapshots when technically and legally permitted.

## BMKG requirements

Respect BMKG attribution obligations.

Use the official machine-readable interface when available.

If a monthly or seasonal climate product is only distributed as a map or document, do not pretend that it is a structured point forecast.

Build a controlled import pathway for verified structured datasets or manually uploaded source artifacts when appropriate.

## Monitoring

Expose:

- Last successful sync.
- Last attempted sync.
- Provider availability.
- Data coverage.
- Stale records.
- Queue health.
- Failed jobs.
- Source response latency.

## Deliverables

Working provider adapters, real data ingestion, historical raw-data retention where allowed, normalized schemas, integration tests, and weather-source monitoring endpoints.

---

# PHASE 5 — CLIMATE OUTLOOK & FORECAST PROCESSING ENGINE

## Objective

Implement the rolling 12-month climate processing layer.

The goal is to transform multiple heterogeneous datasets into reliable, interpretable climate information.

## Temporal classification

Every output must indicate one of:

- Observation.
- Short-range forecast.
- Subseasonal forecast.
- Seasonal forecast.
- Annual outlook.
- Historical climatology.

Never mix these categories silently.

## Monthly aggregation

Implement monthly summaries for:

- Total precipitation.
- Probability of rainfall thresholds when the source supplies it.
- Temperature anomaly.
- Precipitation anomaly.
- Wet/dry tendency.
- Evapotranspiration when available.
- Soil moisture when available.
- Data coverage.
- Forecast uncertainty.

Do not create probabilities by simply averaging deterministic predictions.

Use actual ensemble members or published probabilities where available.

## Rolling 12-month horizon

Implement a service that generates a rolling climate timeline.

For each month:

- Identify available data sources.
- Identify the valid forecast horizon.
- Aggregate the appropriate data.
- Calculate relevant anomalies.
- Store the methodology.
- Record data quality and provenance.

For months without genuine forecast availability:

- Use historical climatology where available.
- Optionally use a verified annual outlook.
- Clearly mark the result as a baseline or outlook.
- Never display historical climatology as a future weather forecast.

## Climatology

Build suitable historical reference periods based on verified historical datasets.

Allow the baseline period to be stored and configured.

Compare forecast anomalies against the correct seasonal baseline.

## Calibration and uncertainty

Investigate bias correction only when sufficient historical hindcast data exists.

Do not blindly calibrate with a small sample.

Different models and lead times may have different skill.

Do not assign arbitrary confidence scores such as 95%.

Distinguish:

1. Data coverage.
2. Ensemble spread.
3. Historical model skill.
4. Forecast probability.
5. General uncertainty.

If model skill is not verified, explicitly mark it as unverified.

## API

Create endpoints such as:

- `GET /climate/outlook`
- `GET /climate/monthly`
- `GET /climate/anomalies`
- `GET /climate/sources`
- `GET /climate/data-quality`

Adjust endpoint design to the architecture.

## Deliverables

A functional climate outlook engine with unit tests, aggregation tests, provenance tracking, and a clear 12-month API response.

---

# PHASE 6 — AGRONOMIC SUITABILITY & PLANTING WINDOW ENGINE

## Objective

Build the core agricultural intelligence engine.

This is the feature that turns a weather application into an agricultural planning application.

## Main principle

A crop should not be recommended merely because the weather is good on the first planting day.

The engine must assess the expected environmental conditions throughout the complete crop growth cycle.

## Evaluation dimensions

Depending on crop profile availability, assess:

- Rainfall availability.
- Expected rainfall distribution.
- Soil moisture.
- Water availability.
- Temperature.
- Evapotranspiration.
- Soil properties.
- Drainage.
- Irrigation access.
- Crop duration.
- Growth stages.
- Weather risks during sensitive growth stages.

For rice, explicitly support paddy-specific water requirements, flooding tolerance, and irrigation conditions.

## Calculation architecture

Create a deterministic, versioned agronomic rules engine.

Use configurable thresholds and stage-dependent requirements.

Consider a multi-factor assessment:

- Climate suitability.
- Water suitability.
- Soil suitability.
- Timing suitability.
- Environmental risk.

Do not use one universal formula for all crops.

Separate:

1. Hard exclusion constraints.
2. Soft suitability scoring.
3. Risk penalties.
4. Missing-data handling.

Every result must explain which factors influenced its score.

## Planting window generation

Calculate candidate planting windows.

An output should include:

- Crop.
- Cultivar.
- Field.
- Window start.
- Window end.
- Temporal precision: daily, dekadal, or monthly.
- Suitability level.
- Relevant forecast horizon.
- Important risks.
- Reasons.
- Supporting data.
- Methodology version.
- Recommendation update time.

For long-range outlooks, recommend ranges rather than invented exact days.

## Example result structure

```typescript
interface PlantingWindow {
  cropId: string;
  fieldId: string;

  startDate: string;
  endDate: string;

  precision: "daily" | "dekadal" | "monthly";

  suitability:
    | "excellent"
    | "good"
    | "conditional"
    | "poor"
    | "insufficient_data";

  score?: number;

  risks: string[];
  explanations: string[];

  forecastSources: string[];
  climateMethodVersion: string;
  agronomyRuleVersion: string;
}
```

The score must be explainable and must not be confused with a statistical probability of crop success.

## Crop icon generator

Implement deterministic crop icons.

Requirements:

- Stable crop identity.
- Category-based icon mapping.
- Consistent color palette.
- Visually distinct crop markers.
- Accessible labels.
- Reusable across the calendar and crop catalog.

Generate icons programmatically from application assets, not by invoking an AI image generator for every crop.

## Admin controls

Allow authorized users to:

- Edit crop requirements.
- Update thresholds.
- Version agronomic profiles.
- Add references.
- Compare old and new rules.
- Recalculate affected planting windows.

## Deliverables

A tested suitability engine, explainable recommendations, versioned rules, and crop-specific planting windows.

---

# PHASE 7 — MAIN DASHBOARD & INTERACTIVE CLIMATE CALENDAR

## Objective

Build the complete primary user experience.

This phase should produce the visual centerpiece of the product.

## Design philosophy

Premium agricultural intelligence.

The design should feel like a mature SaaS analytics product, not a generic weather template.

Use the design system created in Phase 2.

Prioritize desktop because agricultural planning and large calendars benefit from a larger workspace.

Maintain responsive behavior for tablets and mobile.

## Main application layout

Create:

### Sidebar

- Overview.
- Climate Calendar.
- Planting Opportunities.
- Crop Management.
- Farm & Fields.
- Planting History.
- Weather Intelligence.
- Data Sources.
- Settings.

### Top navigation

- Selected farm.
- Selected field.
- Location.
- Current date.
- Notification center.
- User menu.

## Dashboard sections

### A. AI Climate Briefing

A prominent overview containing:

- Current climate summary.
- Short-range weather outlook.
- Upcoming rainfall trends.
- Seasonal climate outlook.
- Planting opportunities.
- Relevant agricultural risks.

Show source freshness and confidence context.

### B. Current weather overview

Display available local information:

- Temperature.
- Rainfall.
- Humidity.
- Wind.
- Observation time.
- Next forecast period.

Clearly distinguish actual observations from predictions.

### C. 12-month climate outlook

Build a continuously rolling annual view.

Support switching the selected farm and field.

Display monthly:

- Rainfall outlook.
- Rainfall anomaly.
- Temperature anomaly.
- Wet/dry tendency.
- Data type.
- Data quality.

### D. Annual planting calendar

This is the primary feature.

Implement three modes.

1. Yearly: 12-month overview.
2. Monthly: full calendar grid.
3. Detailed date: selected date and crop suitability information.

Yearly mode should present an organized 12-month grid.

Monthly mode should have seven columns and normal calendar navigation.

Each date may contain several crop icons.

If there are more crop icons than available space:

- Display a limited number of icons.
- Show a `+N` overflow indicator.
- Opening the overflow must reveal the complete crop list.

Clicking a date opens a detailed panel or dialog containing:

- Recommended crops.
- Crop-specific suitability.
- Reasons.
- Forecast information.
- Risk factors.
- Supporting data.
- Forecast source.
- Temporal resolution.
- Data freshness.
- Alternative planting windows.

Important rendering rules:

- Daily forecast information should only drive daily markers when that resolution is actually supported.
- Far-future projections should use monthly/dekadal windows.
- Never render an exact day marker as though the future daily weather is known when only monthly outlook data exists.
- Make the difference between forecast-based and climatology-based recommendations visually obvious.

### E. Planting opportunities

Create a ranked list of upcoming opportunities.

Allow filtering by:

- Crop.
- Cultivar.
- Field.
- Date range.
- Suitability.
- Forecast type.

### F. Climate charts

Build visualizations for:

- Rainfall by month.
- Historical rainfall versus projected rainfall.
- Temperature trends.
- Wet and dry periods.
- Monthly anomalies.
- Available soil moisture.
- Forecast probability bands.

Never plot missing values as zero.

## Crop icon overflow interaction

Ensure keyboard navigation, accessible labels, proper tooltips, and predictable positioning.

Do not make the UI depend on icon-only communication.

## Design quality

The UI must have:

- Proper loading states.
- Empty states.
- Error states.
- Offline/stale-data states.
- Clear units.
- Helpful tooltips.
- Consistent date formatting.
- Indonesian language support.
- Asia/Jakarta timezone.
- Proper mobile layouts.

Avoid fake live weather.

Use representative fixture data only in isolated UI stories or explicit demo mode.

## Deliverables

Complete dashboard, interactive climate calendar, crop opportunity interactions, climate charts, and comprehensive frontend tests.

---

# PHASE 8 — AI CLIMATE & AGRICULTURAL ANALYST

## Objective

Integrate AI to produce useful and explainable agricultural intelligence.

The AI must not replace the deterministic weather processing and agronomic rules engines.

It is a reasoning and communication layer over verified structured outputs.

## AI capabilities

The AI should answer:

- What are the current weather conditions?
- What is the next suitable planting window?
- Which crops are suitable for the selected field?
- Why is a crop suitable or unsuitable?
- Which weather risks are expected?
- What are the seasonal rainfall tendencies?
- How does the upcoming season compare with historical climatology?
- Should a planned planting date be reconsidered?
- Which additional field information is necessary?

## Context pipeline

The AI must receive structured information from:

1. Current observations.
2. Short-range forecasts.
3. Subseasonal outlook.
4. Seasonal outlook.
5. Annual outlook or climatology.
6. Agronomic suitability results.
7. Field information.
8. Weather-source metadata.

Do not provide raw, unverified assumptions as facts.

## Response structure

Use structured AI output.

Example:

```typescript
interface ClimateBriefing {
  headline: string;

  currentConditions: {
    summary: string;
    sourceStatus: string;
  };

  nearTermOutlook: {
    summary: string;
    relevantRisks: string[];
  };

  seasonalOutlook: {
    summary: string;
    timeHorizon: string;
    uncertainty: string;
  };

  plantingAdvice: Array<{
    cropId: string;
    recommendation: string;
    explanation: string[];
    windowStart?: string;
    windowEnd?: string;
  }>;

  warnings: string[];

  sources: Array<{
    provider: string;
    model: string;
    issuedAt: string;
  }>;
}
```

Adapt the contract as necessary.

## AI behavior requirements

- Answer in natural Indonesian.
- Avoid repetitive explanations.
- Distinguish factual data from interpretation.
- Mention when information is unavailable.
- Explain uncertainty without being unnecessarily alarmist.
- Never claim that planting is guaranteed to succeed.
- Never invent rainfall probabilities.
- Never change deterministic engine results.
- Never produce unsupported agronomic thresholds.
- Cite the underlying source metadata in the UI.
- Clearly disclose when a recommendation uses climatology rather than a genuine future forecast.

## Model integration

Create a provider abstraction.

Support OpenAI-compatible providers where appropriate.

Keep model name, API key, temperature, timeout, and token budget configurable through environment variables.

Validate all structured model outputs.

Implement graceful fallback if AI services are unavailable.

Keep deterministic application functionality operational without AI.

## Deliverables

Working AI briefing generation, structured validation, prompt documentation, source-aware explanations, and AI service tests.

---

# PHASE 9 — VERIFICATION, ACCURACY, HARDENING & DEPLOYMENT

## Objective

Make the application reliable, measurable, and ready for practical use.

## A. Weather forecast verification

Implement a historical forecast verification framework.

Where suitable observations and archived forecasts exist, evaluate:

- MAE.
- RMSE.
- Brier Score.
- CRPS.
- Probability calibration.
- Bias.
- Forecast reliability.
- Performance by lead time.
- Performance by location.
- Performance by season.

Use appropriate metrics for the forecast variable and its probabilistic or deterministic nature.

Compare models against a climatology baseline.

Do not claim a model has superior accuracy without evidence.

## B. Agricultural validation

Prepare test scenarios for different crops.

Test:

- Missing soil data.
- Missing irrigation data.
- Excess rainfall.
- Drought risk.
- Temperature stress.
- Different crop durations.
- Growth-stage-sensitive conditions.
- Seasonal uncertainty.
- Forecast changes after new model runs.

Ask `council` to challenge the agricultural assumptions.

Where agronomic correctness cannot be established through available references, document the limitation.

## C. Backend verification

Implement:

- Unit tests.
- Integration tests.
- API contract tests.
- Provider adapter tests.
- Background job tests.
- Database migration tests.
- Authorization tests.
- Error recovery tests.

## D. Frontend verification

Implement Playwright workflows for:

1. Login.
2. Create farm.
3. Create field.
4. Add crop.
5. Update crop requirements.
6. View 12-month climate outlook.
7. Open annual planting calendar.
8. Open crop overflow.
9. View planting window detail.
10. Generate AI briefing.
11. Update planting records.

## E. Operational hardening

Add:

- Structured logs.
- Correlation IDs.
- Metrics.
- Health endpoints.
- Worker monitoring.
- Provider failure alerts.
- Stale-data alerts.
- Database backup strategy.
- Redis recovery considerations.
- Rate limiting.
- Security headers.
- Secrets handling.
- Access control.

## F. Deployment

Prepare:

- Production Dockerfiles.
- Docker Compose production configuration or equivalent deployment manifests.
- Database migrations.
- Environment templates.
- CI/CD.
- Reverse proxy configuration.
- HTTPS requirements.
- Deployment runbook.
- Backup and restore runbook.
- Rollback strategy.

## G. Documentation

Complete:

- README.
- Architecture documentation.
- API documentation.
- Environment configuration.
- Weather provider setup.
- Data-source attribution.
- Crop configuration guide.
- Admin guide.
- Operational guide.
- Forecast limitation documentation.

## Definition of Done

The system is only complete when:

1. The entire monorepo builds.
2. Frontend and backend run independently.
3. Real data providers have been verified.
4. All source attribution requirements are respected.
5. The rolling 12-month view works.
6. Forecast and climatology are never confused.
7. Crop recommendations are explainable.
8. Daily and monthly forecast resolutions are not misrepresented.
9. The calendar overflow interaction works.
10. AI operates on validated structured data.
11. Historical verification can be performed where sufficient data exists.
12. Critical tests pass.
13. Deployment and recovery documentation exist.

Produce a final implementation report with all completed modules, remaining limitations, unresolved scientific assumptions, and production readiness assessment.

Do not claim 100% accuracy or guaranteed agricultural success.
