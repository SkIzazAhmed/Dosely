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
    jwtSecret: process.env.JWT_SECRET || '',
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '1d',
    bcryptCost: Math.max(10, int('BCRYPT_COST', 10)), // A3: cost >= 10
  }),

  notifications: Object.freeze({
    smsProvider: process.env.SMS_PROVIDER || 'stub',
  }),
});

if (config.isProd && (!config.auth.jwtSecret || config.auth.jwtSecret.startsWith('change-me'))) {
  throw new Error('Config: JWT_SECRET must be set to a real secret in production');
}

module.exports = config;
