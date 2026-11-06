'use strict';

const express = require('express');
const { pool } = require('./db/pool');
const asyncHandler = require('./shared/asyncHandler');
const { errorHandler, notFound } = require('./middleware/errorHandler');

function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  app.get(
    '/health',
    asyncHandler(async (req, res) => {
      let db = 'up';
      try {
        await pool.query('SELECT 1');
      } catch {
        db = 'down';
      }
      res.status(db === 'up' ? 200 : 503).json({ status: db === 'up' ? 'ok' : 'degraded', db });
    })
  );

  // Module routers are mounted here as they land:
  //   Commit 2 (Nov 6):  /auth, /users, /doctors
  //   Commit 3 (Nov 8):  /shops, /shops/:id/staff, /patients
  //   Commit 4 (Nov 10): /{users,patients,shops}/:id/phones, /phones/:id/verify
  //   Commit 5 (Nov 12): /notifications

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
