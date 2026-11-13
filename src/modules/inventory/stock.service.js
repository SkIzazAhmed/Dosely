'use strict';

/**
 * stock.service — the ONLY code allowed to change stock (B6).
 *
 * Every write runs in one transaction that changes INVENTORY and appends a
 * STOCK_MOVEMENTS row; the database refuses inventory writes from anywhere
 * else (trigger inventory_require_stock_service) and refuses any change to
 * the ledger (stock_movements_append_only).
 *
 * Signatures are final — see README "stock.service contract". All functions
 * are real: stockIn, getAvailable, reserve, release (Nov 8); dispense,
 * adjust, writeOff (Nov 10).
 *
 * Every function takes an optional last argument `opts = { client }`: pass
 * your transaction client and the stock change joins your transaction
 * (SAVEPOINT), so it commits or rolls back together with your rows.
 */

const { query } = require('../../db/pool');
const { withTransaction } = require('../../db/transaction');
const { AppError, fromPgError } = require('../../shared/errors');
const medicines = require('../medicines/medicine.service');
const batches = require('../medicines/batch.service');
const inventoryModel = require('./inventory.model');
const movementModel = require('./movement.model');
const alerts = require('./alert.service');

const MAX_QTY = 1000000;

function checkId(v, field, errors, { required = true } = {}) {
  if (v === undefined || v === null) {
    if (required) errors.push({ field, issue: 'required' });
  } else if (!Number.isInteger(v) || v <= 0) {
    errors.push({ field, issue: 'must be a positive integer' });
  }
}

function checkText(v, field, errors, max) {
  if (v === undefined || v === null) return;
  if (typeof v !== 'string' || v.trim() === '' || v.length > max) {
    errors.push({ field, issue: `must be a non-empty string of at most ${max} characters` });
  }
}

function mapPgError(err) {
  if (err && err.code === 'P0001' && String(err.message).startsWith('STOCK_WRITE_FORBIDDEN')) {
    return new AppError('INTERNAL_ERROR', 'Inventory can only be changed through stock.service');
  }
  return fromPgError(err, {
    inventory_quantity_non_negative: 'INSUFFICIENT_STOCK',
    inventory_reserved_range: 'INSUFFICIENT_STOCK',
  });
}

/**
 * Throws NOT_FOUND / SHOP_INACTIVE unless the shop exists and is active.
 * FOR SHARE keeps it from being deactivated until this transaction ends.
 */
async function assertShopActive(shopId, client) {
  const { rows } = await client.query('SELECT is_active FROM shops WHERE id = $1 FOR SHARE', [shopId]);
  if (!rows[0]) throw AppError.notFound('Shop', shopId);
  if (!rows[0].is_active) throw new AppError('SHOP_INACTIVE', 'Shop is inactive and cannot receive stock', { shopId });
}

// ---------------------------------------------------------------------------
// stockIn (B4, B5, B7)
// ---------------------------------------------------------------------------

function validateStockIn(input) {
  if (!input || typeof input !== 'object') throw AppError.validation([{ field: 'input', issue: 'required' }]);
  const errors = [];
  checkId(input.shopId, 'shopId', errors);
  checkId(input.medicineId, 'medicineId', errors);
  checkId(input.performedBy, 'performedBy', errors);
  if (input.quantity === undefined || input.quantity === null) errors.push({ field: 'quantity', issue: 'required' });
  else if (!Number.isInteger(input.quantity) || input.quantity <= 0 || input.quantity > MAX_QTY) {
    errors.push({ field: 'quantity', issue: `must be an integer from 1 to ${MAX_QTY}` });
  }
  checkText(input.reason, 'reason', errors, 500);
  checkText(input.idempotencyKey, 'idempotencyKey', errors, 255);

  let batch = null;
  try {
    batch = batches.validateBatch(input);
  } catch (e) {
    errors.push(...(e.details || []));
  }
  if (errors.length) throw AppError.validation(errors);
  return batch;
}

/** Rebuild the result of an earlier stock-in with the same key, or null if there was none. */
async function replayStockIn(input, b, client) {
  const [m] = await movementModel.findByIdempotencyKey(input.shopId, 'STOCK_IN', input.idempotencyKey, { client });
  if (!m) return null;
  const batch = await batches.getById(m.batchId, { client });
  if (batch.medicineId !== input.medicineId || batch.batchNo !== b.batchNo || m.delta !== input.quantity) {
    throw new AppError('IDEMPOTENCY_KEY_REUSED', 'This idempotency key was already used for a different stock-in', {
      movementId: m.id,
    });
  }
  const inventory = await inventoryModel.getByShopBatch(input.shopId, m.batchId, { client });
  return { batch, inventory, movement: m, replayed: true };
}

/**
 * Receive stock into a shop (STOCK_IN). Creates the batch if its number is new
 * for the medicine, reuses it if expiry and MRP match, otherwise 409 BATCH_MISMATCH.
 *
 * @param {Object} input
 * @param {number} input.shopId            must exist and be active (else 404 / 409 SHOP_INACTIVE)
 * @param {number} input.medicineId        must exist and be active (else 404 / 409 MEDICINE_INACTIVE)
 * @param {string} input.batchNo
 * @param {string} input.expiryDate        'YYYY-MM-DD'; today or earlier → 422 BATCH_EXPIRED
 * @param {string} [input.manufactureDate] 'YYYY-MM-DD', before expiryDate
 * @param {number} input.mrp               INR per base unit, > 0
 * @param {number} input.quantity          base units, 1–1,000,000
 * @param {number} input.performedBy       users.id
 * @param {string} [input.reason]
 * @param {string} [input.idempotencyKey]  same key again → the first result, replayed: true
 * @param {{client?: import('pg').PoolClient}} [opts]
 * @returns {Promise<{batch: Object, batchCreated: boolean, inventory: Object, movement: Object, replayed: boolean}>}
 */
async function stockIn(input, opts = {}) {
  const b = validateStockIn(input);
  const key = input.idempotencyKey || null;

  if (key) {
    const prev = await replayStockIn(input, b, opts.client);
    if (prev) return { ...prev, batchCreated: false };
  }

  try {
    return await withTransaction(async (client) => {
      await assertShopActive(input.shopId, client);
      await medicines.assertActive(input.medicineId, { client });
      if (await batches.isExpiredDate(b.expiryDate, client)) {
        throw new AppError('BATCH_EXPIRED', undefined, { batchNo: b.batchNo, expiryDate: b.expiryDate });
      }
      const { batch, created } = await batches.findOrCreateForStockIn(input.medicineId, b, { client });

      await inventoryModel.enableStockWrites(client);
      const inventory = await inventoryModel.addQuantity(input.shopId, batch.id, input.quantity, { client });
      const movement = await movementModel.insert({
        type: 'STOCK_IN',
        shopId: input.shopId,
        batchId: batch.id,
        inventoryId: inventory.id,
        delta: input.quantity,
        balanceAfter: inventory.quantity,
        reason: input.reason ? input.reason.trim() : null,
        performedBy: input.performedBy,
        idempotencyKey: key,
      }, { client });
      await inventoryModel.disableStockWrites(client);

      return { batch, batchCreated: created, inventory, movement, replayed: false };
    }, { client: opts.client });
  } catch (err) {
    // Two requests with the same key at the same moment: the loser replays the winner.
    if (key && err.code === '23505' && err.constraint === 'stock_movements_idempotency_key') {
      const prev = await replayStockIn(input, b, opts.client);
      if (prev) return { ...prev, batchCreated: false };
    }
    throw err instanceof AppError ? err : mapPgError(err);
  }
}

// ---------------------------------------------------------------------------
// reserve / release (holds for accepted referrals)
// ---------------------------------------------------------------------------

function checkLines(lines, errors) {
  if (!Array.isArray(lines) || lines.length === 0 || lines.length > 100 ||
      lines.some((l) => !l || !Number.isInteger(l.batchId) || l.batchId <= 0 || !Number.isInteger(l.quantity) || l.quantity <= 0)) {
    errors.push({ field: 'lines', issue: 'must be a non-empty array of { batchId, quantity }' });
  }
}

/**
 * Hold stock for an accepted referral: `reserved` goes up, `quantity` stays the
 * same and no movement row is written (nothing has left the shop yet).
 * Picks non-expired batches earliest-expiry first (FEFO), possibly several.
 * Rows are locked in batch_id order, the same order dispense uses, so the two
 * can't deadlock; two referrals racing for the last units → one gets 409.
 *
 * Call it once per referral (Anushka's accept does it inside the PENDING →
 * ACCEPTED transition, which locks the referral). Store the returned `lines`;
 * pass them to release() or dispense({ reservation }).
 *
 * @param {{shopId:number, medicineId:number, quantity:number, referralId:number, performedBy:number}} input
 * @param {{client?: import('pg').PoolClient}} [opts]
 * @returns {Promise<{shopId:number, medicineId:number, referralId:number,
 *           lines: Array<{batchId:number, batchNo:string, expiryDate:string, quantity:number}>, replayed:false}>}
 * @throws INSUFFICIENT_STOCK (409, details.available), SHOP_INACTIVE, NOT_FOUND
 */
async function reserve(input, opts = {}) {
  if (!input || typeof input !== 'object') throw AppError.validation([{ field: 'input', issue: 'required' }]);
  const errors = [];
  checkId(input.shopId, 'shopId', errors);
  checkId(input.medicineId, 'medicineId', errors);
  checkId(input.referralId, 'referralId', errors);
  checkId(input.performedBy, 'performedBy', errors);
  if (!Number.isInteger(input.quantity) || input.quantity <= 0 || input.quantity > MAX_QTY) {
    errors.push({ field: 'quantity', issue: `must be an integer from 1 to ${MAX_QTY}` });
  }
  if (errors.length) throw AppError.validation(errors);

  try {
    return await withTransaction(async (client) => {
      await assertShopActive(input.shopId, client);
      // Lock every sellable row of this medicine at the shop, in batch_id order.
      const { rows } = await client.query(
        `SELECT i.id, i.batch_id, i.quantity - i.reserved AS free, b.batch_no, b.expiry_date::text AS expiry_date
           FROM inventory i
           JOIN medicine_batches b ON b.id = i.batch_id
          WHERE i.shop_id = $1 AND b.medicine_id = $2
            AND b.expiry_date > ${batches.TODAY_SQL} AND b.is_active AND i.is_active
          ORDER BY i.batch_id
          FOR UPDATE OF i`,
        [input.shopId, input.medicineId]
      );
      const fefo = rows
        .filter((r) => r.free > 0)
        .sort((a, b) => (a.expiry_date < b.expiry_date ? -1 : a.expiry_date > b.expiry_date ? 1 : a.batch_id - b.batch_id));
      const available = fefo.reduce((n, r) => n + r.free, 0);
      if (available < input.quantity) {
        throw new AppError('INSUFFICIENT_STOCK', undefined, {
          shopId: input.shopId, medicineId: input.medicineId, requested: input.quantity, available,
        });
      }

      const plan = [];
      let left = input.quantity;
      for (const r of fefo) {
        if (left === 0) break;
        const qty = Math.min(left, r.free);
        plan.push({ r, qty });
        left -= qty;
      }

      await inventoryModel.enableStockWrites(client);
      for (const { r, qty } of [...plan].sort((a, b) => a.r.batch_id - b.r.batch_id)) {
        await client.query('UPDATE inventory SET reserved = reserved + $2 WHERE id = $1', [r.id, qty]);
      }
      await inventoryModel.disableStockWrites(client);

      return {
        shopId: input.shopId,
        medicineId: input.medicineId,
        referralId: input.referralId,
        lines: plan.map(({ r, qty }) => ({ batchId: r.batch_id, batchNo: r.batch_no, expiryDate: r.expiry_date, quantity: qty })),
        replayed: false,
      };
    }, { client: opts.client });
  } catch (err) {
    throw err instanceof AppError ? err : mapPgError(err);
  }
}

/**
 * Give back held stock (referral rejected, cancelled or no-show).
 * Releases at most what is still reserved on each batch, so calling it twice
 * never drives `reserved` below 0. No movement row (quantity doesn't change).
 *
 * @param {{shopId:number, referralId:number, lines:Array<{batchId:number, quantity:number}>, performedBy:number}} input
 * @param {{client?: import('pg').PoolClient}} [opts]
 * @returns {Promise<{shopId:number, referralId:number, released:number}>}  units released
 */
async function release(input, opts = {}) {
  if (!input || typeof input !== 'object') throw AppError.validation([{ field: 'input', issue: 'required' }]);
  const errors = [];
  checkId(input.shopId, 'shopId', errors);
  checkId(input.referralId, 'referralId', errors);
  checkLines(input.lines, errors);
  checkId(input.performedBy, 'performedBy', errors);
  if (errors.length) throw AppError.validation(errors);

  try {
    return await withTransaction(async (client) => {
      await inventoryModel.enableStockWrites(client);
      let released = 0;
      for (const l of [...input.lines].sort((a, b) => a.batchId - b.batchId)) {
        const { rows } = await client.query(
          `WITH cur AS (
             SELECT id, reserved FROM inventory WHERE shop_id = $1 AND batch_id = $2 FOR UPDATE
           )
           UPDATE inventory i SET reserved = i.reserved - LEAST(cur.reserved, $3)
             FROM cur
            WHERE i.id = cur.id AND cur.reserved > 0
           RETURNING LEAST(cur.reserved, $3) AS released`,
          [input.shopId, l.batchId, l.quantity]
        );
        if (rows[0]) released += rows[0].released;
      }
      await inventoryModel.disableStockWrites(client);
      return { shopId: input.shopId, referralId: input.referralId, released };
    }, { client: opts.client });
  } catch (err) {
    throw err instanceof AppError ? err : mapPgError(err);
  }
}

// ---------------------------------------------------------------------------
// shared helpers for dispense / adjust / writeOff
// ---------------------------------------------------------------------------

function requireReason(reason) {
  if (typeof reason !== 'string' || reason.trim().length < 3 || reason.length > 500) {
    throw new AppError('REASON_REQUIRED', 'A reason of 3–500 characters is required for this stock change');
  }
  return reason.trim();
}

const isIdemConflict = (err) => err && err.code === '23505' && err.constraint === 'stock_movements_idempotency_key';

/** Lock one shop + batch inventory row (with its batch) for an owner edit. */
async function lockRow(shopId, batchId, client) {
  const { rows } = await client.query(
    `SELECT i.id, i.shop_id, i.batch_id, i.quantity, i.reserved, i.version,
            b.medicine_id, b.batch_no, b.expiry_date::text AS expiry_date
       FROM inventory i
       JOIN medicine_batches b ON b.id = i.batch_id
      WHERE i.shop_id = $1 AND i.batch_id = $2
      FOR UPDATE OF i`,
    [shopId, batchId]
  );
  if (!rows[0]) throw AppError.notFound('Inventory', { shopId, batchId });
  return rows[0];
}

/** Single-row change (ADJUSTMENT / EXPIRY_WRITE_OFF): update quantity, append movement. */
async function applyRowChange(row, type, delta, input, reason, client) {
  await inventoryModel.enableStockWrites(client);
  const { rows: [inv] } = await client.query(
    'UPDATE inventory SET quantity = quantity + $2 WHERE id = $1 RETURNING *',
    [row.id, delta]
  );
  const movement = await movementModel.insert({
    type,
    shopId: row.shop_id,
    batchId: row.batch_id,
    inventoryId: row.id,
    delta,
    balanceAfter: inv.quantity,
    reason,
    performedBy: input.performedBy,
    idempotencyKey: input.idempotencyKey || null,
  }, { client });
  await inventoryModel.disableStockWrites(client);
  return { inventory: inventoryModel.toPublic(inv), movement };
}

/** Earlier single-row change under the same key, or null. Same key for a different change → 422. */
async function replayRowChange(input, type, matches, client) {
  if (!input.idempotencyKey) return null;
  const [m] = await movementModel.findByIdempotencyKey(input.shopId, type, input.idempotencyKey, { client });
  if (!m) return null;
  if (!matches(m)) {
    throw new AppError('IDEMPOTENCY_KEY_REUSED', 'This idempotency key was already used for a different stock change', {
      movementId: m.id,
    });
  }
  const inventory = await inventoryModel.getByShopBatch(input.shopId, m.batchId, { client });
  return { inventory, movement: m, replayed: true };
}

// ---------------------------------------------------------------------------
// dispense (B8)
// ---------------------------------------------------------------------------

function validateDispense(input) {
  if (!input || typeof input !== 'object') throw AppError.validation([{ field: 'input', issue: 'required' }]);
  const errors = [];
  checkId(input.shopId, 'shopId', errors);
  checkId(input.medicineId, 'medicineId', errors);
  checkId(input.performedBy, 'performedBy', errors);
  if (input.quantity === undefined || input.quantity === null) errors.push({ field: 'quantity', issue: 'required' });
  else if (!Number.isInteger(input.quantity) || input.quantity <= 0 || input.quantity > MAX_QTY) {
    errors.push({ field: 'quantity', issue: `must be an integer from 1 to ${MAX_QTY}` });
  }
  if (input.idempotencyKey === undefined || input.idempotencyKey === null || input.idempotencyKey === '') {
    errors.push({ field: 'idempotencyKey', issue: 'required' });
  } else {
    checkText(input.idempotencyKey, 'idempotencyKey', errors, 255);
  }
  checkId(input.requestId, 'requestId', errors, { required: false });
  checkId(input.referralId, 'referralId', errors, { required: false });
  checkText(input.reason, 'reason', errors, 500);
  if (input.reservation !== undefined && input.reservation !== null) {
    const before = errors.length;
    checkLines(input.reservation, errors);
    if (errors.length > before) errors[errors.length - 1].field = 'reservation';
    else if (input.reservation.reduce((n, l) => n + l.quantity, 0) !== input.quantity) {
      errors.push({ field: 'reservation', issue: 'line quantities must add up to quantity' });
    } else if (new Set(input.reservation.map((l) => l.batchId)).size !== input.reservation.length) {
      errors.push({ field: 'reservation', issue: 'each batch may appear once' });
    }
  }
  if (errors.length) throw AppError.validation(errors);
}

function dispenseResult(input, lines, replayed) {
  return {
    shopId: input.shopId,
    medicineId: input.medicineId,
    quantity: input.quantity,
    lines: [...lines].sort((a, b) => (a.expiryDate < b.expiryDate ? -1 : a.expiryDate > b.expiryDate ? 1 : a.batchId - b.batchId)),
    replayed,
  };
}

async function replayDispense(input, client) {
  const rows = await movementModel.findByIdempotencyKey(input.shopId, 'DISPENSE', input.idempotencyKey, { client });
  if (rows.length === 0) return null;
  const lines = [];
  for (const m of rows) {
    const b = await batches.getById(m.batchId, { client });
    lines.push({ batchId: b.id, batchNo: b.batchNo, expiryDate: b.expiryDate, quantity: -m.delta, movementId: m.id, balanceAfter: m.balanceAfter, medicineId: b.medicineId });
  }
  const total = lines.reduce((n, l) => n + l.quantity, 0);
  if (total !== input.quantity || lines.some((l) => l.medicineId !== input.medicineId)) {
    throw new AppError('IDEMPOTENCY_KEY_REUSED', 'This idempotency key was already used for a different dispense', {
      movementIds: rows.map((r) => r.id),
    });
  }
  return dispenseResult(input, lines.map(({ medicineId, ...l }) => l), true); // eslint-disable-line no-unused-vars
}

/**
 * Dispense a medicine from a shop (DISPENSE, B8).
 *
 * Without `reservation`: takes non-expired, unreserved units earliest-expiry
 * first (FEFO), across several batches if needed. With `reservation` (the
 * `lines` reserve() returned): dispenses exactly those held units and clears
 * the hold, e.g. when a referred patient picks up.
 *
 * Never oversells: rows are locked in batch_id order (no deadlocks between
 * multi-batch dispenses) and every update is conditional on enough stock, so
 * when two dispenses race for the last units one wins and the other gets
 * 409 INSUFFICIENT_STOCK. The same idempotency key never dispenses twice.
 *
 * @param {Object} input
 * @param {number} input.shopId
 * @param {number} input.medicineId
 * @param {number} input.quantity          base units, 1–1,000,000
 * @param {number} input.performedBy       users.id
 * @param {string} input.idempotencyKey    REQUIRED
 * @param {number} [input.requestId]
 * @param {number} [input.referralId]
 * @param {Array<{batchId:number, quantity:number}>} [input.reservation]  must add up to quantity
 * @param {string} [input.reason]
 * @param {{client?: import('pg').PoolClient}} [opts]
 * @returns {Promise<{shopId:number, medicineId:number, quantity:number, replayed:boolean,
 *           lines: Array<{batchId:number, batchNo:string, expiryDate:string, quantity:number, movementId:number, balanceAfter:number}>}>}
 * @throws INSUFFICIENT_STOCK (409, details.available), SHOP_INACTIVE, IDEMPOTENCY_KEY_REUSED, VALIDATION_ERROR
 */
async function dispense(input, opts = {}) {
  validateDispense(input);
  const prev = await replayDispense(input, opts.client);
  if (prev) return prev;

  try {
    return await withTransaction(async (client) => {
      await assertShopActive(input.shopId, client);

      let plan;
      if (input.reservation) {
        const ids = input.reservation.map((l) => l.batchId);
        const { rows } = await client.query(
          `SELECT i.id, i.batch_id, i.quantity, i.reserved, b.medicine_id, b.batch_no,
                  b.expiry_date::text AS expiry_date, (b.expiry_date <= ${batches.TODAY_SQL}) AS expired
             FROM inventory i
             JOIN medicine_batches b ON b.id = i.batch_id
            WHERE i.shop_id = $1 AND i.batch_id = ANY($2::bigint[])
            ORDER BY i.batch_id
            FOR UPDATE OF i`,
          [input.shopId, ids]
        );
        // A racing request with the same key may have committed while we waited for the locks.
        const prior = await replayDispense(input, client);
        if (prior) return prior;
        const byBatch = new Map(rows.map((r) => [Number(r.batch_id), r]));
        plan = input.reservation.map((l) => {
          const r = byBatch.get(l.batchId);
          if (!r || r.medicine_id !== input.medicineId || r.expired || r.reserved < l.quantity) {
            throw new AppError('INSUFFICIENT_STOCK', 'Reserved stock is no longer available', {
              batchId: l.batchId, reserved: r ? r.reserved : 0, requested: l.quantity, expired: r ? r.expired : undefined,
            });
          }
          return { r, qty: l.quantity, fromReserved: true };
        });
      } else {
        // Lock every sellable row of the medicine at this shop, in batch_id order.
        const { rows } = await client.query(
          `SELECT i.id, i.batch_id, i.quantity, i.reserved, b.batch_no, b.expiry_date::text AS expiry_date
             FROM inventory i
             JOIN medicine_batches b ON b.id = i.batch_id
            WHERE i.shop_id = $1 AND b.medicine_id = $2
              AND b.expiry_date > ${batches.TODAY_SQL} AND b.is_active AND i.is_active
            ORDER BY i.batch_id
            FOR UPDATE OF i`,
          [input.shopId, input.medicineId]
        );
        // A racing request with the same key may have committed while we waited for the locks.
        const prior = await replayDispense(input, client);
        if (prior) return prior;
        const fefo = rows
          .filter((r) => r.quantity - r.reserved > 0)
          .sort((a, b) => (a.expiry_date < b.expiry_date ? -1 : a.expiry_date > b.expiry_date ? 1 : a.batch_id - b.batch_id));
        const available = fefo.reduce((n, r) => n + r.quantity - r.reserved, 0);
        if (available < input.quantity) {
          throw new AppError('INSUFFICIENT_STOCK', undefined, {
            shopId: input.shopId, medicineId: input.medicineId, requested: input.quantity, available,
          });
        }
        plan = [];
        let left = input.quantity;
        for (const r of fefo) {
          if (left === 0) break;
          const qty = Math.min(left, r.quantity - r.reserved);
          plan.push({ r, qty, fromReserved: false });
          left -= qty;
        }
      }

      await inventoryModel.enableStockWrites(client);
      const lines = [];
      for (const { r, qty, fromReserved } of [...plan].sort((a, b) => a.r.batch_id - b.r.batch_id)) {
        // Atomic conditional update: only succeeds if the stock is still there.
        const { rows: [inv] } = fromReserved
          ? await client.query(
            `UPDATE inventory SET quantity = quantity - $2, reserved = reserved - $2
              WHERE id = $1 AND reserved >= $2 RETURNING quantity`,
            [r.id, qty]
          )
          : await client.query(
            `UPDATE inventory SET quantity = quantity - $2
              WHERE id = $1 AND quantity - reserved >= $2 RETURNING quantity`,
            [r.id, qty]
          );
        if (!inv) throw new AppError('INSUFFICIENT_STOCK', undefined, { batchId: r.batch_id, requested: qty });
        const m = await movementModel.insert({
          type: 'DISPENSE',
          shopId: input.shopId,
          batchId: r.batch_id,
          inventoryId: r.id,
          delta: -qty,
          balanceAfter: inv.quantity,
          reason: input.reason ? input.reason.trim() : null,
          performedBy: input.performedBy,
          requestId: input.requestId ?? null,
          referralId: input.referralId ?? null,
          idempotencyKey: input.idempotencyKey,
        }, { client });
        lines.push({
          batchId: Number(r.batch_id), batchNo: r.batch_no, expiryDate: r.expiry_date,
          quantity: qty, movementId: m.id, balanceAfter: inv.quantity,
        });
      }
      await inventoryModel.disableStockWrites(client);
      await afterDispense(input, client);
      return dispenseResult(input, lines, false);
    }, { client: opts.client });
  } catch (err) {
    if (isIdemConflict(err)) {
      const again = await replayDispense(input, opts.client);
      if (again) return again;
    }
    throw err instanceof AppError ? err : mapPgError(err);
  }
}

/**
 * Post-dispense low-stock check (B12), inside the dispense transaction: if the
 * medicine just fell below the shop's threshold, alert the shop — at most
 * once per shop + medicine per day (edge case 14).
 */
async function afterDispense(input, client) {
  await alerts.checkLowStock(input.shopId, input.medicineId, { client });
}

// ---------------------------------------------------------------------------
// adjust / writeOff (B9) — OWNER only, enforced by the routes
// ---------------------------------------------------------------------------

/**
 * Manual correction after a recount (ADJUSTMENT). Send the inventory
 * `version` you read: if the row changed since, 409 STALE_INVENTORY.
 * The result can't go below the reserved units (or 0).
 *
 * @param {{shopId:number, batchId:number, delta:number, expectedVersion:number, reason:string,
 *          performedBy:number, idempotencyKey?:string}} input
 * @param {{client?: import('pg').PoolClient}} [opts]
 * @returns {Promise<{inventory:Object, movement:Object, replayed:boolean}>}
 * @throws STALE_INVENTORY, INSUFFICIENT_STOCK, REASON_REQUIRED, NOT_FOUND
 */
async function adjust(input, opts = {}) {
  if (!input || typeof input !== 'object') throw AppError.validation([{ field: 'input', issue: 'required' }]);
  const errors = [];
  checkId(input.shopId, 'shopId', errors);
  checkId(input.batchId, 'batchId', errors);
  checkId(input.performedBy, 'performedBy', errors);
  if (!Number.isInteger(input.delta) || input.delta === 0 || Math.abs(input.delta) > MAX_QTY) {
    errors.push({ field: 'delta', issue: `must be a non-zero integer between -${MAX_QTY} and ${MAX_QTY}` });
  }
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) {
    errors.push({ field: 'expectedVersion', issue: 'required: the inventory version you read' });
  }
  checkText(input.idempotencyKey, 'idempotencyKey', errors, 255);
  if (errors.length) throw AppError.validation(errors);
  const reason = requireReason(input.reason);

  const matches = (m) => m.batchId === input.batchId && m.delta === input.delta;
  const prev = await replayRowChange(input, 'ADJUSTMENT', matches, opts.client);
  if (prev) return prev;

  try {
    return await withTransaction(async (client) => {
      const row = await lockRow(input.shopId, input.batchId, client);
      const prior = await replayRowChange(input, 'ADJUSTMENT', matches, client);
      if (prior) return prior;
      if (row.version !== input.expectedVersion) {
        throw new AppError('STALE_INVENTORY', undefined, {
          expectedVersion: input.expectedVersion, currentVersion: row.version, quantity: row.quantity, reserved: row.reserved,
        });
      }
      if (row.quantity + input.delta < row.reserved) {
        throw new AppError('INSUFFICIENT_STOCK', 'Adjustment would leave less than the reserved units', {
          quantity: row.quantity, reserved: row.reserved, delta: input.delta,
        });
      }
      const r = await applyRowChange(row, 'ADJUSTMENT', input.delta, input, reason, client);
      return { ...r, replayed: false };
    }, { client: opts.client });
  } catch (err) {
    if (isIdemConflict(err)) {
      const again = await replayRowChange(input, 'ADJUSTMENT', matches, opts.client);
      if (again) return again;
    }
    throw err instanceof AppError ? err : mapPgError(err);
  }
}

/**
 * Write off expired or damaged stock (EXPIRY_WRITE_OFF). Reserved units can't
 * be written off; release them first. `expectedVersion` is optional here.
 *
 * @param {{shopId:number, batchId:number, quantity?:number, expectedVersion?:number, reason:string,
 *          performedBy:number, idempotencyKey?:string}} input   quantity defaults to all unreserved units
 * @param {{client?: import('pg').PoolClient}} [opts]
 * @returns {Promise<{inventory:Object, movement:Object, replayed:boolean}>}
 * @throws STALE_INVENTORY, INSUFFICIENT_STOCK, REASON_REQUIRED, NOT_FOUND
 */
async function writeOff(input, opts = {}) {
  if (!input || typeof input !== 'object') throw AppError.validation([{ field: 'input', issue: 'required' }]);
  const errors = [];
  checkId(input.shopId, 'shopId', errors);
  checkId(input.batchId, 'batchId', errors);
  checkId(input.performedBy, 'performedBy', errors);
  if (input.quantity !== undefined && input.quantity !== null &&
      (!Number.isInteger(input.quantity) || input.quantity <= 0 || input.quantity > MAX_QTY)) {
    errors.push({ field: 'quantity', issue: `must be an integer from 1 to ${MAX_QTY}` });
  }
  if (input.expectedVersion !== undefined && input.expectedVersion !== null &&
      (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0)) {
    errors.push({ field: 'expectedVersion', issue: 'must be an integer >= 0' });
  }
  checkText(input.idempotencyKey, 'idempotencyKey', errors, 255);
  if (errors.length) throw AppError.validation(errors);
  const reason = requireReason(input.reason);

  const matches = (m) => m.batchId === input.batchId && (input.quantity == null || -m.delta === input.quantity);
  const prev = await replayRowChange(input, 'EXPIRY_WRITE_OFF', matches, opts.client);
  if (prev) return prev;

  try {
    return await withTransaction(async (client) => {
      const row = await lockRow(input.shopId, input.batchId, client);
      const prior = await replayRowChange(input, 'EXPIRY_WRITE_OFF', matches, client);
      if (prior) return prior;
      if (input.expectedVersion != null && row.version !== input.expectedVersion) {
        throw new AppError('STALE_INVENTORY', undefined, {
          expectedVersion: input.expectedVersion, currentVersion: row.version, quantity: row.quantity, reserved: row.reserved,
        });
      }
      const free = row.quantity - row.reserved;
      const qty = input.quantity ?? free;
      if (qty <= 0 || qty > free) {
        throw new AppError('INSUFFICIENT_STOCK', 'Not enough unreserved units to write off', {
          requested: qty, available: free, reserved: row.reserved,
        });
      }
      const r = await applyRowChange(row, 'EXPIRY_WRITE_OFF', -qty, input, reason, client);
      return { ...r, replayed: false };
    }, { client: opts.client });
  } catch (err) {
    if (isIdemConflict(err)) {
      const again = await replayRowChange(input, 'EXPIRY_WRITE_OFF', matches, opts.client);
      if (again) return again;
    }
    throw err instanceof AppError ? err : mapPgError(err);
  }
}

// ---------------------------------------------------------------------------
// getAvailable (B10)
// ---------------------------------------------------------------------------

/**
 * Non-expired, unreserved quantity of a medicine per active shop, for Anushka's lookup.
 * Shops with nothing available, and inactive shops, are left out.
 *
 * @param {number} medicineId
 * @param {{shopIds?: number[]}} [filter]
 * @param {{client?: import('pg').PoolClient}} [opts]
 * @returns {Promise<Array<{shopId:number, medicineId:number, available:number, nearestExpiry:string}>>}
 *          highest available first
 */
async function getAvailable(medicineId, filter = {}, opts = {}) {
  const errors = [];
  checkId(medicineId, 'medicineId', errors);
  if (filter.shopIds !== undefined &&
      (!Array.isArray(filter.shopIds) || filter.shopIds.some((s) => !Number.isInteger(s) || s <= 0))) {
    errors.push({ field: 'shopIds', issue: 'must be an array of positive integers' });
  }
  if (errors.length) throw AppError.validation(errors);

  const params = [medicineId];
  let shopFilter = '';
  if (filter.shopIds) {
    params.push(filter.shopIds);
    shopFilter = `AND i.shop_id = ANY($${params.length}::bigint[])`;
  }
  const { rows } = await query(
    `SELECT i.shop_id, sum(i.quantity - i.reserved)::int AS available, min(b.expiry_date)::text AS nearest_expiry
       FROM inventory i
       JOIN medicine_batches b ON b.id = i.batch_id
       JOIN shops s ON s.id = i.shop_id AND s.is_active
      WHERE b.medicine_id = $1
        AND b.expiry_date > ${batches.TODAY_SQL}
        AND b.is_active AND i.is_active
        AND i.quantity > i.reserved
        ${shopFilter}
      GROUP BY i.shop_id
      ORDER BY available DESC, i.shop_id`,
    params,
    opts.client
  );
  return rows.map((r) => ({ shopId: r.shop_id, medicineId, available: r.available, nearestExpiry: r.nearest_expiry }));
}

module.exports = {
  stockIn,
  getAvailable,
  dispense,
  adjust,
  writeOff,
  reserve,
  release,
};
