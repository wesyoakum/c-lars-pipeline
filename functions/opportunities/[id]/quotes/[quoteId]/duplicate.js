// POST /opportunities/:id/quotes/:quoteId/duplicate
//
// Create an independent copy of a quote on a (possibly different)
// opportunity and account.  Unlike revise, this:
//   - does NOT set supersedes_quote_id
//   - does NOT mark the source quote as dead
//   - does NOT change the opportunity stage
//   - assigns a new quote_seq in the target opportunity
//   - starts in 'draft' status with revision 'v1'
//
// Expects form-encoded body:
//   target_opportunity_id  — the destination opportunity

import { one, all, stmt, batch } from '../../../../lib/db.js';
import { auditStmt }            from '../../../../lib/audit.js';
import { uuid, now }            from '../../../../lib/ids.js';
import { redirectWithFlash }    from '../../../../lib/http.js';
import { quoteTotalsRecomputeStmt } from '../../../../lib/pricing.js';

export async function onRequestPost(context) {
  const { env, data, params, request } = context;
  const user = data?.user;
  const sourceOppId = params.id;
  const sourceId    = params.quoteId;

  const fd = await request.formData();
  const targetOppId = (fd.get('target_opportunity_id') || '').trim();
  if (!targetOppId) {
    return new Response('Missing target_opportunity_id', { status: 400 });
  }

  // Load source quote
  const source = await one(
    env.DB,
    'SELECT * FROM quotes WHERE id = ? AND deleted_at IS NULL',
    [sourceId]
  );
  if (!source || source.opportunity_id !== sourceOppId) {
    return new Response('Source quote not found', { status: 404 });
  }

  // Load target opportunity
  const targetOpp = await one(
    env.DB,
    'SELECT id, number FROM opportunities WHERE id = ? AND deleted_at IS NULL',
    [targetOppId]
  );
  if (!targetOpp) {
    return new Response('Target opportunity not found', { status: 404 });
  }

  // Find source opportunity number (for audit trail)
  const sourceOpp = await one(
    env.DB,
    'SELECT number FROM opportunities WHERE id = ?',
    [sourceOppId]
  );

  // Next quote_seq in the target opportunity
  const siblings = await all(
    env.DB,
    'SELECT quote_seq FROM quotes WHERE opportunity_id = ? ORDER BY quote_seq DESC',
    [targetOppId]
  );
  const maxSeq = siblings.reduce((max, s) => Math.max(max, Number(s.quote_seq ?? 0)), 0);
  const quoteSeq = maxSeq + 1;
  const revision = 'v1';
  const number = `Q${targetOpp.number}-${quoteSeq}`;

  // Load source lines (comprehensive — copy everything user-visible)
  const sourceLines = await all(
    env.DB,
    `SELECT sort_order, item_type, title, part_number, description,
            quantity, unit, unit_price, extended_price,
            notes, line_notes, is_option, line_type,
            discount_amount, discount_pct, discount_description, discount_is_phantom,
            dm_cost, other_cost, supplier_id, supplier_name,
            delivery_estimate, delivery_show_in_notes, notes_internal,
            is_active, parent_line_id, id AS source_line_id
       FROM quote_lines
      WHERE quote_id = ? AND deleted_at IS NULL
      ORDER BY sort_order, id`,
    [sourceId]
  );

  const newId = uuid();
  const ts = now();

  // Build old→new line ID mapping for parent_line_id references
  const lineIdMap = {};
  const newLines = sourceLines.map(l => {
    const newLineId = uuid();
    lineIdMap[l.source_line_id] = newLineId;
    return { ...l, newLineId };
  });

  const statements = [];

  // Insert the new quote header
  statements.push(
    stmt(
      env.DB,
      `INSERT INTO quotes
         (id, number, opportunity_id, revision, quote_seq, quote_type, status,
          title, description, valid_until, currency,
          subtotal_price, tax_amount, total_price,
          incoterms, payment_terms, delivery_terms, delivery_estimate,
          notes_internal, notes_customer,
          discount_amount, discount_pct, discount_description, discount_is_phantom,
          show_discounts,
          created_at, updated_at, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, 'draft',
               ?, ?, NULL, ?,
               ?, ?, ?,
               ?, ?, ?, ?,
               ?, ?,
               ?, ?, ?, ?,
               ?,
               ?, ?, ?)`,
      [
        newId,
        number,
        targetOppId,
        revision,
        quoteSeq,
        source.quote_type,
        source.title,
        source.description,
        source.currency || 'USD',
        source.subtotal_price ?? 0,
        source.tax_amount ?? 0,
        source.total_price ?? 0,
        source.incoterms,
        source.payment_terms,
        source.delivery_terms,
        source.delivery_estimate,
        source.notes_internal,
        source.notes_customer,
        source.discount_amount ?? null,
        source.discount_pct ?? null,
        source.discount_description ?? null,
        source.discount_is_phantom ?? 0,
        source.show_discounts ?? 0,
        ts,
        ts,
        user?.id ?? null,
      ]
    )
  );

  // Insert line items
  for (const l of newLines) {
    const parentId = l.parent_line_id ? (lineIdMap[l.parent_line_id] ?? null) : null;
    statements.push(
      stmt(
        env.DB,
        `INSERT INTO quote_lines
           (id, quote_id, sort_order, item_type, title, part_number, description,
            quantity, unit, unit_price, extended_price,
            notes, line_notes, is_option, line_type,
            discount_amount, discount_pct, discount_description, discount_is_phantom,
            dm_cost, other_cost, supplier_id, supplier_name,
            delivery_estimate, delivery_show_in_notes, notes_internal,
            is_active, parent_line_id,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?,
                 ?, ?, ?, ?,
                 ?, ?, ?, ?,
                 ?, ?, ?, ?,
                 ?, ?, ?, ?,
                 ?, ?, ?,
                 ?, ?,
                 ?, ?)`,
        [
          l.newLineId,
          newId,
          l.sort_order,
          l.item_type,
          l.title,
          l.part_number,
          l.description,
          l.quantity,
          l.unit,
          l.unit_price,
          l.extended_price,
          l.notes,
          l.line_notes,
          l.is_option ?? 0,
          l.line_type,
          l.discount_amount ?? null,
          l.discount_pct ?? null,
          l.discount_description ?? null,
          l.discount_is_phantom ?? 0,
          l.dm_cost ?? null,
          l.other_cost ?? null,
          l.supplier_id ?? null,
          l.supplier_name ?? null,
          l.delivery_estimate ?? null,
          l.delivery_show_in_notes ?? 0,
          l.notes_internal ?? null,
          l.is_active ?? 1,
          parentId,
          ts,
          ts,
        ]
      )
    );
  }

  // Recompute totals
  statements.push(quoteTotalsRecomputeStmt(env.DB, newId, ts));

  // Audit
  const sameDest = targetOppId === sourceOppId;
  const summaryTarget = sameDest
    ? ''
    : ` on ${targetOpp.number}`;
  statements.push(
    auditStmt(env.DB, {
      entityType: 'quote',
      entityId: newId,
      eventType: 'created',
      user,
      summary: `Duplicated ${source.number} ${source.revision} as ${number}${summaryTarget}`,
      changes: {
        opportunity_id: targetOppId,
        quote_type: source.quote_type,
        duplicated_from: source.id,
      },
    })
  );

  await batch(env.DB, statements);

  return redirectWithFlash(
    `/opportunities/${targetOppId}/quotes/${newId}`,
    `Created ${number} as a copy of ${source.number} ${source.revision}.`
  );
}
