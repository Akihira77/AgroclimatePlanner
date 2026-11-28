-- Closure of OPEN-17 (disallow POINT in v1), OPEN-21 (soil_type & drainage_class
-- closed nullable vocabularies), and OPEN-04 (soft-delete + 30-day grace anonymization
-- + partial unique email index).

-- 1. OPEN-17: disallow POINT fields in v1 (POLYGON and MULTIPOLYGON only).
ALTER TABLE app.fields DROP CONSTRAINT fields_geom_type_check;
ALTER TABLE app.fields ADD CONSTRAINT fields_geom_type_check
  CHECK (public.GeometryType(geom) IN ('POLYGON', 'MULTIPOLYGON'));

-- 2. OPEN-21: closed nullable vocabularies for soil_type and drainage_class.
ALTER TABLE app.fields ADD CONSTRAINT fields_soil_type_check
  CHECK (
    soil_type IS NULL
    OR soil_type IN (
      'clay',
      'loam',
      'sandy',
      'clay_loam',
      'sandy_loam',
      'silt_loam',
      'peat',
      'alluvial',
      'volcanic',
      'unknown'
    )
  );

ALTER TABLE app.fields ADD CONSTRAINT fields_drainage_class_check
  CHECK (
    drainage_class IS NULL
    OR drainage_class IN ('poor', 'moderate', 'well', 'excessive', 'unknown')
  );

-- 3. OPEN-04: soft-delete + grace-period anonymization + partial unique email index.
ALTER TABLE app.users
  ADD COLUMN deleted_at timestamptz(6),
  ADD COLUMN anonymized_at timestamptz(6);

ALTER TABLE app.users ADD CONSTRAINT users_anonymized_requires_deleted_check
  CHECK (anonymized_at IS NULL OR deleted_at IS NOT NULL);

ALTER TABLE app.users DROP CONSTRAINT users_email_key;
CREATE UNIQUE INDEX users_email_key ON app.users (email) WHERE deleted_at IS NULL;

GRANT SELECT (deleted_at) ON app.users TO app_auth;

CREATE OR REPLACE FUNCTION app.soft_delete_account(p_user_id uuid)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, app
AS $$
DECLARE
  v_updated integer;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN false;
  END IF;

  UPDATE app.users
     SET deleted_at = now(),
         updated_at = now()
   WHERE id = p_user_id
     AND deleted_at IS NULL;
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated = 0 THEN
    RETURN false;
  END IF;

  UPDATE app.sessions
     SET revoked_at = now()
   WHERE user_id = p_user_id
     AND revoked_at IS NULL;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION app.soft_delete_account(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.soft_delete_account(uuid) TO app_auth;

CREATE OR REPLACE FUNCTION app.anonymize_expired_deleted_users(p_grace_days integer DEFAULT 30)
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, app
AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_grace_days IS NULL OR p_grace_days < 0 THEN
    RAISE EXCEPTION 'p_grace_days must be non-negative';
  END IF;

  UPDATE app.users
     SET email = 'deleted+' || id::text || '@deleted.invalid',
         password_hash = 'ANONYMIZED',
         anonymized_at = now(),
         updated_at = now()
   WHERE deleted_at IS NOT NULL
     AND anonymized_at IS NULL
     AND deleted_at <= now() - make_interval(days => p_grace_days);
  GET DIAGNOSTICS v_count = ROW_COUNT;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION app.anonymize_expired_deleted_users(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.anonymize_expired_deleted_users(integer) TO app_system;
