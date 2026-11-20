# Phase 3.2 — S7 Dependency Options: Argon2id and the Rate Limiter

| Field | Value |
|---|---|
| Status | **PROPOSED — no dependency approved, none installed.** Two approvals are outstanding in `docs/review/phase-3.2-s7-owner-decisions.md` |
| Prepared | 2026-11-20, from `0a2e6a2` |
| Scope | `IG-6` library selection, `IG-7` limiter mechanism. Parameters and limits were already decided; this document chooses only the implementations |
| Constraints inherited | no dependency without approval; no S8 work; no database change |

Both sections below separate **registry facts** (checked against npm on 2026-11-20) from
**judgement**. Nothing here is installed.

## 1. Environment facts that constrain the choice

| Fact | Value | How it was checked |
|---|---|---|
| Node | `v24.14.0` | `node --version` |
| Host | `x86_64`, glibc `2.39` | `uname -m`, `ldd --version` |
| Native toolchain on the dev host | `g++ 13.3.0`, `python3` present | `command -v` |
| Container image for the API | **none** — no `Dockerfile` anywhere in the repo | `ls Dockerfile apps/*/Dockerfile` |
| Deployment runtime | "Production runs on a managed instance" (`docker-compose.yml:1`) — libc, memory limit, and CPU count are **unspecified** | same |
| NestJS | `12.5.1` | `apps/api/package.json:17-19` |

The last two rows matter: a native module's prebuilt-binary story depends on libc
(glibc vs musl) and the benchmark's acceptance criterion is expressed against a
container memory limit that does not exist yet. Both are recorded as blockers, not
guessed around.

## 2. Argon2id library

| Candidate | Version | Install shape | Runs on | Verdict |
|---|---|---|---|---|
| `@node-rs/argon2` | `2.2.2` | prebuilt N-API binary per platform via optional dependencies (`linux-x64-gnu`, `linux-x64-musl`, `darwin-arm64`, …). **No install script. No runtime dependencies.** | Node ≥ 10; N-API, so Node 24 needs no rebuild | **Recommended** |
| `argon2` (node-argon2) | `0.45.2` | `prebuildify` + `node-gyp-build`: loads a bundled prebuilt when the platform matches, otherwise **compiles at install** (needs `g++`, `make`, `python3`) | Node ≥ 16.17; dependencies: `node-addon-api`, `node-gyp-build`, `@phc/format`, `cross-env` | Acceptable fallback |
| `node:crypto` `scrypt` | stdlib | none | — | Rejected: `IG-6` decided Argon2id |
| `argon2-browser` / WASM | — | none | — | Rejected: slower, and the deployment is Node, not a browser |

Judgement:

- `@node-rs/argon2` wins on the two things that decide this: **no install-time compile**
  (so the dev host's `g++` is irrelevant and a musl base image stays possible) and
  **zero transitive dependencies** (the supply chain is one package plus one
  platform-specific optional package).
- `argon2` is the more widely used package and its `@phc/format`/`@node-argon2` lineage is
  familiar, but its prebuilt coverage is glibc-centric: on Alpine it compiles, which means
  a build toolchain in the runtime image. That is a deployment decision nobody has made.
- Both are N-API, so `node --version` upgrades do not force a rebuild. Neither is
  "faster" in a way that matters at 30 requests/minute; the benchmark measures the
  parameters, not the library race.
- `@node-rs/argon2` resolves its platform package at install time, so a **lockfile
  generated on Linux** is not enough for a macOS developer unless pnpm records the other
  platform (`supportedArchitectures`). That is a real cost, stated once, not hidden.

API surface used by S7, identical in both libraries:
`hash(password, { memoryCost, timeCost, parallelism, salt?, outputLen? })` and
`verify(hash, password)`. `verify` reads the PHC string's own parameters, which is what
`IG-6` requires and what makes the provisional numbers safe to change later.

### Proposed approval wording — `ARGON2ID-LIB`

> Use `@node-rs/argon2` version 2.2.2 for password hashing. Argon2id only; no other
> password-hashing library is added. Parameters come from configuration and are
> provisional until the benchmark in this document is recorded. Verification reads
> parameters from the stored PHC hash.

Files that change on approval: `apps/api/package.json`, `pnpm-workspace.yaml` (catalog
entry), `pnpm-lock.yaml`, `apps/api/src/config/runtime-config.ts` (parameter fields),
and `docs/IMPLEMENTATION_STATUS.md`. No ADR amendment needed: `IG-6` is an owner-decision
record, not an ADR.

### Benchmark plan (run only after approval and on the deployment host)

Reproducible script, intended as `apps/api/scripts/benchmark-argon2.mjs` when approved:

```js
import { hash, verify } from "@node-rs/argon2";
import { performance } from "node:perf_hooks";
import { randomBytes } from "node:crypto";

const PARAMS = { memoryCost: 19456, timeCost: 2, parallelism: 1 };
const SAMPLES = 20;
const CONCURRENCY = 4;

const once = async (i) => {
  const password = `bench-${i}-${randomBytes(4).toString("hex")}`;
  let t = performance.now();
  const digest = await hash(password, PARAMS);
  const hashMs = performance.now() - t;
  t = performance.now();
  await verify(digest, password);
  return { hashMs, verifyMs: performance.now() - t };
};

const pct = (xs, q) =>
  xs.slice().sort((a, b) => a - b)[Math.max(0, Math.ceil(xs.length * q) - 1)];

const serial = [];
for (let i = 0; i < SAMPLES; i += 1) serial.push(await once(i));

const batches = [];
for (let b = 0; b < SAMPLES / CONCURRENCY; b += 1) {
  batches.push(await Promise.all(Array.from({ length: CONCURRENCY }, (_, j) => once(b * CONCURRENCY + j))));
}
const concurrent = batches.flat();
const peakRss = process.memoryUsage().rss;

console.log(JSON.stringify({
  params: PARAMS,
  serial: {
    hashP50: pct(serial.map((s) => s.hashMs), 0.5),
    verifyP50: pct(serial.map((s) => s.verifyMs), 0.5),
  },
  concurrency: CONCURRENCY,
  verifyP95: pct(concurrent.map((s) => s.verifyMs), 0.95),
  hashP95: pct(concurrent.map((s) => s.hashMs), 0.95),
  peakRssMiB: Math.round(peakRss / 1024 / 1024),
}, null, 2));
```

Acceptance, per `IG-6`: verify p95 ≤ 250 ms at concurrency 4; peak RSS ≤ 25% of the
container memory limit; a hash produced with different parameters still verifies
(assert `verify` against a digest made with `memoryCost: 4096`). The RSS criterion cannot
be evaluated until the container memory limit exists — that is a blocker, not a
formality.

The block above is formatted for reading. When it moves into `apps/api/scripts/`, run
`pnpm exec prettier --write` on it; `node --check` already passes on the version above.

## 3. Rate limiter

`IG-7` decided the behaviour: in-process, per-client-IP, 30 req/min, before any database
lookup and any hashing, `429 RATE_LIMITED` with `Retry-After`. What is open is the
mechanism.

| Candidate | Needs approval | Matches `api-conventions.md` §9 headers | Notes |
|---|---|---|---|
| `@nestjs/throttler` `6.8.0` | dependency | **No** | Peer supports `@nestjs/common`/`core` `^12.0.0`, zero runtime dependencies. But the guard hardcodes `this.headerPrefix = 'X-RateLimit'`, so it emits `X-RateLimit-Limit`/`-Remaining`/`-Reset`, while §9 specifies `RateLimit-Limit`/`-Remaining`/`-Reset`. `Retry-After` matches |
| Hand-rolled `ClientIpRateLimiter` guard | none | **Yes** | ~50 lines: fixed-window counter in a `Map`, injectable clock, periodic sweep of expired keys, `req.ip` from the already-configured trust proxy |
| Redis-backed store | dependency + service | Yes | Out of scope for S7 by `IG-7` |

Judgement:

- The header mismatch is the deciding fact. With `@nestjs/throttler` the repository must
  either amend §9 to `X-RateLimit-*` (an owner documentation change) or add an
  interceptor that rewrites the headers — a workaround that has to be tested forever.
- The hand-rolled guard is a counter, not cryptography: one `Map`, one clock read, one
  comparison, one sweep. It keeps the approved header contract exactly, adds no supply
  chain, and can be unit-tested with a fake clock (which the library cannot easily offer
  either).
- It is also replaceable: the moment a second rate-limited surface or a shared store is
  approved, the guard's storage moves behind the same interface and `@nestjs/throttler`
  or Redis becomes the implementation. The guard is ~50 lines because the decision is
  small.
- Counter-argument, stated: a maintained dependency gets bug fixes for free, and a
  self-written limiter is a place where a clock-skew or eviction bug can hide. The sweep
  and the fixed window are the two things the tests must cover.

### Proposed approval wording — `LIMITER-MECHANISM`

> S7 rate-limits `POST /v1/auth/login` and `POST /v1/auth/register` with an in-process,
> per-client-IP fixed-window counter implemented in `apps/api`, using `req.ip` under the
> existing trust-proxy configuration. No runtime dependency is added for S7. Headers
> follow `api-conventions.md` §9 exactly: `RateLimit-Limit`, `RateLimit-Remaining`,
> `RateLimit-Reset`, plus `Retry-After` on `429 RATE_LIMITED`. Replacing it with a shared
> store requires a new approval and must fail closed.

If the owner prefers a maintained dependency instead, the alternative wording is:

> Use `@nestjs/throttler` 6.8.0 with its in-memory store, and amend
> `api-conventions.md` §9 to the `X-RateLimit-*` header names the guard emits.

Files that change on approval: `apps/api/src/http/*` (guard + its tests),
`apps/api/src/app.factory.ts` (registration), `apps/api/src/config/runtime-config.ts`
(window and limit), `docs/IMPLEMENTATION_STATUS.md`. No ADR amendment; `IG-7` is a
decision record.

## 4. What this document does not do

- It does not install anything, and it does not add a `package.json` entry.
- It does not make the Argon2id parameters final: they stay provisional until the
  benchmark output is recorded.
- It does not change `api-conventions.md` §9. The hand-rolled option is recommended
  precisely because it does not need to.
- It does not touch S8, Redis, or a scheduler.
