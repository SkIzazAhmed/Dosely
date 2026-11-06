'use strict';

const express = require('express');
const asyncHandler = require('../../shared/asyncHandler');
const { AppError } = require('../../shared/errors');
const { validate } = require('../../shared/validate');
const { verifyPassword, DUMMY_HASH, MAX_LENGTH } = require('../../shared/password');
const { signToken } = require('../../shared/jwt');
const config = require('../../config');
const { authenticate } = require('../../middleware/auth');
const users = require('../users/users.service');
const doctors = require('../doctors/doctors.service');

const router = express.Router();

// POST /auth/login { email, password } → { token, tokenType, expiresIn, user }
// (Login by phone number is added with the phones module in Commit 4.)
router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { email, password } = validate(req.body, {
      email: { type: 'email', required: true },
      password: { type: 'password', required: true, max: MAX_LENGTH },
    });

    const row = await users.findForLogin(email);
    const ok = await verifyPassword(password, row ? row.password_hash : DUMMY_HASH);
    if (!row || !ok) throw new AppError('INVALID_CREDENTIALS');
    if (!row.is_active) throw new AppError('ACCOUNT_INACTIVE');

    await users.recordLogin(row.id);
    const user = await users.getById(row.id);
    res.json({ token: signToken(user), tokenType: 'Bearer', expiresIn: config.auth.jwtExpiresIn, user });
  })
);

// GET /auth/me → { user, doctor? }
router.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    const out = { user: req.user };
    if (req.user.role === 'DOCTOR') out.doctor = await doctors.getByUserId(req.user.id);
    res.json(out);
  })
);

module.exports = router;
