-- Add payment_schedules JSON column to site_prefs for non-EPS quote
-- type payment schedules (spares, service, refurb_baseline, refurb_modified).
-- Mirrors the eps_schedule pattern from migration 0040.
ALTER TABLE site_prefs ADD COLUMN payment_schedules TEXT;
