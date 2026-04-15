-- Migration 0027 — Per-quote "show discounts" toggle
--
-- Replaces the short-lived per-user show_discounts flag from 0026
-- with a per-quote one. The gear icon now lives in the quote page
-- header, so each quote can hide/show its discount UI independently
-- without affecting other quotes or other users.
--
-- The per-user users.show_discounts column from 0026 is now unused
-- but left in place (SQLite DROP COLUMN is disruptive and the stale
-- column is harmless). Reusable if a future global default is needed.
--
-- Default ON for backward compatibility — existing quotes unchanged.

ALTER TABLE quotes ADD COLUMN show_discounts INTEGER NOT NULL DEFAULT 1;
