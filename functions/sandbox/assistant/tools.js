// functions/sandbox/assistant/tools.js
//
// Phase 1 toolset for the Sandbox AI Assistant. Read-only over Pipeline
// data + a small key/value memory the model can read & append-to.
// Designed to grow incrementally — add another tool here, expose it in
// `definitions`, branch on its name in `execute`. No write operations
// over real Pipeline data yet (no creating tasks / accounts / etc.) —
// that's a deliberate Phase-1 boundary.

import Papa from 'papaparse';
import { all, one, run } from '../../lib/db.js';
import { now, uuid } from '../../lib/ids.js';
import {
  claudiaInsert,
  claudiaUpdate,
  claudiaUndo,
  claudiaListRecentWrites,
  CLAUDIA_WRITES,
} from '../../lib/claudia-writes.js';

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
    {
      name: 'describe_schema',
      description:
        'Introspect the Pipeline database. Pass `tables: ["accounts", "opportunities"]` to get the ' +
        'full CREATE TABLE statement for those tables. Pass an empty/omitted `tables` to just list all ' +
        'table names. Call this before query_db when you need to check column names or see what links ' +
        'to what. The list of table names is also included in your system prompt so you usually do not ' +
        'need to list them — go straight to fetching the schema for the tables you care about.',
      input_schema: {
        type: 'object',
        properties: {
          tables: {
            type: 'array',
            items: { type: 'string' },
            description: 'Specific table names to introspect. Omit/empty to just list all tables.',
          },
        },
      },
    },
    {
      name: 'get_calendar_events',
      description:
        'Fetch events from any of the user\'s configured published-calendar feeds (Outlook, Google, ' +
        'iCloud, sports schedules — anything that exposes an .ics URL). Each calendar URL is stored ' +
        'in memory under a key of the form "calendar.url.<label>" — e.g. "calendar.url.work", ' +
        '"calendar.url.family", "calendar.url.wife", "calendar.url.son_baseball". When the user ' +
        'gives you a new URL conversationally, pick a short lowercase descriptive label and save ' +
        'it via set_memory under that pattern. Ask the user for a label if it is ambiguous. ' +
        'Behavior: with no `sources` arg, returns events merged across ALL configured calendars; ' +
        'pass `sources: ["work", "family"]` to scope to specific labels. Each returned event has a ' +
        '`source` field so you can tell which calendar it came from. Hard cap: 100 events, sorted ' +
        'by start time. Defaults: now → now+7 days. The .ics fetch is cached server-side for 5 min ' +
        'per URL — call freely. If NO calendars are configured, returns setup instructions you ' +
        'should pass to the user.',
      input_schema: {
        type: 'object',
        properties: {
          start: { type: 'string', description: 'ISO datetime/date for window start. Default: now.' },
          end: { type: 'string', description: 'ISO datetime/date for window end. Default: start + 7 days.' },
          sources: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional list of label names (without the "calendar.url." prefix) to scope the query. Omit to query all configured calendars merged.',
          },
        },
      },
    },
    {
      name: 'list_documents',
      description:
        "List documents the user has dropped into Claudia's drop-zone. Files can be PDF, DOCX, " +
        'XLSX, images (PNG / JPG / GIF / WEBP — extracted as a vision-generated description), ' +
        'audio (MP3 / WAV / M4A / etc — transcribed via Whisper), or plain text variants ' +
        '(TXT / MD / CSV / JSON / XML / YAML). Returns id, filename, content_type, size_bytes, ' +
        'retention, extraction_status, created_at, and a short preview. Use this when the user ' +
        'asks about what is in their dropped files, or before suggesting cleanups (filter to ' +
        'retention=auto for trashable candidates). Trashed documents are excluded by default; ' +
        'pass include_trashed: true to see them.',
      input_schema: {
        type: 'object',
        properties: {
          include_trashed: { type: 'boolean', description: 'Include documents whose retention is "trashed". Default false.' },
          retention: { type: 'string', enum: ['auto', 'keep_forever', 'trashed'], description: 'Optional exact-match retention filter.' },
          limit: { type: 'integer', description: 'Max rows to return. Default 30, hard cap 100.' },
        },
      },
    },
    {
      name: 'search_documents',
      description:
        'Find documents whose filename or extracted text contains the query string (case-insensitive). ' +
        'Returns the same row shape as list_documents plus a snippet showing the matched context. ' +
        'Trashed documents are excluded. Use this when the user asks about something that might be ' +
        'in a dropped file (e.g. "what did the customer say about timeline" or ' +
        '"find the spec with the 12V requirement"). Hard cap 20 matches.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Substring to match against filename + full_text.' },
          limit: { type: 'integer', description: 'Max rows. Default 20, hard cap 50.' },
        },
        required: ['query'],
      },
    },
    {
      name: 'read_document',
      description:
        'Return the FULL extracted text of one document so you can answer detailed questions about ' +
        'its contents. Updates last_accessed_at on the row (used to gauge value during cleanup ' +
        'recommendations). For very large documents the text is truncated to ~50k characters; ' +
        'note the truncation flag if present and warn the user.',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Document id from list_documents / search_documents.' },
        },
        required: ['id'],
      },
    },
    {
      name: 'create_contact',
      description:
        'Create a new contact under an existing account. Required: account_id, last_name (or first_name). ' +
        'Optional: first_name, email, phone, mobile, title, notes, is_primary. Returns the new ' +
        'contact id and an audit_id you should surface to the user so they can undo within 24h. ' +
        'NEVER call this without explicit user confirmation. For batch flows (e.g. importing 12 ' +
        'contacts from a CSV) call it once per row, but only after the user has approved the batch ' +
        '("yes, create these"). Pass batch_id to group multiple writes so undo_claudia_write can ' +
        'reverse the whole batch atomically.',
      input_schema: {
        type: 'object',
        properties: {
          account_id: { type: 'string', description: 'Required. The account this contact belongs to. Use search_accounts or query_db to find it.' },
          first_name: { type: 'string' },
          last_name:  { type: 'string' },
          email:      { type: 'string' },
          phone:      { type: 'string' },
          mobile:     { type: 'string' },
          title:      { type: 'string' },
          notes:      { type: 'string' },
          is_primary: { type: 'boolean', description: 'Default false. Only set true when the user explicitly asks.' },
          batch_id:   { type: 'string', description: 'Optional. Group writes by passing the same batch_id across multiple calls so undo_claudia_write can reverse the whole batch.' },
          summary:    { type: 'string', description: 'Optional one-line description of the write for the audit log.' },
        },
        required: ['account_id'],
      },
    },
    {
      name: 'update_contact',
      description:
        'Update specific fields on an existing contact. Pass only the fields you want to change. ' +
        'Returns the diffs applied + an audit_id for undo. NEVER call without explicit user ' +
        'confirmation, especially for batch updates. Use the same batch_id pattern as create_contact ' +
        'when updating many rows from one CSV.',
      input_schema: {
        type: 'object',
        properties: {
          id:         { type: 'string', description: 'Contact id to update.' },
          first_name: { type: 'string' },
          last_name:  { type: 'string' },
          email:      { type: 'string' },
          phone:      { type: 'string' },
          mobile:     { type: 'string' },
          title:      { type: 'string' },
          notes:      { type: 'string' },
          is_primary: { type: 'boolean' },
          account_id: { type: 'string', description: 'Re-parent the contact to a different account. Rare; confirm explicitly.' },
          batch_id:   { type: 'string' },
          summary:    { type: 'string' },
        },
        required: ['id'],
      },
    },
    {
      name: 'update_account',
      description:
        'Update specific fields on an existing account. Pass only the fields you want to change. ' +
        'Returns the diffs applied + an audit_id for undo. Common uses: rename a stub account to ' +
        'its full company name, set or change the alias, fill in segment / parent_group / website / ' +
        'notes after research. Always confirm with the user before renaming an existing account ' +
        '(it will be visible to other Pipeline users and shows up in opp / quote / contact links).',
      input_schema: {
        type: 'object',
        properties: {
          id:               { type: 'string', description: 'Account id to update.' },
          name:             { type: 'string' },
          segment:          { type: 'string' },
          alias:            { type: 'string' },
          parent_group:     { type: 'string' },
          owner_user_id:    { type: 'string' },
          phone:            { type: 'string' },
          website:          { type: 'string' },
          email:            { type: 'string' },
          notes:            { type: 'string' },
          address_billing:  { type: 'string' },
          address_physical: { type: 'string' },
          is_active:        { type: 'boolean' },
          batch_id:         { type: 'string' },
          summary:          { type: 'string' },
        },
        required: ['id'],
      },
    },
    {
      name: 'create_account',
      description:
        'Create a new account (company / customer). Required: name. Optional: segment, alias, ' +
        'parent_group, owner_user_id, phone, website, email, notes, address_billing, address_physical. ' +
        'Returns the new account id + audit_id for undo. Use this BEFORE create_contact when the ' +
        'dedupe report says "needs_new_account". Always confirm with the user before creating an ' +
        'account — accounts cascade-delete contacts when removed.',
      input_schema: {
        type: 'object',
        properties: {
          name:             { type: 'string', description: 'Required. Company / customer display name.' },
          segment:          { type: 'string' },
          alias:            { type: 'string' },
          parent_group:     { type: 'string' },
          owner_user_id:    { type: 'string', description: 'Default: the current user.' },
          phone:            { type: 'string' },
          website:          { type: 'string' },
          email:            { type: 'string' },
          notes:            { type: 'string' },
          address_billing:  { type: 'string' },
          address_physical: { type: 'string' },
          batch_id:         { type: 'string' },
          summary:          { type: 'string' },
        },
        required: ['name'],
      },
    },
    {
      name: 'undo_claudia_write',
      description:
        'Reverse a previous Claudia write within the 24-hour undo window. For a CREATE: deletes ' +
        'the row. For an UPDATE: restores the snapshot from before the write. The audit row stays ' +
        'in the table but is marked undone. Use when the user says "undo that" / "revert" / "I ' +
        'didn\'t mean to do that" — pull the audit_id from the response of the original write or ' +
        'from list_recent_writes.',
      input_schema: {
        type: 'object',
        properties: {
          audit_id: { type: 'string', description: 'The audit log id returned by the original write.' },
          reason:   { type: 'string', description: 'Optional one-line reason for the undo.' },
        },
        required: ['audit_id'],
      },
    },
    {
      name: 'list_recent_writes',
      description:
        'List the user\'s recent Claudia-driven writes with audit ids — useful when the user says ' +
        '"undo what you just did" and you need to find the right audit_id. Newest first; default 25, ' +
        'hard cap 200.',
      input_schema: {
        type: 'object',
        properties: {
          limit: { type: 'integer' },
        },
      },
    },
    {
      name: 'propose_contact_imports',
      description:
        'Analyze an uploaded contacts CSV (Outlook export, Google Contacts export, etc.) and ' +
        'produce a structured dedupe + import proposal. For each row: matches against existing ' +
        'Pipeline contacts by email; matches against existing accounts by company name; classifies ' +
        'as update_existing_contact / create_under_account / needs_new_account / duplicate_in_csv ' +
        '/ skipped_no_email. Returns the per-row proposals plus summary counts. ' +
        'Use this whenever the user drops a CSV that looks like contacts (filename mentions ' +
        '"contacts" / "people" / "address" OR the columns include first/last name + email). ' +
        'Currently you cannot WRITE to the contacts table directly — present the report and offer ' +
        'to format a clean ready-to-import CSV the user can run themselves.',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Document id from list_documents.' },
          max_rows: { type: 'integer', description: 'Cap on rows analyzed. Default 500, hard cap 2000.' },
        },
        required: ['id'],
      },
    },
    {
      name: 'set_document_retention',
      description:
        "Change a document's retention. " +
        '"keep_forever" pins it (you must NOT recommend trashing it). ' +
        '"auto" is the default (eligible for your cleanup recommendations). ' +
        '"trashed" soft-deletes it (hidden from list/search/read) — only use this when the user ' +
        'explicitly asks. Always confirm with the user before flipping to trashed; never trash a ' +
        'doc on your own initiative.',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Document id.' },
          retention: { type: 'string', enum: ['auto', 'keep_forever', 'trashed'], description: 'New retention value.' },
        },
        required: ['id', 'retention'],
      },
    },
    {
      name: 'query_db',
      description:
        'Run a single read-only SELECT (or WITH ... SELECT) against the Pipeline D1 database. Returns ' +
        'up to 200 rows. Use this for any question the curated tools cannot answer: arbitrary joins, ' +
        'aggregations, filters, recency cuts, or full-table introspection. Rules: ' +
        '(1) one statement only, no semicolons; ' +
        '(2) read-only — INSERT/UPDATE/DELETE/DROP/ALTER/CREATE/REPLACE/ATTACH/DETACH/PRAGMA/VACUUM are blocked; ' +
        '(3) if you do not include LIMIT, 200 is appended; ' +
        "(4) prefer the curated tools (search_accounts / list_open_tasks / list_open_opportunities) when they fit — they're cheaper and pre-scoped to the current user.",
      input_schema: {
        type: 'object',
        properties: {
          sql: { type: 'string', description: 'A single read-only SELECT statement.' },
        },
        required: ['sql'],
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
      case 'describe_schema':
        return describeSchema(env, input);
      case 'query_db':
        return queryDb(env, input);
      case 'get_calendar_events':
        return getCalendarEvents(env, user, input);
      case 'list_documents':
        return listDocuments(env, user, input);
      case 'search_documents':
        return searchDocuments(env, user, input);
      case 'read_document':
        return readDocument(env, user, input);
      case 'set_document_retention':
        return setDocumentRetention(env, user, input);
      case 'propose_contact_imports':
        return proposeContactImports(env, user, input);
      case 'create_contact':
        return createContact(env, user, input);
      case 'update_contact':
        return updateContact(env, user, input);
      case 'create_account':
        return createAccount(env, user, input);
      case 'update_account':
        return updateAccount(env, user, input);
      case 'undo_claudia_write':
        return undoClaudiaWrite(env, user, input);
      case 'list_recent_writes':
        return listRecentWrites(env, user, input);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  return { definitions, execute };
}

/**
 * Returns the list of all user-visible table names. Used by the system
 * prompt so Claudia always knows what tables exist without spending a
 * tool call to list them.
 */
export async function listTableNames(env) {
  const rows = await all(
    env.DB,
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  );
  return rows.map((r) => r.name);
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

async function describeSchema(env, { tables } = {}) {
  if (!tables || tables.length === 0) {
    const rows = await all(
      env.DB,
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    );
    return { tables: rows.map((r) => r.name) };
  }
  const placeholders = tables.map(() => '?').join(',');
  const rows = await all(
    env.DB,
    `SELECT name, sql FROM sqlite_master WHERE type='table' AND name IN (${placeholders}) ORDER BY name`,
    tables
  );
  const missing = tables.filter((t) => !rows.find((r) => r.name === t));
  return { tables: rows, missing };
}

const DENIED_KEYWORDS = /\b(insert|update|delete|drop|alter|create|replace|attach|detach|pragma|vacuum|reindex|truncate)\b/i;

async function queryDb(env, { sql }) {
  let stmt = String(sql || '').trim();
  // Strip a single trailing semicolon if present.
  stmt = stmt.replace(/;\s*$/, '');
  if (!stmt) throw new Error('Empty query.');
  if (stmt.includes(';')) throw new Error('Multi-statement queries are not allowed.');
  if (!/^(select|with)\b/i.test(stmt)) {
    throw new Error('Only SELECT or WITH...SELECT queries are allowed.');
  }
  if (DENIED_KEYWORDS.test(stmt)) {
    throw new Error('Query contains a write/DDL keyword (insert/update/delete/drop/alter/create/replace/attach/detach/pragma/vacuum/reindex/truncate).');
  }
  // Apply a hard row cap if the caller didn't include LIMIT.
  const finalSql = /\blimit\s+\d+/i.test(stmt) ? stmt : `${stmt} LIMIT 200`;
  const rows = await all(env.DB, finalSql);
  return { rows, count: rows.length, sql: finalSql };
}

// ---------- Claudia drop-zone documents ----------

const READ_DOCUMENT_MAX_CHARS = 50_000;

async function listDocuments(env, user, { include_trashed, retention, limit } = {}) {
  const cap = Math.min(Math.max(Number(limit) || 30, 1), 100);
  const params = [user.id];
  let where = 'user_id = ?';
  if (retention) {
    where += ' AND retention = ?';
    params.push(retention);
  } else if (!include_trashed) {
    where += " AND retention != 'trashed'";
  }
  params.push(cap);
  const rows = await all(
    env.DB,
    `SELECT id, filename, content_type, size_bytes, retention,
            extraction_status, extraction_error, created_at, last_accessed_at,
            substr(coalesce(full_text, ''), 1, 200) AS preview
       FROM claudia_documents
      WHERE ${where}
      ORDER BY created_at DESC
      LIMIT ?`,
    params
  );
  return { rows, count: rows.length };
}

async function searchDocuments(env, user, { query, limit } = {}) {
  const q = String(query || '').trim();
  if (!q) return { rows: [], count: 0, note: 'Empty query.' };
  const cap = Math.min(Math.max(Number(limit) || 20, 1), 50);
  const like = `%${q}%`;
  const rows = await all(
    env.DB,
    `SELECT id, filename, content_type, size_bytes, retention, created_at,
            substr(coalesce(full_text, ''), 1, 200) AS preview
       FROM claudia_documents
      WHERE user_id = ?
        AND retention != 'trashed'
        AND (filename LIKE ? OR full_text LIKE ?)
      ORDER BY created_at DESC
      LIMIT ?`,
    [user.id, like, like, cap]
  );

  // Build a small snippet around the first hit in full_text (or filename)
  // for each row so Claudia gets context, not just metadata.
  const lcQuery = q.toLowerCase();
  const enriched = await Promise.all(rows.map(async (r) => {
    const ftRow = await one(
      env.DB,
      'SELECT full_text FROM claudia_documents WHERE id = ?',
      [r.id]
    );
    const text = String(ftRow?.full_text || '');
    const idx = text.toLowerCase().indexOf(lcQuery);
    let snippet = null;
    if (idx >= 0) {
      const start = Math.max(0, idx - 80);
      const end = Math.min(text.length, idx + q.length + 120);
      snippet = (start > 0 ? '… ' : '') + text.slice(start, end) + (end < text.length ? ' …' : '');
    }
    return { ...r, snippet };
  }));

  return { rows: enriched, count: enriched.length };
}

async function readDocument(env, user, { id } = {}) {
  if (!id) throw new Error('read_document requires an id.');
  const row = await one(
    env.DB,
    `SELECT id, filename, content_type, size_bytes, retention,
            extraction_status, extraction_error, full_text, created_at
       FROM claudia_documents
      WHERE id = ? AND user_id = ?`,
    [id, user.id]
  );
  if (!row) {
    return { error: 'not_found', id };
  }
  if (row.retention === 'trashed') {
    return { error: 'trashed', id, filename: row.filename };
  }
  // Bump last_accessed_at — non-blocking, ignore failures.
  try {
    await run(
      env.DB,
      'UPDATE claudia_documents SET last_accessed_at = ? WHERE id = ?',
      [now(), id]
    );
  } catch {}

  const fullText = String(row.full_text || '');
  const truncated = fullText.length > READ_DOCUMENT_MAX_CHARS;
  return {
    id: row.id,
    filename: row.filename,
    content_type: row.content_type,
    size_bytes: row.size_bytes,
    retention: row.retention,
    extraction_status: row.extraction_status,
    extraction_error: row.extraction_error,
    truncated,
    text: truncated ? fullText.slice(0, READ_DOCUMENT_MAX_CHARS) : fullText,
  };
}

const RETENTION_VALUES = new Set(['auto', 'keep_forever', 'trashed']);

async function setDocumentRetention(env, user, { id, retention } = {}) {
  if (!id) throw new Error('set_document_retention requires an id.');
  if (!RETENTION_VALUES.has(retention)) {
    throw new Error(`set_document_retention requires retention in: auto, keep_forever, trashed.`);
  }
  const ts = now();
  const result = await run(
    env.DB,
    `UPDATE claudia_documents
        SET retention = ?,
            updated_at = ?,
            trashed_at = CASE WHEN ? = 'trashed' THEN ? ELSE NULL END
      WHERE id = ? AND user_id = ?`,
    [retention, ts, retention, ts, id, user.id]
  );
  return { ok: true, id, retention, updated_at: ts, changes: result?.meta?.changes ?? null };
}

// ---------- Pipeline writes (audited via lib/claudia-writes.js) ----------

async function createContact(env, user, input = {}) {
  const account_id = String(input.account_id || '').trim();
  if (!account_id) throw new Error('create_contact requires account_id.');
  const first_name = trimOrNull(input.first_name);
  const last_name  = trimOrNull(input.last_name);
  if (!first_name && !last_name) {
    throw new Error('create_contact requires at least first_name or last_name.');
  }

  // Fail fast if the parent account doesn't exist (FK would error anyway,
  // but this gives the model a clearer message it can pass to the user).
  const acct = await one(env.DB, 'SELECT id, name FROM accounts WHERE id = ?', [account_id]);
  if (!acct) {
    return { error: 'account_not_found', account_id, message: `No account with id ${account_id}.` };
  }

  const ts = now();
  const id = uuid();
  const summary = input.summary || `created contact ${first_name || ''} ${last_name || ''}`.trim() + ` under ${acct.name}`;
  const result = await claudiaInsert(env, user, 'create_contact', 'contacts', id, {
    account_id,
    first_name,
    last_name,
    title:      trimOrNull(input.title),
    email:      trimOrNull(input.email),
    phone:      trimOrNull(input.phone),
    mobile:     trimOrNull(input.mobile),
    is_primary: input.is_primary ? 1 : 0,
    notes:      trimOrNull(input.notes),
    created_at: ts,
    updated_at: ts,
    created_by_user_id: user.id,
  }, { batchId: input.batch_id, summary });

  return {
    ok: true,
    id: result.id,
    audit_id: result.audit_id,
    account_id,
    account_name: acct.name,
    summary,
  };
}

async function updateContact(env, user, input = {}) {
  const id = String(input.id || '').trim();
  if (!id) throw new Error('update_contact requires id.');

  const updatable = ['first_name', 'last_name', 'email', 'phone', 'mobile', 'title', 'notes', 'account_id'];
  const fields = {};
  for (const k of updatable) {
    if (k in input) fields[k] = trimOrNull(input[k]);
  }
  if ('is_primary' in input) fields.is_primary = input.is_primary ? 1 : 0;
  if (Object.keys(fields).length === 0) {
    return { error: 'no_fields', id, message: 'No updatable fields supplied.' };
  }

  const summary = input.summary || `updated contact ${id} (${Object.keys(fields).join(', ')})`;
  try {
    const result = await claudiaUpdate(env, user, 'update_contact', 'contacts', id, fields, {
      batchId: input.batch_id,
      summary,
    });
    if (result.no_change) {
      return { ok: true, id, no_change: true, message: 'Nothing to update — supplied fields already match.' };
    }
    return {
      ok: true,
      id,
      audit_id: result.audit_id,
      diffs: result.diffs,
      summary,
    };
  } catch (err) {
    return { error: 'update_failed', id, message: err?.message || String(err) };
  }
}

async function createAccount(env, user, input = {}) {
  const name = trimOrNull(input.name);
  if (!name) throw new Error('create_account requires a name.');
  const ts = now();
  const id = uuid();
  const summary = input.summary || `created account ${name}`;
  const result = await claudiaInsert(env, user, 'create_account', 'accounts', id, {
    name,
    segment:          trimOrNull(input.segment),
    alias:            trimOrNull(input.alias),
    parent_group:     trimOrNull(input.parent_group),
    address_billing:  trimOrNull(input.address_billing),
    address_physical: trimOrNull(input.address_physical),
    phone:            trimOrNull(input.phone),
    website:          trimOrNull(input.website),
    email:            trimOrNull(input.email),
    notes:            trimOrNull(input.notes),
    owner_user_id:    trimOrNull(input.owner_user_id) || user.id,
    is_active:        1,
    created_at:       ts,
    updated_at:       ts,
    created_by_user_id: user.id,
  }, { batchId: input.batch_id, summary });

  return {
    ok: true,
    id: result.id,
    audit_id: result.audit_id,
    name,
    summary,
  };
}

async function updateAccount(env, user, input = {}) {
  const id = String(input.id || '').trim();
  if (!id) throw new Error('update_account requires id.');

  const updatable = ['name', 'segment', 'alias', 'parent_group', 'owner_user_id',
    'phone', 'website', 'email', 'notes', 'address_billing', 'address_physical'];
  const fields = {};
  for (const k of updatable) {
    if (k in input) fields[k] = trimOrNull(input[k]);
  }
  if ('is_active' in input) fields.is_active = input.is_active ? 1 : 0;
  if (Object.keys(fields).length === 0) {
    return { error: 'no_fields', id, message: 'No updatable fields supplied.' };
  }

  const summary = input.summary || `updated account ${id} (${Object.keys(fields).join(', ')})`;
  try {
    const result = await claudiaUpdate(env, user, 'update_account', 'accounts', id, fields, {
      batchId: input.batch_id,
      summary,
    });
    if (result.no_change) {
      return { ok: true, id, no_change: true, message: 'Nothing to update — supplied fields already match.' };
    }
    return {
      ok: true,
      id,
      audit_id: result.audit_id,
      diffs: result.diffs,
      summary,
    };
  } catch (err) {
    return { error: 'update_failed', id, message: err?.message || String(err) };
  }
}

async function undoClaudiaWrite(env, user, { audit_id, reason } = {}) {
  if (!audit_id) throw new Error('undo_claudia_write requires audit_id.');
  return claudiaUndo(env, user, audit_id, { reason });
}

async function listRecentWrites(env, user, { limit } = {}) {
  const rows = await claudiaListRecentWrites(env, user, limit ?? 25);
  return { rows, count: rows.length };
}

function trimOrNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

// ---------- Contact imports (CSV → dedupe proposal) ----------

const CONTACT_COLUMN_GUESSES = {
  first_name: ['first name', 'first', 'given name', 'firstname', 'givenname'],
  last_name:  ['last name', 'last', 'surname', 'family name', 'lastname', 'familyname'],
  email:      ['email', 'e-mail', 'email address', 'e-mail address', 'primary email', 'email 1', 'email1', 'mail'],
  phone:      ['phone', 'business phone', 'work phone', 'business phone 1', 'business phone 2', 'office phone', 'phone number'],
  mobile:     ['mobile', 'mobile phone', 'cell', 'cell phone', 'mobile phone 1'],
  company:    ['company', 'organization', 'organisation', 'employer', 'company name'],
  title:      ['title', 'job title', 'position', 'role'],
};

function detectContactColumns(headers) {
  const lowerToOriginal = new Map();
  for (const h of headers) {
    lowerToOriginal.set(String(h || '').toLowerCase().trim(), h);
  }
  const mapping = {};
  for (const [field, guesses] of Object.entries(CONTACT_COLUMN_GUESSES)) {
    for (const g of guesses) {
      if (lowerToOriginal.has(g)) {
        mapping[field] = lowerToOriginal.get(g);
        break;
      }
    }
  }
  return mapping;
}

async function proposeContactImports(env, user, { id, max_rows } = {}) {
  if (!id) throw new Error('propose_contact_imports requires a doc id.');

  const doc = await one(
    env.DB,
    `SELECT id, filename, content_type, retention, full_text
       FROM claudia_documents
      WHERE id = ? AND user_id = ?`,
    [id, user.id]
  );
  if (!doc) return { error: 'not_found', id };
  if (doc.retention === 'trashed') return { error: 'trashed', id, filename: doc.filename };

  const text = String(doc.full_text || '');
  if (!text.trim()) {
    return { error: 'no_text', id, filename: doc.filename, message: 'Document has no extracted text to parse.' };
  }

  const cap = Math.min(Math.max(Number(max_rows) || 500, 1), 2000);
  const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
  const headers = (parsed.meta && parsed.meta.fields) || [];
  const mapping = detectContactColumns(headers);

  if (!mapping.email) {
    return {
      error: 'no_email_column',
      id,
      filename: doc.filename,
      detected_headers: headers,
      detected_columns: mapping,
      message:
        'No recognizable email column in the headers. Expected one of: ' +
        CONTACT_COLUMN_GUESSES.email.join(', ') + '. Either the file is not a contacts CSV ' +
        'or the column name is non-standard — ask the user how to map it.',
    };
  }

  const rows = (parsed.data || []).slice(0, cap);

  // One query for all existing emails — much faster than per-row lookups.
  const existingContacts = await all(
    env.DB,
    `SELECT id, account_id, first_name, last_name, email, phone, mobile, title
       FROM contacts
      WHERE email IS NOT NULL AND email != ''`
  );
  const byEmail = new Map();
  for (const c of existingContacts) {
    byEmail.set(String(c.email).toLowerCase().trim(), c);
  }

  // Active accounts for company → account matching.
  const activeAccounts = await all(
    env.DB,
    `SELECT id, name, alias FROM accounts WHERE is_active = 1`
  );
  const accountIndex = activeAccounts.map((a) => ({
    id: a.id,
    name: a.name,
    alias: a.alias,
    nameLower: String(a.name || '').toLowerCase().trim(),
    aliasLower: String(a.alias || '').toLowerCase().trim(),
  }));

  const seenEmails = new Set();
  const proposals = [];
  const summary = {
    update_existing_contact: 0,
    create_under_account: 0,
    needs_new_account: 0,
    duplicate_in_csv: 0,
    skipped_no_email: 0,
  };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const candidate = {
      first_name: getMappedField(row, mapping.first_name),
      last_name:  getMappedField(row, mapping.last_name),
      email:      getMappedField(row, mapping.email),
      phone:      getMappedField(row, mapping.phone),
      mobile:     getMappedField(row, mapping.mobile),
      company:    getMappedField(row, mapping.company),
      title:      getMappedField(row, mapping.title),
    };

    if (!candidate.email) {
      summary.skipped_no_email++;
      proposals.push({ row_index: i, classification: 'skipped_no_email', candidate });
      continue;
    }

    const emailLower = candidate.email.toLowerCase();
    if (seenEmails.has(emailLower)) {
      summary.duplicate_in_csv++;
      proposals.push({ row_index: i, classification: 'duplicate_in_csv', candidate });
      continue;
    }
    seenEmails.add(emailLower);

    const existing = byEmail.get(emailLower);
    if (existing) {
      const diffs = {};
      for (const f of ['first_name', 'last_name', 'phone', 'mobile', 'title']) {
        const incoming = candidate[f];
        const current = existing[f];
        if (incoming && incoming !== current) {
          diffs[f] = { from: current || null, to: incoming };
        }
      }
      summary.update_existing_contact++;
      proposals.push({
        row_index: i,
        classification: 'update_existing_contact',
        candidate,
        existing_id: existing.id,
        existing_account_id: existing.account_id,
        diffs,
      });
      continue;
    }

    // Try to match the company string to an existing account.
    const companyLower = String(candidate.company || '').toLowerCase().trim();
    let matchedAccount = null;
    if (companyLower) {
      matchedAccount = accountIndex.find(
        (a) => a.nameLower === companyLower || a.aliasLower === companyLower
      );
      if (!matchedAccount) {
        // Soft fuzzy: substring either direction. Cheap; surfaces obvious matches
        // like "Acme Offshore Inc." vs "Acme Offshore" without a similarity lib.
        matchedAccount = accountIndex.find(
          (a) =>
            (a.nameLower && (companyLower.includes(a.nameLower) || a.nameLower.includes(companyLower))) ||
            (a.aliasLower && (companyLower.includes(a.aliasLower) || a.aliasLower.includes(companyLower)))
        );
      }
    }

    if (matchedAccount) {
      summary.create_under_account++;
      proposals.push({
        row_index: i,
        classification: 'create_under_account',
        candidate,
        matched_account: { id: matchedAccount.id, name: matchedAccount.name },
      });
    } else {
      summary.needs_new_account++;
      proposals.push({
        row_index: i,
        classification: 'needs_new_account',
        candidate,
      });
    }
  }

  // Cap the proposals returned to keep the model's context manageable.
  // Counts in `summary` always reflect the full set.
  const PROPOSAL_RETURN_CAP = 100;
  const truncated = proposals.length > PROPOSAL_RETURN_CAP;

  return {
    doc: { id: doc.id, filename: doc.filename },
    detected_columns: mapping,
    detected_headers: headers,
    total_rows_in_csv: parsed.data ? parsed.data.length : 0,
    total_rows_analyzed: rows.length,
    summary,
    proposals: proposals.slice(0, PROPOSAL_RETURN_CAP),
    truncated,
    note_no_writes_yet:
      'Claudia is currently read-only on Pipeline. To act on this report you can either ' +
      'manually create the contacts/accounts via the UI, or ask Claudia to format a clean ' +
      'ready-to-import CSV for the rows in update_existing_contact + create_under_account.',
  };
}

function getMappedField(row, key) {
  if (!key) return null;
  const v = row[key];
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

// ---------- Calendar (published .ics URLs, multi-source) ----------

const CALENDAR_URL_KEY_PREFIX = 'calendar.url.';
const CALENDAR_CACHE_SECONDS = 300;

const SETUP_INSTRUCTIONS =
  'No calendar URLs configured yet. To add one: publish or share a calendar that exposes an .ics ' +
  'feed (Outlook web → Settings → Calendar → Shared calendars → "Publish a calendar"; Google ' +
  'Calendar → Settings → secret iCal URL; or any team / sports schedule that gives you an .ics ' +
  'link). Then call set_memory with key "' + CALENDAR_URL_KEY_PREFIX + '<label>" and value = the ' +
  'URL. The label is whatever short, lowercase descriptor you want — e.g. "work", "family", ' +
  '"wife", "son_baseball". Multiple calendars are supported; add as many as you want.';

async function getCalendarEvents(env, user, { start, end, sources } = {}) {
  const rows = await all(
    env.DB,
    "SELECT key, value FROM assistant_memory WHERE user_id = ? AND key LIKE 'calendar.url.%'",
    [user.id]
  );

  const allConfigured = rows
    .map((r) => ({ label: r.key.slice(CALENDAR_URL_KEY_PREFIX.length), url: String(r.value || '').trim() }))
    .filter((s) => /^https?:\/\//i.test(s.url));

  if (allConfigured.length === 0) {
    return { error: 'no_calendar_url', message: SETUP_INSTRUCTIONS };
  }

  let working = allConfigured;
  if (Array.isArray(sources) && sources.length > 0) {
    const wanted = new Set(sources.map((s) => String(s).toLowerCase()));
    working = allConfigured.filter((s) => wanted.has(s.label.toLowerCase()));
    if (working.length === 0) {
      return {
        error: 'unknown_sources',
        message: 'None of the requested sources matched any configured calendar.',
        configured_labels: allConfigured.map((s) => s.label),
      };
    }
  }

  const startMs = start ? Date.parse(start) : Date.now();
  const endMs = end ? Date.parse(end) : startMs + 7 * 86400000;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return { error: 'invalid_window', message: 'start/end could not be parsed, or end < start.' };
  }

  // Fetch + parse each calendar concurrently.
  const fetched = await Promise.all(working.map(async (s) => {
    try {
      const text = await fetchIcsCached(s.url);
      const raw = parseIcs(text);
      const events = raw
        .map(normalizeEvent)
        .filter((e) => e.start_ms != null)
        .filter((e) => e.start_ms < endMs && (e.end_ms ?? e.start_ms) > startMs)
        .map((e) => ({
          source: s.label,
          summary: e.summary,
          start: e.start,
          end: e.end,
          all_day: e.all_day,
          location: e.location || undefined,
          organizer: e.organizer || undefined,
          start_ms: e.start_ms,
        }));
      return { source: s.label, ok: true, events };
    } catch (err) {
      return { source: s.label, ok: false, error: err.message || String(err), events: [] };
    }
  }));

  const merged = fetched
    .flatMap((r) => r.events)
    .sort((a, b) => a.start_ms - b.start_ms)
    .slice(0, 100)
    .map(({ start_ms, ...rest }) => rest); // drop internal sort key

  return {
    events: merged,
    count: merged.length,
    window: { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() },
    sources: fetched.map((r) => ({
      label: r.source,
      ok: r.ok,
      count: r.events.length,
      ...(r.error ? { error: r.error } : {}),
    })),
  };
}

async function fetchIcsCached(url) {
  const cache = caches.default;
  const cacheKey = new Request(url, { method: 'GET' });
  let resp = await cache.match(cacheKey);
  if (!resp) {
    const upstream = await fetch(url, { headers: { Accept: 'text/calendar' } });
    if (!upstream.ok) {
      throw new Error(`Calendar fetch failed: ${upstream.status} ${upstream.statusText}`);
    }
    // Re-wrap with our own Cache-Control so the Cache API stores it.
    const body = await upstream.text();
    resp = new Response(body, {
      status: 200,
      headers: {
        'content-type': upstream.headers.get('content-type') || 'text/calendar',
        'cache-control': `public, max-age=${CALENDAR_CACHE_SECONDS}`,
      },
    });
    await cache.put(cacheKey, resp.clone());
  }
  return resp.text();
}

function parseIcs(text) {
  // RFC 5545 line-unfolding: a CRLF followed by a space or tab is a continuation.
  const unfolded = text.replace(/\r?\n[ \t]/g, '');
  const lines = unfolded.split(/\r?\n/);
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      cur = {};
    } else if (line === 'END:VEVENT') {
      if (cur) events.push(cur);
      cur = null;
    } else if (cur) {
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;
      const keyPart = line.slice(0, colonIdx);
      const value = line.slice(colonIdx + 1);
      const key = keyPart.split(';')[0]; // strip params (e.g. DTSTART;TZID=...)
      // Don't overwrite repeated keys (e.g. multiple ATTENDEE) — first wins for our needs.
      if (!(key in cur)) cur[key] = value;
    }
  }
  return events;
}

function normalizeEvent(raw) {
  const start = parseIcsDate(raw.DTSTART);
  const end = parseIcsDate(raw.DTEND);
  return {
    summary: unescapeIcs(raw.SUMMARY || ''),
    location: unescapeIcs(raw.LOCATION || ''),
    organizer: (raw.ORGANIZER || '').replace(/^MAILTO:/i, ''),
    start: start?.iso ?? null,
    end: end?.iso ?? null,
    start_ms: start?.ms ?? null,
    end_ms: end?.ms ?? null,
    all_day: !!start?.allDay,
  };
}

function parseIcsDate(s) {
  if (!s) return null;
  // YYYYMMDDTHHMMSS(Z) — datetime, optionally UTC.
  let m = s.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (m) {
    const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7] ? 'Z' : ''}`;
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? { iso, ms, allDay: false } : null;
  }
  // YYYYMMDD — all-day.
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) {
    const iso = `${m[1]}-${m[2]}-${m[3]}`;
    const ms = Date.parse(iso + 'T00:00:00Z');
    return Number.isFinite(ms) ? { iso, ms, allDay: true } : null;
  }
  return null;
}

function unescapeIcs(s) {
  return String(s)
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
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
