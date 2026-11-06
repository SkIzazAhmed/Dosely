'use strict';

/**
 * stock.service — INTERFACE STUB (Rachana, Commit 1, Nov 4).
 *
 * The ONLY code allowed to change stock (B6). Every real function writes
 * INVENTORY and a STOCK_MOVEMENTS row in the same transaction.
 *
 * Anushka (requests / referrals) codes against these signatures from today.
 * The real implementations replace the stub with the SAME signatures:
 *   Nov 8   stockIn                                 (B4, B5, B7)
 *   Nov 10  dispense, adjust, writeOff              (B8, B9)
 *   Nov 12  reserve, release, getAvailable          (B9 version check, B10)
 *
 * Until then the stub validates input exactly like the real service and keeps
 * stock in memory (per process), so you get realistic results and errors:
 * FEFO order, INSUFFICIENT_STOCK, BATCH_EXPIRED, BATCH_MISMATCH,
 * STALE_INVENTORY and idempotent replays. Nothing is written to the database.
 *
 * Every function takes an optional last argument `opts`:
 *   { client }  your transaction client — the real service joins your
 *               transaction (SAVEPOINT) so stock and your rows commit together.
 */

const { AppError } = require('../../shared/errors');

/**
 * @typedef {Object} Opts
 * @property {import('pg').PoolClient} [client]  join the caller's transaction
 *
 * @typedef {Object} Movement
 * @property {number} id
 * @property {'STOCK_IN'|'DISPENSE'|'RETURN'|'ADJUSTMENT'|'EXPIRY_WRITE_OFF'} type
 * @property {number} shopId
 * @property {number} batchId
 * @property {number} delta            signed change in base units
 * @property {number} balanceAfter     inventory.quantity after this movement
 * @property {string|null} reason
 * @property {number} performedBy      users.id
 * @property {number|null} requestId
 * @property {number|null} referralId
 * @property {string|null} idempotencyKey
 *
 * @typedef {Object} Inventory
 * @property {number} id
 * @property {number} shopId
 * @property {number} batchId
 * @property {number} quantity         >= 0
 * @property {number} reserved         0 <= reserved <= quantity
 * @property {number} version          send it back on manual edits (B9)
 *
 * @typedef {Object} Line              one batch's share of a dispense / reservation
 * @property {number} batchId
 * @property {string} batchNo
 * @property {string} expiryDate       'YYYY-MM-DD'
 * @property {number} quantity
 */

// ---------------------------------------------------------------------------
// validation helpers (same rules the real service will apply)
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function check(input, rules) {
  if (!input || typeof input !== 'object') throw AppError.validation([{ field: 'input', issue: 'required' }]);
  const errors = [];
  for (const [field, rule] of Object.entries(rules)) {
    const v = input[field];
    if (v === undefined || v === null || v === '') {
      if (rule.required) errors.push({ field, issue: 'required' });
      continue;
    }
    switch (rule.type) {
      case 'id':
        if (!Number.isInteger(v) || v <= 0) errors.push({ field, issue: 'must be a positive integer' });
        break;
      case 'qty':
        if (!Number.isInteger(v) || v <= 0) errors.push({ field, issue: 'must be an integer > 0' });
        break;
      case 'delta':
        if (!Number.isInteger(v) || v === 0) errors.push({ field, issue: 'must be a non-zero integer' });
        break;
      case 'version':
        if (!Number.isInteger(v) || v < 0) errors.push({ field, issue: 'must be an integer >= 0' });
        break;
      case 'money':
        if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || Math.round(v * 100) !== v * 100) {
          errors.push({ field, issue: 'must be > 0 with at most 2 decimals' });
        }
        break;
      case 'date':
        if (typeof v !== 'string' || !DATE_RE.test(v) || Number.isNaN(Date.parse(v))) {
          errors.push({ field, issue: 'must be a date YYYY-MM-DD' });
        }
        break;
      case 'string':
        if (typeof v !== 'string' || v.trim() === '' || v.length > (rule.max || 255)) {
          errors.push({ field, issue: `must be a non-empty string (max ${rule.max || 255})` });
        }
        break;
      case 'lines':
        if (!Array.isArray(v) || v.length === 0 ||
            v.some((l) => !l || !Number.isInteger(l.batchId) || l.batchId <= 0 || !Number.isInteger(l.quantity) || l.quantity <= 0)) {
          errors.push({ field, issue: 'must be a non-empty array of { batchId, quantity }' });
        }
        break;
      default:
        throw new Error(`stock.service: unknown rule ${rule.type}`);
    }
  }
  if (errors.length) throw AppError.validation(errors);
}

function requireReason(reason) {
  if (typeof reason !== 'string' || reason.trim().length < 3) throw new AppError('REASON_REQUIRED');
}

const today = () => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// in-memory stand-in for MEDICINE_BATCHES / INVENTORY / STOCK_MOVEMENTS
// ---------------------------------------------------------------------------

const mem = {
  batches: new Map(),     // batchId -> { id, medicineId, batchNo, expiryDate, mfgDate, mrp }
  inventory: new Map(),   // `${shopId}:${batchId}` -> Inventory
  movements: [],
  idem: new Map(),        // `${fn}:${idempotencyKey}` -> result
  seq: { batch: 0, inv: 0, mov: 0 },
};

function idempotent(fn, key, work) {
  if (!key) return work();
  const k = `${fn}:${key}`;
  if (mem.idem.has(k)) return { ...mem.idem.get(k), replayed: true };
  const result = { ...work(), replayed: false };
  mem.idem.set(k, result);
  return result;
}

function invRow(shopId, batchId, create = false) {
  const k = `${shopId}:${batchId}`;
  if (!mem.inventory.has(k) && create) {
    mem.inventory.set(k, { id: ++mem.seq.inv, shopId, batchId, quantity: 0, reserved: 0, version: 0 });
  }
  return mem.inventory.get(k);
}

function move(type, inv, delta, input) {
  inv.quantity += delta;
  inv.version += 1;
  const m = {
    id: ++mem.seq.mov,
    type,
    shopId: inv.shopId,
    batchId: inv.batchId,
    delta,
    balanceAfter: inv.quantity,
    reason: input.reason || null,
    performedBy: input.performedBy,
    requestId: input.requestId || null,
    referralId: input.referralId || null,
    idempotencyKey: input.idempotencyKey || null,
  };
  mem.movements.push(m);
  return m;
}

/** Non-expired batches of a medicine that have free stock in a shop, earliest expiry first (FEFO). */
function fefo(shopId, medicineId) {
  const t = today();
  return [...mem.batches.values()]
    .filter((b) => b.medicineId === medicineId && b.expiryDate > t)
    .map((b) => ({ b, inv: invRow(shopId, b.id) }))
    .filter(({ inv }) => inv && inv.quantity - inv.reserved > 0)
    .sort((x, y) => (x.b.expiryDate < y.b.expiryDate ? -1 : x.b.expiryDate > y.b.expiryDate ? 1 : x.b.id - y.b.id));
}

const line = (b, quantity) => ({ batchId: b.id, batchNo: b.batchNo, expiryDate: b.expiryDate, quantity });

function log(fn, input) {
  if (process.env.NODE_ENV !== 'test') console.log(`[stock.service STUB] ${fn}`, JSON.stringify(input));
}

// ---------------------------------------------------------------------------
// public API — these signatures are the contract
// ---------------------------------------------------------------------------

/**
 * Receive stock into a shop (STOCK_IN). Creates the batch if the batch number
 * is new for the medicine; reuses it if expiry and MRP match (B7).
 *
 * @param {Object} input
 * @param {number} input.shopId
 * @param {number} input.medicineId
 * @param {string} input.batchNo
 * @param {string} input.expiryDate        'YYYY-MM-DD'; must be in the future → else 422 BATCH_EXPIRED
 * @param {string} [input.manufactureDate] 'YYYY-MM-DD', before expiryDate
 * @param {number} input.mrp               INR per base unit, > 0
 * @param {number} input.quantity          base units, > 0
 * @param {number} input.performedBy       users.id
 * @param {string} [input.reason]
 * @param {string} [input.idempotencyKey]  same key again → same result, replayed: true
 * @param {Opts} [opts]
 * @returns {Promise<{batch: Object, inventory: Inventory, movement: Movement, replayed: boolean}>}
 * @throws BATCH_EXPIRED (422), BATCH_MISMATCH (409), VALIDATION_ERROR (400)
 */
async function stockIn(input, opts = {}) { // eslint-disable-line no-unused-vars
  check(input, {
    shopId: { type: 'id', required: true },
    medicineId: { type: 'id', required: true },
    batchNo: { type: 'string', required: true, max: 50 },
    expiryDate: { type: 'date', required: true },
    manufactureDate: { type: 'date' },
    mrp: { type: 'money', required: true },
    quantity: { type: 'qty', required: true },
    performedBy: { type: 'id', required: true },
    reason: { type: 'string', max: 500 },
    idempotencyKey: { type: 'string' },
  });
  if (input.manufactureDate && input.manufactureDate >= input.expiryDate) {
    throw AppError.validation([{ field: 'manufactureDate', issue: 'must be before expiryDate' }]);
  }
  log('stockIn', input);

  return idempotent('stockIn', input.idempotencyKey, () => {
    if (input.expiryDate <= today()) {
      throw new AppError('BATCH_EXPIRED', undefined, { batchNo: input.batchNo, expiryDate: input.expiryDate });
    }
    const batchNo = input.batchNo.trim().toUpperCase();
    let batch = [...mem.batches.values()].find((b) => b.medicineId === input.medicineId && b.batchNo === batchNo);
    if (batch && (batch.expiryDate !== input.expiryDate || batch.mrp !== input.mrp)) {
      throw new AppError('BATCH_MISMATCH', undefined, {
        batchId: batch.id,
        known: { expiryDate: batch.expiryDate, mrp: batch.mrp },
        sent: { expiryDate: input.expiryDate, mrp: input.mrp },
      });
    }
    if (!batch) {
      batch = {
        id: ++mem.seq.batch,
        medicineId: input.medicineId,
        batchNo,
        manufactureDate: input.manufactureDate || null,
        expiryDate: input.expiryDate,
        mrp: input.mrp,
      };
      mem.batches.set(batch.id, batch);
    }
    const inv = invRow(input.shopId, batch.id, true);
    const movement = move('STOCK_IN', inv, input.quantity, input);
    return { batch: { ...batch }, inventory: { ...inv }, movement };
  });
}

/**
 * Dispense a medicine from a shop (DISPENSE).
 * Without `reservation`: picks non-expired batches earliest-expiry first (FEFO),
 * possibly across several batches. With `reservation` (the lines reserve()
 * returned): dispenses exactly those units and clears their reservation.
 * Two callers racing for the last units: one wins, the other gets 409.
 *
 * @param {Object} input
 * @param {number} input.shopId
 * @param {number} input.medicineId
 * @param {number} input.quantity          base units, > 0
 * @param {number} input.performedBy       users.id
 * @param {string} input.idempotencyKey    REQUIRED — stops double dispense (B8)
 * @param {number} [input.requestId]
 * @param {number} [input.referralId]
 * @param {Line[]} [input.reservation]     lines from reserve(); must add up to quantity
 * @param {string} [input.reason]
 * @param {Opts} [opts]
 * @returns {Promise<{shopId:number, medicineId:number, quantity:number, lines: Array<Line & {movementId:number, balanceAfter:number}>, replayed:boolean}>}
 * @throws INSUFFICIENT_STOCK (409), VALIDATION_ERROR (400)
 */
async function dispense(input, opts = {}) { // eslint-disable-line no-unused-vars
  check(input, {
    shopId: { type: 'id', required: true },
    medicineId: { type: 'id', required: true },
    quantity: { type: 'qty', required: true },
    performedBy: { type: 'id', required: true },
    idempotencyKey: { type: 'string', required: true },
    requestId: { type: 'id' },
    referralId: { type: 'id' },
    reservation: { type: 'lines' },
    reason: { type: 'string', max: 500 },
  });
  if (input.reservation && input.reservation.reduce((s, l) => s + l.quantity, 0) !== input.quantity) {
    throw AppError.validation([{ field: 'reservation', issue: 'line quantities must add up to quantity' }]);
  }
  log('dispense', input);

  return idempotent('dispense', input.idempotencyKey, () => {
    const t = today();
    let plan;
    if (input.reservation) {
      plan = input.reservation.map((l) => {
        const b = mem.batches.get(l.batchId);
        const inv = b && b.medicineId === input.medicineId && invRow(input.shopId, l.batchId);
        if (!inv || inv.reserved < l.quantity || b.expiryDate <= t) {
          throw new AppError('INSUFFICIENT_STOCK', 'Reserved stock is no longer available', { batchId: l.batchId });
        }
        return { b, inv, qty: l.quantity, fromReserved: true };
      });
    } else {
      plan = [];
      let left = input.quantity;
      for (const { b, inv } of fefo(input.shopId, input.medicineId)) {
        if (left === 0) break;
        const qty = Math.min(left, inv.quantity - inv.reserved);
        plan.push({ b, inv, qty, fromReserved: false });
        left -= qty;
      }
      if (left > 0) {
        throw new AppError('INSUFFICIENT_STOCK', undefined, {
          medicineId: input.medicineId,
          requested: input.quantity,
          available: input.quantity - left,
        });
      }
    }
    // real service locks rows in batch_id order; mirror that ordering here
    const lines = plan
      .sort((x, y) => x.b.id - y.b.id)
      .map(({ b, inv, qty, fromReserved }) => {
        if (fromReserved) inv.reserved -= qty;
        const m = move('DISPENSE', inv, -qty, input);
        return { ...line(b, qty), movementId: m.id, balanceAfter: m.balanceAfter };
      })
      .sort((x, y) => (x.expiryDate < y.expiryDate ? -1 : 1));
    return { shopId: input.shopId, medicineId: input.medicineId, quantity: input.quantity, lines };
  });
}

/**
 * Manual stock correction (ADJUSTMENT). OWNER only (enforced by the route).
 * @param {Object} input
 * @param {number} input.shopId
 * @param {number} input.batchId
 * @param {number} input.delta             signed, non-zero; result can't go below reserved or 0
 * @param {number} input.expectedVersion   inventory.version you read → else 409 STALE_INVENTORY
 * @param {string} input.reason            required (B9)
 * @param {number} input.performedBy
 * @param {string} [input.idempotencyKey]
 * @param {Opts} [opts]
 * @returns {Promise<{inventory: Inventory, movement: Movement, replayed: boolean}>}
 * @throws STALE_INVENTORY, INSUFFICIENT_STOCK, REASON_REQUIRED, NOT_FOUND
 */
async function adjust(input, opts = {}) { // eslint-disable-line no-unused-vars
  check(input, {
    shopId: { type: 'id', required: true },
    batchId: { type: 'id', required: true },
    delta: { type: 'delta', required: true },
    expectedVersion: { type: 'version', required: true },
    performedBy: { type: 'id', required: true },
    idempotencyKey: { type: 'string' },
  });
  requireReason(input.reason);
  log('adjust', input);

  return idempotent('adjust', input.idempotencyKey, () => {
    const inv = invRow(input.shopId, input.batchId);
    if (!inv) throw AppError.notFound('Inventory', { shopId: input.shopId, batchId: input.batchId });
    if (inv.version !== input.expectedVersion) {
      throw new AppError('STALE_INVENTORY', undefined, { expectedVersion: input.expectedVersion, currentVersion: inv.version });
    }
    if (inv.quantity + input.delta < inv.reserved) {
      throw new AppError('INSUFFICIENT_STOCK', undefined, { quantity: inv.quantity, reserved: inv.reserved, delta: input.delta });
    }
    const movement = move('ADJUSTMENT', inv, input.delta, input);
    return { inventory: { ...inv }, movement };
  });
}

/**
 * Write off expired / damaged stock (EXPIRY_WRITE_OFF). OWNER only.
 * @param {Object} input
 * @param {number} input.shopId
 * @param {number} input.batchId
 * @param {number} [input.quantity]        default: all unreserved units of the batch
 * @param {number} [input.expectedVersion] optional version check
 * @param {string} input.reason            required
 * @param {number} input.performedBy
 * @param {string} [input.idempotencyKey]
 * @param {Opts} [opts]
 * @returns {Promise<{inventory: Inventory, movement: Movement, replayed: boolean}>}
 */
async function writeOff(input, opts = {}) { // eslint-disable-line no-unused-vars
  check(input, {
    shopId: { type: 'id', required: true },
    batchId: { type: 'id', required: true },
    quantity: { type: 'qty' },
    expectedVersion: { type: 'version' },
    performedBy: { type: 'id', required: true },
    idempotencyKey: { type: 'string' },
  });
  requireReason(input.reason);
  log('writeOff', input);

  return idempotent('writeOff', input.idempotencyKey, () => {
    const inv = invRow(input.shopId, input.batchId);
    if (!inv) throw AppError.notFound('Inventory', { shopId: input.shopId, batchId: input.batchId });
    if (input.expectedVersion !== undefined && inv.version !== input.expectedVersion) {
      throw new AppError('STALE_INVENTORY', undefined, { expectedVersion: input.expectedVersion, currentVersion: inv.version });
    }
    const free = inv.quantity - inv.reserved;
    const qty = input.quantity ?? free;
    if (qty <= 0 || qty > free) {
      throw new AppError('INSUFFICIENT_STOCK', undefined, { requested: qty, available: free });
    }
    const movement = move('EXPIRY_WRITE_OFF', inv, -qty, input);
    return { inventory: { ...inv }, movement };
  });
}

/**
 * Hold stock for an accepted referral (no movement row; quantity unchanged,
 * reserved goes up). FEFO across batches. Same referralId twice → same lines.
 * @param {Object} input
 * @param {number} input.shopId
 * @param {number} input.medicineId
 * @param {number} input.quantity
 * @param {number} input.referralId
 * @param {number} input.performedBy
 * @param {Opts} [opts]
 * @returns {Promise<{shopId:number, medicineId:number, referralId:number, lines: Line[], replayed:boolean}>}
 *          store `lines`; pass them to dispense({ reservation }) or release({ lines })
 * @throws INSUFFICIENT_STOCK
 */
async function reserve(input, opts = {}) { // eslint-disable-line no-unused-vars
  check(input, {
    shopId: { type: 'id', required: true },
    medicineId: { type: 'id', required: true },
    quantity: { type: 'qty', required: true },
    referralId: { type: 'id', required: true },
    performedBy: { type: 'id', required: true },
  });
  log('reserve', input);

  return idempotent('reserve', `${input.shopId}:${input.medicineId}:${input.referralId}`, () => {
    const plan = [];
    let left = input.quantity;
    for (const { b, inv } of fefo(input.shopId, input.medicineId)) {
      if (left === 0) break;
      const qty = Math.min(left, inv.quantity - inv.reserved);
      plan.push({ b, inv, qty });
      left -= qty;
    }
    if (left > 0) {
      throw new AppError('INSUFFICIENT_STOCK', undefined, {
        medicineId: input.medicineId,
        requested: input.quantity,
        available: input.quantity - left,
      });
    }
    const lines = plan.map(({ b, inv, qty }) => {
      inv.reserved += qty;
      inv.version += 1;
      return line(b, qty);
    });
    return { shopId: input.shopId, medicineId: input.medicineId, referralId: input.referralId, lines };
  });
}

/**
 * Give back reserved stock (referral rejected, expired or cancelled).
 * Releasing more than is reserved on a batch releases what is left (never < 0).
 * @param {Object} input
 * @param {number} input.shopId
 * @param {number} input.referralId
 * @param {Line[]} input.lines             the lines reserve() returned
 * @param {number} input.performedBy
 * @param {Opts} [opts]
 * @returns {Promise<{shopId:number, referralId:number, released:number}>}  units released
 */
async function release(input, opts = {}) { // eslint-disable-line no-unused-vars
  check(input, {
    shopId: { type: 'id', required: true },
    referralId: { type: 'id', required: true },
    lines: { type: 'lines', required: true },
    performedBy: { type: 'id', required: true },
  });
  log('release', input);

  let released = 0;
  for (const l of input.lines) {
    const inv = invRow(input.shopId, l.batchId);
    if (!inv) continue;
    const n = Math.min(inv.reserved, l.quantity);
    inv.reserved -= n;
    if (n) inv.version += 1;
    released += n;
  }
  return { shopId: input.shopId, referralId: input.referralId, released };
}

/**
 * Availability helper for Anushka's lookup (B10): non-expired, unreserved
 * quantity of a medicine per shop. Shops with 0 available are left out.
 * @param {number} medicineId
 * @param {Object} [filter]
 * @param {number[]} [filter.shopIds]      limit to these shops (default: all)
 * @param {Opts} [opts]
 * @returns {Promise<Array<{shopId:number, medicineId:number, available:number, nearestExpiry:string}>>}
 *          sorted by available, highest first
 */
async function getAvailable(medicineId, filter = {}, opts = {}) { // eslint-disable-line no-unused-vars
  check({ medicineId }, { medicineId: { type: 'id', required: true } });
  if (filter.shopIds !== undefined &&
      (!Array.isArray(filter.shopIds) || filter.shopIds.some((s) => !Number.isInteger(s) || s <= 0))) {
    throw AppError.validation([{ field: 'shopIds', issue: 'must be an array of positive integers' }]);
  }
  const t = today();
  const byShop = new Map();
  for (const inv of mem.inventory.values()) {
    const b = mem.batches.get(inv.batchId);
    if (b.medicineId !== medicineId || b.expiryDate <= t) continue;
    if (filter.shopIds && !filter.shopIds.includes(inv.shopId)) continue;
    const free = inv.quantity - inv.reserved;
    if (free <= 0) continue;
    const cur = byShop.get(inv.shopId) || { shopId: inv.shopId, medicineId, available: 0, nearestExpiry: b.expiryDate };
    cur.available += free;
    if (b.expiryDate < cur.nearestExpiry) cur.nearestExpiry = b.expiryDate;
    byShop.set(inv.shopId, cur);
  }
  return [...byShop.values()].sort((x, y) => y.available - x.available || x.shopId - y.shopId);
}

/** Test helper (stub only): forget all in-memory stock. Not part of the contract. */
function _resetStub() {
  mem.batches.clear();
  mem.inventory.clear();
  mem.movements.length = 0;
  mem.idem.clear();
  mem.seq = { batch: 0, inv: 0, mov: 0 };
}

module.exports = {
  stockIn,
  dispense,
  adjust,
  writeOff,
  reserve,
  release,
  getAvailable,
  _resetStub,
};
