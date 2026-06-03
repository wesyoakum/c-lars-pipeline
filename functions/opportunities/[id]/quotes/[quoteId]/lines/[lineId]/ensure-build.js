// functions/opportunities/[id]/quotes/[quoteId]/lines/[lineId]/ensure-build.js
//
// POST — ensure a price build exists for this line with the given kind.
// If a build exists, updates its kind. If none exists, creates one.
// Returns JSON { ok, cost_build_id, build_kind, created }.

import { one, all, stmt, batch } from '../../../../../../lib/db.js';
import { auditStmt } from '../../../../../../lib/audit.js';
import { uuid, now, nextNumber, currentYear } from '../../../../../../lib/ids.js';
import { formBody } from '../../../../../../lib/http.js';
import { normalizePriceBuildKind } from '../../../../../../lib/validators.js';
import { kindConfig } from '../../../../../../lib/pricing.js';

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

  const input = await formBody(request);
  const kind = normalizePriceBuildKind(input.build_kind);
  const ts = now();

  // Check if build already exists
  const line = await one(env.DB,
    `SELECT ql.id, ql.cost_build_id, ql.description, ql.dm_cost, ql.other_cost,
            q.opportunity_id, q.quote_seq
       FROM quote_lines ql
       JOIN quotes q ON q.id = ql.quote_id
      WHERE ql.id = ? AND q.id = ? AND q.opportunity_id = ?
        AND ql.deleted_at IS NULL`,
    [lineId, quoteId, oppId]);
  if (!line) return json({ ok: false, error: 'Line not found' }, 404);

  if (line.cost_build_id) {
    // Build exists — update its kind (same logic as kind.js)
    const build = await one(env.DB,
      'SELECT id, build_kind, status FROM cost_builds WHERE id = ?',
      [line.cost_build_id]);
    if (!build) return json({ ok: false, error: 'Build not found' }, 404);
    if (build.status === 'locked') return json({ ok: false, error: 'Build is locked' }, 409);

    if (kind === build.build_kind) {
      return json({ ok: true, cost_build_id: build.id, build_kind: kind, created: false });
    }

    const kc = kindConfig(kind);
    const clearParts = [];
    if (!kc.dl)   { clearParts.push('dl_user_cost = NULL'); clearParts.push('use_labor_library = 0'); }
    if (!kc.imoh) { clearParts.push('imoh_user_cost = NULL'); }
    if (!kc.dm)   { clearParts.push('dm_user_cost = NULL'); clearParts.push('use_dm_library = 0'); }
    if (!kc.other){ clearParts.push('other_user_cost = NULL'); }
    const clearSql = clearParts.length > 0 ? ', ' + clearParts.join(', ') : '';

    await batch(env.DB, [
      stmt(env.DB,
        `UPDATE cost_builds SET build_kind = ?${clearSql}, updated_at = ? WHERE id = ?`,
        [kind, ts, build.id]),
      auditStmt(env.DB, {
        entityType: 'cost_build',
        entityId: build.id,
        eventType: 'updated',
        user,
        summary: `Set Price Build kind to ${kind}`,
        changes: { build_kind: { from: build.build_kind, to: kind } },
      }),
    ]);

    return json({ ok: true, cost_build_id: build.id, build_kind: kind, created: false });
  }

  // No build — create one with the selected kind
  const id = uuid();
  const label = line.description || 'Price build';

  // Generate build number
  const quoteSeqNum = line.quote_seq ?? 1;
  const existingBuilds = await one(env.DB,
    `SELECT COUNT(*) AS n FROM cost_builds cb
       JOIN quote_lines ql ON ql.id = cb.quote_line_id
      WHERE ql.quote_id = ?`, [quoteId]);
  const buildIndex = (existingBuilds?.n ?? 0) + 1;
  const buildNumber = `P${quoteSeqNum}.${buildIndex}`;

  // Seed DM/Other from the line if already entered
  const seedDm = line.dm_cost ?? null;
  const seedOther = line.other_cost ?? null;

  await batch(env.DB, [
    stmt(env.DB,
      `INSERT INTO cost_builds
         (id, opportunity_id, quote_line_id, label, number, status, build_kind,
          dm_user_cost, dl_user_cost, imoh_user_cost, other_user_cost,
          quote_price_user, use_dm_library, use_labor_library,
          notes, created_at, updated_at, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, NULL, NULL, ?, NULL, 0, 0, NULL, ?, ?, ?)`,
      [id, line.opportunity_id, lineId, label, buildNumber, kind,
       seedDm, seedOther, ts, ts, user?.id ?? null]),
    stmt(env.DB,
      'UPDATE quote_lines SET cost_build_id = ?, updated_at = ? WHERE id = ?',
      [id, ts, lineId]),
    auditStmt(env.DB, {
      entityType: 'cost_build',
      entityId: id,
      eventType: 'created',
      user,
      summary: `Price Build ${buildNumber} created (${kind}) from line details`,
    }),
  ]);

  return json({ ok: true, cost_build_id: id, build_kind: kind, created: true });
}
