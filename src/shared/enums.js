'use strict';

/**
 * JS mirror of the PostgreSQL enums in migration 001.
 * If you add a value in SQL (ALTER TYPE ... ADD VALUE), add it here too.
 */
const freeze = (values) => Object.freeze(Object.fromEntries(values.map((v) => [v, v])));

module.exports = Object.freeze({
  UserRole: freeze(['DOCTOR', 'SHOPKEEPER', 'ADMIN']),
  StaffRole: freeze(['OWNER', 'STAFF']),
  Gender: freeze(['MALE', 'FEMALE', 'OTHER', 'UNDISCLOSED']),
  PhoneOwnerType: freeze(['USER', 'PATIENT', 'SHOP']),
  PhoneType: freeze(['MOBILE', 'LANDLINE', 'WHATSAPP', 'OTHER']),
  PhoneStatus: freeze(['UNVERIFIED', 'VERIFIED', 'UNREACHABLE']),
  NotificationChannel: freeze(['IN_APP', 'SMS', 'EMAIL']),
  NotificationStatus: freeze(['PENDING', 'SENT', 'FAILED', 'SKIPPED']),
  NotificationRecipientType: freeze(['USER', 'PATIENT', 'SHOP']),

  // Catalog + stock (migration 010)
  DosageForm: freeze([
    'TABLET', 'CAPSULE', 'SYRUP', 'SUSPENSION', 'INJECTION', 'OINTMENT', 'CREAM',
    'GEL', 'DROPS', 'INHALER', 'POWDER', 'SACHET', 'LOTION', 'SPRAY', 'OTHER',
  ]),
  BaseUnit: freeze(['TABLET', 'CAPSULE', 'ML', 'G', 'VIAL', 'AMPOULE', 'SACHET', 'TUBE', 'BOTTLE', 'UNIT']),
  StockMovementType: freeze(['STOCK_IN', 'DISPENSE', 'RETURN', 'ADJUSTMENT', 'EXPIRY_WRITE_OFF']),
});
