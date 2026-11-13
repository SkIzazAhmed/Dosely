'use strict';

const express = require('express');
const asyncHandler = require('../../shared/asyncHandler');
const { validate } = require('../../shared/validate');
const { authenticate } = require('../../middleware/auth');
const availability = require('./availability.service');

const router = express.Router();
router.use(authenticate);

// GET /inventory/availability?medicine_id&min_qty[&near_shop_id][&limit] (C6)
// Any logged-in user. Shops with at least min_qty non-expired, unreserved
// units, ranked by distance from near_shop_id, then same pincode, then same area.
router.get(
  '/availability',
  asyncHandler(async (req, res) => {
    const q = validate(req.query, {
      medicine_id: { type: 'integer', min: 1, required: true },
      min_qty: { type: 'integer', min: 1, max: 10000, default: 1 },
      near_shop_id: { type: 'integer', min: 1 },
      limit: { type: 'integer', min: 1, max: 50, default: 20 },
    });
    const items = await availability.lookup({
      medicineId: q.medicine_id, minQty: q.min_qty, nearShopId: q.near_shop_id, limit: q.limit,
    });
    res.json({ medicineId: q.medicine_id, minQty: q.min_qty, items });
  })
);

module.exports = router;
