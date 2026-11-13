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
npm run seed                    # demo users, shops, staff, patients
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
| shopkeeper@dosely.dev | SHOPKEEPER | OWNER of DSL-JAY-01 (Jayanagar) |
| staff@dosely.dev | SHOPKEEPER | STAFF of DSL-JAY-01 |
| owner.kor@dosely.dev | SHOPKEEPER | OWNER of DSL-KOR-02 and DSL-WHF-04 |
| owner.ind@dosely.dev | SHOPKEEPER | OWNER of DSL-IND-03 |

### Demo shops and patients

| Code | Shop | Area, pincode | Notes |
| --- | --- | --- | --- |
| DSL-JAY-01 | Jayanagar Health Pharmacy | Jayanagar, 560011 | has an OWNER and a STAFF member |
| DSL-KOR-02 | Koramangala MedPlus Point | Koramangala, 560095 | |
| DSL-IND-03 | Indiranagar Care Chemists | Indiranagar, 560038 | no coordinates |
| DSL-WHF-04 | Whitefield Night Pharmacy | Whitefield, 560066 | **inactive** — can't receive requests |

Patients (added by doctor@): Arjun Mehta, Priya Nair, Rohan Das (child), Lakshmi Iyer (senior),
Sam Thomas (no DOB/gender), Meera Pillai. Look ids up with `GET /shops?search=DSL-` and `GET /patients`,
or in SQL by `code` / `full_name` — don't hard-code ids.

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
| POST /auth/login | anyone | `{ email \| phone, password }` → token + user (phone must be verified) |
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
| POST /shops | SHOPKEEPER (becomes OWNER) or ADMIN (`ownerUserId`) | `{ name, code, drugLicenceNo, address, area, city?, pincode, latitude?, longitude? }` |
| GET /shops | logged in | `?search=&area=&pincode=&isActive=&mine=true&limit=&offset=` |
| GET /shops/:shopId | logged in | includes `myRole` (OWNER / STAFF / null) |
| PATCH /shops/:shopId | OWNER or ADMIN | any shop field |
| DELETE /shops/:shopId, POST /shops/:shopId/activate | OWNER or ADMIN | deactivate / activate |
| GET /shops/:shopId/staff | shop staff or ADMIN | `?includeRemoved=true` |
| POST /shops/:shopId/staff | OWNER or ADMIN | `{ userId, staffRole? = STAFF }` — SHOPKEEPER users only |
| PATCH /shops/:shopId/staff/:userId | OWNER or ADMIN | `{ staffRole }` |
| DELETE /shops/:shopId/staff/:userId | OWNER or ADMIN | remove; the last OWNER can't be removed or demoted |
| POST /patients | DOCTOR, SHOPKEEPER, ADMIN | `{ fullName, dateOfBirth? (YYYY-MM-DD), gender? }` |
| GET /patients | DOCTOR, SHOPKEEPER, ADMIN | `?search=&phone=&isActive=&mine=true&limit=&offset=` — phone matched after normalising |
| GET /patients/:id, PATCH /patients/:id | DOCTOR, SHOPKEEPER, ADMIN | responses include `age` |
| DELETE /patients/:id | creator or ADMIN | deactivate; `POST /patients/:id/activate` (ADMIN) |
| GET /{users,patients,shops}/:id/phones | see Phone numbers | `?includeRemoved=true`; primary first |
| POST /{users,patients,shops}/:id/phones | see Phone numbers | `{ number, label? = MOBILE, isPrimary? }` → phone + `warnings` |
| PATCH /{users,patients,shops}/:id/phones/:phoneId | see Phone numbers | `{ number?, label?, isPrimary? }` — new digits reset verification (P12) |
| DELETE /{users,patients,shops}/:id/phones/:phoneId | see Phone numbers | deactivate |
| POST /phones/:phoneId/verify | staff confirmation (see P11–P13) | marks VERIFIED, clears UNREACHABLE |
| GET /notifications | logged in | own in-app inbox: `?unreadOnly=&limit=&before=` |
| POST /notifications/:id/read, POST /notifications/read-all | logged in | |

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
router.patch('/shops/:shopId/inventory/:id', requireShopStaff(), …);  // any active staff → req.shopStaff = { shopId, staffRole }
router.post('/shops/:shopId/thresholds', requireShopStaff({ owner: true }), …); // OWNER only
```

### Shop and patient helpers (Commit 3)

```js
const shops = require('../shops/shops.service');
const patients = require('../patients/patients.service');

await shops.assertCanReceiveRequests(shopId);   // throws NOT_FOUND / SHOP_INACTIVE (A6) — call before sending a request or referral
await patients.assertActive(patientId);          // throws NOT_FOUND / PATIENT_INACTIVE
await shops.listActiveStaffUserIds(shopId);      // [userId…] active staff with active accounts (used by notification fan-out)
await shops.listShopsForUser(userId);            // [{ shopId, staffRole }]
```

## Phone numbers (A9, rules P1–P13)

Who can manage numbers: **users** — themselves or ADMIN; **patients** — DOCTOR, SHOPKEEPER, ADMIN;
**shops** — anyone can read, the shop OWNER or ADMIN can change.

| Rule | What happens | Error |
| --- | --- | --- |
| P1 | Spaces, dashes, dots, brackets stripped; 10 digits, leading 0 or 91 → +91 | — |
| P2 | Must be a valid number for its country | 422 PHONE_INVALID_FORMAT |
| P3 | Indian mobiles are +91[6-9]… **and** in a mobile range (so Bengaluru 080 landlines aren't mistaken for mobiles). Landlines only as HOME / WORK / SHOP, never SMS | 422 PHONE_NOT_MOBILE |
| P4 | Same number twice on one owner (compared after normalising) | 409 PHONE_DUPLICATE_FOR_OWNER |
| P5 | Same number on two patients is allowed; response has `warnings: [{ code: 'PHONE_SHARED_WITH_PATIENT', patients: ['P**** N***'] }]` | 201 + warning |
| P6 | A verified number belongs to one user only (it's a login) | 409 PHONE_TAKEN |
| P7 | At most 5 active numbers per owner | 422 PHONE_LIMIT |
| P8 | First number becomes primary | — |
| P9 | New primary unsets the old one in the same transaction | — |
| P10 | Primary can't be removed while others exist | 409 PHONE_PRIMARY_REQUIRED |

Demo numbers (seed 003): users `+91 99000 0000{1–5}` (doctor@, shopkeeper@, staff@, owner.kor@, owner.ind@ — all verified,
so `POST /auth/login { "phone": "9900000001", "password": "Dosely@123" }` works); Jayanagar shop landline `+91 80 2663 0000`;
Priya Nair and Rohan Das share `+91 98100 00102` (P5); Sam Thomas has only an **unverified** number (edge case 9);
Meera Pillai has **no phone** (edge case 10).

```js
const { normalizePhone, tryNormalize } = require('../phones/phone.validator');
normalizePhone('098765 43210');   // { e164: '+919876543210', kind: 'MOBILE', label: 'MOBILE', smsCapable: true, … }
tryNormalize('bad');              // null instead of throwing
```

DATE columns come back from the database as `'YYYY-MM-DD'` strings (not JS Dates), e.g. `dateOfBirth`, `expiryDate`.

**Anushka:** `shops` and `patients` are on `main` now (migration 003), so your 02x migration can add the
foreign keys for `stock_requests.shop_id / patient_id` and `referrals.from_shop_id / to_shop_id`.
**Rachana:** inventory can reference `shops(id)` now.

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

## Notifications (A10) — notification.service is live

Same signatures as the Nov 4 stubs — nothing to change in your code. Rows are now real: in-app ones show up
in the person's inbox (`GET /notifications`), SMS / EMAIL ones are queued as `PENDING` for the delivery job (Commit 6).

```js
const notifications = require('../notifications/notification.service');

// Rachana — low-stock alert to every active staff member of a shop (removed staff get nothing)
await notifications.notifyShop(shopId, {
  channels: ['IN_APP'],
  type: 'LOW_STOCK',                                   // UPPER_SNAKE_CASE
  title: 'Low stock',
  body: `${itemName} is below ${threshold}`,
  data: { medicineId },
  dedupeKey: `low-stock:${shopId}:${medicineId}:${today}`,   // F6.4: once per shop + medicine per day
}, { client });             // inside your transaction: only created if you commit

// Anushka — referral SMS to a patient (≤ 160 chars). Put shopId / doctorUserId in data so the
// right person is alerted if the number turns out to be unreachable (P13).
const r = await notifications.notifyPatient(patientId, {
  type: 'REFERRAL_ACCEPTED',
  title: 'Referral',
  body: `Your medicine is ready at ${shopName}. Code ${code}`,
  data: { referralId, shopId: originShopId, doctorUserId },
  dedupeKey: `referral-sms:${referralId}`,
});
if (r.skipped.length) {
  // edge cases 9 and 10 / F4.9: no usable phone — tell staff to inform the patient in person and print the slip
  // r.skipped[0].skipReason is NO_PHONE | NO_VERIFIED_MOBILE | PHONE_UNREACHABLE
}
```

Returns `{ deduped, notifications: [{ id, channel, recipientUserId, status, phoneId, skipReason }], skipped }`.

| Channel | Who | Status when created |
| --- | --- | --- |
| IN_APP | users (a shop = all its active staff) | `SENT` — it's in their inbox |
| SMS | a user's or patient's verified, reachable mobile (primary first) | `PENDING`, or `SKIPPED` + `skipReason` |
| EMAIL | a user's email | `PENDING`, or `SKIPPED` + `NO_EMAIL` |

- **Dedupe:** a `dedupeKey` that was used before returns `{ deduped: true }` with the earlier rows and creates nothing,
  even with concurrent callers.
- **Inbox routes:** `GET /notifications?unreadOnly=&limit=&before=` → `{ items, unreadCount, nextBefore }`,
  `POST /notifications/:id/read`, `POST /notifications/read-all`.

## Phone verification and delivery rules (P11–P13)

| Rule | What happens | Error |
| --- | --- | --- |
| Verify | `POST /phones/:phoneId/verify` — staff confirmation (F5.3). Patients' numbers: DOCTOR / SHOPKEEPER / ADMIN; shop numbers: that shop's staff; a user's number: ADMIN or an OWNER of a shop they work at. Nobody verifies their own. | 403 FORBIDDEN |
| P11 | A user's primary must be verified: switching to an unverified number, or changing the digits of a user's primary while they have other numbers, is refused. Patients and shops may have an unverified primary, but SMS only goes to verified, reachable mobiles. | 422 PHONE_NOT_VERIFIED |
| P12 | `PATCH …/phones/:phoneId { number }` with new digits resets verification and the failure count | — |
| P13 | 3 failed SMS in a row mark a verified number `UNREACHABLE`; the shop (or the doctor / whoever added the patient) gets an in-app `PHONE_UNREACHABLE` alert. Re-verifying clears it. | — |

## Catalog and stock (Rachana)

Migrations `010`–`019` are claimed for catalog + stock.

- `010`: `generics`, `medicines`, `medicine_batches`, enums `dosage_form`, `base_unit`, `stock_movement_type`.
- `011`: `inventory` (one row per shop + batch: `quantity >= 0`, `0 <= reserved <= quantity`, `version`)
  and the `stock_movements` ledger, both referencing `shops`. `request_id` and `referral_id` have no
  foreign keys yet (`020` runs after `011`); a later migration adds them.
- `012`: `stock_thresholds` (per shop + medicine reorder level) and `stock_alerts` (one row per alert sent;
  its unique index is what stops repeats), plus `medicine_batches.expired_flagged_at`.

- Generic names are unique ignoring case. Medicines are unique on brand + manufacturer + form + strength;
  `prescription_required` defaults to true.
- Batch number is unique per medicine; `mrp` is INR per base unit (> 0); manufacture date must be before expiry.
- A medicine with no batches can be hard-deleted; once it has one, the delete maps to `409 MEDICINE_IN_USE`
  (deactivate it instead). Batches and generics are never hard-deleted.
- **Only stock.service writes stock (B6).** It switches on `dosely.stock_writer` for its own transaction;
  any other `INSERT`/`UPDATE` on `inventory` fails with `STOCK_WRITE_FORBIDDEN`. Inventory rows at 0 are kept.
- **The ledger is append-only (B5).** `UPDATE`, `DELETE` and `TRUNCATE` on `stock_movements` fail with
  `LEDGER_APPEND_ONLY`, even for superusers. The migration also creates a `dosely_app` role with
  `SELECT, INSERT` only on the ledger; in production the app should log in as a member of it.
- Every movement row's `delta` sign must match its type, and `ADJUSTMENT` / `EXPIRY_WRITE_OFF` need a `reason`.
- A batch is expired when its expiry date is today or earlier (India time); expired batches can't be added.

### Catalog API

| Method & path | Who | What |
| --- | --- | --- |
| GET /medicines | logged in | `?q=&genericId=&dosageForm=&prescriptionRequired=&isActive=&limit=&offset=` — `q` matches brand, generic and manufacturer; non-admins see active only |
| GET /medicines/:id | logged in | medicine + sellable batches (earliest expiry first) |
| POST /medicines | ADMIN | `{ brandName, genericId \| genericName, manufacturer, dosageForm, strength, baseUnit, prescriptionRequired?, batches?: [{ batchNo, manufactureDate?, expiryDate, mrp }] }` |
| PATCH /medicines/:id | ADMIN | any of the fields above except `genericName`; `baseUnit` is locked once batches exist |
| POST /medicines/:id/deactivate, /activate | ADMIN | |
| DELETE /medicines/:id | ADMIN | only while it has no batches, else `409 MEDICINE_IN_USE` |
| GET /medicines/:id/batches | logged in | `?includeExpired=true` |
| POST /medicines/:id/batches | ADMIN | `{ batchNo, manufactureDate?, expiryDate, mrp }` → `422 BATCH_EXPIRED`, `409 BATCH_NO_TAKEN` |
| GET /generics, /generics/:id | logged in | `?q=&isActive=` |
| POST /generics, PATCH /generics/:id | ADMIN | `{ name, description? }` (+ `isActive` on PATCH) → `409 GENERIC_NAME_TAKEN` |

`genericName` finds the generic ignoring case, or creates it. Batch numbers are stored trimmed and upper-case.

### stock.service contract (agree Nov 4)

`src/modules/inventory/stock.service.js` is the **only** code that changes stock. Every function takes
`opts = { client }` last to join your transaction (SAVEPOINT). Full JSDoc is in the file.

All seven functions are real (`stockIn`, `getAvailable`, `reserve`, `release` since Nov 8; `dispense`,
`adjust`, `writeOff` since Nov 10).

How it never oversells: `dispense` and `reserve` lock the medicine's inventory rows in `batch_id` order (so
multi-batch calls can't deadlock), pick earliest-expiry first, and every update is conditional on the stock
still being there. When two callers race for the last units, one wins and the other gets
`409 INSUFFICIENT_STOCK`. The same idempotency key never changes stock twice, even when both requests arrive
at once.

`reserve`: call it once per referral (inside the PENDING → ACCEPTED transition) and keep its `lines`;
`release` never takes `reserved` below 0, so calling it twice is safe. Held units can't be dispensed to
walk-ins; `dispense({ reservation: lines })` takes exactly the held units and clears the hold.

#### Stock routes

| Method & path | Who | Body → result |
| --- | --- | --- |
| POST /shops/:shopId/stock-in | shop staff | `{ medicineId, batchNo, manufactureDate?, expiryDate, mrp, quantity, reason? }` → `{ batch, batchCreated, inventory, movement, replayed }` |
| POST /shops/:shopId/dispense | shop staff | `{ medicineId, quantity, requestId?, referralId?, reservation?, reason? }` → `{ lines: [{ batchId, batchNo, expiryDate, quantity, movementId, balanceAfter }], replayed }` |
| POST /shops/:shopId/adjustments | shop OWNER | `{ batchId, delta, expectedVersion, reason }` → `{ inventory, movement, replayed }` |
| POST /shops/:shopId/write-offs | shop OWNER | `{ batchId, quantity?, expectedVersion?, reason }` → `{ inventory, movement, replayed }` |
| GET /shops/:shopId/inventory | shop staff | `?medicineId=&q=&expiring=90&expired=true&includeEmpty=true` → one row per batch, earliest expiry first, with `version` |
| GET /shops/:shopId/movements | shop staff | `?batchId=&medicineId=&type=` → ledger, newest first |
| GET /medicines/:id/availability | logged in | `?shopIds=1,2` → non-expired, unreserved units per active shop |
| GET /shops/:shopId/thresholds | shop staff | `?low=true` → reorder levels with `available` and `isLow` |
| PUT /shops/:shopId/thresholds/:medicineId | shop OWNER | `{ minQuantity }` (create or change) |
| DELETE /shops/:shopId/thresholds/:medicineId | shop OWNER | |

`GET /shops/:shopId/inventory?low=true` lists the batches of medicines that are below the shop's threshold.

#### Alerts and daily jobs (B12)

A medicine is **low** at a shop when its non-expired, unreserved units are below the shop's threshold.

| Alert | Sent by | At most |
| --- | --- | --- |
| `LOW_STOCK` | `dispense` (right after stock drops below the threshold) and `lowStockScan` | once per shop + medicine per day |
| `EXPIRY_ALERT` | `expiryScan`, batches expiring within 90 days | once per shop + batch per week |
| `BATCH_EXPIRED` | `expiryScan`, expired batches still holding units ("write them off") | once per shop + batch |

Alerts go to every active staff member of the shop through `notification.service.notifyShop` (IN_APP).
Each one is first recorded in `stock_alerts`; a repeat in the same period records and sends nothing,
even if two jobs overlap. The post-dispense check runs inside the dispense transaction, so a rolled-back
dispense leaves no alert. `expiryScan` also stamps newly expired batches with `expired_flagged_at`.

Run the jobs by hand with `npm run job:expiry` and `npm run job:low-stock`, or set `ENABLE_JOBS=true` and
the server runs both every day at 06:00 India time (and once shortly after start-up).

`npm run seed` adds demo stock: 10 common medicines (Dolo 650, Pan 40, Azithral 500, …) with batches at
Jayanagar, Koramangala and Indiranagar, a few expiring within 90 days, and thresholds where Dolo 650 and
Azithral 500 are low at Jayanagar. Re-running it adds nothing.

To edit stock safely: read the row from `/inventory`, send its `version` as `expectedVersion`; if someone
changed it meanwhile you get `409 STALE_INVENTORY` with the current version — reload and retry.
Rows at 0 units are hidden unless `includeEmpty=true`; `expired=true` lists expired batches that still hold
units, ready to write off.

ADMIN can use all of them. POST routes need `Idempotency-Key`. Errors: `422 BATCH_EXPIRED`, `409 BATCH_MISMATCH`, `409 INSUFFICIENT_STOCK`,
`409 STALE_INVENTORY`, `400 REASON_REQUIRED`, `409 SHOP_INACTIVE`, `409 MEDICINE_INACTIVE`,
`422 IDEMPOTENCY_KEY_REUSED`, `403 NOT_SHOP_STAFF` / `NOT_SHOP_OWNER`. `getAvailable` only counts active shops.

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
| 2 | Thu Nov 6 | Catalog services and routes: search, create, edit, deactivate, MEDICINE_IN_USE (B1–B3) ✅ |
| 3 | Sat Nov 8 | Inventory + stock_movements (grants revoked); real stockIn (B4, B5, B7) ✅ |
| 4 | Mon Nov 10 | Real dispense: FEFO, atomic update, batch-order locks, idempotency (B8); adjust, writeOff (B9) ✅ |
| 5 | Wed Nov 12 | reserve/release, STALE_INVENTORY, availability helper (B10), inventory list route ✅ |
| 6 | Fri Nov 14 | Thresholds (B11), expiryScan + lowStockScan jobs, post-dispense low-stock check (B12), seed stock ✅ |
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
| POST /requests/:id/acknowledge | shop staff, ADMIN | only from `SENT`, before expiry |
| POST /requests/:id/close | shop staff, ADMIN | `{ reason }` (1–500 chars, else `400 CLOSE_REASON_REQUIRED`); from `ACKNOWLEDGED` or `PARTIALLY_FULFILLED` |
| POST /requests/:id/cancel | sending doctor, ADMIN | `{ reason? }`; cancels live referrals and releases held stock |

Lists take `&status=&limit=&offset=` and return `{ items: [{ prescriptionId, requests: [...] }], total, limit, offset }`:
requests sharing a prescription come back as one group. `ROUTINE` requests expire after 24 h, `URGENT` after 2 h.
Any status change the state machine doesn't allow (wrong status, or a failing guard such as "request has
expired") is `409 INVALID_TRANSITION` with `details: { from, to, actor, reason }`. Acknowledge is a
conditional update, so it can't race the expiry job. The action routes accept an optional `Idempotency-Key`.

Until Izaz's `shops` / `shop_staff` tables land, `src/modules/requests/shopAccess.js` runs as a stub
(any shop id is active, any SHOPKEEPER is staff of every shop) and switches to the real checks by itself.

### Commit plan (Anushka)

| # | Due | Deliverable |
| --- | --- | --- |
| 1 | Tue Nov 4 | Migrations for stock_requests and referrals; request.state.js transition table ✅ |
| 2 | Thu Nov 6 | Create request (snapshot, number, urgency, expiry), doctor list, shop inbox (C1–C3) ✅ |
| 3 | Sat Nov 8 | Guards for every transition; acknowledge, close, cancel routes; state machine tests (C4, C5) ✅ |
| 4 | Mon Nov 10 | Availability lookup with ranking; dispense against a request (C6) |
| 5 | Wed Nov 12 | Referrals: create, accept with hold, reject, cancel (C7, C8) |
| 6 | Fri Nov 14 | Pickup verification, patient SMS batching + slip, expiry jobs, 2-hour reminder (C9–C11) |
| 7 | Sun Nov 16 | Referral flow integration test, edge cases 1, 2, 7, 8, 11, 12, 13, 16; merge to main |

## Commit plan (Izaz)

| # | Due | Deliverable |
| --- | --- | --- |
| 1 | Tue Nov 4 | Scaffold, migration 001 (enums + conventions), error codes, notification stubs ✅ |
| 2 | Thu Nov 6 | Users, bcrypt, JWT login, rbac + idempotency middleware, doctors ✅ |
| 3 | Sat Nov 8 | Shops, shop staff, patients + seed data ✅ |
| 4 | Mon Nov 10 | Phone numbers, validator, CRUD, rules P1–P10 ✅ |
| 5 | Wed Nov 12 | Rules P11–P13, verify route, real notification.service + inbox ✅ |
| 6 | Fri Nov 14 | SMS/email channels, retries with backoff, unreachable after 3 failures |
| 7 | Sun Nov 16 | Edge-case tests 4, 9, 10, fixes, README, merge to main |
