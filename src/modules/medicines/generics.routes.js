'use strict';

/**
 * Generic (salt) routes (B1).
 *
 *   GET   /generics?q=&isActive=&limit=&offset=   logged in (non-admins: active only)
 *   GET   /generics/:id                          logged in
 *   POST  /generics                              ADMIN, Idempotency-Key
 *   PATCH /generics/:id                          ADMIN  { name?, description?, isActive? }
 */

const express = require('express');
const asyncHandler = require('../../shared/asyncHandler');
const { AppError } = require('../../shared/errors');
const { validate, idParam, pagination } = require('../../shared/validate');
const { authenticate } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const { idempotency } = require('../../middleware/idempotency');
const generics = require('./generic.service');

const router = express.Router();
router.use(authenticate);

const schema = {
  name: { type: 'string', required: true, max: 200 },
  description: { type: 'string', nullable: true, max: 1000 },
};

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const filters = validate(req.query, { q: { type: 'string', max: 100 }, isActive: { type: 'boolean' } });
    if (req.user.role !== 'ADMIN') filters.isActive = true;
    res.json(await generics.list({ ...filters, ...pagination(req.query) }));
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id, 'Generic');
    const g = await generics.getByIdOrThrow(id);
    if (!g.isActive && req.user.role !== 'ADMIN') throw AppError.notFound('Generic', id);
    res.json(g);
  })
);

router.post(
  '/',
  requireRole('ADMIN'),
  idempotency(),
  asyncHandler(async (req, res) => {
    res.status(201).json(await generics.create(validate(req.body, schema)));
  })
);

router.patch(
  '/:id',
  requireRole('ADMIN'),
  asyncHandler(async (req, res) => {
    const patch = validate(req.body, { ...schema, isActive: { type: 'boolean' } }, { partial: true });
    res.json(await generics.update(idParam(req.params.id, 'Generic'), patch));
  })
);

module.exports = router;
