# ADR-002 — Monorepo and Backend Architecture

- Status: **Proposed**
- Date: 2026-11-18
- Depends on: ADR-001 (data strategy)
- Supersedes: none

## Context

The system must hold a forecast pipeline that runs on provider schedules, a deterministic agronomic engine that must be replayable, a document-oriented UI, and an AI narration layer. Phase 0 established that the hard parts are (a) provenance and data-class discipline, (b) expensive ingestion with tight provider budgets, (c) recomputation fan-out when a seasonal run lands, and (d) reproducibility of recommendations after a crop profile changes.

None of those justify distribution. All of them justify strict boundaries inside one deployable.

## Decision

**D1. pnpm workspaces + Turborepo; three apps, nine packages.**

`apps/web`, `apps/api`, `apps/worker`; packages per `docs/architecture/system-architecture.md` §3. Dependency direction is enforced by lint rules, not convention. Rationale: the agronomy and climate packages must be importable by both the API (synchronously, for ad-hoc evaluation) and the worker (in bulk), and testable with no DB.

**D2. NestJS on Express for the API; a separate BullMQ worker process.**

Nest gives module boundaries, DI, guards, and a pipe/interceptor model that maps cleanly onto "validate at boundary, authorize at boundary, provenance on every response". The worker is a **separate process, not an in-process queue consumer**, because provider ingest must survive API deploys and must be scaled independently — and because a slow provider must never be able to starve request handling.

**D3. Prisma as ORM, raw SQL for PostGIS and analytics.**

Prisma for CRUD and migrations; `$queryRaw` for geometry, aggregations, and the monthly rollups. PostGIS geometry columns are `Unsupported("geometry")` in Prisma and accessed through typed raw helpers. Rationale: Prisma's spatial support is insufficient for polygon area and centroid correctness, but its migration and type generation are otherwise the best fit.

**D4. REST + OpenAPI, generated from Zod.**

Not GraphQL: the consumer set is small, the payloads are shaped by provenance rather than by client preference, and a machine-readable contract matters more than query flexibility. Zod schemas in `packages/contracts` are the single source of truth for both runtime validation and the OpenAPI document.

**D5. Server-side sessions in Postgres, not JWT.**

The product is a single-tenant-per-account application with a long-lived session, revocation requirements, and no third-party API consumers in v1. Opaque session IDs give instant revocation and no token-refresh complexity.

**D6. Derived data is materialised.**

`MonthlyOutlook`, `SuitabilityRun`, `PlantingWindow`, and briefings are stored rows keyed by `runId`/`engineVersion`/`profileVersionId`. Not computed on read, not cached in Redis as the source of truth. Rationale: freshness, auditability, and the ability to answer "why did this recommendation change" all require a durable record, and Redis eviction must never be able to change what a farmer was told.

**D7. One database, one Redis, one object store (optional).**

Raw provider payloads are stored in the object store only where the provider's terms permit. No data warehouse in v1; Phase 9 verification reads from Postgres plus archived payloads.

## Consequences

Positive:
- Single deploy unit for user-facing work; the worker can be scaled or paused independently.
- The agronomy engine is a pure library: reproducible, unit-testable, replayable against historical outlooks — which is the prerequisite for Phase 9 backtesting.
- Provenance can be made a required response field at the contract level, because one team owns the contract.
- No distributed-transaction problem: recompute fan-out is a queue with per-batch transactions.

Negative / accepted:
- One runtime (Node) for everything, so heavy numerical work must be simple and streaming rather than vectorised. Accepted because the computations are aggregations, not simulations.
- Prisma + PostGIS friction at the geometry boundary; contained in one helper module.
- A monolith means a bad migration can take down reads and ingestion at once; mitigated by migration discipline and backup/restore drills in Phase 9.
- BullMQ gives at-least-once delivery, so every job must be idempotent by `jobId` — a standing constraint, not an optimisation.

## Alternatives rejected

1. **Next.js fullstack (API routes + server components).** Rejected: the worker requirement is intrinsic (provider schedules, budget guards, long ingest), and mixing request handling with background processing is exactly the coupling this project cannot afford. The UI is also a dense SPA-style dashboard, not a content site.
2. **Microservices per domain.** Rejected: no measured scaling bottleneck, and the schema/provenance invariants are far easier to enforce in one process with one migration path.
3. **Python backend (FastAPI) for the agronomy engine.** Rejected for v1: it would duplicate the type system, split the contract, and add a service boundary before there is a numerical reason for one. The agronomy engine is constraint evaluation over a few hundred numbers, not model fitting.
4. **Drizzle instead of Prisma.** Viable; rejected on migration ergonomics and because the team's existing pattern is Prisma. Revisit only if Prisma's geometry handling blocks Phase 3.
5. **tRPC instead of REST.** Rejected: the contract must be legible to non-TypeScript consumers and to the AI tooling layer.
6. **JWT + refresh rotation.** Rejected: revocation and audit matter more than statelessness at this scale.

## Missing decisions this ADR deliberately leaves open (Phase 2 or later)

- Exact Node/Nest versions and the tsconfig baseline (Phase 2).
- Whether the object store is S3-compatible local (MinIO) or a filesystem in v1.
- Whether `packages/ui` ships pre-built or source-consumed by Vite.
- Test topology: which module gets integration tests against a real Postgres (Phase 9 sets the bar; Phase 2 sets the harness).

## Review requirement

`oracle` must attack: the worker/API split cost, the "materialise derived data" decision under recompute fan-out, and whether the agronomy engine can truly stay pure given field geometry and provider lookups. Any decision that makes `PlantingWindow` non-replayable must be rejected.
