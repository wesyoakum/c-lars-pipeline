// functions/wizards/execute.js
//
// POST /wizards/execute
//
// Executes a Smart-start cascade plan (produced by /wizards/plan and
// reviewed/edited by the user). All operations run in a single D1
// batch so partial failure rolls back cleanly.
//
// Body (JSON, contact-shaped — Phase 5a):
//   {
//     wizard_key: 'contact',
//     ai_inbox_entry_id?: '<uuid>',
//     plan: {
//       account: {
//         matched: { id } | null,
//         proposed_new: { name, alias, phone, website, address } | null,
//         push_candidates: [{ field, proposed, checked }],
//       },
//       contact: {
//         matched: { id } | null,
//         proposed_new: { first_name, last_name, title, email, phone, linkedin_url } | null,
//         push_candidates: [{ field, proposed, checked }],
//       },
//     },
//   }
//
// Response:
//   { ok: true, account_id, contact_id, redirect_url }
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

export async function onRequestPost(context) {
  const { env, data, request } = context;
  const user = data?.user;
  if (!user) return json({ ok: false, error: 'unauthenticated' }, 401);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: 'invalid_json' }, 400); }

  const wizardKey = String(body?.wizard_key || '').trim();
  if (wizardKey !== 'contact') {
    return json({ ok: false, error: 'unsupported_wizard_key' }, 400);
  }

  const plan = body?.plan;
  if (!plan || typeof plan !== 'object') {
    return json({ ok: false, error: 'plan_required' }, 400);
  }

  const ts = now();
  const statements = [];

  // ---- Account: existing or new ----
  let accountId = plan.account?.matched?.id || null;
  let accountLabel = plan.account?.matched?.alias
    || plan.account?.matched?.name
    || '';
  let createdNewAccount = false;

  if (!accountId) {
    if (!plan.account?.proposed_new || !plan.account.proposed_new.name) {
      return json({ ok: false, error: 'no_account_target' }, 400);
    }
    const a = plan.account.proposed_new;
    accountId = uuid();
    accountLabel = a.alias || a.name;
    createdNewAccount = true;
    // Optional fields come from push_candidates only — unchecking
    // means "don't include this on the new record." (This is why
    // proposed_new also carries phone/website/address: it's a copy of
    // what the LLM saw, but the executor doesn't read those — it
    // reads push_candidates so unchecks actually stick.)
    const addressForCol = pickChecked(plan.account.push_candidates, 'address');
    const phoneFromPlan = pickChecked(plan.account.push_candidates, 'phone');
    const websiteFromPlan = pickChecked(plan.account.push_candidates, 'website');

    statements.push(stmt(env.DB,
      `INSERT INTO accounts
         (id, name, alias, segment, address_billing, address_physical,
          phone, website, notes, owner_user_id, is_active,
          created_at, updated_at, created_by_user_id)
       VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, NULL, ?, 1, ?, ?, ?)`,
      [accountId, a.name, a.alias || a.name, addressForCol, phoneFromPlan, websiteFromPlan, user.id, ts, ts, user.id]));

    // Address row (separate table). Only insert when there's a
    // checked address; the denormalized column above mirrors it.
    if (addressForCol) {
      statements.push(stmt(env.DB,
        `INSERT INTO account_addresses
           (id, account_id, kind, label, address, is_default, notes, created_at, updated_at)
         VALUES (?, ?, 'physical', NULL, ?, 1, NULL, ?, ?)`,
        [uuid(), accountId, addressForCol, ts, ts]));
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
      if (!c.checked) continue;
      if (c.field === 'address') {
        // Add a new row in account_addresses (don't overwrite existing).
        statements.push(stmt(env.DB,
          `INSERT INTO account_addresses
             (id, account_id, kind, label, address, is_default, notes, created_at, updated_at)
           VALUES (?, ?, 'physical', NULL, ?, 0, NULL, ?, ?)`,
          [uuid(), accountId, c.proposed, ts, ts]));
        continue;
      }
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

  // ---- Contact: existing or new ----
  let contactId = plan.contact?.matched?.id || null;
  let contactLabel = '';
  let createdNewContact = false;

  if (!contactId) {
    const c = plan.contact?.proposed_new;
    if (!c || (!c.first_name && !c.last_name)) {
      return json({ ok: false, error: 'no_contact_target' }, 400);
    }
    contactId = uuid();
    contactLabel = `${c.first_name || ''} ${c.last_name || ''}`.trim() || '(unnamed)';
    createdNewContact = true;
    // Optional fields come from push_candidates (same model as
    // accounts above — unchecking strips the field from the INSERT).
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
    // Apply checked push_candidates to existing contact.
    const updates = {};
    for (const c of (plan.contact.push_candidates || [])) {
      if (!c.checked) continue;
      if (CONTACT_PUSH_COLUMNS.has(c.field)) {
        updates[c.field] = c.proposed;
        // LinkedIn carries a source flip when pushed from AI.
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

  // ---- AI Inbox link rows ----
  const aiInboxEntryId = body?.ai_inbox_entry_id || plan.ai_inbox_entry_id || null;
  if (aiInboxEntryId) {
    if (createdNewAccount) {
      statements.push(linkStmt(env.DB, aiInboxEntryId, 'create_account', 'account', accountId, accountLabel, user));
    } else {
      statements.push(linkStmt(env.DB, aiInboxEntryId, 'link_to_account', 'account', accountId, accountLabel, user));
    }
    if (createdNewContact) {
      statements.push(linkStmt(env.DB, aiInboxEntryId, 'create_contact', 'contact', contactId, contactLabel, user));
    } else {
      // We don't have a 'link_to_contact' action_type yet — record as
      // a generic create_contact "link" (which is allowed). A follow-up
      // pass can introduce link_to_contact if we want to distinguish.
    }
  }

  await batch(env.DB, statements);

  return json({
    ok: true,
    account_id: accountId,
    account_label: accountLabel,
    contact_id: contactId,
    contact_label: contactLabel,
    created_new_account: createdNewAccount,
    created_new_contact: createdNewContact,
    redirect_url: '/contacts/' + encodeURIComponent(contactId),
  });
}

function pickChecked(candidates, field) {
  const c = (candidates || []).find((x) => x.field === field && x.checked);
  return c ? c.proposed : null;
}

function linkStmt(db, itemId, actionType, refType, refId, refLabel, user) {
  return stmt(db,
    `INSERT INTO ai_inbox_links
       (id, item_id, action_type, ref_type, ref_id, ref_label, created_at, created_by_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuid(), itemId, actionType, refType, refId, refLabel || null, now(), user?.id || null]);
}
