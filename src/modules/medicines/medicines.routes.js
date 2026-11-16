'use strict';

/**
 * Catalog routes (B1–B3).
 *
 *   GET    /medicines?q=&genericId=&dosageForm=&prescriptionRequired=&isActive=&limit=&offset=   logged in
 *   GET    /medicines/:id                       logged in (+ sellable batches)
 *   POST   /medicines                           ADMIN, Idempotency-Key
 *   PATCH  /medicines/:id                       ADMIN
 *   POST   /medicines/:id/deactivate            ADMIN
 *   POST   /medicines/:id/activate              ADMIN
 *   DELETE /medicines/:id                       ADMIN; 409 MEDICINE_IN_USE once it has a batch
 *   GET    /medicines/:id/batches?includeExpired=true   logged in
 *   POST   /medicines/:id/batches               ADMIN, Idempotency-Key
 *   GET    /medicines/:id/availability?shopIds=1,2   logged in (B10: units per active shop)
 *
 * Non-admins only see active medicines.
 */

const express = require('express');
const asyncHandler = require('../../shared/asyncHandler');
const { AppError } = require('../../shared/errors');
const { validate, idParam, pagination } = require('../../shared/validate');
const { DosageForm, BaseUnit } = require('../../shared/enums');
const { authenticate } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const { idempotency } = require('../../middleware/idempotency');
const medicines = require('./medicine.service');
const batches = require('./batch.service');
const stock = require('../inventory/stock.service');

const router = express.Router();
router.use(authenticate);

const isAdmin = (req) => req.user.role === 'ADMIN';

const medicineSchema = {
  brandName: { type: 'string', required: true, max: 200 },
  genericId: { type: 'integer', min: 1 },
  genericName: { type: 'string', max: 200 },
  manufacturer: { type: 'string', required: true, max: 200 },
  dosageForm: { type: 'enum', values: Object.keys(DosageForm), required: true },
  strength: { type: 'string', required: true, max: 50 },
  baseUnit: { type: 'enum', values: Object.keys(BaseUnit), required: true },
  prescriptionRequired: { type: 'boolean', default: true },
};

// GET /medicines — catalog search for every logged-in user
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const filters = validate(req.query, {
      q: { type: 'string', max: 100 },
      genericId: { type: 'integer', min: 1 },
      dosageForm: { type: 'enum', values: Object.keys(DosageForm) },
      prescriptionRequired: { type: 'boolean' },
      isActive: { type: 'boolean' },
    });
    if (!isAdmin(req)) filters.isActive = true;
    res.json(await medicines.search({ ...filters, ...pagination(req.query) }));
  })
);

// POST /medicines — ADMIN; optional `batches: [{ batchNo, manufactureDate?, expiryDate, mrp }]`
router.post(
  '/',
  requireRole('ADMIN'),
  idempotency(),
  asyncHandler(async (req, res) => {
    const body = validate(req.body, medicineSchema);
    if (body.genericId && body.genericName) {
      throw AppError.validation([{ field: 'genericName', issue: 'send genericId or genericName, not both' }]);
    }
    const raw = req.body && req.body.batches;
    if (raw !== undefined && (!Array.isArray(raw) || raw.length > 50)) {
      throw AppError.validation([{ field: 'batches', issue: 'must be an array of at most 50 batches' }]);
    }
    res.status(201).json(await medicines.create({ ...body, batches: raw }));
  })
);

async function loadVisible(req) {
  const id = idParam(req.params.id, 'Medicine');
  const m = await medicines.getByIdOrThrow(id);
  if (!m.isActive && !isAdmin(req)) throw AppError.notFound('Medicine', id);
  return m;
}

// GET /medicines/:id — medicine + its sellable batches
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const m = await loadVisible(req);
    res.json(await medicines.getWithBatches(m.id));
  })
);

// PATCH /medicines/:id — ADMIN
router.patch(
  '/:id',
  requireRole('ADMIN'),
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id, 'Medicine');
    const { genericName, ...patchSchema } = medicineSchema; // eslint-disable-line no-unused-vars
    const patch = validate(req.body, patchSchema, { partial: true });
    res.json(await medicines.update(id, patch));
  })
);

// POST /medicines/:id/deactivate, /activate — ADMIN
router.post(
  '/:id/deactivate',
  requireRole('ADMIN'),
  asyncHandler(async (req, res) => {
    res.json(await medicines.setActive(idParam(req.params.id, 'Medicine'), false));
  })
);
router.post(
  '/:id/activate',
  requireRole('ADMIN'),
  asyncHandler(async (req, res) => {
    res.json(await medicines.setActive(idParam(req.params.id, 'Medicine'), true));
  })
);

// DELETE /medicines/:id — ADMIN; only while it has no batches
router.delete(
  '/:id',
  requireRole('ADMIN'),
  asyncHandler(async (req, res) => {
    res.json(await medicines.remove(idParam(req.params.id, 'Medicine')));
  })
);

// GET /medicines/:id/batches?includeExpired=true
router.get(
  '/:id/batches',
  asyncHandler(async (req, res) => {
    const m = await loadVisible(req);
    const { includeExpired } = validate(req.query, { includeExpired: { type: 'boolean', default: false } });
    res.json({ items: await batches.listForMedicine(m.id, { includeExpired }) });
  })
);

// POST /medicines/:id/batches — ADMIN
router.post(
  '/:id/batches',
  requireRole('ADMIN'),
  idempotency(),
  asyncHandler(async (req, res) => {
    res.status(201).json(await medicines.addBatch(idParam(req.params.id, 'Medicine'), req.body));
  })
);

// GET /medicines/:id/availability?shopIds=1,2 — non-expired, unreserved units per active shop (B10)
router.get(
  '/:id/availability',
  asyncHandler(async (req, res) => {
    const m = await loadVisible(req);
    let shopIds;
    if (req.query.shopIds !== undefined) {
      shopIds = String(req.query.shopIds).split(',').filter(Boolean).map(Number);
      if (shopIds.length === 0 || shopIds.length > 100 || shopIds.some((n) => !Number.isInteger(n) || n <= 0)) {
        throw AppError.validation([{ field: 'shopIds', issue: 'must be a comma-separated list of shop ids' }]);
      }
    }
    res.json({ medicineId: m.id, items: await stock.getAvailable(m.id, { shopIds }) });
  })
);

module.exports = router;
