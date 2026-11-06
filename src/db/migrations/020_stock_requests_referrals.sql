-- 020_stock_requests_referrals.sql
-- Anushka, Commit 1 (Nov 4): STOCK_REQUESTS and REFERRALS with their enums
-- and checks (C1, C2, C7, C8). Migration numbers 020–029 are claimed for
-- requests + referrals.
--
-- shops, patients and prescriptions don't exist on main yet (shops and
-- patients land in Izaz's Commit 3, Nov 8). Their id columns are created
-- now without a foreign key; a later migration (02x) adds
--   stock_requests.shop_id / patient_id / prescription_id  and
--   referrals.from_shop_id / to_shop_id
-- foreign keys once those tables are on main.

-- ---------------------------------------------------------------------------
-- Enums (mirrored in src/shared/enums.js)
-- ---------------------------------------------------------------------------

CREATE TYPE request_urgency AS ENUM ('ROUTINE', 'URGENT');                       -- C2

CREATE TYPE request_status AS ENUM (                                            -- C4
  'SENT', 'ACKNOWLEDGED', 'PARTIALLY_FULFILLED', 'REFERRED',
  'FULFILLED', 'CLOSED', 'CANCELLED', 'EXPIRED'
);

CREATE TYPE referral_status AS ENUM (                                           -- C8
  'PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED', 'FULFILLED', 'NO_SHOW'
);

-- ---------------------------------------------------------------------------
-- Request numbers REQ-YYYY-NNNNNN (C2): one counter row per year
-- ---------------------------------------------------------------------------
CREATE TABLE request_number_counters (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  year        integer     NOT NULL CHECK (year BETWEEN 2000 AND 9999),
  last_value  integer     NOT NULL DEFAULT 0 CHECK (last_value BETWEEN 0 AND 999999),
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT request_number_counters_year_key UNIQUE (year)
);
SELECT apply_conventions('request_number_counters');

-- Next number for the year of `at` (IST calendar year). Safe under
-- concurrency: the upsert locks the year's row until the caller commits.
CREATE OR REPLACE FUNCTION next_request_no(at timestamptz DEFAULT now())
RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  y integer := extract(year FROM at AT TIME ZONE 'Asia/Kolkata')::integer;
  n integer;
BEGIN
  INSERT INTO request_number_counters (year, last_value) VALUES (y, 1)
  ON CONFLICT (year) DO UPDATE SET last_value = request_number_counters.last_value + 1
  RETURNING last_value INTO n;
  RETURN format('REQ-%s-%s', y, lpad(n::text, 6, '0'));
END;
$$;

-- ---------------------------------------------------------------------------
-- STOCK_REQUESTS (C1–C5): a doctor asks one shop for one medicine
-- ---------------------------------------------------------------------------
CREATE TABLE stock_requests (
  id                      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_no              text            NOT NULL,
  doctor_id               bigint          NOT NULL REFERENCES doctors (id) ON DELETE RESTRICT,
  shop_id                 bigint          NOT NULL,          -- FK to shops added in 02x
  patient_id              bigint,                            -- FK to patients added in 02x
  prescription_id         bigint,                            -- optional (C2); FK added in 02x
  medicine_id             bigint          NOT NULL REFERENCES medicines (id) ON DELETE RESTRICT,
  requested_qty           integer         NOT NULL,
  available_qty_snapshot  integer         NOT NULL,          -- shop's available qty when sent (C1)
  fulfilled_qty           integer         NOT NULL DEFAULT 0,
  urgency                 request_urgency NOT NULL DEFAULT 'ROUTINE',
  status                  request_status  NOT NULL DEFAULT 'SENT',
  doctor_note             text,
  expires_at              timestamptz     NOT NULL,          -- ROUTINE +24 h, URGENT +2 h
  acknowledged_at         timestamptz,
  acknowledged_by         bigint          REFERENCES users (id) ON DELETE RESTRICT,
  fulfilled_at            timestamptz,
  closed_at               timestamptz,
  closed_by               bigint          REFERENCES users (id) ON DELETE RESTRICT,
  close_reason            text,
  cancelled_at            timestamptz,
  cancel_reason           text,
  expired_at              timestamptz,
  is_active               boolean         NOT NULL DEFAULT true,
  created_at              timestamptz     NOT NULL DEFAULT now(),
  updated_at              timestamptz     NOT NULL DEFAULT now(),

  CONSTRAINT stock_requests_request_no_key UNIQUE (request_no),
  CONSTRAINT stock_requests_request_no_format CHECK (request_no ~ '^REQ-[0-9]{4}-[0-9]{6}$'),
  -- C1: quantity 1–10,000, and only sent when the shop is short
  CONSTRAINT stock_requests_requested_qty_range CHECK (requested_qty BETWEEN 1 AND 10000),
  CONSTRAINT stock_requests_snapshot_non_negative CHECK (available_qty_snapshot >= 0),
  CONSTRAINT stock_requests_shop_is_short CHECK (requested_qty > available_qty_snapshot),
  CONSTRAINT stock_requests_doctor_note_length CHECK (doctor_note IS NULL OR length(doctor_note) <= 500),
  CONSTRAINT stock_requests_fulfilled_qty_range CHECK (fulfilled_qty BETWEEN 0 AND requested_qty),
  CONSTRAINT stock_requests_expiry_after_create CHECK (expires_at > created_at),
  -- status ↔ columns
  CONSTRAINT stock_requests_fulfilled_means_full
    CHECK (status <> 'FULFILLED' OR fulfilled_qty = requested_qty),
  CONSTRAINT stock_requests_partial_means_some
    CHECK (status <> 'PARTIALLY_FULFILLED' OR fulfilled_qty BETWEEN 1 AND requested_qty - 1),
  CONSTRAINT stock_requests_closed_needs_reason
    CHECK (status <> 'CLOSED' OR (close_reason IS NOT NULL AND length(btrim(close_reason)) BETWEEN 1 AND 500)),
  CONSTRAINT stock_requests_cancel_reason_length
    CHECK (cancel_reason IS NULL OR length(cancel_reason) <= 500)
);
-- Doctor's list, newest first (C3)
CREATE INDEX stock_requests_doctor_created_idx ON stock_requests (doctor_id, created_at DESC, id DESC);
-- Shop inbox by status (C3)
CREATE INDEX stock_requests_shop_status_idx ON stock_requests (shop_id, status, created_at DESC);
-- Grouping by prescription (C3)
CREATE INDEX stock_requests_prescription_idx ON stock_requests (prescription_id) WHERE prescription_id IS NOT NULL;
-- expireRequests job: SENT past expiry (C11)
CREATE INDEX stock_requests_expiry_idx ON stock_requests (expires_at) WHERE status = 'SENT';
SELECT apply_conventions('stock_requests');

-- ---------------------------------------------------------------------------
-- REFERRALS (C7–C9): send the patient to another shop that has stock
-- ---------------------------------------------------------------------------
CREATE TABLE referrals (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id          bigint          NOT NULL REFERENCES stock_requests (id) ON DELETE RESTRICT,
  from_shop_id        bigint          NOT NULL,              -- origin shop; FK added in 02x
  to_shop_id          bigint          NOT NULL,              -- target shop; FK added in 02x
  quantity            integer         NOT NULL,
  available_qty_seen  integer         NOT NULL,              -- target's available qty at lookup (C7)
  status              referral_status NOT NULL DEFAULT 'PENDING',
  referred_by         bigint          NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  responded_by        bigint          REFERENCES users (id) ON DELETE RESTRICT,
  accepted_at         timestamptz,
  hold_until          timestamptz,                           -- stock held until (default accept + 24 h)
  reservation_lines   jsonb,                                 -- `lines` from stock.reserve
  rejected_at         timestamptz,
  reject_reason       text,
  cancelled_at        timestamptz,
  cancel_reason       text,
  fulfilled_at        timestamptz,
  fulfilled_by        bigint          REFERENCES users (id) ON DELETE RESTRICT,
  no_show_at          timestamptz,
  reminder_sent_at    timestamptz,                           -- PENDING > 2 h reminder to origin (C11)
  is_active           boolean         NOT NULL DEFAULT true,
  created_at          timestamptz     NOT NULL DEFAULT now(),
  updated_at          timestamptz     NOT NULL DEFAULT now(),

  CONSTRAINT referrals_shops_differ CHECK (from_shop_id <> to_shop_id),
  CONSTRAINT referrals_quantity_range CHECK (quantity BETWEEN 1 AND 10000),
  CONSTRAINT referrals_seen_covers_quantity CHECK (available_qty_seen >= quantity),
  CONSTRAINT referrals_rejected_needs_reason
    CHECK (status <> 'REJECTED' OR (reject_reason IS NOT NULL AND length(btrim(reject_reason)) BETWEEN 1 AND 500)),
  CONSTRAINT referrals_accepted_has_hold
    CHECK (status <> 'ACCEPTED' OR (accepted_at IS NOT NULL AND hold_until IS NOT NULL AND hold_until > accepted_at)),
  CONSTRAINT referrals_cancel_reason_length
    CHECK (cancel_reason IS NULL OR length(cancel_reason) <= 500)
);
-- C7: no duplicate live referral to one shop
CREATE UNIQUE INDEX referrals_live_target_key
  ON referrals (request_id, to_shop_id) WHERE status IN ('PENDING', 'ACCEPTED');
CREATE INDEX referrals_request_idx ON referrals (request_id);
-- Target shop's referral inbox
CREATE INDEX referrals_to_shop_status_idx ON referrals (to_shop_id, status, created_at DESC);
-- expireReferralHolds job (C11)
CREATE INDEX referrals_hold_expiry_idx ON referrals (hold_until) WHERE status = 'ACCEPTED';
-- 2-hour PENDING reminder (C11)
CREATE INDEX referrals_pending_idx ON referrals (created_at) WHERE status = 'PENDING' AND reminder_sent_at IS NULL;
SELECT apply_conventions('referrals');

-- C7: at most 3 referrals per request, and live referred quantity
-- (PENDING + ACCEPTED) must not exceed what is still unfulfilled.
-- The parent request row is locked so two concurrent referrals can't both pass.
CREATE OR REPLACE FUNCTION referrals_enforce_limits() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  req        stock_requests%ROWTYPE;
  n_total    integer;
  live_qty   integer;
BEGIN
  SELECT * INTO req FROM stock_requests WHERE id = NEW.request_id FOR UPDATE;

  IF TG_OP = 'INSERT' THEN
    SELECT count(*) INTO n_total FROM referrals WHERE request_id = NEW.request_id;
    IF n_total >= 3 THEN
      RAISE EXCEPTION 'REFERRAL_LIMIT_REACHED: request % already has 3 referrals', NEW.request_id
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF NEW.status IN ('PENDING', 'ACCEPTED') THEN
    SELECT coalesce(sum(quantity), 0) INTO live_qty
      FROM referrals
     WHERE request_id = NEW.request_id
       AND status IN ('PENDING', 'ACCEPTED')
       AND id IS DISTINCT FROM NEW.id;
    IF live_qty + NEW.quantity > req.requested_qty - req.fulfilled_qty THEN
      RAISE EXCEPTION 'REFERRAL_QTY_EXCEEDED: live referred % + % > unfulfilled %',
        live_qty, NEW.quantity, req.requested_qty - req.fulfilled_qty
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
CREATE TRIGGER referrals_enforce_limits
  BEFORE INSERT OR UPDATE OF quantity, status ON referrals
  FOR EACH ROW EXECUTE FUNCTION referrals_enforce_limits();
