'use strict';

/**
 * SMS and EMAIL channels (A11). Only the stub provider exists in the MVP:
 * it records messages in memory and logs them instead of sending.
 *
 * Each provider has: send({ to, body, subject? }) → { providerMessageId }
 * and throws a DeliveryError when the message couldn't be delivered.
 *
 * Adding a real SMS gateway later (MSG91, Twilio, …) = one more provider here
 * with the same send() shape, picked by SMS_PROVIDER in .env.
 *
 * Stub failures, to try retries and P13 by hand: NOTIFY_STUB_FAIL in .env, or
 * in tests `channels.stub.setFailing('+919810000105', true)`.
 */

const crypto = require('node:crypto');
const config = require('../../config');

const SMS_MAX = 160;

class DeliveryError extends Error {
  constructor(message, { permanent = false } = {}) {
    super(message);
    this.name = 'DeliveryError';
    this.permanent = permanent; // permanent = don't bother retrying (e.g. body too long)
  }
}

// node --test sets NODE_TEST_CONTEXT; keep test output clean
const quiet = Boolean(process.env.NODE_TEST_CONTEXT) || config.isTest;

function createStub(kind) {
  const outbox = [];
  const failing = new Set(config.notifications.stubFail);
  return {
    name: 'stub',
    outbox,
    setFailing(destination, on = true) {
      if (on) failing.add(destination);
      else failing.delete(destination);
    },
    reset() {
      outbox.length = 0;
      failing.clear();
      config.notifications.stubFail.forEach((d) => failing.add(d));
    },
    async send({ to, body, subject }) {
      if (failing.has(to)) throw new DeliveryError(`stub: ${kind} to ${to} failed (in NOTIFY_STUB_FAIL)`);
      const providerMessageId = `stub-${kind.toLowerCase()}-${crypto.randomUUID()}`;
      outbox.push({ to, body, subject: subject || null, providerMessageId, at: new Date() });
      if (!quiet) console.log(`[${kind} stub] → ${to}${subject ? ` [${subject}]` : ''}: ${body}`);
      return { providerMessageId };
    },
  };
}

const smsStub = createStub('SMS');
const emailStub = createStub('EMAIL');

const SMS_PROVIDERS = { stub: smsStub };
const EMAIL_PROVIDERS = { stub: emailStub };

function provider(map, name, kind) {
  const p = map[name];
  if (!p) throw new Error(`Unknown ${kind} provider "${name}" — only "stub" exists in the MVP`);
  return p;
}

const sms = {
  async send({ to, body }) {
    if (body.length > SMS_MAX) throw new DeliveryError(`SMS body is ${body.length} characters (max ${SMS_MAX})`, { permanent: true });
    return provider(SMS_PROVIDERS, config.notifications.smsProvider, 'SMS').send({ to, body });
  },
};

const email = {
  async send({ to, subject, body }) {
    return provider(EMAIL_PROVIDERS, config.notifications.emailProvider, 'EMAIL').send({ to, subject, body });
  },
};

module.exports = { sms, email, DeliveryError, SMS_MAX, stub: { sms: smsStub, email: emailStub } };
