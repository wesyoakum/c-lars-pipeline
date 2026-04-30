-- 0060_fake_names_catalog.sql
--
-- Admin-managed catalog of placeholder names used in wizard prompts
-- and example text. Wes wants something more memorable than "John
-- Doe / Acme Corp" — Bob's Burgers / Karen / Mississippi Development
-- Authority etc. set the tone.
--
-- One row per (kind, value). The wizard engine picks a random value
-- per render so opening the same wizard twice may show different
-- examples. Admin page at /settings/fake-names lets non-engineers
-- add / remove without a deploy.

CREATE TABLE IF NOT EXISTS fake_names (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,        -- 'account_name' | 'first_name' | 'last_name' |
                                       -- 'opportunity_title' | 'quote_title' |
                                       -- 'task_body' | 'phone' | 'email'
  value         TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_by_user_id TEXT REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_fake_names_kind ON fake_names(kind);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fake_names_kind_value
  ON fake_names(kind, value);

-- Seed data. Each row is (kind, value); the id is hex(randomblob(16))
-- because D1 doesn't have a portable UUID generator and we don't need
-- one — these IDs are private and never round-trip through the user.

INSERT INTO fake_names (id, kind, value) VALUES
  -- Account names — playful, plausibly-real fictional businesses
  (lower(hex(randomblob(16))), 'account_name', 'Bob''s Burgers'),
  (lower(hex(randomblob(16))), 'account_name', 'Pawnee Parks Department'),
  (lower(hex(randomblob(16))), 'account_name', 'Dunder Mifflin Paper Co.'),
  (lower(hex(randomblob(16))), 'account_name', 'Initech Software'),
  (lower(hex(randomblob(16))), 'account_name', 'Mississippi Development Authority'),
  (lower(hex(randomblob(16))), 'account_name', 'Atlantic Marine Engineering'),
  (lower(hex(randomblob(16))), 'account_name', 'Northstar Subsea'),
  (lower(hex(randomblob(16))), 'account_name', 'Acme Hydraulics'),
  (lower(hex(randomblob(16))), 'account_name', 'Cyberdyne Systems'),

  -- First names
  (lower(hex(randomblob(16))), 'first_name', 'Bob'),
  (lower(hex(randomblob(16))), 'first_name', 'Karen'),
  (lower(hex(randomblob(16))), 'first_name', 'Wes'),
  (lower(hex(randomblob(16))), 'first_name', 'Linda'),
  (lower(hex(randomblob(16))), 'first_name', 'Tina'),
  (lower(hex(randomblob(16))), 'first_name', 'Leslie'),
  (lower(hex(randomblob(16))), 'first_name', 'Ron'),
  (lower(hex(randomblob(16))), 'first_name', 'April'),

  -- Last names
  (lower(hex(randomblob(16))), 'last_name', 'Belcher'),
  (lower(hex(randomblob(16))), 'last_name', 'Knope'),
  (lower(hex(randomblob(16))), 'last_name', 'Swanson'),
  (lower(hex(randomblob(16))), 'last_name', 'Ludgate'),
  (lower(hex(randomblob(16))), 'last_name', 'Yoakum'),
  (lower(hex(randomblob(16))), 'last_name', 'Smith'),
  (lower(hex(randomblob(16))), 'last_name', 'Wyatt'),

  -- Opportunity titles — shaped like the kinds of things C-LARS quotes on
  (lower(hex(randomblob(16))), 'opportunity_title', 'Spare seals for pump station'),
  (lower(hex(randomblob(16))), 'opportunity_title', 'Refurb of legacy hydraulic winch'),
  (lower(hex(randomblob(16))), 'opportunity_title', 'EPS proposal for IWOCS LARS'),
  (lower(hex(randomblob(16))), 'opportunity_title', 'Annual service contract'),
  (lower(hex(randomblob(16))), 'opportunity_title', 'Replacement A-frame for VOO'),

  -- Quote titles
  (lower(hex(randomblob(16))), 'quote_title', 'Spares quote on pump skid'),
  (lower(hex(randomblob(16))), 'quote_title', 'Refurb baseline + modifications'),
  (lower(hex(randomblob(16))), 'quote_title', 'EPS LARS package — budgetary'),
  (lower(hex(randomblob(16))), 'quote_title', 'Service mobilization'),

  -- Task bodies
  (lower(hex(randomblob(16))), 'task_body', 'Call Bob about the seal kit'),
  (lower(hex(randomblob(16))), 'task_body', 'Send Karen the updated quote'),
  (lower(hex(randomblob(16))), 'task_body', 'Follow up on RFQ #1234'),
  (lower(hex(randomblob(16))), 'task_body', 'Confirm delivery date with the yard'),

  -- Phone (US-style 555 numbers — never real)
  (lower(hex(randomblob(16))), 'phone', '(555) 010-1234'),
  (lower(hex(randomblob(16))), 'phone', '(555) 010-5678'),

  -- Emails — example.com is reserved for documentation, never deliverable
  (lower(hex(randomblob(16))), 'email', 'bob@bobsburgers.example.com'),
  (lower(hex(randomblob(16))), 'email', 'karen@pawnee-gov.example.com'),
  (lower(hex(randomblob(16))), 'email', 'leslie@pawnee-gov.example.com');
