-- Migration 0016 — Rename "Cost build" stage labels to "Price build"
--
-- The internal terminology is "price build", not "cost build".
-- This updates the user-facing stage labels in stage_definitions.

UPDATE stage_definitions SET label = 'Price build (internal)' WHERE stage_key = 'cost_build' AND label = 'Cost build (internal)';
UPDATE stage_definitions SET label = 'Price build (baseline scope)' WHERE stage_key = 'cost_build' AND label = 'Cost build (baseline scope)';
