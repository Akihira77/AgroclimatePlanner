-- Phase 5.3: the PostgreSQL job queue (`background-processing.md` §2.1,
-- `climate-data-foundation.md` §8.3).
--
-- One table, not six. The six queues of §2 are `kind` values; a queue is a
-- predicate, not a table, so an operator can read the whole backlog in one
-- query and a future backing store replaces one module.
--
-- Global like the rest of the climate plane: no `user_id`, no RLS policy, and
-- that is the specification rather than an omission.
--
-- `attempt` counts claims, not failures. It rises exactly once per successful
-- claim and never resets, so `attempt = 0` means "never claimed" and
-- `attempt = max_attempts` means "the last permitted execution is running or
-- has finished". `ingestion_runs.attempt` is a different counter (handler
-- starts) and is deliberately not synchronised with this one.

CREATE TABLE app.jobs (
  id               uuid           PRIMARY KEY DEFAULT uuidv7(),
  -- One of the six queue names in `background-processing.md` §2. Not a job
  -- type: two different jobs may share a kind, and a kind is the unit of
  -- isolation (concurrency ceiling, timeout, rate bucket, blast radius).
  kind             text           NOT NULL,
  -- Deterministic over the job's logical identity. For ingestion jobs:
  -- `ingest:{queue}:{forecastRunId}:{ingestionVersion}`. A dead job keeps its
  -- key (see `jobs_identity_key`), which is what makes dead-letter recovery an
  -- explicit operator action rather than an accident.
  idempotency_key  text           NOT NULL,
  -- Handler-owned. Validated by the handler, not by a CHECK: an invalid payload
  -- must become `dead` with a reason, not be rejected at enqueue by a table
  -- that knows nothing about the handler's contract.
  payload          jsonb          NOT NULL DEFAULT '{}'::jsonb,
  status           text           NOT NULL DEFAULT 'queued',
  -- Claims that succeeded. 0 = never claimed.
  attempt          integer        NOT NULL DEFAULT 0,
  max_attempts     integer        NOT NULL DEFAULT 5,
  -- Earliest claim time. Retry pushes it forward; nothing else does.
  run_at           timestamptz(6) NOT NULL DEFAULT now(),
  -- Ownership token. A UUID rather than the worker's name because two
  -- processes can share a hostname and because a token is what a stale worker
  -- is compared against: every lease-sensitive write names it.
  lease_token      uuid,
  lease_expires_at timestamptz(6),
  -- The logical ingestion this job executes, once a handler has begun. NULL at
  -- enqueue: `ingestion_runs` rows are created by the handler start, so there
  -- is nothing to point at before that (`climate-data-foundation.md` §8.3).
  ingestion_run_id uuid,
  -- {code, message, retryable?}; the last failure, never a history.
  last_error       jsonb,
  finished_at      timestamptz(6),
  created_at       timestamptz(6) NOT NULL DEFAULT now(),
  updated_at       timestamptz(6) NOT NULL DEFAULT now(),

  CONSTRAINT jobs_identity_key UNIQUE (kind, idempotency_key),

  CONSTRAINT jobs_kind_check CHECK (kind IN (
    'ingest.forecast', 'ingest.climate', 'aggregate',
    'recompute.windows', 'verify', 'maintenance')),

  CONSTRAINT jobs_status_check CHECK (status IN ('queued', 'running', 'succeeded', 'dead')),

  -- `attempt` may equal `max_attempts`: the last permitted execution must be
  -- allowed to run, and its failure is what turns the job `dead`.
  CONSTRAINT jobs_attempt_check CHECK (attempt BETWEEN 0 AND max_attempts),
  CONSTRAINT jobs_max_attempts_check CHECK (max_attempts BETWEEN 1 AND 20),

  -- A lease exists exactly while a job is running. One CHECK per direction, so
  -- a half-written lease cannot exist in either shape.
  CONSTRAINT jobs_lease_check CHECK ((status = 'running') = (lease_token IS NOT NULL)),
  CONSTRAINT jobs_lease_expiry_check
    CHECK (lease_token IS NULL OR lease_expires_at IS NOT NULL),

  -- Same shape as `ingestion_runs_finished_check`: one lifecycle, one rule.
  CONSTRAINT jobs_finished_check
    CHECK ((status IN ('succeeded', 'dead')) = (finished_at IS NOT NULL)),

  CONSTRAINT jobs_error_check CHECK (last_error IS NULL OR jsonb_typeof(last_error) = 'object'),

  -- RESTRICT, not SET NULL: a job's reference to the run it executed is
  -- provenance. Deleting the run out from under it must be an explicit decision
  -- that fails first, not a silent NULL that leaves the reaper unable to fail
  -- the run it can no longer see.
  CONSTRAINT jobs_ingestion_run_fkey FOREIGN KEY (ingestion_run_id)
    REFERENCES app.ingestion_runs (id) ON DELETE RESTRICT
);

-- The claim path: the only hot query. Partial because `succeeded` and `dead`
-- rows are never claimable and must not slow the scan down as the table grows
-- without bound.
CREATE INDEX jobs_claim_idx
  ON app.jobs (kind, run_at, id)
  WHERE status = 'queued';

-- The reaper path: expired leases only.
CREATE INDEX jobs_lease_idx
  ON app.jobs (lease_expires_at)
  WHERE status = 'running' AND lease_expires_at IS NOT NULL;

-- Observability (§9: depth, oldest waiting) and operator inspection.
CREATE INDEX jobs_created_idx ON app.jobs (kind, status, created_at);

-- Required by `jobs_ingestion_run_fkey`. The partial unique index below cannot
-- serve the FK check because `queued` rows are outside it.
CREATE INDEX jobs_ingestion_run_idx ON app.jobs (ingestion_run_id);

-- At most one running job may own an IngestionRun. Without this, two jobs could
-- execute the same logical ingestion concurrently; the key makes that state
-- impossible to persist rather than merely discouraged by prose.
CREATE UNIQUE INDEX jobs_active_ingestion_idx
  ON app.jobs (ingestion_run_id)
  WHERE status = 'running' AND ingestion_run_id IS NOT NULL;

-- Runtime privileges --------------------------------------------------------
--
-- app_system only. `app_api` gets no grant at all: user-facing ingestion state
-- is read from `app.ingestion_runs`, which it already holds SELECT on. Granting
-- a read here before a reader exists would be a privilege that only widens the
-- blast radius of a compromised request path.
--
-- Explicit, per table, per operation; no `GRANT ALL`, no
-- `ALTER DEFAULT PRIVILEGES` (ownership-and-rls §2 rule 1).

GRANT SELECT, INSERT, UPDATE, DELETE ON app.jobs TO app_system;
