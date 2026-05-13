// functions/opportunities/[id]/quotes/[quoteId]/lines/group.js
//
// POST /opportunities/:id/quotes/:quoteId/lines/group
//   body: line_ids=<comma-separated>   (alternatively: line_ids[]=...&line_ids[]=...)
//         title=<parent header title>  (optional, defaults to "Group")
//
// Wrap the selected top-level lines into a single parent header line.
// The parent carries title + line_notes only; its children render under
// it on the editor and their summed extended_price is what shows on the
// generated quote. Existing children of a parent cannot themselves be
// re-parented (single-level grouping only).

import { all, one, stmt, batch } from '../../../../../lib/db.js';
import { auditStmt } from '../../../../../lib/audit.js';
import { uuid, now } from '../../../../../lib/ids.js';
import { redirectWithFlash, formBody } from '../../../../../lib/http.js';
import { quoteTotalsRecomputeStmt } from '../../../../../lib/pricing.js';

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
      `Cannot group lines on a ${quote.status} quote.`,
      'error'
    );
  }

  const input = await formBody(request);
  const title = (input.title || '').trim() || 'Group';
  const lineNotes = (input.line_notes || '').trim() || null;

  // Accept either a comma-separated string or repeated form fields.
  let ids = [];
  if (Array.isArray(input.line_ids)) {
    ids = input.line_ids;
  } else if (typeof input.line_ids === 'string') {
    ids = input.line_ids.split(',').map(s => s.trim()).filter(Boolean);
  }
  // Also accept `ids[]` repeated.
  if (!ids.length && Array.isArray(input['ids[]'])) {
    ids = input['ids[]'];
  }
  ids = Array.from(new Set(ids)).filter(Boolean);
  if (ids.length < 2) {
    return redirectWithFlash(
      `/opportunities/${oppId}/quotes/${quoteId}`,
      'Select at least 2 lines to group.',
      'error'
    );
  }

  // Pull the candidate lines. Only top-level (parent_line_id IS NULL)
  // lines that themselves have no children are eligible.
  const placeholders = ids.map(() => '?').join(',');
  const rows = await all(
    env.DB,
    `SELECT id, sort_order, is_option, line_type, parent_line_id
       FROM quote_lines
      WHERE quote_id = ?
        AND id IN (${placeholders})`,
    [quoteId, ...ids]
  );
  if (rows.length !== ids.length) {
    return redirectWithFlash(
      `/opportunities/${oppId}/quotes/${quoteId}`,
      'One or more selected lines could not be found.',
      'error'
    );
  }
  if (rows.some(r => r.parent_line_id)) {
    return redirectWithFlash(
      `/opportunities/${oppId}/quotes/${quoteId}`,
      'Selected lines are already grouped. Ungroup them first.',
      'error'
    );
  }
  const hasChildren = await one(
    env.DB,
    `SELECT 1 AS x FROM quote_lines
      WHERE quote_id = ?
        AND parent_line_id IN (${placeholders})
      LIMIT 1`,
    [quoteId, ...ids]
  );
  if (hasChildren) {
    return redirectWithFlash(
      `/opportunities/${oppId}/quotes/${quoteId}`,
      'A selected line is already a parent group. Ungroup it first.',
      'error'
    );
  }

  // Pick the new parent's slot just before the topmost selected line.
  // The children keep their existing sort_order; the parent gets the
  // minimum sort_order minus a tiny offset so it lays out above them.
  // (We don't renumber the whole quote — sort_order is integer-typed
  // but SQLite will happily store fractional values, and the column is
  // also REAL-flexible in practice. To be safe though, we bump the
  // parent into the min - 1 slot and shift any line with a smaller
  // existing sort_order up by 1 to keep ordering stable.)
  const minSort = Math.min(...rows.map(r => Number(r.sort_order)));
  const parentSort = minSort; // parent takes the min slot; children shift down.

  const ts = now();
  const parentId = uuid();

  // The parent's is_option / line_type follow the children: if all
  // children share the same value we adopt it; otherwise default
  // (is_option=0, line_type=null) so the parent lands in the
  // "regular" section.
  const allOption = rows.every(r => Number(r.is_option) === 1);
  const lineTypes = new Set(rows.map(r => r.line_type ?? null));
  const sharedLineType = lineTypes.size === 1 ? [...lineTypes][0] : null;

  const ops = [];

  // Shift every line at quote_id with sort_order >= parentSort by +1
  // (including the children we're about to re-parent). This guarantees
  // the new parent's sort_order is unique and lower than its children.
  ops.push(
    stmt(
      env.DB,
      `UPDATE quote_lines
          SET sort_order = sort_order + 1,
              updated_at = ?
        WHERE quote_id = ?
          AND sort_order >= ?`,
      [ts, quoteId, parentSort]
    )
  );

  // Insert the parent header line. quantity is set to 0, unit_price 0
  // — the parent doesn't itself contribute to totals, and the
  // pricing recompute SQL explicitly excludes any line that is a
  // parent.
  ops.push(
    stmt(
      env.DB,
      `INSERT INTO quote_lines
         (id, quote_id, sort_order, item_type, title, description,
          quantity, unit, unit_price, extended_price, line_notes,
          is_option, is_active, line_type, parent_line_id,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        parentId,
        quoteId,
        parentSort,
        'product',
        title,
        '',
        0,
        '',
        0,
        0,
        lineNotes,
        allOption ? 1 : 0,
        1,
        sharedLineType,
        null,
        ts,
        ts,
      ]
    )
  );

  // Re-parent the selected children.
  ops.push(
    stmt(
      env.DB,
      `UPDATE quote_lines
          SET parent_line_id = ?,
              updated_at = ?
        WHERE quote_id = ?
          AND id IN (${placeholders})`,
      [parentId, ts, quoteId, ...ids]
    )
  );

  // Totals: SUM math is unchanged in dollars (parent contributes 0,
  // children contribute as before). We still recompute so updated_at /
  // any latent drift gets refreshed.
  ops.push(quoteTotalsRecomputeStmt(env.DB, quoteId, ts));

  ops.push(
    auditStmt(env.DB, {
      entityType: 'quote_line',
      entityId: parentId,
      eventType: 'grouped',
      user,
      summary: `Grouped ${ids.length} lines under "${title}" on ${quote.number} Rev ${quote.revision}`,
      changes: { childIds: ids, title },
    })
  );

  await batch(env.DB, ops);

  return redirectWithFlash(
    `/opportunities/${oppId}/quotes/${quoteId}`,
    `Grouped ${ids.length} lines.`
  );
}
