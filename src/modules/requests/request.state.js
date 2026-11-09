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
 * Guards are named here and looked up in GUARDS; a failing guard is also
 * 409 INVALID_TRANSITION, with the guard's reason in error.details.reason.
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
 * Guards (Commit 3). Each takes a context and returns null when the move is
 * allowed, or a short reason when it isn't (sent back in error.details.reason).
 *
 * @typedef {Object} GuardContext
 * @property {Object} request         public request (request.model toPublic)
 * @property {Date}   [now]           defaults to new Date()
 * @property {number} [fulfilledQty]  fulfilled quantity AFTER the move (dispense);
 *                                    defaults to request.fulfilledQty
 * @property {number} [liveReferrals] PENDING + ACCEPTED referrals AFTER the move
 * @property {string} [reason]        close reason
 */
const expiresAt = (ctx) => new Date(ctx.request.expiresAt).getTime();
const nowMs = (ctx) => (ctx.now ? new Date(ctx.now).getTime() : Date.now());
const fulfilled = (ctx) => (ctx.fulfilledQty !== undefined ? ctx.fulfilledQty : ctx.request.fulfilledQty);
const live = (ctx) => ctx.liveReferrals;

function needs(ctx, ...fields) {
  if (!ctx || !ctx.request) return 'missing request';
  for (const f of fields) if (ctx[f] === undefined) return `missing ${f}`;
  return null;
}

const GUARDS = Object.freeze({
  notExpired: (ctx) => needs(ctx) || (nowMs(ctx) < expiresAt(ctx) ? null : 'request has expired'),
  pastExpiry: (ctx) => needs(ctx) || (nowMs(ctx) >= expiresAt(ctx) ? null : 'request has not expired yet'),
  partlyFulfilled: (ctx) => {
    const miss = needs(ctx);
    if (miss) return miss;
    const n = fulfilled(ctx);
    return n > 0 && n < ctx.request.requestedQty ? null : 'fulfilled quantity must be more than 0 and less than requested';
  },
  fullyFulfilled: (ctx) =>
    needs(ctx) || (fulfilled(ctx) === ctx.request.requestedQty ? null : 'fulfilled quantity must equal requested quantity'),
  hasLiveReferral: (ctx) => needs(ctx, 'liveReferrals') || (live(ctx) > 0 ? null : 'request has no live referral'),
  noLiveReferralSomeGiven: (ctx) =>
    needs(ctx, 'liveReferrals') ||
    (live(ctx) > 0 ? 'request still has a live referral' : fulfilled(ctx) > 0 ? null : 'nothing has been dispensed yet'),
  noLiveReferralNoneGiven: (ctx) =>
    needs(ctx, 'liveReferrals') ||
    (live(ctx) > 0 ? 'request still has a live referral' : fulfilled(ctx) === 0 ? null : 'some quantity was already dispensed'),
  hasReason: (ctx) => {
    const r = ctx && typeof ctx.reason === 'string' ? ctx.reason.trim() : '';
    if (!r) return 'a reason is required';
    return r.length <= 500 ? null : 'reason must be at most 500 characters';
  },
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
