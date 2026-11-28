# API reference

Every route the service serves, in the order a client meets them: conventions
first, then the routes, then the error codes, then what does not exist.

The authority is the code. This page names the source file for each route so a
reader can check it, and §7 gives the command that regenerates the route list.
Schemas live in `packages/contracts`; this page describes their shape and their
limits, and does not reprint them — a second copy would drift.

- Controllers: `apps/api/src/*/*.controller.ts`
- Request and response schemas: `packages/contracts/src/`
- Status and code mapping: `apps/api/src/http/api-exception.filter.ts`
- Global pipeline: `apps/api/src/app.factory.ts`

## 1. Conventions

### Prefix

Every route is under `/v1` except the two probes, which are excluded from the
global prefix on purpose (`app.factory.ts:127`):

| Route            | Purpose  | Auth |
| ---------------- | -------- | ---- |
| `GET /health`    | liveness | none |
| `GET /health/ready` | readiness, one `SELECT 1` with a 2 s budget | none |

Liveness touches nothing — a database outage must not make the process look
dead and get it restarted for no reason. Readiness answers
`503 DEPENDENCY_UNAVAILABLE` when the budget is spent, including when it is
spent waiting for a pooled connection.

### Success envelope

```json
{ "data": { … } }
{ "data": [ … ], "meta": { "page": 1, "pageSize": 20, "total": 3 } }
```

`meta` appears only on lists. Both are `strictObject`s: an extra key is a
contract violation, not something a client may pass through.

### Error envelope

```json
{
  "error": {
    "code": "FIELD_NOT_FOUND",
    "message": "…",
    "details": { … },
    "requestId": "…"
  }
}
```

- `code` is the contract. `message` is user-facing copy and may be reworded
  without a version bump, so a client keys on `code`.
- `details` is per-code and optional. Today only `VALIDATION_FAILED` carries one:
  the issue list, forwarded when a `400` came from the validation pipe. No route
  emits `INSUFFICIENT_DATA` or either `503`, so the payloads the contract reserves
  for them — `missingInputs`, `retryAfter` — are not produced yet. A client must
  treat `details` as absent unless it knows the code.
- `requestId` is `X-Request-Id` as received when `TRUST_REQUEST_ID_HEADER` is on —
  a different switch from `TRUST_PROXY` — otherwise generated. It appears in the
  response header and body. It appears in a log line only for a `5xx`: a `4xx` is
  the client's answer, not the operator's event.

The body is produced by `ApiExceptionFilter` and parsed against
`errorResponseSchema` before it is sent, so a shape mismatch cannot reach a
client. An exception that is not an `HttpException`, or whose status the contract
does not map, becomes `500 INTERNAL_ERROR` — failing closed beats guessing that an
unfamiliar exception is really a `503`.

### Authentication

A session cookie, `__Host-agroclimate_session`, `Secure`, `Path=/`, no `Domain`,
`SameSite=Lax`. It is the only credential. Nothing in a path, query or body can
name a user or an owner: the subject is read from the validated session and
nowhere else.

Missing, malformed, unknown, expired and revoked sessions are one answer, `401
UNAUTHENTICATED`. Which of the five it was is not disclosed and is not recorded
either: the response is the same, and no `4xx` writes a log line. Treat the
distinction as unavailable, not as something an operator can look up.

### CSRF

`AuthGuard` requires an `X-CSRF-Token` header on `POST`, `PUT`, `PATCH` and
`DELETE` for every route it protects. There is no per-route annotation to
forget. The token comes from `GET /v1/auth/csrf`, is generated once per session
and never rotated, and every failure is the same `403 FORBIDDEN` — absent,
malformed, mismatched, or a session that never requested one.

Three routes do not reach the guard and therefore need no token: `register`,
`login`, `logout`. `Origin` validation still covers them.

### Origin

Before the body is parsed, a `POST`/`PUT`/`PATCH`/`DELETE` must carry an
`Origin` header that is an exact member of `CORS_ORIGINS`
(`origin.middleware.ts:46`). A missing header is refused. There is no wildcard,
suffix or prefix matching, and `Origin: null` cannot be configured. The refusal
is `403 FORBIDDEN` in the standard envelope, because this middleware runs before
Nest's routers and writes the body itself.

`GET`, `HEAD` and `OPTIONS` pass through.

### Rate limiting

30 requests per minute per client IP, one quota shared by `POST /v1/auth/register`
and `POST /v1/auth/login` (`rate-limit.guard.ts`). A refused request costs
neither an Argon2id run nor a query. Every answer on those routes carries
`RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`, as the standard
inspectable counter; a refusal is `429 RATE_LIMITED` with `Retry-After` in
seconds. What the refusal does not disclose is why — the caller's own quota or the
limiter being at capacity — so the two are indistinguishable.

"Client IP" is `req.ip`, which is the socket address unless `TRUST_PROXY` is
configured. The default is off, and `TRUST_PROXY=true` is refused at boot. When
it is configured, the quota is only as trustworthy as the proxy: a proxy that
**appends** to `X-Forwarded-For` rather than overwriting it lets a caller place a
value the server will read, and a client that rotates that header gets a fresh
bucket per request. Trusting such a hop therefore requires a proxy that
overwrites the header, not one that appends to it.

Only those two routes are limited. Read routes are not, and the limiter is
in-process per instance — see §8.

### Pagination

Offset paging with a page number. `page` starts at 1, `pageSize` defaults to 20
and caps at 100. `meta.pageSize` is the size the server actually used. `total`
is the count under the same tenant and `deleted_at IS NULL` predicates as the
page.

Query objects are `strictObject`s: an unknown parameter is a `400`, not a filter
the server silently ignores.

## 2. Auth — `apps/api/src/auth/auth.controller.ts`

| Method | Path             | Auth | CSRF | Success | Request                    |
| ------ | ---------------- | ---- | ---- | ------- | -------------------------- |
| POST   | `/v1/auth/register` | none | n/a | `201`   | `{ email, password }`      |
| POST   | `/v1/auth/login`    | none | n/a | `200`   | `{ email, password }`      |
| GET    | `/v1/auth/me`       | yes  | n/a | `200`   | —                          |
| GET    | `/v1/auth/csrf`     | yes  | n/a | `200`   | —                          |
| POST   | `/v1/auth/logout`   | cookie only | n/a | `204` | —                     |

**`register`** returns `{ id, email, role, locale, timezone }` inside `data`, and issues no
session, cookie or token. The password is hashed before the insert, so a
duplicate address costs as long as a fresh registration; the database's unique
constraint decides the conflict and it becomes `409 CONFLICT` with no `details`
— existence is disclosed by the status, and elaborating would disclose more.
`email` is normalised before validation and capped at 254 characters. `password`
is at least 12 Unicode code points and at most 1024 UTF-8 bytes; a grapheme
cluster counts as two code points, and an unpaired surrogate is refused.

**`login`** answers `200`, not `201`: it authenticates, it does not create an
addressable resource. The session token appears only in `Set-Cookie`. A wrong
password and an unknown address are the same `401`. The login password rule is
deliberately looser than registration's — a minimum length enforced here would
answer a too-short password with `400` and a wrong one with `401`, which tells
an attacker which addresses obey the policy.

**`me`** returns the subject the session names.

**`csrf`** is the only response that ever carries the token. It is `no-store`,
because a shared cache holding it would hand one session's token to another.

**`logout`** is `204` in all four cases — no cookie, malformed cookie, valid
session, already-revoked session. "This session is not usable now" is the
postcondition the caller asked for, and a `401` would make a retried logout after
a lost response look like a client bug. The row is revoked, never deleted. The
cookie is cleared only after the database answered.

`register` does not translate a database failure: it inserts directly, so an
outage there is `500 INTERNAL_ERROR`. Everything session-related goes through
`AuthService.withDatabaseErrors` and answers `503 DEPENDENCY_UNAVAILABLE`
instead — telling a client its credential was rejected because the server was
down is a lie it will act on.

## 3. Farms — `apps/api/src/farm/farm.controller.ts`

| Method | Path                | Auth | CSRF | Success | Request |
| ------ | ------------------- | ---- | ---- | ------- | ------- |
| POST   | `/v1/farms`         | yes  | yes  | `201` + `Location` | `{ name, region?, notes? }` |
| GET    | `/v1/farms`         | yes  | n/a  | `200`   | `page`, `pageSize`, `sort` |
| GET    | `/v1/farms/:farmId` | yes  | n/a  | `200`   | —       |
| PATCH  | `/v1/farms/:farmId` | yes  | yes  | `200`   | any subset of the create body |
| DELETE | `/v1/farms/:farmId` | yes  | yes  | `204`   | —       |

`name` is trimmed, 1–100 characters. `region` is at most 120, `notes` at most
2000, both nullable. The create schema is the update schema with every key
optional plus a refinement requiring at least one, so `PATCH` cannot erase a
property and cannot be sent empty.

`sort` is one of `name`, `createdAt`, `updatedAt`, each optionally prefixed with
`-` for descending; the default is `-createdAt`.

`POST` sets a **relative** `Location` (`/v1/farms/:id`). The service is served
behind a single origin, and a scheme or host invented from a `Host` header the
server does not trust is worse than a relative reference.

`PATCH` returns the updated row and is last-write-wins; there is no `If-Match`.
`DELETE` is a soft delete: `204` on success, `404 FARM_NOT_FOUND` for a farm that
is not this tenant's or is already deleted, `409 CONFLICT` while live fields
still reference it. That decision is made under a row lock in the database; the
handler only names it in HTTP terms.

## 4. Fields — `apps/api/src/field/field.controller.ts`

| Method | Path                             | Auth | CSRF | Success | Request |
| ------ | -------------------------------- | ---- | ---- | ------- | ------- |
| POST   | `/v1/fields`                     | yes  | yes  | `201` + `Location` | `{ farmId, name, geometry }` |
| GET    | `/v1/fields`                     | yes  | n/a  | `200`   | `page`, `pageSize`, `sort`, `farmId?` |
| GET    | `/v1/fields/:fieldId`            | yes  | n/a  | `200`   | —       |
| PATCH  | `/v1/fields/:fieldId`            | yes  | yes  | `200`   | `{ name?, geometry? }` |
| POST   | `/v1/fields/:fieldId/resolve-cell` | yes | yes | `200`   | `{ provider, model }` |
| DELETE | `/v1/fields/:fieldId`            | yes  | yes  | `204`   | —       |

The collection is flat: `farmId` is an optional filter, not a path segment.
Supplying it scopes the page to one parent and gives that parent the Farm
not-found semantics; omitting it lists the tenant's fields. `sort` adds `areaHa`
to the Farm set.

`geometry` is a GeoJSON **`Polygon` only**, with rings of `[longitude, latitude]`
pairs. The contract checks the cheap structural half and no more: exactly two
ordinates per position, no third, coordinates within ±180/±90, the first ring
position repeated last, at least four positions per ring. `crs`, `bbox` and any
other member are refused, because RFC 7946 removed `crs` and PostGIS honours one
that is declared. Self-intersection and emptiness are `ST_IsValid`'s job — the
API does not reimplement GEOS.

`areaHa` is generated by PostgreSQL from the stored geometry and is not writable.
Replacing `geometry` recomputes it.

Two `404`s are distinct on purpose. A write or a `farmId` filter whose **parent**
is missing answers `FARM_NOT_FOUND` — that is the noun the caller named. A field
that is missing, foreign, or deleted answers `FIELD_NOT_FOUND`, identically in
all three cases.

**`resolve-cell`** maps the field's centroid onto a provider grid. The request
carries the registry key and nothing else: a coordinate, a `cellKey`, a `gridId`,
a hash or an algorithm version supplied by a client would have to be ignored or
trusted, and both are worse than refusing them. It answers `200`, not `201` —
the only row it may write is a global cell identity with no addressable URL. The
second identical call returns the same body. `servedCoordinate` is always `null`
and is written on purpose: the resolver has no provider response, and a missing
key would invite a reader to treat `anchor` as the served position. An unknown
`(provider, model)` answers `GRID_NOT_FOUND`, a position outside the grid
`CELL_NOT_FOUND`, and neither writes a cell.

## 5. Climate — `apps/api/src/climate/climate.controller.ts`

| Method | Path                  | Auth | Success | Request |
| ------ | --------------------- | ---- | ------- | ------- |
| GET    | `/v1/climate/outlook` | yes  | `200`   | `fieldId`, `provider`, `model`, `firstMonth?` |
| GET    | `/v1/climate/forecast` | yes | `200`   | `fieldId`, `provider`, `model`, `firstDate?` |

Both are `GET`, so neither needs a CSRF token. Both answer `404
FIELD_NOT_FOUND` for a field that is missing, foreign or deleted, and
`GRID_NOT_FOUND` / `CELL_NOT_FOUND` for the grid failures the resolver raises.

**`outlook`** is the twelve-month horizon. `months` always has exactly 12
entries, including the ones with no stored row. Lead months 1–6 are
`seasonal_forecast` when a complete seasonal run exists, 7–12 are `climatology`
where a normal exists, and a month with nothing stored is `pending` — not zero,
and not `ingest_failed`, because nothing records the cause of a failed
derivation. A seasonal month also carries `availability` (`fresh | stale`),
derived at read time from the run's initialisation. `firstMonth`, when given,
must be the first day of a calendar month.

**`forecast`** is days 0–45, read directly from live weather records, in two
ordered segments: 0–14 `weather_forecast`, 15–45 `subseasonal_forecast`. Every
day carries its own model, run, freshness and resolution, because a 45-day
horizon may mix runs.

The two routes are deliberately separate. The monthly contract is unchanged by
the daily route, and the monthly route remains the only source of lead months
1–12. Do not read `forecast` as a long-range daily product: nothing in this
service claims one.

`firstMonth`/`firstDate` shift the window; omitting them starts it at the
current date's month or day, computed by the assembled read, not by the client.

## 6. Crop catalog — `apps/api/src/crop/crop.controller.ts`

| Method | Path                                | Auth | Success | `data` |
| ------ | ----------------------------------- | ---- | ------- | ------ |
| GET    | `/v1/crops`                         | yes  | `200`   | `{ crops: [ … ] }` |
| GET    | `/v1/crops/:slug`                   | yes  | `200`   | one crop with its cultivars and profile versions |
| GET    | `/v1/crop-profiles/:profileVersionId` | yes | `200`  | the rulebook: stages, thresholds, citations |
| GET    | `/v1/crop-profiles/:profileVersionId/cycle` | yes | `200` | stages projected onto calendar dates from one cycle-start date; harvest as a duration range |

Read-only, and there is no write route in this build: a published profile version
is frozen once it exists, so there is nothing for the API to mutate. The catalog
is identical for every tenant, and it is still authenticated: "public" is not
something this build offers anywhere else, and one unauthenticated surface would
be a second trust rule to keep in step.

`cycle` is arithmetic, not a recommendation: it reads the stored stage offsets
and the cultivar's duration range, and no weather. `cycleStartDate` is a calendar
day (`YYYY-MM-DD`, `2026-02-30` is rejected rather than normalised) and must be
the event the cultivar's `cycleStart` names — `sowing` or `transplant`, echoed in
the response. The typical duration places the stages; a stage that runs past it
is clipped and flagged, and the harvest is returned as `earliest`/`typical`/`latest`.
An unknown query parameter is refused, so no caller can substitute its own duration.

`404 CROP_NOT_FOUND` for an unknown slug, `404 PROFILE_NOT_FOUND` for an unknown
version id.

A catalog row is not a recommendation. Each threshold and citation carries an
evidence grade A–D, always present and never nullable; whether that grade may
gate a verdict is a rule of the engine, not of the catalog, and the engine's own
"no dimension observed" answer is `null` there because that is a statement about
what was measured.

## 7. Error codes

`code` is one of nine singletons or a `<RESOURCE>_NOT_FOUND` string.

| Code | Status | Meaning |
| ---- | ------ | ------- |
| `VALIDATION_FAILED` | `400` | the request itself was unusable; `details` is the issue list |
| `UNAUTHENTICATED` | `401` | no usable session |
| `FORBIDDEN` | `403` | a refused `Origin` — which needs no session — or a CSRF token that did not match a valid one |
| `CONFLICT` | `409` | a constraint the client must resolve first (duplicate email, farm with live fields) |
| `INSUFFICIENT_DATA` | `422` | the request was well formed, the inputs to answer are not present |
| `RATE_LIMITED` | `429` | `Retry-After` in seconds |
| `INTERNAL_ERROR` | `500` | a bug, mapped closed rather than to a code that invites a retry |
| `DEPENDENCY_UNAVAILABLE` | `503` | a dependency this request needed did not answer in budget |
| `PROVIDER_UNAVAILABLE` | `503` | an upstream provider refused or failed; `details.retryAfter` when it said so |
| `*_NOT_FOUND` | `404` | the resource is missing, foreign, or deleted — never distinguished |

The filter refuses a code whose meaning contradicts the status the handler
chose: a handler cannot report an `INTERNAL_ERROR` as `200`, or a `409` as a
rate limit. Four transport statuses the framework raises before a handler runs —
`405`, `406`, `413`, `415` — keep their status and carry `VALIDATION_FAILED`,
because the code names the category and the status refines it.

## 8. What this API does not have

Each of these is an absence, not an oversight:

- **No unauthenticated read surface.** Not even the catalog.
- **No version negotiation.** The path carries `/v1`; nothing reads an `Accept`
  header for a version.
- **No `If-Match` / `ETag`.** v1 is last-write-wins, by decision (`Q8`).
  `PATCH` is a partial merge with no way to erase a property.
- **No `Idempotency-Key` handling.** The header is allowed through CORS so a
  future mechanism does not need a preflight change, and nothing reads it.
- **No bulk endpoints.** One resource per request.
- **No write route for catalog, climate or suitability data.** Those rows are
  written by an internal process, not by this API.
- **No rate limit on read routes.** The limiter covers the two auth routes only,
  and it is an in-process fixed window per instance: behind more than one
  instance, each holds its own counter. That is a known property of the shipped
  guard, not a distributed limiter.
- **No CORS wildcard.** `CORS_ORIGINS` rejects `*`, and `credentials: true` with
  a wildcard is invalid anyway.
- **No object storage, no file upload, no generated document.** Nothing returns a
  file handle, so there is no per-object permission to get wrong.
- **No graph, no RPC, no websocket.** JSON over HTTP.

## 9. Newly added routes (Phase 3.6–3.7, Phase 6, Phase 8)

All routes below require a valid session cookie (`AuthGuard`); state-changing `POST`/`PATCH` routes also require trusted `Origin` and `X-CSRF-Token`:

| Method & Path | Controller | Purpose |
| --- | --- | --- |
| `POST /v1/plantings`, `GET /v1/plantings`, `GET /v1/plantings/:plantingId`, `PATCH /v1/plantings/:plantingId` | `ActivityController` | Create, list, read, and transition (`active` → `harvested` \| `failed` \| `abandoned`) field plantings (`OPEN-09`). |
| `POST /v1/plantings/:plantingId/harvests`, `GET /v1/plantings/:plantingId/harvests` | `ActivityController` | Record and list harvests with summed `meta.totalYieldKg`. |
| `POST /v1/fields/:fieldId/observations`, `GET /v1/fields/:fieldId/observations` | `ActivityController` | Record and list local field observations (`rainfall`, `soil_moisture`, `temperature`, `note`). |
| `POST /v1/fields/:fieldId/evaluate`, `GET /v1/fields/:fieldId/suitability`, `GET /v1/planting-windows` | `AgronomyController` | Run deterministic suitability + window generation with atomic supersession, read latest field suitability, and filter active planting windows. |
| `POST /v1/fields/:fieldId/briefing`, `GET /v1/fields/:fieldId/briefing` | `BriefingController` | Generate/cache or read latest `OPEN-11` structured `ClimateBriefing` grounded in `evidenceSegmentIds` with deterministic fallback. |
| `GET /v1/fields/:fieldId/agronomy`, `PATCH /v1/fields/:fieldId/agronomy` | `FieldController` | Read and update closed-vocabulary agronomic field properties (`OPEN-21`: `soilType`, `drainageClass`, `irrigationAvailability`, `soilPh`, `elevationM`, `waterSource`, `croppingHistoryNotes`). |
| `DELETE /v1/auth/account` | `AuthController` | Soft-delete the authenticated account (`OPEN-04`), revoke live sessions, and clear session cookie. |

## 10. Keeping this page true

The route count is mechanical:

```bash
grep -rn "@Get(\|@Post(\|@Patch(\|@Put(\|@Delete(\|@Controller(" \
  apps/api/src --include=*.controller.ts
```

That prints 23 route decorators across six controllers and six `@Controller`
class decorators. The probes are the two routes outside `/v1`; everything else
appears in the tables above under its controller.

A claim on this page that quotes a limit — a length, a default, a budget, a
status — should be checked against `packages/contracts` or the named source file
before it is repeated. The tests that pin the shapes are
`packages/contracts/src/*.test.ts`; the tests that pin the status and code
behaviour are the `node:test` suites in `apps/api/test/`. Most start the app and
call it over HTTP (`routing`, `http`, `origin`, `rate-limit`, and everything under
`integration/`), which is what catches a prefix or header mistake; `errors` drives
the exception filter directly, so it pins the mapping rather than the transport.
