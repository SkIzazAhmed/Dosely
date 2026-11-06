'use strict';

const bcrypt = require('bcryptjs');
const config = require('../config');

const MIN_LENGTH = 8;
const MAX_LENGTH = 72; // bcrypt only uses the first 72 bytes

function hashPassword(plain) {
  return bcrypt.hash(plain, config.auth.bcryptCost); // cost >= 10 (A3)
}

function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

// Used when a login email doesn't exist, so the response time is the same
// as for a wrong password (no user enumeration by timing).
const DUMMY_HASH = bcrypt.hashSync('dosely-dummy-password', 10);

module.exports = { hashPassword, verifyPassword, DUMMY_HASH, MIN_LENGTH, MAX_LENGTH };
