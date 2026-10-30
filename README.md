# MyROOFHOMES Business Suite

Modular-monolith monorepo (NestJS + Prisma + PostgreSQL) built module-by-module from the engineering handbooks.

## Build status
| # | Module | Status |
|---|--------|--------|
| 00 | Foundations (User/Role/Consent/AuditLog, JWT + RBAC, envelope, errors) | ✅ |
| 01 | CRM — leads, dedup, lifecycle state machine, auto-assign, activities, site visits, deals + unit lock, SLA & hold-expiry jobs, pipeline | ✅ backend (UI pending) |
| 02 | Inventory & Projects — projects, units, pricing, availability lifecycle, compliance, CRM deal holds | ✅ backend (UI pending) |
| 03 | CMS & Public Website — editorial API, SEO, redirects, media metadata | ✅ API backend (public web/UI pending) |
| 04–11 | WhatsApp, HRMS, Finance, Vault, Tasks, Partners, Client Portal, Analytics | ⏳ |

CRM integrates with Inventory through `InventoryPort` (`apps/api/src/integrations/ports.ts`). The real Inventory module provides that port, so deal creation and unit holds use the same Prisma transaction. WhatsApp, HRMS leave availability, and Finance invoice-lock remain stubbed ports until those modules are implemented. Site-visit reminders are queued in BullMQ using `REDIS_URL` and sent through the WhatsApp port.

CMS and module ownership/integration sequencing are documented in [docs/module-architecture.md](docs/module-architecture.md). CMS validates project SEO overrides through `ProjectCatalogPort`, provided by Inventory; it does not copy project or unit data into CMS tables.

### CRM backend status
- CSV bulk import is limited to 5 MB / 5,000 rows, validates row-by-row through normal lead creation and returns a data-URI CSV containing failed rows.
- `/v1/leaderboard` currently calculates from CRM records; replace this query with the Analytics materialised-statistics provider when Module 11 is available.
- Login and public lead intake have per-process IP rate limits. Use a shared Redis-backed limiter before deploying multiple API replicas.
- Agent specialization matching uses `User.specialization` tags; update tags through the admin/foundations workflow.
- Channel-partner leads are recorded as referrals and their reads are row-scoped; manager offboarding can use `POST /v1/leads/reassign-agent`.
- Admin UI / agent PWA remain unimplemented; this repository currently contains the API only.

### Inventory & Projects backend status
- Project and unit endpoints support creation, listing, detail reads, updates, unit price history, and availability filtering.
- Unit holds, extensions, release, and sale are exposed to CRM through the transaction-scoped `InventoryPort`; project sold-out status is recalculated as units change.
- Inventory lifecycle operations include blocking/unblocking units, a unit heatmap, and RERA status/compliance dashboard data. A scheduled job performs compliance warning checks.
- Inventory API routes are under `/v1`: `GET/POST /projects`, `GET/PATCH /projects/:id`, `PATCH /projects/:id/status`, `GET /projects/:id/rera-status`, `GET /compliance/dashboard`, `GET/POST /units`, `GET/PATCH /units/:id`, `POST /units/:id/price`, `POST /units/:id/block`, `POST /units/:id/unblock`, and `GET /units/heatmap?project=<projectId>`.
- Admin UI remains unimplemented; Inventory is currently available through the API.

### CMS & Public Website backend status
- Blog posts and editorial pages support draft, scheduled, published, and archived states, optimistic version checks, publish-time SEO/image-alt validation, preview-token issuance, and scheduled publishing.
- Redirects support internal-path validation, loop rejection, chain flattening, and required redirect creation when a published blog slug is renamed.
- Project SEO overrides are stored separately from Inventory and validate project IDs through `ProjectCatalogPort`. CMS listeners are ready for project/unit events, but Inventory does not yet publish those events or provide stable public project slugs; project-page revalidation and delisting are not live yet.
- CMS API route groups include `/v1/blog-posts`, `/v1/pages`, `/v1/redirects`, `/v1/projects/:id/seo-override`, `/v1/sitemap-entries`, and `/v1/media` (media listing and alt-text edits only).
- The public Next.js renderer, draft-mode token verifier, `sitemap.xml`/`robots.txt` routes, S3 upload/Sharp image processing, CMS admin UI, and public website are not implemented. Web revalidation is inactive until `WEB_APP_URL` and `REVALIDATE_SECRET` are configured.

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
