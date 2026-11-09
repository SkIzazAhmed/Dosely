'use strict';

/**
 * Shop checks for the requests module.
 *
 * The shops and shop_staff tables land in Izaz's Commit 3. Until they are in
 * the database this adapter runs as a STUB:
 *   - any positive shop id counts as an active shop
 *   - any SHOPKEEPER counts as staff of every shop
 * As soon as both tables exist the real checks are used automatically, so
 * no code here has to change when they land.
 */

const { query } = require('../../db/pool');
const { AppError } = require('../../shared/errors');

let ready = false; // cached once the tables exist (they never go away)

async function tablesReady({ client } = {}) {
  if (ready) return true;
  const { rows: [r] } = await query(
    `SELECT to_regclass('public.shops') IS NOT NULL AND to_regclass('public.shop_staff') IS NOT NULL AS ok`,
    [],
    client
  );
  ready = r.ok;
  return ready;
}

/** Throws NOT_FOUND / SHOP_INACTIVE unless the shop exists and is active (edge case 13). */
async function assertShopActive(shopId, { client } = {}) {
  if (!(await tablesReady({ client }))) return { id: shopId, stub: true };
  const { rows: [shop] } = await query('SELECT id, is_active FROM shops WHERE id = $1', [shopId], client);
  if (!shop) throw AppError.notFound('Shop', shopId);
  if (!shop.is_active) throw new AppError('SHOP_INACTIVE', undefined, { shopId });
  return { id: shop.id, stub: false };
}

/** Throws NOT_SHOP_STAFF unless `user` is active staff of `shopId`. ADMIN always passes. */
async function assertStaff(user, shopId, { client } = {}) {
  if (user.role === 'ADMIN') return 'ADMIN';
  if (user.role !== 'SHOPKEEPER') throw new AppError('NOT_SHOP_STAFF', undefined, { shopId });
  if (!(await tablesReady({ client }))) return 'STAFF';
  const { rows } = await query(
    `SELECT ss.staff_role
       FROM shop_staff ss
       JOIN shops s ON s.id = ss.shop_id
      WHERE ss.shop_id = $1 AND ss.user_id = $2 AND ss.is_active`,
    [shopId, user.id],
    client
  );
  if (rows.length === 0) throw new AppError('NOT_SHOP_STAFF', undefined, { shopId });
  return rows[0].staff_role;
}

module.exports = { tablesReady, assertShopActive, assertStaff };
