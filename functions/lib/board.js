// functions/lib/board.js
//
// Shared helpers for the board sidebar routes under /functions/board/.
//
// - parseRefs()     : pull @[type:id|label] markers out of a card body
// - rewriteCardRefs(): replace all refs for a card atomically
// - getPrefs() / savePrefs(): per-user sidebar preferences

import { all, run, stmt, batch } from './db.js';
import { now } from './ids.js';

// Markers are inserted into the body text by the sidebar's @-autocomplete
// (js/board-sidebar.js) when the user picks a suggestion. On render the
// sidebar replaces these with styled pills; on save the server parses
// them out into board_card_refs rows.
//
// Format: @[<ref_type>:<ref_id>|<display_label>]
//   ref_type : 'user' | 'opportunity' | 'quote' | 'account' | 'document'
//   ref_id   : UUID of the referenced row
//   label    : display text (pipe and right-bracket are the only chars
//              we forbid in the label — everything else is fine)
const REF_MARKER_RE = /@\[(user|opportunity|quote|account|document):([^|\]]+)\|([^\]]*)\]/g;

const VALID_COLORS = ['yellow', 'pink', 'blue', 'green', 'orange', 'white'];
const VALID_FLAGS = ['red', 'yellow', 'green'];
const VALID_SCOPES = ['private', 'public', 'direct'];

const DEFAULT_MODULE_ORDER = ['my_tasks', 'my_notes', 'shared', 'mentions'];
const DEFAULT_MODULE_COLLAPSED = {
  my_tasks: false,
  my_notes: false,
  shared: false,
  mentions: false,
};

/**
 * Extract a de-duplicated list of { ref_type, ref_id } from a card body.
 */
export function parseRefs(body) {
  if (!body) return [];
  const out = [];
  const seen = Object.create(null);
  REF_MARKER_RE.lastIndex = 0;
  let m;
  while ((m = REF_MARKER_RE.exec(body)) !== null) {
    const key = `${m[1]}:${m[2]}`;
    if (seen[key]) continue;
    seen[key] = true;
    out.push({ ref_type: m[1], ref_id: m[2] });
  }
  return out;
}

/**
 * Replace the refs for one card atomically. Deletes existing rows for
 * card_id then inserts the fresh set. Idempotent and safe to call on
 * every save — D1 batches to a single transaction.
 */
export async function rewriteCardRefs(db, cardId, refs) {
  const stmts = [stmt(db, 'DELETE FROM board_card_refs WHERE card_id = ?', [cardId])];
  for (const r of refs) {
    stmts.push(stmt(
      db,
      'INSERT INTO board_card_refs (card_id, ref_type, ref_id) VALUES (?, ?, ?)',
      [cardId, r.ref_type, r.ref_id]
    ));
  }
  await batch(db, stmts);
}

/**
 * Load a user's sidebar preferences. Returns defaults if no row exists
 * (we don't insert on read — first PATCH /board/prefs upserts).
 */
export async function getPrefs(db, userId) {
  const rows = await all(
    db,
    `SELECT module_order, module_collapsed, hidden_until
       FROM board_user_prefs
      WHERE user_id = ?`,
    [userId]
  );
  if (rows.length === 0) {
    return {
      module_order: DEFAULT_MODULE_ORDER.slice(),
      module_collapsed: { ...DEFAULT_MODULE_COLLAPSED },
      hidden_until: null,
    };
  }
  const r = rows[0];
  return {
    module_order: safeJsonParse(r.module_order, DEFAULT_MODULE_ORDER.slice()),
    module_collapsed: safeJsonParse(r.module_collapsed, { ...DEFAULT_MODULE_COLLAPSED }),
    hidden_until: r.hidden_until || null,
  };
}

/**
 * Upsert a user's sidebar preferences. Accepts a partial patch (any
 * subset of module_order / module_collapsed / hidden_until) and merges
 * with the existing row (or defaults).
 */
export async function savePrefs(db, userId, patch) {
  const current = await getPrefs(db, userId);
  const merged = {
    module_order: Array.isArray(patch.module_order) ? patch.module_order : current.module_order,
    module_collapsed: patch.module_collapsed && typeof patch.module_collapsed === 'object'
      ? { ...current.module_collapsed, ...patch.module_collapsed }
      : current.module_collapsed,
    hidden_until: 'hidden_until' in patch ? patch.hidden_until : current.hidden_until,
  };

  const ts = now();
  const existing = await all(
    db,
    'SELECT user_id FROM board_user_prefs WHERE user_id = ?',
    [userId]
  );

  if (existing.length > 0) {
    await run(
      db,
      `UPDATE board_user_prefs
          SET module_order = ?, module_collapsed = ?, hidden_until = ?, updated_at = ?
        WHERE user_id = ?`,
      [
        JSON.stringify(merged.module_order),
        JSON.stringify(merged.module_collapsed),
        merged.hidden_until,
        ts,
        userId,
      ]
    );
  } else {
    await run(
      db,
      `INSERT INTO board_user_prefs
         (user_id, module_order, module_collapsed, hidden_until, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        userId,
        JSON.stringify(merged.module_order),
        JSON.stringify(merged.module_collapsed),
        merged.hidden_until,
        ts,
      ]
    );
  }

  return merged;
}

/**
 * Validate + normalize card color. Returns default ('yellow') for
 * unknown values rather than throwing — keeps the API forgiving.
 */
export function normalizeColor(c) {
  return VALID_COLORS.indexOf(c) >= 0 ? c : 'yellow';
}

/**
 * Validate + normalize flag value. NULL / unknown => null (no flag).
 */
export function normalizeFlag(f) {
  if (!f) return null;
  return VALID_FLAGS.indexOf(f) >= 0 ? f : null;
}

/**
 * Validate card scope. Throws Error for unknown — scope is required
 * at create time, so unknown values should fail loudly.
 */
export function validateScope(s) {
  if (VALID_SCOPES.indexOf(s) < 0) {
    throw new Error(`Invalid scope: ${s}`);
  }
  return s;
}

export { DEFAULT_MODULE_ORDER, DEFAULT_MODULE_COLLAPSED, VALID_COLORS, VALID_FLAGS };

function safeJsonParse(s, fallback) {
  if (!s) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}
