# Claudia roadmap

> Claudia is **Wes Yoakum's personal AI assistant**, integrated into the
> Pipeline CRM app. She is NOT a generic company AI, NOT a per-user
> feature for everyone in the org, and NOT part of the Pipeline product
> roadmap. She lives inside Pipeline because the data she operates on
> is here, but her identity is "Wes's assistant" — single user, single
> mailbox, single calendar.
>
> Pipeline's own product roadmap (CRM features: RFQ intake workflows,
> NBA coach, per-opp chat, etc.) lives elsewhere and is a separate track.

---

## Status (current as of v0.640)

### Surfaces — where Claudia lives in Pipeline

| surface | what it does | model |
|---------|-------------|-------|
| **Chat** (`/sandbox/assistant`) | Turn-based conversation with Wes. Bounded chat region, triage queue below. | Opus 4.7 |
| **Worker (event-driven triage)** (`/api/claudia/event-tick` via consumer worker) | Per-event agentic loop. Reads enrichment, decides extract/observe/noop. Files actions into the queue. | Sonnet 4.6 |
| **Welcome-back** (`/sandbox/assistant/welcome-back`) | Proactive chat message on page load / tab return / 90s polling. Narrates background activity unprompted. | Opus 4.7 |
| **Brief regen + observations** (hourly cron `/api/cron/claudia-tick`) | Single Opus call producing the catch-me-up brief AND 0–3 observations. | Opus 4.7 |
| **Categorize** (post-doc-extract) | One-shot category label per dropped document. | Haiku 4.5 |
| **Triage queue** (Hot / Plan / Quick / Skip + Questions) | UI surface that lets Wes Approve / Done / Dismiss / Move actions. | n/a |

### Capabilities

**Reads:** full Pipeline DB (curated tools + `query_db`); key/value memory; published `.ics` calendar feeds (any number, configured under `calendar.url.<label>` keys); dropped documents (PDF / DOCX / XLSX / images via vision / audio via Whisper / .eml/.mbox / zip / TXT-MD-CSV-JSON); Gmail (when connected, read-only); audit timeline.

**Writes (audited, 72h undo):** accounts, contacts, activities, opportunities, quote drafts (shell only), jobs (bare metadata), document categories/retention, triage actions, Teams pings via `notify_wes`, Google Calendar events (create / update / delete).

**Background:** hourly cron writes observations + a fresh brief; event-driven worker triages incoming emails / Pipeline events into the action queue. No real-time polling between ticks.

**Cannot yet:** send Gmail or Outlook email; draft full quotes (shell only); fire reminders at a specific time of day.

### Shared knowledge

Lives in `functions/lib/claudia-knowledge.js`:
- `COMPANY_CONTEXT` — C-LARS company facts, key staff, products
- `INDUSTRY_TERMS` — VOO / AHC / FAT / RFQ / HPU / LARS / etc.
- `userContext(user, memoryRows)` — Wes's persisted preferences, family, calendars
- `dayContext(now)` — explicit weekday anchors (Today / Tomorrow / Next Monday / This weekend) — DST-aware

---

## Phases shipped

### Foundation (pre-session)
Anthropic client, Cloudflare AI Gateway, audit + 72h undo (`claudia-writes.js`), permission catalog (`claudia-permissions.js`), AI redaction layer.

### Phase A: event-driven backbone
- Cloudflare Queue + consumer worker
- `claudia_events_pending` event log + per-event dispatch
- `claudia-enrich.js` cross-reference enrichment
- Worker triage with read-heavy tool surface
- `claudia_actions` queue (Hot / Plan / Quick / Skip) + `claudia_questions`

### Phase B: approval flow
- Triage row Approve / Done / Dismiss / Move buttons
- Inline question answering
- Per-action audit / undo via `claudia_writes`
- Re-evaluation on subsequent events (id-match → UPDATE vs INSERT)

### Phase C: tier-1 auto-act (partial)
- `set_document_category` / `set_document_retention` / `refresh_brief` registered as auto-tier writes
- `AUTO_ALLOWED` gate in worker triage
- `fire_auto_task_chain` deferred until missed-event detector proven

### Performance + quality pass
- Tick + brief merged into one Opus call (–1 Haiku/hour)
- Categorize batched per email family (N+1 calls → 1)
- Tool-def caching on worker (cache extends to tool schemas, not just system prompt)
- Worker prompt steered to use enrichment instead of re-fetching via tools
- Chat prompt trimmed 370 → ~217 lines via redline
- Three sections condition-loaded only when relevant: Handling new uploads, Iterative review, Gmail

### Behavior + factual fixes
- **FRESH > RECALL** rule + **FACTUAL SELF-CHECK** (factual recall via tools, not from prior turns)
- Deterministic UTC offset injected in prompt (no more off-by-one timezone math)
- **DAY ANCHORS** — explicit weekday/tomorrow/Monday/weekend anchors (no more Saturday-called-Monday confusion)
- Account-troubleshooting + account-email fabrication ban (no more inventing `@maritimerobotics.com`)
- Outlook `imageNNN.png` signature noise filter
- `[YYYY-MM-DD HH:MM]` prefix leak in output blocked

### Layout + UX
- Triage moved below chat; Hot expanded only by default; Plan/Quick/Skip collapsed
- Chat region bounded to ~55-82vh with messages scrolling within (was full-height with sticky form)
- "why?" expand on triage rows (detail/rationale hidden by default)
- Observations panel slate (not yellow — stops looking like a Question)
- Welcome-back proactive narration: page load / tab return / 90s polling
- Mobile side-panel tabs (Voice / Docs / Triage / Questions)
- Mobile chat width fix

### Phase 4a: personal-side calendar awareness
- `lib/claudia-calendar.js` extracted as shared module (read .ics feeds; multi-source)
- Calendar context in welcome-back, brief, worker enrichment, chat tool
- DAY ANCHORS in all three narration surfaces

### Phase G-Cal: Google Calendar writes (parallel agent)
- `create_event` / `update_event` / `delete_event` / `list_events` tools via Google Calendar API
- Wes can now ask "schedule X with Y at 3pm" and have it land on the calendar

---

## Queued

### Phase 4b — time-bound reminder firing
**Status:** not started.
**Scope:** cron polls `remind.*` memory keys with timestamps; when the time hits, fires `notify_wes` (Teams card) or writes an observation.
**Why:** "remind me Friday 3pm to call dentist" works for SAVING today (memory write), but nothing fires at the time. This is the biggest remaining personal-side gap.
**Effort:** ~50 lines, one cron extension. Schema may need a `remind_fires_at` column on memory rows or a separate `claudia_reminders` table for indexed time queries.

### Phase 4c — personal vs work split in queue
**Status:** not started.
**Scope:** quadrant view tabbed by `source_kind` (personal / work / mixed), or a separate "Personal" lane.
**Why:** lower priority — only worth it if personal-action volume warrants. Right now it's mostly CRM.
**Effort:** UI work + a small filter in `loadActionsAndQuestions`.

### Personal context layer (pre-Phase 4d)
**Status:** lives in `family` memory key today, unstructured.
**Scope:** `PERSONAL_CONTEXT` in `claudia-knowledge.js` — wife's birthday, kids' birthdays + activities, anniversaries, recurring rituals. Available across all surfaces.
**Why:** Stacy's birthday, Silas's baseball schedule, Georgia's graduation — Claudia could be more proactive about these if they were structured.

---

## Deferred (lower priority, tracked)

- **Approve flow end-to-end test** — the Sherman/Oceaneering Hot row from morning testing. Click Approve → verify activity row lands in Pipeline → confirm `execution_audit_id` flows back into `claudia_actions`.
- **Pre-commit `node --check` hook** — backtick-in-template-literal bug bit twice this session and broke production for ~2 hours once. Cheap to add.
- **Memory hygiene tool** — `audit_memory` chat tool to list / consolidate / prune the `assistant_memory` keys.
- **Migration tracking drift** — `d1_migrations` is at 0074 but actual schema is at 0085. Wes has been running `wrangler d1 execute --file` directly. Backfill needed someday.
- **R2 orphaned blob cleanup** from earlier doc wipes.
- **AI Inbox image OCR + categorize merge** — explicitly deferred (marginal saving).
- **Medium-risk redlines on chat prompt** — VOICE bullets 4-7, ACTIONABLE LISTS as a 4th conditional. ~12 more lines if wanted.

---

## Strategic open questions

1. **Sub-agents?** We considered splitting Claudia into per-domain sub-agents (Pipeline / files / personal) but landed on a single agent + dynamic prompt sections. Worth revisiting if the unified prompt grows past ~250 lines on a typical turn.
2. **Daily morning rundown push.** Today the brief refreshes hourly and welcome-back narrates on activate. A dedicated 7 AM Teams push with the day's calendar + Hot rows could be a Phase 4 sibling. Lightweight: one cron + `notify_wes`.
3. **Chat as the only triage UI?** With welcome-back narrating everything proactively, the Hot/Plan/Quick/Skip panel might become reference-only rather than discovery. Worth watching how Wes actually uses it over a week or two.
4. **Permission catalog grows.** Each new write tool needs a row in `PERMISSION_GATED_ACTIONS_CATALOG`. The Google Calendar tools shipped recently — should be reflected in `/settings/claudia` if not already.

---

## Living document

This file is the single source of truth for "where Claudia is and what's next." It's updated on every meaningful ship-step. Pre-existing AI roadmap notes in Claude Code memory (`~/.claude/projects/.../memory/project_ai_roadmap.md`) are stale; rely on this file going forward.

**Last updated:** v0.640 — gmail-account fabrication fixes shipped.
