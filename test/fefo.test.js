'use strict';

/** FEFO unit tests (B8) — pure planning, no database. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { planFefo, byExpiry } = require('../src/modules/inventory/fefo');

const row = (batchId, expiryDate, free) => ({ batchId, expiryDate, free });
const picks = (r) => r.plan.map((p) => [p.row.batchId, p.quantity]);

test('takes the earliest expiry first', () => {
  const r = planFefo([row(1, '2028-01-31', 10), row(2, '2027-03-31', 10), row(3, '2027-12-31', 10)], 5);
  assert.deepEqual(picks(r), [[2, 5]]);
});

test('spills over into the next-earliest batches', () => {
  const r = planFefo([row(1, '2028-01-31', 10), row(2, '2027-03-31', 4), row(3, '2027-12-31', 5)], 12);
  assert.deepEqual(picks(r), [[2, 4], [3, 5], [1, 3]]);
  assert.equal(r.available, 19);
});

test('same expiry: the older batch (lower id) goes first', () => {
  assert.deepEqual(picks(planFefo([row(9, '2027-06-30', 5), row(4, '2027-06-30', 5)], 7)), [[4, 5], [9, 2]]);
});

test('skips rows with nothing free (all reserved or empty)', () => {
  assert.deepEqual(picks(planFefo([row(1, '2027-01-31', 0), row(2, '2027-02-28', -3), row(3, '2027-09-30', 6)], 6)), [[3, 6]]);
});

test('exactly enough takes everything; one short takes nothing and reports what there is', () => {
  const rows = [row(1, '2027-01-31', 3), row(2, '2027-02-28', 2)];
  assert.deepEqual(picks(planFefo(rows, 5)), [[1, 3], [2, 2]]);
  assert.deepEqual(planFefo(rows, 6), { available: 5, enough: false, plan: [] });
  assert.deepEqual(planFefo([], 1), { available: 0, enough: false, plan: [] });
});

test('does not reorder or change the rows it was given', () => {
  const rows = [row(1, '2028-01-31', 10), row(2, '2027-03-31', 10)];
  const copy = JSON.parse(JSON.stringify(rows));
  planFefo(rows, 15);
  assert.deepEqual(rows, copy);
});

test('byExpiry compares YYYY-MM-DD dates correctly across years and months', () => {
  const sorted = [row(1, '2027-10-01', 1), row(2, '2027-09-30', 1), row(3, '2026-12-31', 1)].sort(byExpiry);
  assert.deepEqual(sorted.map((r) => r.batchId), [3, 2, 1]);
});
