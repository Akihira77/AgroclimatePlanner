# ADR-006 — Session Transport and CSRF Protection

- Status: **Accepted** — approved by **Akihira77 on 2026-11-21**. This ADR formalises
  gates `IG-8` (session cookie configuration) and `IG-9` (CSRF protection), recorded by
  the repository owner on 2026-11-21 in
  `docs/review/phase-3.2-owner-decisions.md` *Amendment 3*. Acceptance is the decision;
  this document is its durable record. Acceptance is a **documentation gate, not
  implementation**: `S8` has not started, no cookie is issued, no CSRF token exists, and
  no `Origin` check is mounted. Every security property below is a requirement on code
  that does not exist yet.
- Date: 2026-11-21 (decision date and acceptance), recorded here 2026-11-21
- Depends on: ADR-002 (D5), ADR-004 (`app_auth` boundary), ADR-005 (session storage,
  token design, hash-only persistence), `docs/architecture/api-conventions.md` §8,
  `docs/review/phase-3.2-design-review.md` §17 gates `IG-8`, `IG-9`
- Supersedes: the `IG-8` and `IG-9` recommendations in
  `docs/review/phase-3.2-design-review.md:1056-1057` (plain cookie name in development;
  double-submit CSRF token). Both recommendations are **declined by the owner** — see
  *Alternatives that were rejected*. The review document itself is left unedited because
  it is a snapshot of what was recommended on 2026-11-18, not a live decision record.
- Implemented by: nothing yet. `S8` (login, session issuance, guard, `/me`, logout) owns
  every element of this ADR.
- Register entry: `IG-8`, `IG-9` — **approved 2026-11-21, not implemented, not verified**.

## Context

`ADR-005` decided *where* a session lives: a row in `app.sessions`, looked up by
`sha256(token)`, reachable only through `app_auth`. It deliberately left the transport
undecided — "rotation is an application security decision for the authentication track,
not a property of this store" (`ADR-005` §7). Two gates carried that remainder:

| Gate | Question | Consequence of leaving it open |
|---|---|---|
| `IG-8` | the cookie's name and attributes | whoever sets the first cookie invents a security policy by accident, and a name chosen for convenience becomes permanent |
| `IG-9` | CSRF mechanics: header, token length, comparison, rotation | the design review's one-line "double-submit" is not an implementable specification, so the implementer would invent the rest |

Both gates blocked `S8` and nothing else. They are recorded here because a cookie
attribute and a CSRF mechanism are not implementation details that a developer may
choose: they are the difference between a session that is XSS-stealable and one that is
not, and between a mutation endpoint that resists cross-site forgery and one that does
not.

## Decision

### D1 — Session cookie: host-only, `__Host-` prefixed

| Attribute | Value |
|---|---|
| Name | `__Host-agroclimate_session` |
| `HttpOnly` | yes |
| `Secure` | yes |
| `SameSite` | `Lax` |
| `Path` | `/` |
| `Domain` | **not set** — host-only |
| `Expires` / `Max-Age` | session token lifetime, per `ADR-005` §8 (sliding 30 d, absolute 90 d) |

`__Host-` is a browser-enforced prefix, not a naming convention. A cookie carrying it is
accepted only if it is `Secure`, has `Path=/`, and has **no** `Domain` attribute. The
prefix therefore makes the two strongest mistakes — omitting `Secure`, or widening the
cookie to every subdomain — structurally impossible rather than review-dependent.

`Domain` being absent is the point: the cookie is scoped to the exact host that issued
it. A session issued at `app.example.com` is not sent to `api.example.com`,
`static.example.com`, or any tenant-controlled subdomain. This deliberately forbids
sharing one session across sibling hosts; if a future deployment splits the web app and
the API across different hosts, it must route them under one host or revisit this ADR.

The token itself is the value from `ADR-005` §7: 32 CSPRNG bytes, base64url, opaque. It
appears in the `Set-Cookie` header and the request's `Cookie` header, and nowhere else:

- never in a response body, including login, `/me`, and error responses;
- never in a log line, metric label, trace attribute, or error message;
- never in the database — only `sha256(token)` is stored (`ADR-005` §8), enforced by the
  `token_hash` shape CHECK added as `D-1`.

### D2 — CSRF: synchronizer token bound to the session, plus `Origin` validation

**Two independent controls, both required.** Neither is sufficient alone, and neither is
a substitute for `SameSite=Lax`.

**D2.1 Synchronizer token.**

1. A CSRF token is generated server-side and associated with the authenticated session
   — not with a cookie value the client supplies, and not derived from the session token.
2. The frontend obtains it through a dedicated mechanism owned by `S8`. The mechanism is
   **not decided here** (see *Explicit limitations*); the constraints are decided:
   the retrieval must require the authenticated session, must not expose the session
   token, and must not make the CSRF token derivable from anything the client already
   holds.
3. The frontend sends it in the `X-CSRF-Token` request header.
4. The backend validates the presented token against the active session and rejects the
   request if it is absent, malformed, or does not match. Comparison is constant-time.
5. Protection applies to `POST`, `PUT`, `PATCH`, and `DELETE`. `GET` and `HEAD` are not
   state-changing and are not required to carry a token.

**D2.2 `Origin` validation.**

1. Every state-changing request's `Origin` header is compared, exactly, against an
   explicitly configured set of trusted application origins. Exact means scheme, host,
   and port: no wildcard, no suffix match, no "starts with".
2. A request with no `Origin`, or with an `Origin` outside the set, is refused. Absence
   is treated as untrusted: modern browsers send `Origin` on cross-origin requests and
   on same-origin state-changing requests, so a missing header indicates a client that
   is not a browser, and v1 has no such client.
3. The trusted set is the **existing** `CORS_ORIGINS` configuration
   (`apps/api/src/config/runtime-config.ts`, consumed by `apps/api/src/app.factory.ts`):
   development defaults to `http://localhost:5173`, and production requires the variable
   to be set. `S8` must reuse that one list rather than introduce a second
   origin variable; two lists of "trusted origins" drift, and the drift is invisible
   until one of them is wrong. *(Reusing `CORS_ORIGINS` is derived from the repository's
   existing convention, not from new owner wording. If a separate variable is preferred,
   that is an owner decision to record alongside this ADR.)*
4. No production origin is hardcoded anywhere in this ADR or in code. The deployment
   supplies it.

**D2.3 Endpoints that act before a session exists.**

`POST /v1/auth/register` and `POST /v1/auth/login` change state and have no authenticated
session to bind a synchronizer token to. `POST /v1/auth/logout` has one but must still
work when it is being revoked.

For these three, `Origin` validation (D2.2) is the required control, and it applies
before any body parsing, lookup, or hashing. A synchronizer token is not required where
there is no session to protect; requiring one would mean issuing a token to an
unauthenticated caller, which is the double-submit shape this ADR rejects. `SameSite=Lax`
continues to apply as defence in depth.

### D3 — `SameSite=Lax` is the floor

`SameSite=Lax` is required and may not be relaxed to `SameSite=None` without a separate
owner decision recorded in the same place as this one. `None` would re-permit cross-site
cookie attachment and would make CSRF protection depend entirely on D2 being correct on
every route.

## Alternatives that were rejected

| Alternative | Why rejected |
|---|---|
| **Double-submit cookie** (the design review's `IG-9` recommendation) | The "token" is a cookie the client can set, and the check compares two client-supplied values. It gives no server-side binding to the session, so any cookie-injection primitive — a subdomain, a sibling app, a misconfigured proxy — defeats it. The owner chose a server-verified token instead. |
| **Plain cookie name in development, `__Host-` in production** (the review's `IG-8` recommendation) | Two cookie shapes mean development never exercises the production path, and the difference is exactly the security property being protected. A dev-only relaxation is how a production misconfiguration ships. |
| **`SameSite=Strict`** | Breaks the ordinary case of following a link into the app: the first navigation would arrive unauthenticated. `Lax` plus D2 is the accepted trade. |
| **`SameSite=None`** | Not needed under any current requirement; it would remove the only control that works without application code. |
| **Origin validation alone** | Protects against cross-site requests from browsers, but not against a same-site request forged from a subdomain or a compromised sibling origin. The synchronizer token is bound to the server-side session and survives that. |
| **Synchronizer token alone** | Depends on the header being the only way to carry the token. Origin validation independently rejects requests that did not come from an application origin, which covers routes added later and mistakes in the token check. |
| **JWT with CSRF exemption** | `ADR-002` D5 already rejected stateless tokens; nothing here revives that. |

## Security properties

1. **A cross-site `POST` cannot mutate state** unless it also carries a token bound to
   the victim's session *and* arrives from a trusted origin.
2. **An XSS cannot read the session cookie** — `HttpOnly` — though XSS can still act as
   the user; this ADR does not claim otherwise.
3. **A subdomain cannot receive or set the session cookie** — `__Host-`, no `Domain`.
4. **A stolen database dump does not yield a usable session** — only `sha256(token)` is
   stored (`ADR-005`).
5. **A cookie set over cleartext is impossible** — `Secure` is mandatory and enforced by
   the `__Host-` prefix; a non-HTTPS deployment simply has no session.
6. **A new state-changing route is protected by default**, because both controls are
   global middleware/guards rather than per-route code paths.

## Development considerations (documented, not weakened)

`Secure` is not negotiable, so local development must satisfy it:

- Chromium and Firefox treat loopback origins (`localhost`, `127.0.0.1`, `[::1]`) as
  trustworthy and generally accept `Secure` cookies there over plain HTTP. This is
  browser behaviour, not a protocol guarantee, and it does not extend to a LAN hostname,
  a container name, or a WSL2 IP.
- Therefore: use a loopback origin for the browser, or terminate TLS locally (`mkcert`,
  or a development proxy) for any other origin. Do not add a "dev mode" that drops
  `Secure` or the prefix.
- The web app is a separate origin (`http://localhost:5173`) from the API
  (`http://localhost:3000`). The cookie is same-site (both under `localhost`) but
  cross-origin, so `S8` must enable credentialed CORS — the current factory mounts CORS
  with `credentials: false` (`apps/api/src/app.factory.ts`) — while keeping the origin
  allowlist exact. A wildcard origin with credentials is invalid by specification and
  must not be introduced.
- A deployment that serves the web app and the API from **different registrable
  domains** would not send a `Lax` cookie on cross-site requests. Same-registrable-domain
  hosting (subdomains of one domain) is a deployment requirement implied by D1 + D3, not
  a new decision.

## Explicit limitations

1. **Not implemented.** No cookie, no token, no `Origin` check, no `X-CSRF-Token`
   handling exists. `S8` must not be treated as started because this ADR is accepted.
2. **The CSRF token retrieval mechanism is undecided.** D2.1 fixes the constraints; `S8`
   design must propose the shape (a `GET` endpoint, a field on the login response, or a
   value inside an existing envelope) and the owner records it. Token length, encoding,
   storage form, and rotation policy are likewise `S8` design details, not approvals.
3. **`Origin` validation assumes correct proxy behaviour.** If a deployment terminates TLS
   at a proxy, the API must see the real client `Origin`; the existing `TRUST_PROXY`
   handling already refuses an unconditional `true` (`runtime-config.ts`), and this ADR
   adds no second mechanism.
4. **`__Host-` forbids cross-subdomain sharing.** If the product ever needs one session at
   `app.` and `api.` on different hosts, this ADR must be amended — not worked around by
   dropping the prefix.
5. **CSRF tokens do not cover `GET`.** No current `GET` mutates; that invariant is a
   convention (`api-conventions.md` §6) and must hold.
6. **No CSRF protection helps against a same-origin XSS or a compromised browser
   extension.** Those are outside this control's threat model.

## Consequences

- `S8` gains three requirements it did not have an unambiguous form for: exact cookie
  attributes, a session-bound token with a fixed header, and exact-origin validation
  reusing `CORS_ORIGINS`.
- `apps/api` CORS configuration must become credential-capable while staying an exact
  allowlist. This is a change to behaviour, so it belongs to `S8`, not to this
  documentation task.
- `api-conventions.md` §8 previously stated "CSRF: double-submit token on non-GET"; that
  statement is superseded by D2 and is amended there with a pointer to this ADR.
- No database object, grant, policy, or migration changes. The session table already
  stores only a hash, and `app_auth` already holds the narrowest grants that support it.
- The design review's `IG-8`/`IG-9` rows remain as written. They record what was
  recommended, and two of their recommendations were declined; rewriting them would
  hide that the recommendation was considered and rejected.

## Implementation references

Files `S8` will touch, for orientation only — none is modified by this ADR:

- `apps/api/src/app.factory.ts` — CORS credentials and origin allowlist, cookie parser,
  global middleware order.
- `apps/api/src/config/runtime-config.ts` — `CORS_ORIGINS` already parsed and required in
  production.
- `apps/api/src/http/api-exception.filter.ts` — `FORBIDDEN` is already a mapped code in
  the closed set; refusals must use it rather than inventing a code.
- `packages/contracts/src/response.ts` — the envelope and code set the refusal uses.
- `packages/database/prisma/migrations/20261118050000_sessions/migration.sql` — the
  table and grants the token binds to; unchanged.

## Related decisions and open decisions

- **`IG-8`** — approved 2026-11-21 by this ADR. Not implemented.
- **`IG-9`** — approved 2026-11-21 by this ADR. Not implemented.
- **`ADR-005`** — session storage, token entropy/encoding, hash-only persistence,
  sliding/absolute expiry. Unchanged.
- **`ADR-004`** — the `app_auth` boundary that performs the session lookup. Unchanged.
- **`ADR-002`** D5 — server-side sessions, not JWT. Unchanged.
- **`OPEN-01`** — the credential lookup request path. Unaffected by this ADR: it concerns
  login and session issuance, not cookie transport.
- **`OPEN-28`** — signed tenant context. Unaffected.
