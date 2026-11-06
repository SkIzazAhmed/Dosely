'use strict';

/**
 * Shared error format for every module (A1):
 *   { "error": { "code": "...", "message": "...", "details": ... } }
 *
 * Throw an AppError anywhere (service, route, middleware); errorHandler
 * turns it into the response. Unknown errors become INTERNAL_ERROR (500).
 */

const ErrorCodes = Object.freeze({
  // Generic
  VALIDATION_ERROR: { status: 400, message: 'Request validation failed' },
  BAD_REQUEST: { status: 400, message: 'Bad request' },
  UNAUTHENTICATED: { status: 401, message: 'Authentication required' },
  INVALID_CREDENTIALS: { status: 401, message: 'Invalid email/phone or password' },
  TOKEN_EXPIRED: { status: 401, message: 'Token expired' },
  ACCOUNT_INACTIVE: { status: 403, message: 'This account is deactivated' },
  FORBIDDEN: { status: 403, message: 'You do not have permission for this action' },
  NOT_FOUND: { status: 404, message: 'Resource not found' },
  ROUTE_NOT_FOUND: { status: 404, message: 'Route not found' },
  CONFLICT: { status: 409, message: 'Resource conflict' },
  DUPLICATE: { status: 409, message: 'Resource already exists' },
  IDEMPOTENCY_KEY_REQUIRED: { status: 400, message: 'Idempotency-Key header is required' },
  IDEMPOTENCY_KEY_REUSED: { status: 422, message: 'Idempotency-Key was used with a different request' },
  IDEMPOTENCY_IN_PROGRESS: { status: 409, message: 'A request with this Idempotency-Key is still in progress' },
  INACTIVE_RESOURCE: { status: 409, message: 'Resource is deactivated' },
  DELETE_NOT_ALLOWED: { status: 409, message: 'Delete is not allowed; deactivate instead' },
  INTERNAL_ERROR: { status: 500, message: 'Something went wrong' },

  // Users / doctors (A3, A5)
  EMAIL_TAKEN: { status: 409, message: 'Email is already in use' },
  DOCTOR_PROFILE_EXISTS: { status: 409, message: 'Doctor profile already exists for this user' },
  DOCTOR_REG_NO_TAKEN: { status: 409, message: 'Registration number is already in use' },
  DOCTOR_REG_NO_REQUIRED: { status: 403, message: 'A registration number is required to send requests' },

  // Shops / staff (A6, A7)
  SHOP_CODE_TAKEN: { status: 409, message: 'Shop code is already in use' },
  DRUG_LICENCE_TAKEN: { status: 409, message: 'Drug licence is already in use' },
  SHOP_INACTIVE: { status: 409, message: 'Shop is inactive and cannot receive requests' },
  INVALID_PINCODE: { status: 400, message: 'Pincode must be 6 digits' },
  INVALID_COORDINATES: { status: 400, message: 'Latitude and longitude must both be set or both be empty' },
  NOT_SHOP_STAFF: { status: 403, message: 'You are not staff of this shop' },
  NOT_SHOP_OWNER: { status: 403, message: 'Only the shop OWNER can do this' },
  STAFF_ALREADY_EXISTS: { status: 409, message: 'User is already staff of this shop' },

  // Phones (A9, rules P1–P13, edge cases 4/9/10)
  PHONE_INVALID: { status: 400, message: 'Phone number is not valid' },
  PHONE_DUPLICATE: { status: 409, message: 'Phone number already exists for this owner' },
  PHONE_LIMIT_REACHED: { status: 409, message: 'An owner can have at most 5 phone numbers' },
  PHONE_OWNER_INVALID: { status: 400, message: 'A phone number must have exactly one owner' },
  PHONE_PRIMARY_REQUIRED: { status: 409, message: 'Owner must keep one primary phone number' },
  PHONE_UNVERIFIED: { status: 409, message: 'Phone number is not verified' },
  PHONE_UNREACHABLE: { status: 409, message: 'Phone number is marked unreachable' },
  PATIENT_NO_PHONE: { status: 409, message: 'Patient has no usable phone number' },

  // Notifications (A10, A11)
  NOTIFICATION_DUPLICATE: { status: 409, message: 'Notification with this dedupe key already exists' },
  SMS_TOO_LONG: { status: 400, message: 'SMS body exceeds 160 characters' },
  NOTIFICATION_CHANNEL_UNAVAILABLE: { status: 409, message: 'No usable destination for this channel' },

  // Catalog (Rachana, B1–B3, edge case 5)
  GENERIC_NAME_TAKEN: { status: 409, message: 'A generic with this name already exists' },
  MEDICINE_DUPLICATE: { status: 409, message: 'A medicine with this brand, manufacturer, form and strength already exists' },
  MEDICINE_IN_USE: { status: 409, message: 'Medicine has batches and cannot be deleted; deactivate it instead' },
  MEDICINE_INACTIVE: { status: 409, message: 'Medicine is deactivated' },
  BATCH_NO_TAKEN: { status: 409, message: 'Batch number already exists for this medicine' },

  // Stock (Rachana, B4–B10, edge cases 3, 6, 15)
  BATCH_EXPIRED: { status: 422, message: 'Batch is expired' },
  BATCH_MISMATCH: { status: 409, message: 'Batch number is already known with a different expiry date or MRP' },
  INSUFFICIENT_STOCK: { status: 409, message: 'Not enough non-expired stock' },
  STALE_INVENTORY: { status: 409, message: 'Inventory changed since you read it; reload and try again' },
  REASON_REQUIRED: { status: 400, message: 'A reason is required for this stock change' },

  // Requests + referrals (Anushka, C1–C11, edge cases 1, 2, 7, 8, 11, 12, 13, 16)
  INVALID_TRANSITION: { status: 409, message: 'This status change is not allowed' },
  REQUEST_NOT_SHORT: { status: 409, message: 'Shop already has enough stock; no request needed' },
  REQUEST_EXPIRED: { status: 409, message: 'Request has expired' },
  CLOSE_REASON_REQUIRED: { status: 400, message: 'A reason is required to close a request' },
  REFERRAL_LIMIT_REACHED: { status: 409, message: 'A request can have at most 3 referrals' },
  REFERRAL_DUPLICATE: { status: 409, message: 'This shop already has a live referral for this request' },
  REFERRAL_QTY_EXCEEDED: { status: 409, message: 'Referred quantity is more than what is still unfulfilled' },
  REFERRAL_SAME_SHOP: { status: 400, message: 'Cannot refer a request to the same shop' },
  REJECT_REASON_REQUIRED: { status: 400, message: 'A reason is required to reject a referral' },
  REFERRAL_VERIFICATION_FAILED: { status: 403, message: 'Request number or phone digits do not match' },
});

class AppError extends Error {
  /**
   * @param {keyof typeof ErrorCodes | string} code
   * @param {string} [message]  overrides the default message for the code
   * @param {*} [details]       extra info for the client (field errors, ids…)
   * @param {number} [status]   only needed for codes not in ErrorCodes
   */
  constructor(code, message, details, status) {
    const def = ErrorCodes[code];
    super(message || (def && def.message) || code);
    this.name = 'AppError';
    this.code = def ? code : code || 'INTERNAL_ERROR';
    this.status = status || (def && def.status) || 500;
    this.details = details === undefined ? null : details;
    Error.captureStackTrace?.(this, AppError);
  }

  toJSON() {
    return { code: this.code, message: this.message, details: this.details };
  }

  static validation(details, message) {
    return new AppError('VALIDATION_ERROR', message, details);
  }

  static notFound(resource = 'Resource', id) {
    return new AppError('NOT_FOUND', `${resource} not found`, id === undefined ? null : { id });
  }

  static forbidden(message) {
    return new AppError('FORBIDDEN', message);
  }
}

/**
 * Map PostgreSQL errors to AppErrors so routes don't leak SQL errors.
 * Modules can pass a map of constraint name -> AppError code, e.g.
 *   fromPgError(err, { users_email_key: 'EMAIL_TAKEN' })
 */
function fromPgError(err, constraintMap = {}) {
  if (!err || typeof err.code !== 'string') return err;
  const mapped = err.constraint && constraintMap[err.constraint];
  switch (err.code) {
    case '23505': // unique_violation
      return new AppError(mapped || 'DUPLICATE', undefined, { constraint: err.constraint || null });
    case '23503': // foreign_key_violation
      return mapped
        ? new AppError(mapped, undefined, { constraint: err.constraint })
        : err.message.includes('update or delete')
          ? new AppError('DELETE_NOT_ALLOWED', undefined, { constraint: err.constraint || null })
          : new AppError('VALIDATION_ERROR', 'Referenced record does not exist', { constraint: err.constraint || null });
    case '23514': // check_violation
    case '23502': // not_null_violation
    case '22P02': // invalid_text_representation (bad enum / uuid / int)
      return new AppError(mapped || 'VALIDATION_ERROR', undefined, {
        constraint: err.constraint || null,
        column: err.column || null,
      });
    case 'P0001': // raise_exception from our triggers, e.g. delete guard
      if (err.message.startsWith('DELETE_NOT_ALLOWED')) {
        return new AppError('DELETE_NOT_ALLOWED', undefined, { table: err.table || null });
      }
      // Triggers raise 'CODE: detail' (e.g. REFERRAL_LIMIT_REACHED from migration 020)
      {
        const prefix = err.message.split(':', 1)[0];
        return ErrorCodes[prefix] ? new AppError(prefix) : err;
      }
    default:
      return err;
  }
}

module.exports = { AppError, ErrorCodes, fromPgError };
