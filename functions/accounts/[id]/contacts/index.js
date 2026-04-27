// functions/accounts/[id]/contacts/index.js
//
// POST /accounts/:id/contacts — create a new contact under an account.
//
// If is_primary is set, demote any existing primary on this account in
// the same batch so there's always at most one primary.

import { one, stmt, batch } from '../../../lib/db.js';
import { auditStmt } from '../../../lib/audit.js';
import { validateContact } from '../../../lib/validators.js';
import { uuid, now } from '../../../lib/ids.js';
import { redirectWithFlash, formBody, isPopupMode, popupCloseResponse } from '../../../lib/http.js';
import { layout, htmlResponse } from '../../../lib/layout.js';

/**
 * Detects a request coming from the wizard modal or any XHR-style client.
 * Same three signals used in POST /accounts and POST /opportunities:
 * form source=wizard, an x-requested-with header, or a JSON-only accept.
 */
function isAjaxRequest(request, input) {
  if (input?.source === 'wizard' || input?.source === 'modal') return true;
  const xrw = request.headers.get('x-requested-with');
  if (xrw && xrw.toLowerCase() === 'xmlhttprequest') return true;
  const accept = request.headers.get('accept') || '';
  return accept.includes('application/json') && !accept.includes('text/html');
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const accountId = params.id;

  const input = { ...(await formBody(request)), account_id: accountId };
  const ajax = isAjaxRequest(request, input);

  const account = await one(
    env.DB,
    `SELECT id, name FROM accounts WHERE id = ?`,
    [accountId]
  );
  if (!account) {
    if (ajax) {
      return jsonResponse(
        { ok: false, error: 'Account not found', errors: { account_id: 'Account not found' } },
        404
      );
    }
    return htmlResponse(
      layout('Not found', '<section class="card"><h1>Account not found</h1></section>', {
        user, env: data?.env, activeNav: '/accounts',
      }),
      { status: 404 }
    );
  }

  const { ok, value, errors } = validateContact(input);

  if (!ok) {
    if (ajax) {
      const firstError = Object.values(errors)[0] || 'Invalid input.';
      return jsonResponse({ ok: false, error: firstError, errors }, 400);
    }
    const { renderNewContactForm } = await import('./new.js');
    return renderNewContactForm(context, { account, values: input, errors });
  }

  const id = uuid();
  const ts = now();
  const displayName = [value.first_name, value.last_name].filter(Boolean).join(' ') || '(no name)';

  const statements = [];

  // If the new contact should be primary, clear any existing primary on this account.
  if (value.is_primary) {
    statements.push(
      stmt(
        env.DB,
        `UPDATE contacts SET is_primary = 0, updated_at = ? WHERE account_id = ? AND is_primary = 1`,
        [ts, accountId]
      )
    );
  }

  statements.push(
    stmt(
      env.DB,
      `INSERT INTO contacts
         (id, account_id, first_name, last_name, title, email, phone, mobile,
          is_primary, notes, created_at, updated_at, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        accountId,
        value.first_name,
        value.last_name,
        value.title,
        value.email,
        value.phone,
        value.mobile,
        value.is_primary,
        value.notes,
        ts,
        ts,
        user?.id ?? null,
      ]
    )
  );

  statements.push(
    auditStmt(env.DB, {
      entityType: 'contact',
      entityId: id,
      eventType: 'created',
      user,
      summary: `Created contact "${displayName}" on ${account.name}${value.is_primary ? ' (primary)' : ''}`,
      changes: value,
    })
  );

  await batch(env.DB, statements);

  if (ajax) {
    return jsonResponse({
      ok: true,
      id,
      first_name: value.first_name,
      last_name: value.last_name,
      display_name: displayName,
      account_id: accountId,
      redirectUrl: `/contacts/${id}`,
    });
  }

  if (isPopupMode(request, input)) {
    return popupCloseResponse('pipeline.contact.created', {
      contact: {
        id,
        first_name: value.first_name,
        last_name: value.last_name,
        title: value.title,
      },
    });
  }

  return redirectWithFlash(
    `/accounts/${accountId}?tab=contacts`,
    `Contact "${displayName}" added.`
  );
}
