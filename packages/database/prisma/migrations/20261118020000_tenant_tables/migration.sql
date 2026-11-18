-- Phase 2.2.3 — the first tenant-owned tables, and the row policy that isolates
-- them.
--
-- Scope is deliberately three tables. `docs/data-model/` does not exist yet, and
-- the conceptual model in `docs/architecture/domain-model.md` §2 is the only
-- normative description of these entities — users, farms, fields. The derived
-- tables (`suitability_runs`, `planting_windows`, `ai_briefings`) have columns
-- specified as discriminated unions and would have to be invented here, so they
-- are not created.
--
-- Every table below is owned by migration_owner (the migration connection), and
-- every runtime privilege is granted explicitly at the end of the file.

CREATE TABLE app.users (
  id            uuid        PRIMARY KEY DEFAULT uuidv7(),
  email         text        NOT NULL,
  password_hash text        NOT NULL,
  locale        text        NOT NULL DEFAULT 'id',
  timezone      text        NOT NULL DEFAULT 'Asia/Jakarta',
  role          text        NOT NULL DEFAULT 'owner',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_key UNIQUE (email),
  -- Shape, not deliverability. A mailbox check belongs in the verification mail
  -- flow; the database's job is to not store an obvious non-address.
  CONSTRAINT users_email_shape_check CHECK (position('@' IN email) > 1 AND email !~ '\s'),
  CONSTRAINT users_role_check CHECK (role IN ('owner', 'admin'))
);

CREATE TABLE app.farms (
  id         uuid        PRIMARY KEY DEFAULT uuidv7(),
  user_id    uuid        NOT NULL REFERENCES app.users (id),
  name       text        NOT NULL,
  region     text,
  notes      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Farms and fields are soft-deleted (domain-model §7); a row that disappears
  -- takes its history with it, and a suitability run must stay explainable.
  deleted_at timestamptz,
  -- The target of fields' composite foreign key. Without it, the ownership
  -- invariant below could only be enforced by a trigger.
  CONSTRAINT farms_id_user_id_key UNIQUE (id, user_id)
);

CREATE INDEX farms_user_id_idx ON app.farms (user_id) WHERE deleted_at IS NULL;

CREATE TABLE app.fields (
  id                      uuid        PRIMARY KEY DEFAULT uuidv7(),
  -- Denormalised on purpose: the RLS policy compares the row's own column
  -- instead of joining through farms, which would make every write a join
  -- against another RLS-protected table.
  user_id                 uuid        NOT NULL,
  farm_id                 uuid        NOT NULL,
  name                    text        NOT NULL,
  geom                    public.geometry(Geometry, 4326) NOT NULL,
  -- Computed by the database so there is one definition of area, and it cannot
  -- drift from the geometry it describes.
  area_ha                 double precision GENERATED ALWAYS AS (public.ST_Area(geom::public.geography) / 10000.0) STORED,
  elevation_m             numeric(7, 2),
  soil_type               text,
  soil_ph                 numeric(3, 1),
  drainage_class          text,
  irrigation_availability text,
  water_source            text,
  cropping_history_notes  text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  deleted_at              timestamptz,
  CONSTRAINT fields_id_user_id_key UNIQUE (id, user_id),
  -- Ownership travels with the reference. A tenant cannot create a field under
  -- another tenant's farm by writing its own user_id: the pair must match a row
  -- in farms, and (farm_id, user_id) is that row's identity.
  CONSTRAINT fields_farm_owner_fkey FOREIGN KEY (farm_id, user_id)
    REFERENCES app.farms (id, user_id),
  CONSTRAINT fields_geom_type_check CHECK (public.GeometryType(geom) IN ('POINT', 'POLYGON', 'MULTIPOLYGON')),
  CONSTRAINT fields_geom_srid_check CHECK (public.ST_SRID(geom) = 4326),
  CONSTRAINT fields_geom_valid_check CHECK (public.ST_IsValid(geom)),
  CONSTRAINT fields_geom_not_empty_check CHECK (NOT public.ST_IsEmpty(geom)),
  CONSTRAINT fields_name_not_blank_check CHECK (length(btrim(name)) > 0),
  CONSTRAINT fields_elevation_range_check CHECK (elevation_m BETWEEN -500 AND 6000),
  CONSTRAINT fields_soil_ph_range_check CHECK (soil_ph BETWEEN 3.0 AND 10.0)
);

CREATE INDEX fields_user_id_idx ON app.fields (user_id) WHERE deleted_at IS NULL;
CREATE INDEX fields_farm_id_idx ON app.fields (farm_id) WHERE deleted_at IS NULL;
CREATE INDEX fields_geom_gist_idx ON app.fields USING gist (geom);

-- Row isolation -------------------------------------------------------------
--
-- FORCE is not decoration: without it the table owner bypasses its own policies,
-- and migration_owner is the owner. ENABLE alone would leave the migration
-- connection reading every tenant's rows.
--
-- The context expression is fail-closed in three distinct ways, all of which
-- matter: unset `app.user_id` -> current_setting(...,true) is NULL -> NULLIF(NULL)
-- is NULL -> no row matches. Empty string -> NULLIF gives NULL -> no row matches.
-- A missing setting therefore denies, it does not raise a cast error and it does
-- not fall back to "all rows".
--
-- Policies are FOR ALL rather than four separate policies: the ownership
-- predicate is identical for SELECT, INSERT, UPDATE and DELETE, and UPDATE needs
-- both USING (which rows may be seen) and WITH CHECK (which rows may result).
-- A row of two policies — USING only — would let a tenant UPDATE a row into
-- another tenant's ownership.

ALTER TABLE app.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.users FORCE ROW LEVEL SECURITY;
CREATE POLICY users_self_only ON app.users
  FOR ALL TO app_api
  USING (id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.user_id', true), '')::uuid);

ALTER TABLE app.farms ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.farms FORCE ROW LEVEL SECURITY;
CREATE POLICY farms_tenant_isolation ON app.farms
  FOR ALL TO app_api
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

ALTER TABLE app.fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.fields FORCE ROW LEVEL SECURITY;
CREATE POLICY fields_tenant_isolation ON app.fields
  FOR ALL TO app_api
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

-- FORCE applies row security to the table owner too, and a table with no policy
-- for a role denies it — including migration_owner. Without the three policies
-- below the owner could not insert a fixture or run a data migration, which
-- reads as a mysterious "new row violates row-level security policy". This is
-- not a widening: owning the table already means DROP and ALTER, so the policy
-- only makes the owner's existing authority explicit.
CREATE POLICY users_owner_full_access ON app.users
  FOR ALL TO migration_owner USING (true) WITH CHECK (true);
CREATE POLICY farms_owner_full_access ON app.farms
  FOR ALL TO migration_owner USING (true) WITH CHECK (true);
CREATE POLICY fields_owner_full_access ON app.fields
  FOR ALL TO migration_owner USING (true) WITH CHECK (true);

-- Runtime privileges --------------------------------------------------------
--
-- Explicit, per table, per operation. No `GRANT ALL`, no
-- `GRANT ... ON ALL TABLES`, no `ALTER DEFAULT PRIVILEGES` — the default-deny
-- established in 2.2.2 stays the baseline, and each new table opts in.
--
-- app_system is granted nothing. background-processing §10 rule 2: a new
-- tenant-owned table ships without an app_system grant, and access is added only
-- when a specific sweep needs it. The maintenance sweep does not exist yet.
--
-- app_api gets no privileges on app.users at all. Reading a user by email is the
-- authentication path, which runs *before* a tenant context exists; granting
-- SELECT here would either require an unpolicied table or invent a security
-- definer function. Deferred deliberately — see docs/architecture/auth-deferred.md
-- in the 2.2.3 notes in database-foundation.md rather than half-building it.

GRANT SELECT, INSERT, UPDATE, DELETE ON app.farms TO app_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.fields TO app_api;

-- Sequences are not granted because there are none: identifiers come from
-- uuidv7(), so there is no nextval() path to leak.
