-- 022_patient_referral_sms.sql
-- Anushka, Commit 6 (C10): patient messages for accepted referrals.
--
-- One row per accepted referral that has a patient. The sendPatientReferralSms
-- job sends one SMS per (patient, batch_key) once the batch's first row is
-- 10 minutes old, so referrals on one prescription accepted within 10 minutes
-- go out as a single SMS. batch_key is 'rx:<prescription_id>' or, for a request
-- without a prescription, 'req:<request_id>'.
--
-- method SMS: the patient had a usable phone at accept time.
-- method SLIP: no usable phone (or no patient) — the shop prints a slip instead
--              (GET /referrals/:id/slip); nothing is sent.

CREATE TYPE patient_message_method AS ENUM ('SMS', 'SLIP');
CREATE TYPE patient_message_status AS ENUM ('QUEUED', 'SENT', 'SKIPPED', 'SLIP');

CREATE TABLE patient_referral_messages (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  referral_id       bigint                  NOT NULL REFERENCES referrals (id) ON DELETE RESTRICT,
  request_id        bigint                  NOT NULL REFERENCES stock_requests (id) ON DELETE RESTRICT,
  patient_id        bigint                  REFERENCES patients (id) ON DELETE RESTRICT,
  batch_key         text                    NOT NULL CHECK (batch_key ~ '^(rx|req):[0-9]+$'),
  method            patient_message_method  NOT NULL,
  status            patient_message_status  NOT NULL,
  queued_at         timestamptz             NOT NULL DEFAULT now(),
  sent_at           timestamptz,
  notification_ids  jsonb,
  is_active         boolean                 NOT NULL DEFAULT true,
  created_at        timestamptz             NOT NULL DEFAULT now(),
  updated_at        timestamptz             NOT NULL DEFAULT now(),

  CONSTRAINT patient_referral_messages_referral_key UNIQUE (referral_id),
  CONSTRAINT patient_referral_messages_sms_needs_patient CHECK (method <> 'SMS' OR patient_id IS NOT NULL),
  CONSTRAINT patient_referral_messages_method_status CHECK (
    (method = 'SMS' AND status IN ('QUEUED', 'SENT', 'SKIPPED')) OR (method = 'SLIP' AND status = 'SLIP')
  ),
  CONSTRAINT patient_referral_messages_sent_at CHECK ((status = 'SENT') = (sent_at IS NOT NULL))
);
CREATE INDEX patient_referral_messages_queue_idx
  ON patient_referral_messages (patient_id, batch_key, queued_at) WHERE status = 'QUEUED';
SELECT apply_conventions('patient_referral_messages');
