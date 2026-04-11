// functions/opportunities/[id]/cost-builds/index.js
//
// POST /opportunities/:id/cost-builds  — create a new cost build for
// this opportunity and redirect into the editor. The new build starts
// empty (all five nullable cost / quote inputs NULL, no library
// linkage, no current-project labor). Multiple cost builds per
// opportunity are allowed — the list on the "Cost builds" tab shows
// them in created_at DESC order.

import { one, stmt, batch } from '../../../lib/db.js';
import { auditStmt } from '../../../lib/audit.js';
import { uuid, now } from '../../../lib/ids.js';
import { redirectWithFlash } from '../../../lib/http.js';

export async function onRequestPost(context) {
  const { env, data, params } = context;
  const user = data?.user;
  const oppId = params.id;

  const opp = await one(
    env.DB,
    'SELECT id, number FROM opportunities WHERE id = ?',
    [oppId]
  );
  if (!opp) return new Response('Opportunity not found', { status: 404 });

  // Auto-label: "Cost build #N" where N is one higher than the current
  // count for this opportunity. Cheap to compute and gives the user a
  // sensible default they can overwrite in the editor.
  const countRow = await one(
    env.DB,
    'SELECT COUNT(*) AS n FROM cost_builds WHERE opportunity_id = ?',
    [oppId]
  );
  const nextIdx = (countRow?.n ?? 0) + 1;
  const label = `Cost build #${nextIdx}`;

  const id = uuid();
  const ts = now();

  await batch(env.DB, [
    stmt(
      env.DB,
      `INSERT INTO cost_builds
         (id, opportunity_id, label, status,
          dm_user_cost, dl_user_cost, imoh_user_cost, other_user_cost,
          quote_price_user, use_dm_library, use_labor_library,
          notes, created_at, updated_at, created_by_user_id)
       VALUES (?, ?, ?, 'draft',
               NULL, NULL, NULL, NULL,
               NULL, 0, 0,
               NULL, ?, ?, ?)`,
      [id, oppId, label, ts, ts, user?.id ?? null]
    ),
    auditStmt(env.DB, {
      entityType: 'cost_build',
      entityId: id,
      eventType: 'created',
      user,
      summary: `Created ${label} on ${opp.number}`,
      changes: { opportunity_id: oppId, label },
    }),
  ]);

  return redirectWithFlash(
    `/opportunities/${oppId}/cost-builds/${id}`,
    `Created ${label}.`
  );
}
