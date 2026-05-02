// functions/lib/claudia-permissions.js
//
// Single source of truth for "what can Claudia do?". Each entry here is
// a tool whose use mutates Pipeline data — read-only tools (search,
// list, read, get_memory, etc.) are NOT gated and never appear in this
// catalog. Each entry corresponds to a row in the claudia_permissions
// table seeded by migration 0074; rows missing from the DB are inserted
// on the next GET /settings/claudia (defaulting to enabled=1) so adding
// a new tool only requires editing this file.
//
// Used by:
//   - functions/sandbox/assistant/tools.js — to filter the toolset sent
//     to Claude on each request, so disabled tools are invisible.
//   - functions/settings/claudia/index.js — to render the toggles page.
//   - functions/settings/claudia/toggle.js — to validate POSTed actions.

import { all, run } from './db.js';
import { now } from './ids.js';

/**
 * Catalog of permission-gated tools, in display order. Categories are
 * used to group the toggles on the settings page (one section per
 * category). Add a new entry here when adding a new write tool — the
 * settings page will pick it up on the next render and bootstrap the
 * row.
 */
export const PERMISSION_GATED_ACTIONS_CATALOG = [
  // accounts
  {
    action: 'create_account',
    category: 'accounts',
    label: 'Create accounts',
    description: 'Add new accounts (companies / customers). Required before creating a contact under a company that does not yet exist in Pipeline.',
  },
  {
    action: 'update_account',
    category: 'accounts',
    label: 'Update accounts',
    description: 'Edit account fields — name, alias, segment, parent group, addresses, website, notes, etc.',
  },
  // contacts
  {
    action: 'create_contact',
    category: 'contacts',
    label: 'Create contacts',
    description: 'Add new contacts under existing accounts. Used heavily by the contacts CSV import flow.',
  },
  {
    action: 'update_contact',
    category: 'contacts',
    label: 'Update contacts',
    description: 'Edit contact fields — name, email, phone, mobile, title, notes, account.',
  },
  // activities (tasks, calls, emails, meetings, notes)
  {
    action: 'create_activity',
    category: 'activities',
    label: 'Create activities (tasks)',
    description: 'Add a new task / call / meeting / note, optionally linked to an account, opportunity, or contact. Most often used to convert a commitment found in a meeting note or upload into a tracked task.',
  },
  {
    action: 'update_activity',
    category: 'activities',
    label: 'Update activities',
    description: 'Edit an activity\'s subject, body, due date, status, assignee, or links. Use to reassign, reschedule, clarify scope, or fix typos.',
  },
  {
    action: 'complete_activity',
    category: 'activities',
    label: 'Complete activities',
    description: 'Mark an activity as completed. Sugar around update_activity that sets status=completed and completed_at=now.',
  },
  // opportunities (deals)
  {
    action: 'create_opportunity',
    category: 'opportunities',
    label: 'Create opportunities',
    description: 'Open a new deal under an existing account. Auto-allocates the next opportunity number from the sequence; defaults to stage=lead, transaction_type=spares unless overridden.',
  },
  {
    action: 'update_opportunity',
    category: 'opportunities',
    label: 'Update opportunities',
    description: 'Edit opportunity fields — title, description, value, expected close date, BANT, RFQ dates, owner, etc. Stage transitions are NOT exposed here — use the dedicated stage endpoint to keep the auto-task chain consistent.',
  },
  // documents
  {
    action: 'set_document_retention',
    category: 'documents',
    label: 'Change document retention',
    description: 'Pin a dropped document as keep_forever, mark it auto, or trash it. Low-risk, but gated for consistency.',
  },
];

/**
 * Set of action names that are gated. Read-only tools (search / list /
 * read / get_memory / describe_schema / query_db) MUST NOT be in here —
 * they are always available regardless of claudia_permissions state.
 */
export const PERMISSION_GATED_ACTIONS = new Set(
  PERMISSION_GATED_ACTIONS_CATALOG.map((a) => a.action)
);

/**
 * Categories in display order, with a short blurb shown above each
 * group on the settings page.
 */
export const PERMISSION_CATEGORIES = [
  {
    key: 'accounts',
    label: 'Accounts',
    blurb: 'Mutations on the accounts table. Account writes cascade — deleting an account cascades to its contacts.',
  },
  {
    key: 'contacts',
    label: 'Contacts',
    blurb: 'Mutations on the contacts table. Contacts always belong to an account.',
  },
  {
    key: 'activities',
    label: 'Activities (tasks)',
    blurb: 'Mutations on the activities table — tasks, calls, meetings, notes. The activities surface is what other users (Kat, etc.) can already assign to Claudia, so giving her write access closes the loop on those.',
  },
  {
    key: 'opportunities',
    label: 'Opportunities',
    blurb: 'Mutations on the opportunities table. Stage transitions are intentionally NOT exposed here — those need to fire the auto-task chain via the regular stage endpoint, not a raw column write.',
  },
  {
    key: 'documents',
    label: 'Documents',
    blurb: 'Mutations against Claudia\'s drop-zone (claudia_documents). Does not include creating documents — those land via the upload endpoint.',
  },
];

/**
 * Read the action → enabled map from claudia_permissions. Missing rows
 * fall back to enabled=true so newly added tools work before the
 * settings page bootstraps a row. Errors fail open to the same default.
 *
 * Used by the chat tool resolver to decide which definitions to send
 * to Claude on each request. Always returns a plain object map.
 */
export async function loadPermissionMap(env) {
  try {
    const rows = await all(env.DB, 'SELECT action, enabled FROM claudia_permissions');
    const map = {};
    for (const r of rows) map[r.action] = r.enabled === 1;
    return map;
  } catch {
    return {};
  }
}

/**
 * Insert any missing catalog rows into claudia_permissions, defaulting
 * to enabled=1. Idempotent — uses INSERT OR IGNORE so existing rows
 * keep their current enabled state. Called by the settings page on
 * every GET so that adding a new tool to the catalog only requires
 * editing this file.
 *
 * Returns the full set of rows after the bootstrap (action, enabled,
 * updated_at, updated_by_user_id), keyed by action.
 */
export async function ensurePermissionRows(env) {
  const ts = now();
  for (const entry of PERMISSION_GATED_ACTIONS_CATALOG) {
    await run(
      env.DB,
      `INSERT OR IGNORE INTO claudia_permissions
         (action, enabled, category, label, description, updated_at)
       VALUES (?, 1, ?, ?, ?, ?)`,
      [entry.action, entry.category, entry.label, entry.description, ts]
    );
  }
  const rows = await all(
    env.DB,
    `SELECT cp.action, cp.enabled, cp.category, cp.label, cp.description,
            cp.updated_at, cp.updated_by_user_id, u.display_name AS updated_by_name
       FROM claudia_permissions cp
       LEFT JOIN users u ON u.id = cp.updated_by_user_id`
  );
  const map = {};
  for (const r of rows) map[r.action] = r;
  return map;
}
