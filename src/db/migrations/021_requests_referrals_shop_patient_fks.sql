-- 021_requests_referrals_shop_patient_fks.sql
-- Anushka: foreign keys promised in 020, now that shops and patients are on
-- main (Izaz, migration 003). prescription_id stays without a foreign key
-- until a prescriptions table exists.
--
-- NOT VALID: rows created before this migration (dev databases used the
-- shop stub with made-up shop ids) are not checked; every new or updated row
-- is. Run `ALTER TABLE ... VALIDATE CONSTRAINT ...` on a clean database if
-- you want the old rows checked too.

ALTER TABLE stock_requests
  ADD CONSTRAINT stock_requests_shop_id_fkey
    FOREIGN KEY (shop_id) REFERENCES shops (id) ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT stock_requests_patient_id_fkey
    FOREIGN KEY (patient_id) REFERENCES patients (id) ON DELETE RESTRICT NOT VALID;

ALTER TABLE referrals
  ADD CONSTRAINT referrals_from_shop_id_fkey
    FOREIGN KEY (from_shop_id) REFERENCES shops (id) ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT referrals_to_shop_id_fkey
    FOREIGN KEY (to_shop_id) REFERENCES shops (id) ON DELETE RESTRICT NOT VALID;

CREATE INDEX stock_requests_patient_idx ON stock_requests (patient_id) WHERE patient_id IS NOT NULL;
