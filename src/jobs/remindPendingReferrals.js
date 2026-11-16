'use strict';

/** C11: PENDING referrals unanswered for 2 hours → one reminder to the origin shop. Every 5 minutes. */
const referrals = require('../modules/referrals/referral.service');

module.exports = { name: 'remindPendingReferrals', everyMs: 5 * 60_000, run: () => referrals.remindPending({ hours: 2 }) };
