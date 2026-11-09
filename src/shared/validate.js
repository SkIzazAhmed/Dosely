'use strict';

const { AppError } = require('./errors');

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Tiny schema validator. Returns a cleaned object (only known fields,
 * strings trimmed) or throws VALIDATION_ERROR with every bad field.
 *
 *   const body = validate(req.body, {
 *     fullName: { type: 'string', required: true, max: 120 },
 *     email:    { type: 'email', nullable: true },
 *     role:     { type: 'enum', values: ['DOCTOR', 'ADMIN'], required: true },
 *   });
 *
 * opts.partial = true (PATCH): nothing is required, but at least one field must be sent.
 */
function validate(input, schema, opts = {}) {
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const out = {};
  const errors = [];

  for (const [field, rule] of Object.entries(schema)) {
    let v = src[field];
    const present = v !== undefined;

    if (!present) {
      if (rule.required && !opts.partial) errors.push({ field, issue: 'required' });
      else if (rule.default !== undefined && !opts.partial) out[field] = rule.default;
      continue;
    }
    if (v === null || (typeof v === 'string' && v.trim() === '' && rule.type !== 'password')) {
      if (rule.nullable) out[field] = null;
      else errors.push({ field, issue: rule.required ? 'required' : 'cannot be empty' });
      continue;
    }

    switch (rule.type) {
      case 'string':
      case 'email':
      case 'password': {
        if (typeof v !== 'string') { errors.push({ field, issue: 'must be a string' }); continue; }
        if (rule.type !== 'password') v = v.trim();
        if (rule.type === 'email') {
          v = v.toLowerCase();
          if (!EMAIL_RE.test(v) || v.length > 254) { errors.push({ field, issue: 'must be a valid email' }); continue; }
        }
        if (rule.min !== undefined && v.length < rule.min) { errors.push({ field, issue: `must be at least ${rule.min} characters` }); continue; }
        if (rule.max !== undefined && v.length > rule.max) { errors.push({ field, issue: `must be at most ${rule.max} characters` }); continue; }
        if (rule.pattern && !rule.pattern.test(v)) { errors.push({ field, issue: rule.patternMessage || 'has an invalid format' }); continue; }
        break;
      }
      case 'integer': {
        const n = typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v) : v;
        if (!Number.isInteger(n)) { errors.push({ field, issue: 'must be an integer' }); continue; }
        if (rule.min !== undefined && n < rule.min) { errors.push({ field, issue: `must be >= ${rule.min}` }); continue; }
        if (rule.max !== undefined && n > rule.max) { errors.push({ field, issue: `must be <= ${rule.max}` }); continue; }
        v = n;
        break;
      }
      case 'number': {
        const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
        if (typeof n !== 'number' || !Number.isFinite(n)) { errors.push({ field, issue: 'must be a number' }); continue; }
        if (rule.min !== undefined && n < rule.min) { errors.push({ field, issue: `must be >= ${rule.min}` }); continue; }
        if (rule.max !== undefined && n > rule.max) { errors.push({ field, issue: `must be <= ${rule.max}` }); continue; }
        v = n;
        break;
      }
      case 'date': {
        // YYYY-MM-DD, a real calendar date; optional notFuture / minDate
        if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v.trim())) { errors.push({ field, issue: 'must be a date (YYYY-MM-DD)' }); continue; }
        v = v.trim();
        const d = new Date(`${v}T00:00:00Z`);
        if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) { errors.push({ field, issue: 'is not a real date' }); continue; }
        if (rule.notFuture && v > new Date().toISOString().slice(0, 10)) { errors.push({ field, issue: 'cannot be in the future' }); continue; }
        if (rule.minDate && v < rule.minDate) { errors.push({ field, issue: `must be on or after ${rule.minDate}` }); continue; }
        break;
      }
      case 'boolean': {
        if (v === 'true') v = true;
        else if (v === 'false') v = false;
        if (typeof v !== 'boolean') { errors.push({ field, issue: 'must be true or false' }); continue; }
        break;
      }
      case 'enum': {
        if (!rule.values.includes(v)) { errors.push({ field, issue: `must be one of ${rule.values.join(', ')}` }); continue; }
        break;
      }
      default:
        throw new Error(`validate: unknown type ${rule.type} for ${field}`);
    }
    out[field] = v;
  }

  if (opts.partial && Object.keys(out).length === 0 && errors.length === 0) {
    errors.push({ field: null, issue: `send at least one of: ${Object.keys(schema).join(', ')}` });
  }
  if (errors.length) throw AppError.validation(errors);
  return out;
}

/** Parse a positive integer route param, or throw NOT_FOUND. */
function idParam(value, resource = 'Resource') {
  if (!/^\d+$/.test(String(value)) || Number(value) <= 0 || Number(value) > Number.MAX_SAFE_INTEGER) {
    throw AppError.notFound(resource, value);
  }
  return Number(value);
}

/** limit/offset from query string with sane bounds. */
function pagination(query, { defaultLimit = 20, maxLimit = 100 } = {}) {
  const { limit, offset } = validate(query, {
    limit: { type: 'integer', min: 1, max: maxLimit, default: defaultLimit },
    offset: { type: 'integer', min: 0, default: 0 },
  });
  return { limit, offset };
}

module.exports = { validate, idParam, pagination };
