// functions/accounts/[id]/addresses.js
//
// POST /accounts/:id/addresses — save the address list inline from the
// account detail page. Reuses the same parseAddressForm + buildAddressStatements
// helpers as the full edit form, and also keeps the denormalized
// address_billing / address_physical columns on accounts in sync.

import { one, stmt, batch } from '../../lib/db.js';
import { auditStmt } from '../../lib/audit.js';
import { now } from '../../lib/ids.js';
import { formBody, redirectWithFlash } from '../../lib/http.js';
import {
  loadAddresses,
  parseAddressForm,
  buildAddressStatements,
} from '../../lib/address_editor.js';

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const accountId = params.id;

  // Clients set Accept: application/json for the auto-save path and expect
  // a JSON body back with the canonical post-save list. The traditional
  // form POST still gets a redirect.
  const wantsJson = (request.headers.get('accept') || '').includes('application/json');

  const before = await one(env.DB, `SELECT * FROM accounts WHERE id = ?`, [accountId]);
  if (!before) {
    return new Response('Account not found', { status: 404 });
  }

  const input = await formBody(request);
  const submittedAddresses = parseAddressForm(input);
  const existingAddresses = await loadAddresses(env.DB, accountId);

  // First default-or-first wins per kind — keeps the denormalized
  // address_billing / address_physical columns on accounts consistent with
  // the normalized account_addresses rows.
  // 'both' rows contend for both slots — they show up in either lookup.
  const isBilling = (a) => a.kind === 'billing' || a.kind === 'both';
  const isPhysical = (a) => a.kind === 'physical' || a.kind === 'both';
  const firstBilling =
    submittedAddresses.find((a) => isBilling(a) && a.is_default) ||
    submittedAddresses.find((a) => isBilling(a));
  const firstPhysical =
    submittedAddresses.find((a) => isPhysical(a) && a.is_default) ||
    submittedAddresses.find((a) => isPhysical(a));

  const newBilling = firstBilling?.address ?? null;
  const newPhysical = firstPhysical?.address ?? null;

  const { statements: addrStmts, changes: addrChanges } = buildAddressStatements(
    env.DB,
    accountId,
    submittedAddresses,
    existingAddresses,
    user
  );

  const ts = now();
  const statements = [
    stmt(
      env.DB,
      `UPDATE accounts
          SET address_billing = ?, address_physical = ?, updated_at = ?
        WHERE id = ?`,
      [newBilling, newPhysical, ts, accountId]
    ),
    ...addrStmts,
  ];

  const addressesDirty =
    addrChanges.inserted > 0 || addrChanges.updated > 0 || addrChanges.deleted > 0;

  if (addressesDirty) {
    statements.push(
      auditStmt(env.DB, {
        entityType: 'account',
        entityId: accountId,
        eventType: 'updated',
        user,
        summary: `Updated addresses`,
        changes: { addresses: addrChanges },
      })
    );
  }

  await batch(env.DB, statements);

  const msg = addressesDirty ? 'Addresses saved.' : 'No changes.';

  if (wantsJson) {
    // Echo back the canonical list so the client can promote freshly
    // inserted rows (which had blank ids) into real ones with server ids.
    const saved = await loadAddresses(env.DB, accountId);
    return new Response(
      JSON.stringify({
        ok: true,
        dirty: addressesDirty,
        message: msg,
        addresses: saved.map((a) => ({
          id: a.id,
          kind: a.kind,
          label: a.label ?? '',
          address: a.address,
          is_default: !!a.is_default,
        })),
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }

  return redirectWithFlash(`/accounts/${accountId}`, msg);
}
