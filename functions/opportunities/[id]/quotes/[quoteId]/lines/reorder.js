// functions/opportunities/[id]/quotes/[quoteId]/lines/reorder.js
//
// POST /opportunities/:id/quotes/:quoteId/lines/reorder
//
// Drag-and-drop reorder endpoint. Moves a line to a new position.
// Body: { lineId, afterLineId } — place lineId after afterLineId.
// If afterLineId is null/empty, move to the top.

import { all, one, run } from '../../../../../lib/db.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export async function onRequestPost(context) {
  const { env, request, params } = context;
  const quoteId = params.quoteId;

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: 'Invalid JSON' }, 400); }

  const { lineId, afterLineId } = body;
  if (!lineId) return json({ ok: false, error: 'lineId required' }, 400);

  // Get all active lines for this quote, ordered.
  const lines = await all(env.DB,
    `SELECT id, sort_order, parent_line_id
       FROM quote_lines
      WHERE quote_id = ? AND deleted_at IS NULL
      ORDER BY sort_order`,
    [quoteId]);

  const lineMap = new Map(lines.map(l => [l.id, l]));
  const moving = lineMap.get(lineId);
  if (!moving) return json({ ok: false, error: 'Line not found' }, 404);

  // Build ordered ID list, respecting parent-child grouping.
  // If moving a parent, its children move with it.
  const isParent = lines.some(l => l.parent_line_id === lineId);
  const movingIds = new Set([lineId]);
  if (isParent) {
    lines.forEach(l => { if (l.parent_line_id === lineId) movingIds.add(l.id); });
  }

  // Remove moving items from the list.
  const remaining = lines.filter(l => !movingIds.has(l.id));
  const movingItems = lines.filter(l => movingIds.has(l.id));

  // Find insertion point.
  let insertIdx;
  if (!afterLineId) {
    insertIdx = 0;
  } else {
    const afterIdx = remaining.findIndex(l => l.id === afterLineId);
    insertIdx = afterIdx >= 0 ? afterIdx + 1 : remaining.length;
    // If afterLineId is a parent, insert after all its children too.
    const afterLine = lineMap.get(afterLineId);
    if (afterLine) {
      while (insertIdx < remaining.length && remaining[insertIdx].parent_line_id === afterLineId) {
        insertIdx++;
      }
    }
  }

  // Splice moving items into the new position.
  remaining.splice(insertIdx, 0, ...movingItems);

  // Reassign sort_order values sequentially.
  const updates = [];
  for (let i = 0; i < remaining.length; i++) {
    if (remaining[i].sort_order !== i) {
      updates.push({ id: remaining[i].id, sort_order: i });
    }
  }

  // Write updates.
  for (const u of updates) {
    await run(env.DB,
      'UPDATE quote_lines SET sort_order = ? WHERE id = ?',
      [u.sort_order, u.id]);
  }

  return json({ ok: true, moved: updates.length > 0 });
}
