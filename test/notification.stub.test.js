'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const svc = require('../src/modules/notifications/notification.service');

const base = { type: 'LOW_STOCK', title: 'Low stock', body: 'Paracetamol 500mg below 10 strips' };

test('notifyShop returns one row per channel with the agreed shape', async () => {
  const res = await svc.notifyShop(7, { ...base, channels: ['IN_APP', 'SMS'], dedupeKey: 'low-stock:7:42' });
  assert.equal(res.deduped, false);
  assert.equal(res.notifications.length, 2);
  for (const n of res.notifications) {
    assert.ok(Number.isInteger(n.id));
    assert.ok(['IN_APP', 'SMS'].includes(n.channel));
    assert.equal(n.status, 'PENDING');
  }
});

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
