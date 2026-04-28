// functions/ai-inbox/lib/push-helpers.js
//
// Helpers shared by /push/* routes. Push semantics:
//   - A "push" takes a piece of an entry (the transcript/summary, an
//     action_item, a phone number, an email, an attachment) and writes
//     it onto a real CRM row (account / contact / opportunity / etc).
//   - Every push auto-associates: if there isn't already an
//     ai_inbox_links row pointing this entry at that target, we write
//     one (action_type='link_to_<ref_type>'). The push itself is also
//     recorded as a separate ai_inbox_links row with a richer
//     action_type so the entry's actions panel can group "what got
//     pushed to OPP-1234" together.
//
// All push routes call ensureAssociateAndRecordPush() which returns
// { associateLink, pushLink } so the caller can hand both back to
// the client and update its in-memory state in one shot.

import { one, stmt } from '../../lib/db.js';
import { uuid, now } from '../../lib/ids.js';

const ASSOCIATE_ACTION_BY_REF_TYPE = {
  account: 'link_to_account',
  contact: 'link_to_contact',
  opportunity: 'link_to_opportunity',
  quote: 'link_to_quote',
  job: 'link_to_job',
};

/**
 * Build the prepared statements that record a push action plus, when
 * needed, an auto-associate. Returned as an array of D1
 * PreparedStatement so the caller can compose them into a single
 * batch() with the actual CRM mutation (the activity insert, the
 * contact UPDATE, etc).
 *
 * Inputs:
 *   db         — env.DB
 *   user       — context.data.user (for created_by_user_id)
 *   entry_id   — the ai_inbox_items.id
 *   push       — { action_type, ref_type, ref_id, ref_label }
 *   alreadyAssociated — boolean (caller pre-queries to decide)
 *
 * Returns: { associateLinkRow, pushLinkRow, statements }
 *   - associateLinkRow: { id, action_type, ref_type, ref_id, ref_label, created_at } or null when already associated
 *   - pushLinkRow: same shape, the push action itself
 *   - statements: array of D1 PreparedStatement to add to the caller's batch
 */
export function buildPushLinkStatements(db, user, entry_id, push, alreadyAssociated) {
  const ts = now();
  const statements = [];
  let associateLinkRow = null;

  if (!alreadyAssociated) {
    const associateAction = ASSOCIATE_ACTION_BY_REF_TYPE[push.ref_type];
    if (associateAction) {
      const associateId = uuid();
      associateLinkRow = {
        id: associateId,
        action_type: associateAction,
        ref_type: push.ref_type,
        ref_id: push.ref_id,
        ref_label: push.ref_label,
        created_at: ts,
      };
      statements.push(stmt(db,
        `INSERT INTO ai_inbox_links
           (id, item_id, action_type, ref_type, ref_id, ref_label, created_at, created_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [associateId, entry_id, associateAction, push.ref_type, push.ref_id, push.ref_label, ts, user.id]));
    }
  }

  const pushId = uuid();
  const pushLinkRow = {
    id: pushId,
    action_type: push.action_type,
    ref_type: push.ref_type,
    ref_id: push.ref_id,
    ref_label: push.ref_label,
    created_at: ts,
  };
  statements.push(stmt(db,
    `INSERT INTO ai_inbox_links
       (id, item_id, action_type, ref_type, ref_id, ref_label, created_at, created_by_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [pushId, entry_id, push.action_type, push.ref_type, push.ref_id, push.ref_label, ts, user.id]));

  return { associateLinkRow, pushLinkRow, statements };
}

/**
 * Look up whether this entry already has an associate-link to the
 * given (ref_type, ref_id). Used by push routes to decide whether
 * they need to ALSO write the associate row.
 */
export async function isAlreadyAssociated(db, entry_id, ref_type, ref_id) {
  const associateAction = ASSOCIATE_ACTION_BY_REF_TYPE[ref_type];
  if (!associateAction) return false;
  const row = await one(db,
    `SELECT id FROM ai_inbox_links
      WHERE item_id = ? AND action_type = ? AND ref_type = ? AND ref_id = ?
      LIMIT 1`,
    [entry_id, associateAction, ref_type, ref_id]);
  return !!row;
}

/**
 * Verify (a) the entry exists and is owned by the user, and
 * (b) the target entity (ref_type, ref_id) exists and look up a
 * sensible display label for it. Returns { entry, refLabel } or null
 * if either lookup fails.
 *
 * ref_type must be one of 'account' | 'contact' | 'opportunity'.
 * Quote / job lookups can be added when those become first-class
 * push targets.
 */
export async function loadPushContext(env, user, entry_id, ref_type, ref_id) {
  const entry = await one(env.DB,
    'SELECT id, extracted_json FROM ai_inbox_items WHERE id = ? AND user_id = ?',
    [entry_id, user.id]);
  if (!entry) return { error: 'entry_not_found', status: 404 };

  let target;
  let refLabel;
  if (ref_type === 'account') {
    target = await one(env.DB,
      'SELECT id, name, alias FROM accounts WHERE id = ?', [ref_id]);
    if (!target) return { error: 'account_not_found', status: 404 };
    refLabel = (user?.show_alias && target.alias) ? target.alias : target.name;
  } else if (ref_type === 'contact') {
    target = await one(env.DB,
      `SELECT c.id, c.first_name, c.last_name, a.name AS account_name, a.alias AS account_alias
         FROM contacts c LEFT JOIN accounts a ON a.id = c.account_id
        WHERE c.id = ?`, [ref_id]);
    if (!target) return { error: 'contact_not_found', status: 404 };
    const fullName = `${target.first_name || ''} ${target.last_name || ''}`.trim() || '(unnamed)';
    const orgPart = target.account_name ? ` · ${(user?.show_alias && target.account_alias) ? target.account_alias : target.account_name}` : '';
    refLabel = fullName + orgPart;
  } else if (ref_type === 'opportunity') {
    target = await one(env.DB,
      `SELECT o.id, o.number, o.title, a.name AS account_name, a.alias AS account_alias
         FROM opportunities o LEFT JOIN accounts a ON a.id = o.account_id
        WHERE o.id = ?`, [ref_id]);
    if (!target) return { error: 'opportunity_not_found', status: 404 };
    const acctPart = target.account_name ? ` · ${(user?.show_alias && target.account_alias) ? target.account_alias : target.account_name}` : '';
    refLabel = `OPP-${target.number}${target.title ? ' · ' + target.title : ''}${acctPart}`;
  } else {
    return { error: 'bad_ref_type', status: 400 };
  }

  return { entry, target, refLabel };
}
