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
 *
 * Optional fields:
 * - `defaultEnabled: false` — bootstrap the row with enabled=0 instead
 *   of 1. Use for tools that are intentionally shipped-but-off so Wes
 *   has to explicitly opt in (e.g. high-blast-radius ops like merging
 *   accounts, or experimental features under evaluation).
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
    description: 'Edit opportunity fields — title, description, value, expected close date, BANT, RFQ dates, owner, etc. Stage transitions go through change_opportunity_stage so the auto-task chain fires.',
  },
  {
    action: 'change_opportunity_stage',
    category: 'opportunities',
    label: 'Move opportunities through stages',
    description: 'Advance (or, with a reason, regress) an opportunity through its stage workflow — e.g. lead → rfq_received → quote_drafted → quote_submitted. Calls the same code path as the manual stage button so the auto-task chain fires correctly. Terminal stages (closed_won / closed_lost) require a reason.',
  },
  // quotes (shell only — no line items via Claudia yet)
  {
    action: 'create_quote_draft',
    category: 'quotes',
    label: 'Draft new quotes (shell)',
    description: 'Open a new quote in draft status under an existing opportunity. Header only — no line items via Claudia yet (she can still suggest the line list in chat for the user to enter manually). Auto-syncs the opp stage to quote_drafted, mirroring the manual quote-create flow.',
  },
  // jobs (post-sale execution records)
  {
    action: 'create_job',
    category: 'jobs',
    label: 'Create jobs',
    description: 'Open a new job under a won opportunity. Bare-metadata creation — name, opp link, type, PO number — without milestones (those come from quotes when they\'re accepted). One job per opportunity is enforced; duplicates are rejected.',
  },
  // documents
  {
    action: 'set_document_retention',
    category: 'documents',
    label: 'Change document retention',
    description: 'Pin a dropped document as keep_forever, mark it auto, or trash it. Low-risk, but gated for consistency.',
  },
  {
    action: 'set_document_category',
    category: 'documents',
    label: 'Categorize documents',
    description: 'Label a dropped document with a category (RFQ, spec sheet, contact list, meeting note, badge photo, etc.). Free-form text — no enum yet. Helpful for searches and cleanups, but not yet wired into the rest of the app.',
    defaultEnabled: false,
  },
  // auto-task rule firing — manually trigger a rule chain when the
  // natural event didn\'t fire (rare but useful for cleanup).
  {
    action: 'fire_auto_task_chain',
    category: 'auto_tasks',
    label: 'Fire auto-task chains manually',
    description: 'Re-fire an auto-task rule chain against an entity (opp, quote, task, job) by event_type. Use only when the natural trigger missed for a specific entity — firing a chain that already ran will create duplicate tasks. Powerful and easy to misuse, hence default-off.',
    defaultEnabled: false,
  },
  // account / contact merging (consolidate duplicate rows)
  {
    action: 'merge_accounts',
    category: 'merging',
    label: 'Merge duplicate accounts',
    description: 'Consolidate two account rows: repoints all foreign-key references (contacts, opps, activities, documents) from the loser onto the winner, then deletes the loser. NOT undoable via undo_claudia_write — to reverse, manually re-create the loser and split the children. Default-off; turn on only when actively de-duping.',
    defaultEnabled: false,
  },
  {
    action: 'merge_contacts',
    category: 'merging',
    label: 'Merge duplicate contacts',
    description: 'Consolidate two contact rows: repoints all foreign-key references (opportunities.primary_contact_id, opportunities.bant_authority_contact_id, activities.contact_id, documents.contact_id) from the loser onto the winner, then deletes the loser. NOT undoable. Default-off.',
    defaultEnabled: false,
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
    blurb: 'Mutations on the opportunities table. Stage transitions get their own toggle because they fire the auto-task chain — gate them separately from plain field edits.',
  },
  {
    key: 'quotes',
    label: 'Quotes',
    blurb: 'Quote drafting only — Claudia can open a draft shell, but issuing / revising / OC / NTP still belong to humans. Lines are not exposed; she can suggest a line list in chat for you to enter.',
  },
  {
    key: 'jobs',
    label: 'Jobs',
    blurb: 'Post-sale execution records. Claudia can open a job under a won opportunity; milestones come from quote acceptance, not from her.',
  },
  {
    key: 'documents',
    label: 'Documents',
    blurb: 'Mutations against Claudia\'s drop-zone (claudia_documents). Does not include creating documents — those land via the upload endpoint.',
  },
  {
    key: 'auto_tasks',
    label: 'Auto-tasks',
    blurb: 'Manual control over the auto-task rule engine. Fire a chain only when the natural trigger missed; firing a chain that already ran will create duplicate tasks.',
  },
  {
    key: 'merging',
    label: 'Merging (deduplication)',
    blurb: 'Consolidate duplicate accounts or contacts into one row. Repoints every FK reference and deletes the loser. NOT undoable — only enable when actively de-duping.',
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
    const initialEnabled = entry.defaultEnabled === false ? 0 : 1;
    await run(
      env.DB,
      `INSERT OR IGNORE INTO claudia_permissions
         (action, enabled, category, label, description, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [entry.action, initialEnabled, entry.category, entry.label, entry.description, ts]
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
