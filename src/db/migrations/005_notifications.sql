-- 005_notifications.sql
-- Izaz, Commit 5 (Nov 12): NOTIFICATIONS (A10, F6). One row per channel per
-- person reached: a shop notification fans out to every active staff member.

CREATE TABLE notifications (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recipient_type   notification_recipient_type NOT NULL,   -- what the caller addressed: USER, PATIENT or SHOP
  recipient_id     bigint       NOT NULL,                  -- users.id / patients.id / shops.id
  channel          notification_channel NOT NULL,          -- IN_APP | SMS | EMAIL
  user_id          bigint       REFERENCES users (id) ON DELETE RESTRICT,          -- person reached (null for a patient)
  phone_id         bigint       REFERENCES phone_numbers (id) ON DELETE RESTRICT,  -- SMS destination
  email            text,                                                            -- EMAIL destination
  target_key       text         NOT NULL,                  -- 'user:5' / 'patient:9' — one row per target per channel
  type             text         NOT NULL CHECK (type ~ '^[A-Z][A-Z0-9_]{1,59}$'),  -- e.g. LOW_STOCK, REQUEST_CREATED
  title            text         NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  body             text         NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  data             jsonb        NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key       text         CHECK (dedupe_key IS NULL OR char_length(dedupe_key) BETWEEN 1 AND 200),
  status           notification_status NOT NULL DEFAULT 'PENDING',  -- PENDING | SENT | FAILED | SKIPPED
  skip_reason      text,                                   -- NO_PHONE, NO_VERIFIED_MOBILE, PHONE_UNREACHABLE, NO_EMAIL, USER_INACTIVE
  attempts         integer      NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts     integer      NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 10),
  next_attempt_at  timestamptz,
  last_error       text,
  sent_at          timestamptz,
  read_at          timestamptz,
  created_at       timestamptz  NOT NULL DEFAULT now(),
  updated_at       timestamptz  NOT NULL DEFAULT now(),

  CONSTRAINT notifications_sms_length CHECK (channel <> 'SMS' OR char_length(body) <= 160),          -- A11
  CONSTRAINT notifications_in_app_user CHECK (channel <> 'IN_APP' OR user_id IS NOT NULL),
  CONSTRAINT notifications_read_in_app CHECK (read_at IS NULL OR channel = 'IN_APP'),
  CONSTRAINT notifications_sms_phone CHECK (channel <> 'SMS' OR status = 'SKIPPED' OR phone_id IS NOT NULL),
  CONSTRAINT notifications_email_address CHECK (channel <> 'EMAIL' OR status = 'SKIPPED' OR email IS NOT NULL),
  CONSTRAINT notifications_skip_reason CHECK ((status = 'SKIPPED') = (skip_reason IS NOT NULL)),
  CONSTRAINT notifications_attempts_max CHECK (attempts <= max_attempts)
);

-- Dedupe: the same key never creates a second row for the same target and channel
CREATE UNIQUE INDEX notifications_dedupe_key ON notifications (dedupe_key, channel, target_key) WHERE dedupe_key IS NOT NULL;
-- In-app inbox, newest first; unread count
CREATE INDEX notifications_inbox_idx ON notifications (user_id, id DESC) WHERE channel = 'IN_APP';
CREATE INDEX notifications_unread_idx ON notifications (user_id) WHERE channel = 'IN_APP' AND read_at IS NULL;
-- Delivery queue for SMS / EMAIL (Commit 6)
CREATE INDEX notifications_due_idx ON notifications (next_attempt_at) WHERE status = 'PENDING';

SELECT apply_conventions('notifications');
