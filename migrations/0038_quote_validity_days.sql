-- 0038_quote_validity_days.sql
--
-- Per-quote-type default validity window (in days). Seeded into the
-- existing `quote_term_defaults` table (migration 0024) as a new
-- `validity_days` field.
--
-- Replaces the hardcoded `(hasSpares || hasService) ? 14 : 30` logic
-- in the quote create handler. Drafts now leave `valid_until` NULL and
-- compute "today + N" live at render time; at issuance we freeze
-- `valid_until = submitted_at + N`. N is editable per quote_type from
-- the Settings page.
--
-- Seed values reproduce the previous hardcoded defaults exactly:
--   spares / service                         → 14 days
--   eps / refurb_baseline / refurb_modified /
--     refurb_supplemental                    → 30 days

INSERT OR REPLACE INTO quote_term_defaults (quote_type, field, value, updated_at) VALUES
  ('spares',              'validity_days', '14', CURRENT_TIMESTAMP),
  ('service',             'validity_days', '14', CURRENT_TIMESTAMP),
  ('eps',                 'validity_days', '30', CURRENT_TIMESTAMP),
  ('refurb_baseline',     'validity_days', '30', CURRENT_TIMESTAMP),
  ('refurb_modified',     'validity_days', '30', CURRENT_TIMESTAMP),
  ('refurb_supplemental', 'validity_days', '30', CURRENT_TIMESTAMP);
