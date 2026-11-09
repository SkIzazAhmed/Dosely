'use strict';

const { query } = require('../../db/pool');
const { withTransaction } = require('../../db/transaction');
const { AppError, fromPgError } = require('../../shared/errors');

const PG_MAP = {
  shops_code_key: 'SHOP_CODE_TAKEN',
  shops_drug_licence_key: 'DRUG_LICENCE_TAKEN',
  shops_pincode_check: 'INVALID_PINCODE',
  shops_coordinates_check: 'INVALID_COORDINATES',
  shop_staff_shop_user_key: 'STAFF_ALREADY_EXISTS',
};

const COLUMNS = `id, name, code, drug_licence_no, address, area, city, pincode, latitude, longitude,
                 is_active, created_at, updated_at`;

function toPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    drugLicenceNo: row.drug_licence_no,
    address: row.address,
    area: row.area,
    city: row.city,
    pincode: row.pincode,
    latitude: row.latitude,
    longitude: row.longitude,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function staffToPublic(row) {
  return {
    shopId: row.shop_id,
    userId: row.user_id,
    fullName: row.full_name,
    email: row.email,
    staffRole: row.staff_role,
    isActive: row.is_active,
    userIsActive: row.user_is_active,
    addedBy: row.added_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapError(err) {
  return fromPgError(err, PG_MAP);
}

// ---------------------------------------------------------------------------
// Shops (A6)
// ---------------------------------------------------------------------------

/**
 * Create a shop and make ownerUserId its OWNER, in one transaction.
 * input: { name, code, drugLicenceNo, address, area, city?, pincode, latitude?, longitude? }
 */
async function create(input, ownerUserId) {
  try {
    return await withTransaction(async (client) => {
      const { rows: [row] } = await client.query(
        `INSERT INTO shops (name, code, drug_licence_no, address, area, city, pincode, latitude, longitude)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${COLUMNS}`,
        [input.name, input.code, input.drugLicenceNo, input.address, input.area, input.city ?? null,
          input.pincode, input.latitude ?? null, input.longitude ?? null]
      );
      await client.query(
        `INSERT INTO shop_staff (shop_id, user_id, staff_role, added_by) VALUES ($1, $2, 'OWNER', $2)`,
        [row.id, ownerUserId]
      );
      return toPublic(row);
    });
  } catch (err) {
    throw mapError(err);
  }
}

async function getById(id, { client } = {}) {
  const { rows } = await query(`SELECT ${COLUMNS} FROM shops WHERE id = $1`, [id], client);
  return toPublic(rows[0]);
}

async function getByIdOrThrow(id, opts) {
  const shop = await getById(id, opts);
  if (!shop) throw AppError.notFound('Shop', id);
  return shop;
}

/**
 * filters: { search?, area?, pincode?, isActive?, staffUserId? (shops this user works at) }
 */
async function list({ search, area, pincode, isActive, staffUserId, limit = 20, offset = 0 } = {}) {
  const where = [];
  const params = [];
  const add = (sql, v) => { params.push(v); where.push(sql.replaceAll('?', `$${params.length}`)); };
  if (isActive !== undefined) add('s.is_active = ?', isActive);
  if (area) add('lower(s.area) = lower(?)', area);
  if (pincode) add('s.pincode = ?', pincode);
  if (search) add('(s.name ILIKE ? OR s.code ILIKE ? OR s.area ILIKE ?)', `%${search}%`);
  if (staffUserId) add('EXISTS (SELECT 1 FROM shop_staff ss WHERE ss.shop_id = s.id AND ss.user_id = ? AND ss.is_active)', staffUserId);
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { rows: [{ total }] } = await query(`SELECT count(*)::int AS total FROM shops s ${w}`, params);
  params.push(limit, offset);
  const { rows } = await query(
    `SELECT ${COLUMNS.split(',').map((c) => `s.${c.trim()}`).join(', ')}
       FROM shops s ${w} ORDER BY s.id LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { items: rows.map(toPublic), total, limit, offset };
}

const COLUMN = {
  name: 'name', code: 'code', drugLicenceNo: 'drug_licence_no', address: 'address', area: 'area',
  city: 'city', pincode: 'pincode', latitude: 'latitude', longitude: 'longitude',
};

async function update(id, patch) {
  const sets = [];
  const params = [id];
  for (const [k, col] of Object.entries(COLUMN)) {
    if (patch[k] !== undefined) { params.push(patch[k]); sets.push(`${col} = $${params.length}`); }
  }
  if (sets.length === 0) return getByIdOrThrow(id);
  try {
    const { rows } = await query(`UPDATE shops SET ${sets.join(', ')} WHERE id = $1 RETURNING ${COLUMNS}`, params);
    if (!rows[0]) throw AppError.notFound('Shop', id);
    return toPublic(rows[0]);
  } catch (err) {
    throw mapError(err);
  }
}

async function setActive(id, isActive) {
  const { rows } = await query(`UPDATE shops SET is_active = $2 WHERE id = $1 RETURNING ${COLUMNS}`, [id, isActive]);
  if (!rows[0]) throw AppError.notFound('Shop', id);
  return toPublic(rows[0]);
}

/**
 * For Anushka's requests/referrals (A6): call before sending a request or
 * referral to a shop. Returns the shop, or throws NOT_FOUND / SHOP_INACTIVE.
 */
async function assertCanReceiveRequests(shopId, { client } = {}) {
  const shop = await getById(shopId, { client });
  if (!shop) throw AppError.notFound('Shop', shopId);
  if (!shop.isActive) throw new AppError('SHOP_INACTIVE', undefined, { shopId });
  return shop;
}

// ---------------------------------------------------------------------------
// Shop staff (A7)
// ---------------------------------------------------------------------------

const STAFF_SELECT = `
  SELECT ss.shop_id, ss.user_id, ss.staff_role, ss.is_active, ss.added_by, ss.created_at, ss.updated_at,
         u.full_name, u.email, u.is_active AS user_is_active
    FROM shop_staff ss
    JOIN users u ON u.id = ss.user_id`;

async function listStaff(shopId, { includeRemoved = false } = {}) {
  const { rows } = await query(
    `${STAFF_SELECT} WHERE ss.shop_id = $1 ${includeRemoved ? '' : 'AND ss.is_active'}
     ORDER BY ss.staff_role, u.full_name`,
    [shopId]
  );
  return rows.map(staffToPublic);
}

async function getStaff(shopId, userId, { client } = {}) {
  const { rows } = await query(`${STAFF_SELECT} WHERE ss.shop_id = $1 AND ss.user_id = $2`, [shopId, userId], client);
  return rows[0] ? staffToPublic(rows[0]) : null;
}

/**
 * Add a SHOPKEEPER user as OWNER or STAFF. Re-adding someone who was removed
 * re-activates their row with the new role.
 */
async function addStaff(shopId, userId, staffRole, addedBy) {
  try {
    return await withTransaction(async (client) => {
      await lockShop(client, shopId);
      const existing = await getStaff(shopId, userId, { client });
      if (existing && existing.isActive) throw new AppError('STAFF_ALREADY_EXISTS', undefined, { shopId, userId });
      if (existing) {
        await client.query(
          `UPDATE shop_staff SET is_active = true, staff_role = $3, added_by = $4 WHERE shop_id = $1 AND user_id = $2`,
          [shopId, userId, staffRole, addedBy]
        );
      } else {
        await client.query(
          `INSERT INTO shop_staff (shop_id, user_id, staff_role, added_by) VALUES ($1, $2, $3, $4)`,
          [shopId, userId, staffRole, addedBy]
        );
      }
      return getStaff(shopId, userId, { client });
    });
  } catch (err) {
    throw mapError(err);
  }
}

async function lockShop(client, shopId) {
  const { rowCount } = await client.query('SELECT 1 FROM shops WHERE id = $1 FOR UPDATE', [shopId]);
  if (!rowCount) throw AppError.notFound('Shop', shopId);
}

async function assertNotLastOwner(client, shopId, userId) {
  const { rows: [{ n }] } = await client.query(
    `SELECT count(*)::int AS n FROM shop_staff
      WHERE shop_id = $1 AND staff_role = 'OWNER' AND is_active AND user_id <> $2`,
    [shopId, userId]
  );
  if (n === 0) throw new AppError('LAST_OWNER', undefined, { shopId });
}

/** Change OWNER <-> STAFF. A shop always keeps at least one active OWNER. */
async function changeStaffRole(shopId, userId, staffRole) {
  return withTransaction(async (client) => {
    await lockShop(client, shopId);
    const current = await getStaff(shopId, userId, { client });
    if (!current || !current.isActive) throw new AppError('STAFF_NOT_FOUND', undefined, { shopId, userId });
    if (current.staffRole === 'OWNER' && staffRole !== 'OWNER') await assertNotLastOwner(client, shopId, userId);
    await client.query('UPDATE shop_staff SET staff_role = $3 WHERE shop_id = $1 AND user_id = $2', [shopId, userId, staffRole]);
    return getStaff(shopId, userId, { client });
  });
}

/** Remove (deactivate) a staff member. Removed staff stop getting shop notifications. */
async function removeStaff(shopId, userId) {
  return withTransaction(async (client) => {
    await lockShop(client, shopId);
    const current = await getStaff(shopId, userId, { client });
    if (!current || !current.isActive) throw new AppError('STAFF_NOT_FOUND', undefined, { shopId, userId });
    if (current.staffRole === 'OWNER') await assertNotLastOwner(client, shopId, userId);
    await client.query('UPDATE shop_staff SET is_active = false WHERE shop_id = $1 AND user_id = $2', [shopId, userId]);
    return getStaff(shopId, userId, { client });
  });
}

/**
 * For notification.service fan-out (A7, A10): user ids of everyone who should
 * get a shop's notifications — active staff rows whose user is also active.
 */
async function listActiveStaffUserIds(shopId, { client } = {}) {
  const { rows } = await query(
    `SELECT ss.user_id FROM shop_staff ss JOIN users u ON u.id = ss.user_id
      WHERE ss.shop_id = $1 AND ss.is_active AND u.is_active ORDER BY ss.user_id`,
    [shopId],
    client
  );
  return rows.map((r) => r.user_id);
}

/** Shops a user actively works at: [{ shopId, staffRole }] */
async function listShopsForUser(userId) {
  const { rows } = await query(
    `SELECT shop_id, staff_role FROM shop_staff WHERE user_id = $1 AND is_active ORDER BY shop_id`,
    [userId]
  );
  return rows.map((r) => ({ shopId: r.shop_id, staffRole: r.staff_role }));
}

module.exports = {
  toPublic,
  create,
  getById,
  getByIdOrThrow,
  list,
  update,
  setActive,
  assertCanReceiveRequests,
  listStaff,
  getStaff,
  addStaff,
  changeStaffRole,
  removeStaff,
  listActiveStaffUserIds,
  listShopsForUser,
};
