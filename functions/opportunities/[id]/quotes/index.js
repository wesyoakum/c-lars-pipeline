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
import { uuid, now, nextRevisionLetter } from '../../../lib/ids.js';
import { redirectWithFlash } from '../../../lib/http.js';
import { validateQuote, allowedQuoteTypes } from '../../../lib/validators.js';
import { formBody } from '../../../lib/http.js';

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

  // Validate cost_build_id belongs to this opportunity (if supplied).
  if (value.cost_build_id) {
    const cb = await one(
      env.DB,
      'SELECT id FROM cost_builds WHERE id = ? AND opportunity_id = ?',
      [value.cost_build_id, oppId]
    );
    if (!cb) {
      return redirectWithFlash(
        `/opportunities/${oppId}?tab=quotes`,
        'Selected cost build does not belong to this opportunity.',
        'error'
      );
    }
  }

  const id = uuid();
  const ts = now();

  // Revision letter: pick the next available letter across ALL quotes on
  // this opportunity (not scoped by quote_type) so the composite number
  // Q{opp_number}-{rev} is always unique.
  const siblings = await all(
    env.DB,
    'SELECT revision FROM quotes WHERE opportunity_id = ?',
    [oppId]
  );
  const revision = nextRevisionLetter(siblings.map((r) => r.revision));
  const number = `Q${opp.number}-${revision}`;
  const title = value.title || `${number} (${value.quote_type})`;

  await batch(env.DB, [
    stmt(
      env.DB,
      `INSERT INTO quotes
         (id, number, opportunity_id, revision, quote_type, status,
          title, description, valid_until, currency,
          subtotal_price, tax_amount, total_price,
          incoterms, payment_terms, delivery_terms, delivery_estimate,
          cost_build_id,
          notes_internal, notes_customer,
          created_at, updated_at, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, 'draft',
               ?, ?, ?, 'USD',
               0, ?, 0,
               ?, ?, ?, ?,
               ?,
               ?, ?,
               ?, ?, ?)`,
      [
        id,
        number,
        oppId,
        revision,
        value.quote_type,
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
      summary: `Created quote ${number} Rev ${revision} on ${opp.number}`,
      changes: {
        opportunity_id: oppId,
        quote_type: value.quote_type,
        revision,
      },
    }),
  ]);

  return redirectWithFlash(
    `/opportunities/${oppId}/quotes/${id}`,
    `Created ${number} Rev ${revision}.`
  );
}
