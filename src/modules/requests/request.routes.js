'use strict';

const express = require('express');
const asyncHandler = require('../../shared/asyncHandler');
const { AppError } = require('../../shared/errors');
const { validate, idParam, pagination } = require('../../shared/validate');
const { RequestStatus, RequestUrgency } = require('../../shared/enums');
const { authenticate } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const { idempotency } = require('../../middleware/idempotency');
const shopAccess = require('./shopAccess');
const requests = require('./request.service');

const router = express.Router();
router.use(authenticate);

const id = { type: 'integer', min: 1 };

// POST /requests — DOCTOR sends a stock request (C1, C2)
router.post(
  '/',
  requireRole('DOCTOR'),
  idempotency(),
  asyncHandler(async (req, res) => {
    const body = validate(req.body, {
      shopId: { ...id, required: true },
      medicineId: { ...id, required: true },
      quantity: { type: 'integer', min: 1, max: 10000, required: true },
      urgency: { type: 'enum', values: Object.values(RequestUrgency), default: 'ROUTINE' },
      doctorNote: { type: 'string', max: 500, nullable: true },
      patientId: { ...id, nullable: true },
      prescriptionId: { ...id, nullable: true },
    });
    res.status(201).json(await requests.create(req.user.id, body));
  })
);

// GET /requests?mine — DOCTOR: own requests, newest first (C3)
// GET /requests?shopId= — shop staff / ADMIN: the shop's inbox, by status (C3)
// Both take &status=&limit=&offset=; requests sharing a prescription are grouped.
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const filters = {
      ...validate(req.query, {
        status: { type: 'enum', values: Object.values(RequestStatus) },
        shopId: id,
        mine: { type: 'string', nullable: true }, // presence flag: ?mine or ?mine=true
      }),
      ...pagination(req.query),
    };
    if (req.user.role === 'DOCTOR') {
      if (filters.shopId) throw AppError.forbidden('Doctors can only list their own requests');
      return res.json(await requests.listForDoctor(req.user.id, filters));
    }
    if (!filters.shopId) throw AppError.validation([{ field: 'shopId', issue: 'required for the shop inbox' }]);
    await shopAccess.assertStaff(req.user, filters.shopId);
    res.json(await requests.listForShop(filters.shopId, filters));
  })
);

// GET /requests/:id — the doctor who sent it, staff of its shop, or ADMIN
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json(await requests.getForUser(req.user, idParam(req.params.id, 'Request')));
  })
);

module.exports = router;
