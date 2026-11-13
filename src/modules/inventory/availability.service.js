'use strict';

/**
 * Availability lookup (C6, Anushka): which active shops can cover a need?
 *
 * Uses Rachana's stock.getAvailable (non-expired, unreserved units per active
 * shop), keeps shops with available >= minQty and ranks them:
 *   1. distance from the origin shop (km, when both shops have coordinates;
 *      shops without coordinates come after all that have them)
 *   2. same pincode as the origin shop
 *   3. same area as the origin shop
 *   4. more available first, then shop id (stable order)
 * Without an origin shop only rule 4 applies.
 */

const { query } = require('../../db/pool');
const { AppError } = require('../../shared/errors');
const stock = require('./stock.service');

const EARTH_KM = 6371;

/** Great-circle distance in km, or null when either point is missing. */
function distanceKm(a, b) {
  if (!a || !b || a.latitude == null || b.latitude == null) return null;
  const rad = (d) => (Number(d) * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * EARTH_KM * Math.asin(Math.sqrt(h)) * 100) / 100;
}

const sameText = (x, y) => x != null && y != null && String(x).trim().toLowerCase() === String(y).trim().toLowerCase();

function rank(origin, a, b) {
  if (origin) {
    if (a.distanceKm !== b.distanceKm) {
      if (a.distanceKm == null) return 1;
      if (b.distanceKm == null) return -1;
      return a.distanceKm - b.distanceKm;
    }
    if (a.samePincode !== b.samePincode) return a.samePincode ? -1 : 1;
    if (a.sameArea !== b.sameArea) return a.sameArea ? -1 : 1;
  }
  return b.available - a.available || a.shop.id - b.shop.id;
}

async function shopRows(ids, client) {
  if (!ids.length) return new Map();
  const { rows } = await query(
    `SELECT id, name, code, address, area, city, pincode, latitude::float8 AS latitude, longitude::float8 AS longitude,
            is_active
       FROM shops WHERE id = ANY($1::bigint[])`,
    [ids],
    client
  );
  return new Map(rows.map((r) => [Number(r.id), r]));
}

/**
 * @param {Object} q
 * @param {number} q.medicineId
 * @param {number} [q.minQty=1]          the need; shops with less are left out
 * @param {number} [q.nearShopId]        origin shop to rank from (left out of results)
 * @param {number[]} [q.excludeShopIds]  also leave these out
 * @param {number} [q.limit=20]
 * @param {{client?: import('pg').PoolClient}} [opts]
 * @returns {Promise<Array<{shop:Object, available:number, nearestExpiry:string,
 *           distanceKm:(number|null), samePincode:boolean, sameArea:boolean}>>}
 */
async function lookup({ medicineId, minQty = 1, nearShopId, excludeShopIds = [], limit = 20 }, opts = {}) {
  const { client } = opts;
  const { rows: [med] } = await query('SELECT id, is_active FROM medicines WHERE id = $1', [medicineId], client);
  if (!med) throw AppError.notFound('Medicine', medicineId);
  if (!med.is_active) throw new AppError('MEDICINE_INACTIVE', undefined, { medicineId });

  let origin = null;
  if (nearShopId) {
    origin = (await shopRows([nearShopId], client)).get(Number(nearShopId));
    if (!origin) throw AppError.notFound('Shop', nearShopId);
  }

  const exclude = new Set([...excludeShopIds, ...(nearShopId ? [nearShopId] : [])].map(Number));
  const found = (await stock.getAvailable(medicineId, {}, { client })).filter(
    (r) => r.available >= minQty && !exclude.has(Number(r.shopId))
  );
  const shops = await shopRows(found.map((r) => r.shopId), client);

  return found
    .map((r) => {
      const s = shops.get(Number(r.shopId));
      if (!s || !s.is_active) return null; // deactivated shop (edge case 13)
      return {
        shop: {
          id: s.id, name: s.name, code: s.code, address: s.address, area: s.area, city: s.city, pincode: s.pincode,
          latitude: s.latitude, longitude: s.longitude,
        },
        available: r.available,
        nearestExpiry: r.nearestExpiry,
        distanceKm: distanceKm(origin, s),
        samePincode: Boolean(origin) && sameText(origin.pincode, s.pincode),
        sameArea: Boolean(origin) && sameText(origin.area, s.area),
      };
    })
    .filter(Boolean)
    .sort((a, b) => rank(origin, a, b))
    .slice(0, limit);
}

module.exports = { lookup, distanceKm };
