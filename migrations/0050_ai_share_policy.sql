-- =====================================================================
-- Migration 0050: AI share policy.
--
-- Per-record gate that controls whether an account or opportunity can be
-- sent to an LLM provider, and if so whether names are aliased.
--
-- Allowed values (enforced in functions/lib/ai-redact.js, not as a CHECK
-- constraint — matches the convention used by transaction_type, segment,
-- etc. elsewhere in the schema):
--   'full'   — names flow through to the model unchanged.
--   'alias'  — names replaced with accounts.alias (or a stable pseudonym
--              like 'Customer-A') before leaving Pipeline, and swapped
--              back on the way in.
--   'block'  — record is excluded from every AI feature.
--
-- The effective mode for a record-in-context is the most restrictive of
-- the related rows (block beats alias beats full). See
-- functions/lib/ai-redact.js (effectiveShareMode).
--
-- Pricing and part numbers are tokenized regardless of this flag — the
-- model never sees a real dollar figure or PN, so quote-line content is
-- safe to share even at 'full'.
-- =====================================================================

ALTER TABLE accounts        ADD COLUMN share_with_ai TEXT NOT NULL DEFAULT 'full';
ALTER TABLE opportunities   ADD COLUMN share_with_ai TEXT NOT NULL DEFAULT 'full';

-- Indexed so "exclude from this AI feature" filters stay cheap.
CREATE INDEX IF NOT EXISTS idx_accounts_share_with_ai
  ON accounts(share_with_ai)
  WHERE share_with_ai != 'full';

CREATE INDEX IF NOT EXISTS idx_opportunities_share_with_ai
  ON opportunities(share_with_ai)
  WHERE share_with_ai != 'full';
