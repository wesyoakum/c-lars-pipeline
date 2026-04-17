# TODO

Running backlog of enhancements queued for later work. New items at the top.

---

## New (2026-04-17)

- **Delete buttons on opp / quote details.** Add a Delete button to the
  opportunity detail page and the quote detail page. Deletion should open
  a confirm modal that lists all child entities that will be cascaded
  (quotes, revisions, activities, attachments, audit trail, etc.) and
  requires explicit confirmation.
- **Remove "New Job" button for now.** Hide the "New Job" action from
  wherever it currently surfaces — feature paused.
- **Shared post-it edits in blue.** When a post-it card is shared with
  another user, that user should be able to edit the card. Their edits
  render in blue so the original author can tell what was changed.
- **Sticky table header (real).** Current workaround: non-sticky thead.
  Proper fix needs a two-table split — head `<table>` outside the
  horizontal-scroll wrapper, body `<table>` inside it, with synced
  colgroup widths and scrollLeft.
- **Quote → opp status coupling.** When a quote draft is saved, opp
  status → `quote_drafted`. When quote is issued, create auto-task
  prompting submission; when that task completes, opp →
  `quote_submitted`. Revision flow: revising → `quote_under_revision`;
  issued revision creates submission task; task complete →
  `revised_quote_submitted`. Accepted → `won`. Rejected → `lost`.

---

## Earlier plan batches (see `.claude/plans/enumerated-sprouting-lagoon.md`)

Pre-existing grab-bag covered in the planning doc:

1. Table alignment polish (center rev/status/date columns)
2. Library page formatting parity with /documents
3. Post-it visual fixes (aspect-ratio, clipping)
4. Reports: fix "Outcome of Issued Quotes" (legend + filters)
5. Quote wizard: title/description fields + new-opp inline create
6. Quote expiration: days-from-now → lock at issuance (DONE — migration
   0037)
7. Active-only filter excludes lost/dead opps (DONE — migration 0037)
8. Settings: Users admin page (DONE)
9. Settings: History viewer (DONE)
10. Post-it trash (soft delete + 5-day cron)
