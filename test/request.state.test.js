'use strict';

/**
 * Transition tables for requests (C4) and referrals (C8).
 * Commit 1: the table lists every allowed move and everything else is refused
 * with 409 INVALID_TRANSITION. Guard behaviour is tested from Commit 3.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const requestState = require('../src/modules/requests/request.state');
const referralState = require('../src/modules/referrals/referral.state');
const { RequestStatus, ReferralStatus } = require('../src/shared/enums');

const key = (t) => `${t.from}->${t.to}`;

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

function checkTable(name, sm, statuses, expected) {
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
          assert.equal(sm.assertTransition(t.from, t.to, a), t);
          assert.equal(sm.canTransition(t.from, t.to, a), true);
        } else {
          assert.throws(() => sm.assertTransition(t.from, t.to, a), { code: 'INVALID_TRANSITION' });
          assert.equal(sm.canTransition(t.from, t.to, a), false);
        }
      }
    }
  });
}

checkTable('request', requestState, Object.values(RequestStatus), EXPECTED_REQUEST_MOVES);
checkTable('referral', referralState, Object.values(ReferralStatus), EXPECTED_REFERRAL_MOVES);

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
