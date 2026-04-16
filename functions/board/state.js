// functions/board/state.js
//
// GET /board/state
//
// Single round-trip endpoint polled by the sidebar every 30s. Returns:
//   {
//     prefs:        { module_order, module_collapsed, hidden_until },
//     server_time:  ISO-8601 now (client uses this for snooze calc),
//     modules: {
//       my_tasks:        [ ...pending tasks assigned to me ],
//       my_tasks_done:   [ ...recently completed tasks (last 14 days) ],
//       my_notes:        [ ...my private cards ],
//       shared:          [ ...public cards ],
//       mentions:        [ ...messages relevant to me — direct broadcasts,
//                            direct-to/from-me, or public mentioning me ]
//     }
//   }
//
// Each note-type module row carries its author display info and a
// parsed `refs` array. my_tasks rows are raw activities (no refs).

import { all } from '../lib/db.js';
import { getPrefs } from '../lib/board.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

const CARD_SELECT_COLS = `
  c.id, c.author_user_id, c.scope, c.target_user_id, c.body,
  c.color, c.flag, c.pinned, c.snooze_until, c.created_at, c.updated_at,
  u.display_name AS author_display_name, u.email AS author_email`;

export async function onRequestGet(context) {
  const { env, data } = context;
  const user = data?.user;
  if (!user || !user.id) return json({ error: 'unauthenticated' }, 401);

  const nowIso = new Date().toISOString();

  // Recently-completed window for the "show complete" toggle in the
  // tasks zone. 14 days is generous enough to feel useful, tight
  // enough to keep the payload small.
  const completedSinceIso = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString();

  const [prefs, myTasks, myTasksDone, myNotes, shared, mentions] = await Promise.all([
    getPrefs(env.DB, user.id),

    all(env.DB,
      `SELECT id, subject, body, due_at, remind_at, status, completed_at,
              opportunity_id, quote_id, account_id
         FROM activities
        WHERE assigned_user_id = ?
          AND status = 'pending'
          AND type = 'task'
        ORDER BY
          CASE WHEN due_at IS NULL THEN 1 ELSE 0 END,
          due_at ASC,
          created_at DESC
        LIMIT 50`,
      [user.id]),

    all(env.DB,
      `SELECT id, subject, body, due_at, remind_at, status, completed_at,
              opportunity_id, quote_id, account_id
         FROM activities
        WHERE assigned_user_id = ?
          AND status = 'completed'
          AND type = 'task'
          AND completed_at >= ?
        ORDER BY completed_at DESC
        LIMIT 30`,
      [user.id, completedSinceIso]),

    all(env.DB,
      `SELECT ${CARD_SELECT_COLS}
         FROM board_cards c
         LEFT JOIN users u ON u.id = c.author_user_id
        WHERE c.scope = 'private'
          AND c.author_user_id = ?
          AND c.archived_at IS NULL
          AND (c.snooze_until IS NULL OR c.snooze_until < ?)
        ORDER BY c.pinned DESC, c.created_at DESC
        LIMIT 50`,
      [user.id, nowIso]),

    all(env.DB,
      `SELECT ${CARD_SELECT_COLS}
         FROM board_cards c
         LEFT JOIN users u ON u.id = c.author_user_id
        WHERE c.scope = 'public'
          AND c.archived_at IS NULL
          AND (c.snooze_until IS NULL OR c.snooze_until < ?)
        ORDER BY c.pinned DESC, c.created_at DESC
        LIMIT 50`,
      [nowIso]),

    all(env.DB,
      `SELECT ${CARD_SELECT_COLS}
         FROM board_cards c
         LEFT JOIN users u ON u.id = c.author_user_id
        WHERE c.archived_at IS NULL
          AND (c.snooze_until IS NULL OR c.snooze_until < ?)
          AND (
            -- Direct chat: broadcasts (NULL target) are visible to
            -- everyone; targeted DMs only to author or recipient.
            (c.scope = 'direct' AND (
              c.target_user_id IS NULL
              OR c.target_user_id = ?
              OR c.author_user_id = ?
            ))
            OR (
              c.scope = 'public'
              AND EXISTS (
                SELECT 1 FROM board_card_refs r
                 WHERE r.card_id = c.id AND r.ref_type = 'user' AND r.ref_id = ?
              )
            )
          )
        ORDER BY c.pinned DESC, c.created_at DESC
        LIMIT 100`,
      [nowIso, user.id, user.id, user.id]),
  ]);

  // Bundle refs for all note-type cards in one query, fan out client-side.
  const noteCards = [...myNotes, ...shared, ...mentions];
  const refsById = await loadRefs(env.DB, noteCards.map((c) => c.id));
  for (const c of noteCards) {
    c.refs = refsById[c.id] || [];
  }

  return json({
    prefs,
    server_time: nowIso,
    user: {
      id: user.id,
      display_name: user.display_name || '',
      email: user.email || '',
    },
    modules: {
      my_tasks: myTasks,
      my_tasks_done: myTasksDone,
      my_notes: myNotes,
      shared,
      mentions,
    },
  });
}

async function loadRefs(db, cardIds) {
  if (!cardIds || cardIds.length === 0) return {};
  const placeholders = cardIds.map(() => '?').join(',');
  const rows = await all(
    db,
    `SELECT card_id, ref_type, ref_id
       FROM board_card_refs
      WHERE card_id IN (${placeholders})`,
    cardIds
  );
  const byId = Object.create(null);
  for (const r of rows) {
    (byId[r.card_id] = byId[r.card_id] || []).push({
      ref_type: r.ref_type,
      ref_id: r.ref_id,
    });
  }
  return byId;
}
