'use strict';

/**
 * Transition tables for requests (C4) and referrals (C8).
 * Commit 3 "done when": every disallowed move returns 409 INVALID_TRANSITION —
 * moves not in the table, the wrong actor, and every guard's failing case.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const requestState = require('../src/modules/requests/request.state');
const referralState = require('../src/modules/referrals/referral.state');
const { RequestStatus, ReferralStatus } = require('../src/shared/enums');

const key = (t) => `${t.from}->${t.to}`;

const HOUR = 3.6e6;
const NOW = new Date('2026-11-08T10:00:00Z');
const req = (over = {}) => ({
  requestedQty: 10, fulfilledQty: 0, expiresAt: new Date(NOW.getTime() + HOUR).toISOString(), ...over,
});

/** A context that makes the transition's guard pass. */
function requestPassCtx(t) {
  switch (t.guard) {
    case 'notExpired': return { request: req(), now: NOW };
    case 'pastExpiry': return { request: req({ expiresAt: new Date(NOW.getTime() - 1).toISOString() }), now: NOW };
    case 'partlyFulfilled': return { request: req(), fulfilledQty: 4 };
    case 'fullyFulfilled': return { request: req(), fulfilledQty: 10 };
    case 'hasLiveReferral': return { request: req(), liveReferrals: 1 };
    case 'noLiveReferralSomeGiven': return { request: req({ fulfilledQty: 4 }), liveReferrals: 0 };
    case 'noLiveReferralNoneGiven': return { request: req(), liveReferrals: 0 };
    case 'hasReason': return { request: req(), reason: 'Supplier delay' };
    default: return { request: req() };
  }
}

const ref = (over = {}) => ({ quantity: 5, holdUntil: new Date(NOW.getTime() - 1).toISOString(), ...over });
function referralPassCtx(t) {
  switch (t.guard) {
    case 'stockAvailable': return { referral: ref(), available: 5 };
    case 'hasReason': return { referral: ref(), reason: 'Out of stock' };
    case 'pickupVerified': return { referral: ref(), verified: true };
    case 'holdExpired': return { referral: ref(), now: NOW };
    default: return { referral: ref() };
  }
}

const EXPECTED_REQUEST_MOVES = [
  'SENT->ACKNOWLEDGED', 'SENT->EXPIRED', 'SENT->CANCELLED',
  'ACKNOWLEDGED->PARTIALLY_FULFILLED', 'ACKNOWLEDGED->FULFILLED', 'ACKNOWLEDGED->REFERRED',
  'ACKNOWLEDGED->CLOSED', 'ACKNOWLEDGED->CANCELLED',
  'PARTIALLY_FULFILLED->FULFILLED', 'PARTIALLY_FULFILLED->REFERRED',
  'PARTIALLY_FULFILLED->CLOSED', 'PARTIALLY_FULFILLED->CANCELLED',
  'REFERRED->FULFILLED', 'REFERRED->PARTIALLY_FULFILLED', 'REFERRED->ACKNOWLEDGED', 'REFERRED->CANCELLED',
];

const EXPECTED_REFERRAL_MOVES = [
  'PENDING->ACCEPTED', 'PENDING->REJECTED', 'PENDING->CANCELLED',
  'ACCEPTED->FULFILLED', 'ACCEPTED->NO_SHOW', 'ACCEPTED->CANCELLED',
];

function checkTable(name, sm, statuses, expected, passCtx) {
  test(`${name}: table lists exactly the allowed moves`, () => {
    assert.deepEqual(sm.TRANSITIONS.map(key).sort(), [...expected].sort());
  });

  test(`${name}: every row is well-formed`, () => {
    const seen = new Set();
    for (const t of sm.TRANSITIONS) {
      assert.ok(statuses.includes(t.from), `unknown from ${t.from}`);
      assert.ok(statuses.includes(t.to), `unknown to ${t.to}`);
      assert.ok(Array.isArray(t.actor) && t.actor.length > 0, `${key(t)} needs an actor`);
      assert.ok(t.guard === null || typeof sm.GUARDS[t.guard] === 'function', `${key(t)} guard ${t.guard} missing`);
      assert.ok(!seen.has(key(t)), `duplicate ${key(t)}`);
      seen.add(key(t));
    }
  });

  test(`${name}: terminal statuses have no outgoing moves`, () => {
    for (const s of sm.TERMINAL) assert.deepEqual(sm.nextStatuses(s), [], s);
  });

  test(`${name}: every move not in the table is 409 INVALID_TRANSITION`, () => {
    for (const from of statuses) {
      for (const to of statuses) {
        if (expected.includes(`${from}->${to}`)) continue;
        assert.throws(
          () => sm.assertTransition(from, to, 'SYSTEM'),
          (err) => err.code === 'INVALID_TRANSITION' && err.status === 409 && err.details.from === from,
          `${from}->${to} should be refused`
        );
      }
    }
  });

  test(`${name}: allowed moves pass for their actors and are refused for others`, () => {
    const actors = ['DOCTOR', 'SHOP', 'TARGET_SHOP', 'SYSTEM'];
    for (const t of sm.TRANSITIONS) {
      for (const a of actors) {
        if (t.actor.includes(a)) {
          assert.equal(sm.assertTransition(t.from, t.to, a, passCtx(t)), t);
          assert.equal(sm.canTransition(t.from, t.to, a), true);
        } else {
          assert.throws(() => sm.assertTransition(t.from, t.to, a, passCtx(t)), { code: 'INVALID_TRANSITION' });
          assert.equal(sm.canTransition(t.from, t.to, a), false);
        }
      }
    }
  });
}

checkTable('request', requestState, Object.values(RequestStatus), EXPECTED_REQUEST_MOVES, requestPassCtx);
checkTable('referral', referralState, Object.values(ReferralStatus), EXPECTED_REFERRAL_MOVES, referralPassCtx);

test('request: only SHOP acknowledges, only SYSTEM expires, only DOCTOR cancels', () => {
  assert.deepEqual(requestState.nextStatuses('SENT', 'SHOP'), ['ACKNOWLEDGED']);
  assert.deepEqual(requestState.nextStatuses('SENT', 'SYSTEM'), ['EXPIRED']);
  assert.deepEqual(requestState.nextStatuses('SENT', 'DOCTOR'), ['CANCELLED']);
  for (const s of requestState.OPEN) assert.ok(requestState.canTransition(s, 'CANCELLED', 'DOCTOR'), s);
});

test('request: EXPIRED is reachable only from SENT', () => {
  const into = requestState.TRANSITIONS.filter((t) => t.to === 'EXPIRED').map((t) => t.from);
  assert.deepEqual(into, ['SENT']);
});

test('statuses are split into open and terminal with no overlap', () => {
  assert.deepEqual([...requestState.OPEN, ...requestState.TERMINAL].sort(), Object.values(RequestStatus).sort());
  assert.deepEqual([...referralState.LIVE, ...referralState.TERMINAL].sort(), Object.values(ReferralStatus).sort());
});

// ---------------------------------------------------------------------------
// Guards: each failing case is 409 INVALID_TRANSITION with a reason
// ---------------------------------------------------------------------------

function refused(sm, from, to, actor, ctx, reasonRe) {
  assert.throws(
    () => sm.assertTransition(from, to, actor, ctx),
    (err) => err.code === 'INVALID_TRANSITION' && err.status === 409 && reasonRe.test(err.details.reason),
    `${from}->${to} should be refused with ${reasonRe}`
  );
}

test('request guards: acknowledge only before expiry, expire only after', () => {
  const expired = req({ expiresAt: NOW.toISOString() });
  refused(requestState, 'SENT', 'ACKNOWLEDGED', 'SHOP', { request: expired, now: NOW }, /expired/);
  refused(requestState, 'SENT', 'EXPIRED', 'SYSTEM', { request: req(), now: NOW }, /not expired/);
  requestState.assertTransition('SENT', 'EXPIRED', 'SYSTEM', { request: expired, now: NOW });
});

test('request guards: partial and full dispense need the right fulfilled quantity', () => {
  for (const n of [0, 10]) {
    refused(requestState, 'ACKNOWLEDGED', 'PARTIALLY_FULFILLED', 'SHOP', { request: req(), fulfilledQty: n }, /more than 0/);
  }
  for (const n of [0, 9]) {
    refused(requestState, 'ACKNOWLEDGED', 'FULFILLED', 'SHOP', { request: req(), fulfilledQty: n }, /equal requested/);
    refused(requestState, 'PARTIALLY_FULFILLED', 'FULFILLED', 'SHOP', { request: req(), fulfilledQty: n }, /equal requested/);
    refused(requestState, 'REFERRED', 'FULFILLED', 'TARGET_SHOP', { request: req(), fulfilledQty: n }, /equal requested/);
  }
  // fulfilledQty defaults to the request's own value
  requestState.assertTransition('ACKNOWLEDGED', 'PARTIALLY_FULFILLED', 'SHOP', { request: req({ fulfilledQty: 3 }) });
});

test('request guards: referred needs a live referral; step back needs none', () => {
  refused(requestState, 'ACKNOWLEDGED', 'REFERRED', 'SHOP', { request: req(), liveReferrals: 0 }, /no live referral/);
  refused(requestState, 'ACKNOWLEDGED', 'REFERRED', 'SHOP', { request: req() }, /missing liveReferrals/);
  refused(requestState, 'REFERRED', 'ACKNOWLEDGED', 'SYSTEM', { request: req(), liveReferrals: 1 }, /still has a live/);
  refused(requestState, 'REFERRED', 'ACKNOWLEDGED', 'SYSTEM', { request: req({ fulfilledQty: 2 }), liveReferrals: 0 }, /already dispensed/);
  refused(requestState, 'REFERRED', 'PARTIALLY_FULFILLED', 'SYSTEM', { request: req(), liveReferrals: 0 }, /nothing has been dispensed/);
  refused(requestState, 'REFERRED', 'PARTIALLY_FULFILLED', 'SYSTEM', { request: req({ fulfilledQty: 2 }), liveReferrals: 2 }, /still has a live/);
});

test('request guards: close needs a reason of 1–500 characters', () => {
  for (const reason of [undefined, '', '   ', 'x'.repeat(501)]) {
    refused(requestState, 'ACKNOWLEDGED', 'CLOSED', 'SHOP', { request: req(), reason }, /reason/);
  }
  requestState.assertTransition('PARTIALLY_FULFILLED', 'CLOSED', 'SHOP', { request: req(), reason: ' x ' });
});

test('request guards: a missing request in the context is refused, not crashed', () => {
  refused(requestState, 'SENT', 'ACKNOWLEDGED', 'SHOP', {}, /missing request/);
  refused(requestState, 'SENT', 'ACKNOWLEDGED', 'SHOP', undefined, /missing request/);
});

test('referral guards: stock, reason, verification, hold expiry', () => {
  refused(referralState, 'PENDING', 'ACCEPTED', 'TARGET_SHOP', { referral: ref(), available: 4 }, /enough stock/);
  refused(referralState, 'PENDING', 'ACCEPTED', 'TARGET_SHOP', { referral: ref() }, /missing available/);
  refused(referralState, 'PENDING', 'REJECTED', 'TARGET_SHOP', { referral: ref(), reason: ' ' }, /reason/);
  refused(referralState, 'ACCEPTED', 'FULFILLED', 'TARGET_SHOP', { referral: ref(), verified: false }, /not verified/);
  refused(referralState, 'ACCEPTED', 'NO_SHOW', 'SYSTEM',
    { referral: ref({ holdUntil: new Date(NOW.getTime() + 1).toISOString() }), now: NOW }, /not expired/);
  refused(referralState, 'ACCEPTED', 'NO_SHOW', 'SYSTEM', { referral: { quantity: 1 }, now: NOW }, /no hold/);
  // DB rows (snake_case) work too
  referralState.assertTransition('ACCEPTED', 'NO_SHOW', 'SYSTEM', { referral: { hold_until: NOW.toISOString() }, now: NOW });
});
