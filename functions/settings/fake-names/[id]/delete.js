// functions/settings/fake-names/[id]/delete.js
//
// POST /settings/fake-names/:id/delete — remove a single catalog row.

import { one, run } from '../../../lib/db.js';
import { redirectWithFlash } from '../../../lib/http.js';
import { hasRole } from '../../../lib/auth.js';

export async function onRequestPost(context) {
  const { env, data, params } = context;
  const user = data?.user;
  if (!user || !hasRole(user, 'admin')) {
    return redirectWithFlash('/settings/fake-names', 'Admin only.', 'error');
  }
  const row = await one(env.DB,
    `SELECT id, value FROM fake_names WHERE id = ?`, [params.id]);
  if (!row) {
    return redirectWithFlash('/settings/fake-names', 'Not found.', 'error');
  }
  await run(env.DB, `DELETE FROM fake_names WHERE id = ?`, [params.id]);
  return redirectWithFlash('/settings/fake-names', `Removed "${row.value}".`);
}
