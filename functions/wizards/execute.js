// functions/wizards/execute.js
//
// POST /wizards/execute
//
// Executes a Smart-start cascade plan (produced by /wizards/plan and
// reviewed/edited by the user). All operations run in a single D1
// batch so partial failure rolls back cleanly.
//
// Body (JSON):
//   {
//     wizard_key: 'contact' | 'account' | …,
//     ai_inbox_entry_id?: '<uuid>',
//     plan: { /* see plan.js for shape */ },
//   }
//
// Response:
//   { ok: true, account_id?, contact_id?, redirect_url, ... }
//   { ok: false, error }

import { stmt, batch } from '../lib/db.js';
import { auditStmt } from '../lib/audit.js';
import { uuid, now } from '../lib/ids.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

const CONTACT_PUSH_COLUMNS = new Set([
  'title', 'email', 'phone', 'mobile', 'linkedin_url',
]);

const ACCOUNT_PUSH_COLUMNS = new Set([
  'phone', 'website', 'segment',
]);

// ----- handler ----------------------------------------------------

export async function onRequestPost(context) {
  const { env, data, request } = context;
  const user = data?.user;
  if (!user) return json({ ok: false, error: 'unauthenticated' }, 401);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: 'invalid_json' }, 400); }

  const wizardKey = String(body?.wizard_key || '').trim();
  const plan = body?.plan;
  if (!plan || typeof plan !== 'object') {
    return json({ ok: false, error: 'plan_required' }, 400);
  }

  const ts = now();
  const statements = [];
  const aiInboxEntryId = body?.ai_inbox_entry_id || plan.ai_inbox_entry_id || null;

  // ---- contact wizard: account (optional) → contact ----
  if (wizardKey === 'contact') {
    const acct = processAccountSection(env, plan, ts, user, statements);
    if (acct.error) return json({ ok: false, error: acct.error }, 400);
    const ctc = processContactSection(env, plan, acct.accountId, ts, user, statements);
    if (ctc.error) return json({ ok: false, error: ctc.error }, 400);

    if (aiInboxEntryId) {
      statements.push(linkStmt(env.DB, aiInboxEntryId,
        acct.createdNew ? 'create_account' : 'link_to_account',
        'account', acct.accountId, acct.accountLabel, user));
      if (ctc.createdNew) {
        statements.push(linkStmt(env.DB, aiInboxEntryId,
          'create_contact', 'contact', ctc.contactId, ctc.contactLabel, user));
      }
    }

    await batch(env.DB, statements);

    // Pick the destination: when the cascade created a brand-new
    // account, land the user there — they'll see the new account in
    // full context with the new contact under it (Contacts tab).
    const redirect_url = acct.createdNew
      ? '/accounts/' + encodeURIComponent(acct.accountId)
      : '/contacts/' + encodeURIComponent(ctc.contactId);

    return json({
      ok: true,
      account_id: acct.accountId,
      account_label: acct.accountLabel,
      contact_id: ctc.contactId,
      contact_label: ctc.contactLabel,
      created_new_account: acct.createdNew,
      created_new_contact: ctc.createdNew,
      redirect_url,
    });
  }

  // ---- account wizard: account only ----
  if (wizardKey === 'account') {
    const acct = processAccountSection(env, plan, ts, user, statements);
    if (acct.error) return json({ ok: false, error: acct.error }, 400);

    if (aiInboxEntryId) {
      statements.push(linkStmt(env.DB, aiInboxEntryId,
        acct.createdNew ? 'create_account' : 'link_to_account',
        'account', acct.accountId, acct.accountLabel, user));
    }

    await batch(env.DB, statements);

    return json({
      ok: true,
      account_id: acct.accountId,
      account_label: acct.accountLabel,
      created_new_account: acct.createdNew,
      redirect_url: '/accounts/' + encodeURIComponent(acct.accountId),
    });
  }

  return json({ ok: false, error: 'unsupported_wizard_key' }, 400);
}

// ----- per-section processors -------------------------------------
//
// Each takes the plan + the running statements array and appends the
// SQL statements needed to materialize that section. Returns an
// object with the resulting entity id (so dependent sections can
// reference it) plus a couple of metadata bits the handler needs.
// On invalid plans returns { error: '<code>' } and the handler
// surfaces that as a 400.

function processAccountSection(env, plan, ts, user, statements) {
  // The plan's `account` section may be missing entirely (e.g. a
  // contact-only plan with a pinned account from the prefill — caller
  // would already have an account_id and skip the section). For the
  // account wizard this is invalid; for the contact wizard we just
  // return null so the caller can decide what to do.
  if (!plan.account) {
    return { accountId: null, accountLabel: '', createdNew: false };
  }

  let accountId = plan.account.matched?.id || null;
  let accountLabel = plan.account.matched?.alias
    || plan.account.matched?.name
    || '';
  let createdNew = false;

  if (!accountId) {
    if (!plan.account.proposed_new || !plan.account.proposed_new.name) {
      return { error: 'no_account_target' };
    }
    const a = plan.account.proposed_new;
    accountId = uuid();
    accountLabel = a.alias || a.name;
    createdNew = true;

    // Optional fields come from push_candidates only — unchecking
    // means "don't include this on the new record."
    const addrCand = (plan.account.push_candidates || []).find((c) => c.field === 'address');
    const addressKind = pickAddressKind(addrCand);
    const addressForRow = addressKind ? addrCand.proposed : null;
    // Mirror the address into the right denormalized column.
    const addressBillingCol = (addressKind === 'billing' || addressKind === 'both') ? addrCand.proposed : null;
    const addressPhysicalCol = (addressKind === 'physical' || addressKind === 'both') ? addrCand.proposed : null;
    const phoneFromPlan = pickChecked(plan.account.push_candidates, 'phone');
    const websiteFromPlan = pickChecked(plan.account.push_candidates, 'website');

    statements.push(stmt(env.DB,
      `INSERT INTO accounts
         (id, name, alias, segment, address_billing, address_physical,
          phone, website, notes, owner_user_id, is_active,
          created_at, updated_at, created_by_user_id)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, NULL, ?, 1, ?, ?, ?)`,
      [accountId, a.name, a.alias || a.name, addressBillingCol, addressPhysicalCol, phoneFromPlan, websiteFromPlan, user.id, ts, ts, user.id]));

    if (addressForRow) {
      statements.push(stmt(env.DB,
        `INSERT INTO account_addresses
           (id, account_id, kind, label, address, is_default, notes, created_at, updated_at)
         VALUES (?, ?, ?, NULL, ?, 1, NULL, ?, ?)`,
        [uuid(), accountId, addressKind, addressForRow, ts, ts]));
    }

    statements.push(auditStmt(env.DB, {
      entityType: 'account',
      entityId: accountId,
      eventType: 'created',
      user,
      summary: `Created account "${a.name}" via Smart-start`,
      changes: { name: { from: null, to: a.name }, source: { from: null, to: 'wizard_smart_start' } },
    }));
  } else {
    // Account exists. Apply checked push_candidates.
    const updates = {};
    for (const c of (plan.account.push_candidates || [])) {
      if (c.field === 'address') {
        const kind = pickAddressKind(c);
        if (!kind) continue;
        statements.push(stmt(env.DB,
          `INSERT INTO account_addresses
             (id, account_id, kind, label, address, is_default, notes, created_at, updated_at)
           VALUES (?, ?, ?, NULL, ?, 0, NULL, ?, ?)`,
          [uuid(), accountId, kind, c.proposed, ts, ts]));
        continue;
      }
      if (!c.checked) continue;
      if (ACCOUNT_PUSH_COLUMNS.has(c.field)) {
        updates[c.field] = c.proposed;
      }
    }
    if (Object.keys(updates).length > 0) {
      const sets = Object.keys(updates).map((k) => `${k} = ?`).join(', ');
      const vals = Object.keys(updates).map((k) => updates[k]);
      vals.push(ts, accountId);
      statements.push(stmt(env.DB,
        `UPDATE accounts SET ${sets}, updated_at = ? WHERE id = ?`,
        vals));
      statements.push(auditStmt(env.DB, {
        entityType: 'account',
        entityId: accountId,
        eventType: 'updated',
        user,
        summary: `Pushed Smart-start fields to "${accountLabel}"`,
        changes: Object.fromEntries(Object.entries(updates).map(([k, v]) => [k, { from: null, to: v }])),
      }));
    }
  }

  return { accountId, accountLabel, createdNew };
}

function processContactSection(env, plan, accountId, ts, user, statements) {
  if (!plan.contact) {
    return { contactId: null, contactLabel: '', createdNew: false };
  }

  let contactId = plan.contact.matched?.id || null;
  let contactLabel = '';
  let createdNew = false;

  if (!contactId) {
    const c = plan.contact.proposed_new;
    if (!c || (!c.first_name && !c.last_name)) {
      return { error: 'no_contact_target' };
    }
    if (!accountId) {
      // Can't create a contact without an account_id; the cascade
      // upstream should have produced one.
      return { error: 'no_account_for_contact' };
    }
    contactId = uuid();
    contactLabel = `${c.first_name || ''} ${c.last_name || ''}`.trim() || '(unnamed)';
    createdNew = true;
    const titleCand = pickChecked(plan.contact.push_candidates, 'title');
    const emailCand = pickChecked(plan.contact.push_candidates, 'email');
    const phoneCand = pickChecked(plan.contact.push_candidates, 'phone');
    const linkedinCand = pickChecked(plan.contact.push_candidates, 'linkedin_url');
    statements.push(stmt(env.DB,
      `INSERT INTO contacts
         (id, account_id, first_name, last_name, title, email, phone, mobile,
          is_primary, notes, linkedin_url, linkedin_url_source,
          created_at, updated_at, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL, ?, ?, ?, ?, ?)`,
      [
        contactId,
        accountId,
        c.first_name || null,
        c.last_name || null,
        titleCand,
        emailCand,
        phoneCand,
        linkedinCand,
        linkedinCand ? 'ai_suggested' : null,
        ts,
        ts,
        user.id,
      ]));
    statements.push(auditStmt(env.DB, {
      entityType: 'contact',
      entityId: contactId,
      eventType: 'created',
      user,
      summary: `Created contact "${contactLabel}" via Smart-start`,
      changes: { name: { from: null, to: contactLabel }, source: { from: null, to: 'wizard_smart_start' } },
    }));
  } else {
    contactLabel = `${plan.contact.matched.first_name || ''} ${plan.contact.matched.last_name || ''}`.trim();
    const updates = {};
    for (const c of (plan.contact.push_candidates || [])) {
      if (!c.checked) continue;
      if (CONTACT_PUSH_COLUMNS.has(c.field)) {
        updates[c.field] = c.proposed;
        if (c.field === 'linkedin_url') updates.linkedin_url_source = 'ai_suggested';
      }
    }
    if (Object.keys(updates).length > 0) {
      const sets = Object.keys(updates).map((k) => `${k} = ?`).join(', ');
      const vals = Object.keys(updates).map((k) => updates[k]);
      vals.push(ts, contactId);
      statements.push(stmt(env.DB,
        `UPDATE contacts SET ${sets}, updated_at = ? WHERE id = ?`,
        vals));
      statements.push(auditStmt(env.DB, {
        entityType: 'contact',
        entityId: contactId,
        eventType: 'updated',
        user,
        summary: `Pushed Smart-start fields to "${contactLabel}"`,
        changes: Object.fromEntries(Object.entries(updates).map(([k, v]) => [k, { from: null, to: v }])),
      }));
    }
  }

  return { contactId, contactLabel, createdNew };
}

// ----- helpers ----------------------------------------------------

function pickChecked(candidates, field) {
  const c = (candidates || []).find((x) => x.field === field && x.checked);
  return c ? c.proposed : null;
}

// For an address candidate, return the chosen kind based on the
// physical/billing toggles, or null if both are off (skip this row).
function pickAddressKind(candidate) {
  if (!candidate) return null;
  const phys = !!candidate.address_physical;
  const bill = !!candidate.address_billing;
  if (phys && bill) return 'both';
  if (phys) return 'physical';
  if (bill) return 'billing';
  return null;
}

function linkStmt(db, itemId, actionType, refType, refId, refLabel, user) {
  return stmt(db,
    `INSERT INTO ai_inbox_links
       (id, item_id, action_type, ref_type, ref_id, ref_label, created_at, created_by_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuid(), itemId, actionType, refType, refId, refLabel || null, now(), user?.id || null]);
}
