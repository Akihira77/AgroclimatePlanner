# Phase 3.2 — S7 Argon2id Benchmark Plan and Resource Inventory

| Field | Value |
|---|---|
| Status | **PREPARED — NOT EXECUTED.** No parameter is selected, no measurement exists |
| Prepared | 2026-11-20, from `1744f48` |
| Scope | Resource envelope for `apps/api`, assessment of the previous benchmark sketch, and the harness that replaces it |
| Approved inputs | `ARGON2ID-LIB` = `@node-rs/argon2@2.2.2`; `LIMITER-MECHANISM` = in-process fixed window. Both final; this document reopens neither |
| Not in scope | registration, login, hashing integration, rate-limiter implementation, dependency installation, schema or grant changes |

The single question this document answers is: **can an Argon2id parameter set be
selected from evidence, or is the deployment envelope still unknown?** Today the
envelope is unknown, so the answer is "not yet", and the harness refuses to pretend
otherwise.

## 1. Deployment resource inventory

| Item | Finding | Evidence |
|---|---|---|
| Deployment environment | **No production configuration in the repository.** The only Compose file runs PostgreSQL for development. The API runs on the host via `node dist/main.js`; there is no `Dockerfile`, no Kubernetes manifest, no CI workflow, no infrastructure file | `docker-compose.yml:1` ("Development database only. Production runs on a managed instance."); `apps/api/package.json:11`; no `.github/`, no `Dockerfile` anywhere (`find`) |
| Container memory limit | **Not configured / Unknown.** No API container is defined, so no limit exists to measure against. The development API process is not containerised | `docker-compose.yml` defines only `db`; the benchmark cgroup's `memory.max` is `max` |
| CPU limit | **Not configured / Unknown** for production. The development host exposes 12 logical CPUs and no `cpu.max` for the process cgroup | `nproc` = 12; `/sys/fs/cgroup/<own>/cpu.max` empty |
| cgroup version | **v2 on the development host.** Production unknown | `/sys/fs/cgroup` is `cgroup2fs`; `/proc/self/cgroup` has a `0::/…` entry |
| Node.js runtime | `engines.node >= 24.14.0`; development host `v24.14.0`, `x86_64`, glibc 2.39 | `package.json:6-8`; `node --version`; `uname -m` |
| Existing memory consumers | The repository defines one process per deployable: `apps/api`, `apps/worker`, `apps/web` are separate. PostgreSQL is its own container. Anything a base image adds is **unknown** because no image exists | `docs/architecture/system-architecture.md:78-79,237` |

Recorded inconsistencies, not resolved here:

1. `system-architecture.md:78` says `apps/api` runs on **Node 22**, while `package.json`
   requires **≥ 24.14.0**. One of the two is wrong; the deployment image does not exist
   yet to settle it.
2. `system-architecture.md:237` describes a production Compose stack (`web`, `api`,
   `worker`, `postgres`, `redis`, `caddy`). That file is not in the repository. The
   documented deployment shape is a plan, not configuration.
3. The development host's cgroup figures (`memory.current` 2.10 GiB, `memory.peak`
   2.78 GiB at the time of inspection) belong to the agent's `tmux` scope, not to an API
   container. They are **not** deployment evidence and must not be copied into a
   parameter decision.

### 1.1 What is missing before IG-6's memory criterion can be evaluated

- A container image or deployment manifest for `apps/api`.
- An explicit memory limit for that container.
- An explicit CPU limit (Argon2 cost is CPU-bound, so latency on an unlimited host is not
  transferable).
- Confirmation of the runtime's cgroup version inside the deployment.
- The base image and any sidecar processes that share the container.

Until these exist, any latency number is a development-host number, and the RSS
criterion has nothing to be a percentage of.

## 2. Assessment of the previous benchmark sketch

The sketch in `phase-3.2-s7-dependency-options.md` (before this change) is superseded. It
would have run, but it could not select parameters:

| Weakness | Consequence |
|---|---|
| `peakRss = process.memoryUsage().rss` was a single snapshot taken once, after the run | That is **current** RSS, not peak. Peak requires the kernel high-water mark (`VmHWM`) or `process.resourceUsage().maxRSS` |
| 20 samples, `p95 = sorted[ceil(20·0.95) − 1]` | With 20 samples p95 is the **19th value** — effectively the maximum. It is not a tail estimate |
| No warm-up | The first iterations include allocator and N-API binding warm-up, inflating the head of the distribution |
| No error capture | A rejected `hash`/`verify` aborted the run with no count of failed operations |
| Hash and verify measured inside one `once()` | The concurrent phase interleaved both, so its "hash p95" and "verify p95" were measured under different contention than the sequential phase |
| No memory guard | Four 19 MiB Argon2 pools would run on any host, including one with an unknown or tiny limit |
| Parameters hard-coded | No way to measure an alternative set without editing the file |
| No environment capture | Node version, CPU count, cgroup limit and cgroup metrics were absent, so the numbers were not attributable |
| No cgroup metrics | `memory.max`, `memory.current`, `memory.peak` were never read |
| No cross-parameter verification | IG-6's "a hash produced with different parameters still verifies" was prose only |

## 3. Harness

`apps/api/scripts/benchmark-argon2.mjs`. Node built-ins only; the approved library is
imported dynamically and the script exits `2` with the prerequisite when it is absent. It
is not referenced by `package.json`, `start`, or any test, so it cannot run during normal
startup or test execution.

| IG-6 / task requirement | Where it is reported |
|---|---|
| Hash latency | `latencyMs.{sequential,concurrent}.hash.{p50,p95,max,min,mean}` |
| Verify latency | same path, `.verify` |
| Median | `p50` |
| p95 | `p95`, nearest-rank, `n ≥ 100` enforced |
| Maximum observed | `max` |
| RSS before and after | `memory.baselineRssBytes`, `memory.afterRssBytes` |
| Peak process RSS | `memory.peakRssBytes` (`VmHWM`) and `memory.resourceMaxRssBytes` (`process.resourceUsage().maxRSS`) |
| Peak cgroup memory | `memory.cgroupPeakBytes`, with the scope caveat in `memory.note` |
| Failed operations | `failures.count`, `failures.byStage`, first 10 samples; exit `4` if any |
| Cross-parameter verification | `crossParameterVerification` (a digest hashed at `memoryCost: 4096`, verified with the current configuration) |
| Environment | `environment.{node,platform,arch,cpuCount,cgroup}` |

Method:

1. Warm-up: 10 iterations, discarded.
2. Sequential phase: 100 measured samples, each a hash then a verify, timed separately
   with `performance.now()` around the awaited call.
3. Concurrent phase: 100 measured samples in batches of 4, each worker timing its own hash
   and its own verify. A worker holds at most one Argon2 pool at a time, so the
   concurrency's pool count is bounded by 4.
4. A fresh random 16-byte salt per hash; passwords are synthetic
   (`s7-bench-<n>-<random>`), never real credentials, never written to disk.
5. Argon2id only, parameters from the CLI, defaults matching the provisional row:
   `m=19456`, `t=2`, `p=1`, 32-byte output.

### 3.1 Memory guard

`estimatedPeak = baselineRss + memoryCost × parallelism × concurrency × 1.25`

- Known limit: the run is **refused** when `estimatedPeak > 25%` of the limit, because
  IG-6 states the criterion as "peak RSS ≤ 25% of the container memory limit".
- Unknown limit (`memory.max` is `max` or absent): the run is **refused** unless
  `--allow-unbounded-memory` is passed, and is then labelled `latency-only` — its RSS
  numbers cannot satisfy the criterion.

Worked arithmetic, not a measurement: with a baseline RSS of 80 MiB, one 19 MiB pool per
operation exactly as configured, and concurrency 4, the estimate is
`80 + 19 × 1 × 4 × 1.25 = 175 MiB`. Satisfying the 25% rule therefore needs a container
limit of at least **700 MiB**, or a smaller `memoryCost`/concurrency. A 512 MiB container
would fail the criterion with these provisional parameters.

## 4. How to execute

Prerequisite, owner action, **not performed here** — the dependency is approved but not
added to any manifest, and adding it is out of scope for this task:

```
pnpm --filter @agroclimate/api add @node-rs/argon2@2.2.2
```

Then, inside the deployment container (or on a host whose cgroup limit is explicit):

```
node apps/api/scripts/benchmark-argon2.mjs --json > argon2-benchmark.json
node apps/api/scripts/benchmark-argon2.mjs --samples 100 --concurrency 1
node apps/api/scripts/benchmark-argon2.mjs --memory 19456 --time 2 --parallelism 1
node apps/api/scripts/benchmark-argon2.mjs --allow-unbounded-memory   # latency only
node apps/api/scripts/benchmark-argon2.mjs --self-test                 # no hashing
```

`--self-test` checks the percentile and guard maths without importing the library. It is
the only part of the harness that has been executed so far.

## 5. Interpretation

- The harness measures **this process**. An API image with different baseline RSS, a
  different Node build, or another process in the same cgroup will produce different
  numbers; the run must be repeated in the real image.
- Argon2's `memoryCost` is one pool per operation. Total pressure is
  `baseline + pools × concurrency`; the configured cost alone is not the application's
  memory.
- `p95` with `n = 100` is the 95th value. It is a coarse tail estimate and the harness
  refuses fewer than 100 samples; it does not refuse more.
- Acceptance is a conjunction, not a latency race: verify p95 ≤ 250 ms at concurrency 4,
  **and** peak RSS ≤ 25% of the container limit, **and** a different-parameter digest
  still verifies. One satisfied criterion is not a decision.
- A good number on the development host does not approve a parameter set. The
  provisional row in `phase-3.2-s7-owner-decisions.md` stays provisional until a run
  inside the deployment envelope is recorded.

## 6. Limitations and blockers

1. **No container image and no memory limit** — the primary blocker; the guard refuses a
   default run on any host whose `memory.max` is `max`.
2. **Library not installed** — the harness exits `2` until the dependency is added.
3. **cgroup peak is scope-wide** — `memory.peak` is monotonic for the whole scope, so a
   benchmark in a shared scope inherits earlier peaks. The process-level `VmHWM` is the
   figure IG-6 should be judged on.
4. **CPU limit unknown** — Argon2 latency tracks available CPU; an unlimited development
   host is not a lower bound for a throttled container.
5. **Node 22 vs 24 contradiction** in `system-architecture.md` is unresolved and may
   change the runtime under test.

## 7. Verification performed

| Command | Result |
|---|---|
| `node --check apps/api/scripts/benchmark-argon2.mjs` | exit `0` |
| `node apps/api/scripts/benchmark-argon2.mjs --self-test` | `self-test ok: 10 checks`, exit `0` |
| `node apps/api/scripts/benchmark-argon2.mjs` | exit `2` — library absent, prerequisite printed |
| `node apps/api/scripts/benchmark-argon2.mjs --samples 50` | exit `1` — fewer than 100 samples refused |
| `node apps/api/scripts/benchmark-argon2.mjs --concurrency 3` | exit `1` — concurrency must be 1 or 4 |
| `pnpm exec prettier --check apps/api/scripts/benchmark-argon2.mjs` | `All matched files use Prettier code style!` |

No hashing benchmark was executed. No latency or memory number in this document is a
measurement.
