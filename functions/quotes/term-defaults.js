// functions/quotes/term-defaults.js
//
// POST /quotes/term-defaults — Save a new default payment_terms /
// delivery_terms value for a given quote_type. Called by the
// "Save as default" button on the quote detail page (see the
// `flatTerms` / `plainTerms` Alpine components).
//
// Accepts JSON `{ quote_type, field, value }`. Responds with
//   { ok: true, changed: bool }  on success, or
//   { ok: false, error: "..." }  on any validation failure.

import { setQuoteTermDefault, QUOTE_TERM_FIELDS } from '../lib/quote-term-defaults.js';

// Duplicated from validators.js intentionally — avoiding a new export
// so we don't have to touch that file just to expose the set. Keep in
// sync with QUOTE_TYPES_BY_TRANSACTION there.
const ALL_QUOTE_TYPES = new Set([
  'spares',
  'eps',
  'service',
  'refurb_baseline',
  'refurb_modified',
]);

export async function onRequestPost(context) {
  const { env, request, data } = context;
  const user = data?.user;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON' }, 400);
  }

  const quoteType = typeof body?.quote_type === 'string' ? body.quote_type.trim() : '';
  const field     = typeof body?.field === 'string' ? body.field.trim() : '';
  const value     = typeof body?.value === 'string' ? body.value : '';

  if (!ALL_QUOTE_TYPES.has(quoteType)) {
    return json({ ok: false, error: `Unknown quote_type: ${quoteType}` }, 400);
  }
  if (!QUOTE_TERM_FIELDS.has(field)) {
    return json({ ok: false, error: `Unknown field: ${field}` }, 400);
  }
  // EPS payment terms are formula-driven (25/25/25/15/10 based on
  // delivery weeks) — there's no static string to save as a default.
  // The UI hides the "Save as default" button in this case, but we
  // also reject it here as a belt-and-suspenders.
  if (quoteType === 'eps' && field === 'payment_terms') {
    return json({
      ok: false,
      error: 'EPS payment terms are computed from delivery weeks — no default to save.',
    }, 400);
  }

  try {
    const { changed, previous } = await setQuoteTermDefault(env, quoteType, field, value, user);
    return json({ ok: true, changed, previous });
  } catch (err) {
    return json({ ok: false, error: err?.message || 'Save failed' }, 500);
  }
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
