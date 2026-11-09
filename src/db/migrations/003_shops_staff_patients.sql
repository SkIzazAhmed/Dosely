-- 003_shops_staff_patients.sql
-- Izaz, Commit 3 (Nov 8): SHOPS (A6), SHOP_STAFF (A7), PATIENTS (A8).
-- Migration numbers 001–009 are claimed for platform + people.
-- No dependency on 010/020, so it applies cleanly on databases that already ran them.

-- ---------------------------------------------------------------------------
-- SHOPS (A6)
-- ---------------------------------------------------------------------------
CREATE TABLE shops (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name             text          NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 120),
  code             text          NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9-]{2,19}$'),
  drug_licence_no  text          NOT NULL CHECK (length(btrim(drug_licence_no)) BETWEEN 5 AND 60),
  address          text          NOT NULL CHECK (length(btrim(address)) BETWEEN 5 AND 300),
  area             text          NOT NULL CHECK (length(btrim(area)) BETWEEN 2 AND 100),
  city             text,
  pincode          char(6)       NOT NULL CONSTRAINT shops_pincode_check CHECK (pincode ~ '^[1-9][0-9]{5}$'),
  latitude         numeric(9, 6) CHECK (latitude BETWEEN -90 AND 90),
  longitude        numeric(9, 6) CHECK (longitude BETWEEN -180 AND 180),
  is_active        boolean       NOT NULL DEFAULT true,
  created_at       timestamptz   NOT NULL DEFAULT now(),
  updated_at       timestamptz   NOT NULL DEFAULT now(),
  -- latitude and longitude: both or neither
  CONSTRAINT shops_coordinates_check CHECK ((latitude IS NULL) = (longitude IS NULL))
);
CREATE UNIQUE INDEX shops_code_key ON shops (code);
CREATE UNIQUE INDEX shops_drug_licence_key ON shops (upper(btrim(drug_licence_no)));
CREATE INDEX shops_area_idx ON shops (lower(area)) WHERE is_active;
CREATE INDEX shops_pincode_idx ON shops (pincode) WHERE is_active;
SELECT apply_conventions('shops');

-- ---------------------------------------------------------------------------
-- SHOP_STAFF (A7): OWNER or STAFF per shop; removed = is_active false
-- ---------------------------------------------------------------------------
CREATE TABLE shop_staff (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shop_id     bigint      NOT NULL REFERENCES shops (id) ON DELETE RESTRICT,
  user_id     bigint      NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  staff_role  staff_role  NOT NULL DEFAULT 'STAFF',
  added_by    bigint      REFERENCES users (id) ON DELETE RESTRICT,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shop_staff_shop_user_key UNIQUE (shop_id, user_id)
);
CREATE INDEX shop_staff_user_idx ON shop_staff (user_id) WHERE is_active;
CREATE INDEX shop_staff_shop_active_idx ON shop_staff (shop_id) WHERE is_active;
SELECT apply_conventions('shop_staff');

-- Only SHOPKEEPER users can be shop staff.
CREATE OR REPLACE FUNCTION shop_staff_require_shopkeeper() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id AND role = 'SHOPKEEPER') THEN
    RAISE EXCEPTION 'SHOPKEEPER_ROLE_REQUIRED: user % is not a SHOPKEEPER', NEW.user_id USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER shop_staff_require_shopkeeper
  BEFORE INSERT OR UPDATE OF user_id ON shop_staff
  FOR EACH ROW EXECUTE FUNCTION shop_staff_require_shopkeeper();

-- ---------------------------------------------------------------------------
-- PATIENTS (A8): no login; name required, DOB and gender optional
-- ---------------------------------------------------------------------------
CREATE TABLE patients (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  full_name      text        NOT NULL CHECK (length(btrim(full_name)) BETWEEN 1 AND 120),
  date_of_birth  date        CHECK (date_of_birth > DATE '1890-01-01'),
  gender         gender,
  created_by     bigint      REFERENCES users (id) ON DELETE RESTRICT,
  is_active      boolean     NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX patients_name_idx ON patients (lower(full_name)) WHERE is_active;
SELECT apply_conventions('patients');
