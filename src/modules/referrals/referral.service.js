'use strict';

/**
 * Referrals (C7, C8): send the patient to another shop that has the stock.
 *
 * Locking order, everywhere: the request row first, then its referral rows.
 * (request.service cancel does the same), so two actions on one request
 * can't deadlock.
 */

const { query } = require('../../db/pool');
const { withTransaction } = require('../../db/transaction');
const { AppError, fromPgError } = require('../../shared/errors');
const stock = require('../inventory/stock.service');
const notifications = require('../notifications/notification.service');
const shopAccess = require('../requests/shopAccess');
const requests = require('../requests/request.service');
const requestState = require('../requests/request.state');
const state = require('./referral.state');
const { holdHours, SELECT, toPublic } = require('./referral.model');
const messages = require('./referral.messages');
const patientPhone = require('./patientPhone');

const PG_CONSTRAINTS = { referrals_live_target_key: 'REFERRAL_DUPLICATE', referrals_shops_differ: 'REFERRAL_SAME_SHOP' };

async function getById(id, { client } = {}) {
  const { rows } = await query(`${SELECT} WHERE f.id = $1`, [id], client);
  return toPublic(rows[0]);
}

async function getByIdOrThrow(id, opts) {
  const r = await getById(id, opts);
  if (!r) throw AppError.notFound('Referral', id);
  return r;
}

async function listForRequest(user, requestId) {
  const request = await requests.getByIdOrThrow(requestId);
  await requests.actorFor(user, request);
  const { rows } = await query(`${SELECT} WHERE f.request_id = $1 ORDER BY f.id`, [requestId]);
  return { items: rows.map(toPublic) };
}

/** Target shop's referral inbox: live ones first, newest first. */
async function listForShop(user, shopId, { status, limit = 20, offset = 0 } = {}) {
  await shopAccess.assertStaff(user, shopId);
  const params = [shopId];
  let where = 'f.to_shop_id = $1';
  if (status) {
    params.push(status);
    where += ` AND f.status = $${params.length}`;
  }
  const { rows: [{ total }] } = await query(`SELECT count(*)::int AS total FROM referrals f WHERE ${where}`, params);
  params.push(limit, offset);
  const { rows } = await query(
    `${SELECT} WHERE ${where}
      ORDER BY (f.status IN ('PENDING', 'ACCEPTED')) DESC, f.created_at DESC, f.id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { items: rows.map(toPublic), total, limit, offset };
}

/** Origin staff, target staff or ADMIN may read a referral. */
async function getForUser(user, id) {
  const ref = await getByIdOrThrow(id);
  if (user.role !== 'ADMIN') {
    try {
      await shopAccess.assertStaff(user, ref.toShop.id);
    } catch {
      await shopAccess.assertStaff(user, ref.fromShop.id);
    }
  }
  return ref;
}

/** 'SHOP' (origin staff) or 'TARGET_SHOP'; ADMIN may act as either. */
async function actAs(user, ref, needed, { client } = {}) {
  if (user.role === 'ADMIN') return needed;
  await shopAccess.assertStaff(user, needed === 'TARGET_SHOP' ? ref.toShop.id : ref.fromShop.id, { client });
  return needed;
}

async function availableAt(shopId, medicineId, client) {
  const rows = await stock.getAvailable(medicineId, { shopIds: [shopId] }, { client });
  return rows.reduce((n, r) => n + r.available, 0);
}

/** Lock the request, then the referral (see locking order above). */
async function lockForAction(client, referralId) {
  const { rows: [head] } = await client.query('SELECT request_id FROM referrals WHERE id = $1', [referralId]);
  if (!head) throw AppError.notFound('Referral', referralId);
  const request = await requests.getByIdOrThrow(head.request_id, { client, forUpdate: true });
  const { rows: [row] } = await client.query('SELECT * FROM referrals WHERE id = $1 FOR UPDATE', [referralId]);
  return { request, row, ref: await getById(referralId, { client }) };
}

/**
 * When a request's last live referral ends (rejected, cancelled, no-show,
 * fulfilled short), step it back: PARTIALLY_FULFILLED if something was
 * dispensed, else ACKNOWLEDGED. No-op while it still has a live referral.
 * Caller must hold the request row lock.
 */
async function stepBack(client, requestId, actor) {
  const request = await requests.getByIdOrThrow(requestId, { client });
  if (request.status !== 'REFERRED') return request;
  const liveReferrals = await requests.liveReferralCount(requestId, { client });
  if (liveReferrals > 0) return request;
  const to = request.fulfilledQty > 0 ? 'PARTIALLY_FULFILLED' : 'ACKNOWLEDGED';
  requestState.assertTransition('REFERRED', to, actor, { request, liveReferrals });
  await client.query('UPDATE stock_requests SET status = $2::request_status WHERE id = $1', [requestId, to]);
  return requests.getByIdOrThrow(requestId, { client });
}

function notifyShop(shopId, type, title, body, data, client) {
  return notifications.notifyShop(shopId, { channels: ['IN_APP'], type, title, body, data }, { client });
}

const medName = (m) => [m.brandName, m.strength].filter(Boolean).join(' ');

// ---------------------------------------------------------------------------
// C7: create
// ---------------------------------------------------------------------------

/**
 * The origin shop refers (part of) what it can't supply to another shop.
 * Rules (C7): at most 3 referrals per request, no second live referral to the
 * same shop, live referred quantity ≤ unfulfilled (DB trigger + unique index),
 * and the target must have the units right now (edge case 8). The available
 * quantity seen is stored on the referral.
 */
async function create(user, requestId, { toShopId, quantity }) {
  return withTransaction(async (client) => {
    const request = await requests.getByIdOrThrow(requestId, { client, forUpdate: true });
    if (user.role !== 'ADMIN') await shopAccess.assertStaff(user, request.shopId, { client });
    if (!['ACKNOWLEDGED', 'PARTIALLY_FULFILLED', 'REFERRED'].includes(request.status)) {
      throw new AppError('INVALID_TRANSITION', `Cannot refer a ${request.status} request`, {
        entity: 'stock_request', from: request.status, to: 'REFERRED', actor: 'SHOP',
        reason: request.status === 'SENT' ? 'acknowledge the request first' : 'request is closed',
      });
    }
    if (toShopId === request.shopId) throw new AppError('REFERRAL_SAME_SHOP');
    await shopAccess.assertShopActive(toShopId, { client }); // edge case 13

    const available = await availableAt(toShopId, request.medicine.id, client);
    if (available < quantity) {
      throw new AppError('INSUFFICIENT_STOCK', 'Target shop does not have enough stock', {
        shopId: toShopId, medicineId: request.medicine.id, requested: quantity, available,
      });
    }

    let id;
    try {
      await client.query('SAVEPOINT referral_insert');
      ({ rows: [{ id }] } = await client.query(
        `INSERT INTO referrals (request_id, from_shop_id, to_shop_id, quantity, available_qty_seen, referred_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [requestId, request.shopId, toShopId, quantity, available, user.id]
      ));
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT referral_insert');
      throw fromPgError(err, PG_CONSTRAINTS);
    }

    if (request.status !== 'REFERRED') {
      requestState.assertTransition(request.status, 'REFERRED', 'SHOP', {
        request, liveReferrals: await requests.liveReferralCount(requestId, { client }),
      });
      await client.query(`UPDATE stock_requests SET status = 'REFERRED' WHERE id = $1`, [requestId]);
    }

    const ref = await getById(id, { client });
    await notifyShop(
      toShopId, 'REFERRAL_SENT', `Referral for ${request.requestNo}`,
      `${ref.fromShop.name} is sending a patient for ${quantity} × ${medName(request.medicine)}. Please accept or reject.`,
      { referralId: id, requestId, requestNo: request.requestNo, quantity },
      client
    );
    return ref;
  });
}

// ---------------------------------------------------------------------------
// C8: accept, reject, cancel
// ---------------------------------------------------------------------------

/** Target shop accepts: reserves the units through stock.reserve and holds them (default 24 h). */
async function accept(user, id) {
  return withTransaction(async (client) => {
    const { request, row, ref } = await lockForAction(client, id);
    const actor = await actAs(user, ref, 'TARGET_SHOP', { client });
    state.assertTransition(row.status, 'ACCEPTED', actor, { referral: row, available: row.quantity }); // table + actor

    const available = await availableAt(row.to_shop_id, request.medicine.id, client);
    if (available < row.quantity) {
      // edge case 8: stock went since the lookup — the referral stays PENDING (reject it, or refer elsewhere)
      throw new AppError('INSUFFICIENT_STOCK', 'Not enough stock left to hold for this referral', {
        shopId: row.to_shop_id, medicineId: request.medicine.id, requested: row.quantity, available,
      });
    }
    state.assertTransition(row.status, 'ACCEPTED', actor, { referral: row, available });

    const { lines } = await stock.reserve(
      { shopId: row.to_shop_id, medicineId: request.medicine.id, quantity: row.quantity, referralId: id, performedBy: user.id },
      { client }
    );
    await client.query(
      `UPDATE referrals
          SET status = 'ACCEPTED', accepted_at = now(), hold_until = now() + make_interval(hours => $3),
              reservation_lines = $2::jsonb, responded_by = $4
        WHERE id = $1`,
      [id, JSON.stringify(lines), holdHours(), user.id]
    );

    const updated = await getById(id, { client });
    // C10: patient SMS (batched) or a printed slip — only now that it's ACCEPTED
    const patientContact = await messages.queueForAccepted(client, updated, request);
    await notifyShop(
      row.from_shop_id, 'REFERRAL_ACCEPTED', `Referral accepted for ${request.requestNo}`,
      `${updated.toShop.name} is holding ${row.quantity} × ${medName(request.medicine)} until pickup.`,
      { referralId: id, requestId: request.id, holdUntil: updated.holdUntil },
      client
    );
    return { ...updated, patientContact };
  });
}

/** Target shop rejects with a reason; the request steps back if this was its last live referral. */
async function reject(user, id, reason) {
  return withTransaction(async (client) => {
    const { request, row, ref } = await lockForAction(client, id);
    const actor = await actAs(user, ref, 'TARGET_SHOP', { client });
    state.assertTransition(row.status, 'REJECTED', actor, { referral: row, reason });
    await client.query(
      `UPDATE referrals SET status = 'REJECTED', rejected_at = now(), reject_reason = $2, responded_by = $3 WHERE id = $1`,
      [id, reason.trim(), user.id]
    );
    const req = await stepBack(client, request.id, actor);
    await notifyShop(
      row.from_shop_id, 'REFERRAL_REJECTED', `Referral rejected for ${request.requestNo}`,
      `${ref.toShop.name} rejected the referral: ${reason.trim()}`,
      { referralId: id, requestId: request.id }, client
    );
    return { ...(await getById(id, { client })), request: { id: req.id, status: req.status } };
  });
}

/**
 * Origin shop cancels a live referral (edge case 11 at referral level):
 * stock held for an ACCEPTED one is released at the target shop.
 */
async function cancel(user, id, reason = null) {
  return withTransaction(async (client) => {
    const { request, row, ref } = await lockForAction(client, id);
    const actor = await actAs(user, ref, 'SHOP', { client });
    state.assertTransition(row.status, 'CANCELLED', actor, { referral: row });

    let released = 0;
    if (row.status === 'ACCEPTED' && Array.isArray(row.reservation_lines) && row.reservation_lines.length) {
      ({ released } = await stock.release(
        { shopId: row.to_shop_id, referralId: id, lines: row.reservation_lines, performedBy: user.id },
        { client }
      ));
    }
    await client.query(
      `UPDATE referrals SET status = 'CANCELLED', cancelled_at = now(), cancel_reason = $2 WHERE id = $1`,
      [id, reason]
    );
    const req = await stepBack(client, request.id, actor);
    await notifyShop(
      row.to_shop_id, 'REFERRAL_CANCELLED', `Referral cancelled for ${request.requestNo}`,
      `${ref.fromShop.name} cancelled the referral${reason ? `: ${reason}` : ''}.`,
      { referralId: id, requestId: request.id }, client
    );
    return { ...(await getById(id, { client })), released, request: { id: req.id, status: req.status } };
  });
}

// ---------------------------------------------------------------------------
// C9: pickup at the target shop
// ---------------------------------------------------------------------------

const norm = (v) => String(v || '').trim().toUpperCase();

/**
 * The patient collects at the target shop. Staff enter the request number and
 * the last 5 digits of the patient's phone; a patient with no usable phone
 * (printed slip) is verified by the request number alone. Then the held units
 * are dispensed through stock.dispense (with the reservation lines) and the
 * request's fulfilled quantity goes up: FULFILLED when complete, otherwise
 * PARTIALLY_FULFILLED once no other referral is live.
 */
async function fulfil(user, id, { requestNo, phoneLast5 }) {
  return withTransaction(async (client) => {
    const { request, row, ref } = await lockForAction(client, id);
    const actor = await actAs(user, ref, 'TARGET_SHOP', { client });
    state.assertTransition(row.status, 'FULFILLED', actor, { referral: row, verified: true }); // table + actor

    const phone = await patientPhone.getUsablePhone(request.patientId, { client });
    const verified = norm(requestNo) === norm(request.requestNo) &&
      (!phone || (patientPhone.last5(phone.number) !== '' && String(phoneLast5 || '').trim() === patientPhone.last5(phone.number)));
    if (!verified) {
      throw new AppError('REFERRAL_VERIFICATION_FAILED', undefined, { phoneRequired: Boolean(phone) });
    }
    state.assertTransition(row.status, 'FULFILLED', actor, { referral: row, verified });

    const result = await stock.dispense(
      {
        shopId: row.to_shop_id,
        medicineId: request.medicine.id,
        quantity: row.quantity,
        performedBy: user.id,
        requestId: request.id,
        referralId: id,
        reservation: row.reservation_lines,
        idempotencyKey: `referral:${id}:fulfil`,
      },
      { client }
    );
    await client.query(
      `UPDATE referrals SET status = 'FULFILLED', fulfilled_at = now(), fulfilled_by = $2 WHERE id = $1`,
      [id, user.id]
    );

    const fulfilledQty = request.fulfilledQty + row.quantity;
    const liveReferrals = await requests.liveReferralCount(request.id, { client });
    let to = null;
    if (fulfilledQty === request.requestedQty) to = 'FULFILLED';
    else if (liveReferrals === 0) to = 'PARTIALLY_FULFILLED';
    if (to) requestState.assertTransition(request.status, to, actor, { request, fulfilledQty, liveReferrals });
    await client.query(
      `UPDATE stock_requests
          SET fulfilled_qty = $2, status = COALESCE($3::request_status, status),
              fulfilled_at = CASE WHEN $3::request_status = 'FULFILLED' THEN now() ELSE fulfilled_at END
        WHERE id = $1`,
      [request.id, fulfilledQty, to]
    );
    const req = await requests.getByIdOrThrow(request.id, { client });

    await notifyShop(
      row.from_shop_id, 'REFERRAL_FULFILLED', `Referral collected for ${request.requestNo}`,
      `The patient collected ${row.quantity} × ${medName(request.medicine)} at ${ref.toShop.name}.`,
      { referralId: id, requestId: request.id, requestStatus: req.status }, client
    );
    return {
      ...(await getById(id, { client })),
      dispensed: { quantity: row.quantity, lines: result.lines },
      request: { id: req.id, status: req.status, fulfilledQty: req.fulfilledQty, unfulfilledQty: req.unfulfilledQty },
    };
  });
}

/** C10: printable slip for an accepted referral (origin or target staff). */
async function slip(user, id) {
  const ref = await getForUser(user, id);
  if (!['ACCEPTED', 'FULFILLED'].includes(ref.status)) {
    throw new AppError('INVALID_TRANSITION', 'A slip is only available for an accepted referral', {
      entity: 'referral', from: ref.status, to: 'ACCEPTED', reason: 'referral is not accepted',
    });
  }
  return messages.slipFor(ref);
}

// ---------------------------------------------------------------------------
// C11: jobs
// ---------------------------------------------------------------------------

/**
 * expireReferralHolds: every ACCEPTED referral past hold_until becomes NO_SHOW
 * (edge case 12), its stock is released and the request steps back.
 * @returns {Promise<{noShow:number[]}>}
 */
async function expireHolds() {
  const { rows } = await query(
    `SELECT id FROM referrals WHERE status = 'ACCEPTED' AND hold_until <= now() ORDER BY hold_until, id`
  );
  const noShow = [];
  for (const { id } of rows) {
    await withTransaction(async (client) => {
      const { request, row } = await lockForAction(client, id);
      if (row.status !== 'ACCEPTED' || new Date(row.hold_until) > new Date()) return; // picked up meanwhile
      state.assertTransition('ACCEPTED', 'NO_SHOW', 'SYSTEM', { referral: row });
      if (Array.isArray(row.reservation_lines) && row.reservation_lines.length) {
        await stock.release(
          { shopId: row.to_shop_id, referralId: id, lines: row.reservation_lines, performedBy: row.responded_by || row.referred_by },
          { client }
        );
      }
      await client.query(`UPDATE referrals SET status = 'NO_SHOW', no_show_at = now() WHERE id = $1`, [id]);
      await stepBack(client, request.id, 'SYSTEM');
      for (const shopId of [row.from_shop_id, row.to_shop_id]) {
        await notifyShop(
          shopId, 'REFERRAL_NO_SHOW', `No-show for ${request.requestNo}`,
          `The patient did not collect ${row.quantity} × ${medName(request.medicine)}; the held stock was released.`,
          { referralId: id, requestId: request.id }, client
        );
      }
      noShow.push(id);
    });
  }
  return { noShow };
}

/**
 * PENDING referrals unanswered for 2 hours: remind the origin shop once (C11).
 * @returns {Promise<{reminded:number[]}>}
 */
async function remindPending({ hours = 2 } = {}) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE referrals f SET reminder_sent_at = now()
         FROM stock_requests r, shops ts
        WHERE f.status = 'PENDING' AND f.reminder_sent_at IS NULL
          AND f.created_at <= now() - make_interval(hours => $1)
          AND r.id = f.request_id AND ts.id = f.to_shop_id
       RETURNING f.id, f.from_shop_id, f.request_id, r.request_no, ts.name AS to_shop_name`,
      [hours]
    );
    for (const r of rows) {
      await notifyShop(
        r.from_shop_id, 'REFERRAL_PENDING_REMINDER', `No answer yet for ${r.request_no}`,
        `${r.to_shop_name} hasn't answered the referral for ${hours} hours. You can cancel it and refer elsewhere.`,
        { referralId: r.id, requestId: r.request_id }, client
      );
    }
    return { reminded: rows.map((r) => r.id) };
  });
}

module.exports = {
  fulfil,
  slip,
  expireHolds,
  remindPending,
  getById,
  getByIdOrThrow,
  getForUser,
  listForRequest,
  listForShop,
  create,
  accept,
  reject,
  cancel,
  stepBack,
  lockForAction,
};
