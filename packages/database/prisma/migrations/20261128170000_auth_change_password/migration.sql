-- AUTH-14: allow authenticated users to change their password through app_auth
-- via a narrow SECURITY DEFINER function that revokes all other active sessions.

CREATE OR REPLACE FUNCTION app.change_user_password(
  p_user_id uuid,
  p_new_password_hash text,
  p_keep_session_id uuid DEFAULT NULL
)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, app
AS $$
DECLARE
  v_updated integer;
BEGIN
  IF p_user_id IS NULL OR p_new_password_hash IS NULL OR btrim(p_new_password_hash) = '' THEN
    RETURN false;
  END IF;

  UPDATE app.users
     SET password_hash = p_new_password_hash,
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
     AND revoked_at IS NULL
     AND (p_keep_session_id IS NULL OR id <> p_keep_session_id);

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION app.change_user_password(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.change_user_password(uuid, text, uuid) TO app_auth;
