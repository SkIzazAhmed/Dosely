'use strict';

/** C10: send patient SMS batches whose 10-minute window has closed. Every minute. */
const messages = require('../modules/referrals/referral.messages');

module.exports = { name: 'sendPatientReferralSms', everyMs: 60_000, run: () => messages.sendDueBatches() };
