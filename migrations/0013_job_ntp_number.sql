-- 0013_job_ntp_number.sql
-- Add ntp_number column to jobs table for NTP-{QuoteNumber} tracking.
ALTER TABLE jobs ADD COLUMN ntp_number TEXT;
