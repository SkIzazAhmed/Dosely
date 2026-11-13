'use strict';

require('dotenv').config();

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) throw new Error(`Config: ${name} must be an integer, got "${raw}"`);
  return n;
}

const env = process.env.NODE_ENV || 'development';

const config = Object.freeze({
  env,
  isProd: env === 'production',
  isTest: env === 'test',
  port: int('PORT', 3000),

  db: Object.freeze({
    // If DATABASE_URL is unset, pg falls back to PGHOST/PGUSER/... env values.
    connectionString: process.env.DATABASE_URL || undefined,
    max: int('DB_POOL_MAX', 10),
  }),

  auth: Object.freeze({
    jwtSecret: process.env.JWT_SECRET || (env === 'production' ? '' : 'dosely-dev-only-secret'),
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '1d',
    bcryptCost: Math.max(10, int('BCRYPT_COST', 10)), // A3: cost >= 10
  }),

  notifications: Object.freeze({
    smsProvider: process.env.SMS_PROVIDER || 'stub',
    emailProvider: process.env.EMAIL_PROVIDER || 'stub',
    // Stub only: comma-separated numbers / emails that always fail, to try retries and P13 by hand
    stubFail: (process.env.NOTIFY_STUB_FAIL || '').split(',').map((x) => x.trim()).filter(Boolean),
    // Retry backoff: base * 2^(attempt-1), capped (A11, F6.3)
    backoffBaseMs: int('NOTIFY_BACKOFF_BASE_MS', 30_000),
    backoffMaxMs: int('NOTIFY_BACKOFF_MAX_MS', 30 * 60_000),
    // retryNotifications job inside the API process; set NOTIFY_WORKER=off to run it separately
    worker: (process.env.NOTIFY_WORKER || 'on') !== 'off',
    workerIntervalMs: int('NOTIFY_WORKER_INTERVAL_MS', 5_000),
  }),
});

if (config.isProd && (!config.auth.jwtSecret || config.auth.jwtSecret.startsWith('change-me') || config.auth.jwtSecret.length < 32)) {
  throw new Error('Config: JWT_SECRET must be set to a real secret (32+ characters) in production');
}

module.exports = config;
