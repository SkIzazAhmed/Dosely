'use strict';

/**
 * Phone numbers (A9, F5) — rules P4–P10 here; P1–P3 live in phone.validator.js.
 *
 *   P4  Same number twice on one owner                → 409 PHONE_DUPLICATE_FOR_OWNER
 *   P5  Same number on two patients is allowed (families share); the response
 *       carries a warning with the other patient's masked name
 *   P6  A verified number belongs to only one user    → 409 PHONE_TAKEN
 *   P7  At most 5 active numbers per owner            → 422 PHONE_LIMIT
 *   P8  The first number added becomes primary
 *   P9  Setting a new primary unsets the old one in the same transaction
 *   P10 The primary can't be removed while other numbers exist → 409 PHONE_PRIMARY_REQUIRED
 *   P11 A user's primary must be verified (switching to an unverified number, or
 *       editing the digits of a user's primary while they have other numbers,
 *       → 422 PHONE_NOT_VERIFIED). Patients and shops may have an unverified
 *       primary, but SMS only goes to verified, reachable mobiles (pickSmsPhone).
 *   P12 Editing the digits resets verification.
 *   P13 3 consecutive failed SMS mark the number UNREACHABLE (recordDeliveryFailure);
 *       notification.service alerts the shop or doctor.
 *
 * Every change locks the owner row first, so two concurrent adds can't both
 * slip under the limit or both become primary.
 */

const { query } = require('../../db/pool');
const { withTransaction } = require('../../db/transaction');
const { AppError, fromPgError } = require('../../shared/errors');
const { normalizePhone, maskName } = require('./phone.validator');

const MAX_PER_OWNER = 5;

const OWNERS = Object.freeze({
  USER: { table: 'users', column: 'user_id', resource: 'User' },
  PATIENT: { table: 'patients', column: 'patient_id', resource: 'Patient' },
  SHOP: { table: 'shops', column: 'shop_id', resource: 'Shop' },
});

const PG_MAP = {
  phone_numbers_owner_e164_key: 'PHONE_DUPLICATE_FOR_OWNER',
  phone_numbers_user_verified_key: 'PHONE_TAKEN',
  phone_numbers_landline_label: 'PHONE_NOT_MOBILE',
  phone_numbers_one_owner: 'PHONE_OWNER_INVALID',
};

const COLUMNS = `id, owner_type, owner_id, e164, kind, label, is_primary, status, verified_at, verified_by,
                 consecutive_failures, last_failure_at, unreachable_at, is_active, created_at, updated_at`;

function toPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    ownerType: row.owner_type,
    ownerId: row.owner_id,
    e164: row.e164,
    kind: row.kind,
    label: row.label,
    isPrimary: row.is_primary,
    status: row.status,
    isVerified: row.status === 'VERIFIED',
    smsCapable: row.kind === 'MOBILE' && row.status === 'VERIFIED' && row.is_active,
    verifiedAt: row.verified_at,
    verifiedBy: row.verified_by,
    consecutiveFailures: row.consecutive_failures,
    lastFailureAt: row.last_failure_at,
    unreachableAt: row.unreachable_at,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function owner(ownerType) {
  const o = OWNERS[ownerType];
  if (!o) throw new AppError('PHONE_OWNER_INVALID', undefined, { ownerType });
  return o;
}

/** Lock the owner row so phone changes for one owner run one at a time. */
async function lockOwner(client, ownerType, ownerId) {
  const o = owner(ownerType);
  const { rows } = await client.query(`SELECT id, is_active FROM ${o.table} WHERE id = $1 FOR UPDATE`, [ownerId]);
  if (!rows[0]) throw AppError.notFound(o.resource, ownerId);
  return rows[0];
}

async function getById(id, { client } = {}) {
  const { rows } = await query(`SELECT ${COLUMNS} FROM phone_numbers WHERE id = $1`, [id], client);
  return toPublic(rows[0]);
}

async function getByIdOrThrow(id, opts) {
  const p = await getById(id, opts);
  if (!p) throw AppError.notFound('Phone number', id);
  return p;
}

/** Active numbers, primary first. includeRemoved adds deactivated ones. */
async function list(ownerType, ownerId, { includeRemoved = false, client } = {}) {
  owner(ownerType);
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM phone_numbers
      WHERE owner_type = $1 AND owner_id = $2 ${includeRemoved ? '' : 'AND is_active'}
      ORDER BY is_active DESC, is_primary DESC, id`,
    [ownerType, ownerId],
    client
  );
  return rows.map(toPublic);
}

async function activeRows(client, ownerType, ownerId) {
  const { rows } = await client.query(
    `SELECT ${COLUMNS} FROM phone_numbers WHERE owner_type = $1 AND owner_id = $2 AND is_active ORDER BY id`,
    [ownerType, ownerId]
  );
  return rows;
}

/** P6: is this number verified for a different user? */
async function assertNotTakenByOtherUser(client, e164, userId) {
  const { rows } = await client.query(
    `SELECT user_id FROM phone_numbers
      WHERE owner_type = 'USER' AND e164 = $1 AND status <> 'UNVERIFIED' AND is_active AND user_id <> $2
      LIMIT 1`,
    [e164, userId]
  );
  if (rows[0]) throw new AppError('PHONE_TAKEN', undefined, { e164 });
}

/** P5: other active patients that already have this number (masked names). */
async function sharedWithPatients(client, e164, patientId) {
  const { rows } = await client.query(
    `SELECT DISTINCT p.id, p.full_name
       FROM phone_numbers ph JOIN patients p ON p.id = ph.patient_id
      WHERE ph.owner_type = 'PATIENT' AND ph.e164 = $1 AND ph.is_active AND p.is_active AND p.id <> $2
      ORDER BY p.id`,
    [e164, patientId]
  );
  if (rows.length === 0) return [];
  return [{
    code: 'PHONE_SHARED_WITH_PATIENT',
    message: 'This number is also saved for another patient (allowed — families often share a phone).',
    patients: rows.map((r) => maskName(r.full_name)),
  }];
}

/** P9: unset the current primary, then set the new one — same transaction. */
async function switchPrimary(client, ownerType, ownerId, phoneId) {
  await client.query(
    `UPDATE phone_numbers SET is_primary = false
      WHERE owner_type = $1 AND owner_id = $2 AND is_primary AND is_active AND id <> $3`,
    [ownerType, ownerId, phoneId]
  );
  await client.query('UPDATE phone_numbers SET is_primary = true WHERE id = $1', [phoneId]);
}

/**
 * Add a number. input: { number, label?, isPrimary? }
 * @returns {{ phone, warnings: Array }}
 */
async function add(ownerType, ownerId, input, { verifiedBy = null, verified = false } = {}) {
  const o = owner(ownerType);
  const n = normalizePhone(input.number, input.label || 'MOBILE');           // P1–P3
  try {
    return await withTransaction(async (client) => {
      await lockOwner(client, ownerType, ownerId);
      const existing = await activeRows(client, ownerType, ownerId);

      if (existing.some((r) => r.e164 === n.e164)) {                        // P4
        throw new AppError('PHONE_DUPLICATE_FOR_OWNER', undefined, { e164: n.e164 });
      }
      if (existing.length >= MAX_PER_OWNER) {                                // P7
        throw new AppError('PHONE_LIMIT', undefined, { max: MAX_PER_OWNER });
      }
      if (ownerType === 'USER') await assertNotTakenByOtherUser(client, n.e164, ownerId); // P6

      const first = existing.length === 0;                                   // P8
      const { rows: [row] } = await client.query(
        `INSERT INTO phone_numbers (owner_type, ${o.column}, e164, kind, label, is_primary, status, verified_at, verified_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [ownerType, ownerId, n.e164, n.kind, n.label, first,
          verified ? 'VERIFIED' : 'UNVERIFIED', verified ? new Date() : null, verified ? verifiedBy : null]
      );
      if (!first && input.isPrimary === true) {
        await assertCanBecomePrimary(client, ownerType, row.id);
        await switchPrimary(client, ownerType, ownerId, row.id);             // P9
      }

      const warnings = ownerType === 'PATIENT' ? await sharedWithPatients(client, n.e164, ownerId) : []; // P5
      return { phone: await getById(row.id, { client }), warnings };
    });
  } catch (err) {
    throw fromPgError(err, PG_MAP);
  }
}

/** P11: a user's primary must be verified. Patients and shops may have an unverified primary. */
async function assertCanBecomePrimary(client, ownerType, phoneId) {
  if (ownerType !== 'USER') return;
  const { rows: [row] } = await client.query('SELECT status FROM phone_numbers WHERE id = $1', [phoneId]);
  if (!row || row.status !== 'VERIFIED') {
    throw new AppError('PHONE_NOT_VERIFIED', "A user's primary number must be verified first", { phoneId });
  }
}

async function lockPhone(client, phoneId) {
  const { rows } = await client.query(`SELECT ${COLUMNS} FROM phone_numbers WHERE id = $1 FOR UPDATE`, [phoneId]);
  if (!rows[0] || !rows[0].is_active) throw AppError.notFound('Phone number', phoneId);
  return rows[0];
}

/**
 * Update digits, label and/or primary flag. patch: { number?, label?, isPrimary? }
 * P12: new digits reset verification and delivery-failure tracking.
 */
async function update(phoneId, patch) {
  try {
    return await withTransaction(async (client) => {
      const current = await getByIdOrThrow(phoneId, { client });
      await lockOwner(client, current.ownerType, current.ownerId);
      let row = await lockPhone(client, phoneId);

      if (patch.number !== undefined) {
        const n = normalizePhone(patch.number, patch.label || row.label);    // P1–P3
        if (n.e164 !== row.e164) {
          const others = (await activeRows(client, row.owner_type, row.owner_id)).filter((r) => r.id !== row.id);
          if (others.some((r) => r.e164 === n.e164)) {                        // P4
            throw new AppError('PHONE_DUPLICATE_FOR_OWNER', undefined, { e164: n.e164 });
          }
          if (row.owner_type === 'USER') {
            await assertNotTakenByOtherUser(client, n.e164, row.owner_id);    // P6
            if (row.is_primary && others.length > 0) {                        // P11
              throw new AppError('PHONE_NOT_VERIFIED',
                "Changing these digits would leave the user's primary unverified; make another verified number primary first",
                { phoneId });
            }
          }
          await client.query(                                                  // P12
            `UPDATE phone_numbers
                SET e164 = $2, kind = $3, label = $4, status = 'UNVERIFIED', verified_at = NULL, verified_by = NULL,
                    consecutive_failures = 0, last_failure_at = NULL, unreachable_at = NULL
              WHERE id = $1`,
            [phoneId, n.e164, n.kind, n.label]
          );
          row = await lockPhone(client, phoneId);
        }
      }

      if (patch.label !== undefined && patch.label !== row.label) {
        if (row.kind === 'LANDLINE' && patch.label === 'MOBILE') {          // P3
          throw new AppError('PHONE_NOT_MOBILE', undefined, { e164: row.e164 });
        }
        await client.query('UPDATE phone_numbers SET label = $2 WHERE id = $1', [phoneId, patch.label]);
      }

      if (patch.isPrimary === true && !row.is_primary) {
        await assertCanBecomePrimary(client, row.owner_type, phoneId);
        await switchPrimary(client, row.owner_type, row.owner_id, phoneId); // P9
      } else if (patch.isPrimary === false && row.is_primary) {
        // There must always be a primary while numbers exist: pick the new one instead (P8–P10)
        throw new AppError('PHONE_PRIMARY_REQUIRED', 'Set another number as primary instead of unsetting this one');
      }
      return getById(phoneId, { client });
    });
  } catch (err) {
    throw fromPgError(err, PG_MAP);
  }
}

/** Remove (deactivate) a number. P10: not the primary while others exist. */
async function remove(phoneId) {
  return withTransaction(async (client) => {
    const current = await getByIdOrThrow(phoneId, { client });
    await lockOwner(client, current.ownerType, current.ownerId);
    const row = await lockPhone(client, phoneId);
    if (row.is_primary) {
      const others = (await activeRows(client, row.owner_type, row.owner_id)).filter((r) => r.id !== row.id);
      if (others.length > 0) throw new AppError('PHONE_PRIMARY_REQUIRED', undefined, { otherNumbers: others.length }); // P10
    }
    await client.query('UPDATE phone_numbers SET is_active = false, is_primary = false WHERE id = $1', [phoneId]);
    return getById(phoneId, { client });
  });
}

/**
 * Verify a number by staff confirmation (F5.3, MVP). Also clears UNREACHABLE
 * and the failure count. P6: a user number already verified for someone else → PHONE_TAKEN.
 */
async function verify(phoneId, verifiedBy) {
  try {
    return await withTransaction(async (client) => {
      const current = await getByIdOrThrow(phoneId, { client });
      await lockOwner(client, current.ownerType, current.ownerId);
      const row = await lockPhone(client, phoneId);
      if (row.owner_type === 'USER') await assertNotTakenByOtherUser(client, row.e164, row.owner_id);
      await client.query(
        `UPDATE phone_numbers
            SET status = 'VERIFIED', verified_at = now(), verified_by = $2,
                consecutive_failures = 0, last_failure_at = NULL, unreachable_at = NULL
          WHERE id = $1`,
        [phoneId, verifiedBy]
      );
      return getById(phoneId, { client });
    });
  } catch (err) {
    throw fromPgError(err, PG_MAP);
  }
}

const UNREACHABLE_AFTER = 3;

/**
 * P13: count a failed SMS. The 3rd failure in a row marks a verified number
 * UNREACHABLE. Returns { phone, becameUnreachable }.
 */
async function recordDeliveryFailure(phoneId, { client } = {}) {
  const { rows: [row] } = await query(
    `UPDATE phone_numbers
        SET consecutive_failures = consecutive_failures + 1,
            last_failure_at = now(),
            status = CASE WHEN status = 'VERIFIED' AND consecutive_failures + 1 >= $2 THEN 'UNREACHABLE'::phone_status ELSE status END,
            unreachable_at = CASE WHEN status = 'VERIFIED' AND consecutive_failures + 1 >= $2 THEN now() ELSE unreachable_at END
      WHERE id = $1
      RETURNING ${COLUMNS}, (status = 'UNREACHABLE' AND consecutive_failures = $2) AS became_unreachable`,
    [phoneId, UNREACHABLE_AFTER],
    client
  );
  if (!row) throw AppError.notFound('Phone number', phoneId);
  return { phone: toPublic(row), becameUnreachable: row.became_unreachable };
}

/** A delivered SMS resets the failure streak (and makes an UNREACHABLE number reachable again). */
async function recordDeliverySuccess(phoneId, { client } = {}) {
  const { rows: [row] } = await query(
    `UPDATE phone_numbers
        SET consecutive_failures = 0,
            status = CASE WHEN status = 'UNREACHABLE' THEN 'VERIFIED'::phone_status ELSE status END,
            unreachable_at = NULL
      WHERE id = $1 RETURNING ${COLUMNS}`,
    [phoneId],
    client
  );
  return toPublic(row);
}

/**
 * P11 / edge cases 9 and 10: the number an SMS should go to — a verified,
 * reachable, active mobile, primary first. Returns { phone } or
 * { phone: null, reason: 'NO_PHONE' | 'NO_VERIFIED_MOBILE' | 'PHONE_UNREACHABLE' }.
 */
async function pickSmsPhone(ownerType, ownerId, { client } = {}) {
  const all = await list(ownerType, ownerId, { client });
  if (all.length === 0) return { phone: null, reason: 'NO_PHONE' };
  const usable = all.find((p) => p.kind === 'MOBILE' && p.status === 'VERIFIED');
  if (usable) return { phone: usable };
  const unreachable = all.some((p) => p.kind === 'MOBILE' && p.status === 'UNREACHABLE');
  return { phone: null, reason: unreachable ? 'PHONE_UNREACHABLE' : 'NO_VERIFIED_MOBILE' };
}

/** Login by phone: the user who owns this verified number (unique by P6). */
async function findUserIdByVerifiedPhone(e164) {
  const { rows } = await query(
    `SELECT user_id FROM phone_numbers
      WHERE owner_type = 'USER' AND e164 = $1 AND status <> 'UNVERIFIED' AND is_active`,
    [e164]
  );
  return rows[0] ? rows[0].user_id : null;
}

module.exports = {
  MAX_PER_OWNER,
  OWNERS,
  toPublic,
  getById,
  getByIdOrThrow,
  list,
  add,
  update,
  remove,
  findUserIdByVerifiedPhone,
  verify,
  recordDeliveryFailure,
  recordDeliverySuccess,
  pickSmsPhone,
  UNREACHABLE_AFTER,
  // internals reused by Commit 5
  _internal: { lockOwner, lockPhone, activeRows, switchPrimary, PG_MAP, COLUMNS },
};
