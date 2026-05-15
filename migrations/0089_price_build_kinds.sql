-- 0089_price_build_kinds.sql
--
-- Repurpose cost_builds.build_kind into the Price Build "kind"
-- taxonomy: new_build, buy_ship, cylinder_buy_ship, cylinder_build,
-- refurb, service (see functions/lib/validators.js PRICE_BUILD_KINDS).
--
-- The legacy values (eps_full / spares_simple / service_* /
-- wfm_reference) drove different field-sets / a WFM badge. Per the
-- product decision, every kind now renders the same default price-
-- builder layout; per-kind differences come later. Collapse every
-- legacy / unknown value to the default 'new_build'. Idempotent:
-- re-running matches 0 rows once applied.
--
-- (The column DEFAULT stays 'eps_full' — SQLite can't ALTER a column
-- default without a table rebuild — but every INSERT path now sets
-- build_kind explicitly, so the default is never used.)

UPDATE cost_builds
   SET build_kind = 'new_build',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE build_kind NOT IN (
   'new_build', 'buy_ship', 'cylinder_buy_ship',
   'cylinder_build', 'refurb', 'service'
 );
