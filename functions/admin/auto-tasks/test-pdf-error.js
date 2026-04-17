// GET /admin/auto-tasks/test-pdf-error
//
// One-off test hook for auto-tasks Phase 1 Rule C (PDF generation
// failure investigation). Fires a synthetic `system.error` event with
// code `pdf_generation_failed` so we can confirm the rule engine
// produces a task without having to break a real template.
//
// Optional query params:
//   quoteId=<uuid>  — link the resulting task to a real quote so the
//                     "Go to linked quote" button on the task works
//
// Safety:
//   Gated on authenticated user only (no role check yet — this is a
//   debug-only route). Delete this file once Rule C is verified.
//
// Response:
//   Redirects to / with a flash message showing fired/skipped counts.

import { one } from '../../lib/db.js';
import { reportError } from '../../lib/auto-tasks.js';
import { redirectWithFlash } from '../../lib/http.js';

export async function onRequestGet(context) {
  const { env, data, request } = context;
  const user = data?.user;
  if (!user || !user.id) {
    return new Response('Not signed in', { status: 401 });
  }

  const url = new URL(request.url);
  const quoteId = url.searchParams.get('quoteId');

  let quote = null;
  let opportunity = null;
  let account = null;
  if (quoteId) {
    quote = await one(env.DB, 'SELECT * FROM quotes WHERE id = ?', [quoteId]);
    if (quote) {
      opportunity = await one(
        env.DB,
        'SELECT * FROM opportunities WHERE id = ?',
        [quote.opportunity_id]
      );
      if (opportunity) {
        account = await one(
          env.DB,
          'SELECT * FROM accounts WHERE id = ?',
          [opportunity.account_id]
        );
      }
    }
  }

  try {
    await reportError(env, 'pdf_generation_failed', {
      summary: 'Synthetic test error (admin/auto-tasks/test-pdf-error)',
      detail: 'This is a fake error fired from the admin test route to verify Rule C end-to-end. Safe to delete the task.',
      context: {
        synthetic: true,
        firedBy: user.id,
        quoteId: quoteId || null,
      },
      user,
      quote,
      opportunity,
      account,
      // Unique dedupe key per hit so repeated tests each produce a task.
      dedupe_key: `test-${Date.now()}`,
    });
  } catch (err) {
    return redirectWithFlash(
      '/',
      `test-pdf-error FAILED: ${err?.message || err}`,
      'error'
    );
  }

  return redirectWithFlash(
    '/',
    'Fired synthetic pdf_generation_failed — check your tasks + notifications.'
  );
}
