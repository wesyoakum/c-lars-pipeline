// functions/lib/fake-names.js
//
// Server-side helpers for the admin-managed fake-names catalog
// (migration 0060). The catalog feeds wizard placeholders so the
// example text in inputs is something memorable — Bob's Burgers,
// Karen, Mississippi Development Authority — instead of the default
// "John Doe / Acme Corp" baseline.
//
// Reads are done on every page render (it's a small table, dozens
// of rows), so there's no caching to invalidate when an admin edits
// the catalog. If this ever gets large enough to matter we can pop
// it into a Cache API entry keyed by an updated_at watermark.

import { all } from './db.js';

export const FAKE_NAME_KINDS = Object.freeze([
  'account_name',
  'first_name',
  'last_name',
  'opportunity_title',
  'quote_title',
  'task_body',
  'phone',
  'email',
]);

export const FAKE_NAME_KIND_LABELS = Object.freeze({
  account_name:      'Account name',
  first_name:        'First name',
  last_name:         'Last name',
  opportunity_title: 'Opportunity title',
  quote_title:       'Quote title',
  task_body:         'Task body',
  phone:             'Phone number',
  email:             'Email address',
});

/**
 * Load every row in the catalog grouped by kind. Returns:
 *   { account_name: ['Bob''s Burgers', ...], first_name: [...], ... }
 *
 * Empty kinds are present as []. Used by layout.js to JSON-stringify
 * into window.Pipeline.fakeNames so client-side wizard configs can
 * pick from the catalog without a separate fetch.
 */
export async function loadFakeNamesByKind(env) {
  const rows = await all(env.DB,
    `SELECT kind, value FROM fake_names ORDER BY kind, value`, []);
  const out = {};
  for (const k of FAKE_NAME_KINDS) out[k] = [];
  for (const r of rows) {
    if (!r.kind || !r.value) continue;
    if (!out[r.kind]) out[r.kind] = [];
    out[r.kind].push(r.value);
  }
  return out;
}

/**
 * Pick a random value for a kind. Server-side use (e.g. seed example
 * text into a server-rendered template). Returns null when the kind
 * has no entries.
 */
export function pickFakeName(catalog, kind) {
  const arr = catalog?.[kind];
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}
