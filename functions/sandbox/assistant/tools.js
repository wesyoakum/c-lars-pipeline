// functions/sandbox/assistant/tools.js
//
// Phase 1 toolset for the Sandbox AI Assistant. Read-only over Pipeline
// data + a small key/value memory the model can read & append-to.
// Designed to grow incrementally — add another tool here, expose it in
// `definitions`, branch on its name in `execute`. No write operations
// over real Pipeline data yet (no creating tasks / accounts / etc.) —
// that's a deliberate Phase-1 boundary.

import { all, one, run } from '../../lib/db.js';
import { now } from '../../lib/ids.js';

/**
 * Build the toolset bound to a particular request (env + acting user).
 * Returns Anthropic-format tool definitions plus an executeTool() that
 * dispatches by name. Pass `executeTool` straight into messagesWithTools().
 */
export function makeAssistantTools({ env, user }) {
  const definitions = [
    {
      name: 'search_accounts',
      description:
        'Fuzzy-search Pipeline accounts (companies / customers) by name or alias. ' +
        'Returns up to 20 matches with id, name, segment, alias, parent_group, is_active. ' +
        'Use when the user mentions a company by name and you need to look it up.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Substring to search for in account name or alias.' },
          include_inactive: { type: 'boolean', description: 'Include inactive accounts. Default false.' },
        },
        required: ['query'],
      },
    },
    {
      name: 'list_open_tasks',
      description:
        "List the user's open tasks (activities of type 'task' with no completed_at). " +
        'Returns id, subject, due_at, account_id, opportunity_id, status, created_at, updated_at. ' +
        'Use when planning the day, surfacing what is due, checking what is in flight, or ' +
        'finding what was recently touched (sort=recently_updated).',
      input_schema: {
        type: 'object',
        properties: {
          due_within_days: {
            type: 'integer',
            description: 'Only return tasks due within this many days from today (inclusive). Omit for all open tasks.',
          },
          limit: { type: 'integer', description: 'Max rows to return. Default 50, hard cap 200.' },
          sort: {
            type: 'string',
            enum: ['due_soonest', 'recently_updated', 'recently_created'],
            description: 'Sort order. Default: due_soonest.',
          },
        },
      },
    },
    {
      name: 'list_open_opportunities',
      description:
        "List the user's open Pipeline opportunities (stage not in ('won','lost','closed')). " +
        'Returns id, number, title, stage, account_id, expected_close_date, estimated_value_usd, ' +
        'created_at, updated_at, stage_entered_at. ' +
        'Use to discuss the funnel, deals at risk, what is closing soon, or what was recently ' +
        'touched (sort=recently_updated).',
      input_schema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: 'Max rows to return. Default 50, hard cap 200.' },
          stage: { type: 'string', description: 'Optional exact-match stage filter.' },
          sort: {
            type: 'string',
            enum: ['closing_soonest', 'recently_updated', 'recently_created'],
            description: 'Sort order. Default: closing_soonest.',
          },
        },
      },
    },
    {
      name: 'get_memory',
      description:
        'Read from the assistant memory store. With a `key`, returns just that one value (or null if missing). ' +
        'Without a key, returns ALL memory entries for the user as an array of {key, value, updated_at}. ' +
        'Use at the start of a conversation to load context, and any time the user references something prior.',
      input_schema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'The memory key to fetch. Omit to list all.' },
        },
      },
    },
    {
      name: 'set_memory',
      description:
        'Write a key/value to the assistant memory store. Upserts (overwrites existing key). ' +
        'Use to remember user preferences (travel airline, dietary, working hours), recurring context ' +
        '(active projects, key relationships), or "remind me about X" notes the user explicitly asks ' +
        'to be remembered. Keep keys short and descriptive (e.g. "travel.airline_pref", "remind.q3_review"). ' +
        'Values can be free-form text up to a few KB.',
      input_schema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Short, descriptive key.' },
          value: { type: 'string', description: 'Free-form value to store.' },
        },
        required: ['key', 'value'],
      },
    },
  ];

  async function execute(name, input) {
    switch (name) {
      case 'search_accounts':
        return searchAccounts(env, input);
      case 'list_open_tasks':
        return listOpenTasks(env, user, input);
      case 'list_open_opportunities':
        return listOpenOpportunities(env, user, input);
      case 'get_memory':
        return getMemory(env, user, input);
      case 'set_memory':
        return setMemory(env, user, input);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  return { definitions, execute };
}

// ---------- Implementations ----------

async function searchAccounts(env, { query, include_inactive }) {
  const q = String(query || '').trim();
  if (!q) return { rows: [], note: 'Empty query.' };
  const like = `%${q}%`;
  const sql = `
    SELECT id, name, segment, alias, parent_group, is_active
      FROM accounts
     WHERE (name LIKE ? OR alias LIKE ?)
       ${include_inactive ? '' : 'AND is_active = 1'}
     ORDER BY name
     LIMIT 20
  `;
  const rows = await all(env.DB, sql, [like, like]);
  return { rows, count: rows.length };
}

async function listOpenTasks(env, user, { due_within_days, limit, sort } = {}) {
  const cap = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const params = [user.id];
  let sql = `
    SELECT id, subject, status, due_at, account_id, opportunity_id, type,
           created_at, updated_at
      FROM activities
     WHERE assigned_user_id = ?
       AND completed_at IS NULL
       AND (type = 'task' OR type IS NULL)
  `;
  if (Number.isFinite(due_within_days)) {
    const deadline = new Date(Date.now() + due_within_days * 86400000).toISOString();
    sql += ' AND due_at IS NOT NULL AND due_at <= ?';
    params.push(deadline);
  }
  sql += ` ORDER BY ${orderClauseForTasks(sort)} LIMIT ?`;
  params.push(cap);
  const rows = await all(env.DB, sql, params);
  return { rows, count: rows.length };
}

function orderClauseForTasks(sort) {
  switch (sort) {
    case 'recently_updated': return 'updated_at DESC';
    case 'recently_created': return 'created_at DESC';
    case 'due_soonest':
    default:                 return 'due_at IS NULL, due_at ASC';
  }
}

async function listOpenOpportunities(env, user, { limit, stage, sort } = {}) {
  const cap = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const params = [user.id, user.id];
  let sql = `
    SELECT id, number, title, stage, account_id, expected_close_date,
           estimated_value_usd, created_at, updated_at, stage_entered_at
      FROM opportunities
     WHERE (owner_user_id = ? OR salesperson_user_id = ?)
       AND stage NOT IN ('won', 'lost', 'closed')
  `;
  if (stage) {
    sql += ' AND stage = ?';
    params.push(stage);
  }
  sql += ` ORDER BY ${orderClauseForOpps(sort)} LIMIT ?`;
  params.push(cap);
  const rows = await all(env.DB, sql, params);
  return { rows, count: rows.length };
}

function orderClauseForOpps(sort) {
  switch (sort) {
    case 'recently_updated': return 'updated_at DESC';
    case 'recently_created': return 'created_at DESC';
    case 'closing_soonest':
    default:                 return 'expected_close_date IS NULL, expected_close_date ASC';
  }
}

async function getMemory(env, user, { key } = {}) {
  if (key) {
    const row = await one(
      env.DB,
      'SELECT key, value, updated_at FROM assistant_memory WHERE user_id = ? AND key = ?',
      [user.id, String(key)]
    );
    return row || { key, value: null };
  }
  const rows = await all(
    env.DB,
    'SELECT key, value, updated_at FROM assistant_memory WHERE user_id = ? ORDER BY updated_at DESC',
    [user.id]
  );
  return { rows, count: rows.length };
}

async function setMemory(env, user, { key, value }) {
  const k = String(key || '').trim();
  const v = String(value ?? '');
  if (!k) throw new Error('set_memory requires a non-empty key.');
  const ts = now();
  await run(
    env.DB,
    `INSERT INTO assistant_memory (user_id, key, value, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at`,
    [user.id, k, v, ts, ts]
  );
  return { ok: true, key: k, updated_at: ts };
}
