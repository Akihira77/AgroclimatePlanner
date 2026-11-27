-- D5, transition half: a published (or retired) crop profile is immutable.
--
-- `tables-catalog.md` §3 specifies the `crop_profile_versions_immutable` trigger
-- and names the reason: `migration_owner` can write the table, and a seed script
-- correcting a typo in place would silently change what every stored window was
-- evaluated against while the windows still name this id. Grants alone block the
-- runtime roles, not the owner.
--
-- The published-at column is the test, not the status: a retired profile keeps
-- serving every artifact that already names it, so retirement is a status change
-- on a frozen row, not a thaw. Allowed transitions: `published -> published` and
-- `published -> retired`, with every content column unchanged.
CREATE FUNCTION app.enforce_crop_profile_immutability() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.published_at IS NOT NULL THEN
    -- Retirement is terminal: a retired profile cannot be republished, because
    -- artifacts already name it and a second publication would make the id mean
    -- two different rulebooks.
    IF NEW.status NOT IN ('published', 'retired')
       OR (OLD.status = 'retired' AND NEW.status <> 'retired') THEN
      RAISE EXCEPTION 'crop_profile_versions % is published; only published -> retired is allowed', OLD.id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF (NEW.cultivar_id, NEW.rule_version, NEW.published_at, NEW.supersedes_id, NEW.created_at)
       IS DISTINCT FROM
       (OLD.cultivar_id, OLD.rule_version, OLD.published_at, OLD.supersedes_id, OLD.created_at) THEN
      RAISE EXCEPTION 'crop_profile_versions % is immutable after publication', OLD.id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER crop_profile_versions_immutable
  BEFORE UPDATE ON app.crop_profile_versions
  FOR EACH ROW EXECUTE FUNCTION app.enforce_crop_profile_immutability();

-- The same rule for the rulebook's own rows. A profile whose stages, thresholds,
-- or citations can be edited after publication is not immutable: the id would
-- still name the version, and the version would no longer be the one evaluated.
-- Rejected for `published` and `retired` alike, and for INSERT as well as
-- UPDATE/DELETE, because appending a threshold to a frozen profile is the same
-- violation as editing one.
CREATE FUNCTION app.enforce_crop_profile_child_immutability() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target uuid;
  profile_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target := OLD.profile_version_id;
  ELSE
    target := NEW.profile_version_id;
  END IF;

  SELECT p.status INTO profile_status FROM app.crop_profile_versions p WHERE p.id = target;

  IF profile_status IN ('published', 'retired') THEN
    RAISE EXCEPTION '% rows of % profile % are immutable', TG_TABLE_NAME, profile_status, target
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER growth_stages_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON app.growth_stages
  FOR EACH ROW EXECUTE FUNCTION app.enforce_crop_profile_child_immutability();

CREATE TRIGGER constraints_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON app.constraints
  FOR EACH ROW EXECUTE FUNCTION app.enforce_crop_profile_child_immutability();

CREATE TRIGGER source_refs_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON app.source_refs
  FOR EACH ROW EXECUTE FUNCTION app.enforce_crop_profile_child_immutability();
