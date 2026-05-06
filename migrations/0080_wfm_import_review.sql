-- migrations/0080_wfm_import_review.sql
--
-- Foundation tables for the per-record WFM import review-and-decide
-- flow described in docs/wfm-import-review.md. Phase 1 of that
-- rollout. No backfill — pre-existing imported rows pass through the
-- "no snapshot yet" branches (cases 7/8) of §2 until they accumulate
-- snapshot rows on first re-import.

-- The review queue. Populated by dry-run, drained by apply.
CREATE TABLE IF NOT EXISTS wfm_import_pending (
  id                      TEXT PRIMARY KEY,             -- uuid
  run_id                  TEXT NOT NULL,                -- groups items from one import run
  entity_type             TEXT NOT NULL,                -- 'account' | 'contact' | 'opportunity' | 'quote' | 'job'
  external_id             TEXT NOT NULL,                -- WFM UUID
  action                  TEXT NOT NULL                 -- 'insert' | 'update'
                            CHECK (action IN ('insert','update')),
  pipeline_row_id         TEXT,                         -- NULL for inserts
  wfm_payload_json        TEXT NOT NULL,                -- the WFM source as JSON
  pipeline_snapshot_json  TEXT,                         -- Pipeline row at dry-run time, JSON (NULL for inserts)
  fields_diff_json        TEXT NOT NULL,                -- {field: {base, pipeline, wfm}} per case 5/8 conflict
  status                  TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','approved','rejected','applied','superseded')),
  decided_at              TEXT,                         -- ISO 8601 when user clicked
  applied_at              TEXT,                         -- when commit ran
  decided_fields_json     TEXT,                         -- {field: 'wfm'|'pipeline'} per field user picked
  created_at              TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wfm_pending_status
  ON wfm_import_pending(status, run_id);
CREATE INDEX IF NOT EXISTS idx_wfm_pending_entity
  ON wfm_import_pending(entity_type, external_id);

-- The per-field "base" for the three-way merge. Stores the last WFM
-- payload we saw for each record so future re-imports can detect
-- WFM-side vs Pipeline-side changes independently. Refreshed on
-- every successful apply (and on case-3 auto-applies); NOT
-- refreshed on case-2 skips (since WFM didn't change there).
CREATE TABLE IF NOT EXISTS wfm_import_snapshots (
  entity_type    TEXT NOT NULL,            -- 'account' | 'contact' | …
  external_id    TEXT NOT NULL,            -- WFM UUID
  payload_json   TEXT NOT NULL,            -- last WFM payload, normalized
  last_seen_at   TEXT NOT NULL,            -- when this snapshot was last refreshed
  PRIMARY KEY (entity_type, external_id)
);
