-- =====================================================================
-- C-LARS Pipeline Management System (Pipeline)
-- Migration 0001 — initial schema
--
-- All tables from the P0 plan §2 are created in this single migration so
-- there is one consistent "M1 starting point". Ordering follows the
-- dependency graph (users first, then accounts/contacts, then the
-- opportunity spine, then everything that hangs off an opportunity).
--
-- Conventions:
--   * Primary keys are TEXT UUIDs (crypto.randomUUID()).
--   * Timestamps are TEXT ISO-8601 UTC. datetime('now') in SQLite returns
--     'YYYY-MM-DD HH:MM:SS' which is sortable but we prefer strftime to
--     guarantee explicit UTC; defaults use strftime('%Y-%m-%dT%H:%M:%fZ','now').
--   * All mutations should also write an audit_events row via lib/audit.js.
-- =====================================================================


-- ---------------------------------------------------------------------
-- Identity & org
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  display_name  TEXT,
  role          TEXT NOT NULL DEFAULT 'sales',  -- 'admin' | 'sales' | 'viewer' | 'service'
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);


CREATE TABLE IF NOT EXISTS accounts (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  segment             TEXT,              -- 'WROV' | 'Research' | 'Defense' | 'Commercial' | 'Other'
  address_billing     TEXT,
  address_physical    TEXT,
  phone               TEXT,
  website             TEXT,
  notes               TEXT,
  owner_user_id       TEXT REFERENCES users(id),
  -- Federation / import idempotence (see plan §4.3)
  external_source     TEXT,              -- 'wfm' | null
  external_id         TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by_user_id  TEXT REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_accounts_name ON accounts(name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_ext
  ON accounts(external_source, external_id)
  WHERE external_id IS NOT NULL;


CREATE TABLE IF NOT EXISTS contacts (
  id                  TEXT PRIMARY KEY,
  account_id          TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  first_name          TEXT,
  last_name           TEXT,
  title               TEXT,
  email               TEXT,
  phone               TEXT,
  mobile              TEXT,
  is_primary          INTEGER NOT NULL DEFAULT 0,
  notes               TEXT,
  external_source     TEXT,
  external_id         TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by_user_id  TEXT REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_contacts_account ON contacts(account_id);
CREATE INDEX IF NOT EXISTS idx_contacts_email   ON contacts(email);
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_ext
  ON contacts(external_source, external_id)
  WHERE external_id IS NOT NULL;


-- ---------------------------------------------------------------------
-- Stage catalog (data-driven — editable without code changes)
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS stage_definitions (
  transaction_type     TEXT NOT NULL,          -- 'spares' | 'eps' | 'refurb' | 'service'
  stage_key            TEXT NOT NULL,
  label                TEXT NOT NULL,
  sort_order           INTEGER NOT NULL,
  default_probability  INTEGER,
  is_terminal          INTEGER NOT NULL DEFAULT 0,
  is_won               INTEGER NOT NULL DEFAULT 0,
  gate_rules_json      TEXT,                   -- JSON array of { check, severity }
  PRIMARY KEY (transaction_type, stage_key)
);


-- ---------------------------------------------------------------------
-- Opportunities (the spine)
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS opportunities (
  id                    TEXT PRIMARY KEY,
  number                TEXT NOT NULL UNIQUE,   -- 'OPP-2026-0001'
  account_id            TEXT NOT NULL REFERENCES accounts(id),
  primary_contact_id    TEXT REFERENCES contacts(id),
  title                 TEXT NOT NULL,
  description           TEXT,
  transaction_type      TEXT NOT NULL,          -- 'spares' | 'eps' | 'refurb' | 'service'
  stage                 TEXT NOT NULL,          -- FK (transaction_type, stage) → stage_definitions
  stage_entered_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  probability           INTEGER,                -- 0..100 (defaulted from stage)
  estimated_value_usd   REAL,
  currency              TEXT NOT NULL DEFAULT 'USD',
  expected_close_date   TEXT,
  actual_close_date     TEXT,

  -- How the deal came in
  source                TEXT,                   -- 'inbound' | 'outreach' | 'referral' | 'existing' | 'other'
  rfq_format            TEXT,                   -- 'verbal' | 'text' | 'email_informal' |
                                                -- 'email_formal' | 'formal_document' |
                                                -- 'government_rfq' | 'rfi_preliminary' |
                                                -- 'none' | 'other'

  -- BANT-lite qualification
  bant_budget           TEXT,                   -- 'known' | 'estimated' | 'unknown'
  bant_authority        TEXT,
  bant_need             TEXT,
  bant_timeline         TEXT,

  -- Close
  close_reason          TEXT,                   -- 'won' | 'lost' | 'abandoned'
  loss_reason_tag       TEXT,

  -- Ownership
  owner_user_id         TEXT REFERENCES users(id),
  salesperson_user_id   TEXT REFERENCES users(id),

  -- Federation / import idempotence
  external_source       TEXT,
  external_id           TEXT,

  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by_user_id    TEXT REFERENCES users(id),

  FOREIGN KEY (transaction_type, stage) REFERENCES stage_definitions(transaction_type, stage_key)
);
CREATE INDEX IF NOT EXISTS idx_opportunities_account    ON opportunities(account_id);
CREATE INDEX IF NOT EXISTS idx_opportunities_stage      ON opportunities(transaction_type, stage);
CREATE INDEX IF NOT EXISTS idx_opportunities_owner      ON opportunities(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_opportunities_updated    ON opportunities(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_opportunities_rfq_format ON opportunities(rfq_format);
CREATE UNIQUE INDEX IF NOT EXISTS idx_opportunities_ext
  ON opportunities(external_source, external_id)
  WHERE external_id IS NOT NULL;


-- ---------------------------------------------------------------------
-- Cost builds (internal pricing discipline — flexible top-down & bottom-up)
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS cost_builds (
  id                  TEXT PRIMARY KEY,
  opportunity_id      TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  label               TEXT,                     -- 'Initial estimate' | 'Post-inspection' | ...
  status              TEXT NOT NULL DEFAULT 'draft',  -- 'draft' | 'locked'
  pricing_method      TEXT,                     -- 'bottom_up' | 'top_down' | 'mixed' | null

  -- Cost side: either computed from lines or manually entered
  total_cost          REAL NOT NULL DEFAULT 0,
  total_cost_source   TEXT NOT NULL DEFAULT 'lines', -- 'lines' | 'manual'

  -- Price side: independently editable; UI recomputes the other as a hint
  target_price        REAL,
  target_margin_pct   REAL,

  confidence_overall  TEXT,                     -- 'low' | 'medium' | 'high'
  notes               TEXT,

  locked_at           TEXT,
  locked_by_user_id   TEXT REFERENCES users(id),
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by_user_id  TEXT REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_cost_builds_opp ON cost_builds(opportunity_id);


CREATE TABLE IF NOT EXISTS cost_lines (
  id                    TEXT PRIMARY KEY,
  cost_build_id         TEXT NOT NULL REFERENCES cost_builds(id) ON DELETE CASCADE,
  sort_order            INTEGER NOT NULL DEFAULT 0,
  category              TEXT NOT NULL,          -- 'material' | 'labor' | 'subcontract' | 'services' | 'shipping' | 'other'
  description           TEXT NOT NULL,
  quantity              REAL NOT NULL DEFAULT 1,
  unit                  TEXT,                   -- 'ea' | 'hr' | 'lot' | ...
  unit_cost             REAL NOT NULL DEFAULT 0,
  extended_cost         REAL NOT NULL DEFAULT 0, -- qty * unit_cost (server-computed)
  supplier              TEXT,
  notes                 TEXT,

  -- Schema-ready flexibility fields (UI-optional in P0)
  confidence            TEXT,                   -- 'low' | 'medium' | 'high'
  is_long_lead          INTEGER NOT NULL DEFAULT 0,
  is_vendor_dependent   INTEGER NOT NULL DEFAULT 0,

  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_cost_lines_build ON cost_lines(cost_build_id, sort_order);


-- ---------------------------------------------------------------------
-- Quotes (customer-facing) with governance revision snapshots
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS quotes (
  id                      TEXT PRIMARY KEY,
  number                  TEXT NOT NULL UNIQUE, -- 'Q-2026-0001'
  opportunity_id          TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  revision                TEXT NOT NULL DEFAULT 'A',
  quote_type              TEXT NOT NULL,
    -- 'spares' | 'eps' | 'refurb_baseline' | 'refurb_modified'
    -- | 'refurb_supplemental' | 'service'
  status                  TEXT NOT NULL DEFAULT 'draft',
    -- 'draft' | 'internal_review' | 'approved_internal' | 'submitted'
    -- | 'accepted' | 'rejected' | 'superseded' | 'expired'

  title                   TEXT,
  description             TEXT,
  valid_until             TEXT,
  currency                TEXT NOT NULL DEFAULT 'USD',
  subtotal_price          REAL NOT NULL DEFAULT 0,
  tax_amount              REAL NOT NULL DEFAULT 0,
  total_price             REAL NOT NULL DEFAULT 0,

  incoterms               TEXT DEFAULT 'EXW',
  payment_terms           TEXT,
  delivery_terms          TEXT,
  delivery_estimate       TEXT,                 -- free text, e.g. '14-16 weeks ARO'

  -- Governance snapshots captured at submission time
  tc_revision             TEXT,
  warranty_revision       TEXT,
  rate_schedule_revision  TEXT,
  sop_revision            TEXT,

  supersedes_quote_id     TEXT REFERENCES quotes(id),
  cost_build_id           TEXT REFERENCES cost_builds(id),

  submitted_at            TEXT,
  submitted_by_user_id    TEXT REFERENCES users(id),
  notes_internal          TEXT,
  notes_customer          TEXT,

  external_source         TEXT,
  external_id             TEXT,

  created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by_user_id      TEXT REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_quotes_opp    ON quotes(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_quotes_status ON quotes(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_quotes_ext
  ON quotes(external_source, external_id)
  WHERE external_id IS NOT NULL;


CREATE TABLE IF NOT EXISTS quote_lines (
  id              TEXT PRIMARY KEY,
  quote_id        TEXT NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  item_type       TEXT NOT NULL DEFAULT 'misc', -- 'product' | 'service' | 'labor' | 'misc'
  description     TEXT NOT NULL,
  quantity        REAL NOT NULL DEFAULT 1,
  unit            TEXT,
  unit_price      REAL NOT NULL DEFAULT 0,
  extended_price  REAL NOT NULL DEFAULT 0,
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_quote_lines_quote ON quote_lines(quote_id, sort_order);


-- ---------------------------------------------------------------------
-- Jobs (commercial hand-off record only — execution lives elsewhere)
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS jobs (
  id                          TEXT PRIMARY KEY,
  number                      TEXT NOT NULL UNIQUE, -- 'JOB-2026-0001'
  opportunity_id              TEXT NOT NULL REFERENCES opportunities(id),
  job_type                    TEXT NOT NULL,        -- mirrors opportunities.transaction_type
  status                      TEXT NOT NULL DEFAULT 'created',
    -- 'created' | 'awaiting_authorization' | 'awaiting_ntp' | 'handed_off' | 'cancelled'
  title                       TEXT,

  -- Customer PO
  customer_po_number          TEXT,
  customer_po_received_at     TEXT,

  -- Order Confirmation (all transaction types)
  oc_number                   TEXT,
  oc_issued_at                TEXT,
  oc_revision                 INTEGER NOT NULL DEFAULT 1,
  oc_issued_by_user_id        TEXT REFERENCES users(id),

  -- Notice to Proceed (EPS only)
  ntp_required                INTEGER NOT NULL DEFAULT 0,
  ntp_issued_at               TEXT,
  ntp_issued_by_user_id       TEXT REFERENCES users(id),

  -- Customer Authorization to Proceed (EPS only; per governance doc §6.1)
  authorization_received_at   TEXT,
  authorization_notes         TEXT,

  -- Optional executive concurrence (informal per governance doc §6.2)
  ceo_concurrence_at          TEXT,
  ceo_concurrence_by          TEXT,
  cfo_concurrence_at          TEXT,
  cfo_concurrence_by          TEXT,

  -- External hand-off pointer
  external_pm_system          TEXT,                 -- 'Monday' | 'Smartsheet' | etc
  external_pm_system_ref      TEXT,                 -- URL or ID in that system
  handed_off_at               TEXT,
  handed_off_by_user_id       TEXT REFERENCES users(id),
  handed_off_notes            TEXT,

  notes                       TEXT,
  created_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by_user_id          TEXT REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_jobs_opp    ON jobs(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);


-- ---------------------------------------------------------------------
-- Activities (tasks, notes, calls, meetings, emails)
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS activities (
  id                  TEXT PRIMARY KEY,
  opportunity_id      TEXT REFERENCES opportunities(id) ON DELETE CASCADE,
  account_id          TEXT REFERENCES accounts(id)      ON DELETE CASCADE,
  job_id              TEXT REFERENCES jobs(id)          ON DELETE CASCADE,
  quote_id            TEXT REFERENCES quotes(id)        ON DELETE CASCADE,
  type                TEXT NOT NULL,                    -- 'email' | 'call' | 'meeting' | 'task' | 'note'
  subject             TEXT,
  body                TEXT,
  direction           TEXT,                             -- 'inbound' | 'outbound' | null
  status              TEXT,                             -- 'pending' | 'completed' | 'cancelled' (tasks only)
  due_at              TEXT,
  completed_at        TEXT,
  assigned_user_id    TEXT REFERENCES users(id),
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by_user_id  TEXT REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_activities_opp        ON activities(opportunity_id, due_at);
CREATE INDEX IF NOT EXISTS idx_activities_open_tasks ON activities(status, due_at) WHERE status = 'pending';


-- ---------------------------------------------------------------------
-- Documents (files in R2, metadata in D1)
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS documents (
  id                    TEXT PRIMARY KEY,
  opportunity_id        TEXT REFERENCES opportunities(id) ON DELETE CASCADE,
  quote_id              TEXT REFERENCES quotes(id)        ON DELETE CASCADE,
  job_id                TEXT REFERENCES jobs(id)          ON DELETE CASCADE,
  account_id            TEXT REFERENCES accounts(id)      ON DELETE CASCADE,
  kind                  TEXT NOT NULL,
    -- 'rfq' | 'rfi' | 'quote_pdf' | 'po' | 'oc_pdf' | 'ntp_pdf'
    -- | 'drawing' | 'specification' | 'supplier_quote' | 'other'
  title                 TEXT NOT NULL,
  r2_key                TEXT NOT NULL UNIQUE,   -- 'opp/<opp_id>/<uuid>-<safe_name>'
  mime_type             TEXT,
  size_bytes            INTEGER,
  notes                 TEXT,
  uploaded_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  uploaded_by_user_id   TEXT REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_documents_opp   ON documents(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_documents_quote ON documents(quote_id);


-- ---------------------------------------------------------------------
-- External artifacts (federation hub — analyzer/calculators/docs apps)
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS external_artifacts (
  id                  TEXT PRIMARY KEY,
  opportunity_id      TEXT REFERENCES opportunities(id) ON DELETE CASCADE,
  quote_id            TEXT REFERENCES quotes(id)        ON DELETE CASCADE,
  job_id              TEXT REFERENCES jobs(id)          ON DELETE CASCADE,
  source_app          TEXT NOT NULL,            -- 'calculators' | 'analyzer' | 'commercial_docs' | ...
  external_id         TEXT,
  kind                TEXT,                     -- 'calc_result' | 'winch_analysis' | 'generated_doc' | ...
  title               TEXT,
  url                 TEXT,                     -- deep link back to source app
  summary             TEXT,
  payload_json        TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by_user_id  TEXT REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_external_artifacts_opp ON external_artifacts(opportunity_id);


-- ---------------------------------------------------------------------
-- Governance documents (mirror of the C-LARS Document Control Register)
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS governing_documents (
  id              TEXT PRIMARY KEY,
  doc_key         TEXT NOT NULL,      -- 'terms' | 'warranty' | 'refurb_sop' | 'rate_schedule'
  revision        TEXT NOT NULL,      -- 'A' | 'B' | ...
  effective_date  TEXT NOT NULL,
  title           TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'superseded'
  r2_key          TEXT,
  notes           TEXT,
  UNIQUE(doc_key, revision)
);


-- ---------------------------------------------------------------------
-- Sequences (human-readable numbering counters)
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sequences (
  scope       TEXT PRIMARY KEY,       -- 'OPP-2026' | 'Q-2026' | 'JOB-2026'
  next_value  INTEGER NOT NULL DEFAULT 1
);


-- ---------------------------------------------------------------------
-- Audit events (who did what, when — single source of truth for history)
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS audit_events (
  id                TEXT PRIMARY KEY,
  entity_type       TEXT NOT NULL,
    -- 'opportunity' | 'quote' | 'cost_build' | 'cost_line' | 'quote_line'
    -- | 'job' | 'account' | 'contact' | 'document' | 'activity' | 'external_artifact'
  entity_id         TEXT NOT NULL,
  event_type        TEXT NOT NULL,
    -- generic:      'created' | 'updated' | 'deleted'
    -- opportunity:  'stage_changed' | 'owner_changed'
    -- quote:        'submitted' | 'revised' | 'accepted' | 'rejected' | 'superseded' | 'expired'
    -- cost_build:   'locked' | 'unlocked'
    -- job:          'oc_issued' | 'ntp_issued' | 'authorization_received'
    --             | 'amended_oc_issued' | 'handed_off' | 'cancelled'
    -- document:     'uploaded' | 'downloaded' | 'deleted'
  user_id           TEXT REFERENCES users(id),
  at                TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  summary           TEXT,
  changes_json      TEXT,            -- JSON: { field: { from, to }, ... } for updates
  override_reason   TEXT             -- non-null iff a soft gate was overridden
);
CREATE INDEX IF NOT EXISTS idx_audit_events_entity  ON audit_events(entity_type, entity_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_user    ON audit_events(user_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_type_at ON audit_events(event_type, at DESC);
