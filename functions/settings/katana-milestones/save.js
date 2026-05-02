// functions/settings/katana-milestones/save.js
//
// POST /settings/katana-milestones/save
//
// Body: { milestones: [{ percent, label, katana_variant_id,
//                        katana_sku }, ...] }
//
// Validates (via lib/katana-milestones.js: validateMilestoneMap) and
// upserts site_prefs.katana_milestone_map with an audit-log entry.

import { hasRole } from '../../lib/auth.js';
import { saveMilestoneMap } from '../../lib/katana-milestones.js';

export async function onRequestPost(context) {
  const { env, data, request } = context;
  const user = data?.user;
  if (!user) return jsonError(401, 'sign-in required');
  if (!hasRole(user, 'admin')) return jsonError(403, 'admin only');

  let body;
  try { body = await request.json(); }
  catch { return jsonError(400, 'invalid JSON body'); }

  try {
    const normalized = await saveMilestoneMap(env, body, user);
    return jsonOk({ milestones: normalized.milestones });
  } catch (err) {
    return jsonError(400, String(err && err.message || err));
  }
}

function jsonOk(obj) {
  return new Response(JSON.stringify({ ok: true, ...obj }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
function jsonError(status, message) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
