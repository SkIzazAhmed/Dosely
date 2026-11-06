'use strict';

/**
 * Stock request state machine (C4).
 *
 * ONE table of every allowed move: { from, to, actor, guard }.
 * Anything not listed here is refused with 409 INVALID_TRANSITION.
 *
 * Actors
 *   DOCTOR       the doctor who sent the request
 *   SHOP         staff of the shop the request was sent to (origin shop)
 *   TARGET_SHOP  staff of a shop the request was referred to
 *   SYSTEM       background jobs (expireRequests, expireReferralHolds)
 *
 * Guards are named here and looked up in GUARDS. Commit 1 (Nov 4) is the
 * skeleton: every guard passes. Commit 3 (Nov 8) fills them in with the
 * real checks and unit tests.
 *
 *   SENT ──ack──▶ ACKNOWLEDGED ──dispense──▶ PARTIALLY_FULFILLED ──dispense──▶ FULFILLED
 *     │               │   │                        │   ▲
 *     │               │   └──refer──▶ REFERRED ◀───┘   │ step back (reject / cancel /
 *     │               │                 │  └───────────┘ no-show, some already given)
 *     ├──▶ EXPIRED    └──▶ CLOSED       └──▶ FULFILLED (picked up at target shop)
 *     └──▶ CANCELLED (doctor, from any open state; releases holds)
 */

const { AppError } = require('../../shared/errors');
const { RequestStatus: S } = require('../../shared/enums');

const OPEN = Object.freeze([S.SENT, S.ACKNOWLEDGED, S.PARTIALLY_FULFILLED, S.REFERRED]);
const TERMINAL = Object.freeze([S.FULFILLED, S.CLOSED, S.CANCELLED, S.EXPIRED]);

/** @type {ReadonlyArray<{from: string, to: string, actor: string[], guard: string|null}>} */
const TRANSITIONS = Object.freeze(
  [
    // C5: acknowledge only from SENT, and only before it expires
    { from: S.SENT, to: S.ACKNOWLEDGED, actor: ['SHOP'], guard: 'notExpired' },
    // C11: expireRequests job
    { from: S.SENT, to: S.EXPIRED, actor: ['SYSTEM'], guard: 'pastExpiry' },

    // Dispense at the origin shop (C5, via stock.service)
    { from: S.ACKNOWLEDGED, to: S.PARTIALLY_FULFILLED, actor: ['SHOP'], guard: 'partlyFulfilled' },
    { from: S.ACKNOWLEDGED, to: S.FULFILLED, actor: ['SHOP'], guard: 'fullyFulfilled' },
    { from: S.PARTIALLY_FULFILLED, to: S.FULFILLED, actor: ['SHOP'], guard: 'fullyFulfilled' },

    // Referrals (C7)
    { from: S.ACKNOWLEDGED, to: S.REFERRED, actor: ['SHOP'], guard: 'hasLiveReferral' },
    { from: S.PARTIALLY_FULFILLED, to: S.REFERRED, actor: ['SHOP'], guard: 'hasLiveReferral' },
    // Picked up at the target shop (C9)
    { from: S.REFERRED, to: S.FULFILLED, actor: ['TARGET_SHOP'], guard: 'fullyFulfilled' },
    // Step back when the last live referral ends (reject, cancel, no-show, C11)
    { from: S.REFERRED, to: S.PARTIALLY_FULFILLED, actor: ['SHOP', 'TARGET_SHOP', 'SYSTEM'], guard: 'noLiveReferralSomeGiven' },
    { from: S.REFERRED, to: S.ACKNOWLEDGED, actor: ['SHOP', 'TARGET_SHOP', 'SYSTEM'], guard: 'noLiveReferralNoneGiven' },

    // Close with a reason (C5)
    { from: S.ACKNOWLEDGED, to: S.CLOSED, actor: ['SHOP'], guard: 'hasReason' },
    { from: S.PARTIALLY_FULFILLED, to: S.CLOSED, actor: ['SHOP'], guard: 'hasReason' },

    // Doctor cancel from any open state (C5, edge case 11: releases holds)
    { from: S.SENT, to: S.CANCELLED, actor: ['DOCTOR'], guard: null },
    { from: S.ACKNOWLEDGED, to: S.CANCELLED, actor: ['DOCTOR'], guard: null },
    { from: S.PARTIALLY_FULFILLED, to: S.CANCELLED, actor: ['DOCTOR'], guard: null },
    { from: S.REFERRED, to: S.CANCELLED, actor: ['DOCTOR'], guard: null },
  ].map((t) => Object.freeze({ ...t, actor: Object.freeze(t.actor) }))
);

/**
 * Guard implementations. Each takes a context and returns null when the move
 * is allowed, or a short reason string when it isn't.
 * Skeleton (Commit 1): all pass. Real checks land in Commit 3.
 *
 * @typedef {Object} GuardContext
 * @property {Object} request        stock_requests row
 * @property {Date}   [now]
 * @property {number} [liveReferrals] count of PENDING + ACCEPTED referrals
 * @property {string} [reason]
 */
const GUARDS = Object.freeze({
  notExpired: () => null,
  pastExpiry: () => null,
  partlyFulfilled: () => null,
  fullyFulfilled: () => null,
  hasLiveReferral: () => null,
  noLiveReferralSomeGiven: () => null,
  noLiveReferralNoneGiven: () => null,
  hasReason: () => null,
});

function findTransition(from, to) {
  return TRANSITIONS.find((t) => t.from === from && t.to === to) || null;
}

/** Statuses reachable from `from` (optionally only for one actor). */
function nextStatuses(from, actor) {
  return TRANSITIONS.filter((t) => t.from === from && (!actor || t.actor.includes(actor))).map((t) => t.to);
}

/** True when `actor` may move a request from `from` to `to` (table only, no guard). */
function canTransition(from, to, actor) {
  const t = findTransition(from, to);
  return Boolean(t && (!actor || t.actor.includes(actor)));
}

/**
 * Throws 409 INVALID_TRANSITION unless the move is in the table, the actor is
 * allowed and the guard passes. Returns the transition.
 */
function assertTransition(from, to, actor, ctx = {}) {
  const t = findTransition(from, to);
  const refuse = (why) => {
    throw new AppError('INVALID_TRANSITION', `Cannot move request from ${from} to ${to}`, {
      entity: 'stock_request', from, to, actor: actor || null, reason: why,
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

module.exports = {
  TRANSITIONS,
  GUARDS,
  OPEN,
  TERMINAL,
  findTransition,
  nextStatuses,
  canTransition,
  assertTransition,
};
