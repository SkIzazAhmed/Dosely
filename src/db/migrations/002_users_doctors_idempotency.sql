-- 002_users_doctors_idempotency.sql
-- Commit 2 (Nov 6): USERS (A3), DOCTORS (A5), idempotency keys (A4).

-- ---------------------------------------------------------------------------
-- USERS (A3)
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  role           user_role   NOT NULL,
  full_name      text        NOT NULL CHECK (length(btrim(full_name)) BETWEEN 1 AND 120),
  email          text        CHECK (email IS NULL OR email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  password_hash  text        NOT NULL,
  last_login_at  timestamptz,
  is_active      boolean     NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
-- Email is optional, but unique (case-insensitive) when present.
CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email)) WHERE email IS NOT NULL;
CREATE INDEX users_role_idx ON users (role) WHERE is_active;
SELECT apply_conventions('users');

-- ---------------------------------------------------------------------------
-- DOCTORS (A5): one profile per DOCTOR user
-- ---------------------------------------------------------------------------
CREATE TABLE doctors (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id          bigint      NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  registration_no  text        CHECK (registration_no IS NULL OR length(btrim(registration_no)) BETWEEN 3 AND 50),
  specialization   text,
  qualification    text,
  clinic_name      text,
  is_active        boolean     NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT doctors_user_id_key UNIQUE (user_id)
);
-- Registration number is required to send requests; unique when present.
CREATE UNIQUE INDEX doctors_registration_no_key ON doctors (upper(registration_no)) WHERE registration_no IS NOT NULL;
SELECT apply_conventions('doctors');

-- A doctor profile can only belong to a DOCTOR user.
CREATE OR REPLACE FUNCTION doctors_require_doctor_role() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id AND role = 'DOCTOR') THEN
    RAISE EXCEPTION 'DOCTOR_ROLE_REQUIRED: user % is not a DOCTOR', NEW.user_id USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER doctors_require_doctor_role
  BEFORE INSERT OR UPDATE OF user_id ON doctors
  FOR EACH ROW EXECUTE FUNCTION doctors_require_doctor_role();

-- ---------------------------------------------------------------------------
-- IDEMPOTENCY KEYS (A4): replay POST responses for the same key
-- ---------------------------------------------------------------------------
CREATE TABLE idempotency_keys (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  scope_user_id  bigint      NOT NULL DEFAULT 0,   -- 0 = anonymous caller
  key            text        NOT NULL CHECK (length(key) BETWEEN 1 AND 255),
  method         text        NOT NULL,
  path           text        NOT NULL,
  request_hash   text        NOT NULL,
  state          text        NOT NULL DEFAULT 'IN_PROGRESS' CHECK (state IN ('IN_PROGRESS', 'COMPLETED')),
  status_code    integer,
  response_body  jsonb,
  expires_at     timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT idempotency_keys_scope_key UNIQUE (scope_user_id, key)
);
CREATE INDEX idempotency_keys_expires_idx ON idempotency_keys (expires_at);
SELECT apply_conventions('idempotency_keys', true);  -- expired keys may be deleted
