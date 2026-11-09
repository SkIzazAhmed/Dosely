'use strict';

const express = require('express');
const asyncHandler = require('../../shared/asyncHandler');
const { AppError } = require('../../shared/errors');
const { validate, idParam, pagination } = require('../../shared/validate');
const { Gender } = require('../../shared/enums');
const { authenticate } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const { idempotency } = require('../../middleware/idempotency');
const patients = require('./patients.service');

const router = express.Router();
// Patients have no login (A8). Doctors, shop staff and admins manage them.
router.use(authenticate, requireRole('DOCTOR', 'SHOPKEEPER', 'ADMIN'));

const patientSchema = {
  fullName: { type: 'string', required: true, max: 120 },
  dateOfBirth: { type: 'date', nullable: true, notFuture: true, minDate: '1900-01-01' },
  gender: { type: 'enum', values: Object.values(Gender), nullable: true },
};

// POST /patients { fullName, dateOfBirth?, gender? }
router.post(
  '/',
  idempotency(),
  asyncHandler(async (req, res) => {
    const body = validate(req.body, patientSchema);
    res.status(201).json(await patients.create(body, req.user.id));
  })
);

// GET /patients?search=&isActive=&mine=true&limit=&offset=
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { mine, ...filters } = validate(req.query, {
      search: { type: 'string', max: 100 },
      isActive: { type: 'boolean' },
      mine: { type: 'boolean' },
    });
    res.json(await patients.list({ ...filters, createdBy: mine ? req.user.id : undefined, ...pagination(req.query) }));
  })
);

// GET /patients/:id
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json(await patients.getByIdOrThrow(idParam(req.params.id, 'Patient')));
  })
);

// PATCH /patients/:id
router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id, 'Patient');
    const patch = validate(req.body, patientSchema, { partial: true });
    const current = await patients.getByIdOrThrow(id);
    if (!current.isActive) throw new AppError('PATIENT_INACTIVE', undefined, { patientId: id });
    res.json(await patients.update(id, patch));
  })
);

// DELETE /patients/:id — deactivate (ADMIN or whoever created the record)
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id, 'Patient');
    const current = await patients.getByIdOrThrow(id);
    if (req.user.role !== 'ADMIN' && current.createdBy !== req.user.id) {
      throw new AppError('FORBIDDEN', 'Only an ADMIN or the person who added this patient can deactivate them');
    }
    res.json(await patients.setActive(id, false));
  })
);

// POST /patients/:id/activate — ADMIN
router.post(
  '/:id/activate',
  requireRole('ADMIN'),
  asyncHandler(async (req, res) => {
    res.json(await patients.setActive(idParam(req.params.id, 'Patient'), true));
  })
);

module.exports = router;
