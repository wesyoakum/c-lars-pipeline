# PMS — C-LARS Pipeline Management System

Custom opportunity/quote/job pipeline management for C-LARS. Replaces
WorkflowMax (WFM) with a system that actually understands the C-LARS
commercial sequence (Spares / EPS / Refurbishment / Service) and the
governing document hierarchy.

> **Status:** P0 in active development. See
> `C:\Users\WesYoakum\.claude\plans\mutable-dreaming-liskov.md` for the
> full P0 plan (milestones M1–M8).

## Stack

| Layer          | Tech                                                    |
| -------------- | ------------------------------------------------------- |
| Hosting        | Cloudflare Pages (project `c-lars-pms`)                 |
| Server logic   | Pages Functions (`functions/**`)                        |
| Database       | D1 (SQLite) — `c-lars-pms-db`                           |
| File storage   | R2 — `c-lars-pms-docs`                                  |
| Auth           | Cloudflare Access (Google / Microsoft SSO, `@c-lars.com`) |
| UI             | Server-rendered HTML + HTMX + Alpine.js (no build step) |
| Domain         | `pms.c-lars.com`                                        |

## Repository layout

```
PMS/
├── functions/         Cloudflare Pages Functions (server)
│   ├── _middleware.js   Access JWT decode + user upsert
│   ├── index.js         Dashboard (landing page)
│   ├── api/v1/...       JSON API (federation + WFM import)
│   ├── opportunities/   HTML pages for opportunities
│   ├── accounts/        HTML pages for accounts
│   ├── contacts/        HTML pages for contacts
│   ├── jobs/            HTML pages for jobs
│   └── lib/             Shared server helpers
├── migrations/        D1 SQL migrations (0001_initial.sql, ...)
├── public/            Static assets (CSS, vendored JS)
├── scripts/           CLI utilities (wfm-import.mjs)
├── wrangler.jsonc     Pages + D1 + R2 binding config
└── package.json
```

## Development loop

One-time setup:

```bash
npm install
```

Apply migrations to the remote D1 (first deploy only, then as new
migrations are added):

```bash
npm run migrate:remote
```

Run a local dev server against remote bindings:

```bash
npx wrangler pages dev . --remote
```

> Cloudflare Access protects `pms.c-lars.com` itself, not local dev.
> During local dev the middleware falls back to a stub "dev user" so
> you can iterate without an Access JWT.

## Deploy

`main` branch auto-deploys to Cloudflare Pages. Preview deploys land on
`*.c-lars-pms.pages.dev` behind the same Access policy.

## Cloudflare resources

| Resource      | Name              | ID / Binding                               |
| ------------- | ----------------- | ------------------------------------------ |
| D1 database   | `c-lars-pms-db`   | `50f45535-8f4d-4428-8da1-d4ce4bd24d6e` → `DB` |
| R2 bucket     | `c-lars-pms-docs` | → `DOCS`                                   |
| Pages project | `c-lars-pms`      | github.com/wesyoakum/pms (branch `main`)   |

## Governing documents (reference)

PMS enforces the commercial sequence defined by:

- **C-LARS Commercial Document Governance and Sequencing** Rev A
- **C-LARS General Terms and Conditions of Sale and Services** Rev A
- **C-LARS Limited Warranty Policy** Rev A
- **C-LARS Refurbishment SOP** Rev A
- **C-LARS Field Service Day Rate Schedule** Rev A

All four revisions are seeded into the `governing_documents` table so
quote submissions can snapshot "which rev applied at the time."
