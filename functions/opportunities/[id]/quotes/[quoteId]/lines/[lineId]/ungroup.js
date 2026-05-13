// functions/opportunities/[id]/quotes/[quoteId]/lines/[lineId]/ungroup.js
//
// POST /opportunities/:id/quotes/:quoteId/lines/:lineId/ungroup
//
// Break a parent group apart. The children become top-level lines (in
// their original sort_order, just below where the parent header sat)
// and the parent row itself is deleted. Audit logs the ungroup event.

import { all, one, stmt, batch } from '../../../../../../lib/db.js';
import { auditStmt } from '../../../../../../lib/audit.js';
import { now } from '../../../../../../lib/ids.js';
import { redirectWithFlash } from '../../../../../../lib/http.js';
import { quoteTotalsRecomputeStmt } from '../../../../../../lib/pricing.js';

const READ_ONLY_STATUSES = new Set([
  'accepted',
  'rejected',
  'superseded',
  'expired',
]);

export async function onRequestPost(context) {
  const { env, data, params } = context;
  const user = data?.user;
  const oppId = params.id;
  const quoteId = params.quoteId;
  const lineId = params.lineId;

  const quote = await one(
    env.DB,
    'SELECT id, number, revision, status, opportunity_id FROM quotes WHERE id = ?',
    [quoteId]
  );
  if (!quote || quote.opportunity_id !== oppId) {
    return new Response('Quote not found', { status: 404 });
  }
  if (READ_ONLY_STATUSES.has(quote.status)) {
    return redirectWithFlash(
      `/opportunities/${oppId}/quotes/${quoteId}`,
      `Cannot ungroup on a ${quote.status} quote.`,
      'error'
    );
  }

  const parent = await one(
    env.DB,
    'SELECT id, title FROM quote_lines WHERE id = ? AND quote_id = ? AND parent_line_id IS NULL',
    [lineId, quoteId]
  );
  if (!parent) {
    return new Response('Group not found', { status: 404 });
  }

  const children = await all(
    env.DB,
    'SELECT id FROM quote_lines WHERE quote_id = ? AND parent_line_id = ?',
    [quoteId, lineId]
  );
  if (!children.length) {
    return redirectWithFlash(
      `/opportunities/${oppId}/quotes/${quoteId}`,
      'That line is not a group.',
      'error'
    );
  }

  const ts = now();
  const ops = [
    stmt(
      env.DB,
      `UPDATE quote_lines
          SET parent_line_id = NULL,
              updated_at = ?
        WHERE quote_id = ?
          AND parent_line_id = ?`,
      [ts, quoteId, lineId]
    ),
    // Defensive: detach any cost_build that somehow ended up linked
    // to the parent header row, otherwise the FK on cost_builds.quote_line_id
    // blocks the DELETE below. Parents normally don't have builds,
    // but the schema allows it.
    stmt(
      env.DB,
      'UPDATE cost_builds SET quote_line_id = NULL WHERE quote_line_id = ?',
      [lineId]
    ),
    stmt(
      env.DB,
      'DELETE FROM quote_lines WHERE id = ? AND quote_id = ?',
      [lineId, quoteId]
    ),
    quoteTotalsRecomputeStmt(env.DB, quoteId, ts),
    auditStmt(env.DB, {
      entityType: 'quote_line',
      entityId: lineId,
      eventType: 'ungrouped',
      user,
      summary: `Ungrouped "${parent.title || 'Group'}" on ${quote.number} Rev ${quote.revision}`,
      changes: { childCount: children.length },
    }),
  ];

  await batch(env.DB, ops);

  return redirectWithFlash(
    `/opportunities/${oppId}/quotes/${quoteId}`,
    'Group dissolved.'
  );
}
