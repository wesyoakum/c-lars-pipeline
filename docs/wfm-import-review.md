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

## 2. Behavior — three-way merge per field

The importer keeps a snapshot of the last WFM value it saw for every
field of every record (see §3). This turns each re-import into a
proper three-way merge: `base = snapshot`, `wfm = current WFM`,
`pipe = current Pipeline`. Per-field classification:

| Case | base | wfm | pipe | Action |
|---|---|---|---|---|
| 1 | a | a | a | SKIP — nothing moved |
| 2 | a | a | b | SKIP — Pipeline moved, WFM stable; preserve user edit |
| 3 | a | b | a | AUTO-APPLY — WFM moved, Pipeline still matches old; fast-forward |
| 4 | a | b | b | SKIP — both moved to the same value, already in sync |
| 5 | a | b | c | **CONFLICT** — both moved to different values, queue for user |
| 6 | (none) | b | (none) | INSERT — new record, no Pipeline row |
| 7 | (none) | b | b | SKIP — record exists in Pipeline but no snapshot yet (first delta after bulk pull); equality means we're already in sync |
| 8 | (none) | b | c | **CONFLICT** — exists in Pipeline but no snapshot AND values disagree; can't tell who's right, queue for user |

After every import (whether the field was applied, skipped, or
deferred to user) the snapshot is refreshed to the latest WFM
payload. That means cases 5/8 only surface as conflicts ONCE per
WFM-side change, even if Pipeline stays disagreeing.

For each WFM record:

1. Fetch the matching Pipeline row by `(external_source='wfm',
   external_id=<wfm_uuid>)` AND the corresponding snapshot from
   `wfm_import_snapshots`.
2. Classify each field per the table above.
3. Aggregate at the record level:
   - All fields SKIP → record marked **unchanged** (silent)
   - Mix of AUTO-APPLY + SKIP → **autoApply** (no user input needed,
     applied straight through but logged in the run report)
   - Any CONFLICT field → **conflict** queued for review (other
     fields shown as context but pre-decided)
   - INSERT → queued for review as a single approve-or-reject card
4. Live tables aren't written until the user clicks Commit (except
   AUTO-APPLY in case 3 — those write immediately, log to
   `claudia_writes`, and don't appear in the review queue).
5. Snapshot table is updated as part of every successful write.

## 3. Schema

Two new tables.

**`wfm_import_pending`** — the review queue. Populated on dry-run,
drained on commit:

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
  fields_diff_json    TEXT NOT NULL,           -- {field: {base, pipeline, wfm}} for the 3-way diff
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

**`wfm_import_snapshots`** — the per-field "base" for three-way
merge. Stores the last WFM payload we saw for each record so future
re-imports can detect WFM-side vs Pipeline-side changes
independently:

```sql
CREATE TABLE wfm_import_snapshots (
  entity_type     TEXT NOT NULL,               -- 'account' | 'contact' | …
  external_id     TEXT NOT NULL,               -- WFM UUID
  payload_json    TEXT NOT NULL,               -- last WFM payload, normalized
  last_seen_at    TEXT NOT NULL,               -- when this snapshot was last refreshed
  PRIMARY KEY (entity_type, external_id)
);
```

The snapshot is the canonical "what did WFM look like the last time
we saw it" — refreshed on every successful apply (and on AUTO-APPLY
case 3) but NOT on case-2 skips (since we didn't pull WFM there;
WFM didn't change, so the snapshot is already correct).

Snapshot entries are seeded by the initial bulk pull. Records
imported before this plan ships have no snapshot — case 7/8 of the
behavior table handles that gracefully.

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

1. **Schema migration** — add `wfm_import_pending` and
   `wfm_import_snapshots` tables. Backfill `wfm_import_snapshots`
   from any existing imported records (run a one-shot pull from
   WFM and seed the snapshot table with current values; future
   re-imports will work normally from there).
2. **Dry-run handler with three-way merge** — wire
   `POST /settings/wfm-import/dry-run` for one entity (start with
   `accounts`); use the existing `wfm-client.js` to fetch + the new
   normalizer + the case 1–8 classifier + insert to pending (or
   AUTO-APPLY case 3 directly).
3. **Pending list UI** — render the cards for one entity, with the
   3-way display (base / pipe / wfm side-by-side per conflicting
   field).
4. **Decide + apply** — write the decide and apply endpoints;
   commit applies the live writes AND refreshes
   `wfm_import_snapshots` per touched record.
5. **Roll out to remaining entities** — contacts, opportunities,
   quotes, jobs, invoices.
6. **Bulk actions** — "accept WFM where Pipeline empty",
   "keep all Pipeline", etc.
7. **Delta sync mode** — same code, called on a cron schedule with
   `?since=<last_run_at>` so only WFM-changed records are pulled.

## 8. Verification

Each scenario maps to one row of the §2 case table:

| Scenario | Setup | Expected |
|---|---|---|
| Idempotent re-run | Run dry-run twice in a row | First produces `N new · K conflicts`; second produces `0 · 0` (case 1 for everything) |
| WFM-side change | Edit a field in WFM → re-run | 1 AUTO-APPLY (case 3 — Pipeline still matched the snapshot, so no user input needed) |
| Pipeline-side edit | Edit a Pipeline row, no WFM change → re-run | 0 conflicts, the row is silent (case 2 — WFM matches snapshot, so we never even consider Pipeline) |
| Both sides change to same | Edit same field in both to same value → re-run | 0 conflicts (case 4) |
| Both sides change to different | Edit same field in both to DIFFERENT values → re-run | 1 conflict (case 5), card shows base/pipe/wfm |
| Pre-snapshot Pipeline match | Pre-existing Pipeline row matches WFM, no snapshot → re-run | Silent (case 7); snapshot gets seeded |
| Pre-snapshot Pipeline mismatch | Pre-existing Pipeline row disagrees with WFM, no snapshot → re-run | 1 conflict (case 8), card shows wfm and pipe (no base) |

## 9. Open questions

- Do we keep a long-term log of `applied`/`rejected` items for
  audit? Probably yes — keep them in `wfm_import_pending` with
  status, prune anything older than 90 days via cron.
- Should bulk approval require a confirmation dialog ("about to
  apply 47 changes — continue?")? Yes for >10 changes.
