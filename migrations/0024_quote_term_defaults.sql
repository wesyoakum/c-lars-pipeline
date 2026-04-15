-- 0024_quote_term_defaults.sql
--
-- User-editable defaults for quote payment_terms and delivery_terms
-- per quote_type. Replaces the hardcoded strings previously baked into
-- the quote create handler (functions/opportunities/[id]/quotes/index.js)
-- and the Alpine flatTerms / epsTerms components in the quote detail
-- page.
--
-- Users save a new default via the "Save as default" button next to
-- each field on a single-type quote detail page; the value is read
-- back by the create handler for new quotes of the same type, and by
-- the flatTerms / epsTerms Alpine components so the "Default X Terms"
-- checkbox always reflects the current saved default.
--
-- Seed rows reproduce the existing hardcoded defaults exactly so
-- behavior doesn't change on launch.

CREATE TABLE IF NOT EXISTS quote_term_defaults (
  quote_type  TEXT NOT NULL,
  field       TEXT NOT NULL,
  value       TEXT,
  updated_at  TEXT NOT NULL,
  updated_by  TEXT,
  PRIMARY KEY (quote_type, field)
);

INSERT OR REPLACE INTO quote_term_defaults (quote_type, field, value, updated_at) VALUES
  ('spares',              'payment_terms',
   '50% Due upon receipt of purchase order' || char(10) || '50% Due upon delivery, payable Net 15',
   CURRENT_TIMESTAMP),
  ('service',             'payment_terms',
   '50% of estimated price Due upon receipt of purchase order' || char(10) || 'Remainder Due upon completion of work, payable Net 15',
   CURRENT_TIMESTAMP),
  ('eps',                 'delivery_terms', 'EXW, C-LARS facility', CURRENT_TIMESTAMP),
  ('refurb_baseline',     'delivery_terms', 'EXW, C-LARS facility', CURRENT_TIMESTAMP),
  ('refurb_modified',     'delivery_terms', 'EXW, C-LARS facility', CURRENT_TIMESTAMP),
  ('refurb_supplemental', 'delivery_terms', 'EXW, C-LARS facility', CURRENT_TIMESTAMP);
