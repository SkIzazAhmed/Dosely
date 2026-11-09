# Dosely — Pharmacy MVP (ApDe Project)

Express + PostgreSQL backend for the pharmacy module.
Platform & People (setup, auth, users, shops, patients, phones, notifications): **Izaz**.

## Setup

Requires Node 20+ and PostgreSQL 14+.

```bash
git clone https://github.com/SkIzazAhmed/Dosely.git && cd Dosely
npm install
cp .env.example .env            # edit DATABASE_URL
createdb pharmacy_mvp           # or: psql -c 'CREATE DATABASE pharmacy_mvp'
npm run migrate                 # apply db/migrations/*.sql
npm run seed                    # demo users (shops/patients from Commit 3, Nov 8)
npm start                       # http://localhost:3000/health
```

| Script | What it does |
| --- | --- |
| `npm start` / `npm run dev` | run the server (dev = auto-restart) |
| `npm run migrate` | apply pending migrations |
| `npm run migrate:status` | list applied `[x]` and pending `[ ]` migrations |
| `npm run seed` | run `src/db/seeds/*.js` (idempotent) |
| `npm test` | unit + DB tests (DB tests skip if Postgres isn't reachable; they add users with random emails) |

## Layout

```
src/
  app.js, server.js
  config/            env values (config/index.js)
  db/
    pool.js          pg Pool + query()
    transaction.js   withTransaction(fn, { client? })
    migrate.js       migration runner
    seed.js          seed runner
    migrations/      NNN_name.sql
    seeds/           NNN_name.js  -> export async function seed(client)
  middleware/        auth, rbac, idempotency, errorHandler
  shared/            errors, enums, validate, password, jwt, asyncHandler
  modules/           auth, users, doctors, shops, patients, phones, notifications, …
```

## Demo logins

After `npm run seed` (password for all: `Dosely@123`, or `SEED_PASSWORD` in `.env`):

| Email | Role | Notes |
| --- | --- | --- |
| admin@dosely.dev | ADMIN | |
| doctor@dosely.dev | DOCTOR | registration no. KMC-100245, can send requests |
| doctor.noreg@dosely.dev | DOCTOR | no registration no., can't send requests |
| shopkeeper@dosely.dev | SHOPKEEPER | becomes shop OWNER in Commit 3 |
| staff@dosely.dev | SHOPKEEPER | becomes shop STAFF in Commit 3 |

```bash
curl -s -X POST localhost:3000/auth/login -H 'content-type: application/json' \
  -d '{"email":"doctor@dosely.dev","password":"Dosely@123"}'
# → { "token": "eyJ…", "tokenType": "Bearer", "expiresIn": "1d", "user": { … } }
curl -s localhost:3000/auth/me -H "authorization: Bearer <token>"
```

## API so far

All routes except `POST /auth/login` need `Authorization: Bearer <token>`.
`POST` routes that create something need an `Idempotency-Key` header (any unique string, e.g. a UUID).

| Method & path | Who | What |
| --- | --- | --- |
| POST /auth/login | anyone | `{ email, password }` → token + user |
| GET /auth/me | logged in | current user (+ `doctor` profile for doctors) |
| POST /users | ADMIN | `{ role, fullName, email?, password }` |
| GET /users | ADMIN | `?role=&isActive=&search=&limit=&offset=` |
| GET /users/:id | self or ADMIN | |
| PATCH /users/:id | self or ADMIN | `{ fullName?, email?, password?, currentPassword? }` — role can't change |
| DELETE /users/:id | ADMIN | deactivates (no hard delete) |
| POST /users/:id/activate | ADMIN | |
| POST /doctors | DOCTOR (own) or ADMIN (`userId`) | `{ registrationNo?, specialization?, qualification?, clinicName? }` |
| GET /doctors, /doctors/:id | logged in | list / one |
| GET /doctors/me | DOCTOR | own profile, incl. `canSendRequests` |
| PATCH /doctors/:id | that doctor or ADMIN | |
| DELETE /doctors/:id, POST /doctors/:id/activate | ADMIN | deactivate / activate |

### Using auth in your module (Rachana, Anushka)

```js
const { authenticate } = require('../../middleware/auth');
const { requireRole, requireShopStaff } = require('../../middleware/rbac');
const { idempotency } = require('../../middleware/idempotency');
const doctors = require('../doctors/doctors.service');

router.use(authenticate);                                   // sets req.user = { id, role, fullName, email, … }
router.post('/', requireRole('DOCTOR'), idempotency(), asyncHandler(async (req, res) => {
  const doctor = await doctors.assertCanSendRequests(req.user.id); // throws DOCTOR_REG_NO_REQUIRED
  …
}));
router.patch('/shops/:shopId/inventory/:id', requireShopStaff(), …);         // any active staff (shops land Nov 8)
router.delete('/shops/:shopId/staff/:id', requireShopStaff({ owner: true }), …); // OWNER only
```

ADMIN passes `requireShopStaff` for every shop. Idempotent replays carry the header `Idempotent-Replayed: true`.

## Team conventions

**Errors.** Throw `AppError` — never `res.status(…).json(…)` by hand for errors.
Every error response has this shape:

```json
{ "error": { "code": "PHONE_LIMIT_REACHED", "message": "An owner can have at most 5 phone numbers", "details": null } }
```

```js
const { AppError, fromPgError } = require('../../shared/errors');
throw new AppError('SHOP_INACTIVE');
throw AppError.validation([{ field: 'quantity', issue: 'must be > 0' }]);
// map DB constraint names to your own codes:
catch (e) { throw fromPgError(e, { inventory_shop_item_key: 'DUPLICATE' }); }
```

Add new codes to `ErrorCodes` in `src/shared/errors.js` (put them in a section for your module).

**Tables (A2).** Every table has `id bigint GENERATED ALWAYS AS IDENTITY`, `created_at`, `updated_at`,
`is_active`; foreign keys are `ON DELETE RESTRICT`; status-like columns use PostgreSQL enums.
After `CREATE TABLE`, run:

```sql
SELECT apply_conventions('my_table');        -- updated_at trigger + blocks DELETE
SELECT apply_conventions('my_log', true);    -- updated_at trigger only (deletes allowed)
```

Deactivate rows (`is_active = false`) instead of deleting them.

**Migrations.** `NNN_name.sql`, claim your number in the team chat first. Never edit a migration that is
on `main` — the runner checks checksums and stops. Add a new file instead.

**Transactions.** Anything that writes to more than one table goes through `withTransaction`, and every
query inside it uses the `client` it gives you.

## notification.service contract (agree Nov 4)

Stubs are in `src/modules/notifications/notification.service.js` and already validate input, so you can
call them now; the real service replaces them on **Nov 12** (in-app) and **Nov 14** (SMS/email) with
the same signatures.

```js
const notifications = require('../notifications/notification.service');

// Rachana — low-stock alert to every active staff member of a shop
await notifications.notifyShop(shopId, {
  channels: ['IN_APP'],
  type: 'LOW_STOCK',
  title: 'Low stock',
  body: `${itemName} is below ${threshold}`,
  data: { itemId },
  dedupeKey: `low-stock:${shopId}:${itemId}:${today}`,
}, { client });             // pass your transaction client if you're in one

// Anushka — referral SMS to a patient (≤ 160 chars)
await notifications.notifyPatient(patientId, {
  channels: ['SMS'],
  type: 'REFERRAL_SENT',
  title: 'Referral',
  body: `Your prescription was sent to ${shopName}. Code ${code}`,
  dedupeKey: `referral:${referralId}`,
});
```

Returns `{ deduped, notifications: [{ id, channel, recipientUserId, status }] }`.
Also: `notifyUser(userId, payload, opts)`, `notify({ recipientType, recipientId, ...payload })`,
`listInbox(userId, { unreadOnly, limit, before })`, `markRead(notificationId, userId)`.
Patients have no login, so `IN_APP` to a patient is a validation error.

## Catalog and stock (Rachana)

Tables so far (migration `010`, numbers 010–019 claimed for catalog + stock): `generics`,
`medicines`, `medicine_batches`, plus enums `dosage_form`, `base_unit`, `stock_movement_type`.
`inventory`, `stock_movements` and `stock_thresholds` land Nov 8.

- Generic names are unique ignoring case. Medicines are unique on brand + manufacturer + form + strength;
  `prescription_required` defaults to true.
- Batch number is unique per medicine; `mrp` is INR per base unit (> 0); manufacture date must be before expiry.
- A medicine with no batches can be hard-deleted; once it has one, the delete maps to `409 MEDICINE_IN_USE`
  (deactivate it instead). Batches and generics are never hard-deleted.

### stock.service contract (agree Nov 4)

`src/modules/inventory/stock.service.js` is the **only** code that changes stock. Today it is a stub that
validates input like the real service and keeps stock in memory, so FEFO, `INSUFFICIENT_STOCK`,
`BATCH_EXPIRED`, `BATCH_MISMATCH`, `STALE_INVENTORY` and idempotent replays already behave realistically.
Real versions replace it with the same signatures: `stockIn` Nov 8, `dispense`/`adjust`/`writeOff` Nov 10,
`reserve`/`release`/`getAvailable` Nov 12. Every function takes `opts = { client }` last to join your
transaction. Full JSDoc is in the file.

```js
const stock = require('../inventory/stock.service');

// Anushka — lookup: which shops have it? (non-expired, unreserved units)
const shops = await stock.getAvailable(medicineId, { shopIds });   // [{ shopId, medicineId, available, nearestExpiry }]

// referral accepted → hold the units; keep `lines` on the referral
const { lines } = await stock.reserve({ shopId, medicineId, quantity, referralId, performedBy: req.user.id }, { client });

// patient picks up → dispense exactly the reserved units
await stock.dispense({ shopId, medicineId, quantity, referralId, reservation: lines,
                       performedBy: req.user.id, idempotencyKey }, { client });

// referral rejected / expired → give the units back
await stock.release({ shopId, referralId, lines, performedBy: req.user.id }, { client });

// walk-in dispense (FEFO across batches); idempotencyKey is required
await stock.dispense({ shopId, medicineId, quantity, requestId, performedBy, idempotencyKey });
```

| Function | Errors |
| --- | --- |
| `stockIn({ shopId, medicineId, batchNo, expiryDate, manufactureDate?, mrp, quantity, performedBy, reason?, idempotencyKey? })` | 422 `BATCH_EXPIRED`, 409 `BATCH_MISMATCH` |
| `dispense({ shopId, medicineId, quantity, performedBy, idempotencyKey, requestId?, referralId?, reservation? })` | 409 `INSUFFICIENT_STOCK` |
| `adjust({ shopId, batchId, delta, expectedVersion, reason, performedBy })` — OWNER | 409 `STALE_INVENTORY`, 400 `REASON_REQUIRED` |
| `writeOff({ shopId, batchId, quantity?, expectedVersion?, reason, performedBy })` — OWNER | 409 `STALE_INVENTORY`, 409 `INSUFFICIENT_STOCK` |
| `reserve({ shopId, medicineId, quantity, referralId, performedBy })` → `{ lines }` | 409 `INSUFFICIENT_STOCK` |
| `release({ shopId, referralId, lines, performedBy })` → `{ released }` | — |
| `getAvailable(medicineId, { shopIds? })` | — |

### Commit plan (Rachana)

| # | Due | Deliverable |
| --- | --- | --- |
| 1 | Tue Nov 4 | Migrations for generics, medicines, batches; stock.service stub with agreed signatures ✅ |
| 2 | Thu Nov 6 | Catalog services and routes: search, create, edit, deactivate, MEDICINE_IN_USE (B1–B3) |
| 3 | Sat Nov 8 | Inventory + stock_movements (grants revoked); real stockIn (B4, B5, B7) |
| 4 | Mon Nov 10 | Real dispense: FEFO, atomic update, batch-order locks, idempotency (B8); adjust, writeOff (B9) |
| 5 | Wed Nov 12 | reserve/release, STALE_INVENTORY, availability helper (B10), inventory list route |
| 6 | Fri Nov 14 | Thresholds (B11), expiryScan + lowStockScan jobs, post-dispense low-stock check (B12), seed stock |
| 7 | Sun Nov 16 | FEFO + concurrent dispense tests, edge cases 3, 5, 6, 14, 15; merge to main |

## Requests and referrals (Anushka)

Migration `020` (numbers 020–029 claimed for requests + referrals): `stock_requests`, `referrals`,
`request_number_counters`, enums `request_urgency`, `request_status`, `referral_status`, and
`next_request_no()` → `REQ-YYYY-NNNNNN`.

- One request = one medicine; quantity 1–10,000; it can only be sent when the requested quantity is more
  than the shop's available quantity (stored as `available_qty_snapshot`); doctor note ≤ 500 characters.
- `FULFILLED` needs `fulfilled_qty = requested_qty`; `PARTIALLY_FULFILLED` needs some but not all;
  `CLOSED` needs a reason.
- Referrals: at most 3 per request, no two live (`PENDING`/`ACCEPTED`) referrals to the same shop, and
  live referred quantity ≤ what is still unfulfilled (trigger, maps to `REFERRAL_LIMIT_REACHED` /
  `REFERRAL_QTY_EXCEEDED`). `REJECTED` needs a reason; `ACCEPTED` needs `hold_until`.
- `shop_id`, `patient_id`, `prescription_id`, `from_shop_id`, `to_shop_id` get their foreign keys in a
  later 02x migration, once those tables are on main.

State machines: `src/modules/requests/request.state.js` and `src/modules/referrals/referral.state.js`,
one `{ from, to, actor, guard }` table each. Any other move throws `409 INVALID_TRANSITION`.

### Requests API

| Method & path | Who | What |
| --- | --- | --- |
| POST /requests | DOCTOR with registration no. | `{ shopId, medicineId, quantity, urgency?, doctorNote?, patientId?, prescriptionId? }` → 201. Only when `quantity` > the shop's available stock, else `409 REQUEST_NOT_SHORT` |
| GET /requests?mine | DOCTOR | own requests, newest first |
| GET /requests?shopId= | shop staff, ADMIN | shop inbox, open statuses first |
| GET /requests/:id | sender, shop staff, ADMIN | one request |

Lists take `&status=&limit=&offset=` and return `{ items: [{ prescriptionId, requests: [...] }], total, limit, offset }`:
requests sharing a prescription come back as one group. `ROUTINE` requests expire after 24 h, `URGENT` after 2 h.

Until Izaz's `shops` / `shop_staff` tables land, `src/modules/requests/shopAccess.js` runs as a stub
(any shop id is active, any SHOPKEEPER is staff of every shop) and switches to the real checks by itself.

### Commit plan (Anushka)

| # | Due | Deliverable |
| --- | --- | --- |
| 1 | Tue Nov 4 | Migrations for stock_requests and referrals; request.state.js transition table ✅ |
| 2 | Thu Nov 6 | Create request (snapshot, number, urgency, expiry), doctor list, shop inbox (C1–C3) ✅ |
| 3 | Sat Nov 8 | Guards for every transition; acknowledge, close, cancel routes; state machine tests (C4, C5) |
| 4 | Mon Nov 10 | Availability lookup with ranking; dispense against a request (C6) |
| 5 | Wed Nov 12 | Referrals: create, accept with hold, reject, cancel (C7, C8) |
| 6 | Fri Nov 14 | Pickup verification, patient SMS batching + slip, expiry jobs, 2-hour reminder (C9–C11) |
| 7 | Sun Nov 16 | Referral flow integration test, edge cases 1, 2, 7, 8, 11, 12, 13, 16; merge to main |

## Commit plan (Izaz)

| # | Due | Deliverable |
| --- | --- | --- |
| 1 | Tue Nov 4 | Scaffold, migration 001 (enums + conventions), error codes, notification stubs ✅ |
| 2 | Thu Nov 6 | Users, bcrypt, JWT login, rbac + idempotency middleware, doctors ✅ |
| 3 | Sat Nov 8 | Shops, shop staff, patients + seed data |
| 4 | Mon Nov 10 | Phone numbers, validator, CRUD, rules P1–P10 |
| 5 | Wed Nov 12 | Rules P11–P13, verify route, real notification.service + inbox |
| 6 | Fri Nov 14 | SMS/email channels, retries with backoff, unreachable after 3 failures |
| 7 | Sun Nov 16 | Edge-case tests 4, 9, 10, fixes, README, merge to main |
