# Phase 3.2 — S7 Owner Decision Record: Registration and Credential Verification

| Field | Value |
|---|---|
| Status | **OWNER DECISIONS RECORDED — 2026-11-20; FINALIZED 2026-11-21.** The seven `IG` gates that blocked S7 are answered. **Amendment 1 (2026-11-21)** records the owner's final disposition: `IG-1`, `IG-2`, `IG-3`, `IG-4`, `IG-7`, `IG-10` **approved**; `IG-6` **conditionally approved** — Argon2id is decided, its parameters are not, until a concurrency-4 benchmark on the deployment envelope is recorded. `ARGON2ID-LIB` (`@node-rs/argon2@2.2.2`) and `LIMITER-MECHANISM` (in-process fixed window, no dependency) were approved 2026-11-20; the library is now installed, the limiter is not implemented. Benchmark: a local latency-only run exists, and it does **not** satisfy `IG-6` |
| Approver | Akihira77 (repository owner) |
| Scope | S7 — `POST /v1/auth/register`, email normalisation, password policy, Argon2id hashing, user persistence, duplicate handling, credential verification, rate limiting on registration. **Not** the login endpoint, session issuance, session token, cookie, CSRF, guard, `/me`, or logout — those are S8 |
| Prepared from | `0a2e6a2` — the S7 readiness assessment returned `S7 READINESS REVIEW COMPLETE WITH BLOCKERS` |
| Supersedes | nothing; the answers below replace the *recommended* column of the assessment, which was never an approval |
| `OPEN-nn` dispositions changed | **None.** `OPEN-01` stays unresolved: the boundary is built and S7's credential verification will read through it, but no login endpoint or session issuance path exists yet. `OPEN-13` was already resolved on 2026-11-20 |
| Implementation authorised | **No.** See *Implementation gate* — the record is necessary, not sufficient |

This document records the owner's answers and nothing else. A recommendation that
appears in `docs/implementation/phase-3.2.3-authentication-database-boundary.md` or in
`docs/review/phase-3.2-design-review.md` is still a recommendation where it disagrees
with this file.

## Recorded decisions

| ID | Decision | Selected | Date |
|---|---|---|---|
| `IG-1` | Email normalisation | **A** — one shared function in `packages/contracts` | 2026-11-20 |
| `IG-2` | Duplicate registration | **A** — `409 CONFLICT`, disclosure accepted | 2026-11-20 |
| `IG-3` | Registration session behaviour | **A** — no session; login is the only issuance path | 2026-11-20 |
| `IG-4` | Password policy | **A** — 12–1024 characters, printable ASCII only, no composition rules | 2026-11-20 |
| `IG-6` | Password hashing | **A, conditional** — Argon2id, provisional parameters, benchmark required | 2026-11-20 |
| `IG-7` | Brute-force protection | **A, conditional** — in-process per-IP limiter, 30 req/min | 2026-11-20 |
| `IG-10` | Email verification | **A** — deferred, excluded from S7 | 2026-11-20 |

**Statuses as of 2026-11-21** (*Amendment 1*): `IG-1`, `IG-2`, `IG-3`, `IG-7`, `IG-10`
are **approved**; `IG-4` is **approved with a revised password rule** (the ASCII-only
charset in the 2026-11-20 row is superseded — see *Amendment 1*, §A1.2); `IG-6` remains
**conditionally approved**. The table above records the 2026-11-20 round and is left as
written.

### Milestone mapping — S7 vs S8

The seven decisions below are answered once and applied across two milestones. Splitting
them does not change any decision; it fixes where each half is built.

| Built in S7 | Built in S8 |
|---|---|
| Registration endpoint and request contract | Login endpoint |
| Email normalisation (shared function) | Session token generation, SHA-256 hashing, storage |
| Password policy and Argon2id hashing | Session cookie and its attributes |
| User persistence through the existing `app_auth` grants | CSRF protection on non-GET requests |
| Duplicate handling (`409 CONFLICT`, no session) | Authentication guard |
| Credential verification: uniform failure, dummy hash for unknown addresses | `GET /v1/auth/me` |
| Per-IP rate limiting on registration | Logout and session invalidation, plus rate limiting on login |

Credential verification is the part that is easy to confuse with login. S7 answers
"do these email and password bytes match a stored hash?" and returns either the safe user
representation or a uniform failure. It issues **nothing**: no session row, no token, no
cookie. Until S8 ships, no account has a usable authenticated session, and no endpoint
behaves as if one existed.

---

## IG-1 — Email normalisation — **A**

Normalisation is an application invariant implemented through one shared function in
`packages/contracts`.

Rules:

- Trim surrounding whitespace.
- Lowercase with `toLowerCase()`.
- Registration and login call the same function — registration in S7, login in S8. Two
  copies is how one endpoint starts accepting variants the other rejects.
- `users_email_key` stays case-sensitive.
- No database index, no column type change, no `citext`.
- No NFC/NFKC normalisation: the bytes the user typed (after trim and lowercase) are the
  bytes stored.

Acceptance: `User@Example.COM` and `user@example.com` resolve to one account;
normalisation is idempotent; the second registration of the same address is rejected
(`IG-2`).

## IG-2 — Duplicate registration — **A**

A duplicate registration returns HTTP `409` with code `CONFLICT` and **no** `details`.
No additional account information is disclosed.

Password hashing happens before the duplicate check, so the hashing cost — and therefore
the response time — does not depend on whether the address exists.

Account enumeration through registration is an **explicitly accepted** product/security
trade-off. It is accepted because `R-1` already accepts enumeration through the login
lookup itself, and because `IG-10` deferred email verification: a `202`-style answer
would be indistinguishable from success only if some channel could later tell the user
something, and there is no such channel in S7.

## IG-3 — Registration session behaviour — **A**

Registration creates the user record and nothing else.

- No session row, no token, no `Set-Cookie`.
- Response is `201` with the safe user representation.
- Session issuance happens exclusively through the login endpoint, which is S8, so the
  repository keeps exactly one issuance path to audit.

## IG-4 — Password policy — **A**

**Partly superseded, 2026-11-21.** *Amendment 1* §A1.2 replaces the charset restriction
recorded below and the UTF-16 counting basis. Still in force, unchanged: minimum 12
characters; maximum 1024 UTF-8 bytes; no composition requirements; no trimming,
normalisation, or truncation; the password is hashed exactly as supplied; the leaked-password
check stays deferred. Superseded: "printable ASCII only", and `password.length >= 12` as
the minimum check — the requirement is now Unicode code points, never UTF-16 code units.
The 2026-11-20 text is kept below as the record of what it said.

- Minimum: **12 characters**.
- Maximum: **1024 characters**, enforced as `Buffer.byteLength(password, "utf8") <= 1024`.
  The approved charset is ASCII, so the character count and the UTF-8 byte count are the
  same number; the byte check is the form the boundary code uses.
- No composition requirements.
- No trimming, no Unicode normalisation; the password is hashed exactly as supplied.
- Leaked-password checking is **deferred** and recorded as a gap (see *Accepted gaps*).

**Character set, decided at the same time as the length rule — superseded 2026-11-21.**
Passwords are ordinary
printable text: letters, digits, and common symbols. Concretely, every character must be
printable ASCII (U+0020–U+007E). Emoji and other non-ASCII characters are rejected at the
boundary with `VALIDATION_FAILED`.

Consequence, stated because it is a real limitation and not an oversight: a password
containing an accented letter or a non-Latin script is refused rather than silently
mangled. Passwords are never transliterated. Space (U+0020) is permitted, so passphrases
work.

Because the charset is ASCII, `password.length` and the character count agree; the
minimum is checked with `password.length >= 12` and the maximum with `byteLength`. The
two agree by construction: no allowed character is longer than one byte.
A rejected password produces no partial state. *(The `password.length` basis is
superseded 2026-11-21 — see §A1.2. The byte-length maximum is unchanged.)*

## IG-6 — Password hashing — **A, conditional**

Argon2id. Provisional parameters, **not final until benchmark evidence is recorded**:

| Parameter | Value |
|---|---:|
| Algorithm | Argon2id (`$argon2id$v=19$…`) |
| Memory | 19456 KiB |
| Iterations | 2 |
| Parallelism | 1 |
| Salt | 16 bytes, cryptographically random per hash |
| Output | 32 bytes |
| Encoding | PHC string |

Rules:

- Parameters are configurable and appear once, in the runtime configuration.
- Verification reads the parameters encoded in the stored hash, not from configuration,
  so a parameter change does not invalidate existing hashes.
- Final parameters come from the recorded benchmark below, on the deployment host; the
  provisional row is a starting point, not a claim.
- Library selection was approved by the owner on 2026-11-20:
  `@node-rs/argon2@2.2.2`. The dependency is **installed** at `b48f22c` (2026-11-21) as an
  exact version in `apps/api/package.json`, with only its own platform packages added to
  the lockfile. No runtime code imports it — only the benchmark script does. *(The 2026-11-20
  text said "not installed"; that became false on 2026-11-21.)*

Benchmark acceptance — reproducible, recorded in the repository, and **a precondition for
final parameter approval**:

1. Both hashing and verification are measured, as separate stages.
2. Realistic concurrent authentication load is exercised, **including concurrency 4**.
   A single-connection run cannot satisfy this clause.
3. p50 and p95 latency are recorded for every stage.
4. Peak RSS is recorded.
5. Memory consumption is evaluated against the **actual** process/container memory limit,
   with that limit stated. If no limit exists on the benchmark host, the run is
   latency-only and cannot satisfy this clause.
6. The configuration is shown not to create unacceptable resource-exhaustion risk.

Acceptance targets:

- verification p95 ≤ 250 ms at **concurrency 4**;
- peak RSS ≤ 25 % of the configured memory limit for the benchmarked workload.

If a target is missed, the measured numbers are reported and adjusted parameters are
proposed — the security policy is not silently changed and the provisional row is not
promoted to final by preference.

- A hash produced with different parameters still verifies (the property that makes
  parameter upgrades safe).

## IG-7 — Brute-force protection — **A, conditional**

**Status raised to APPROVED, 2026-11-21** (*Amendment 1* §A1.4). "Conditional" below
described the 2026-11-20 state, when the limiter mechanism was still being chosen; the
mechanism was approved the same day and the policy is now final. The limits, the ordering
guarantee, and the recorded limitations are unchanged.

In-process, per-client-IP rate limiting.

- 30 requests per minute per IP.
- Applied to `POST /v1/auth/register` in S7 and to `POST /v1/auth/login` when S8 adds that
  endpoint. One decision, applied at the milestone that owns each endpoint.
- Executed before any database lookup and before any password hashing.
- Rejection is `429` with code `RATE_LIMITED`, plus `Retry-After` and the `RateLimit-*`
  headers specified in `api-conventions.md` §9.
- Per-account throttling is deferred.
- Redis and shared distributed rate limiting are **out of scope** for S7 and S8.
- The mechanism is a separate decision, `LIMITER-MECHANISM`, recorded in
  `docs/review/phase-3.2-s7-dependency-options.md`. The owner selected the in-process
  guard with no dependency on 2026-11-20, so this gate is a mechanism decision rather
  than a dependency approval.

Limitations, recorded rather than implied:

- Limits are process-local; N replicas behind the proxy enforce roughly N× the configured
  quota, and no shared quota exists.
- Distributed credential stuffing against one account remains an open security gap.
- If shared storage is introduced later, its failure policy must be fail closed — never
  "allow because the limiter is down".

## IG-10 — Email verification — **A**

Deferred and excluded from S7.

- Registration does not require verification.
- A newly registered account can log in immediately.
- No verification token, no email provider, no `email_verified_at` column.

Security consequence: **email ownership is not proven.** Anyone may register any
address. This is a mandatory security consideration before public deployment and a
blocker for it, not a detail to be discovered later.

---

## Additional implementation constraints

1. Do not modify the S4/S5/S6 migrations or the database grants as part of S7 without
   separate approval. Registration and login must fit the grants that exist.
2. Registration responses must **not** include `createdAt`: `app_auth` holds
   `SELECT (id, email, password_hash, role, locale, timezone)` and has no privilege on
   `created_at`.
3. Real-database integration tests run as the `app_auth` role.
4. `password_hash`, plaintext passwords, and session tokens never appear in a response or
   a log.
5. No cookie handling, CSRF protection, authentication guard, `/me`, or logout in S7, and
   no login endpoint either. Those are S8.
6. `docs/architecture/api-conventions.md` documents registration.
7. Every accepted security gap is recorded explicitly — see below.

## Accepted gaps

| Gap | Why accepted | Where it bites |
|---|---|---|
| Registration enumeration (`409` discloses existence) | `R-1` already accepts enumeration through the login lookup; hiding it in registration would not hide it anywhere else | account list validation |
| No per-account throttling | a shared store would be a new service for one endpoint; deferred with the rest of the distributed limit | credential stuffing across IPs |
| Process-local limiter | no shared storage is provisioned; `docker-compose.yml` has one service | horizontal scaling multiplies the quota |
| No leaked-password check | it needs a list or a service, neither approved | weak but policy-compliant passwords |
| No email verification | no provider, no token storage, and `IG-10` was explicitly deferred | account ownership claims, and any future password reset |
| Passwords restricted to printable ASCII | decided with the policy on 2026-11-20 to keep the rule unambiguous and testable | users who type accented or non-Latin passwords are refused |
| Argon2id parameters provisional | measurement on the real host has not run yet | the cost is a guess until it does |

## Implementation gate

S7 implementation may begin after **all** of:

1. This record is approved. *(Recorded 2026-11-20; finalized 2026-11-21 — Amendment 1.)*
2. The Argon2id library is selected and approved as a dependency. **Approved 2026-11-20,
   installed 2026-11-21** — `@node-rs/argon2@2.2.2`, exact, in `apps/api/package.json`;
   see `docs/review/phase-3.2-s7-dependency-options.md`. No runtime code imports it yet.
3. The `LIMITER-MECHANISM` decision is recorded. **Approved 2026-11-20** — in-process
   fixed-window guard, no dependency. Nothing implemented. No new dependency is approved
   for this, including `@nestjs/throttler`.
4. The benchmark is run and its numbers recorded. **Outstanding** — the harness is
   prepared in `apps/api/scripts/benchmark-argon2.mjs` and its plan is
   `docs/review/phase-3.2-s7-argon2-benchmark-plan.md`. A latency-only local run exists
   (2026-11-21, concurrency 1, unlimited-memory host) and does **not** satisfy `IG-6`:
   it has no concurrency-4 measurement and no memory limit to evaluate against. Parameters
   stay provisional until a run inside the deployment envelope is recorded.

Items 2 and 3 are satisfied. Items 1 and 4 are not sufficient for *final parameter*
approval — but they do not block S7 implementation itself: S7 may be built against the
provisional parameters, with the parameter constant isolated so that final approval is a
configuration change, not a rewrite.

Nothing in this record authorises an implementation, a migration, a dependency
installation, or a repository change on its own.

## What this record does not do

- It does not resolve `OPEN-01`. The credential boundary and the session table exist;
  no code reads a credential through them.
- It does not resolve `OPEN-04`, and it does not choose an account-deletion policy.
- It does not authorise S8, a cookie, or a CSRF mechanism.
- It does not approve `IG-8` or `IG-9`. (Both were approved later, on 2026-11-21 —
  `ADR-006` and *Amendment 3* of `docs/review/phase-3.2-owner-decisions.md`. That
  approval is not part of this S7 record and changes nothing here.)
- It does not make the provisional Argon2id parameters final.

---

# Amendment 1 — 2026-11-21: S7 policy finalized

**Approver:** Akihira77 (repository owner). **Date:** 2026-11-21.
**Status of the amendment:** decisions **approved**; nothing **implemented**; nothing
**verified**. S7 code does not exist.

This amendment closes the S7 policy round. It restates each gate's final disposition,
records the one substantive change since 2026-11-20 (`IG-4`), keeps `IG-6` conditional,
and classifies the implementation prerequisites so that they are not mistaken for owner
decisions. Nothing in the 2026-11-20 text above is deleted; where the two disagree, the
amendment wins and the disagreement is named.

The three words are used strictly:

| Word | Means here |
|---|---|
| **approved** | the owner has decided; the wording may be implemented against |
| **implemented** | code exists and does the thing |
| **verified** | an executed check against a real database or host proves it |

## A1.1 Final disposition

| ID | Subject | Final status | Approval date | Implementation |
|---|---|---|---|---|
| `IG-1` | Email normalisation | **APPROVED** | 2026-11-20, reconfirmed 2026-11-21 | not implemented |
| `IG-2` | Duplicate registration | **APPROVED** | 2026-11-20, reconfirmed 2026-11-21 | not implemented |
| `IG-3` | Registration issues no session | **APPROVED** | 2026-11-20, reconfirmed 2026-11-21 | not implemented |
| `IG-4` | Password policy | **APPROVED — rule revised 2026-11-21** | 2026-11-20, revised 2026-11-21 | not implemented |
| `IG-6` | Argon2id parameters | **CONDITIONALLY APPROVED** | 2026-11-20, conditional restated 2026-11-21 | not implemented |
| `IG-7` | Rate limiting | **APPROVED** (was conditional) | 2026-11-20; raised 2026-11-21 | not implemented |
| `IG-10` | Email verification | **APPROVED — DEFERRED** | 2026-11-20, reconfirmed 2026-11-21 | intentionally absent |

`OPEN-01`, `IG-8`, `IG-9` were approved earlier and are **not** reopened here — see
§A1.7.

## A1.2 `IG-4` — password policy, revised

The 2026-11-20 rule restricted passwords to printable ASCII and justified it by making
the character count and the byte count identical. On 2026-11-21 the owner approved a rule
that does not assume that equivalence, which makes the ASCII-only restriction
inconsistent: the charset clause and the `password.length` basis are **superseded**.

**Approved wording (2026-11-21).**

> Minimum length 12 characters. Maximum 1024 bytes in UTF-8. No composition
> requirements. The password is not trimmed, normalised, truncated, or otherwise modified
> before hashing, and is hashed exactly as supplied. The byte limit is validated with the
> UTF-8 byte length, not JavaScript `String.length`. Minimum-character counting for
> Unicode must be defined and tested explicitly; UTF-16 code units must not be silently
> treated as characters. Unicode normalisation is not introduced without a separate
> decision.

**What changed, precisely.**

| Rule | 2026-11-20 | 2026-11-21 |
|---|---|---|
| Allowed characters | printable ASCII only, U+0020–U+007E; everything else `400` | no charset restriction; non-ASCII permitted |
| Maximum | 1024 bytes (`Buffer.byteLength`) — unchanged | 1024 UTF-8 bytes (`Buffer.byteLength`) |
| Minimum counting | `password.length >= 12` (safe only because of the ASCII rule) | Unicode code points; `String.length` is explicitly rejected as the basis |
| Composition | none | none |
| Pre-hash modification | none | none |
| Normalisation | none (`IG-1` is about email only) | none; NFC/NFKC needs a separate decision |
| Leaked-password check | deferred | deferred, unchanged |

**What the implementation must define and test** (this is a specification obligation, not
a further approval):

1. **Counting unit.** The minimum counts Unicode code points — one astral character
   (surrogate pair in UTF-16) counts as **one**, not two. `password.length` therefore may
   not be used. A grapheme-cluster rule (counting `é` composed of `e` + combining accent
   as one) is a stricter alternative that is **not** approved; adopting it needs its own
   decision, because it changes which passwords are accepted.
2. **Tests must include** at least: a 12-code-point ASCII password (accepted), an
   11-code-point password (rejected), a password containing an astral character at the
   boundary (counted once), a password of 1024 bytes (accepted) and 1025 bytes
   (rejected), and a multi-byte password whose code-point count and byte count differ
   (the two limits must be applied independently).
3. **Unpaired surrogates are rejected** with `VALIDATION_FAILED`. A lone surrogate cannot
   be encoded to UTF-8; `Buffer.from` substitutes `U+FFFD`, so hashing it would hash
   different bytes than the user supplied — which contradicts "hashed exactly as
   supplied". This is a direct consequence of the approved rule, not a new one.
4. Because the charset is no longer ASCII, the maximum is **not** "1024 characters". A
   password may be far fewer than 1024 characters and still exceed 1024 bytes.
5. No trimming of leading or trailing spaces. A space is an ordinary character.

## A1.3 `IG-6` — Argon2id, **conditionally approved**

**Approved now:** algorithm Argon2id; 16-byte random salt per hash; 32-byte output; PHC
string encoding; parameters configuration-driven and appearing once; verification reads
its parameters from the stored hash, so a parameter change does not invalidate existing
hashes.

**Not approved now:** the numeric parameters. This row is a **provisional baseline** and
carries no final approval:

| Parameter | Provisional baseline |
|---|---:|
| `m` | 19456 KiB |
| `t` | 2 |
| `p` | 1 |

**Final approval requires a reproducible benchmark that does all six of the following.**
The full list is in the `IG-6` section above; in summary: hash *and* verify measured
separately; realistic concurrent load including **concurrency 4**; p50 and p95 recorded;
peak RSS recorded; memory evaluated against the **actual** process/container limit;
resource-exhaustion risk assessed and stated.

Acceptance targets: **verification p95 ≤ 250 ms at concurrency 4**, and **peak RSS ≤ 25 %
of the configured memory limit** for the benchmarked workload.

If a target is missed, the measured numbers are reported and adjusted parameters are
proposed. The security policy is not silently changed, and the provisional row is not
promoted by preference.

**Why the existing evidence does not close this gate.** A local benchmark ran on
2026-11-21 and is recorded in `docs/review/phase-3.2-s7-local-argon2-benchmark-results.md`
(six parameter sets, 100 samples per stage, environment snapshot, reproduction commands).
It satisfies clauses 1, 3, 4 and 6. It **cannot** satisfy clause 2 or 5:

- every run used `--concurrency 1`, because the harness refuses `concurrency > 1` when the
  effective cgroup memory limit is unknown — and on that host `memory.max = max` at every
  ancestor, so no finite limit exists. The run is marked
  `suitableForResourceEvaluation: false`;
- with no limit, the 25 %-of-limit criterion has no denominator.

The run is therefore **latency evidence only**. It must not be cited as final parameter
approval, and this document does not.

**One measured fact worth carrying forward** (from that run, subject to re-measurement on
the deployment envelope): peak RSS tracked `memoryCost` and **not** `memoryCost ×
parallelism` — 64 MiB at `p=1` and `p=4` both peaked near 118 MiB. The harness guard
over-estimates for `p > 1`; the guard was deliberately not weakened.

**Library status.** `@node-rs/argon2@2.2.2` is approved and **installed** (exact version,
`apps/api/package.json`, `b48f22c` 2026-11-21). No runtime code imports it; only
`apps/api/scripts/benchmark-argon2.mjs` does. Installing the library is not parameter
approval.

## A1.4 `IG-7` — rate limiting, approved

Approved v1 policy:

- 30 requests per minute per client IP on `POST /v1/auth/register` (S7) and
  `POST /v1/auth/login` (S8).
- In-process store for v1. Single implementation, no shared state.
- Enforced **before** password hashing and **before** the database lookup.
- Rejection: HTTP `429`, code `RATE_LIMITED`, `Retry-After`, plus the `RateLimit-Limit`,
  `RateLimit-Remaining`, `RateLimit-Reset` headers `api-conventions.md` §9 already
  specifies. `CONFLICT` and `RATE_LIMITED` both already exist in the closed error-code set
  (`packages/contracts/src/response.ts`), so no contract change is required for this gate.
- Accepted limitations, recorded rather than implied: state is lost on restart; each
  replica enforces an independent quota, so N replicas multiply it; distributed credential
  stuffing is not mitigated; per-account throttling is deferred; a shared store (Redis) is
  **not** approved and must not be added.

**Dependency decision — no new dependency.** The owner approved the policy, not a package.
`LIMITER-MECHANISM` was decided on 2026-11-20 as a hand-written in-process fixed-window
guard in `apps/api`, using `req.ip` under the existing trust-proxy configuration
(`docs/review/phase-3.2-s7-dependency-options.md` §2). Current dependencies are NestJS
`12.5.1` with no throttling package; the existing HTTP layer already has the middleware
seam and the header vocabulary, so a guard of this size does not justify a dependency.
`@nestjs/throttler` remains the documented, **unapproved** alternative — it would also
require amending §9's header names. If the guard proves inadequate in implementation, that
is a dependency request with an exact version, rationale, and impact, put to the owner
before installation.

## A1.5 `IG-1`, `IG-2`, `IG-3`, `IG-10` — reconfirmed

- **`IG-1`** — one shared function in `packages/contracts`, `trim()` then `toLowerCase()`,
  the same function for registration and login, `users_email_key` stays case-sensitive,
  no `citext`, no `lower(email)` index, no migration. Normalisation is an application
  invariant. No Unicode normalisation of the address joins this decision.
- **`IG-2`** — `409` with `CONFLICT`, no `details`, existing error envelope. Added clause
  (2026-11-21): the implementation must attempt the insert and map the unique-constraint
  violation atomically; a **prior existence check is not permitted**, because it is
  racy and it changes the disclosure behaviour under concurrency. Account-existence
  disclosure through registration stays an explicitly accepted trade-off.
- **`IG-3`** — no session, no cookie, no token from registration. Login is the only
  issuance path. Unchanged.
- **`IG-10`** — deferred; registration yields an immediately usable account; no
  verification table, column, token, or mail infrastructure in S7. **Email ownership is
  not proven.** This is a **blocker before public deployment** and must not be read as
  permission to deploy an unverified-email authentication system to the public.

`IG-2`'s hashing-before-duplicate-check ordering (2026-11-20) is retained: the hashing
cost, and therefore the timing, must not depend on whether the address exists. With
`IG-4`'s variable-length input and Argon2's fixed cost, that ordering is still the reason
a duplicate response takes as long as a fresh registration.

## A1.6 Implementation prerequisites — H-1 to H-9, classified

These are **not** owner decisions. Each is classified, and the classification decides who
acts.

| # | Finding | Classification | Disposition |
|---|---|---|---|
| `H-1` | `app_auth` holds `SELECT (id, email, password_hash, role, locale, timezone)` — no `created_at` | **Constraint, already decided** (`IG-3` response shape) | Registration returns `{ id, email, role, locale, timezone }` and omits `createdAt`. Do **not** broaden the grant to expose it. Verified in the migration; no change. |
| `H-2` | API tests use database doubles; no real-PostgreSQL target exists | **Implementation prerequisite** | S7 must add an integration target that connects as `app_auth` against a real database and exercises register + credential verification. `test/rls/auth-boundary.test.mjs` already runs as the real roles and is the model. |
| `H-3` | "No password hashing library installed" | **Resolved dependency — stale finding** | False since `b48f22c`: `@node-rs/argon2@2.2.2` is installed exactly. What remains is runtime code that imports it. |
| `H-4` | No rate-limiter dependency installed | **Decided — no dependency** | The approved mechanism is a hand-written guard (§A1.4). Nothing to install. A dependency would need its own approval. |
| `H-5` | Auth request contracts do not exist | **Implementation prerequisite** | `registerRequestSchema` / `loginRequestSchema` (and the safe-user response) belong in `packages/contracts`, validated by the existing pipe. No route may be written before its schema exists. |
| `H-6` | `users.updated_at` has no SQL trigger | **Documented behaviour — do not overclaim** | `User.updatedAt` is Prisma's `@updatedAt`: the client sets it on ORM updates. There is **no** `CREATE TRIGGER` anywhere in the migrations. A raw SQL `UPDATE` leaves the column stale, and `updated_at` must not be used as an audit trail. |
| `H-7` | Register is missing from API conventions | **Satisfied, then corrected** | `api-conventions.md` §8.1 documents registration and credential verification. It was corrected on 2026-11-21 for the revised `IG-4` rule (it previously stated printable-ASCII-only). |
| `H-8` | No explicit request-body size limit | **Implementation prerequisite + hardening gap** | The application relies on the platform default (Express/Nest `100 kb`), which is implicit. S7 must set the limit explicitly and document it; a marker for the later hardening pass (`OPEN-28` scope). No new dependency. |
| `H-9` | Existing internal error message and logging conventions | **Constraint — preserve** | The fixed message table, closed code set, `details` only from the validation pipe, and the rule that no message, stack, value, or token is logged all apply unchanged. `409`/`429` use that envelope; no ad-hoc body. |

## A1.7 Not reopened

- **`OPEN-01`** — `app_auth` stays separate from `app_api`, with least-privilege column
  grants, no hash exposure to the API role, no `BYPASSRLS`, no new `SECURITY DEFINER`
  function, and no `app.user_id` on the credential path. Confirmed by the owner on
  2026-11-21 (*Amendment 3* of `docs/review/phase-3.2-owner-decisions.md`, `ADR-004`).
  **Architectural approval is not implementation:** the boundary is built and verified,
  and no login request path exists. `OPEN-01` stays unresolved until one does.
- **`IG-8`** — `__Host-agroclimate_session`, `HttpOnly`, `Secure`, `SameSite=Lax`,
  `Path=/`, no `Domain`; token never in a response body; only the hash persisted.
- **`IG-9`** — synchronizer token bound to the session, `X-CSRF-Token`, exact `Origin`
  validation, on `POST`/`PUT`/`PATCH`/`DELETE`; `Origin` validation on register, login and
  logout even with no session; `SameSite=Lax` as defence in depth; not double-submit.

Both are recorded in `ADR-006` and *Amendment 3*; token retrieval, encoding, storage, and
rotation may be specified during S8 without another owner decision.

## A1.8 What Amendment 1 does not do

- It does not start S7. No endpoint, schema, guard, hasher, or limiter is implemented.
- It does not make the Argon2id parameters final, and does not convert the latency-only
  local run into resource evidence.
- It does not change a grant, policy, migration, RLS behaviour, or the dependency set.
- It does not add a rate-limiter dependency, Redis, or any infrastructure.
- It does not alter `IG-1`, `IG-2`, `IG-3`, `IG-7`, `IG-10` semantics beyond the clauses
  stated above, and it does not reopen `OPEN-01`, `IG-8`, or `IG-9`.
- It does not verify anything against a real database; **no verification claim is made**.
