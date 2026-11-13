'use strict';

const express = require('express');
const asyncHandler = require('../../shared/asyncHandler');
const { AppError } = require('../../shared/errors');
const { validate, idParam, pagination } = require('../../shared/validate');
const { ReferralStatus } = require('../../shared/enums');
const { authenticate } = require('../../middleware/auth');
const { idempotency } = require('../../middleware/idempotency');
const referrals = require('./referral.service');

const id = { type: 'integer', min: 1 };

// ---------------------------------------------------------------------------
// /requests/:id/referrals  (mounted by request.routes, already authenticated)
// ---------------------------------------------------------------------------
const forRequest = express.Router({ mergeParams: true });

// POST /requests/:id/referrals { toShopId, quantity } — origin shop staff (C7)
forRequest.post(
  '/',
  idempotency(),
  asyncHandler(async (req, res) => {
    const requestId = idParam(req.params.id, 'Request');
    const body = validate(req.body, {
      toShopId: { ...id, required: true },
      quantity: { type: 'integer', min: 1, max: 10000, required: true },
    });
    res.status(201).json(await referrals.create(req.user, requestId, body));
  })
);

// GET /requests/:id/referrals — anyone who can see the request
forRequest.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(await referrals.listForRequest(req.user, idParam(req.params.id, 'Request')));
  })
);

// ---------------------------------------------------------------------------
// /referrals
// ---------------------------------------------------------------------------
const router = express.Router();
router.use(authenticate);

// GET /referrals?shopId=&status= — the target shop's referral inbox
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const q = {
      ...validate(req.query, {
        shopId: { ...id, required: true },
        status: { type: 'enum', values: Object.values(ReferralStatus) },
      }),
      ...pagination(req.query),
    };
    res.json(await referrals.listForShop(req.user, q.shopId, q));
  })
);

// GET /referrals/:id — origin staff, target staff, ADMIN
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json(await referrals.getForUser(req.user, idParam(req.params.id, 'Referral')));
  })
);

// POST /referrals/:id/accept — target shop staff; reserves stock and holds it (C8)
router.post(
  '/:id/accept',
  idempotency({ required: false }),
  asyncHandler(async (req, res) => {
    res.json(await referrals.accept(req.user, idParam(req.params.id, 'Referral')));
  })
);

// POST /referrals/:id/reject { reason } — target shop staff; reason required (C8)
router.post(
  '/:id/reject',
  idempotency({ required: false }),
  asyncHandler(async (req, res) => {
    const refId = idParam(req.params.id, 'Referral');
    const reason = req.body && typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
    if (!reason) throw new AppError('REJECT_REASON_REQUIRED');
    const body = validate(req.body, { reason: { type: 'string', max: 500, required: true } });
    res.json(await referrals.reject(req.user, refId, body.reason));
  })
);

// POST /referrals/:id/fulfil { requestNo, phoneLast5? } — target shop staff (C9).
// Idempotency-Key required: this dispenses stock.
router.post(
  '/:id/fulfil',
  idempotency(),
  asyncHandler(async (req, res) => {
    const refId = idParam(req.params.id, 'Referral');
    const body = validate(req.body, {
      requestNo: { type: 'string', max: 20, required: true },
      phoneLast5: { type: 'string', pattern: /^\d{5}$/, patternMessage: 'must be 5 digits', nullable: true },
    });
    res.json(await referrals.fulfil(req.user, refId, body));
  })
);

// GET /referrals/:id/slip — printable slip for a patient without a usable phone (C10)
router.get(
  '/:id/slip',
  asyncHandler(async (req, res) => {
    const out = await referrals.slip(req.user, idParam(req.params.id, 'Referral'));
    if ((req.get('accept') || '').includes('text/plain')) return res.type('text/plain').send(out.text);
    res.json(out);
  })
);

// POST /referrals/:id/cancel { reason? } — origin shop staff; releases held stock
router.post(
  '/:id/cancel',
  idempotency({ required: false }),
  asyncHandler(async (req, res) => {
    const refId = idParam(req.params.id, 'Referral');
    const body = validate(req.body, { reason: { type: 'string', max: 500, nullable: true } });
    res.json(await referrals.cancel(req.user, refId, body.reason ?? null));
  })
);

module.exports = router;
module.exports.forRequest = forRequest;
