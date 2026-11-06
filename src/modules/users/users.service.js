'use strict';

const { query } = require('../../db/pool');
const { AppError, fromPgError } = require('../../shared/errors');
const { hashPassword } = require('../../shared/password');

const PG_MAP = { users_email_lower_key: 'EMAIL_TAKEN' };
const COLUMNS = 'id, role, full_name, email, is_active, last_login_at, created_at, updated_at';

/** Public user shape — password_hash is never included (A3). */
function toPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    role: row.role,
    fullName: row.full_name,
    email: row.email,
    isActive: row.is_active,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function create({ role, fullName, email = null, password }, { client } = {}) {
  const passwordHash = await hashPassword(password);
  try {
    const { rows } = await query(
      `INSERT INTO users (role, full_name, email, password_hash)
       VALUES ($1, $2, $3, $4) RETURNING ${COLUMNS}`,
      [role, fullName, email, passwordHash],
      client
    );
    return toPublic(rows[0]);
  } catch (err) {
    throw fromPgError(err, PG_MAP);
  }
}

async function getById(id, { client } = {}) {
  const { rows } = await query(`SELECT ${COLUMNS} FROM users WHERE id = $1`, [id], client);
  return toPublic(rows[0]);
}

async function getByIdOrThrow(id, opts) {
  const user = await getById(id, opts);
  if (!user) throw AppError.notFound('User', id);
  return user;
}

/** Internal: includes password_hash. Only auth uses this. */
async function findForLogin(email) {
  const { rows } = await query(
    `SELECT ${COLUMNS}, password_hash FROM users WHERE lower(email) = lower($1)`,
    [email]
  );
  return rows[0] || null;
}

async function recordLogin(id) {
  await query('UPDATE users SET last_login_at = now() WHERE id = $1', [id]);
}

async function list({ role, isActive, search, limit = 20, offset = 0 } = {}) {
  const where = [];
  const params = [];
  if (role) { params.push(role); where.push(`role = $${params.length}`); }
  if (isActive !== undefined) { params.push(isActive); where.push(`is_active = $${params.length}`); }
  if (search) {
    params.push(`%${search}%`);
    where.push(`(full_name ILIKE $${params.length} OR email ILIKE $${params.length})`);
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { rows: [{ total }] } = await query(`SELECT count(*)::int AS total FROM users ${w}`, params);
  params.push(limit, offset);
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM users ${w} ORDER BY id LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { items: rows.map(toPublic), total, limit, offset };
}

/** patch: { fullName?, email?, password? } */
async function update(id, patch, { client } = {}) {
  const sets = [];
  const params = [id];
  if (patch.fullName !== undefined) { params.push(patch.fullName); sets.push(`full_name = $${params.length}`); }
  if (patch.email !== undefined) { params.push(patch.email); sets.push(`email = $${params.length}`); }
  if (patch.password !== undefined) {
    params.push(await hashPassword(patch.password));
    sets.push(`password_hash = $${params.length}`);
  }
  if (sets.length === 0) return getByIdOrThrow(id, { client });
  try {
    const { rows } = await query(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $1 RETURNING ${COLUMNS}`,
      params,
      client
    );
    if (!rows[0]) throw AppError.notFound('User', id);
    return toPublic(rows[0]);
  } catch (err) {
    throw fromPgError(err, PG_MAP);
  }
}

async function setActive(id, isActive, { client } = {}) {
  const { rows } = await query(
    `UPDATE users SET is_active = $2 WHERE id = $1 RETURNING ${COLUMNS}`,
    [id, isActive],
    client
  );
  if (!rows[0]) throw AppError.notFound('User', id);
  return toPublic(rows[0]);
}

module.exports = { toPublic, create, getById, getByIdOrThrow, findForLogin, recordLogin, list, update, setActive };
