// functions/settings/patch.js
//
// POST /settings/patch — inline save for per-user preferences.
//
// Request body (JSON):
//   { field: 'show_discounts', value: 0 | 1 }
//
// Fields are whitelisted against PATCHABLE. Boolean-style flags are
// stored as INTEGER 0/1 to match SQLite conventions used elsewhere.
// Auditing is intentionally skipped — these are per-user UI prefs,
// not business data, so they don't belong in the audit log.

import { stmt, batch } from '../lib/db.js';
import { now } from '../lib/ids.js';

// field → { coerce(raw): dbValue | null }
const PATCHABLE = {
  show_discounts: {
    coerce(raw) {
      // Accept 0/1, true/false, "0"/"1", "true"/"false"
      if (raw === 1 || raw === true || raw === '1' || raw === 'true') return 1;
      if (raw === 0 || raw === false || raw === '0' || raw === 'false') return 0;
      return null;
    },
  },
};

export async function onRequestPost(context) {
  const { env, data, request } = context;
  const user = data?.user;

  if (!user || !user.id) {
    return json({ ok: false, error: 'Not signed in' }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON' }, 400);
  }

  const { field, value: rawValue } = body || {};
  if (!field || !PATCHABLE[field]) {
    return json({ ok: false, error: `Field "${field}" is not editable` }, 400);
  }

  const newValue = PATCHABLE[field].coerce(rawValue);
  if (newValue === null) {
    return json({ ok: false, error: `Invalid value for ${field}` }, 400);
  }

  const ts = now();

  try {
    await batch(env.DB, [
      stmt(env.DB, `UPDATE users SET ${field} = ?, updated_at = ? WHERE id = ?`, [newValue, ts, user.id]),
    ]);
  } catch (e) {
    return json({ ok: false, error: String(e.message ?? e) }, 500);
  }

  return json({ ok: true, field, value: newValue });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
