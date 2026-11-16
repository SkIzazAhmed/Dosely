'use strict';

/**
 * Patient phone lookup for referrals (C9 verification, C10 SMS vs slip).
 *
 * Uses Izaz's phones.service (Commit 4): the patient's usable phone is the
 * primary number if it is SMS-capable (verified mobile, active), otherwise the
 * first other SMS-capable number. An unverified number (edge case 9) or no
 * number at all (edge case 10) means no usable phone → printed slip.
 *
 * If phones.service isn't there (older checkout), it falls back to a stub where
 * no patient has a usable phone unless _setStubPhone() set one.
 */

let phones = null;
try {
  // eslint-disable-next-line global-require
  phones = require('../phones/phones.service');
  if (typeof phones.list !== 'function') phones = null;
} catch {
  phones = null;
}

const stubPhones = new Map();

/** @returns {Promise<{number:string, phoneId?:number}|null>} the patient's usable phone, or null */
async function getUsablePhone(patientId, { client } = {}) {
  if (!patientId) return null;
  if (!phones) {
    const number = stubPhones.get(Number(patientId));
    return number ? { number } : null;
  }
  const list = await phones.list('PATIENT', patientId, { client });
  const usable = list.find((p) => p.isPrimary && p.smsCapable) || list.find((p) => p.smsCapable);
  return usable ? { number: usable.e164, phoneId: usable.id } : null;
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
