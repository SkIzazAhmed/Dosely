'use strict';

const express = require('express');
const asyncHandler = require('../../shared/asyncHandler');
const { AppError } = require('../../shared/errors');
const { validate, idParam, pagination } = require('../../shared/validate');
const { authenticate } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const { idempotency } = require('../../middleware/idempotency');
const doctors = require('./doctors.service');

const router = express.Router();
router.use(authenticate);

const profileSchema = {
  registrationNo: { type: 'string', nullable: true, min: 3, max: 50 },
  specialization: { type: 'string', nullable: true, max: 100 },
  qualification: { type: 'string', nullable: true, max: 100 },
  clinicName: { type: 'string', nullable: true, max: 150 },
};

async function loadAndAuthorize(req) {
  const doctor = await doctors.getByIdOrThrow(idParam(req.params.id, 'Doctor'));
  if (req.user.role !== 'ADMIN' && doctor.userId !== req.user.id) throw new AppError('FORBIDDEN');
  return doctor;
}

// POST /doctors — a DOCTOR creates their own profile; ADMIN passes userId
router.post(
  '/',
  requireRole('DOCTOR', 'ADMIN'),
  idempotency(),
  asyncHandler(async (req, res) => {
    const body = validate(req.body, { ...profileSchema, userId: { type: 'integer', min: 1 } });
    let userId = req.user.id;
    if (req.user.role === 'ADMIN') {
      if (!body.userId) throw AppError.validation([{ field: 'userId', issue: 'required when an ADMIN creates a profile' }]);
      userId = body.userId;
    } else if (body.userId && body.userId !== req.user.id) {
      throw new AppError('FORBIDDEN', 'You can only create your own doctor profile');
    }
    delete body.userId;
    res.status(201).json(await doctors.create(userId, body));
  })
);

// GET /doctors/me — the logged-in doctor's profile
router.get(
  '/me',
  requireRole('DOCTOR'),
  asyncHandler(async (req, res) => {
    const d = await doctors.getByUserId(req.user.id);
    if (!d) throw AppError.notFound('Doctor profile');
    res.json(d);
  })
);

// GET /doctors?search=&isActive=&limit=&offset= — any logged-in user
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const filters = validate(req.query, { search: { type: 'string', max: 100 }, isActive: { type: 'boolean' } });
    res.json(await doctors.list({ ...filters, ...pagination(req.query) }));
  })
);

// GET /doctors/:id
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json(await doctors.getByIdOrThrow(idParam(req.params.id, 'Doctor')));
  })
);

// PATCH /doctors/:id — the doctor themself or ADMIN
router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const doctor = await loadAndAuthorize(req);
    const patch = validate(req.body, profileSchema, { partial: true });
    res.json(await doctors.update(doctor.id, patch));
  })
);

// DELETE /doctors/:id — ADMIN deactivates
router.delete(
  '/:id',
  requireRole('ADMIN'),
  asyncHandler(async (req, res) => {
    res.json(await doctors.setActive(idParam(req.params.id, 'Doctor'), false));
  })
);

// POST /doctors/:id/activate — ADMIN
router.post(
  '/:id/activate',
  requireRole('ADMIN'),
  asyncHandler(async (req, res) => {
    res.json(await doctors.setActive(idParam(req.params.id, 'Doctor'), true));
  })
);

module.exports = router;
