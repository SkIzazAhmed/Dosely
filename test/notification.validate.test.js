'use strict';

/** notification.service input checks — no database needed (they run before any query). */

const test = require('node:test');
const assert = require('node:assert/strict');
const svc = require('../src/modules/notifications/notification.service');

const base = { type: 'LOW_STOCK', title: 'Low stock', body: 'Paracetamol 500mg below 10 strips' };

test('SMS bodies over 160 characters are rejected', async () => {
  await assert.rejects(
    svc.notifyUser(1, { ...base, channels: ['SMS'], body: 'x'.repeat(161) }),
    (e) => e.code === 'SMS_TOO_LONG'
  );
});

test('patients cannot get IN_APP notifications', async () => {
  await assert.rejects(
    svc.notifyPatient(3, { ...base, channels: ['IN_APP'] }),
    (e) => e.code === 'VALIDATION_ERROR'
  );
});

test('invalid input lists every bad field', async () => {
  await assert.rejects(svc.notify({ recipientType: 'NOPE', recipientId: -1, channels: [] }), (e) => {
    assert.equal(e.code, 'VALIDATION_ERROR');
    assert.deepEqual(e.details.map((d) => d.field), ['recipientType', 'recipientId', 'channels', 'type', 'title', 'body']);
    return true;
  });
});

test('type must be UPPER_SNAKE_CASE and data an object', async () => {
  await assert.rejects(svc.notifyUser(1, { ...base, channels: ['IN_APP'], type: 'low stock' }), (e) => e.details[0].field === 'type');
  await assert.rejects(svc.notifyUser(1, { ...base, channels: ['IN_APP'], data: [1] }), (e) => e.details[0].field === 'data');
});
