-- Cluster-level bootstrap. Executed by scripts/bootstrap.mjs as a superuser,
-- because creating roles is a cluster privilege that migration_owner must not
-- hold. Contains no credentials: roles are created NOLOGIN and the provisioning
-- step enables LOGIN with a password supplied from the environment.
--
-- Idempotent: safe to run against an existing cluster.

DO $$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['migration_owner', 'app_api', 'app_system'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('CREATE ROLE %I', role_name);
    END IF;
  END LOOP;
END
$$;

-- Attributes enforced on every run, not only at creation. NOLOGIN is set here
-- deliberately: the provisioning step turns it on with a password.
ALTER ROLE migration_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
ALTER ROLE app_api          NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
ALTER ROLE app_system       NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS    NOINHERIT;

-- Application objects live in their own schema so that migration_owner owns
-- exactly one namespace and PostGIS keeps `public`, `topology`, and `tiger`.
CREATE SCHEMA IF NOT EXISTS app AUTHORIZATION migration_owner;

-- Nothing reaches the app schema by default. USAGE only: enough to resolve
-- names, not enough to create anything.
REVOKE ALL ON SCHEMA app FROM PUBLIC;
REVOKE CREATE ON SCHEMA app FROM PUBLIC;
GRANT USAGE ON SCHEMA app TO app_api, app_system;

-- `public` holds PostGIS. Runtime roles may reference its types and functions,
-- and still may not create objects there.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO app_api, app_system;

-- Default privileges are creator-specific: declared for migration_owner, the only
-- role that creates application objects. Without this, every function created
-- later would be executable by PUBLIC — that is the one real change here.
--
-- Measured on PostgreSQL 18.6: the schema-qualified form
-- (`... IN SCHEMA app REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`) records no
-- pg_default_acl row and changes nothing — a function created afterwards was
-- still executable by app_api. The unqualified form does take effect and stores
-- `{migration_owner=X/migration_owner}`. Tables and sequences need no entry at
-- all: PostgreSQL grants no privileges on them to other roles by default, which
-- the privilege verification checks against a table created after this runs.
ALTER DEFAULT PRIVILEGES FOR ROLE migration_owner
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, app_api, app_system;

-- Development volumes created before this phase put the Prisma ledger in
-- `public`, owned by the cluster admin. Move it where Prisma will look once the
-- connection carries ?schema=app, and where migration_owner owns it.
DO $$
BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL
     AND to_regclass('app._prisma_migrations') IS NULL THEN
    ALTER TABLE public._prisma_migrations SET SCHEMA app;
    RAISE NOTICE 'moved _prisma_migrations from public to app';
  END IF;
END
$$;

ALTER TABLE IF EXISTS app._prisma_migrations OWNER TO migration_owner;
