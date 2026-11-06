-- 001_enums_and_conventions.sql
-- Commit 1 (Nov 4): every enum for the platform/people tables, plus the
-- shared conventions (A2) that every later table applies.
--
-- Conventions for EVERY table (A2):
--   id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY
--   created_at  timestamptz NOT NULL DEFAULT now()
--   updated_at  timestamptz NOT NULL DEFAULT now()   -- kept fresh by trigger
--   is_active   boolean NOT NULL DEFAULT true        -- deactivate, don't delete
--   foreign keys use ON DELETE RESTRICT
--   after CREATE TABLE, call:  SELECT apply_conventions('table_name');
--
-- Example for later migrations:
--   CREATE TABLE shops (
--     id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
--     ...,
--     is_active   boolean     NOT NULL DEFAULT true,
--     created_at  timestamptz NOT NULL DEFAULT now(),
--     updated_at  timestamptz NOT NULL DEFAULT now()
--   );
--   SELECT apply_conventions('shops');

-- ---------------------------------------------------------------------------
-- Enums (mirrored in src/shared/enums.js)
-- ---------------------------------------------------------------------------

CREATE TYPE user_role AS ENUM ('DOCTOR', 'SHOPKEEPER', 'ADMIN');                 -- A3
CREATE TYPE staff_role AS ENUM ('OWNER', 'STAFF');                               -- A7
CREATE TYPE gender AS ENUM ('MALE', 'FEMALE', 'OTHER', 'UNDISCLOSED');           -- A8
CREATE TYPE phone_owner_type AS ENUM ('USER', 'PATIENT', 'SHOP');                -- A9
CREATE TYPE phone_type AS ENUM ('MOBILE', 'LANDLINE', 'WHATSAPP', 'OTHER');      -- A9
CREATE TYPE phone_status AS ENUM ('UNVERIFIED', 'VERIFIED', 'UNREACHABLE');      -- A9, A11
CREATE TYPE notification_channel AS ENUM ('IN_APP', 'SMS', 'EMAIL');             -- A10
CREATE TYPE notification_status AS ENUM ('PENDING', 'SENT', 'FAILED', 'SKIPPED');-- A10, A11
CREATE TYPE notification_recipient_type AS ENUM ('USER', 'PATIENT', 'SHOP');     -- A10

-- ---------------------------------------------------------------------------
-- Convention helpers
-- ---------------------------------------------------------------------------

-- Keeps updated_at current on every UPDATE.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- Blocks hard deletes: rows are deactivated (is_active = false) instead.
-- Error message starts with DELETE_NOT_ALLOWED so fromPgError() can map it.
CREATE OR REPLACE FUNCTION prevent_hard_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'DELETE_NOT_ALLOWED: rows in % are deactivated, not deleted', TG_TABLE_NAME
    USING ERRCODE = 'P0001';
END;
$$;

-- Attach both triggers to a table. allow_delete = true skips the delete
-- guard (for join/log tables where hard deletes are fine, e.g. idempotency keys).
CREATE OR REPLACE FUNCTION apply_conventions(tbl regclass, allow_delete boolean DEFAULT false)
RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  t text := tbl::text;
  n text := replace(tbl::text, '.', '_');
BEGIN
  EXECUTE format(
    'CREATE TRIGGER %I BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
    n || '_set_updated_at', t);
  IF NOT allow_delete THEN
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE DELETE ON %s FOR EACH ROW EXECUTE FUNCTION prevent_hard_delete()',
      n || '_no_delete', t);
  END IF;
END;
$$;
