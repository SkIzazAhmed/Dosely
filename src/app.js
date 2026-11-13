'use strict';

const express = require('express');
const { pool } = require('./db/pool');
const asyncHandler = require('./shared/asyncHandler');
const { errorHandler, notFound } = require('./middleware/errorHandler');
const authRoutes = require('./modules/auth/auth.routes');
const userRoutes = require('./modules/users/users.routes');
const doctorRoutes = require('./modules/doctors/doctors.routes');
const shopRoutes = require('./modules/shops/shops.routes');
const patientRoutes = require('./modules/patients/patients.routes');
const { phoneRouter } = require('./modules/phones/phones.routes');
const patientsService = require('./modules/patients/patients.service');
const requestRoutes = require('./modules/requests/request.routes');
const medicineRoutes = require('./modules/medicines/medicines.routes');
const genericRoutes = require('./modules/medicines/generics.routes');
const inventoryRoutes = require('./modules/inventory/inventory.routes');

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

  app.use('/auth', authRoutes);
  // Phone routes first so /users/:id/phones isn't swallowed by the /users router
  app.use('/users/:ownerId/phones', phoneRouter('USER'));
  app.use('/patients/:ownerId/phones', phoneRouter('PATIENT', {
    beforeAdd: (patientId) => patientsService.assertActive(patientId),
  }));
  app.use('/shops/:ownerId/phones', phoneRouter('SHOP'));

  app.use('/users', userRoutes);
  app.use('/doctors', doctorRoutes);
  app.use('/shops', shopRoutes);
  app.use('/patients', patientRoutes);
  app.use('/requests', requestRoutes);
  app.use('/medicines', medicineRoutes); // Rachana: catalog (B1–B3)
  app.use('/generics', genericRoutes);
  app.use('/shops', inventoryRoutes); // Rachana: /shops/:shopId/stock-in (B4–B7)

  // Module routers still to land:
  //   Commit 5 (Nov 12): /phones/:id/verify
  //   Commit 5 (Nov 12): /notifications

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
