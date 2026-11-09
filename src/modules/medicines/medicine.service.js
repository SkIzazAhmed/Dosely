'use strict';

/**
 * MEDICINES (B1, B2): catalog search for every logged-in user, create / edit /
 * deactivate for admins. A medicine can be hard-deleted only while it has no
 * batches; after that, 409 MEDICINE_IN_USE (edge case 5) — deactivate instead.
 */

const { query } = require('../../db/pool');
const { withTransaction } = require('../../db/transaction');
const { AppError, fromPgError } = require('../../shared/errors');
const generics = require('./generic.service');
const batches = require('./batch.service');

const PG_MAP = {
  medicines_identity_key: 'MEDICINE_DUPLICATE',
  medicines_generic_id_fkey: 'VALIDATION_ERROR',
  medicine_batches_medicine_id_fkey: 'MEDICINE_IN_USE',
  medicine_batches_medicine_batch_no_key: 'BATCH_NO_TAKEN',
};

const SELECT = `
  SELECT m.id, m.brand_name, m.generic_id, g.name AS generic_name, m.manufacturer, m.dosage_form,
         m.strength, m.base_unit, m.prescription_required, m.is_active, m.created_at, m.updated_at
    FROM medicines m
    JOIN generics g ON g.id = m.generic_id`;

function toPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    brandName: row.brand_name,
    generic: { id: row.generic_id, name: row.generic_name },
    manufacturer: row.manufacturer,
    dosageForm: row.dosage_form,
    strength: row.strength,
    baseUnit: row.base_unit,
    prescriptionRequired: row.prescription_required,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapError(err) {
  const e = fromPgError(err, PG_MAP);
  if (e.code === 'VALIDATION_ERROR' && e.details?.constraint === 'medicines_generic_id_fkey') {
    return AppError.validation([{ field: 'genericId', issue: 'generic does not exist' }]);
  }
  return e;
}

async function getById(id, { client } = {}) {
  const { rows } = await query(`${SELECT} WHERE m.id = $1`, [id], client);
  return toPublic(rows[0]);
}

async function getByIdOrThrow(id, opts) {
  const m = await getById(id, opts);
  if (!m) throw AppError.notFound('Medicine', id);
  return m;
}

/** Medicine with its sellable (non-expired, active) batches. */
async function getWithBatches(id, { includeExpired = false } = {}) {
  const m = await getByIdOrThrow(id);
  return { ...m, batches: await batches.listForMedicine(id, { includeExpired }) };
}

/**
 * Throws NOT_FOUND / MEDICINE_INACTIVE unless the medicine exists and is active.
 * Locks the row (FOR SHARE) when called inside a transaction so it can't be
 * deactivated or deleted halfway through a stock-in.
 */
async function assertActive(id, { client } = {}) {
  const { rows } = await query(
    `SELECT id, is_active FROM medicines WHERE id = $1${client ? ' FOR SHARE' : ''}`,
    [id],
    client
  );
  if (!rows[0]) throw AppError.notFound('Medicine', id);
  if (!rows[0].is_active) throw new AppError('MEDICINE_INACTIVE', undefined, { medicineId: id });
  return rows[0];
}

async function resolveGeneric({ genericId, genericName }, client) {
  if (genericId) {
    const g = await generics.getById(genericId, { client });
    if (!g) throw AppError.validation([{ field: 'genericId', issue: 'generic does not exist' }]);
    if (!g.isActive) throw AppError.validation([{ field: 'genericId', issue: 'generic is deactivated' }]);
    return g;
  }
  const g = await generics.findOrCreate(genericName, { client });
  if (!g.isActive) throw AppError.validation([{ field: 'genericName', issue: 'generic is deactivated' }]);
  return g;
}

/**
 * Create a medicine, optionally with its first batches, in one transaction.
 * @param {Object} input  { brandName, genericId | genericName, manufacturer, dosageForm,
 *                          strength, baseUnit, prescriptionRequired = true, batches?: [...] }
 * @returns medicine + `batches`
 */
async function create(input) {
  if (!input.genericId && !input.genericName) {
    throw AppError.validation([{ field: 'genericId', issue: 'send genericId or genericName' }]);
  }
  const batchInputs = input.batches || [];
  // Validate every batch before touching the database, so all errors come back at once.
  const errors = [];
  const cleaned = batchInputs.map((b, i) => {
    try {
      return batches.validateBatch(b, { prefix: `batches[${i}].` });
    } catch (e) {
      errors.push(...(e.details || []));
      return null;
    }
  });
  const seen = new Set();
  cleaned.forEach((b, i) => {
    if (!b) return;
    if (seen.has(b.batchNo)) errors.push({ field: `batches[${i}].batchNo`, issue: 'is repeated' });
    seen.add(b.batchNo);
  });
  if (errors.length) throw AppError.validation(errors);

  return withTransaction(async (client) => {
    const generic = await resolveGeneric(input, client);
    let id;
    try {
      ({ rows: [{ id }] } = await query(
        `INSERT INTO medicines (brand_name, generic_id, manufacturer, dosage_form, strength, base_unit, prescription_required)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [
          input.brandName.trim(), generic.id, input.manufacturer.trim(), input.dosageForm,
          input.strength.trim(), input.baseUnit, input.prescriptionRequired ?? true,
        ],
        client
      ));
    } catch (err) {
      throw mapError(err);
    }
    const created = [];
    for (const b of cleaned) created.push(await batches.create(id, b, { client }));
    return { ...(await getById(id, { client })), batches: created };
  });
}

/**
 * Catalog search (B2). Matches brand, generic and manufacturer.
 * Brand names that start with q come first.
 * Non-admins only ever see active medicines (enforced by the route).
 */
async function search({ q, genericId, dosageForm, prescriptionRequired, isActive, limit = 20, offset = 0 } = {}) {
  const where = [];
  const params = [];
  const add = (sql, v) => { params.push(v); where.push(sql.replaceAll('$?', `$${params.length}`)); };

  if (isActive !== undefined) add('m.is_active = $?', isActive);
  if (genericId) add('m.generic_id = $?', genericId);
  if (dosageForm) add('m.dosage_form = $?', dosageForm);
  if (prescriptionRequired !== undefined) add('m.prescription_required = $?', prescriptionRequired);
  let order = 'lower(m.brand_name), m.id';
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    add('(m.brand_name ILIKE $? OR g.name ILIKE $? OR m.manufacturer ILIKE $?)', like);
    params.push(`${q.toLowerCase()}%`);
    order = `(lower(m.brand_name) LIKE $${params.length}) DESC, ${order}`;
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const countParams = q ? params.slice(0, -1) : params;
  const { rows: [{ total }] } = await query(
    `SELECT count(*)::int AS total FROM medicines m JOIN generics g ON g.id = m.generic_id ${w}`,
    countParams
  );
  params.push(limit, offset);
  const { rows } = await query(
    `${SELECT} ${w} ORDER BY ${order} LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { items: rows.map(toPublic), total, limit, offset };
}

const COLUMN = {
  brandName: 'brand_name',
  genericId: 'generic_id',
  manufacturer: 'manufacturer',
  dosageForm: 'dosage_form',
  strength: 'strength',
  baseUnit: 'base_unit',
  prescriptionRequired: 'prescription_required',
};

async function hasBatches(id, client) {
  const { rows } = await query('SELECT EXISTS (SELECT 1 FROM medicine_batches WHERE medicine_id = $1) AS x', [id], client);
  return rows[0].x;
}

/**
 * Edit a medicine (admin). The base unit can't change once the medicine has
 * batches, because every quantity and MRP is counted in it.
 */
async function update(id, patch) {
  return withTransaction(async (client) => {
    const current = await getById(id, { client });
    if (!current) throw AppError.notFound('Medicine', id);
    if (patch.baseUnit !== undefined && patch.baseUnit !== current.baseUnit && (await hasBatches(id, client))) {
      throw new AppError('MEDICINE_IN_USE', 'Base unit cannot change once the medicine has batches', {
        field: 'baseUnit',
      });
    }
    if (patch.genericId !== undefined) await resolveGeneric({ genericId: patch.genericId }, client);

    const sets = [];
    const params = [id];
    for (const [k, col] of Object.entries(COLUMN)) {
      if (patch[k] === undefined) continue;
      params.push(typeof patch[k] === 'string' ? patch[k].trim() : patch[k]);
      sets.push(`${col} = $${params.length}`);
    }
    if (sets.length === 0) return current;
    try {
      await query(`UPDATE medicines SET ${sets.join(', ')} WHERE id = $1`, params, client);
    } catch (err) {
      throw mapError(err);
    }
    return getById(id, { client });
  });
}

async function setActive(id, isActive) {
  const { rowCount } = await query('UPDATE medicines SET is_active = $2 WHERE id = $1', [id, isActive]);
  if (!rowCount) throw AppError.notFound('Medicine', id);
  return getById(id);
}

/**
 * Hard delete (admin), only while the medicine has no batches (B2, edge case 5).
 * Otherwise 409 MEDICINE_IN_USE — the batches' RESTRICT foreign key decides,
 * so a batch added at the same moment still blocks the delete.
 */
async function remove(id) {
  try {
    const { rowCount } = await query('DELETE FROM medicines WHERE id = $1', [id]);
    if (!rowCount) throw AppError.notFound('Medicine', id);
    return { id, deleted: true };
  } catch (err) {
    const e = mapError(err);
    if (e.code === 'MEDICINE_IN_USE') {
      throw new AppError('MEDICINE_IN_USE', undefined, { medicineId: id, hint: 'POST /medicines/:id/deactivate' });
    }
    throw e;
  }
}

/** Add a batch to an existing, active medicine (admin catalog route). */
async function addBatch(id, input) {
  return withTransaction(async (client) => {
    await assertActive(id, { client });
    return batches.create(id, input, { client });
  });
}

module.exports = {
  create,
  search,
  getById,
  getByIdOrThrow,
  getWithBatches,
  assertActive,
  update,
  setActive,
  remove,
  addBatch,
};
