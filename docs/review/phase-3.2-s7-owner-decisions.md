# Phase 3.2 — S7 Owner Decision Record: Registration and Credential Verification

| Field | Value |
|---|---|
| Status | **OWNER DECISIONS RECORDED — 2026-11-20.** The seven `IG` gates that blocked S7 are answered. One dependency approval (`ARGON2ID-LIB`), one mechanism decision (`LIMITER-MECHANISM`), and one benchmark remain, listed under *Implementation gate* |
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

- Minimum: **12 characters**.
- Maximum: **1024 characters**, enforced as `Buffer.byteLength(password, "utf8") <= 1024`.
  The approved charset is ASCII, so the character count and the UTF-8 byte count are the
  same number; the byte check is the form the boundary code uses.
- No composition requirements.
- No trimming, no Unicode normalisation; the password is hashed exactly as supplied.
- Leaked-password checking is **deferred** and recorded as a gap (see *Accepted gaps*).

**Character set, decided at the same time as the length rule.** Passwords are ordinary
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
A rejected password produces no partial state.

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
- Library selection requires explicit dependency approval and is **not** granted by this
  record.

Benchmark acceptance, reproducible and recorded in the repository:

- `argon2.verify` p95 ≤ 250 ms at concurrency 4.
- Peak RSS ≤ 25% of the container memory limit.
- A hash produced with different parameters still verifies.

## IG-7 — Brute-force protection — **A, conditional**

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
  `docs/review/phase-3.2-s7-dependency-options.md`. The recommendation is an in-process
  guard with no dependency, so this gate is not a dependency approval.

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

1. This record is approved. *(Recorded 2026-11-20; see Status.)*
2. The Argon2id library is selected and approved as a dependency. **Outstanding** —
   options and a recommendation are in `docs/review/phase-3.2-s7-dependency-options.md`
   (`@node-rs/argon2` 2.2.2 proposed).
3. The `LIMITER-MECHANISM` decision is recorded. **Outstanding** — the same document
   recommends no dependency at all (an in-process guard), which is a mechanism choice
   rather than a dependency approval, and needs the owner's word either way.
4. The benchmark is run and its numbers recorded. **Outstanding** — parameters stay
   provisional until then.

Nothing in this record authorises an implementation, a migration, a dependency
installation, or a repository change on its own.

## What this record does not do

- It does not resolve `OPEN-01`. The credential boundary and the session table exist;
  no code reads a credential through them.
- It does not resolve `OPEN-04`, and it does not choose an account-deletion policy.
- It does not authorise S8, a cookie, or a CSRF mechanism.
- It does not approve `IG-8` or `IG-9`.
- It does not make the provisional Argon2id parameters final.
