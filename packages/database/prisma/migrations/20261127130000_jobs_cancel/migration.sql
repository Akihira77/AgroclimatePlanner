-- Cancel a job that has not started.
--
-- `cancelled` is a terminal state with its own name, not a reuse of `dead`:
-- `dead` means an attempt failed and the budget is spent, while `cancelled` means
-- nobody wants the work any more. Sharing one value would send an operator
-- looking for a `last_error` that never existed.
--
-- Only `queued` rows can be cancelled. A `running` job is refused on purpose: its
-- handler may be mid-transaction, and handing the row to nobody while the old
-- owner is still writing would produce data whose provenance disagrees with its
-- job status. The attempt budget bounds a bad job, and the lease reaper recovers
-- one whose process died — `background-processing.md` §11.
--
-- A cancelled row keeps `(kind, idempotency_key)`, so re-enqueuing the same
-- logical job returns `enqueued: false` and does not run. That is the intended
-- reading of "cancel": the decision is recorded, not erased.

ALTER TABLE app.jobs DROP CONSTRAINT jobs_status_check;
ALTER TABLE app.jobs ADD CONSTRAINT jobs_status_check
  CHECK (status IN ('queued', 'running', 'succeeded', 'dead', 'cancelled'));

ALTER TABLE app.jobs DROP CONSTRAINT jobs_finished_check;
ALTER TABLE app.jobs ADD CONSTRAINT jobs_finished_check
  CHECK ((status IN ('succeeded', 'dead', 'cancelled')) = (finished_at IS NOT NULL));
