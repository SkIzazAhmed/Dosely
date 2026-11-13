'use strict';

/**
 * POST /phones/:phoneId/verify — verification by staff confirmation (F5.3, MVP).
 *
 * Who can confirm:
 *   patient numbers  DOCTOR, SHOPKEEPER or ADMIN (the person in front of the patient)
 *   shop numbers     active staff of that shop, or ADMIN
 *   user numbers     ADMIN, or an OWNER of a shop where that user is active staff
 * Nobody (except ADMIN) can confirm their own number.
 */

const express = require('express');
const asyncHandler = require('../../shared/asyncHandler');
const { AppError } = require('../../shared/errors');
const { idParam } = require('../../shared/validate');
const { authenticate } = require('../../middleware/auth');
const { query } = require('../../db/pool');
const phones = require('./phones.service');

const router = express.Router();
router.use(authenticate);

async function isActiveStaff(shopId, userId, { owner = false } = {}) {
  const { rowCount } = await query(
    `SELECT 1 FROM shop_staff WHERE shop_id = $1 AND user_id = $2 AND is_active ${owner ? "AND staff_role = 'OWNER'" : ''}`,
    [shopId, userId]
  );
  return rowCount > 0;
}

async function canVerify(actor, phone) {
  if (actor.role === 'ADMIN') return true;
  switch (phone.ownerType) {
    case 'PATIENT':
      return ['DOCTOR', 'SHOPKEEPER'].includes(actor.role);
    case 'SHOP':
      return isActiveStaff(phone.ownerId, actor.id);
    case 'USER': {
      if (phone.ownerId === actor.id) return false;
      const { rowCount } = await query(
        `SELECT 1 FROM shop_staff me JOIN shop_staff them ON them.shop_id = me.shop_id
          WHERE me.user_id = $1 AND me.staff_role = 'OWNER' AND me.is_active
            AND them.user_id = $2 AND them.is_active`,
        [actor.id, phone.ownerId]
      );
      return rowCount > 0;
    }
    default:
      return false;
  }
}

router.post(
  '/:phoneId/verify',
  asyncHandler(async (req, res) => {
    const phoneId = idParam(req.params.phoneId, 'Phone number');
    const phone = await phones.getById(phoneId);
    if (!phone || !phone.isActive) throw AppError.notFound('Phone number', phoneId);
    if (!(await canVerify(req.user, phone))) {
      throw new AppError('FORBIDDEN', 'You cannot confirm this number', { ownerType: phone.ownerType });
    }
    res.json(await phones.verify(phoneId, req.user.id));
  })
);

module.exports = router;
