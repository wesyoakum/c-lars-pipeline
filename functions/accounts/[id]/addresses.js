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
  const firstBilling =
    submittedAddresses.find((a) => a.kind === 'billing' && a.is_default) ||
    submittedAddresses.find((a) => a.kind === 'billing');
  const firstPhysical =
    submittedAddresses.find((a) => a.kind === 'physical' && a.is_default) ||
    submittedAddresses.find((a) => a.kind === 'physical');

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
  return redirectWithFlash(`/accounts/${accountId}`, msg);
}
