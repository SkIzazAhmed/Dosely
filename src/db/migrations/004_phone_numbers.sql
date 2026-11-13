-- 004_phone_numbers.sql
-- Izaz, Commit 4 (Nov 10): PHONE_NUMBERS (A9, F5, rules P1–P13).
-- Every number belongs to exactly one owner: a user, a patient or a shop (F5.1).

CREATE TYPE phone_label AS ENUM ('MOBILE', 'HOME', 'WORK', 'SHOP');            -- P3

CREATE TABLE phone_numbers (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_type            phone_owner_type NOT NULL,
  user_id               bigint REFERENCES users (id) ON DELETE RESTRICT,
  patient_id            bigint REFERENCES patients (id) ON DELETE RESTRICT,
  shop_id               bigint REFERENCES shops (id) ON DELETE RESTRICT,
  owner_id              bigint GENERATED ALWAYS AS (COALESCE(user_id, patient_id, shop_id)) STORED,
  e164                  text        NOT NULL CHECK (e164 ~ '^\+[1-9][0-9]{6,14}$'),   -- P1/P2: stored normalised
  kind                  phone_type  NOT NULL,                                          -- MOBILE | LANDLINE
  label                 phone_label NOT NULL DEFAULT 'MOBILE',
  is_primary            boolean     NOT NULL DEFAULT false,
  status                phone_status NOT NULL DEFAULT 'UNVERIFIED',                    -- UNVERIFIED | VERIFIED | UNREACHABLE
  verified_at           timestamptz,
  verified_by           bigint REFERENCES users (id) ON DELETE RESTRICT,
  consecutive_failures  integer     NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),  -- P13
  last_failure_at       timestamptz,
  unreachable_at        timestamptz,
  is_active             boolean     NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  -- F5.1: exactly one owner, matching owner_type
  CONSTRAINT phone_numbers_one_owner CHECK (
       (owner_type = 'USER'    AND user_id IS NOT NULL AND patient_id IS NULL AND shop_id IS NULL)
    OR (owner_type = 'PATIENT' AND patient_id IS NOT NULL AND user_id IS NULL AND shop_id IS NULL)
    OR (owner_type = 'SHOP'    AND shop_id IS NOT NULL AND user_id IS NULL AND patient_id IS NULL)
  ),
  -- P3: landlines only as HOME, WORK or SHOP
  CONSTRAINT phone_numbers_landline_label CHECK (kind <> 'LANDLINE' OR label IN ('HOME', 'WORK', 'SHOP')),
  CONSTRAINT phone_numbers_kind_check CHECK (kind IN ('MOBILE', 'LANDLINE')),
  -- A verified (or later unreachable) number has a verification time
  CONSTRAINT phone_numbers_verified_check CHECK ((status = 'UNVERIFIED') = (verified_at IS NULL)),
  -- A removed number is never primary
  CONSTRAINT phone_numbers_inactive_not_primary CHECK (is_active OR NOT is_primary)
);

-- P4: the same number only once per owner (compared after normalisation, edge case 4)
CREATE UNIQUE INDEX phone_numbers_owner_e164_key ON phone_numbers (owner_type, owner_id, e164) WHERE is_active;
-- P8/P9: at most one primary per owner
CREATE UNIQUE INDEX phone_numbers_one_primary_key ON phone_numbers (owner_type, owner_id) WHERE is_primary AND is_active;
-- P6: a verified number belongs to only one user (it's a login identity)
CREATE UNIQUE INDEX phone_numbers_user_verified_key ON phone_numbers (e164)
  WHERE owner_type = 'USER' AND status <> 'UNVERIFIED' AND is_active;
-- Lookups: login by phone, patient search by phone, P5 shared-number warning
CREATE INDEX phone_numbers_e164_idx ON phone_numbers (e164) WHERE is_active;
CREATE INDEX phone_numbers_owner_idx ON phone_numbers (owner_type, owner_id) WHERE is_active;

SELECT apply_conventions('phone_numbers');   -- removed numbers are deactivated, not deleted
