'use strict';

const { AppError } = require('../shared/errors');
const { verifyToken } = require('../shared/jwt');
const asyncHandler = require('../shared/asyncHandler');
const users = require('../modules/users/users.service');

/**
 * authenticate — requires `Authorization: Bearer <jwt>`.
 * Loads the user on every request so a deactivated user is locked out
 * immediately, even with an unexpired token. Sets req.user (public shape).
 */
const authenticate = asyncHandler(async (req, res, next) => {
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) throw new AppError('UNAUTHENTICATED');

  const { userId } = verifyToken(token);
  const user = await users.getById(userId);
  if (!user) throw new AppError('UNAUTHENTICATED', 'User no longer exists');
  if (!user.isActive) throw new AppError('ACCOUNT_INACTIVE');

  req.user = user;
  next();
});

module.exports = { authenticate };
