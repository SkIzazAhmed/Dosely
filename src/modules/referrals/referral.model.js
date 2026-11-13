'use strict';

/**
 * REFERRALS row shape and helpers (migration 020).
 */

/** How long an accepted referral holds stock (C8). REFERRAL_HOLD_HOURS overrides the 24 h default. */
function holdHours() {
  const n = Number(process.env.REFERRAL_HOLD_HOURS);
  return Number.isFinite(n) && n > 0 ? n : 24;
}

const SELECT = `
  SELECT f.*,
         r.request_no, r.medicine_id, r.patient_id, r.prescription_id, r.doctor_id,
         m.brand_name AS medicine_brand_name, m.strength AS medicine_strength,
         fs.name AS from_shop_name,
         ts.name AS to_shop_name, ts.address AS to_shop_address, ts.area AS to_shop_area, ts.pincode AS to_shop_pincode
    FROM referrals f
    JOIN stock_requests r ON r.id = f.request_id
    JOIN medicines m ON m.id = r.medicine_id
    JOIN shops fs ON fs.id = f.from_shop_id
    JOIN shops ts ON ts.id = f.to_shop_id`;

function toPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    requestId: row.request_id,
    requestNo: row.request_no,
    status: row.status,
    medicine: { id: row.medicine_id, brandName: row.medicine_brand_name, strength: row.medicine_strength },
    patientId: row.patient_id,
    prescriptionId: row.prescription_id,
    fromShop: { id: row.from_shop_id, name: row.from_shop_name },
    toShop: {
      id: row.to_shop_id, name: row.to_shop_name, address: row.to_shop_address,
      area: row.to_shop_area, pincode: row.to_shop_pincode,
    },
    quantity: row.quantity,
    availableQtySeen: row.available_qty_seen,
    referredBy: row.referred_by,
    respondedBy: row.responded_by,
    acceptedAt: row.accepted_at,
    holdUntil: row.hold_until,
    reservationLines: row.reservation_lines,
    rejectedAt: row.rejected_at,
    rejectReason: row.reject_reason,
    cancelledAt: row.cancelled_at,
    cancelReason: row.cancel_reason,
    fulfilledAt: row.fulfilled_at,
    fulfilledBy: row.fulfilled_by,
    noShowAt: row.no_show_at,
    reminderSentAt: row.reminder_sent_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

module.exports = { holdHours, SELECT, toPublic };
