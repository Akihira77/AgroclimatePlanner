# API Conventions

Status: Phase 1. Binding on Phase 3–8. OpenAPI is generated from Zod schemas in `packages/contracts`.

## 1. Base

- Base path `/v1`. Breaking change ⇒ `/v2`, never a silent shape change.
- `Content-Type: application/json; charset=utf-8`. All timestamps ISO-8601 UTC (`Z`); user-facing dates computed in `Asia/Jakarta`.
- IDs: opaque ULID strings, never sequential integers in the URL.
- Money: not applicable. Units must be explicit on every numeric field (`value`, `unit`), never implied by the key name alone.

## 2. Resource shape

```
GET /v1/farms
{
  "data": [ … ],
  "meta": { "page": 1, "pageSize": 20, "total": 3 }
}
```

Single resource: `{ "data": { … } }`. Errors never return `data`.

## 3. Errors

```json
{
  "error": {
    "code": "FIELD_NOT_FOUND",
    "message": "Petak tidak ditemukan.",
    "details": [{ "path": "fieldId", "issue": "unknown_id" }],
    "requestId": "01J..."
  }
}
```

| Status | Code family | Meaning |
|---|---|---|
| 400 | `VALIDATION_FAILED` | Zod rejected the body/query |
| 401 | `UNAUTHENTICATED` | no/expired session |
| 403 | `FORBIDDEN` | authenticated, not owner |
| 404 | `*_NOT_FOUND` | missing or not owned (never distinguish the two) |
| 409 | `CONFLICT` | duplicate slug, published profile edit |
| 422 | `INSUFFICIENT_DATA` | agronomic input missing; body lists `missingInputs[]` |
| 429 | `RATE_LIMITED` | with `Retry-After` |
| 503 | `PROVIDER_UNAVAILABLE` / `DATA_STALE` | with `retryAfter`, and a `lastKnown` block when available |

`DATA_STALE` is a first-class outcome, not a 200 with a footnote. A client that ignores freshness must be forced to acknowledge it.

## 4. Weather and climate responses carry provenance, always

Every object containing a weather-derived value includes:

```ts
{
  value: 247.6,
  unit: "mm",
  dataClass: "seasonal_forecast",     // one of the 9 classes, ADR-001 D9
  source: { provider: "open-meteo", model: "ecmwf_seas5", runId: "…", initializedAt: "…" },
  spatialResolutionKm: 36,
  servedValueIsInterpolated: true,
  freshness: { isStale: false, ageSeconds: 86400, ttlSeconds: 3024000 },
  attribution: "ECMWF / Open-Meteo"
}
```

Rules:
1. `temporalClass` may not be inferred by the client from the date. It is always sent.
2. A response may contain several classes (a 12-month outlook). It may never emit a single aggregate that spans classes.
3. `anomaly` objects carry `anomalyKind` (`model_relative` | `baseline_difference`) plus `baseline` and, for the latter, `modelClimateOffsetMm`.

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

POST   /v1/ai/briefing?fieldId=…        (cached per runId)
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

The API exposes `engineVersion`, `profileVersionId`, and `outlookRunId` on derived resources. Two responses with the same URL can legitimately differ because the underlying run changed; the client must be able to tell why without diffing values.

## 11. OpenAPI requirements

- Every endpoint documented, including error variants.
- `dataClass`, `runId`, and `freshness` are required properties in the generated schema — not optional, so an implementation cannot forget them.
- Contract tests (Phase 9) assert that responses validate against the schema for both fresh and stale fixtures.
