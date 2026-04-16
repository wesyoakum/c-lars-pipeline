// functions/activities/picker-data.js
//
// GET /activities/picker-data
//
// Returns the data needed to populate the "New task" modal (user
// dropdown, opportunity picker, recent quote picker, account picker).
// Fetched lazily the first time a user opens the modal on a page so
// we don't tax every page load with these queries.
//
// Response shape:
//   {
//     current_user_id: 'uuid' | null,
//     users:         [ { id, display_name, email } ],
//     opportunities: [ { id, number, title } ],
//     quotes:        [ { id, number, title } ],
//     accounts:      [ { id, name, alias } ]
//   }
//
// Lists are capped for performance. If the user needs to assign a
// task to an opportunity that isn't in the first 200 rows, they can
// always open that opp first and hit its in-page "+ Task" button,
// which pre-fills the modal via the prefill prop — no picker needed.

import { all } from '../lib/db.js';

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
  const { env, data } = context;
  const user = data?.user;
  if (!user || !user.id) {
    return json({
      current_user_id: null,
      users: [],
      opportunities: [],
      quotes: [],
      accounts: [],
    }, 200);
  }

  const [users, opportunities, quotes, accounts] = await Promise.all([
    all(env.DB,
      `SELECT id, display_name, email
         FROM users
        WHERE active = 1
        ORDER BY display_name, email`),
    all(env.DB,
      `SELECT id, number, title, account_id
         FROM opportunities
        WHERE stage NOT IN ('closed_won', 'closed_lost', 'closed_abandoned')
        ORDER BY updated_at DESC
        LIMIT 200`),
    all(env.DB,
      `SELECT id, number, title
         FROM quotes
        WHERE status IN ('draft', 'issued', 'revision_draft', 'revision_issued', 'accepted')
        ORDER BY updated_at DESC
        LIMIT 200`),
    all(env.DB,
      `SELECT id, name, alias
         FROM accounts
        ORDER BY name
        LIMIT 500`),
  ]);

  return json({
    current_user_id: user.id,
    users,
    opportunities,
    quotes,
    accounts,
  });
}
