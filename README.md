# MyROOFHOMES Business Suite

Modular-monolith monorepo (NestJS + Prisma + PostgreSQL) built module-by-module from the engineering handbooks.

## Build status
| # | Module | Status |
|---|--------|--------|
| 00 | Foundations (User/Role/Consent/AuditLog, JWT + RBAC, envelope, errors) | ✅ |
| 01 | CRM — leads, dedup, lifecycle state machine, auto-assign, activities, site visits, deals + unit lock, SLA & hold-expiry jobs, pipeline | ✅ backend (see gaps) |
| 02–11 | Inventory, CMS, WhatsApp, HRMS, Finance, Vault, Tasks, Partners, Client Portal, Analytics | ⏳ |

CRM integrates with later modules through **ports** (`apps/api/src/integrations/ports.ts`): Inventory, WhatsApp, HRMS leave, Finance invoice-lock. They are logging stubs today; each real module just replaces its provider.

### Known CRM gaps (next increment)
- BullMQ site-visit reminders (3h/1h) — needs Redis + WhatsApp module; `reminderJobId` column is ready
- `POST /v1/leads/bulk-import` (CSV)  ·  `GET /v1/leaderboard` (reads Analytics' materialised table, Module 11)
- Rate limiting on `/auth/login` and public lead intake  ·  agent specialisation matching in auto-assign
- Admin UI / agent PWA (apps/admin, apps/web, apps/agent-pwa)

## Run locally
```bash
npm install
cp .env.example apps/api/.env
npm run db:up                         # postgres + redis
npm run db:migrate                    # creates + applies pending migrations
npm run db:seed
npm run dev:api                       # http://localhost:3000/v1/health
```
Seed logins (dev only): `admin@myroofhomes.com`, `manager@…`, `agent1@…` — password `ChangeMe123!`.

## Try it
```bash
# public intake (portal webhook / website form)
curl -X POST localhost:3000/v1/leads -H 'x-api-key: change-me-public-intake-key' -H 'content-type: application/json' \
  -d '{"name":"Rohan Mehta","phone":"+91 98765 43210","source":"PORTAL_99ACRES"}'
# staff
TOKEN=$(curl -s -X POST localhost:3000/v1/auth/login -H 'content-type: application/json' \
  -d '{"email":"manager@myroofhomes.com","password":"ChangeMe123!"}' | jq -r .data.accessToken)
curl localhost:3000/v1/pipeline -H "authorization: Bearer $TOKEN"
```

## Design rules enforced in code
- `LeadStateMachineService.transition()` is the only writer of `Lead.status`.
- Row-level scope comes from the JWT (`scopeFor`) and out-of-scope reads return **404**, not 403.
- Events are emitted only **after** the DB transaction commits.
- Money is `Decimal`; phones are stored via one `normalizePhone()`.
