'use strict';

/** C11: SENT requests past their expiry → EXPIRED. Every 5 minutes. */
const requests = require('../modules/requests/request.service');

module.exports = { name: 'expireRequests', everyMs: 5 * 60_000, run: () => requests.expireDue() };
