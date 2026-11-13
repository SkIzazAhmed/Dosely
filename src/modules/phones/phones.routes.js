'use strict';

/**
 * Phone routes for each owner type (A9):
 *   GET    /{users|patients|shops}/:ownerId/phones
 *   POST   /{users|patients|shops}/:ownerId/phones            { number, label?, isPrimary? }
 *   PATCH  /{users|patients|shops}/:ownerId/phones/:phoneId   { number?, label?, isPrimary? }  (new digits reset verification, P12)
 *   POST   /phones/:phoneId/verify                             staff confirmation (F5.3)
 *   DELETE /{users|patients|shops}/:ownerId/phones/:phoneId   (deactivates)
 *
 * Who may read / write:
 *   users     the user themself, or ADMIN
 *   patients  DOCTOR, SHOPKEEPER, ADMIN (no patient login)
 *   shops     read: anyone logged in; write: shop OWNER or ADMIN
 */

const express = require('express');
const asyncHandler = require('../../shared/asyncHandler');
const { AppError } = require('../../shared/errors');
const { validate, idParam } = require('../../shared/validate');
const { authenticate } = require('../../middleware/auth');
const { requireRole, requireShopStaff } = require('../../middleware/rbac');
const { idempotency } = require('../../middleware/idempotency');
const { LABELS } = require('./phone.validator');
const phones = require('./phones.service');

function selfOrAdmin(req, res, next) {
  const id = idParam(req.params.ownerId, 'User');
  if (req.user.role !== 'ADMIN' && req.user.id !== id) return next(new AppError('FORBIDDEN'));
  next();
}

const ACCESS = {
  USER: { resource: 'User', read: [selfOrAdmin], write: [selfOrAdmin] },
  PATIENT: {
    resource: 'Patient',
    read: [requireRole('DOCTOR', 'SHOPKEEPER', 'ADMIN')],
    write: [requireRole('DOCTOR', 'SHOPKEEPER', 'ADMIN')],
  },
  SHOP: { resource: 'Shop', read: [], write: [requireShopStaff({ owner: true, param: 'ownerId' })] },
};

async function loadOwnPhone(ownerType, ownerId, phoneId) {
  const phone = await phones.getById(phoneId);
  if (!phone || phone.ownerType !== ownerType || phone.ownerId !== ownerId || !phone.isActive) {
    throw AppError.notFound('Phone number', phoneId);
  }
  return phone;
}

/** Returns hooks so later commits can add owner-specific checks (e.g. inactive patients). */
function phoneRouter(ownerType, { beforeAdd } = {}) {
  const access = ACCESS[ownerType];
  const router = express.Router({ mergeParams: true });
  router.use(authenticate);

  const ownerIdOf = (req) => idParam(req.params.ownerId, access.resource);

  router.get(
    '/',
    ...access.read,
    asyncHandler(async (req, res) => {
      const { includeRemoved } = validate(req.query, { includeRemoved: { type: 'boolean' } });
      res.json({ items: await phones.list(ownerType, ownerIdOf(req), { includeRemoved: Boolean(includeRemoved) }) });
    })
  );

  router.post(
    '/',
    ...access.write,
    idempotency(),
    asyncHandler(async (req, res) => {
      const body = validate(req.body, {
        number: { type: 'string', required: true, max: 30 },
        label: { type: 'enum', values: LABELS, default: 'MOBILE' },
        isPrimary: { type: 'boolean' },
      });
      const ownerId = ownerIdOf(req);
      if (beforeAdd) await beforeAdd(ownerId, req);
      const { phone, warnings } = await phones.add(ownerType, ownerId, body);
      res.status(201).json({ ...phone, warnings });
    })
  );

  router.patch(
    '/:phoneId',
    ...access.write,
    asyncHandler(async (req, res) => {
      const ownerId = ownerIdOf(req);
      const phoneId = idParam(req.params.phoneId, 'Phone number');
      await loadOwnPhone(ownerType, ownerId, phoneId);
      const patch = validate(req.body, {
        number: { type: 'string', max: 30 },
        label: { type: 'enum', values: LABELS },
        isPrimary: { type: 'boolean' },
      }, { partial: true });
      res.json(await phones.update(phoneId, patch));
    })
  );

  router.delete(
    '/:phoneId',
    ...access.write,
    asyncHandler(async (req, res) => {
      const ownerId = ownerIdOf(req);
      const phoneId = idParam(req.params.phoneId, 'Phone number');
      await loadOwnPhone(ownerType, ownerId, phoneId);
      res.json(await phones.remove(phoneId));
    })
  );

  return router;
}

module.exports = { phoneRouter, loadOwnPhone };
