// functions/opportunities/[id]/quotes/[quoteId]/lines/[lineId]/move.js
//
// POST /opportunities/:id/quotes/:quoteId/lines/:lineId/move
//   body: direction=up|down
//
// Swap a line's sort_order with its neighbor in the same "nesting
// level": top-level lines swap with the next/previous top-level line
// (skipping over any sibling group's children); children swap with the
// next/previous child of the same parent. A line can't move out of its
// group via the arrows.

import { all, one, stmt, batch } from '../../../../../../lib/db.js';
import { auditStmt } from '../../../../../../lib/audit.js';
import { now } from '../../../../../../lib/ids.js';
import { redirectWithFlash, formBody } from '../../../../../../lib/http.js';

const READ_ONLY_STATUSES = new Set([
  'accepted',
  'rejected',
  'superseded',
  'expired',
]);

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
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
      `Cannot reorder lines on a ${quote.status} quote.`,
      'error'
    );
  }

  const input = await formBody(request);
  const direction = input.direction === 'up' ? 'up' : 'down';

  const line = await one(
    env.DB,
    'SELECT id, sort_order, parent_line_id FROM quote_lines WHERE id = ? AND quote_id = ?',
    [lineId, quoteId]
  );
  if (!line) {
    return new Response('Line not found', { status: 404 });
  }

  // Find the neighbor at the same nesting level. parent_line_id IS NULL
  // means a top-level row; we treat NULL and non-NULL siblings as
  // distinct groups.
  let neighbor;
  if (line.parent_line_id) {
    const op = direction === 'up' ? '<' : '>';
    const order = direction === 'up' ? 'DESC' : 'ASC';
    neighbor = await one(
      env.DB,
      `SELECT id, sort_order
         FROM quote_lines
        WHERE quote_id = ?
          AND parent_line_id = ?
          AND sort_order ${op} ?
        ORDER BY sort_order ${order}
        LIMIT 1`,
      [quoteId, line.parent_line_id, line.sort_order]
    );
  } else {
    const op = direction === 'up' ? '<' : '>';
    const order = direction === 'up' ? 'DESC' : 'ASC';
    neighbor = await one(
      env.DB,
      `SELECT id, sort_order
         FROM quote_lines
        WHERE quote_id = ?
          AND parent_line_id IS NULL
          AND sort_order ${op} ?
        ORDER BY sort_order ${order}
        LIMIT 1`,
      [quoteId, line.sort_order]
    );
  }

  if (!neighbor) {
    // Already at the end — nothing to do.
    const accept = request.headers.get('accept') || '';
    if (accept.includes('application/json')) {
      return new Response(JSON.stringify({ ok: true, moved: false }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    return redirectWithFlash(
      `/opportunities/${oppId}/quotes/${quoteId}`,
      'Already at the edge.'
    );
  }

  const ts = now();
  const ops = [
    stmt(
      env.DB,
      'UPDATE quote_lines SET sort_order = ?, updated_at = ? WHERE id = ? AND quote_id = ?',
      [neighbor.sort_order, ts, lineId, quoteId]
    ),
    stmt(
      env.DB,
      'UPDATE quote_lines SET sort_order = ?, updated_at = ? WHERE id = ? AND quote_id = ?',
      [line.sort_order, ts, neighbor.id, quoteId]
    ),
  ];

  // If the moved line is a parent (groups its own children), shift its
  // children's sort_order in lockstep so the group stays contiguous in
  // the next page render. Children sort_order doesn't affect the swap
  // above (children sort within their own bucket), but the editor lays
  // out the rendered table by walking quote_lines ordered by
  // sort_order with parents pulling their children behind them.
  ops.push(
    auditStmt(env.DB, {
      entityType: 'quote_line',
      entityId: lineId,
      eventType: 'reordered',
      user,
      summary: `Moved line ${direction} on ${quote.number} Rev ${quote.revision}`,
      changes: { direction },
    })
  );

  await batch(env.DB, ops);

  const accept = request.headers.get('accept') || '';
  if (accept.includes('application/json')) {
    return new Response(JSON.stringify({ ok: true, moved: true }), {
      headers: { 'content-type': 'application/json' },
    });
  }
  return redirectWithFlash(
    `/opportunities/${oppId}/quotes/${quoteId}`,
    'Line moved.'
  );
}
