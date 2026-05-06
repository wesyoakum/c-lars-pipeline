# WFM import — per-record review & decide

**Status:** Plan, not yet built
**Last updated:** 2026-05-06
**Companion to:** `docs/wfm-migration-plan.md` (this is a refinement of
Phases 4–5 there)

## 1. Why

The current importer (and the planned delta sync in Phase 5 of the
migration plan) UPSERTs by `external_id`: WFM values overwrite Pipeline
values whenever they differ. That's safe during the initial bulk pull,
but once Pipeline has been used as a real working surface — manual
edits, contact cleanups, opportunity stage corrections — re-imports
silently revert that work.

Flavor A (dumb diff, skip-if-equal) doesn't help: it only suppresses
no-op writes. Differences still get blindly resolved in WFM's favor.

Flavor B (snapshot-based 3-way merge) auto-resolves cleanly when only
one side moved, but conflicts where both sides moved still need a
decision — and we shouldn't pick for the user.

This plan: **defer to the user on every conflict**, via a review UI
that lets him click through proposed changes per record before
anything writes. Same architecture handles the bulk pull AND the
delta sync.

## 2. Behavior

For each WFM record encountered during an import:

1. Fetch the matching Pipeline row by `(external_source='wfm',
   external_id=<wfm_uuid>)`.
2. Classify:
   - **new** — no Pipeline row → INSERT (no conflict, queue for
     approval as a single bulk item)
   - **unchanged** — all fields equal → SKIP silently (doesn't
     appear in review)
   - **conflict** — at least one field differs → queue with the
     specific field-level diff
3. Nothing writes to the live tables. All proposals land in a
   pending queue.
4. User reviews via UI, decides per record (or bulk-accepts in
   common-case categories), commits.
5. Commit applies only the approved fields, writes audit rows,
   clears the pending queue.

## 3. Schema

New table:

```sql
CREATE TABLE wfm_import_pending (
  id              TEXT PRIMARY KEY,            -- uuid
  run_id          TEXT NOT NULL,               -- groups items from one import run
  entity_type     TEXT NOT NULL,               -- 'account' | 'contact' | 'opportunity' | …
  external_id     TEXT NOT NULL,               -- WFM UUID
  action          TEXT NOT NULL                -- 'insert' | 'update'
                    CHECK (action IN ('insert','update')),
  pipeline_row_id TEXT,                        -- NULL for inserts
  wfm_payload_json    TEXT NOT NULL,           -- the WFM source as JSON
  pipeline_snapshot_json TEXT,                 -- Pipeline row as JSON (NULL for inserts)
  fields_diff_json    TEXT NOT NULL,           -- {field: {pipeline, wfm}} for the diff
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','approved','rejected','applied','superseded')),
  decided_at      TEXT,                        -- ISO 8601 when user clicked
  applied_at      TEXT,                        -- when commit ran
  decided_fields_json TEXT,                    -- {field: 'wfm'|'pipeline'} per field
  created_at      TEXT NOT NULL
);

CREATE INDEX idx_wfm_pending_status ON wfm_import_pending(status, run_id);
CREATE INDEX idx_wfm_pending_entity ON wfm_import_pending(entity_type, external_id);
```

`run_id` ties pending rows back to a `wfm_import_runs` row (existing
table per the migration plan) so we can correlate "this conflict
came from the May 6 delta sync."

`status='superseded'` covers the case where a newer import run
generates a fresh pending row for the same `(entity_type,
external_id)` while a prior one is still un-decided — the older
becomes superseded and is hidden from the UI.

## 4. Endpoints

- `POST /settings/wfm-import/dry-run` — runs the read-only pass
  against WFM for a chosen entity (or all). Populates
  `wfm_import_pending` and returns counts: `{new: N, unchanged: M,
  conflict: K}`.
- `POST /settings/wfm-import/decide` — records a per-record
  decision. Body: `{pending_id, decision: 'accept_wfm' |
  'keep_pipeline' | 'skip', fields?: {field: 'wfm'|'pipeline'}}`.
- `POST /settings/wfm-import/apply` — applies all approved
  decisions for a given `run_id`. INSERT/UPDATE the live tables,
  write `claudia_writes` audit rows, mark pending rows as `applied`.
- `GET /settings/wfm-import/pending?run_id=…` — list pending items
  for the review UI.

## 5. UI

Extends the existing review-card pattern at `/settings/wfm-import`:

- **Run controls** at the top: "Dry-run delta sync" / "Dry-run full
  pull" buttons.
- **Pending counts** banner: `12 new · 47 unchanged · 8 conflicts`.
- **Cards grouped by entity** (Accounts / Contacts / Opportunities /
  Quotes / Jobs / …). Each card:
  - Header: `Saab AB` (existing) vs `Saab` (WFM)
  - Field grid: for each diff, two columns side-by-side, radio
    button to pick one. Default to WFM but flippable.
  - Card-level buttons: `Accept all WFM`, `Keep all Pipeline`,
    `Skip this card`.
- **Bulk actions** above the cards:
  - `Accept all WFM` (everything)
  - `Keep all Pipeline` (everything)
  - `Accept WFM where Pipeline is empty` — auto-resolves the boring
    80% (Pipeline NULL or `""` for the diffed field, WFM has a
    value)
- **Commit** button at the bottom: applies the approved set, shows
  a summary, redirects to the run history.

## 6. Per-entity equality rules

Diff has to be smart enough to not flag cosmetic differences as
conflicts. Per-entity normalizers handle:

| Concern | Rule |
|---|---|
| Date format | Both sides parsed to ISO-8601 UTC before compare; ignore sub-second precision |
| NULL vs `""` | Treat as equal |
| Trailing whitespace | `String#trim()` before compare |
| Custom fields | Deep-equal on parsed JSON, not string-equal |
| Phone numbers | Strip non-digits before compare |
| Email | `toLowerCase()` before compare |
| Decimal money | Compare as numbers, not strings (`"166000.00"` == `166000`) |

Lives in `scripts/wfm/normalizers/<entity>.mjs` (one per entity) so
each can evolve independently as edge cases come up.

## 7. Rollout phases

1. **Schema migration** — add `wfm_import_pending` table.
2. **Dry-run handler** — wire `POST /settings/wfm-import/dry-run`
   for one entity (start with `accounts`); use the existing
   `wfm-client.js` to fetch + the new normalizer + insert to
   pending.
3. **Pending list UI** — render the cards for one entity.
4. **Decide + apply** — write the two endpoints; commit applies the
   live writes.
5. **Roll out to remaining entities** — contacts, opportunities,
   quotes, jobs, invoices.
6. **Bulk actions** — "accept WFM where Pipeline empty",
   "keep all Pipeline", etc.
7. **Delta sync mode** — same code, called on a cron schedule with
   `?since=<last_run_at>` so only WFM-changed records are pulled.

## 8. Verification

- After initial bulk pull and review/apply: re-run dry-run
  immediately → expect `0 new · 0 conflicts`, all unchanged.
- Edit one record in WFM → re-run → expect 1 conflict for that
  record only.
- Edit a Pipeline row (no WFM change) → re-run → expect 0
  conflicts, 1 unchanged (the diff is suppressed because we last
  saw WFM with the same value Pipeline now disagrees with — i.e.,
  Pipeline-side edits don't get flagged as conflicts unless WFM
  also moves).

## 9. Open questions

- Do we keep a long-term log of `applied`/`rejected` items for
  audit? Probably yes — keep them in `wfm_import_pending` with
  status, prune anything older than 90 days via cron.
- Should bulk approval require a confirmation dialog ("about to
  apply 47 changes — continue?")? Yes for >10 changes.
- Does delta sync auto-apply unchanged-Pipeline-side conflicts
  (i.e., WFM moved, Pipeline didn't, no actual conflict from the
  user's POV)? With snapshots, yes; without snapshots, those still
  surface as conflicts the user has to dismiss. Worth deciding
  before §6 implementation — leaning toward adding snapshots so
  the common case is auto-resolved and only true conflicts surface.
