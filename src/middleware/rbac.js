'use strict';

const { AppError } = require('../shared/errors');
const asyncHandler = require('../shared/asyncHandler');
const { query } = require('../db/pool');

/**
 * requireRole('ADMIN') / requireRole('DOCTOR', 'ADMIN')
 * Use after authenticate.
 */
function requireRole(...roles) {
  if (roles.length === 0) throw new Error('requireRole needs at least one role');
  return function roleGuard(req, res, next) {
    if (!req.user) return next(new AppError('UNAUTHENTICATED'));
    if (!roles.includes(req.user.role)) {
      return next(new AppError('FORBIDDEN', `Requires role: ${roles.join(' or ')}`, { required: roles, actual: req.user.role }));
    }
    next();
  };
}

/**
 * requireShopStaff({ owner: true, param: 'shopId' })
 * Caller must be active staff (or OWNER when owner: true) of the shop in
 * req.params[param]. ADMIN always passes. Sets req.shopStaff = { shopId, staffRole }.
 *
 * Uses the shops / shop_staff tables that land in Commit 3 (Nov 8).
 */
function requireShopStaff({ owner = false, param = 'shopId' } = {}) {
  return asyncHandler(async (req, res, next) => {
    if (!req.user) throw new AppError('UNAUTHENTICATED');
    const raw = req.params[param];
    if (!/^\d+$/.test(String(raw))) throw AppError.notFound('Shop', raw);
    const shopId = Number(raw);

    if (req.user.role === 'ADMIN') {
      req.shopStaff = { shopId, staffRole: 'ADMIN' };
      return next();
    }

    const { rows } = await query(
      `SELECT ss.staff_role
         FROM shop_staff ss
         JOIN shops s ON s.id = ss.shop_id
        WHERE ss.shop_id = $1 AND ss.user_id = $2 AND ss.is_active`,
      [shopId, req.user.id]
    );
    if (rows.length === 0) throw new AppError('NOT_SHOP_STAFF', undefined, { shopId });
    if (owner && rows[0].staff_role !== 'OWNER') throw new AppError('NOT_SHOP_OWNER', undefined, { shopId });

    req.shopStaff = { shopId, staffRole: rows[0].staff_role };
    next();
  });
}

module.exports = { requireRole, requireShopStaff };
