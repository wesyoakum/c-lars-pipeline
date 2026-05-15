// POST /opportunities/:id/quotes/:quoteId/lines/:lineId/price-build/kind
//
// Set the Price Build "kind" (cost_builds.build_kind). Standalone from
// the pricing autosave so the inline Kind selector can't clobber the
// rest of the build. Returns JSON; the editor reloads on success.

import { one, stmt, batch } from '../../../../../../../lib/db.js';
import { auditStmt } from '../../../../../../../lib/audit.js';
import { now } from '../../../../../../../lib/ids.js';
import { formBody } from '../../../../../../../lib/http.js';
import { normalizePriceBuildKind } from '../../../../../../../lib/validators.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const { id: oppId, quoteId, lineId } = params;

  const build = await one(
    env.DB,
    `SELECT cb.id, cb.label, cb.status, cb.build_kind
       FROM cost_builds cb
       JOIN quote_lines ql ON ql.id = cb.quote_line_id
       JOIN quotes q ON q.id = ql.quote_id
      WHERE cb.quote_line_id = ? AND q.id = ? AND q.opportunity_id = ?`,
    [lineId, quoteId, oppId]
  );
  if (!build) return json({ ok: false, error: 'Price build not found' }, 404);
  if (build.status === 'locked') {
    return json({ ok: false, error: 'Price build is locked' }, 409);
  }

  const input = await formBody(request);
  const kind = normalizePriceBuildKind(input.build_kind);
  if (kind === build.build_kind) {
    return json({ ok: true, build_kind: kind });
  }

  const ts = now();
  await batch(env.DB, [
    stmt(
      env.DB,
      `UPDATE cost_builds SET build_kind = ?, updated_at = ? WHERE id = ?`,
      [kind, ts, build.id]
    ),
    auditStmt(env.DB, {
      entityType: 'cost_build',
      entityId: build.id,
      eventType: 'updated',
      user,
      summary: `Set Price Build kind to ${kind}`,
      changes: { build_kind: { from: build.build_kind, to: kind } },
    }),
  ]);

  return json({ ok: true, build_kind: kind });
}
