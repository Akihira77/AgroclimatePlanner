# System Architecture

Status: Phase 1. Decision record: `docs/adr/ADR-002-monorepo-and-backend-architecture.md`.

## 1. Shape

Modular monolith with three deployables and a shared package graph. One Postgres, one Redis, one object store (optional, for raw provider payloads).

```mermaid
flowchart TB
  subgraph Client
    WEB["apps/web<br/>React 19 + Vite + TanStack Router/Query"]
  end

  subgraph API["apps/api — NestJS"]
    direction TB
    HTTP["HTTP layer<br/>controllers, Zod DTOs, OpenAPI"]
    subgraph Modules
      AUTH[auth]
      FARM[farm]
      CROP[crop]
      WX[weather]
      CLI[climate]
      AGR[agronomy]
      ACT[activity]
      MON[monitoring]
      AI[ai]
    end
    HTTP --> AUTH & FARM & CROP & WX & CLI & AGR & ACT & MON & AI
  end

  subgraph WORKER["apps/worker — BullMQ consumers"]
    ING[ingest: bmkg / om-forecast / om-ensemble / om-seasonal]
    AGG[aggregate: monthly, climatology, spread]
    ENG[recompute: outlook, windows, briefings]
    VER[verify: forecast scoring]
  end

  subgraph DATA
    PG[("PostgreSQL + PostGIS")]
    RD[("Redis / BullMQ")]
    S3[("raw payload store<br/>optional")]
  end

  subgraph EXTERNAL
    BMKG[BMKG API]
    OM[Open-Meteo<br/>forecast / ensemble / seasonal / archive]
    ERA[ERA5 via archive API]
  end

  WEB -->|"REST /v1, session cookie"| HTTP
  AUTH --> PG
  FARM --> PG
  CROP --> PG
  AGR --> PG
  ACT --> PG
  WX -->|"read normalized"| PG
  CLI -->|"read outlook"| PG
  MON --> PG
  AI -->|"structured context only"| CLI
  AI -.->|"OpenAI-compatible"| LLM[DeepSeek V4.1 Flash]
  HTTP -->|"enqueue"| RD
  RD --> ING & AGG & ENG & VER
  ING --> BMKG & OM
  ING --> PG
  ING -.-> S3
  AGG --> PG
  ENG --> PG
  VER --> PG
```

## 2. Applications

| App | Runtime | Responsibility | Must not |
|---|---|---|---|
| `apps/web` | static SPA | render, route, cache, call API | compute suitability, derive anomalies, invent labels |
| `apps/api` | Node 22, NestJS/Express | auth, CRUD, read models, enqueue jobs, serve contracts | hold long-running provider calls on the request path |
| `apps/worker` | Node 22, BullMQ | ingest, aggregate, recompute, verify | serve user traffic or own business rules that the API needs synchronously |

**Rule:** the API never calls a weather provider synchronously. If the data is stale, the API returns the stale record *with its freshness metadata*, or a `503` with a machine-readable reason — never a blocking fetch.

## 3. Packages

```
packages/contracts      Zod schemas + TS types shared by api, web, worker
packages/database       Prisma client, migrations, PostGIS helpers
packages/weather-core   provider adapters, normalization, DataClass, horizon table
packages/climate-core   monthly aggregation, anomalies, climatology, outlook assembly
packages/agronomy       crop profiles, constraint evaluation, window generation
packages/ai             provider abstraction, prompt templates, output validation
packages/ui             design system (tokens, primitives, charts)
packages/config         env validation, typed config
packages/utils          time (Asia/Jakarta), rounding, ids, units
```

### Dependency direction (enforced by ESLint `no-restricted-imports`, not convention)

```
contracts  ← everything
utils      ← everything except contracts
config     ← apps only
database   ← api, worker
weather-core, climate-core, agronomy, ai   ← api, worker
ui         ← web only
```

Forbidden: `climate-core → agronomy`, `agronomy → ai`, `web → database`, `weather-core → database` (adapters are pure; persistence is the caller's job), `api → web`.

Rationale: `weather-core` must be testable against recorded payloads with no DB; `agronomy` must be a pure function of (profile, outlook, field) so Phase 6 results are reproducible from stored inputs.

## 4. Module boundaries inside the API

| Module | Owns | Reads |
|---|---|---|
| `auth` | users, sessions, roles, permissions | — |
| `farm` | farms, fields, geometry, soil, irrigation | — |
| `crop` | crops, cultivars, profiles, profile versions | — |
| `weather` | normalized weather records, freshness, sources | — |
| `climate` | monthly outlooks, anomalies, climatology, quality | weather |
| `agronomy` | suitability runs, planting windows, explanations | crop, farm, climate |
| `activity` | planting/harvest records, field notes, local measurements | farm, crop |
| `monitoring` | sync status, queue health, provider latency | weather (metadata only) |
| `ai` | briefings, prompt/response audit | climate, agronomy, farm |

Cross-module access is **through services, never through another module's repository**. `climate` asks `weather` for a normalized series; it does not query weather tables.

## 5. Request path

1. Session cookie → `auth` guard → user.
2. Ownership check at the boundary (`farm.field.userId === user.id`), not buried in a service.
3. Zod DTO validation, `400` with field errors.
4. Service → repository → Prisma.
5. Response envelope (`docs/architecture/api-conventions.md`).
6. Every response that carries weather data carries `dataClass`, `sourceId`, `initializedAt`, `freshness`.

## 6. Write path for derived data

Derived data is **never** computed during a GET.

```
GET /climate/outlook?fieldId=…
  → read stored outlook for (field, cellKey)
  → usable but stale      → 200 + dataAvailability="stale" + reason, enqueue re-ingest
  → absent, ingest running → 202 + retryAfter, no fabricated value
  → absent, ingest failed  → 503 PROVIDER_UNAVAILABLE, or 200 with lastKnown marked stale
                             if a previous artifact is still stored and usable
```

Staleness is a body field, never a status code (`provenance-contract.md` §7). The read path may enqueue work, but it may never wait for it.

This is the only way the app stays honest about freshness: the read path cannot accidentally fabricate a fresh value.

## 7. Failure isolation

| Failure | Behaviour |
|---|---|
| Provider 5xx/timeout | job retries with exponential backoff; last good record keeps serving, marked stale; monitoring records the attempt |
| Seasonal feed absent for a cell, month beyond the horizon | months degrade to climatology **labelled as climatology**, with `reason = beyond_horizon` on the forecast axis |
| Seasonal run `pending`/`failed` for a cell inside the horizon | month reports `pending`/`unavailable` with its reason; **no climatology substitution** (`provenance-contract.md` §6) |
| Redis down | API keeps serving reads; job enqueue returns `503` with `retryAfter`; worker backpressure |
| Postgres down | API `503`; no partial responses |
| AI provider down | briefing endpoint returns the deterministic briefing skeleton with `narration: unavailable`; nothing else degrades |
| BMKG permission not granted | adapter disabled at config level; no route, no UI slot |

## 8. Multi-tenancy and isolation

v1 is single-owner-per-account. Ownership is a column (`user_id`) on `farms`, enforced twice: an explicit filter in every repository call, and Postgres RLS as the second line. No organisation/team model in v1.

### RLS with Prisma connection pooling

RLS is only a defence if the setting cannot outlive the request. Prisma pools connections, so `SET app.user_id` on a pooled connection leaks that identity into the next request. The rule is therefore **transaction-scoped**:

```sql
-- policy shape
CREATE POLICY farm_owner ON farms
  USING (user_id = current_setting('app.user_id', true)::uuid);
-- no user_id set -> current_setting returns NULL -> policy matches nothing (fail closed)
```

```ts
// packages/database/src/tenant.ts — the only way tenants are scoped
export function withTenant<T>(user: AuthUser, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.user_id', ${user.id}, true)`; // true = local to txn
    return fn(tx);
  });
}
```

Binding rules:

1. `set_config(..., is_local => true)` only. `SET` (session-scoped) is forbidden anywhere in the codebase; a lint/grep check in CI rejects it.
2. Every request path enters the database through `withTenant(user, fn)`. A repository function never receives a raw `PrismaClient`.
3. A connection returned to the pool has no `app.user_id` (the transaction reset it), so a missing context fails closed — the policy matches zero rows rather than all of them. This is the property that makes the second line worth having.
4. Worker jobs have no user. They run as a dedicated role with `BYPASSRLS` granted only to that role, or through an explicitly-scoped service function — never by faking a user id.
5. Integration test requirement: two concurrent requests for different users inside one pooled client must not see each other's rows, and a query outside `withTenant` must return zero rows.
6. Ownership is *also* checked at the controller boundary. RLS is a backstop against a forgotten `WHERE`, not the primary authorization mechanism — the two are independent by design.

## 9. Observability

- Structured JSON logs with `requestId`, `userId`, `jobId`, `provider`, `cellKey`.
- Metrics: provider latency, ingest success rate, stale-record count by class, queue depth, job failure rate, recompute duration.
- Health: `/health` (process), `/health/ready` (DB + Redis), `/monitoring/*` (data-plane, per provider).

## 10. Deployment shape

Docker Compose for dev and single-node prod: `web`, `api`, `worker`, `postgres` (PostGIS), `redis`, `caddy` (TLS + reverse proxy). Horizontal scaling of `worker` by replica count; `api` stateless behind the proxy.

## 11. Deliberate omissions

- No event bus beyond BullMQ; no Kafka, no outbox in v1.
- No CQRS read models; the outlook is materialised as a table, which is the one read model that earns its keep.
- No GraphQL, no tRPC; REST + OpenAPI because the contract must be inspectable by an external consumer (and by the AI tooling later).
- No vector/search DB.
