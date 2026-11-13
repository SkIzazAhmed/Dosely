'use strict';

const express = require('express');
const asyncHandler = require('../../shared/asyncHandler');
const { validate, idParam } = require('../../shared/validate');
const { authenticate } = require('../../middleware/auth');
const notifications = require('./notification.service');

const router = express.Router();
router.use(authenticate);

// GET /notifications?unreadOnly=true&limit=20&before=<id>
// → { items: [...], unreadCount, nextBefore }  (pass nextBefore as `before` for the next page)
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const q = validate(req.query, {
      unreadOnly: { type: 'boolean', default: false },
      limit: { type: 'integer', min: 1, max: 100, default: 20 },
      before: { type: 'integer', min: 1 },
    });
    res.json(await notifications.listInbox(req.user.id, q));
  })
);

// POST /notifications/read-all → { updated }
router.post(
  '/read-all',
  asyncHandler(async (req, res) => {
    res.json(await notifications.markAllRead(req.user.id));
  })
);

// POST /notifications/:id/read → { id, readAt }  (only your own; otherwise 404)
router.post(
  '/:id/read',
  asyncHandler(async (req, res) => {
    res.json(await notifications.markRead(idParam(req.params.id, 'Notification'), req.user.id));
  })
);

module.exports = router;
