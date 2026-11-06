-- 010_catalog_generics_medicines_batches.sql
-- Rachana, Commit 1 (Nov 4): catalog tables GENERICS, MEDICINES, MEDICINE_BATCHES
-- (requirements B1, B3) and the enums the catalog and stock modules use.
-- Migration numbers 010–019 are claimed for catalog + stock.
--
-- Inventory, stock movements and thresholds land in Commit 3 (Nov 8), once
-- the shops table exists.

-- ---------------------------------------------------------------------------
-- Enums (mirrored in src/shared/enums.js)
-- ---------------------------------------------------------------------------

CREATE TYPE dosage_form AS ENUM (                                               -- B1
  'TABLET', 'CAPSULE', 'SYRUP', 'SUSPENSION', 'INJECTION', 'OINTMENT', 'CREAM',
  'GEL', 'DROPS', 'INHALER', 'POWDER', 'SACHET', 'LOTION', 'SPRAY', 'OTHER'
);

-- The unit stock is counted in. All quantities and MRP are per base unit.
CREATE TYPE base_unit AS ENUM (                                                 -- B1
  'TABLET', 'CAPSULE', 'ML', 'G', 'VIAL', 'AMPOULE', 'SACHET', 'TUBE', 'BOTTLE', 'UNIT'
);

-- Used by STOCK_MOVEMENTS (Commit 3); defined now so the stock.service
-- contract and src/shared/enums.js can refer to it from day one.
CREATE TYPE stock_movement_type AS ENUM (                                       -- B5
  'STOCK_IN', 'DISPENSE', 'RETURN', 'ADJUSTMENT', 'EXPIRY_WRITE_OFF'
);

-- ---------------------------------------------------------------------------
-- GENERICS (B1): salt / molecule, e.g. "Paracetamol"
-- ---------------------------------------------------------------------------
CREATE TABLE generics (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name         text        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  description  text,
  is_active    boolean     NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
-- Case-insensitive unique name ("paracetamol" = "Paracetamol ").
CREATE UNIQUE INDEX generics_name_lower_key ON generics (lower(btrim(name)));
SELECT apply_conventions('generics');

-- ---------------------------------------------------------------------------
-- MEDICINES (B1, B2): a branded product, e.g. "Dolo 650" by Micro Labs
-- ---------------------------------------------------------------------------
CREATE TABLE medicines (
  id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  brand_name             text        NOT NULL CHECK (length(btrim(brand_name)) BETWEEN 1 AND 200),
  generic_id             bigint      NOT NULL REFERENCES generics (id) ON DELETE RESTRICT,
  manufacturer           text        NOT NULL CHECK (length(btrim(manufacturer)) BETWEEN 1 AND 200),
  dosage_form            dosage_form NOT NULL,
  strength               text        NOT NULL CHECK (length(btrim(strength)) BETWEEN 1 AND 50),  -- e.g. '650 mg', '5 mg/5 ml'
  base_unit              base_unit   NOT NULL,
  prescription_required  boolean     NOT NULL DEFAULT true,
  is_active              boolean     NOT NULL DEFAULT true,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
-- Unique on brand + manufacturer + form + strength (case/space-insensitive).
CREATE UNIQUE INDEX medicines_identity_key ON medicines (
  lower(btrim(brand_name)), lower(btrim(manufacturer)), dosage_form,
  lower(regexp_replace(strength, '\s+', '', 'g'))
);
CREATE INDEX medicines_generic_id_idx ON medicines (generic_id);
CREATE INDEX medicines_brand_search_idx ON medicines (lower(brand_name) text_pattern_ops) WHERE is_active;

-- Hard delete is allowed only while a medicine has no batches (B2): the
-- RESTRICT foreign key from medicine_batches refuses it otherwise and the
-- service maps that to 409 MEDICINE_IN_USE. So no delete guard here.
SELECT apply_conventions('medicines', true);

-- ---------------------------------------------------------------------------
-- MEDICINE_BATCHES (B3)
-- ---------------------------------------------------------------------------
CREATE TABLE medicine_batches (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  medicine_id       bigint        NOT NULL,
  batch_no          text          NOT NULL CHECK (length(btrim(batch_no)) BETWEEN 1 AND 50),
  manufacture_date  date,
  expiry_date       date          NOT NULL,
  mrp               numeric(12,2) NOT NULL,              -- INR per base unit
  is_active         boolean       NOT NULL DEFAULT true,
  created_at        timestamptz   NOT NULL DEFAULT now(),
  updated_at        timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT medicine_batches_medicine_id_fkey
    FOREIGN KEY (medicine_id) REFERENCES medicines (id) ON DELETE RESTRICT,
  CONSTRAINT medicine_batches_mrp_positive CHECK (mrp > 0),
  CONSTRAINT medicine_batches_dates_order
    CHECK (manufacture_date IS NULL OR manufacture_date < expiry_date)
);
-- Batch number is unique per medicine (case-insensitive).
CREATE UNIQUE INDEX medicine_batches_medicine_batch_no_key
  ON medicine_batches (medicine_id, upper(btrim(batch_no)));
-- FEFO lookups: earliest expiry first for a medicine.
CREATE INDEX medicine_batches_fefo_idx ON medicine_batches (medicine_id, expiry_date, id);
CREATE INDEX medicine_batches_expiry_idx ON medicine_batches (expiry_date) WHERE is_active;
SELECT apply_conventions('medicine_batches');
