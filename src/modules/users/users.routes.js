'use strict';

const express = require('express');
const asyncHandler = require('../../shared/asyncHandler');
const { AppError } = require('../../shared/errors');
const { validate, idParam, pagination } = require('../../shared/validate');
const { UserRole } = require('../../shared/enums');
const { MIN_LENGTH, MAX_LENGTH, verifyPassword } = require('../../shared/password');
const { authenticate } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const { idempotency } = require('../../middleware/idempotency');
const { query } = require('../../db/pool');
const users = require('./users.service');

const router = express.Router();
router.use(authenticate);

const createSchema = {
  role: { type: 'enum', values: Object.values(UserRole), required: true },
  fullName: { type: 'string', required: true, max: 120 },
  email: { type: 'email', nullable: true },
  password: { type: 'password', required: true, min: MIN_LENGTH, max: MAX_LENGTH },
};

const updateSchema = {
  fullName: { type: 'string', max: 120 },
  email: { type: 'email', nullable: true },
  password: { type: 'password', min: MIN_LENGTH, max: MAX_LENGTH },
  currentPassword: { type: 'password', max: MAX_LENGTH },
};

function assertSelfOrAdmin(req, id) {
  if (req.user.role !== 'ADMIN' && req.user.id !== id) throw new AppError('FORBIDDEN');
}

// POST /users — ADMIN creates a user of any role
router.post(
  '/',
  requireRole('ADMIN'),
  idempotency(),
  asyncHandler(async (req, res) => {
    const body = validate(req.body, createSchema);
    res.status(201).json(await users.create(body));
  })
);

// GET /users?role=DOCTOR&isActive=true&search=ana&limit=20&offset=0 — ADMIN
router.get(
  '/',
  requireRole('ADMIN'),
  asyncHandler(async (req, res) => {
    const filters = validate(req.query, {
      role: { type: 'enum', values: Object.values(UserRole) },
      isActive: { type: 'boolean' },
      search: { type: 'string', max: 100 },
    });
    res.json(await users.list({ ...filters, ...pagination(req.query) }));
  })
);

// GET /users/:id — self or ADMIN
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id, 'User');
    assertSelfOrAdmin(req, id);
    res.json(await users.getByIdOrThrow(id));
  })
);

// PATCH /users/:id — self (password change needs currentPassword) or ADMIN.
// Role can't be changed; create a new user instead.
router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id, 'User');
    assertSelfOrAdmin(req, id);
    if (req.body && 'role' in req.body) {
      throw AppError.validation([{ field: 'role', issue: 'cannot be changed; create a new user instead' }]);
    }
    const { currentPassword, ...patch } = validate(req.body, updateSchema, { partial: true });

    if (patch.password !== undefined && req.user.role !== 'ADMIN') {
      if (!currentPassword) throw AppError.validation([{ field: 'currentPassword', issue: 'required to change password' }]);
      const { rows: [row] } = await query('SELECT password_hash FROM users WHERE id = $1', [id]);
      if (!row || !(await verifyPassword(currentPassword, row.password_hash))) {
        throw new AppError('INVALID_CREDENTIALS', 'Current password is incorrect');
      }
    }
    res.json(await users.update(id, patch));
  })
);

// DELETE /users/:id — ADMIN deactivates (never a hard delete)
router.delete(
  '/:id',
  requireRole('ADMIN'),
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id, 'User');
    if (id === req.user.id) throw new AppError('CONFLICT', 'You cannot deactivate your own account');
    res.json(await users.setActive(id, false));
  })
);

// POST /users/:id/activate — ADMIN re-activates
router.post(
  '/:id/activate',
  requireRole('ADMIN'),
  asyncHandler(async (req, res) => {
    res.json(await users.setActive(idParam(req.params.id, 'User'), true));
  })
);

module.exports = router;
