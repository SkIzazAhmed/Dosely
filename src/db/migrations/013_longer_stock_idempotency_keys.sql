-- 013_longer_stock_idempotency_keys.sql
-- Rachana, Commit 7 (Nov 16): callers such as request dispense build the stock
-- idempotency key from the client's Idempotency-Key (up to 255 characters)
-- plus a prefix like 'request:42:dispense:', which could exceed the old
-- 255-character limit on stock_movements.idempotency_key. Allow up to 512.

ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_idempotency_key_check;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_idempotency_key_check
  CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 512);
