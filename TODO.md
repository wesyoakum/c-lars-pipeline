# TODO

Running backlog of enhancements queued for later work. New items at the top.
Completed items get struck through and then pruned in later cleanup passes.

---

## Open

### UI polish / table

- **Real sticky table header.** Current workaround: non-sticky thead.
  Proper fix needs a two-table split — head `<table>` outside the
  horizontal-scroll wrapper, body `<table>` inside it, with synced
  colgroup widths and scrollLeft.
- **Table alignment polish** — center rev/status/date columns globally
  via `functions/lib/list-table.js` (column-type aware defaults).
- **/library page formatting parity** with /documents.
- **Post-it visual fixes** — aspect-ratio (never taller than wide
  except editing), square multi-page cards, star/delete button
  clipping on hover.

### Reports / wizards / settings

- **Quote wizard: title/description fields + new-opp inline create**
  — after choosing type + account, capture title/description; allow
  creating a new opp inline from the account step.

### Refurb flow — still to polish

- **"Create supplemental quote" button** on refurb opps past
  `inspection_report_submitted` — the existing `+ New quote` already
  auto-tags as supplemental via quote_kind, but a labeled button is
  nicer UX.
- **Job page visual reshape** — original ask: the job page should
  look like the OC PDF (while OC is active) and swap to the NTP
  layout once the OC is submitted. We shipped the buttons + PDF gen
  but not the visual reshape.
- **Upload the real .docx templates** for `oc-refurb-amended`,
  `inspection-report-refurb`, `ntp`. Placeholders emit fine today —
  just needs content uploaded via /settings/templates.

### Board

- **Post-it trash** — soft-delete + 5-day auto-purge cron. Partial:
  archive_at already exists via board_cards.archived_at (migration
  0031). Need: admin-only `/settings/trash`, restore + delete-forever
  buttons, daily cron to hard-delete `archived_at < now - 5d`.

---

## Done (recent)

- ✅ **Reports: "Outcome of Issued Quotes" fix** — legend + month pills
  + type selector now wired.
- ✅ **Remove "New Job" button** (v0.272) — button hidden on opp detail;
  jobs now auto-create when an OC is issued.
- ✅ **Shared post-it edits in blue** (v0.272) — direct-message
  recipients can edit shared cards. `last_edited_by_user_id` stamped
  on edit; body text renders in blue when editor != author.
  Migration 0044.
- ✅ **Delete buttons on opp / quote details** (v0.272) — opp delete
  (`functions/opportunities/[id]/delete.js`) with two-step confirm,
  blocked by any attached jobs. Quote delete already existed; the
  confirm got upgraded to two-step with line-item count.
- ✅ **Placeholder PDFs + amended OC / inspection / NTP auto-gen**
  (v0.271) — missing templates now emit a minimal PDF with centered
  "{template} Placeholder" text instead of erroring. Every issue-*
  endpoint auto-generates and auto-downloads.
- ✅ **Refurb supplemental loop** (v0.268–0.270) — quote_kind column,
  supplemental quote flow (draft→submit→accept/reject→revise all
  branch on kind), inspection report endpoint, amended OC endpoint,
  `supplemental_quote` opt-out on refurb opps + stage-picker filter.
- ✅ **Stage catalog v2** (v0.266–0.267) — unified `completed`
  terminal across all four transaction types. Migration 0041.
- ✅ **Quote → opp status coupling** (v0.264–0.265) — automatic stage
  advance on new quote, submit-task complete, accept/reject, revise.
- ✅ **Auto-gen + auto-download PDFs on quote issue / OC issue**
  (v0.265).
- ✅ **Sticky top bar + horizontal scroll proxy + back-to-top**
  (v0.260–0.263).
- ✅ **EPS schedule editor in Settings** (v0.258) — migration 0040.
- ✅ **Quote expiration lock at issuance** — migration 0037/0038.
- ✅ **Active-only filter excludes lost/dead opps** — migration 0037.
- ✅ **Settings: Users admin page**.
- ✅ **Settings: History viewer**.
