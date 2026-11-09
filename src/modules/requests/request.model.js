'use strict';

/**
 * STOCK_REQUESTS row shape and helpers (migration 020).
 */

const URGENCY_HOURS = Object.freeze({ ROUTINE: 24, URGENT: 2 }); // C2

const SELECT = `
  SELECT r.*,
         m.brand_name AS medicine_brand_name, m.strength AS medicine_strength,
         m.dosage_form AS medicine_dosage_form, m.base_unit AS medicine_base_unit,
         u.full_name AS doctor_name
    FROM stock_requests r
    JOIN medicines m ON m.id = r.medicine_id
    JOIN doctors d ON d.id = r.doctor_id
    JOIN users u ON u.id = d.user_id`;

// Shop inbox order (C3): work that needs action first, finished last.
const STATUS_ORDER = `array_position(ARRAY['SENT','ACKNOWLEDGED','PARTIALLY_FULFILLED','REFERRED',
  'FULFILLED','CLOSED','CANCELLED','EXPIRED']::request_status[], r.status)`;

function toPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    requestNo: row.request_no,
    status: row.status,
    urgency: row.urgency,
    doctor: { id: row.doctor_id, fullName: row.doctor_name },
    shopId: row.shop_id,
    patientId: row.patient_id,
    prescriptionId: row.prescription_id,
    medicine: {
      id: row.medicine_id,
      brandName: row.medicine_brand_name,
      strength: row.medicine_strength,
      dosageForm: row.medicine_dosage_form,
      baseUnit: row.medicine_base_unit,
    },
    requestedQty: row.requested_qty,
    availableQtySnapshot: row.available_qty_snapshot,
    fulfilledQty: row.fulfilled_qty,
    unfulfilledQty: row.requested_qty - row.fulfilled_qty,
    doctorNote: row.doctor_note,
    expiresAt: row.expires_at,
    acknowledgedAt: row.acknowledged_at,
    acknowledgedBy: row.acknowledged_by,
    fulfilledAt: row.fulfilled_at,
    closedAt: row.closed_at,
    closedBy: row.closed_by,
    closeReason: row.close_reason,
    cancelledAt: row.cancelled_at,
    cancelReason: row.cancel_reason,
    expiredAt: row.expired_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Group requests that share a prescription (C3). Keeps the list order: a group
 * sits where its first request was. Requests without a prescription are a
 * group of one with prescriptionId null.
 *   [{ prescriptionId, requests: [...] }, ...]
 */
function groupByPrescription(requests) {
  const groups = [];
  const byRx = new Map();
  for (const r of requests) {
    if (r.prescriptionId == null) {
      groups.push({ prescriptionId: null, requests: [r] });
      continue;
    }
    let g = byRx.get(r.prescriptionId);
    if (!g) {
      g = { prescriptionId: r.prescriptionId, requests: [] };
      byRx.set(r.prescriptionId, g);
      groups.push(g);
    }
    g.requests.push(r);
  }
  return groups;
}

module.exports = { URGENCY_HOURS, SELECT, STATUS_ORDER, toPublic, groupByPrescription };
