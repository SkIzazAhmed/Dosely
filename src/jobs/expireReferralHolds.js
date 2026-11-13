'use strict';

/** C11: ACCEPTED referrals past hold_until → NO_SHOW, stock released, request steps back. Every 5 minutes. */
const referrals = require('../modules/referrals/referral.service');

module.exports = { name: 'expireReferralHolds', everyMs: 5 * 60_000, run: () => referrals.expireHolds() };
