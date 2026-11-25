'use strict';

/**
 * FEFO planning (B8): first expiry, first out. Pure functions, no database,
 * shared by dispense and reserve so both pick batches the same way.
 */

/** Earliest expiry first; ties go to the older batch (lower id). Dates are 'YYYY-MM-DD'. */
function byExpiry(a, b) {
  if (a.expiryDate < b.expiryDate) return -1;
  if (a.expiryDate > b.expiryDate) return 1;
  return a.batchId - b.batchId;
}

/**
 * Decide how many units to take from each batch.
 * @param {Array<{batchId:number, expiryDate:string, free:number}>} rows  sellable rows (expired ones already excluded)
 * @param {number} quantity  units wanted (> 0)
 * @returns {{available:number, enough:boolean, plan:Array<{row:Object, quantity:number}>}}
 *          plan is in FEFO order and empty when there isn't enough
 */
function planFefo(rows, quantity) {
  const sorted = rows.filter((r) => r.free > 0).sort(byExpiry);
  const available = sorted.reduce((n, r) => n + r.free, 0);
  if (available < quantity) return { available, enough: false, plan: [] };
  const plan = [];
  let left = quantity;
  for (const row of sorted) {
    if (left === 0) break;
    const take = Math.min(left, row.free);
    plan.push({ row, quantity: take });
    left -= take;
  }
  return { available, enough: true, plan };
}

module.exports = { byExpiry, planFefo };
