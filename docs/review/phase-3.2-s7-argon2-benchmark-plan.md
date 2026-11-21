# Phase 3.2 — S7 Argon2id Benchmark Plan and Resource Inventory

| Field | Value |
|---|---|
| Status | **LOCAL RUN EXECUTED 2026-11-21 (latency-only).** Production envelope still unknown; results in `phase-3.2-s7-local-argon2-benchmark-results.md` |
| Prepared | 2026-11-20, from `1744f48` |
| Revised | 2026-11-21: measurement stages isolated, memory guard hardened, cgroup ancestor limits resolved |
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
| Container memory limit | **Not configured / Unknown.** No API container is defined, so no limit exists to measure against. The development API process is not containerised | `docker-compose.yml` defines only `db`; every ancestor of the development cgroup reports `memory.max = max` |
| CPU limit | **Not configured / Unknown** for production. The development host exposes 12 logical CPUs, and every ancestor reports `cpu.max = max 100000` (no quota) | `nproc` = 12; `/sys/fs/cgroup/<own>/cpu.max` absent, ancestors `max 100000` |
| cgroup version | **v2 on the development host.** Production unknown | `/sys/fs/cgroup` is `cgroup2fs`; `/proc/self/cgroup` has a `0::/…` entry |
| Node.js runtime | `engines.node >= 24.14.0`; development host `v24.14.0`, `x86_64`, glibc 2.39 | `package.json:6-8`; `node --version`; `uname -m` |
| Existing memory consumers | The repository defines one process per deployable: `apps/api`, `apps/worker`, `apps/web` are separate. PostgreSQL is its own container. Anything a base image adds is **unknown** because no image exists | `docs/architecture/system-architecture.md:78-79,237` |

Recorded inconsistencies:

1. ~~`system-architecture.md:78` says `apps/api` runs on **Node 22**, while `package.json`
   requires **≥ 24.14.0**.~~ Resolved 2026-11-21: the workspace `engines.node` is
   `>=24.14.0` (`package.json:6-8`), which Node 22 cannot satisfy, so the `Node 22`
   statements in the architecture table were stale and were replaced by the engine
   constraint. No production runtime is asserted: no image exists to confirm it. See §6.5.
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
| Failed operations | `failures.count`, `failures.byStage` (per stage), first 10 samples; exit `4` if any |
| Cross-parameter verification | `crossParameterVerification` (a digest hashed at `memoryCost: 4096`, verified with the current configuration) |
| Environment | `environment.{node,platform,arch,hostLogicalCpus,cgroup}` |
| Effective memory limit | `environment.cgroup.effectiveMemoryLimitBytes`, `…Raw`, `memoryLimitSourcePath` |
| Effective CPU allocation | `environment.cgroup.effectiveCpuCpus`, `cpuQuotaRaw`, `cpuSourcePath` |
| Process cgroup path | `environment.cgroup.{processPath,resolvedPath,mountPoint}` |
| Guard verdict | `guard.verdict`, `guard.reason`, `guard.estimatedPeakBytes` |
| Suitability | `verdict.{memoryGuard,suitableForLatencyAnalysis,suitableForResourceEvaluation,complete}` |

Method — four stages, executed strictly one after another:

1. Warm-up: 10 iterations of hash then verify, discarded. Failures are recorded but the
   latencies are not.
2. Sequential hash: 100 measured hash calls at concurrency 1. Digests are retained.
3. Sequential verify: 100 measured verify calls at concurrency 1, over the digests from
   stage 2. Every digest must verify against the password that produced it.
4. Concurrent hash: 100 measured hash calls at the configured concurrency, for the first
   time interleaved with each other and with nothing else.
5. Concurrent verify: 100 measured verify calls at the configured concurrency, over the
   digests from stage 4, which has already settled. A verify never overlaps a hash, so each
   stage's statistics describe a single operation kind under a single contention pattern.

A fresh random 16-byte salt per hash; passwords are synthetic (`s7-bench-<n>-<random>`),
never real credentials, never written to disk. Argon2id only, parameters from the CLI,
defaults matching the provisional row: `m=19456`, `t=2`, `p=1`, 32-byte output.

### 3.1 Memory guard

`estimatedPeak = baselineRss + memoryCost × parallelism × concurrency × 1.25`

- Known limit: the run is **refused** when `estimatedPeak > 25%` of the limit, because
  IG-6 states the criterion as "peak RSS ≤ 25% of the container memory limit".
- Unknown limit (`memory.max` is `max` or absent anywhere in the hierarchy):
  - `--concurrency 4` is **always refused**, including with `--allow-unbounded-memory`.
    An unknown limit cannot bound four Argon2 pools per operation; a flag cannot create a
    budget that the kernel has not declared.
  - `--concurrency 1` is refused by default, and permitted with
    `--allow-unbounded-memory` only as `verdict = latency-only`. Such a run is
    `suitableForResourceEvaluation: false` and cannot satisfy IG-6's RSS criterion.
- Invalid resource data (non-finite limit) is treated as an unknown limit, not as a
  permissive one.

Worked arithmetic, not a measurement: with a baseline RSS of 80 MiB, one 19 MiB pool per
operation exactly as configured, and concurrency 4, the estimate is
`80 + 19 × 1 × 4 × 1.25 = 175 MiB`. Satisfying the 25% rule therefore needs a container
limit of at least **700 MiB**, or a smaller `memoryCost`/concurrency. A 512 MiB container
would fail the criterion with these provisional parameters.

### 3.2 Effective cgroup v2 limits

The harness resolves the process's own cgroup rather than assuming the root:

1. `0::<path>` in `/proc/self/cgroup` gives the process path and the cgroup version.
   Without a `0::` entry the environment is reported as **cgroup v1, unsupported**.
2. `/proc/self/mountinfo` supplies the `cgroup2` mount point and its mounted subtree root.
   The process path is rebased on that mount; a path outside the mounted subtree is
   reported unresolved instead of being guessed.
3. Every ancestor from the process cgroup up to the mount point is inspected, deepest
   first, and recorded in `environment.cgroup.levels`.
4. The effective memory limit is the **tightest finite** `memory.max` in that chain. `max`
   means "no budget at this level" and is skipped, never treated as infinite. When no level
   declares a finite limit, the limit is `unknown` — the correct answer, not an inference.
5. The effective CPU quota is the tightest finite `cpu.max`, reported as
   `effectiveCpuCpus`. Host logical CPU count is reported separately as
   `hostLogicalCpus` and is never substituted for the container allocation.
6. `memory.current` and `memory.peak` are read from the process cgroup. They remain
   scope-wide figures, not benchmark-only memory.

Detection is read-only: no cgroup file or system setting is written.

### 3.3 Self-tests

`--self-test` runs 39 checks without importing `@node-rs/argon2`:

| Group | Coverage |
|---|---|
| Percentiles | nearest-rank p50/p95/max, the 20-sample "p95 is the maximum" case, empty summary |
| Stage isolation | one stage records only its own latencies; all hashes settle before any verify; verify consumes the produced digests; failures are attributed to the stage that raised them |
| Memory guard | unknown limit refuses concurrency 4; the override cannot change that; concurrency 1 is refused by default and latency-only with the override; 1 GiB and the exact 700 MiB boundary pass; 512 MiB is refused; non-finite limits fail safe |
| cgroup hierarchy | finite child, tighter finite parent, unlimited child under a finite parent, multiple unlimited ancestors, missing files, unresolved mount, cgroup v1, tightest CPU quota, mount-root rebasing |

Stage and hierarchy tests use injected operations and fixture files, so they do not depend
on the host's cgroup configuration or on the library being installed.

## 4. How to execute

Prerequisite, **now done** — the dependency is installed at `2.2.2` in
`apps/api/package.json` (2026-11-21). The command that was run:

```
pnpm --filter @agroclimate/api add @node-rs/argon2@2.2.2 --save-exact
```

Inside the deployment container (or on a host whose cgroup limit is explicit):

```
node apps/api/scripts/benchmark-argon2.mjs --json > argon2-benchmark.json
node apps/api/scripts/benchmark-argon2.mjs --samples 100 --concurrency 4
node apps/api/scripts/benchmark-argon2.mjs --memory 19456 --time 2 --parallelism 1
node apps/api/scripts/benchmark-argon2.mjs --concurrency 1 --allow-unbounded-memory  # latency only
node apps/api/scripts/benchmark-argon2.mjs --self-test                              # no hashing
```

`--allow-unbounded-memory` is accepted only with `--concurrency 1`; the harness refuses
concurrency 4 whenever the effective memory limit is unknown.

On 2026-11-21 the harness was executed on the development host, where the limit is
unknown, so every run used `--concurrency 1 --allow-unbounded-memory` and is marked
`suitableForResourceEvaluation: false`. Six parameter sets were measured; the results,
including a recommended local configuration, are in
[`phase-3.2-s7-local-argon2-benchmark-results.md`](./phase-3.2-s7-local-argon2-benchmark-results.md).
Concurrency 4 has still never been measured, and no production run exists.

## 5. Interpretation

- The harness measures **this process**. An API image with different baseline RSS, a
  different Node build, or another process in the same cgroup will produce different
  numbers; the run must be repeated in the real image.
- Argon2's `memoryCost` is one pool per operation. Total pressure is
  `baseline + pools × concurrency`; the configured cost alone is not the application's
  memory.
- `p95` with `n = 100` is the 95th value. It is a coarse tail estimate and the harness
  refuses fewer than 100 samples; it does not refuse more.
- Concurrent hash and concurrent verify are separate stages, so `concurrent.hash.p95`
  describes hash contention only and `concurrent.verify.p95` describes verify contention
  only. A combined figure would not be attributable to either.
- The effective limit is the tightest finite `memory.max` on the process's cgroup chain.
  A host-wide `max` at the root does not cancel a tighter limit further down, and it is not
  evidence of an unlimited container.
- Acceptance is a conjunction, not a latency race: verify p95 ≤ 250 ms at concurrency 4,
  **and** peak RSS ≤ 25% of the container limit, **and** a different-parameter digest
  still verifies. One satisfied criterion is not a decision.
- A good number on the development host does not approve a parameter set. The
  provisional row in `phase-3.2-s7-owner-decisions.md` stays provisional until a run
  inside the deployment envelope is recorded.

## 6. Limitations and blockers

1. **No container image and no memory limit** — the primary blocker; with the limit unknown
   the guard refuses concurrency 4 outright and permits nothing above a latency-only,
   concurrency-1 run.
2. **Library not installed** — the harness exits `2` until the dependency is added.
3. **cgroup peak is scope-wide** — `memory.peak` is monotonic for the whole scope, so a
   benchmark in a shared scope inherits earlier peaks. The process-level `VmHWM` is the
   figure IG-6 should be judged on.
4. **CPU limit unknown** — Argon2 latency tracks available CPU; an unlimited development
   host is not a lower bound for a throttled container.
5. **Node 22 vs 24 contradiction** in `system-architecture.md` was resolved on
   2026-11-21 in favour of the workspace engine constraint; see §6.5. The production
   runtime itself is still unestablished.

### 6.5 Runtime statement correction

`package.json:6-8` (workspace root) declares `engines.node = ">=24.14.0"`, and the
development host runs `v24.14.0`. Node 22 cannot satisfy that constraint, so the
`Node 22` cells in `system-architecture.md:78-79` were stale. They now read
`Node.js (engines >=24.14.0)`. This corrects the claim to the only version evidence in the
repository; it does **not** assert that production already runs Node.js 24, because no
image or manifest exists to show it.

## 7. Verification performed

| Command | Result |
|---|---|
| `node --check apps/api/scripts/benchmark-argon2.mjs` | exit `0` |
| `node apps/api/scripts/benchmark-argon2.mjs --self-test` | `self-test ok: 39 checks`, exit `0` |
| `node apps/api/scripts/benchmark-argon2.mjs` | exit `2` — library absent, prerequisite printed |
| `node apps/api/scripts/benchmark-argon2.mjs --samples 50` | exit `1` — fewer than 100 samples refused |
| `node apps/api/scripts/benchmark-argon2.mjs --concurrency 3` | exit `1` — concurrency must be 1 or 4 |
| `node apps/api/scripts/benchmark-argon2.mjs --bogus` | exit `1` — unknown argument |
| `pnpm exec prettier --check apps/api/scripts/benchmark-argon2.mjs` | `All matched files use Prettier code style!`, exit `0` |
| `git diff --check` | exit `0` |

No latency or memory number in this document is a measurement. The executed local run is
recorded in
[`phase-3.2-s7-local-argon2-benchmark-results.md`](./phase-3.2-s7-local-argon2-benchmark-results.md).
