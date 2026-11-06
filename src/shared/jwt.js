'use strict';

const jwt = require('jsonwebtoken');
const config = require('../config');
const { AppError } = require('./errors');

const ISSUER = 'dosely';

function signToken(user) {
  return jwt.sign({ role: user.role }, config.auth.jwtSecret, {
    subject: String(user.id),
    expiresIn: config.auth.jwtExpiresIn,
    issuer: ISSUER,
    algorithm: 'HS256',
  });
}

function verifyToken(token) {
  try {
    const payload = jwt.verify(token, config.auth.jwtSecret, { issuer: ISSUER, algorithms: ['HS256'] });
    return { userId: Number(payload.sub), role: payload.role, exp: payload.exp };
  } catch (err) {
    if (err.name === 'TokenExpiredError') throw new AppError('TOKEN_EXPIRED');
    throw new AppError('UNAUTHENTICATED', 'Invalid token');
  }
}

module.exports = { signToken, verifyToken };
