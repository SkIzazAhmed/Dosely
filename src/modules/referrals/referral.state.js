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
 * A failing guard is also 409 INVALID_TRANSITION, with the reason in error.details.reason.
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

/**
 * Guards. ctx: { referral (row or public), now?, available?, reason?, verified? }
 *   stockAvailable  target shop's available qty (ctx.available) covers the referral
 *   hasReason       reject reason, 1–500 characters
 *   pickupVerified  request number + last 5 phone digits matched (ctx.verified === true, C9)
 *   holdExpired     now >= hold_until (expireReferralHolds job, C11)
 */
const val = (ref, camel, snake) => (ref[camel] !== undefined ? ref[camel] : ref[snake]);

const GUARDS = Object.freeze({
  stockAvailable: (ctx) => {
    if (!ctx || !ctx.referral) return 'missing referral';
    if (ctx.available === undefined) return 'missing available';
    return ctx.available >= ctx.referral.quantity ? null : 'target shop does not have enough stock';
  },
  hasReason: (ctx) => {
    const r = ctx && typeof ctx.reason === 'string' ? ctx.reason.trim() : '';
    if (!r) return 'a reason is required';
    return r.length <= 500 ? null : 'reason must be at most 500 characters';
  },
  pickupVerified: (ctx) => (ctx && ctx.verified === true ? null : 'pickup is not verified'),
  holdExpired: (ctx) => {
    if (!ctx || !ctx.referral) return 'missing referral';
    const hold = val(ctx.referral, 'holdUntil', 'hold_until');
    if (!hold) return 'referral has no hold';
    const now = ctx.now ? new Date(ctx.now).getTime() : Date.now();
    return now >= new Date(hold).getTime() ? null : 'hold has not expired yet';
  },
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
