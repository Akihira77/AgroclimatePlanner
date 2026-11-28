-- OPEN-09 (settled 2026-11-28): plantings.status vocabulary, default, and partial index (D26).
ALTER TABLE app.plantings
  ALTER COLUMN status SET DEFAULT 'active';

ALTER TABLE app.plantings
  ADD CONSTRAINT plantings_status_check
  CHECK (status IN ('active', 'harvested', 'failed', 'abandoned'));

CREATE INDEX plantings_active_idx
  ON app.plantings (user_id, field_id)
  WHERE status = 'active';

-- OPEN-21 (settled 2026-11-28): closed vocabulary CHECK on fields.irrigation_availability.
ALTER TABLE app.fields
  ADD CONSTRAINT fields_irrigation_availability_check
  CHECK (
    irrigation_availability IS NULL
    OR irrigation_availability IN ('irrigated', 'partial_irrigation', 'rainfed', 'unknown')
  );
