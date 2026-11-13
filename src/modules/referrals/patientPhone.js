'use strict';

/**
 * Patient phone lookup for referrals (C9 verification, C10 SMS vs slip).
 *
 * Phones are Izaz's module (Commit 4, not on main yet). When
 * src/modules/phones/phones.service.js exists and exports
 * getPrimaryUsablePhone(patientId, { client }) → { number } | null, it is used.
 * Until then this is a STUB: no patient has a usable phone (so every
 * accepted referral gets a printed slip), unless a test sets one with
 * _setStubPhone(patientId, '+919812345678').
 */

let phones = null;
try {
  // eslint-disable-next-line global-require
  phones = require('../phones/phones.service');
  if (typeof phones.getPrimaryUsablePhone !== 'function') phones = null;
} catch {
  phones = null;
}

const stubPhones = new Map();

/** @returns {Promise<{number:string}|null>} the patient's primary usable phone, or null */
async function getUsablePhone(patientId, { client } = {}) {
  if (!patientId) return null;
  if (phones) return phones.getPrimaryUsablePhone(patientId, { client });
  const number = stubPhones.get(Number(patientId));
  return number ? { number } : null;
}

/** Last 5 digits of a phone number ('' when it has fewer). */
function last5(number) {
  const digits = String(number || '').replace(/\D/g, '');
  return digits.length >= 5 ? digits.slice(-5) : '';
}

function _setStubPhone(patientId, number) {
  if (number) stubPhones.set(Number(patientId), number);
  else stubPhones.delete(Number(patientId));
}

module.exports = { getUsablePhone, last5, isStub: () => !phones, _setStubPhone };
