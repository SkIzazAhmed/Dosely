'use strict';

/**
 * Idempotency-Key middleware for POST routes (A4).
 *
 *   router.post('/', authenticate, idempotency(), handler)
 *
 * - Same key + same request (method, path, body) within 24h → the stored
 *   response is replayed with header `Idempotent-Replayed: true`.
 * - Same key + different request → 422 IDEMPOTENCY_KEY_REUSED.
 * - Same key while the first request is still running → 409 IDEMPOTENCY_IN_PROGRESS.
 * - Keys are scoped per user (anonymous callers share scope 0).
 * - 5xx responses are not stored, so the client can retry with the same key.
 *
 * Put it AFTER authenticate so keys are scoped to the user.
 */

const crypto = require('node:crypto');
const { AppError } = require('../shared/errors');
const asyncHandler = require('../shared/asyncHandler');
const { query } = require('../db/pool');

function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
}

function idempotency({ required = true, ttlHours = 24 } = {}) {
  return asyncHandler(async (req, res, next) => {
    if (req.method !== 'POST') return next();

    const key = req.get('Idempotency-Key');
    if (!key) {
      if (required) throw new AppError('IDEMPOTENCY_KEY_REQUIRED');
      return next();
    }
    if (key.length > 255) throw AppError.validation([{ field: 'Idempotency-Key', issue: 'must be at most 255 characters' }]);

    const scope = req.user ? req.user.id : 0;
    const path = `${req.baseUrl}${req.path}`;
    const hash = crypto
      .createHash('sha256')
      .update(stableStringify({ method: req.method, path, body: req.body ?? null }))
      .digest('hex');

    await query('DELETE FROM idempotency_keys WHERE scope_user_id = $1 AND key = $2 AND expires_at < now()', [scope, key]);

    const ins = await query(
      `INSERT INTO idempotency_keys (scope_user_id, key, method, path, request_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + make_interval(hours => $6::int))
       ON CONFLICT (scope_user_id, key) DO NOTHING
       RETURNING id`,
      [scope, key, req.method, path, hash, ttlHours]
    );

    if (ins.rowCount === 0) {
      const { rows: [prev] } = await query(
        'SELECT request_hash, state, status_code, response_body FROM idempotency_keys WHERE scope_user_id = $1 AND key = $2',
        [scope, key]
      );
      if (!prev) throw new AppError('IDEMPOTENCY_IN_PROGRESS'); // deleted between statements; client retries
      if (prev.request_hash !== hash) throw new AppError('IDEMPOTENCY_KEY_REUSED');
      if (prev.state !== 'COMPLETED') throw new AppError('IDEMPOTENCY_IN_PROGRESS');
      res.set('Idempotent-Replayed', 'true');
      return res.status(prev.status_code).json(prev.response_body);
    }

    const rowId = ins.rows[0].id;
    const originalJson = res.json.bind(res);
    let body;
    res.json = (b) => {
      body = b;
      return originalJson(b);
    };

    res.on('finish', () => {
      const done =
        res.statusCode >= 500
          ? query('DELETE FROM idempotency_keys WHERE id = $1', [rowId])
          : query(
              `UPDATE idempotency_keys SET state = 'COMPLETED', status_code = $2, response_body = $3 WHERE id = $1`,
              [rowId, res.statusCode, body === undefined ? null : JSON.stringify(body)]
            );
      done.catch((err) => console.error('[idempotency] failed to store result:', err.message));
    });

    next();
  });
}

module.exports = { idempotency, _stableStringify: stableStringify };
