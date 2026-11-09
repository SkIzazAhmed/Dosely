'use strict';

const express = require('express');
const asyncHandler = require('../../shared/asyncHandler');
const { AppError } = require('../../shared/errors');
const { validate, idParam, pagination } = require('../../shared/validate');
const { StaffRole } = require('../../shared/enums');
const { authenticate } = require('../../middleware/auth');
const { requireRole, requireShopStaff } = require('../../middleware/rbac');
const { idempotency } = require('../../middleware/idempotency');
const shops = require('./shops.service');

const router = express.Router();
router.use(authenticate);

const PINCODE = /^[1-9][0-9]{5}$/;
const CODE = /^[A-Z0-9][A-Z0-9-]{2,19}$/;

const shopSchema = {
  name: { type: 'string', required: true, min: 2, max: 120 },
  code: { type: 'string', required: true, pattern: CODE, patternMessage: '3–20 letters, digits or hyphens (stored uppercase)' },
  drugLicenceNo: { type: 'string', required: true, min: 5, max: 60 },
  address: { type: 'string', required: true, min: 5, max: 300 },
  area: { type: 'string', required: true, min: 2, max: 100 },
  city: { type: 'string', nullable: true, max: 100 },
  pincode: { type: 'string', required: true, pattern: PINCODE, patternMessage: 'must be a 6-digit pincode' },
  latitude: { type: 'number', nullable: true, min: -90, max: 90 },
  longitude: { type: 'number', nullable: true, min: -180, max: 180 },
};

/** Uppercase the code before validating, so "dsl-001" is accepted as "DSL-001". */
function normalise(body) {
  if (body && typeof body.code === 'string') return { ...body, code: body.code.trim().toUpperCase() };
  return body;
}

/** Latitude and longitude: both or neither (A6). For PATCH, checked against the stored values. */
function assertCoordinates(lat, lng) {
  if ((lat === null || lat === undefined) !== (lng === null || lng === undefined)) {
    throw new AppError('INVALID_COORDINATES', undefined, [
      { field: lat == null ? 'latitude' : 'longitude', issue: 'latitude and longitude must both be set or both be empty' },
    ]);
  }
}

function pincodeError(err) {
  // Surface the specific code the PRD names instead of a generic validation error.
  if (err.code === 'VALIDATION_ERROR' && Array.isArray(err.details) && err.details.length === 1 && err.details[0].field === 'pincode') {
    return new AppError('INVALID_PINCODE', undefined, err.details);
  }
  return err;
}

// ---------------------------------------------------------------------------
// Shops
// ---------------------------------------------------------------------------

// POST /shops — a SHOPKEEPER creates a shop and becomes its OWNER;
// an ADMIN must pass ownerUserId (a SHOPKEEPER).
router.post(
  '/',
  requireRole('SHOPKEEPER', 'ADMIN'),
  idempotency(),
  asyncHandler(async (req, res) => {
    let body;
    try {
      body = validate(normalise(req.body), { ...shopSchema, ownerUserId: { type: 'integer', min: 1 } });
    } catch (err) {
      throw pincodeError(err);
    }
    assertCoordinates(body.latitude, body.longitude);

    let ownerUserId = req.user.id;
    if (req.user.role === 'ADMIN') {
      if (!body.ownerUserId) throw AppError.validation([{ field: 'ownerUserId', issue: 'required when an ADMIN creates a shop' }]);
      ownerUserId = body.ownerUserId;
    } else if (body.ownerUserId && body.ownerUserId !== req.user.id) {
      throw new AppError('FORBIDDEN', 'Shopkeepers can only create shops they own');
    }
    delete body.ownerUserId;
    res.status(201).json(await shops.create(body, ownerUserId));
  })
);

// GET /shops?search=&area=&pincode=&isActive=&mine=true&limit=&offset=
// Any logged-in user (doctors pick shops from here). mine=true → shops I work at.
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const f = validate(req.query, {
      search: { type: 'string', max: 100 },
      area: { type: 'string', max: 100 },
      pincode: { type: 'string', pattern: PINCODE, patternMessage: 'must be a 6-digit pincode' },
      isActive: { type: 'boolean' },
      mine: { type: 'boolean' },
    });
    const { mine, ...filters } = f;
    res.json(await shops.list({ ...filters, staffUserId: mine ? req.user.id : undefined, ...pagination(req.query) }));
  })
);

// GET /shops/:shopId — any logged-in user; includes myRole if caller is staff
router.get(
  '/:shopId',
  asyncHandler(async (req, res) => {
    const shopId = idParam(req.params.shopId, 'Shop');
    const shop = await shops.getByIdOrThrow(shopId);
    const me = await shops.getStaff(shopId, req.user.id);
    res.json({ ...shop, myRole: me && me.isActive ? me.staffRole : null });
  })
);

// PATCH /shops/:shopId — OWNER or ADMIN
router.patch(
  '/:shopId',
  requireShopStaff({ owner: true }),
  asyncHandler(async (req, res) => {
    let patch;
    try {
      patch = validate(normalise(req.body), shopSchema, { partial: true });
    } catch (err) {
      throw pincodeError(err);
    }
    if ('latitude' in patch || 'longitude' in patch) {
      const current = await shops.getByIdOrThrow(req.shopStaff.shopId);
      assertCoordinates(
        'latitude' in patch ? patch.latitude : current.latitude,
        'longitude' in patch ? patch.longitude : current.longitude
      );
    }
    res.json(await shops.update(req.shopStaff.shopId, patch));
  })
);

// DELETE /shops/:shopId — OWNER or ADMIN deactivates; inactive shops can't receive requests
router.delete(
  '/:shopId',
  requireShopStaff({ owner: true }),
  asyncHandler(async (req, res) => {
    res.json(await shops.setActive(req.shopStaff.shopId, false));
  })
);

// POST /shops/:shopId/activate — OWNER or ADMIN
router.post(
  '/:shopId/activate',
  requireShopStaff({ owner: true }),
  asyncHandler(async (req, res) => {
    res.json(await shops.setActive(req.shopStaff.shopId, true));
  })
);

// ---------------------------------------------------------------------------
// Staff (A7) — anyone on staff can view; only OWNER (or ADMIN) edits
// ---------------------------------------------------------------------------

// GET /shops/:shopId/staff?includeRemoved=true
router.get(
  '/:shopId/staff',
  requireShopStaff(),
  asyncHandler(async (req, res) => {
    const { includeRemoved } = validate(req.query, { includeRemoved: { type: 'boolean' } });
    await shops.getByIdOrThrow(req.shopStaff.shopId);
    res.json({ items: await shops.listStaff(req.shopStaff.shopId, { includeRemoved: Boolean(includeRemoved) }) });
  })
);

// POST /shops/:shopId/staff { userId, staffRole? = STAFF }
router.post(
  '/:shopId/staff',
  requireShopStaff({ owner: true }),
  idempotency(),
  asyncHandler(async (req, res) => {
    const body = validate(req.body, {
      userId: { type: 'integer', min: 1, required: true },
      staffRole: { type: 'enum', values: Object.values(StaffRole), default: 'STAFF' },
    });
    res.status(201).json(await shops.addStaff(req.shopStaff.shopId, body.userId, body.staffRole, req.user.id));
  })
);

// PATCH /shops/:shopId/staff/:userId { staffRole }
router.patch(
  '/:shopId/staff/:userId',
  requireShopStaff({ owner: true }),
  asyncHandler(async (req, res) => {
    const userId = idParam(req.params.userId, 'Staff member');
    const { staffRole } = validate(req.body, { staffRole: { type: 'enum', values: Object.values(StaffRole), required: true } });
    res.json(await shops.changeStaffRole(req.shopStaff.shopId, userId, staffRole));
  })
);

// DELETE /shops/:shopId/staff/:userId — remove (deactivate) a staff member
router.delete(
  '/:shopId/staff/:userId',
  requireShopStaff({ owner: true }),
  asyncHandler(async (req, res) => {
    const userId = idParam(req.params.userId, 'Staff member');
    res.json(await shops.removeStaff(req.shopStaff.shopId, userId));
  })
);

module.exports = router;
