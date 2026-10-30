# Module Architecture and Integration Plan

## Repository Layout

The system is a modular monolith: one NestJS API process, one PostgreSQL database, and domain-owned folders under `apps/api/src`. A module owns its controller, service, DTOs, listeners/jobs, and Prisma models. `auth`, `common`, `prisma`, and `integrations` are shared infrastructure, not places for domain rules.

```text
apps/api/src/
  auth/             JWT identity and permission guards
  common/           shared HTTP errors, envelopes, utilities
  prisma/           shared Prisma client only
  integrations/     ports and replaceable adapters between domains
  crm/              leads, visits, deals, CRM lifecycle
  inventory/        Project, Unit, inventory lifecycle
  cms/              editorial content, SEO, redirects, CMS events
  whatsapp/         planned: message delivery
  ...               later business domains
apps/api/prisma/
  schema.prisma     one physical schema; each module owns its model definitions
  migrations/       append-only database migrations
apps/web/            planned: public Next.js renderer and draft/revalidation routes
apps/admin/          planned: internal CMS/CRM interface
```

## Ownership and Communication

| Domain | Owns | Communicates through |
| --- | --- | --- |
| Foundations/Auth | Users, roles, permissions, audit logs, JWT | Shared guards and authenticated `AuthUser` |
| CRM | Leads, site visits, deals | `InventoryPort` for unit holds; `WhatsappPort` for notifications; emits CRM events after commits |
| Inventory | Projects, units, prices, availability | Exposes `ProjectCatalogPort` to CMS and `InventoryPort` to CRM; CMS event listeners are ready for `project.status_changed` and `unit.*` events |
| CMS | Blog posts, editorial pages, media metadata, redirects, project SEO overrides | Reads project existence via `ProjectCatalogPort`; listens to inventory events; calls the web revalidation endpoint through `RevalidationService` |
| Public web (not implemented) | HTML rendering, sitemap.xml, robots.txt, preview-cookie routes | Reads CMS public API; accepts authenticated revalidation calls; preview tokens are content-ID and path scoped |
| WhatsApp (not implemented) | Templates and message delivery | Replaces the existing `WhatsappPort` adapter |

Modules must not query another module's Prisma models or write another domain's rows. Shared-table transactions are allowed only for infrastructure concerns. Domain events are process-local today; event-producing services should emit only after persistence commits. Inventory currently has no public slug field and does not yet publish the CMS-facing events; that contract must be completed before public project-page revalidation is considered live.

## CMS Implementation Status

Implemented in this increment: BlogPost/Page persistence and API, optimistic version checks, draft/scheduled/published/archived transitions, SEO and image-alt publish gates, scoped preview-token issuance, redirects with loop detection/chain flattening, project SEO override endpoints, sitemap entries, media alt-text editing, inventory-event listeners, and optional web revalidation.

Deferred integration work: Inventory's public-slug/event producer contract, the Next.js public renderer and token verifier, S3 upload/Sharp variants, and UI screens. Project SEO writes validate IDs through the real Inventory service using `ProjectCatalogPort`. Web revalidation is a no-op with a diagnostic log until `WEB_APP_URL` and `REVALIDATE_SECRET` are configured.

## Delivery Sequence

1. Keep Foundations/Auth, CRM, and Inventory independently buildable; regenerate Prisma Client after schema migrations.
2. Complete Inventory's public project slug and publish `project.status_changed` and `unit.*` events after commits with stable `projectSlug` payloads.
3. Apply the CMS migration and API module. CMS owns editorial data and SEO overrides only; it does not create project or unit copies.
4. Add `apps/web` with public server rendering, authenticated draft-mode token verification, `/api/revalidate`, sitemap.xml, and robots.txt.
5. Add object storage and async image processing, then internal editor screens. These depend on infrastructure not present in the current repository.
6. Add integration/E2E coverage spanning inventory status changes through CMS delisting and public rendering.

## Current Repository Diagnosis

The upstream repository now contains Foundations/Auth, CRM, and Inventory; it still has no public web or admin app. Before the CMS commit, modified working-tree files had syntax damage in `app.module.ts`, `seed.ts`, and the Media/Lead boundary in `schema.prisma`, and the API typecheck failed. The CMS increment restores those boundaries, adds the CMS API, and connects project existence checks through an Inventory-owned port.