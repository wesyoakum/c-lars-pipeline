// functions/activities/picker-data.js
//
// GET /activities/picker-data[?include_inactive=1]
//
// Returns the data needed to populate the shared wizard modal's pickers
// (user dropdown, opportunity picker, recent quote picker, account
// picker). Fetched lazily the first time the modal opens on a page.
//
// Active-only filtering (migration 0035):
//   - If the current user has the `active_only` pref on, the default
//     response only contains active records.
//   - If `?include_inactive=1` is set, all records come back and the
//     per-row `active` flag is 0 or 1 so the client can show them with
//     a visual marker (struck through, muted, etc.).
//   - If the pref is off, all records come back regardless (matches
//     pre-0035 behavior, plus annotations).
//
// Every record in opportunities / quotes / accounts carries an `active`
// field the client can filter on. The response also includes a
// `prefs.active_only` field so the wizard engine knows whether to hide
// inactive entries by default.
//
// Response shape:
//   {
//     current_user_id: 'uuid' | null,
//     users:         [ { id, display_name, email } ],
//     opportunities: [ { id, number, title, account_id, active } ],
//     quotes:        [ { id, number, title, active } ],
//     accounts:      [ { id, name, alias, parent_group, active } ],
//     groups:        [ { slug, label, member_ids } ],
//     prefs: { show_alias, group_rollup, active_only }
//   }

import { all } from '../lib/db.js';
import { buildAccountPickerGroups } from '../lib/account-groups.js';
import {
  ACTIVE_QUOTE_STATUSES,
  CLOSED_OPPORTUNITY_STAGES,
  isActiveOnly,
} from '../lib/activeness.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export async function onRequestGet(context) {
  const { env, data, request } = context;
  const user = data?.user;
  if (!user || !user.id) {
    return json({
      current_user_id: null,
      users: [],
      opportunities: [],
      quotes: [],
      accounts: [],
      groups: [],
      prefs: { show_alias: 0, group_rollup: 0, active_only: 0 },
    }, 200);
  }

  const url = new URL(request.url);
  const includeInactive = url.searchParams.get('include_inactive') === '1';
  const prefActive = isActiveOnly(user);
  const filterServerSide = prefActive && !includeInactive;

  // ---- Opportunities ----
  //
  // Active = non-closed stage AND (no quotes OR has active quote). We
  // compute the flag in SQL via a correlated sub-EXISTS rather than
  // post-processing in JS; the column comes back as 0 / 1 per row.
  //
  // When filterServerSide, we also drop the inactive rows entirely so
  // the LIMIT doesn't get consumed by records the user can't see.
  const activeQuoteList = ACTIVE_QUOTE_STATUSES.map((s) => `'${s}'`).join(', ');
  const closedStageList = CLOSED_OPPORTUNITY_STAGES.map((s) => `'${s}'`).join(', ');
  const oppActiveExpr = `(
    CASE WHEN o.stage NOT IN (${closedStageList})
           AND (
             NOT EXISTS (SELECT 1 FROM quotes q2 WHERE q2.opportunity_id = o.id)
             OR EXISTS (
               SELECT 1 FROM quotes q2
               WHERE q2.opportunity_id = o.id AND q2.status IN (${activeQuoteList})
             )
           )
         THEN 1 ELSE 0 END
  )`;

  const oppSql = `
    SELECT o.id, o.number, o.title, o.account_id,
           ${oppActiveExpr} AS active
      FROM opportunities o
      ${filterServerSide ? `WHERE ${oppActiveExpr} = 1` : ''}
     ORDER BY o.updated_at DESC
     LIMIT 500
  `;

  const quoteActiveExpr = `CASE WHEN q.status IN (${activeQuoteList}) THEN 1 ELSE 0 END`;
  const quoteSql = `
    SELECT q.id, q.number, q.title, ${quoteActiveExpr} AS active
      FROM quotes q
      ${filterServerSide ? `WHERE ${quoteActiveExpr} = 1` : ''}
     ORDER BY q.updated_at DESC
     LIMIT 500
  `;

  const accountSql = `
    SELECT id, name, alias, parent_group, is_active AS active
      FROM accounts
      ${filterServerSide ? `WHERE is_active = 1` : ''}
     ORDER BY name
     LIMIT 1000
  `;

  const [users, opportunities, quotes, accounts] = await Promise.all([
    all(env.DB,
      `SELECT id, display_name, email
         FROM users
        WHERE active = 1
        ORDER BY display_name, email`),
    all(env.DB, oppSql),
    all(env.DB, quoteSql),
    all(env.DB, accountSql),
  ]);

  const groups = buildAccountPickerGroups(accounts);

  return json({
    current_user_id: user.id,
    users,
    opportunities,
    quotes,
    accounts,
    groups,
    prefs: {
      show_alias: user.show_alias ? 1 : 0,
      group_rollup: user.group_rollup ? 1 : 0,
      active_only: user.active_only ? 1 : 0,
    },
  });
}
