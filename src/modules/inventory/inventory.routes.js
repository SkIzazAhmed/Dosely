'use strict';

/**
 * Stock routes (mounted at /shops).
 *
 *   POST /shops/:shopId/stock-in    any active staff of the shop (or ADMIN), Idempotency-Key
 *
 * Coming next: POST /shops/:shopId/dispense (Nov 10), POST /shops/:shopId/adjustments (Nov 10),
 * GET /shops/:shopId/inventory?low=true&expiring=90 (Nov 12).
 *
 * Middleware is attached per route (not router.use) because Izaz's shops
 * router shares the /shops prefix.
 */

const express = require('express');
const asyncHandler = require('../../shared/asyncHandler');
const { validate, idParam } = require('../../shared/validate');
const { authenticate } = require('../../middleware/auth');
const { requireShopStaff } = require('../../middleware/rbac');
const { idempotency } = require('../../middleware/idempotency');
const stock = require('./stock.service');

const router = express.Router();

// POST /shops/:shopId/stock-in
// { medicineId, batchNo, manufactureDate?, expiryDate, mrp, quantity, reason? }
router.post(
  '/:shopId/stock-in',
  authenticate,
  requireShopStaff(),
  idempotency(),
  asyncHandler(async (req, res) => {
    const shopId = idParam(req.params.shopId, 'Shop');
    const body = validate(req.body, {
      medicineId: { type: 'integer', min: 1, required: true },
      quantity: { type: 'integer', min: 1, max: 1000000, required: true },
      reason: { type: 'string', max: 500 },
    });
    const result = await stock.stockIn({
      ...body,
      shopId,
      batchNo: req.body.batchNo,
      manufactureDate: req.body.manufactureDate,
      expiryDate: req.body.expiryDate,
      mrp: req.body.mrp,
      performedBy: req.user.id,
      idempotencyKey: req.get('Idempotency-Key'),
    });
    res.status(201).json(result);
  })
);

module.exports = router;
