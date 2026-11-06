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
npm run seed                    # demo data (from Commit 3, Nov 8)
npm start                       # http://localhost:3000/health
```

| Script | What it does |
| --- | --- |
| `npm start` / `npm run dev` | run the server (dev = auto-restart) |
| `npm run migrate` | apply pending migrations |
| `npm run migrate:status` | list applied `[x]` and pending `[ ]` migrations |
| `npm run seed` | run `src/db/seeds/*.js` (idempotent) |
| `npm test` | unit + DB tests (DB tests skip if Postgres isn't reachable) |

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
  middleware/        errorHandler (auth, rbac, idempotency land Nov 6)
  shared/            errors.js (AppError, ErrorCodes), enums.js, asyncHandler.js
  modules/           users, shops, patients, phones, notifications, …
```

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

## Commit plan (Izaz)

| # | Due | Deliverable |
| --- | --- | --- |
| 1 | Tue Nov 4 | Scaffold, migration 001 (enums + conventions), error codes, notification stubs ✅ |
| 2 | Thu Nov 6 | Users, bcrypt, JWT login, rbac + idempotency middleware, doctors |
| 3 | Sat Nov 8 | Shops, shop staff, patients + seed data |
| 4 | Mon Nov 10 | Phone numbers, validator, CRUD, rules P1–P10 |
| 5 | Wed Nov 12 | Rules P11–P13, verify route, real notification.service + inbox |
| 6 | Fri Nov 14 | SMS/email channels, retries with backoff, unreachable after 3 failures |
| 7 | Sun Nov 16 | Edge-case tests 4, 9, 10, fixes, README, merge to main |
