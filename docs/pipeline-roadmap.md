# Pipeline roadmap

> Pipeline is **C-LARS's internal CRM** for managing the sales process —
> from inbound RFQ through quoting through won-deal handoff to
> engineering and production. NOT a commercial product. NOT for sale.
> Single tenant: C-LARS only. Audience: C-LARS staff (Adam, Amanda,
> Sherman, Wes, Kat) plus AI assistance via Claudia (which is Wes's
> personal layer — see [`claudia-roadmap.md`](./claudia-roadmap.md) for that track).
>
> Sandbox features (us-map, statehood, flow chart, etc.) are excluded
> from this roadmap — they're exploration, not Pipeline's sales-process
> mission.

---

## Identity

**What Pipeline is for**: tracking the lifecycle of a deal from first
contact through close to job handoff. Centralizes accounts, contacts,
opportunities, activities, quotes, and jobs in one D1-backed Cloudflare
Pages app, with audit trail + undo, automated task generation on stage
transitions, and inbound document/email ingestion.

**Who uses it**:
- **Wes Yoakum** (CCO) — primary user. Owns sales, marketing, BD.
- **Sherman Watters** (CPDO, PE) — engineering review on quotes.
- **Amanda Ingram** (COO) — operations after won, job kickoff.
- **Kat Deno** (Commercial Admin) — spares orders, OC issuance, commercial follow-through.
- **Adam Janac** (CEO) — visibility, strategic decisions.
- **Claudia (AI)** — read most things, write a permissioned subset; surfaces a personal-assistant layer for Wes specifically.

**What it's not**:
- Not a customer-facing portal
- Not multi-tenant
- Not for sale
- Not the place for sandbox / exploratory features (those have their own surfaces)

---

## Status — what's shipped (factual)

### CRM core
- **Accounts** — create / update; segment / parent_group / website / address; alias
- **Contacts** — create / update; under an account; email / phone / mobile / title / LinkedIn; primary flag
- **Opportunities** — create / update / change stage; auto-numbered (WFMxx-#####, PMSxx-#####); transaction_type (spares / eps / lars / service); estimated_value_usd, expected_close_date
- **Activities** (tasks) — create / update / complete; assigned_user_id; account_id / opportunity_id / contact_id linking
- **Quotes** — DRAFT shell creation (line items still entered manually); auto quote-number Q{opp}-{seq}; revision tracking (v1, v2, ...); change-order quotes
- **Jobs** — bare-metadata creation on closed_won opps; auto JOB-{YYYY}-{seq}; one-job-per-opp constraint
- **Documents** — drop-zone (PDF / DOCX / XLSX / images via vision / audio via Whisper / .eml/.mbox / zip / TXT-MD-CSV-JSON); per-user monotonic seq; auto-categorization on upload; retention (auto / keep_forever / trashed)

### Workflows
- **Stage transitions** — full state machine (lead → rfq_received → quote_drafted → quote_submitted → quote_under_revision → closed_won / closed_lost / closed_died); gate evaluation; terminal-stage reason capture
- **Auto-task chains** — rule engine fires tasks on natural events (stage change, quote issued, job kickoff, etc.); per-rule active flag; manual recovery via fire_auto_task_chain
- **Permission catalog** — per-write-tool toggle in `/settings/claudia` so individual mutation surfaces can be killed without code change
- **Audit + 72h undo** — `claudia_writes` records before/after snapshots for every mutation; `undo_claudia_write` reverses within 72h; stale-conflict warning when a row was edited externally between write and undo

### Inbound ingest
- **Outlook add-in** — Wes can forward / process emails into Pipeline as documents; sender / subject / email_date captured; attachments extracted as child rows; signature noise (imageNNN.png) filtered; auto-categorized; queued for Claudia worker triage
- **Email ingest via Cloudflare Email Routing** — API endpoint at `/api/email-ingest` accepts authenticated submissions
- **AI Inbox** — voice memo + text drop UI; Whisper transcription; structured extraction (people, organizations, action items, requirements, suggested destinations); contact CSV → propose_contact_imports flow

### Integrations
- **Cloudflare Queues** — `cf-claudia-events` for event-driven worker dispatch
- **Cloudflare D1** — primary database; per-user schema, indexed
- **Cloudflare R2** — document blob storage
- **Cloudflare AI Gateway** — Anthropic + OpenAI routing
- **Anthropic API** — Opus 4.7 (chat / brief / welcome-back / hourly tick), Sonnet 4.6 (worker), Haiku 4.5 (categorize / quote-line polish)
- **OpenAI API** — Whisper / gpt-4o-transcribe for audio
- **ConvertAPI** — DOCX / XLSX → text extraction
- **Gmail (read-only)** — search / read messages, threads
- **Google Calendar (write)** — create / update / delete events (just shipped via parallel agent)
- **Microsoft Teams (outbound)** — webhook-based notification cards via `notify_wes`

### UX surfaces
- Account / Contact / Opportunity / Activity / Quote / Job list + detail pages
- Inline-edit pattern (click-to-edit in place; no separate edit page)
- Pipeline (board / funnel) view
- Document drop-zone + per-file drill-down
- AI Inbox queue
- `/settings/claudia` for tool permissions
- Mobile-responsive; mobile side-panel tabs (just shipped)

---

## In-flight

### WorkflowMax → Pipeline migration
**Status**: Phase 1 (schema) shipped 2026-05-06. Phase 2 (classifier + dry-run for accounts) is the next checkpoint.
**Scope**: pull all C-LARS data out of the legacy WorkflowMax (BlueRock v2) system into Pipeline so WFM can be decommissioned. Includes a short-lived delta sync during cutover.
**Trigger to resume**: "continue the WFM import review build" per memory note.

### Mobile UX hardening
**Status**: tabbed Voice/Docs/Triage/Questions panels + chat width fix shipped today.
**Remaining**: there are likely more mobile breakpoints to cover; ad-hoc as found.

### Claudia (assistant)
**Status**: separate track — see [`claudia-roadmap.md`](./claudia-roadmap.md). She's a *layer* in Pipeline, not a Pipeline product feature, so her phases don't appear here.

---

## Queued — proposed priorities (PROPOSED, not committed)

### Full quote lifecycle
**Why**: today Claudia + the UI can create quote *shells* but full quote lifecycle (line items, issuance, OC, NTP, change orders, revisions, expiry, customer signature, conversion to job) still requires manual steps outside Pipeline or in legacy WFM.
**Scope**: line item CRUD; quote issuance (draft → submitted); revision flow (v1 → v2 → ...); OC (Order Confirmation) issuance; NTP (Notice to Proceed); change orders against active jobs; terms templates; expiry handling.
**Effort**: large. Likely the biggest single product investment Pipeline needs.
**Ordering**: gate this on WFM migration completing — mass-importing 5+ years of historical quotes into a half-built quote system is wasteful.

### Job lifecycle
**Why**: jobs currently exist as bare metadata after closed_won; no milestones, no FAT tracking, no shipping / invoicing milestones, no commercial close.
**Scope**: milestones from quote acceptance; FAT scheduling + sign-off; shipping events; invoicing tie-in (or at least invoicing-event capture); job close with retrospective.
**Effort**: medium-large. Depends on how much commercial-execution Pipeline owns vs. is outsourced (e.g. accounting still in QB?).

### Reporting / dashboards
**Why**: today most "where do we stand" answers come from Claudia's brief + ad-hoc query_db. Wes has visibility; Adam / Amanda probably want their own filtered views.
**Scope**: per-role dashboard (CCO / COO / CEO views); funnel velocity charts; quote conversion ratio; stale-opp surfacing; revenue forecast by stage × probability.
**Effort**: medium. Depends on how much of "the brief" already does this for Wes.

### Multi-user onboarding
**Why**: Pipeline has multi-user data structures, but Wes is effectively the only active user. Amanda / Sherman / Kat each have different read/write needs, different views, different notification preferences.
**Scope**: per-user dashboards; per-user notification config (Teams webhook, email, mobile); role-based default views; activity assignment workflows; "tasks assigned to me" surfacing for non-Wes users.
**Effort**: medium. Real onboarding cost is more about training + workflow design than code.

### Email notifications (external)
**Why**: today notification surface is Teams-only via `notify_wes`. Email scaffolding (Resend provider) was started but not finished.
**Scope**: finish the email provider + email templates; per-event configurable channel routing (event X → Teams + email; event Y → Teams only); customer-facing email (e.g. quote-issued notifications) — separate concern, may want a different sender domain.
**Effort**: small for internal-Wes-only; medium when you add multi-user routing + customer-facing.

---

## Deferred (lower priority, tracked)

- **Bulk import / data hygiene tools** — beyond WFM migration, ongoing tools for data cleanup (de-dupe contacts, merge accounts, fix bad email domains).
- **Audit / compliance reports** — "show me every change to opp X" / "who edited account Y" exports for regulated-customer accounts (defense / autonomy programs).
- **LARS spec library** — structured product catalog (winch model X has these specs, A-frame model Y has these specs) so quote line items can pull from a catalog instead of free-text.
- **Vessel database** — known vessels customers have referenced; track which equipment we've quoted for which vessel.
- **Customer activity history view** — full timeline of every interaction with a given account in one scrollable view.
- **Quote PDF generation** — currently quote → PDF probably lives outside Pipeline. Could be brought in.
- **Mobile app vs. responsive web** — current is responsive web. Native app is a much bigger swing if Wes / team want one.
- **Integration: accounting** — connect to QuickBooks (or whatever) so jobs → invoices → cash flow is visible in Pipeline.
- **Integration: doc gen / e-sign** — quotes → DocuSign or similar.
- **Backups / DR** — explicit backup strategy for D1 + R2 beyond Cloudflare's built-in durability. Important when Pipeline becomes the system of record after WFM is decommissioned.

---

## Strategic open questions

1. **What does "WFM is decommissioned" actually look like?** Pipeline becomes system of record for everything. Currently parallel-running. The cutover criteria — when do we declare it — drives the priority of "full quote lifecycle" (must be solid before cutover) and "reporting" (must match what WFM gives Wes today).

2. **How much commercial execution lives in Pipeline?** Spares orders go through Kat. OCs / NTPs are commercial events. If Pipeline owns end-to-end commercial workflow, the queued work is huge. If Pipeline is the *sales* CRM and commercial-execution stays in some other tool, scope is smaller. Who owns this answer? (Probably Adam + Wes.)

3. **Do non-Wes users really use Pipeline today?** Claudia's data refers to assignments to Kat / Amanda / Sherman, which suggests they at least have user records. But are they actually checking Pipeline daily? If the answer is "no, Wes pings them via Teams / email", then "multi-user onboarding" is a bigger question than UI work.

4. **Adam's view.** As CEO, what does he need from Pipeline? A read-only dashboard? Just monthly reports? Direct visibility into specific deals? This shapes the reporting roadmap.

5. **Customer-facing surfaces.** None today. Should there be — e.g. a customer-facing portal where they can see their open RFQs / quotes / jobs status? Not "for sale" doesn't preclude this; it just means it's an internal tool extended outward, not a product. Probably a Phase 6+ thing if at all.

---

## Living document

This file is the single source of truth for "where Pipeline is and what's next." Updated on every meaningful ship-step. Distinct from the AI roadmap note in Claude Code memory (stale) and from Claudia's own roadmap ([`claudia-roadmap.md`](./claudia-roadmap.md)).

**Last updated:** initial draft, v0.641 — written same day as Claudia roadmap.
