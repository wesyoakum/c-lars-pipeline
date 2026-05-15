// functions/opportunities/[id]/quotes/index.js
//
// POST /opportunities/:id/quotes — create a new quote (Rev A) for this
// opportunity and redirect into the quote editor. Rev B/C/... revisions
// are created from the quote detail page via the /revise route, not here.
//
// The form only needs a quote_type (constrained by the parent
// opportunity's transaction_type) and optionally a label/title. All
// other fields (validity, payment terms, lines, cost_build_id) get
// filled in on the editor page.

import { one, all, stmt, batch } from '../../../lib/db.js';
import { auditStmt } from '../../../lib/audit.js';
import { uuid, now } from '../../../lib/ids.js';
import { redirectWithFlash } from '../../../lib/http.js';
import {
  validateQuote,
  allowedQuoteTypes,
  parseQuoteTypes,
  parseTransactionTypes,
  quoteTypeCategory,
} from '../../../lib/validators.js';
import { getQuoteTermDefault } from '../../../lib/quote-term-defaults.js';
import { formBody } from '../../../lib/http.js';
import { changeOppStage } from '../../../lib/stage-transitions.js';

const TXN_LABELS = {
  spares: 'Spares',
  eps: 'Engineered Product (EPS)',
  refurb: 'Refurbishment',
  service: 'Service',
};

export async function onRequestGet(context) {
  const oppId = context.params.id;
  return Response.redirect(new URL(`/opportunities/${oppId}?tab=quotes`, context.request.url), 302);
}

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const oppId = params.id;

  const opp = await one(
    env.DB,
    'SELECT id, number, transaction_type FROM opportunities WHERE id = ?',
    [oppId]
  );
  if (!opp) return new Response('Opportunity not found', { status: 404 });

  const input = await formBody(request);

  // If the chosen quote type implies a transaction category the
  // opportunity doesn't have yet, offer to add it instead of hard-
  // failing validation. The quote wizard re-submits with add_category=1
  // once the user confirms. No-JS posts fall through to the standard
  // validateQuote error below.
  const wantParts = parseQuoteTypes(input.quote_type);
  const oppCats = parseTransactionTypes(opp.transaction_type);
  const missingCats = [];
  for (const p of wantParts) {
    const cat = quoteTypeCategory(p);
    if (cat && !oppCats.includes(cat) && !missingCats.includes(cat)) {
      missingCats.push(cat);
    }
  }
  if (missingCats.length) {
    const confirmed = ['1', 'true', 'yes', 'on'].includes(
      String(input.add_category || '').toLowerCase()
    );
    const isAjax =
      (request.headers.get('x-requested-with') || '').toLowerCase() ===
      'xmlhttprequest';
    if (!confirmed && isAjax) {
      const labels = missingCats.map((c) => TXN_LABELS[c] || c);
      return new Response(
        JSON.stringify({
          ok: false,
          needs_category_confirm: true,
          categories: missingCats,
          category_labels: labels,
          message: `This opportunity does not have the ${labels.join(
            ' / '
          )} category. Add it to the opportunity and create the quote?`,
        }),
        { status: 409, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (confirmed) {
      const merged = oppCats.slice();
      for (const c of missingCats) if (!merged.includes(c)) merged.push(c);
      const newTxn = merged.join(',');
      const ts0 = now();
      await batch(env.DB, [
        stmt(
          env.DB,
          `UPDATE opportunities SET transaction_type = ?, updated_at = ? WHERE id = ?`,
          [newTxn, ts0, oppId]
        ),
        auditStmt(env.DB, {
          entityType: 'opportunity',
          entityId: oppId,
          eventType: 'updated',
          user,
          summary: `Added ${missingCats
            .map((c) => TXN_LABELS[c] || c)
            .join(', ')} category while creating a quote`,
          changes: {
            transaction_type: { from: opp.transaction_type, to: newTxn },
          },
        }),
      ]);
      opp.transaction_type = newTxn;
    }
    // Not confirmed + non-AJAX: fall through; validateQuote emits the
    // standard "not valid for this opportunity's type(s)" flash error.
  }

  const { ok, value, errors } = validateQuote(input, {
    transactionType: opp.transaction_type,
    requireType: true,
  });

  if (!ok) {
    // Soft surface: redirect back to the quotes tab with the first error
    // as a flash. The create form is small enough that this is fine —
    // a full form-repopulate round-trip would be overkill.
    const firstErr = Object.values(errors)[0] ?? 'Invalid input.';
    return redirectWithFlash(
      `/opportunities/${oppId}?tab=quotes`,
      firstErr,
      'error'
    );
  }

  // Seed type-specific defaults when the user didn't supply them.
  // Payment/delivery-term defaults are user-editable per quote_type —
  // they live in the `quote_term_defaults` table (migration 0024) and
  // are written via the "Save as default" button on the quote detail
  // page. The hardcoded strings that used to live here still seed the
  // table on launch so behavior is unchanged for new installs.
  //
  // T3.4 Sub-feature A — hybrid quotes combine parts (e.g. spares +
  // service). The plan says "apply the most-conservative default —
  // shorter expiration, strictest payment terms". Concretely:
  //   - If any part is spares/service, use the 14d expiration (shorter).
  //   - Prefer spares terms when spares is in the mix (they are the
  //     strictest — 50% PO / 50% delivery Net 15). Fall back to service
  //     terms when it's the only non-EPS/refurb part. EPS terms are
  //     computed client-side from delivery weeks so we don't seed
  //     payment_terms for EPS-only quotes.
  //   - Delivery terms default to the EPS / refurb saved default
  //     whenever any part is EPS or refurb — same table, same helper.
  const parts = parseQuoteTypes(value.quote_type);
  const hasSpares  = parts.includes('spares');
  const hasService = parts.includes('service');
  const hasEps     = parts.includes('eps');
  const hasRefurb  = parts.some(p => p.startsWith('refurb_'));

  // Drafts leave valid_until NULL — the detail page renders "today + N"
  // live from the per-quote-type default (migration 0038), and submit.js
  // locks the final date as `submitted_at + N` at issuance. N is editable
  // per type in Settings.
  if (!value.payment_terms) {
    if (hasSpares) {
      value.payment_terms = await getQuoteTermDefault(env, 'spares', 'payment_terms', '');
    } else if (hasService) {
      value.payment_terms = await getQuoteTermDefault(env, 'service', 'payment_terms', '');
    }
    // EPS terms are computed client-side from delivery_estimate — don't seed here.
  }
  if (!value.delivery_terms) {
    // Pick whichever part has a saved delivery default. Refurb variants
    // each have their own row so we honor the specific type the user
    // chose; EPS falls back to its dedicated row.
    let deliveryType = null;
    if (hasEps) deliveryType = 'eps';
    else if (hasRefurb) deliveryType = parts.find(p => p.startsWith('refurb_')) ?? null;
    if (deliveryType) {
      value.delivery_terms = await getQuoteTermDefault(env, deliveryType, 'delivery_terms', '');
    }
  }

  // Validate cost_build_id belongs to this opportunity (if supplied).
  value.cost_build_id = (input.cost_build_id || '').trim() || null;
  if (value.cost_build_id) {
    const cb = await one(
      env.DB,
      'SELECT id FROM cost_builds WHERE id = ? AND opportunity_id = ?',
      [value.cost_build_id, oppId]
    );
    if (!cb) {
      return redirectWithFlash(
        `/opportunities/${oppId}?tab=quotes`,
        'Selected price build does not belong to this opportunity.',
        'error'
      );
    }
  }

  const id = uuid();
  const ts = now();

  // New numbering: Q{opp_number}-{seq} where seq is 1, 2, 3...
  // Each quote gets a unique seq within the opportunity.
  // Revisions are tracked as v1, v2, v3... within the same seq.
  const siblings = await all(
    env.DB,
    'SELECT quote_seq, revision FROM quotes WHERE opportunity_id = ? ORDER BY quote_seq DESC, revision DESC',
    [oppId]
  );

  // Find the next sequence number (for a brand new quote, not a revision)
  const maxSeq = siblings.reduce((max, s) => Math.max(max, Number(s.quote_seq ?? 0)), 0);
  const quoteSeq = maxSeq + 1;
  const revision = 'v1';
  const number = `Q${opp.number}-${quoteSeq}`;
  const title = value.title || '';

  // Change-order context: when the caller passes change_order_id, the
  // new quote is bound to that CO and flows through the CO stages
  // instead of the baseline quote stages.
  const changeOrderId = (input.change_order_id || '').trim() || null;
  let changeOrder = null;
  if (changeOrderId) {
    changeOrder = await one(
      env.DB,
      'SELECT id, number, opportunity_id, job_id FROM change_orders WHERE id = ?',
      [changeOrderId]
    );
    if (!changeOrder || changeOrder.opportunity_id !== oppId) {
      return redirectWithFlash(
        `/opportunities/${oppId}?tab=quotes`,
        'Change order not found on this opportunity.',
        'error'
      );
    }
  }
  const isCO = !!changeOrder;

  await batch(env.DB, [
    stmt(
      env.DB,
      `INSERT INTO quotes
         (id, number, opportunity_id, revision, quote_seq, quote_type, change_order_id, status,
          title, description, valid_until, currency,
          subtotal_price, tax_amount, total_price,
          incoterms, payment_terms, delivery_terms, delivery_estimate,
          cost_build_id,
          notes_internal, notes_customer,
          show_discounts,
          created_at, updated_at, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'draft',
               ?, ?, ?, 'USD',
               0, ?, 0,
               ?, ?, ?, ?,
               ?,
               ?, ?,
               0,
               ?, ?, ?)`,
      [
        id,
        number,
        oppId,
        revision,
        quoteSeq,
        value.quote_type,
        changeOrderId,
        title,
        value.description,
        value.valid_until,
        value.tax_amount,
        value.incoterms,
        value.payment_terms,
        value.delivery_terms,
        value.delivery_estimate,
        value.cost_build_id,
        value.notes_internal,
        value.notes_customer,
        ts,
        ts,
        user?.id ?? null,
      ]
    ),
    auditStmt(env.DB, {
      entityType: 'quote',
      entityId: id,
      eventType: 'created',
      user,
      summary: isCO
        ? `Created change-order quote ${number} Rev ${revision} on ${opp.number} (CO ${changeOrder.number})`
        : `Created quote ${number} Rev ${revision} on ${opp.number}`,
      changes: {
        opportunity_id: oppId,
        quote_type: value.quote_type,
        change_order_id: changeOrderId,
        revision,
      },
    }),
  ]);

  // Sync opportunity stage. CO quotes advance to change_order_drafted;
  // baseline quotes go to quote_drafted. onlyForward guards against
  // regressing already-advanced opps.
  const draftedStage = isCO ? 'change_order_drafted' : 'quote_drafted';
  await changeOppStage(context, oppId, draftedStage, {
    reason: isCO
      ? `New change-order quote draft ${number}`
      : `New quote draft ${number}`,
    onlyForward: true,
  });

  return redirectWithFlash(
    `/opportunities/${oppId}/quotes/${id}`,
    `Created ${number} Rev ${revision}.`
  );
}
