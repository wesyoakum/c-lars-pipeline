// POST /opportunities/:id/quotes/:quoteId/revise
//
// Create a new revision of a quote. The new quote:
//   - is a fresh row with a new UUID and a Q{opp_number}-{rev} number
//   - copies header fields (title, description, terms, cost_build_id)
//     from the source
//   - copies all line items from the source (new UUIDs, same
//     sort_order/description/quantity/etc)
//   - sets supersedes_quote_id to the source
//   - revision letter is the next in sequence (A → B → C, wrapping
//     from Z to AA is unlikely to ever happen but handled)
//   - starts in 'draft' status
//
// The source quote is marked 'superseded' IF it was in a customer-
// facing status (submitted/accepted/rejected/expired). If the source
// was still in draft/internal_review/approved_internal, it's left
// alone — the user is probably just experimenting with a parallel
// version and will delete one later.

import { one, all, stmt, batch } from '../../../../lib/db.js';
import { auditStmt } from '../../../../lib/audit.js';
import { uuid, now, nextRevisionLetter } from '../../../../lib/ids.js';
import { redirectWithFlash } from '../../../../lib/http.js';

const CUSTOMER_FACING = new Set(['submitted', 'accepted', 'rejected', 'expired']);

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

  // Load the opportunity for its number (used in the quote number).
  const opp = await one(env.DB, 'SELECT number FROM opportunities WHERE id = ?', [oppId]);
  if (!opp) return new Response('Opportunity not found', { status: 404 });

  // Work out the next revision letter. We look at ALL quotes on this
  // opportunity (regardless of quote_type) so that the composite number
  // Q{opp_number}-{rev} is always unique.
  const siblings = await all(
    env.DB,
    'SELECT revision FROM quotes WHERE opportunity_id = ?',
    [oppId]
  );
  const nextRev = nextRevisionLetter(siblings.map((r) => r.revision));

  const sourceLines = await all(
    env.DB,
    `SELECT sort_order, item_type, description, quantity, unit,
            unit_price, extended_price, notes
       FROM quote_lines
      WHERE quote_id = ?
      ORDER BY sort_order, id`,
    [sourceId]
  );

  const newId = uuid();
  const ts = now();
  const number = `Q${opp.number}-${nextRev}`;

  // Build up the batch: insert the new quote header, insert each line,
  // supersede the source if appropriate, and two audit events.
  const statements = [];

  statements.push(
    stmt(
      env.DB,
      `INSERT INTO quotes
         (id, number, opportunity_id, revision, quote_type, status,
          title, description, valid_until, currency,
          subtotal_price, tax_amount, total_price,
          incoterms, payment_terms, delivery_terms, delivery_estimate,
          cost_build_id, supersedes_quote_id,
          notes_internal, notes_customer,
          created_at, updated_at, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, 'draft',
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
           (id, quote_id, sort_order, item_type, description, quantity, unit,
            unit_price, extended_price, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          uuid(),
          newId,
          l.sort_order,
          l.item_type,
          l.description,
          l.quantity,
          l.unit,
          l.unit_price,
          l.extended_price,
          l.notes,
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
        `UPDATE quotes SET status = 'superseded', updated_at = ? WHERE id = ?`,
        [ts, source.id]
      )
    );
    statements.push(
      auditStmt(env.DB, {
        entityType: 'quote',
        entityId: source.id,
        eventType: 'superseded',
        user,
        summary: `${source.number} Rev ${source.revision} superseded by ${number} Rev ${nextRev}`,
        changes: {
          status: { from: source.status, to: 'superseded' },
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
      summary: `Created ${number} Rev ${nextRev} as revision of ${source.number} Rev ${source.revision}`,
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
    `Created ${number} Rev ${nextRev}.`
  );
}

