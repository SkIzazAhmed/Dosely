-- 012_thresholds_and_stock_alerts.sql
-- Rachana, Commit 6 (Nov 14): STOCK_THRESHOLDS (B11) and the record of alerts
-- already sent, which keeps the expiry and low-stock jobs from repeating
-- themselves (B12, edge case 14).

-- ---------------------------------------------------------------------------
-- STOCK_THRESHOLDS (B11): per shop + medicine reorder level
-- ---------------------------------------------------------------------------
-- A medicine is "low" at a shop when its non-expired, unreserved units are
-- below min_quantity.
CREATE TABLE stock_thresholds (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shop_id       bigint      NOT NULL REFERENCES shops (id) ON DELETE RESTRICT,
  medicine_id   bigint      NOT NULL REFERENCES medicines (id) ON DELETE CASCADE,
  min_quantity  integer     NOT NULL CHECK (min_quantity BETWEEN 1 AND 1000000),
  set_by        bigint      REFERENCES users (id) ON DELETE SET NULL,
  is_active     boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stock_thresholds_shop_medicine_key UNIQUE (shop_id, medicine_id)
);
CREATE INDEX stock_thresholds_medicine_idx ON stock_thresholds (medicine_id);
-- Owners may remove a threshold outright.
SELECT apply_conventions('stock_thresholds', true);

-- ---------------------------------------------------------------------------
-- STOCK_ALERTS (B12): one row per alert actually sent
-- ---------------------------------------------------------------------------
--   LOW_STOCK      once per shop + medicine per day         period_key '2026-11-14'
--   EXPIRY_ALERT   once per shop + batch per week           period_key '2026-W46'
--   BATCH_EXPIRED  once per shop + batch, ever               period_key 'once'
-- The unique index is the guarantee: a second attempt in the same period
-- inserts nothing, so nothing is sent twice even if two jobs overlap.
CREATE TABLE stock_alerts (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  alert_type    text        NOT NULL CHECK (alert_type IN ('LOW_STOCK', 'EXPIRY_ALERT', 'BATCH_EXPIRED')),
  shop_id       bigint      NOT NULL REFERENCES shops (id) ON DELETE RESTRICT,
  medicine_id   bigint      NOT NULL REFERENCES medicines (id) ON DELETE CASCADE,
  batch_id      bigint      REFERENCES medicine_batches (id) ON DELETE CASCADE,
  period_key    text        NOT NULL CHECK (length(period_key) BETWEEN 4 AND 20),
  details       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stock_alerts_batch_needed CHECK (alert_type = 'LOW_STOCK' OR batch_id IS NOT NULL)
);
CREATE UNIQUE INDEX stock_alerts_once_key
  ON stock_alerts (alert_type, shop_id, medicine_id, coalesce(batch_id, 0), period_key);
CREATE INDEX stock_alerts_shop_created_idx ON stock_alerts (shop_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Expired batches are flagged by expiryScan (B12)
-- ---------------------------------------------------------------------------
ALTER TABLE medicine_batches ADD COLUMN expired_flagged_at timestamptz;
