'use strict';

/** Unit tests for rules P1–P3 (no database). */

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePhone, tryNormalize, maskName, maskPhone } = require('../src/modules/phones/phone.validator');

const code = (fn) => {
  try {
    fn();
    return 'OK';
  } catch (e) {
    return e.code;
  }
};

test('P1: strips spaces, dashes, dots and brackets; adds +91', () => {
  const same = [
    '9876543210', '98765 43210', '98765-43210', '(98765) 43210', '98765.43210',
    '09876543210', '098765 43210', '919876543210', '91 98765 43210', '+91 98765 43210', '+91-98765-43210', ' +919876543210 ',
  ];
  for (const input of same) assert.equal(normalizePhone(input).e164, '+919876543210', input);
});

test('P1/edge case 4: different spellings of one number compare equal after normalisation', () => {
  assert.equal(tryNormalize('098765 43210'), tryNormalize('+919876543210'));
  assert.equal(tryNormalize('(080) 2663 0000'), '+918026630000');
});

test('P2: invalid numbers → PHONE_INVALID_FORMAT', () => {
  for (const bad of ['', '   ', '12345', '98765432', '98765432101', '+91 02345 67890', '55555 55555', 'abcdefghij', '+0 98765 43210',
    '00919876543210', '+1 555 123 4567', '9876543210x', null, undefined, '9'.repeat(40)]) {
    assert.equal(code(() => normalizePhone(bad)), 'PHONE_INVALID_FORMAT', String(bad));
  }
});

test('P2: valid non-Indian numbers in E.164 are accepted', () => {
  const us = normalizePhone('+1 (202) 555-0123');
  assert.equal(us.e164, '+12025550123');
  assert.equal(us.country, 'US');
  assert.equal(normalizePhone('+44 7911 123456').kind, 'MOBILE');
});

test('P3: Indian mobiles start with 6–9', () => {
  for (const n of ['6200123456', '7012345678', '8123456789', '9876543210']) {
    assert.equal(normalizePhone(n).kind, 'MOBILE', n);
  }
  // valid Indian number, but a landline (starts with 1) → not a mobile
  assert.equal(code(() => normalizePhone('+91 11 2345 6789')), 'PHONE_NOT_MOBILE');
});

test('P3: a landline that happens to match +91[6-9] is still a landline (Bengaluru 080, Patna 0612)', () => {
  assert.equal(code(() => normalizePhone('080 2663 0000')), 'PHONE_NOT_MOBILE');
  assert.equal(code(() => normalizePhone('0612 345 6789')), 'PHONE_NOT_MOBILE');
  assert.equal(normalizePhone('0612 345 6789', 'WORK').kind, 'LANDLINE');
});

test('P3: landlines only as HOME, WORK or SHOP; never SMS-capable', () => {
  assert.equal(code(() => normalizePhone('080 2663 0000')), 'PHONE_NOT_MOBILE');
  assert.equal(code(() => normalizePhone('080 2663 0000', 'MOBILE')), 'PHONE_NOT_MOBILE');
  for (const label of ['HOME', 'WORK', 'SHOP']) {
    const n = normalizePhone('080 2663 0000', label);
    assert.deepEqual([n.e164, n.kind, n.label, n.smsCapable], ['+918026630000', 'LANDLINE', label, false]);
  }
  assert.equal(normalizePhone('9876543210', 'HOME').smsCapable, true, 'a mobile labelled HOME can still get SMS');
});

test('P3: unknown label is a validation error', () => {
  assert.equal(code(() => normalizePhone('9876543210', 'FAX')), 'VALIDATION_ERROR');
});

test('display helpers mask numbers and names', () => {
  assert.equal(maskPhone('+919876543210'), '+91 ••••• •3210');
  assert.equal(maskName('Priya Nair'), 'P**** N***');
  assert.equal(maskName('  A  B '), 'A B');
  assert.equal(normalizePhone('9876543210').display, '+91 98765 43210');
});
