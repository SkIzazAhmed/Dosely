'use strict';

/**
 * Phone number normalisation and validation — rules P1–P3 of the main PRD.
 * Pure functions, no database: easy to unit test.
 *
 *   P1  Strip spaces, dashes, dots and brackets. A 10-digit Indian number gets
 *       +91; a leading 0 or 91 becomes +91.
 *   P2  The result must be valid E.164 for its country      → 422 PHONE_INVALID_FORMAT
 *   P3  Indian mobiles must match +91[6-9]XXXXXXXXX (and be in a mobile range of the
 *       numbering plan — see below). Landlines are allowed only labelled HOME,
 *       WORK or SHOP and never get SMS                       → 422 PHONE_NOT_MOBILE
 *
 * Edge case 4: duplicates are compared after normalisation, so
 * "098765 43210" and "+919876543210" are the same number.
 */

const { parsePhoneNumberFromString } = require('libphonenumber-js/max');
const { AppError } = require('../../shared/errors');

const LABELS = Object.freeze(['MOBILE', 'HOME', 'WORK', 'SHOP']);
const LANDLINE_LABELS = Object.freeze(['HOME', 'WORK', 'SHOP']);
const INDIAN_MOBILE = /^\+91[6-9]\d{9}$/;
const MAX_INPUT_LENGTH = 30;

/** P1: strip formatting and add the +91 country code where the PRD says to. */
function toE164Candidate(raw) {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const s = String(raw).trim();
  if (s === '' || s.length > MAX_INPUT_LENGTH) return null;
  const stripped = s.replace(/[\s\-().]/g, '');
  if (/^\+\d+$/.test(stripped)) return stripped;
  if (/^\d{10}$/.test(stripped)) return `+91${stripped}`;          // 9876543210
  if (/^0\d{10}$/.test(stripped)) return `+91${stripped.slice(1)}`; // 09876543210 / 08026630000
  if (/^91\d{10}$/.test(stripped)) return `+${stripped}`;           // 919876543210
  return null;
}

/**
 * Normalise and validate a number.
 * @param {string} raw    what the user typed
 * @param {string} [label] MOBILE (default) | HOME | WORK | SHOP
 * @returns {{ e164: string, kind: 'MOBILE'|'LANDLINE', label: string, country: string, display: string, smsCapable: boolean }}
 * @throws AppError PHONE_INVALID_FORMAT | PHONE_NOT_MOBILE | VALIDATION_ERROR (bad label)
 */
function normalizePhone(raw, label = 'MOBILE') {
  if (!LABELS.includes(label)) {
    throw AppError.validation([{ field: 'label', issue: `must be one of ${LABELS.join(', ')}` }]);
  }
  const candidate = toE164Candidate(raw);
  const parsed = candidate ? parsePhoneNumberFromString(candidate) : undefined;
  if (!parsed || !parsed.isValid() || parsed.number !== candidate) {
    throw new AppError('PHONE_INVALID_FORMAT', undefined, { input: typeof raw === 'string' ? raw.slice(0, MAX_INPUT_LENGTH) : null });
  }

  const e164 = parsed.number;
  let kind;
  const type = parsed.getType();
  const mobileType = type === 'MOBILE' || type === 'FIXED_LINE_OR_MOBILE';
  if (parsed.country === 'IN') {
    // P3's pattern alone isn't enough: Bengaluru landlines (080…) become +9180… and
    // match +91[6-9]. A number is a mobile only if it matches the pattern AND
    // libphonenumber's numbering plan says it's a mobile range.
    kind = INDIAN_MOBILE.test(e164) && mobileType ? 'MOBILE' : 'LANDLINE';
  } else {
    kind = mobileType ? 'MOBILE' : 'LANDLINE';
  }

  if (kind === 'LANDLINE' && !LANDLINE_LABELS.includes(label)) {
    throw new AppError('PHONE_NOT_MOBILE', undefined, { e164, allowedLabels: LANDLINE_LABELS });
  }

  return {
    e164,
    kind,
    label,
    country: parsed.country || null,
    display: parsed.formatInternational(),
    smsCapable: kind === 'MOBILE',
  };
}

/** Normalise for lookups (login, search). Returns null instead of throwing. */
function tryNormalize(raw) {
  try {
    return normalizePhone(raw, 'HOME').e164; // HOME accepts mobiles and landlines
  } catch {
    return null;
  }
}

/** "+919876543210" → "+91 ••••• •3210" for display in lists and warnings. */
function maskPhone(e164) {
  return e164 ? `${e164.slice(0, 3)} ••••• •${e164.slice(-4)}` : null;
}

/** "Priya Nair" → "P**** N***" (P5: warn without exposing the other patient's name). */
function maskName(name) {
  return String(name || '')
    .trim()
    .split(/\s+/)
    .map((w) => (w.length <= 1 ? w : `${w[0]}${'*'.repeat(Math.min(w.length - 1, 6))}`))
    .join(' ');
}

module.exports = { normalizePhone, tryNormalize, toE164Candidate, maskPhone, maskName, LABELS, LANDLINE_LABELS, INDIAN_MOBILE };
