'use strict';

/**
 * Stock routes (mounted at /shops). All need an Idempotency-Key.
 *
 *   POST /shops/:shopId/stock-in      shop staff (or ADMIN)     B4–B7
 *   POST /shops/:shopId/dispense      shop staff (or ADMIN)     B8
 *   POST /shops/:shopId/adjustments   shop OWNER (or ADMIN)     B9
 *   POST /shops/:shopId/write-offs    shop OWNER (or ADMIN)     B9
 *   GET  /shops/:shopId/inventory     shop staff  ?low=true&expiring=90&medicineId=&q=&expired=true&includeEmpty=true
 *   GET  /shops/:shopId/movements     shop staff  ?batchId=&medicineId=&type=
 *   GET  /shops/:shopId/thresholds    shop staff  ?low=true
 *   PUT  /shops/:shopId/thresholds/:medicineId   shop OWNER  { minQuantity }
 *   DELETE /shops/:shopId/thresholds/:medicineId shop OWNER
 *
 * Middleware is attached per route (not router.use) because the shops
 * router shares the /shops prefix.
 */

const express = require('express');
const asyncHandler = require('../../shared/asyncHandler');
const { validate, idParam, pagination } = require('../../shared/validate');
const { StockMovementType } = require('../../shared/enums');
const inventoryModel = require('./inventory.model');
const movementModel = require('./movement.model');
const thresholds = require('./threshold.service');
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

// POST /shops/:shopId/dispense
// { medicineId, quantity, requestId?, referralId?, reservation?: [{ batchId, quantity }], reason? }
router.post(
  '/:shopId/dispense',
  authenticate,
  requireShopStaff(),
  idempotency(),
  asyncHandler(async (req, res) => {
    const shopId = idParam(req.params.shopId, 'Shop');
    const body = validate(req.body, {
      medicineId: { type: 'integer', min: 1, required: true },
      quantity: { type: 'integer', min: 1, max: 1000000, required: true },
      requestId: { type: 'integer', min: 1 },
      referralId: { type: 'integer', min: 1 },
      reason: { type: 'string', max: 500 },
    });
    const result = await stock.dispense({
      ...body,
      shopId,
      reservation: req.body.reservation,
      performedBy: req.user.id,
      idempotencyKey: req.get('Idempotency-Key'),
    });
    res.status(201).json(result);
  })
);

// POST /shops/:shopId/adjustments — OWNER
// { batchId, delta, expectedVersion, reason }
router.post(
  '/:shopId/adjustments',
  authenticate,
  requireShopStaff({ owner: true }),
  idempotency(),
  asyncHandler(async (req, res) => {
    const shopId = idParam(req.params.shopId, 'Shop');
    const body = validate(req.body, {
      batchId: { type: 'integer', min: 1, required: true },
      delta: { type: 'integer', min: -1000000, max: 1000000, required: true },
      expectedVersion: { type: 'integer', min: 0, required: true },
    });
    const result = await stock.adjust({
      ...body,
      shopId,
      reason: req.body.reason,
      performedBy: req.user.id,
      idempotencyKey: req.get('Idempotency-Key'),
    });
    res.status(201).json(result);
  })
);

// POST /shops/:shopId/write-offs — OWNER
// { batchId, quantity?, expectedVersion?, reason }   quantity defaults to all unreserved units
router.post(
  '/:shopId/write-offs',
  authenticate,
  requireShopStaff({ owner: true }),
  idempotency(),
  asyncHandler(async (req, res) => {
    const shopId = idParam(req.params.shopId, 'Shop');
    const body = validate(req.body, {
      batchId: { type: 'integer', min: 1, required: true },
      quantity: { type: 'integer', min: 1, max: 1000000 },
      expectedVersion: { type: 'integer', min: 0 },
    });
    const result = await stock.writeOff({
      ...body,
      shopId,
      reason: req.body.reason,
      performedBy: req.user.id,
      idempotencyKey: req.get('Idempotency-Key'),
    });
    res.status(201).json(result);
  })
);

// GET /shops/:shopId/inventory — one row per batch, earliest expiry first.
// Each row carries `version`: send it back as expectedVersion on adjustments.
router.get(
  '/:shopId/inventory',
  authenticate,
  requireShopStaff(),
  asyncHandler(async (req, res) => {
    const shopId = idParam(req.params.shopId, 'Shop');
    const f = validate(req.query, {
      medicineId: { type: 'integer', min: 1 },
      q: { type: 'string', max: 100 },
      low: { type: 'boolean', default: false },
      expiring: { type: 'integer', min: 1, max: 365 },
      expired: { type: 'boolean', default: false },
      includeEmpty: { type: 'boolean', default: false },
    });
    res.json(await inventoryModel.listForShop(shopId, f, pagination(req.query)));
  })
);

// GET /shops/:shopId/movements — ledger, newest first
router.get(
  '/:shopId/movements',
  authenticate,
  requireShopStaff(),
  asyncHandler(async (req, res) => {
    const shopId = idParam(req.params.shopId, 'Shop');
    const f = validate(req.query, {
      batchId: { type: 'integer', min: 1 },
      medicineId: { type: 'integer', min: 1 },
      type: { type: 'enum', values: Object.keys(StockMovementType) },
    });
    res.json(await movementModel.listForShop(shopId, f, pagination(req.query)));
  })
);

// GET /shops/:shopId/thresholds?low=true — reorder levels with current availability
router.get(
  '/:shopId/thresholds',
  authenticate,
  requireShopStaff(),
  asyncHandler(async (req, res) => {
    const shopId = idParam(req.params.shopId, 'Shop');
    const { low } = validate(req.query, { low: { type: 'boolean', default: false } });
    res.json(await thresholds.list(shopId, { low, ...pagination(req.query) }));
  })
);

// PUT /shops/:shopId/thresholds/:medicineId { minQuantity } — OWNER
router.put(
  '/:shopId/thresholds/:medicineId',
  authenticate,
  requireShopStaff({ owner: true }),
  asyncHandler(async (req, res) => {
    const shopId = idParam(req.params.shopId, 'Shop');
    const medicineId = idParam(req.params.medicineId, 'Medicine');
    const { minQuantity } = validate(req.body, { minQuantity: { type: 'integer', min: 1, max: 1000000, required: true } });
    res.json(await thresholds.set(shopId, medicineId, minQuantity, req.user.id));
  })
);

// DELETE /shops/:shopId/thresholds/:medicineId — OWNER
router.delete(
  '/:shopId/thresholds/:medicineId',
  authenticate,
  requireShopStaff({ owner: true }),
  asyncHandler(async (req, res) => {
    const shopId = idParam(req.params.shopId, 'Shop');
    res.json(await thresholds.remove(shopId, idParam(req.params.medicineId, 'Medicine')));
  })
);

module.exports = router;
