'use strict';

/**
 * GENERICS (B1): the salt / molecule a medicine contains, e.g. "Paracetamol".
 * Names are unique ignoring case and surrounding spaces.
 */

const { query } = require('../../db/pool');
const { AppError, fromPgError } = require('../../shared/errors');

const PG_MAP = { generics_name_lower_key: 'GENERIC_NAME_TAKEN' };

const SELECT = `
  SELECT g.id, g.name, g.description, g.is_active, g.created_at, g.updated_at,
         (SELECT count(*)::int FROM medicines m WHERE m.generic_id = g.id) AS medicine_count
    FROM generics g`;

function toPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    medicineCount: row.medicine_count,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getById(id, { client } = {}) {
  const { rows } = await query(`${SELECT} WHERE g.id = $1`, [id], client);
  return toPublic(rows[0]);
}

async function getByIdOrThrow(id, opts) {
  const g = await getById(id, opts);
  if (!g) throw AppError.notFound('Generic', id);
  return g;
}

async function create({ name, description = null }, { client } = {}) {
  try {
    const { rows: [{ id }] } = await query(
      'INSERT INTO generics (name, description) VALUES ($1, $2) RETURNING id',
      [name.trim(), description],
      client
    );
    return getById(id, { client });
  } catch (err) {
    throw fromPgError(err, PG_MAP);
  }
}

/**
 * Find a generic by name (case-insensitive) or create it. Used when an admin
 * creates a medicine with `genericName` instead of `genericId`.
 * A deactivated generic is returned as-is; the caller decides what to do.
 */
async function findOrCreate(name, { client } = {}) {
  const clean = name.trim();
  const { rows } = await query(
    `INSERT INTO generics (name) VALUES ($1)
     ON CONFLICT (lower(btrim(name))) DO NOTHING
     RETURNING id`,
    [clean],
    client
  );
  if (rows[0]) return getById(rows[0].id, { client });
  const found = await query('SELECT id FROM generics WHERE lower(btrim(name)) = lower($1)', [clean], client);
  return getById(found.rows[0].id, { client });
}

async function list({ q, isActive, limit = 20, offset = 0 } = {}) {
  const where = [];
  const params = [];
  if (isActive !== undefined) { params.push(isActive); where.push(`g.is_active = $${params.length}`); }
  if (q) { params.push(`%${q}%`); where.push(`g.name ILIKE $${params.length}`); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { rows: [{ total }] } = await query(`SELECT count(*)::int AS total FROM generics g ${w}`, params);
  params.push(limit, offset);
  const { rows } = await query(
    `${SELECT} ${w} ORDER BY lower(g.name), g.id LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { items: rows.map(toPublic), total, limit, offset };
}

async function update(id, patch, { client } = {}) {
  const sets = [];
  const params = [id];
  if (patch.name !== undefined) { params.push(patch.name.trim()); sets.push(`name = $${params.length}`); }
  if (patch.description !== undefined) { params.push(patch.description); sets.push(`description = $${params.length}`); }
  if (patch.isActive !== undefined) { params.push(patch.isActive); sets.push(`is_active = $${params.length}`); }
  if (sets.length === 0) return getByIdOrThrow(id, { client });
  try {
    const { rowCount } = await query(`UPDATE generics SET ${sets.join(', ')} WHERE id = $1`, params, client);
    if (!rowCount) throw AppError.notFound('Generic', id);
    return getById(id, { client });
  } catch (err) {
    throw fromPgError(err, PG_MAP);
  }
}

module.exports = { create, findOrCreate, getById, getByIdOrThrow, list, update };
