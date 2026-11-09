-- 011_inventory_stock_movements.sql
-- Rachana, Commit 3 (Nov 8): INVENTORY (B4) and the STOCK_MOVEMENTS ledger (B5),
-- with the guards that make stock.service the only writer (B6).
--
-- stock_requests / referrals come from migration 020, which runs after this
-- one, so request_id and referral_id are created without foreign keys; a
-- later migration adds them (same approach as migration 020).

-- ---------------------------------------------------------------------------
-- INVENTORY (B4): one row per shop + batch
-- ---------------------------------------------------------------------------
CREATE TABLE inventory (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shop_id     bigint      NOT NULL REFERENCES shops (id) ON DELETE RESTRICT,
  batch_id    bigint      NOT NULL REFERENCES medicine_batches (id) ON DELETE RESTRICT,
  quantity    integer     NOT NULL DEFAULT 0,
  reserved    integer     NOT NULL DEFAULT 0,
  version     integer     NOT NULL DEFAULT 0,                         -- optimistic locking (B9)
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inventory_shop_batch_key UNIQUE (shop_id, batch_id),
  CONSTRAINT inventory_quantity_non_negative CHECK (quantity >= 0),   -- never oversell
  CONSTRAINT inventory_reserved_range CHECK (reserved >= 0 AND reserved <= quantity)
);
CREATE INDEX inventory_batch_idx ON inventory (batch_id);
-- Rows that reach 0 are kept (B4): the delete guard from apply_conventions blocks deletes.
SELECT apply_conventions('inventory');

-- Every change to quantity or reserved bumps version, whoever writes it,
-- so a stale read can always be detected (STALE_INVENTORY, B9).
CREATE OR REPLACE FUNCTION inventory_bump_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.quantity IS DISTINCT FROM OLD.quantity OR NEW.reserved IS DISTINCT FROM OLD.reserved THEN
    NEW.version := OLD.version + 1;
  ELSE
    NEW.version := OLD.version;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER inventory_bump_version
  BEFORE UPDATE ON inventory
  FOR EACH ROW EXECUTE FUNCTION inventory_bump_version();

-- B6: only stock.service may write inventory. It turns this flag on for its own
-- transaction (set_config('dosely.stock_writer', 'on', true)); any other
-- INSERT or UPDATE fails with STOCK_WRITE_FORBIDDEN.
CREATE OR REPLACE FUNCTION inventory_require_stock_service() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(current_setting('dosely.stock_writer', true), '') <> 'on' THEN
    RAISE EXCEPTION 'STOCK_WRITE_FORBIDDEN: inventory can only be changed through stock.service'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER inventory_require_stock_service
  BEFORE INSERT OR UPDATE ON inventory
  FOR EACH ROW EXECUTE FUNCTION inventory_require_stock_service();

-- ---------------------------------------------------------------------------
-- STOCK_MOVEMENTS (B5): append-only ledger, one row per batch per change
-- ---------------------------------------------------------------------------
-- No updated_at / is_active: rows are never changed or deactivated.
CREATE TABLE stock_movements (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type             stock_movement_type NOT NULL,
  shop_id          bigint      NOT NULL REFERENCES shops (id) ON DELETE RESTRICT,
  batch_id         bigint      NOT NULL REFERENCES medicine_batches (id) ON DELETE RESTRICT,
  inventory_id     bigint      NOT NULL REFERENCES inventory (id) ON DELETE RESTRICT,
  delta            integer     NOT NULL,                              -- signed change in base units
  balance_after    integer     NOT NULL,                              -- inventory.quantity after this row
  reason           text        CHECK (reason IS NULL OR length(btrim(reason)) BETWEEN 1 AND 500),
  performed_by     bigint      NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  request_id       bigint,                                            -- stock_requests.id (FK added later)
  referral_id      bigint,                                            -- referrals.id (FK added later)
  idempotency_key  text        CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 255),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stock_movements_balance_non_negative CHECK (balance_after >= 0),
  -- The sign of delta must match the type.
  CONSTRAINT stock_movements_delta_sign CHECK (
    CASE type
      WHEN 'STOCK_IN'         THEN delta > 0
      WHEN 'RETURN'           THEN delta > 0
      WHEN 'DISPENSE'         THEN delta < 0
      WHEN 'EXPIRY_WRITE_OFF' THEN delta < 0
      WHEN 'ADJUSTMENT'       THEN delta <> 0
    END
  ),
  -- B9: adjustments and write-offs need a reason.
  CONSTRAINT stock_movements_reason_required CHECK (
    type NOT IN ('ADJUSTMENT', 'EXPIRY_WRITE_OFF') OR reason IS NOT NULL
  )
);
-- Same idempotency key twice = one change (B8). A dispense across several
-- batches writes one row per batch under the same key, hence batch_id here.
CREATE UNIQUE INDEX stock_movements_idempotency_key
  ON stock_movements (shop_id, type, idempotency_key, batch_id)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX stock_movements_shop_created_idx ON stock_movements (shop_id, created_at DESC);
CREATE INDEX stock_movements_batch_idx ON stock_movements (batch_id, created_at DESC);
CREATE INDEX stock_movements_request_idx ON stock_movements (request_id) WHERE request_id IS NOT NULL;
CREATE INDEX stock_movements_referral_idx ON stock_movements (referral_id) WHERE referral_id IS NOT NULL;

-- Append-only, even for superusers and table owners (who ignore GRANTs).
CREATE OR REPLACE FUNCTION stock_movements_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'LEDGER_APPEND_ONLY: stock_movements rows cannot be changed or deleted'
    USING ERRCODE = 'P0001';
END;
$$;
CREATE TRIGGER stock_movements_append_only
  BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION stock_movements_append_only();
CREATE TRIGGER stock_movements_no_truncate
  BEFORE TRUNCATE ON stock_movements
  FOR EACH STATEMENT EXECUTE FUNCTION stock_movements_append_only();

-- ---------------------------------------------------------------------------
-- Grants (B5): the app role may read and insert movements, never update or delete.
-- The app should connect as a LOGIN role that is a member of dosely_app.
-- Creating the role needs CREATEROLE; without it this only prints a notice
-- (the triggers above still protect the ledger).
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dosely_app') THEN
    BEGIN
      CREATE ROLE dosely_app NOLOGIN;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'dosely_app role not created (no CREATEROLE); grant SELECT, INSERT on stock_movements to the app role by hand';
    END;
  END IF;
END;
$$;

REVOKE UPDATE, DELETE, TRUNCATE ON stock_movements FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dosely_app') THEN
    GRANT SELECT, INSERT ON stock_movements TO dosely_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON stock_movements FROM dosely_app;
    GRANT SELECT, INSERT, UPDATE ON inventory TO dosely_app;
    REVOKE DELETE, TRUNCATE ON inventory FROM dosely_app;
  END IF;
END;
$$;
