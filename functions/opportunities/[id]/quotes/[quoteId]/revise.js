// POST /opportunities/:id/quotes/:quoteId/revise
//
// Create a new revision of a quote. The new quote:
//   - is a fresh row with a new UUID
//   - uses the same quote_seq as the source but increments the version
//     e.g. Q25012-1-v1 → Q25012-1-v2
//   - copies header fields (title, description, terms)
//   - copies all line items (new UUIDs, same sort_order/description/etc)
//   - sets supersedes_quote_id to the source
//   - starts in 'revision_draft' status
//
// The source quote is marked 'dead' IF it was in a customer-
// facing status (submitted/accepted/rejected/expired). If the source
// was still in draft/internal_review/approved_internal, it's left alone.

import { one, all, stmt, batch } from '../../../../lib/db.js';
import { auditStmt } from '../../../../lib/audit.js';
import { uuid, now } from '../../../../lib/ids.js';
import { redirectWithFlash } from '../../../../lib/http.js';

const CUSTOMER_FACING = new Set(['issued', 'revision_issued', 'accepted', 'rejected', 'expired']);

export async function onRequestPost(context) {
  const { env, data, params } = context;
  const user = data?.user;
  const oppId = params.id;
  const sourceId = params.quoteId;

  const source = await one(
    env.DB,
    'SELECT * FROM quotes WHERE id = ?',
    [sourceId]
  );
  if (!source || source.opportunity_id !== oppId) {
    return new Response('Quote not found', { status: 404 });
  }

  const opp = await one(env.DB, 'SELECT number FROM opportunities WHERE id = ?', [oppId]);
  if (!opp) return new Response('Opportunity not found', { status: 404 });

  // Find the next version number for this quote_seq.
  // If the source has quote_seq, use it. Otherwise fall back to counting siblings.
  const quoteSeq = source.quote_seq ?? 1;

  // Find highest version for this seq
  const sameSeqQuotes = await all(
    env.DB,
    `SELECT revision FROM quotes WHERE opportunity_id = ? AND quote_seq = ?`,
    [oppId, quoteSeq]
  );

  // Parse version numbers from revisions like 'v1', 'v2', or old-style 'A', 'B'
  let maxVersion = 0;
  for (const q of sameSeqQuotes) {
    const match = String(q.revision ?? '').match(/^v(\d+)$/i);
    if (match) {
      maxVersion = Math.max(maxVersion, Number(match[1]));
    } else {
      // Old-style letter revision — count as version 1
      maxVersion = Math.max(maxVersion, 1);
    }
  }
  const nextVersion = maxVersion + 1;
  const nextRev = `v${nextVersion}`;
  const number = `Q${opp.number}-${quoteSeq}-${nextRev}`;

  const sourceLines = await all(
    env.DB,
    `SELECT sort_order, item_type, title, part_number, description, quantity, unit,
            unit_price, extended_price, notes, line_notes, is_option
       FROM quote_lines
      WHERE quote_id = ?
      ORDER BY sort_order, id`,
    [sourceId]
  );

  const newId = uuid();
  const ts = now();

  const statements = [];

  statements.push(
    stmt(
      env.DB,
      `INSERT INTO quotes
         (id, number, opportunity_id, revision, quote_seq, quote_type, status,
          title, description, valid_until, currency,
          subtotal_price, tax_amount, total_price,
          incoterms, payment_terms, delivery_terms, delivery_estimate,
          cost_build_id, supersedes_quote_id,
          notes_internal, notes_customer,
          created_at, updated_at, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, 'revision_draft',
               ?, ?, ?, ?,
               ?, ?, ?,
               ?, ?, ?, ?,
               ?, ?,
               ?, ?,
               ?, ?, ?)`,
      [
        newId,
        number,
        oppId,
        nextRev,
        quoteSeq,
        source.quote_type,
        source.title,
        source.description,
        source.valid_until,
        source.currency || 'USD',
        source.subtotal_price ?? 0,
        source.tax_amount ?? 0,
        source.total_price ?? 0,
        source.incoterms,
        source.payment_terms,
        source.delivery_terms,
        source.delivery_estimate,
        source.cost_build_id,
        source.id,
        source.notes_internal,
        source.notes_customer,
        ts,
        ts,
        user?.id ?? null,
      ]
    )
  );

  for (const l of sourceLines) {
    statements.push(
      stmt(
        env.DB,
        `INSERT INTO quote_lines
           (id, quote_id, sort_order, item_type, title, part_number, description,
            quantity, unit, unit_price, extended_price, notes, line_notes, is_option,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          uuid(),
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
          ts,
          ts,
        ]
      )
    );
  }

  const supersedeSource = CUSTOMER_FACING.has(source.status);
  if (supersedeSource) {
    statements.push(
      stmt(
        env.DB,
        `UPDATE quotes SET status = 'dead', updated_at = ? WHERE id = ?`,
        [ts, source.id]
      )
    );
    statements.push(
      auditStmt(env.DB, {
        entityType: 'quote',
        entityId: source.id,
        eventType: 'dead',
        user,
        summary: `${source.number} ${source.revision} superseded by ${number} ${nextRev}`,
        changes: {
          status: { from: source.status, to: 'dead' },
          superseded_by: newId,
        },
      })
    );
  }

  statements.push(
    auditStmt(env.DB, {
      entityType: 'quote',
      entityId: newId,
      eventType: 'created',
      user,
      summary: `Created ${number} ${nextRev} as revision of ${source.number} ${source.revision}`,
      changes: {
        opportunity_id: oppId,
        quote_type: source.quote_type,
        revision: nextRev,
        supersedes_quote_id: source.id,
      },
    })
  );

  await batch(env.DB, statements);

  return redirectWithFlash(
    `/opportunities/${oppId}/quotes/${newId}`,
    `Created ${number} ${nextRev}.`
  );
}
