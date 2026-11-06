'use strict';

/**
 * Referral state machine (C8). Same shape as request.state.js:
 * one table { from, to, actor, guard }; any other move is 409 INVALID_TRANSITION.
 *
 * Actors: SHOP (origin shop staff), TARGET_SHOP (staff of to_shop), DOCTOR, SYSTEM (jobs).
 *
 *   PENDING ──accept (reserve, hold 24 h)──▶ ACCEPTED ──pickup verified──▶ FULFILLED
 *      │                                       │
 *      ├──reject (reason)──▶ REJECTED          ├──hold expired──▶ NO_SHOW (release stock)
 *      └──cancel──▶ CANCELLED ◀────────────────┘ cancel (release stock)
 *
 * Skeleton (Commit 1): guards are named and all pass; real checks in Commit 3/5.
 */

const { AppError } = require('../../shared/errors');
const { ReferralStatus: R } = require('../../shared/enums');

const LIVE = Object.freeze([R.PENDING, R.ACCEPTED]);
const TERMINAL = Object.freeze([R.REJECTED, R.CANCELLED, R.FULFILLED, R.NO_SHOW]);

const TRANSITIONS = Object.freeze(
  [
    { from: R.PENDING, to: R.ACCEPTED, actor: ['TARGET_SHOP'], guard: 'stockAvailable' },
    { from: R.PENDING, to: R.REJECTED, actor: ['TARGET_SHOP'], guard: 'hasReason' },
    { from: R.PENDING, to: R.CANCELLED, actor: ['SHOP', 'DOCTOR', 'SYSTEM'], guard: null },
    { from: R.ACCEPTED, to: R.FULFILLED, actor: ['TARGET_SHOP'], guard: 'pickupVerified' },
    { from: R.ACCEPTED, to: R.NO_SHOW, actor: ['SYSTEM'], guard: 'holdExpired' },
    { from: R.ACCEPTED, to: R.CANCELLED, actor: ['SHOP', 'DOCTOR', 'SYSTEM'], guard: null },
  ].map((t) => Object.freeze({ ...t, actor: Object.freeze(t.actor) }))
);

const GUARDS = Object.freeze({
  stockAvailable: () => null,
  hasReason: () => null,
  pickupVerified: () => null,
  holdExpired: () => null,
});

function findTransition(from, to) {
  return TRANSITIONS.find((t) => t.from === from && t.to === to) || null;
}

function nextStatuses(from, actor) {
  return TRANSITIONS.filter((t) => t.from === from && (!actor || t.actor.includes(actor))).map((t) => t.to);
}

function canTransition(from, to, actor) {
  const t = findTransition(from, to);
  return Boolean(t && (!actor || t.actor.includes(actor)));
}

function assertTransition(from, to, actor, ctx = {}) {
  const t = findTransition(from, to);
  const refuse = (why) => {
    throw new AppError('INVALID_TRANSITION', `Cannot move referral from ${from} to ${to}`, {
      entity: 'referral', from, to, actor: actor || null, reason: why,
    });
  };
  if (!t) refuse('not an allowed move');
  if (!t.actor.includes(actor)) refuse(`${actor} cannot make this move`);
  if (t.guard) {
    const why = GUARDS[t.guard](ctx);
    if (why) refuse(why);
  }
  return t;
}

module.exports = { TRANSITIONS, GUARDS, LIVE, TERMINAL, findTransition, nextStatuses, canTransition, assertTransition };
