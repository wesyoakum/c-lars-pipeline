// functions/lib/quote-term-defaults.js
//
// User-editable defaults for quote payment_terms and delivery_terms,
// keyed by (quote_type, field). Rows live in the `quote_term_defaults`
// table (migration 0024). Users save a new default via the
// "Save as default" button next to each field on the quote detail page;
// the create handler seeds new quotes from the same values and the
// flatTerms / epsTerms Alpine components read the saved string back to
// drive their "Default X Terms" checkbox.
//
// Fields are a fixed set — 'payment_terms' and 'delivery_terms'.
// Quote types are the same enum as validators.ALL_QUOTE_TYPES.
// Unknown (type, field) pairs just return `fallback` / nothing; the
// helper never throws on a missing row.
//
// NOTE: EPS payment terms are intentionally NOT saved here. The EPS
// payment schedule is computed client-side from the delivery-weeks value
// (25% / 25% / 25% / 15% / 10% on a sliding w/3, 2w/3 schedule), so there
// is no static string to save as a default. The "Save as default" button
// is hidden on EPS quotes for payment_terms.

import { one, all, stmt, batch } from './db.js';
import { auditStmt } from './audit.js';

/** Fields that support per-quote-type defaults. */
export const QUOTE_TERM_FIELDS = new Set(['payment_terms', 'delivery_terms']);

/**
 * Load a single default by (quote_type, field). Returns the raw string
 * value (or `fallback` when no row exists).
 */
export async function getQuoteTermDefault(env, quoteType, field, fallback = '') {
  if (!quoteType || !QUOTE_TERM_FIELDS.has(field)) return fallback;
  const row = await one(
    env.DB,
    'SELECT value FROM quote_term_defaults WHERE quote_type = ? AND field = ?',
    [quoteType, field]
  );
  const val = row?.value;
  return (val == null || val === '') ? fallback : val;
}

/**
 * Load every saved default into a nested map:
 *   { [quoteType]: { payment_terms: '...', delivery_terms: '...' } }
 *
 * Used by the quote detail page — it serializes the map into JS so
 * Alpine can consult any (type, field) without a round-trip, and also
 * uses it on the server to pre-populate the initial textareas for
 * hybrid quotes that fall through to the plain branch.
 */
export async function loadQuoteTermDefaultsMap(env) {
  const rows = await all(
    env.DB,
    'SELECT quote_type, field, value FROM quote_term_defaults'
  );
  const map = {};
  for (const r of rows) {
    if (!map[r.quote_type]) map[r.quote_type] = {};
    map[r.quote_type][r.field] = r.value ?? '';
  }
  return map;
}

/**
 * Upsert a default. Writes an audit event on any real change (no-op
 * when the submitted value matches what's already stored). Returns
 * `{ changed: bool, previous: string }` so the caller can report
 * whether the click actually saved anything.
 */
export async function setQuoteTermDefault(env, quoteType, field, value, user) {
  if (!quoteType || !QUOTE_TERM_FIELDS.has(field)) {
    throw new Error(`Invalid quote_type or field: ${quoteType} / ${field}`);
  }
  const clean = (value ?? '').toString();

  const existing = await one(
    env.DB,
    'SELECT value FROM quote_term_defaults WHERE quote_type = ? AND field = ?',
    [quoteType, field]
  );
  const previous = existing?.value ?? '';
  if (existing && previous === clean) {
    return { changed: false, previous };
  }

  await batch(env.DB, [
    stmt(
      env.DB,
      `INSERT INTO quote_term_defaults (quote_type, field, value, updated_at, updated_by)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?)
       ON CONFLICT (quote_type, field) DO UPDATE SET
         value      = excluded.value,
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`,
      [quoteType, field, clean, user?.id ?? null]
    ),
    auditStmt(env.DB, {
      entityType: 'quote_term_default',
      entityId: `${quoteType}:${field}`,
      eventType: existing ? 'updated' : 'created',
      user,
      summary: `${existing ? 'Updated' : 'Set'} default ${field} for ${quoteType}`,
      changes: { value: { from: previous, to: clean } },
    }),
  ]);

  return { changed: true, previous };
}
