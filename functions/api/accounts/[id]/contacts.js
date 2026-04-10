// functions/api/accounts/[id]/contacts.js
//
// GET /api/accounts/:id/contacts — JSON list of contacts for an account.
//
// Used by the opportunity form's client-side script to repopulate the
// Authority and Primary contact dropdowns when the account changes.

import { all } from '../../../lib/db.js';

export async function onRequestGet(context) {
  const { env, params } = context;
  const rows = await all(
    env.DB,
    `SELECT id, first_name, last_name, title, email, phone, is_primary
       FROM contacts
      WHERE account_id = ?
      ORDER BY is_primary DESC, last_name, first_name`,
    [params.id]
  );
  return new Response(JSON.stringify(rows), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}
