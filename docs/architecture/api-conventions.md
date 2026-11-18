# API Conventions

Status: Phase 1. Binding on Phase 3–8. OpenAPI is generated from Zod schemas in `packages/contracts`.

## 1. Base

- Base path `/v1`. Breaking change ⇒ `/v2`, never a silent shape change.
- Two exceptions, both operational and both outside the version prefix: `GET /health` (process liveness) and `GET /health/ready` (readiness, including a bounded database check). They are unversioned because a probe must not break when the API version changes; an outage must not be reported as healthy.
- Every response carries `X-Request-Id`. The value is a UUID minted per request by the server, and the same value appears in the body of any error response. A caller-supplied `X-Request-Id` is ignored unless trusted-proxy header propagation is explicitly enabled in configuration.
- `Content-Type: application/json; charset=utf-8`. All timestamps ISO-8601 UTC (`Z`); user-facing dates computed in `Asia/Jakarta`.
- IDs: opaque **UUIDv7** strings, never sequential integers in the URL. One id space — the value in the URL is the primary key in Postgres (`uuid`, 16 bytes, native Prisma support, time-ordered for index locality). Deliberately **not** ULID: a 26-char text key doubles the PK index size, needs a CHECK constraint to be safe, and buys nothing UUIDv7 lacks (ULID's sortability is the only advantage, and v7 has it). It is also deliberately not "UUID internally, ULID publicly" — that mapping would have to be applied in every RLS policy, every join, and every URL parse, which is a whole class of bug for zero benefit. `app.user_id` is therefore a `uuid`, and policies cast `::uuid`.
- Money: not applicable. Units must be explicit on every numeric field (`amount`, `unit`), never implied by the key name alone.

## 2. Resource shape

```
GET /v1/farms
{
  "data": [ … ],
  "meta": { "page": 1, "pageSize": 20, "total": 3 }
}
```

Single resource: `{ "data": { … } }`. Errors never return `data`.

One generic schema covers both list and single-resource responses: `envelopeSchema(dataSchema)` is the single-resource shape, and `envelopeSchema(dataSchema, metaSchema)` adds a required `meta`. There is no separate "single resource" schema, because it would be the same object under a second name.

## 3. Errors

```json
{
  "error": {
    "code": "FIELD_NOT_FOUND",
    "message": "Petak tidak ditemukan.",
    "details": [{ "path": "fieldId", "issue": "unknown_id" }],
    "requestId": "018f5b7e-6f3a-7c2b-9d1e-4a5b6c7d8e9f"
  }
}
```

Both envelopes are implemented once in `packages/contracts/src/response.ts` as
`envelopeSchema` and `errorResponseSchema`; `code` is `errorCodeSchema`. Unknown keys
are rejected on both, so a controller cannot add a field the contract does not carry.

`requestId` is a **UUID string** (RFC 9562), not a ULID — the id family is the same one
§1 already chose for resources, and `crypto.randomUUID()` produces one without a
dependency. Generation and propagation are middleware work; this document only fixes
the shape.

| Status | Code family | Meaning |
|---|---|---|
| 400 | `VALIDATION_FAILED` | Zod rejected the body/query |
| 401 | `UNAUTHENTICATED` | no/expired session |
| 403 | `FORBIDDEN` | authenticated, not owner |
| 404 | `*_NOT_FOUND` | missing or not owned (never distinguish the two) |
| 409 | `CONFLICT` | duplicate slug, published profile edit |
| 422 | `INSUFFICIENT_DATA` | agronomic input missing; body lists `missingInputs[]` |
| 429 | `RATE_LIMITED` | with `Retry-After` |
| 503 | `PROVIDER_UNAVAILABLE` | no usable weather value exists **and** no permitted fallback — with `retryAfter` |
| 503 | `DEPENDENCY_UNAVAILABLE` | an infrastructure dependency (session store, database) is unreachable — fail closed |
| 500 | `INTERNAL_ERROR` | an unexpected failure the server did not classify. No stack trace, SQL text, connection string, or exception message reaches the body |
| 202 | *(no error)* | data missing while ingest is `pending`; body carries `retryAfter` and no fabricated value |

The two `503`s are not interchangeable. `PROVIDER_UNAVAILABLE` is a statement about
weather data: the value does not exist and no permitted fallback supplies it, which a
client may route around. `DEPENDENCY_UNAVAILABLE` is a statement about us. Widening
`PROVIDER_UNAVAILABLE` to cover both would give one code two meanings and force a
client to guess which outage it is reacting to.

`details` is deliberately unconstrained: each code owns its payload (`{ path, issue }[]`
for validation, `missingInputs[]` for insufficient input, `retryAfter` for the `503`s),
and one shared shape would either drop fields or describe them wrongly.

`RESOURCE_NOT_FOUND` is the family's generic member, used when a path names no
resource at all. It is not an endpoint's code; a handler that knows which noun is
missing returns that noun (`FIELD_NOT_FOUND`), validated through
`notFoundErrorCodeSchema`. The filter also keeps `405`/`406`/`415` with their own
status and falls back to `VALIDATION_FAILED` — the request, not the server, was
unacceptable — and maps every other unmapped status to `500 INTERNAL_ERROR` rather
than inventing a code for it.

`DATA_STALE` is **not** an error status. Stale-but-usable data returns `200` with `freshness.dataAvailability = "stale"` and its reason. Mapping staleness to `503` would train clients to retry a request that can be answered, and would hide the distinction between "old" and "absent". Full matrix in `provenance-contract.md` §7.

Staleness is stated in the body on **every** response that carries weather-derived data, including `200`. There is no successful weather response without a `freshness` object, so a client cannot accidentally render a value with no age attached. `DATA_STALE` is not an error code; it does not exist as one.

## 4. Weather and climate responses carry provenance, always

Provenance is **conditional on the data class**, because the classes do not have the same provenance to offer. A climatology value has no initialization time; a field observation has no provider run. Making every property optional to fit one flat shape would mean the contract guarantees nothing — so the value is a discriminated union on `dataClass`.

```ts
type WeatherValue<TUnit extends string> =
  | ForecastValue<TUnit> | BaselineValue<TUnit>
  | DatasetValue<TUnit>  | ObservationValue<TUnit>;

interface ValueBase<TUnit> {
  dataClass: WeatherDataClass;                 // discriminant
  evaluationBasis: "daily" | "weekly" | "monthly" | "climatology" | "mixed";
  dataAvailability: "available" | "stale" | "pending" | "unavailable" | "not_applicable";
  amount?: number;                             // absent when not available — never 0
  unit: TUnit;
  spatialResolutionKm: number;
  servedValueIsInterpolated: boolean;
  freshness: SourceFreshness;
  attribution: string;
}

// weather_forecast | subseasonal_forecast | seasonal_forecast | annual_outlook
interface ForecastValue<TUnit> extends ValueBase<TUnit> {
  dataClass: "weather_forecast" | "subseasonal_forecast" | "seasonal_forecast" | "annual_outlook";
  source: {
    provider: string; model: string; modelVersion?: string;
    forecastRunId: string; ingestionRunId: string;
    initializedAt: string;                     // REQUIRED here
  };
}

// climatology
interface BaselineValue<TUnit> extends ValueBase<TUnit> {
  dataClass: "climatology";
  baseline: { baselineVersion: string; periodFrom: string; periodTo: string };
  source?: never; initializedAt?: never;       // forbidden, not merely absent
}

// reanalysis | satellite_estimate
interface DatasetValue<TUnit> extends ValueBase<TUnit> {
  dataClass: "reanalysis" | "satellite_estimate";
  dataset: { provider: string; name: string; datasetVersion: string; validAt: string };
  initializedAt?: never;
}

// field_observation — the only class that may say "observed"
interface ObservationValue<TUnit> extends ValueBase<TUnit> {
  dataClass: "field_observation";
  observation: { observationId: string; observedAt: string; method: string };
  source?: never; initializedAt?: never;
}
```

`source?: never` and `initializedAt?: never` are deliberate: they turn "climatology carrying an `initializedAt`" into a compile error instead of a runtime lint. A shape that merely omits the field invites an adapter to fill it.

For a month beyond the seasonal horizon, both axes are explicit and the value carries its true class:

```json
{
  "date": "2027-03-01",
  "forecast":    { "dataAvailability": "not_applicable", "reason": "beyond_horizon" },
  "climatology": { "dataAvailability": "available", "baselineVersion": "ERA5:1991-2020:v1" },
  "value": {
    "dataClass": "climatology",
    "evaluationBasis": "climatology",
    "dataAvailability": "available",
    "amount": 244.2,
    "unit": "mm",
    "baseline": { "baselineVersion": "ERA5:1991-2020:v1",
                  "periodFrom": "1991-01-01", "periodTo": "2020-12-31" },
    "spatialResolutionKm": 28,
    "servedValueIsInterpolated": true,
    "freshness": { "kind": "source", "dataAvailability": "available" },
    "attribution": "Copernicus / ECMWF"
  }
}
```

Rules:
1. `evaluationBasis`, `dataClass`, and `dataAvailability` are **required on every variant**. A client may not infer any of them from the date.
2. Per-variant provenance is enforced by the type: `forecastRunId`/`ingestionRunId`/`initializedAt` are required where they exist and forbidden where they do not. There is no `displayedClass` or equivalent escape hatch — `dataClass` is the only place the class is stated.
3. A value whose `dataAvailability` is `pending`, `unavailable`, or `not_applicable` has **no `amount`**. Sending `0` there would be a fabricated measurement.
4. A response may contain several classes (a 12-month outlook). It may never emit a single aggregate that spans classes; containers carry `evidenceSegments`.
5. `anomaly` objects carry `anomalyKind` (`model_relative` | `baseline_difference`), `baselineVersion`, and, for the latter, `modelClimateOffsetMm`.
6. When a source failed and a previous value is still shown, the value lives under `lastKnown` with `dataAvailability = "stale"` and `reason = "provider_unavailable"`. It is never promoted to the current field.
7. Window responses include `evidenceSegments[]`, `missingRanges[]`, `primaryBasis`, `mixedEvidence`, and `weakestEvidenceClass`.

## 5. Pagination, filtering, sorting

- `?page=1&pageSize=20` (max 100). Cursor pagination only for activity feeds.
- Filters are explicit and validated: `?suitability=good&cropId=…&from=2026-11-01&to=2027-10-31`.
- Sorting: `?sort=-startDate` (`-` descending), whitelist per resource.
- Unknown query params are a `400`, not ignored. Silently ignoring a filter is how users lose trust in a "no results" screen.

## 6. Endpoint surface (v1)

```
POST   /v1/auth/login | /logout | GET /v1/auth/me

GET    /v1/farms                       POST /v1/farms
GET    /v1/farms/:id                   PATCH /v1/farms/:id
GET    /v1/farms/:id/fields            POST /v1/farms/:id/fields
GET    /v1/fields/:id                  PATCH /v1/fields/:id
POST   /v1/fields/:id/resolve-cell     (returns provider cell mapping)

GET    /v1/crops                       POST /v1/crops
GET    /v1/crops/:id/cultivars         POST /v1/crops/:id/cultivars
GET    /v1/profiles/:id                POST /v1/profiles/:id/publish
POST   /v1/profiles/:id/duplicate

GET    /v1/weather/current?fieldId=…    (forecast, labelled)
GET    /v1/weather/daily?fieldId=…&from=…&to=…
GET    /v1/weather/sources

GET    /v1/climate/outlook?fieldId=…    (12 months, per-month class)
GET    /v1/climate/monthly?fieldId=…&year=…
GET    /v1/climate/anomalies?fieldId=…
GET    /v1/climate/data-quality?fieldId=…

GET    /v1/agronomy/windows?fieldId=…&cropId=…
GET    /v1/agronomy/windows/:id
POST   /v1/agronomy/evaluate            (ad-hoc, rate-limited)

GET    /v1/activities/plantings        POST /v1/activities/plantings
POST   /v1/activities/harvests
GET    /v1/observations                POST /v1/observations

POST   /v1/ai/briefing?fieldId=…        (cached per inputSnapshotHash)
GET    /v1/monitoring/sources
GET    /v1/monitoring/queues
GET    /health  |  /health/ready
```

## 7. Write semantics

- `POST` returns `201` + `Location`.
- Mutations are idempotent where the client may retry: plantings and observations accept `Idempotency-Key`.
- Optimistic concurrency on profile edits via `If-Match: <version>`; a stale edit returns `409`.
- Deleting a farm soft-deletes; weather records are never deleted by any endpoint.

## 8. Auth and authorization

- Session cookie (`HttpOnly`, `Secure`, `SameSite=Lax`), server-side session table, sliding expiry 30 d, absolute 90 d.
- CSRF: double-submit token on non-GET.
- Authorization: ownership checked at the controller boundary, mirrored by Postgres RLS. A `404` is returned for another user's resource — never `403`, which leaks existence.
- Roles: `owner` (everything on own data), `admin` (catalog and profile publishing, read-only on other users' farms). No per-field granularity in v1.

## 9. Rate limiting

- Public/auth endpoints: 30 req/min/IP.
- Read endpoints: 300 req/min/user.
- `POST /agronomy/evaluate` and `POST /ai/briefing`: 20/hour/user, because both are compute-costly and neither is needed at dashboard speed.
- Responses include `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`.

## 10. Versioning of semantics, not just routes

The API exposes `engineVersion`, `profileVersionId`, `derivationVersion`, `inputRefs`, `fieldSnapshot.fieldSnapshotHash`, and `inputSnapshotHash` on derived resources — plus `primaryForecastRunId` as a convenience when one run dominates. Two responses with the same URL can legitimately differ because the underlying run changed; the client must be able to tell why without diffing values. There is no single `outlookRunId`; a derived artifact consumes several runs and a baseline.

## 11. OpenAPI requirements

- Every endpoint documented, including error variants.
- `dataClass`, `evaluationBasis`, `dataAvailability`, and `freshness` are required on **every** `WeatherValue` variant, and the OpenAPI model is generated as a `oneOf` discriminated on `dataClass` — not a single object with all-optional provenance fields. Per-variant required properties (`forecastRunId`/`ingestionRunId`/`initializedAt` on forecasts, `baseline` on climatology, `observation` on field measurements) are required **within their variant**.
- Contract tests (Phase 9) assert that responses validate against the schema for fresh, stale, pending, and climatology fixtures — a climatology fixture that includes an `initializedAt` must fail validation, not pass silently.

## 12. Transport and runtime configuration

Implemented in `apps/api` (Phase 3.2, step S2). Nothing here changes the response
contract above; it fixes how a request becomes a response.

- **Validation.** One global `ValidationPipe`: `whitelist`, `forbidNonWhitelisted`,
  `transform`, and `enableImplicitConversion: false`. An unknown property is a `400`
  `VALIDATION_FAILED`, not a silently dropped field, and a query string `"3"` stays a
  string until a DTO declares otherwise. `details` carries `{ path, issue }` entries
  describing the failure — never the submitted value.
- **Errors.** One global exception filter. It is the only place an HTTP status is
  chosen, it validates what it is about to send against `errorResponseSchema`, and it
  falls back to `500 INTERNAL_ERROR` if that validation fails. Unrecognised
  exceptions never contribute their message.
- **CORS.** Explicit allowlist from `CORS_ORIGINS` (comma-separated). Credentials are
  not enabled — no cookie is issued by this phase. In production the variable is
  required; in development it defaults to `http://localhost:5173`. An invalid entry
  fails startup rather than widening the policy.
- **Trust proxy.** `TRUST_PROXY` is explicit and off by default. Accepted values:
  `false` (default), `loopback`, `linklocal`, `uniquelocal`, or a comma-separated list
  of those and/or IPv4/IPv6 CIDRs. `true` is rejected: it would let any caller set
  `X-Forwarded-For` and choose their own client IP, and rate limiting in a later phase
  depends on that value being real. Deployments behind Caddy set `TRUST_PROXY=loopback`.
- **Cookies.** `cookie-parser` is registered with no secret: signed cookies are not part
  of this phase, and a secret would imply a trust decision nobody has made yet.
- **Database.** The API connects as `app_api` through `APP_API_DATABASE_URL`. Outside
  development that variable is required; inside development it is derived from
  `APP_API_PASSWORD` and the shared database defaults. `MIGRATION_DATABASE_URL` is
  never read by the API — it carries schema-owner privileges the runtime must not hold.
  Missing configuration fails startup rather than falling back to another role.
- **Readiness.** `/health/ready` runs `SELECT 1` through the pooled client under a
  bounded timeout and returns `503 DEPENDENCY_UNAVAILABLE` when it fails or times out.
  Redis is not checked because it is not provisioned.
- **Tests.** `pnpm --filter @agroclimate/api test` builds and runs `node --test`. HTTP
  plumbing tests do not need a live PostgreSQL; the database token is replaced with a
  controlled double. A double proves lifecycle wiring, not connectivity or privilege.
