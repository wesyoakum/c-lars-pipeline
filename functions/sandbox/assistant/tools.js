// functions/sandbox/assistant/tools.js
//
// Phase 1 toolset for the Sandbox AI Assistant. Read-only over Pipeline
// data + a small key/value memory the model can read & append-to.
// Designed to grow incrementally — add another tool here, expose it in
// `definitions`, branch on its name in `execute`. No write operations
// over real Pipeline data yet (no creating tasks / accounts / etc.) —
// that's a deliberate Phase-1 boundary.

import Papa from 'papaparse';
import { all, one, run, batch as d1Batch, stmt } from '../../lib/db.js';
import { now, uuid, nextSequenceValue, nextNumber, currentYear } from '../../lib/ids.js';
import { CLAUDIA_USER_ID } from '../../lib/auth.js';
import { audit, auditStmt } from '../../lib/audit.js';
import { changeOppStage } from '../../lib/stage-transitions.js';
import { fireEvent } from '../../lib/auto-tasks.js';
import {
  claudiaInsert,
  claudiaUpdate,
  claudiaUndo,
  claudiaListRecentWrites,
  CLAUDIA_WRITES,
} from '../../lib/claudia-writes.js';
import {
  PERMISSION_GATED_ACTIONS,
  loadPermissionMap,
} from '../../lib/claudia-permissions.js';

/**
 * Build the toolset bound to a particular request (env + acting user).
 * Returns Anthropic-format tool definitions plus an executeTool() that
 * dispatches by name. Pass `executeTool` straight into messagesWithTools().
 *
 * Async so it can read claudia_permissions and filter mutation tools
 * Wes has disabled at /settings/claudia.
 */
export async function makeAssistantTools({ env, user }) {
  const permissions = await loadPermissionMap(env);
  const isAllowed = (action) => {
    if (!PERMISSION_GATED_ACTIONS.has(action)) return true;
    // Missing row → enabled (defensive default).
    return permissions[action] !== false;
  };

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
      name: 'create_activity',
      description:
        'Create a new activity (task / call / email / meeting / note), optionally linked to an account, ' +
        'opportunity, contact, job, or quote. Most common use: convert a commitment found in a meeting note ' +
        'or upload into a tracked task. Required: subject. Optional: type (default "task"), body, due_at, ' +
        'remind_at, status, opportunity_id, account_id, contact_id, job_id, quote_id, assigned_user_id ' +
        '(default the current user). Always confirm with the user before creating, and use a batch_id when ' +
        'creating several from one source. Returns the new activity id + audit_id for undo.',
      input_schema: {
        type: 'object',
        properties: {
          subject:          { type: 'string', description: 'Required. Short title shown in task lists.' },
          type:             { type: 'string', description: 'Default "task". Common values: task, call, email, meeting, note.' },
          body:             { type: 'string', description: 'Optional longer description / agenda / notes.' },
          status:           { type: 'string', description: 'Default "open". Common values: open, in_progress, blocked, completed.' },
          due_at:           { type: 'string', description: 'ISO datetime when the task is due.' },
          remind_at:        { type: 'string', description: 'ISO datetime to fire a reminder.' },
          direction:        { type: 'string', description: 'For calls/emails/meetings: "inbound" or "outbound".' },
          opportunity_id:   { type: 'string', description: 'Link to an opportunity. Cascade-deletes if the opp is deleted.' },
          account_id:       { type: 'string', description: 'Link to an account. Cascade-deletes if the account is deleted.' },
          contact_id:       { type: 'string', description: 'Link to a specific contact.' },
          job_id:           { type: 'string', description: 'Link to a job (post-sale execution record).' },
          quote_id:         { type: 'string', description: 'Link to a specific quote.' },
          assigned_user_id: { type: 'string', description: 'User id this is assigned to. Default: current user.' },
          batch_id:         { type: 'string', description: 'Group writes for batch undo.' },
          summary:          { type: 'string', description: 'One-line description for the audit trail.' },
        },
        required: ['subject'],
      },
    },
    {
      name: 'update_activity',
      description:
        'Update one or more fields on an existing activity. Pass only the fields you want to change. ' +
        'Use to reassign, reschedule, clarify scope, or fix typos. Returns diffs + audit_id. ' +
        'Note: to mark an activity completed, prefer complete_activity which also sets completed_at.',
      input_schema: {
        type: 'object',
        properties: {
          id:               { type: 'string', description: 'Activity id to update.' },
          subject:          { type: 'string' },
          type:             { type: 'string' },
          body:             { type: 'string' },
          status:           { type: 'string' },
          due_at:           { type: 'string' },
          remind_at:        { type: 'string' },
          direction:        { type: 'string' },
          opportunity_id:   { type: 'string' },
          account_id:       { type: 'string' },
          contact_id:       { type: 'string' },
          job_id:           { type: 'string' },
          quote_id:         { type: 'string' },
          assigned_user_id: { type: 'string' },
          batch_id:         { type: 'string' },
          summary:          { type: 'string' },
        },
        required: ['id'],
      },
    },
    {
      name: 'complete_activity',
      description:
        'Mark an activity completed. Sets status="completed" and completed_at to now. Sugar around ' +
        'update_activity that handles the timestamp atomically. Use when the user (or a task assigner) ' +
        'tells you "I did that" / "done" / "mark it complete." Returns audit_id for undo.',
      input_schema: {
        type: 'object',
        properties: {
          id:       { type: 'string', description: 'Activity id to complete.' },
          batch_id: { type: 'string', description: 'Group writes for batch undo.' },
          summary:  { type: 'string', description: 'Optional one-line audit note.' },
        },
        required: ['id'],
      },
    },
    {
      name: 'create_opportunity',
      description:
        'Open a new deal (opportunity) under an existing account. Required: account_id, title. ' +
        'Optional: description, transaction_type (default "spares"), stage (default "lead"), ' +
        'estimated_value_usd, expected_close_date, primary_contact_id, owner_user_id, ' +
        'salesperson_user_id, source, rfq_format, rfq_received_date, rfq_due_date, rfi_due_date, ' +
        'quoted_date, bant_budget, bant_authority, bant_authority_contact_id, bant_need, bant_timeline, ' +
        'notes_internal, number (auto-allocated from the sequence if omitted — that is the strongly ' +
        'preferred default; only pass an explicit number if the user dictates one). Returns the new ' +
        'opportunity id + auto-allocated number + audit_id. Always confirm with the user before opening.',
      input_schema: {
        type: 'object',
        properties: {
          account_id:                { type: 'string', description: 'Required. The account this opp belongs to.' },
          title:                     { type: 'string', description: 'Required. Short deal name.' },
          description:               { type: 'string' },
          transaction_type:          { type: 'string', description: 'Default "spares". Other common values: eps, lars, service, change_order.' },
          stage:                     { type: 'string', description: 'Default "lead". Use the regular stage endpoint to advance — do NOT bypass via update_opportunity.' },
          number:                    { type: 'string', description: 'Optional 5-digit number. If omitted, the next sequence value is allocated and zero-padded. Pass only when the user dictates one.' },
          probability:               { type: 'integer', description: '0–100. Defaults from the stage catalog if omitted.' },
          estimated_value_usd:       { type: 'number' },
          expected_close_date:       { type: 'string' },
          primary_contact_id:        { type: 'string' },
          owner_user_id:             { type: 'string', description: 'Default: current user.' },
          salesperson_user_id:       { type: 'string', description: 'Default: current user.' },
          source:                    { type: 'string', description: 'How the deal came in (referral, conference, inbound web, etc.).' },
          rfq_format:                { type: 'string' },
          rfq_received_date:         { type: 'string' },
          rfq_due_date:              { type: 'string' },
          rfi_due_date:              { type: 'string' },
          quoted_date:               { type: 'string' },
          bant_budget:               { type: 'string' },
          bant_authority:            { type: 'string' },
          bant_authority_contact_id: { type: 'string' },
          bant_need:                 { type: 'string' },
          bant_timeline:             { type: 'string' },
          notes_internal:            { type: 'string' },
          batch_id:                  { type: 'string' },
          summary:                   { type: 'string' },
        },
        required: ['account_id', 'title'],
      },
    },
    {
      name: 'update_opportunity',
      description:
        'Update one or more fields on an existing opportunity. Pass only the fields you want to change. ' +
        'Returns diffs + audit_id. ' +
        'IMPORTANT: do NOT change `stage` here — stage transitions need to fire the auto-task chain, ' +
        'so they go through the regular /opportunities/:id/stage endpoint (which Claudia does not have ' +
        'access to). If a stage change is needed, tell the user and have them do it from the opp page.',
      input_schema: {
        type: 'object',
        properties: {
          id:                        { type: 'string', description: 'Opportunity id to update.' },
          title:                     { type: 'string' },
          description:               { type: 'string' },
          transaction_type:          { type: 'string' },
          probability:               { type: 'integer' },
          estimated_value_usd:       { type: 'number' },
          expected_close_date:       { type: 'string' },
          actual_close_date:         { type: 'string' },
          primary_contact_id:        { type: 'string' },
          owner_user_id:             { type: 'string' },
          salesperson_user_id:       { type: 'string' },
          source:                    { type: 'string' },
          rfq_format:                { type: 'string' },
          rfq_received_date:         { type: 'string' },
          rfq_due_date:              { type: 'string' },
          rfi_due_date:              { type: 'string' },
          quoted_date:               { type: 'string' },
          bant_budget:               { type: 'string' },
          bant_authority:            { type: 'string' },
          bant_authority_contact_id: { type: 'string' },
          bant_need:                 { type: 'string' },
          bant_timeline:             { type: 'string' },
          close_reason:              { type: 'string' },
          loss_reason_tag:           { type: 'string' },
          customer_po_number:        { type: 'string' },
          notes_internal:            { type: 'string' },
          batch_id:                  { type: 'string' },
          summary:                   { type: 'string' },
        },
        required: ['id'],
      },
    },
    {
      name: 'change_opportunity_stage',
      description:
        'Move an opportunity to a new stage in its workflow (e.g. lead → rfq_received → quote_drafted → ' +
        'quote_submitted → closed_won). Calls the same code path as the manual stage button on the opp ' +
        'page so the auto-task chain fires correctly — do NOT bypass via update_opportunity. Returns ' +
        '{ changed, from, to, reason? }. ' +
        'Rules: ' +
        '(1) Always confirm with the user before moving a stage; stage moves cascade into auto-tasks ' +
        '    and notifications. ' +
        '(2) Terminal stages (closed_won / closed_lost / closed_died) require an explicit reason — ' +
        '    pass it via the `reason` field. ' +
        '(3) If the function returns { changed: false }, surface the reason verbatim — common values: ' +
        '    "already at target", "would regress" (when onlyForward was true and the target is behind), ' +
        '    "unknown stage", "opp not found". ' +
        '(4) NOT undoable via undo_claudia_write — auto-task firings can\'t be unfired. To reverse, ' +
        '    advance forward through closed_lost or have the user use the regular UI.',
      input_schema: {
        type: 'object',
        properties: {
          id:           { type: 'string', description: 'Opportunity id.' },
          stage:        { type: 'string', description: 'Target stage_key (e.g. quote_drafted, oc_submitted, closed_won). Use describe_schema or query_db on stage_definitions if unsure which keys are valid for this opp\'s transaction_type.' },
          reason:       { type: 'string', description: 'Short note appended to the audit row. REQUIRED when moving to a terminal stage (closed_won / closed_lost / closed_died).' },
          only_forward: { type: 'boolean', description: 'If true, refuse to regress the stage. Default false.' },
        },
        required: ['id', 'stage'],
      },
    },
    {
      name: 'create_quote_draft',
      description:
        'Open a new quote in DRAFT status under an existing opportunity. SHELL ONLY — no line items ' +
        'via Claudia yet. Required: opportunity_id, quote_type. Optional: title, description, ' +
        'valid_until, incoterms, payment_terms, delivery_terms, delivery_estimate, notes_internal, ' +
        'notes_customer, change_order_id (for CO quotes). ' +
        'Auto-allocates the next quote number (Q{opp_number}-{seq}) and revision (v1). ' +
        'Auto-syncs the opp stage forward to quote_drafted (or change_order_drafted for CO quotes), ' +
        'mirroring the manual quote-create flow. ' +
        'Returns the new quote id, number, and audit_id for undo. ' +
        'When the user wants line items: AFTER creating the shell, suggest the line list in the chat ' +
        '(qty / description / price) for them to enter manually — you do NOT have a line-write tool.',
      input_schema: {
        type: 'object',
        properties: {
          opportunity_id:    { type: 'string', description: 'Required. Parent opportunity id.' },
          quote_type:        { type: 'string', description: 'Required. Usually matches the opp transaction_type — common values: spares, eps, lars, service.' },
          change_order_id:   { type: 'string', description: 'Optional. Bind this quote to a change order; advances opp through CO stages instead of baseline quote stages.' },
          title:             { type: 'string' },
          description:       { type: 'string' },
          valid_until:       { type: 'string', description: 'ISO date when the quote expires.' },
          incoterms:         { type: 'string' },
          payment_terms:     { type: 'string' },
          delivery_terms:    { type: 'string' },
          delivery_estimate: { type: 'string' },
          notes_internal:    { type: 'string' },
          notes_customer:    { type: 'string' },
          batch_id:          { type: 'string' },
          summary:           { type: 'string' },
        },
        required: ['opportunity_id', 'quote_type'],
      },
    },
    {
      name: 'create_job',
      description:
        'Open a new job under a won opportunity. Bare-metadata creation only — name, opp link, type, ' +
        'PO number. Milestones come from quote acceptance, NOT from this tool. ' +
        'Required: opportunity_id. Optional: title (defaults to opp.title), customer_po_number ' +
        '(defaults to opp.customer_po_number). ' +
        'Job number auto-allocates as JOB-{YYYY}-{seq}. ' +
        'Hard rule: one open job per opportunity. If a non-cancelled job already exists for the opp, ' +
        'the call fails with { error: "duplicate_job", existing_number }. Surface that to the user ' +
        'plainly and ask if they want to look at the existing one.',
      input_schema: {
        type: 'object',
        properties: {
          opportunity_id:     { type: 'string', description: 'Required. Parent opportunity id. Should normally be at closed_won; the function does not enforce that, but creating a job on a still-open opp is unusual.' },
          title:              { type: 'string', description: 'Defaults to opp.title.' },
          customer_po_number: { type: 'string', description: 'Defaults to opp.customer_po_number.' },
          batch_id:           { type: 'string' },
          summary:            { type: 'string' },
        },
        required: ['opportunity_id'],
      },
    },
    {
      name: 'fire_auto_task_chain',
      description:
        'Manually fire an auto-task rule chain against a specific entity. Use ONLY when the natural ' +
        'event missed for some reason and tasks are visibly absent that should be there. Firing a ' +
        'chain that already ran will create DUPLICATE tasks — the rule engine has no per-entity ' +
        'idempotency check. Always confirm with the user before firing. ' +
        'Required: event_type and the matching entity_* fields. Common event types: ' +
        '"opportunity.stage_changed" (needs entity_type=opportunity), ' +
        '"quote.issued" / "quote.accepted" / "quote.rejected" / "quote.expired" / "quote.revised" ' +
        '(needs entity_type=quote), "task.completed" (needs entity_type=activity), ' +
        '"oc.issued" / "ntp.issued" / "change_order.issued" / "job.handed_off" / "job.completed". ' +
        'Returns { ok, fired, skipped, event_type, entity_type, entity_id }.',
      input_schema: {
        type: 'object',
        properties: {
          event_type:  { type: 'string', description: 'Required. The trigger string (e.g. "opportunity.stage_changed").' },
          entity_type: { type: 'string', enum: ['opportunity', 'quote', 'activity', 'job'], description: 'Required. Which kind of entity the event is firing for.' },
          entity_id:   { type: 'string', description: 'Required. Id of the entity.' },
        },
        required: ['event_type', 'entity_type', 'entity_id'],
      },
    },
    {
      name: 'set_document_category',
      description:
        'Label a dropped document with a category — RFQ, spec sheet, contact list, meeting note, ' +
        'badge photo, contract, PO, etc. Free-form string for now (no enum). Pass null to clear. ' +
        'Useful for filtered listings and cleanups; not yet wired into the rest of the app. Direct ' +
        'UPDATE — no claudia_writes/audit row.',
      input_schema: {
        type: 'object',
        properties: {
          id:       { type: 'string', description: 'Document id.' },
          category: { type: 'string', description: 'Category label, or null/empty to clear.' },
        },
        required: ['id'],
      },
    },
    {
      name: 'merge_accounts',
      description:
        'Consolidate two account rows into one. Repoints every FK reference (contacts, opportunities, ' +
        'activities, documents) from `loser_id` onto `winner_id`, then deletes the loser. ALL data ' +
        'on the loser row itself (name / alias / segment / addresses / notes) is LOST — anything you ' +
        'want to keep must be merged onto the winner via update_account first. ' +
        'NOT undoable via undo_claudia_write — to reverse you would manually re-create the loser and ' +
        'split the children back. Always confirm with the user, including which row wins, before ' +
        'firing. The `reason` field is required for the audit trail. Returns the per-table repoint ' +
        'counts plus the deleted loser snapshot.',
      input_schema: {
        type: 'object',
        properties: {
          loser_id:  { type: 'string', description: 'Required. The duplicate account that will be deleted.' },
          winner_id: { type: 'string', description: 'Required. The account that absorbs all the FK references and survives.' },
          reason:    { type: 'string', description: 'Required. Short note for the audit trail (e.g. "duplicate KCS rows from CSV import").' },
        },
        required: ['loser_id', 'winner_id', 'reason'],
      },
    },
    {
      name: 'merge_contacts',
      description:
        'Consolidate two contact rows into one. Repoints FK references on opportunities ' +
        '(primary_contact_id, bant_authority_contact_id), activities (contact_id), and documents ' +
        '(contact_id) from `loser_id` onto `winner_id`, then deletes the loser. ALL data on the ' +
        'loser row (name / email / phone / title / notes) is LOST — merge anything worth keeping ' +
        'via update_contact first. NOT undoable. Always confirm with the user, including which row ' +
        'wins, before firing. `reason` is required.',
      input_schema: {
        type: 'object',
        properties: {
          loser_id:  { type: 'string', description: 'Required. The duplicate contact that will be deleted.' },
          winner_id: { type: 'string', description: 'Required. The contact that absorbs the FK references and survives.' },
          reason:    { type: 'string', description: 'Required. Short note for the audit trail.' },
        },
        required: ['loser_id', 'winner_id', 'reason'],
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

  // Filter out disabled mutation tools so Claude never sees them in the
  // toolset (preferred — she can't even propose using a tool she can't
  // see). The execute() check below is defense-in-depth in case a stale
  // schema makes it through anyway.
  const filteredDefinitions = definitions.filter((d) => isAllowed(d.name));

  async function execute(name, input) {
    if (!isAllowed(name)) {
      return {
        error: 'permission_denied',
        action: name,
        message: `The "${name}" tool is currently disabled by ${user.display_name || user.email} at /settings/claudia. Tell him plainly that you can't do that right now and ask if he wants to enable it.`,
      };
    }
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
      case 'create_activity':
        return createActivity(env, user, input);
      case 'update_activity':
        return updateActivity(env, user, input);
      case 'complete_activity':
        return completeActivity(env, user, input);
      case 'create_opportunity':
        return createOpportunity(env, user, input);
      case 'update_opportunity':
        return updateOpportunity(env, user, input);
      case 'change_opportunity_stage':
        return changeOpportunityStage(env, user, input);
      case 'create_quote_draft':
        return createQuoteDraft(env, user, input);
      case 'create_job':
        return createJob(env, user, input);
      case 'fire_auto_task_chain':
        return fireAutoTaskChain(env, user, input);
      case 'set_document_category':
        return setDocumentCategory(env, user, input);
      case 'merge_accounts':
        return mergeAccounts(env, user, input);
      case 'merge_contacts':
        return mergeContacts(env, user, input);
      case 'undo_claudia_write':
        return undoClaudiaWrite(env, user, input);
      case 'list_recent_writes':
        return listRecentWrites(env, user, input);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  return { definitions: filteredDefinitions, execute, permissions };
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
    `SELECT id, filename, content_type, size_bytes, retention, category,
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
    `SELECT id, filename, content_type, size_bytes, retention, category, created_at,
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
    `SELECT id, filename, content_type, size_bytes, retention, category,
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
    category: row.category,
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

// ---------- Activities (tasks / calls / meetings / notes) ----------

async function createActivity(env, user, input = {}) {
  const subject = trimOrNull(input.subject);
  if (!subject) throw new Error('create_activity requires a subject.');
  const type = trimOrNull(input.type) || 'task';
  const ts = now();
  const id = uuid();
  const summary = input.summary || `created ${type} "${subject}"`;
  const result = await claudiaInsert(env, user, 'create_activity', 'activities', id, {
    type,
    subject,
    body:             trimOrNull(input.body),
    status:           trimOrNull(input.status) || 'open',
    direction:        trimOrNull(input.direction),
    due_at:           trimOrNull(input.due_at),
    remind_at:        trimOrNull(input.remind_at),
    opportunity_id:   trimOrNull(input.opportunity_id),
    account_id:       trimOrNull(input.account_id),
    contact_id:       trimOrNull(input.contact_id),
    job_id:           trimOrNull(input.job_id),
    quote_id:         trimOrNull(input.quote_id),
    assigned_user_id: trimOrNull(input.assigned_user_id) || user.id,
    created_at:       ts,
    updated_at:       ts,
    created_by_user_id: user.id,
  }, { batchId: input.batch_id, summary });

  return {
    ok: true,
    id: result.id,
    audit_id: result.audit_id,
    subject,
    type,
    summary,
  };
}

async function updateActivity(env, user, input = {}) {
  const id = String(input.id || '').trim();
  if (!id) throw new Error('update_activity requires id.');

  const updatable = ['type', 'subject', 'body', 'status', 'direction', 'due_at',
    'remind_at', 'opportunity_id', 'account_id', 'contact_id', 'job_id',
    'quote_id', 'assigned_user_id'];
  const fields = {};
  for (const k of updatable) {
    if (k in input) fields[k] = trimOrNull(input[k]);
  }
  if (Object.keys(fields).length === 0) {
    return { error: 'no_fields', id, message: 'No updatable fields supplied.' };
  }

  const summary = input.summary || `updated activity ${id} (${Object.keys(fields).join(', ')})`;
  try {
    const result = await claudiaUpdate(env, user, 'update_activity', 'activities', id, fields, {
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

async function completeActivity(env, user, input = {}) {
  const id = String(input.id || '').trim();
  if (!id) throw new Error('complete_activity requires id.');
  const ts = now();
  const summary = input.summary || `completed activity ${id}`;
  try {
    const result = await claudiaUpdate(env, user, 'complete_activity', 'activities', id, {
      status: 'completed',
      completed_at: ts,
    }, { batchId: input.batch_id, summary });
    if (result.no_change) {
      return { ok: true, id, no_change: true, message: 'Already completed.' };
    }
    return {
      ok: true,
      id,
      audit_id: result.audit_id,
      completed_at: ts,
      diffs: result.diffs,
      summary,
    };
  } catch (err) {
    return { error: 'complete_failed', id, message: err?.message || String(err) };
  }
}

// ---------- Opportunities (deals) ----------

async function createOpportunity(env, user, input = {}) {
  const account_id = String(input.account_id || '').trim();
  const title = trimOrNull(input.title);
  if (!account_id) throw new Error('create_opportunity requires account_id.');
  if (!title) throw new Error('create_opportunity requires a title.');

  const acct = await one(env.DB, 'SELECT id, name, is_active FROM accounts WHERE id = ?', [account_id]);
  if (!acct) {
    return { error: 'account_not_found', account_id, message: `No account with id ${account_id}.` };
  }

  // Allocate the next sequence number unless the caller dictated one.
  // Mirrors the human-driven path in functions/opportunities/index.js so
  // the auto-allocate counter stays aligned.
  let number = trimOrNull(input.number);
  if (!number) {
    const allocated = await nextSequenceValue(env.DB, 'opportunity');
    number = String(allocated).padStart(5, '0');
  }

  const ts = now();
  const id = uuid();
  const transaction_type = trimOrNull(input.transaction_type) || 'spares';
  const stage = trimOrNull(input.stage) || 'lead';
  const probability = Number.isFinite(input.probability) ? input.probability : 0;
  const summary = input.summary || `opened opp ${number}: "${title}" for ${acct.name}`;

  const result = await claudiaInsert(env, user, 'create_opportunity', 'opportunities', id, {
    number,
    account_id,
    primary_contact_id:        trimOrNull(input.primary_contact_id),
    title,
    description:               trimOrNull(input.description),
    transaction_type,
    stage,
    stage_entered_at:          ts,
    probability,
    estimated_value_usd:       Number.isFinite(input.estimated_value_usd) ? input.estimated_value_usd : null,
    currency:                  'USD',
    expected_close_date:       trimOrNull(input.expected_close_date),
    actual_close_date:         null,
    source:                    trimOrNull(input.source),
    rfq_format:                trimOrNull(input.rfq_format),
    rfq_received_date:         trimOrNull(input.rfq_received_date),
    rfq_due_date:              trimOrNull(input.rfq_due_date),
    rfi_due_date:              trimOrNull(input.rfi_due_date),
    quoted_date:               trimOrNull(input.quoted_date),
    bant_budget:               trimOrNull(input.bant_budget),
    bant_authority:            trimOrNull(input.bant_authority),
    bant_authority_contact_id: trimOrNull(input.bant_authority_contact_id),
    bant_need:                 trimOrNull(input.bant_need),
    bant_timeline:             trimOrNull(input.bant_timeline),
    notes_internal:            trimOrNull(input.notes_internal),
    owner_user_id:             trimOrNull(input.owner_user_id) || user.id,
    salesperson_user_id:       trimOrNull(input.salesperson_user_id) || user.id,
    created_at:                ts,
    updated_at:                ts,
    created_by_user_id:        user.id,
  }, { batchId: input.batch_id, summary });

  return {
    ok: true,
    id: result.id,
    audit_id: result.audit_id,
    number,
    account_id,
    account_name: acct.name,
    title,
    transaction_type,
    stage,
    summary,
  };
}

async function updateOpportunity(env, user, input = {}) {
  const id = String(input.id || '').trim();
  if (!id) throw new Error('update_opportunity requires id.');

  // Note: `stage` is intentionally NOT in updatable. Stage transitions
  // need to fire the auto-task chain, which only the
  // /opportunities/:id/stage endpoint handles. Bypassing it here would
  // leave the auto-task system out of sync.
  const updatable = ['title', 'description', 'transaction_type', 'probability',
    'estimated_value_usd', 'expected_close_date', 'actual_close_date',
    'primary_contact_id', 'owner_user_id', 'salesperson_user_id',
    'source', 'rfq_format', 'rfq_received_date', 'rfq_due_date', 'rfi_due_date',
    'quoted_date', 'bant_budget', 'bant_authority', 'bant_authority_contact_id',
    'bant_need', 'bant_timeline', 'close_reason', 'loss_reason_tag',
    'customer_po_number', 'notes_internal'];
  const fields = {};
  for (const k of updatable) {
    if (k in input) {
      // Numbers stay as numbers, strings get trimmed.
      const raw = input[k];
      if (k === 'probability' || k === 'estimated_value_usd') {
        fields[k] = Number.isFinite(raw) ? raw : null;
      } else {
        fields[k] = trimOrNull(raw);
      }
    }
  }
  if (Object.keys(fields).length === 0) {
    return { error: 'no_fields', id, message: 'No updatable fields supplied.' };
  }
  if ('stage' in input) {
    return {
      error: 'stage_change_blocked',
      id,
      message:
        'Stage transitions go through /opportunities/:id/stage so the auto-task chain fires correctly. ' +
        'Tell the user to advance the stage from the opportunity page; do not retry update_opportunity ' +
        'with `stage` set.',
    };
  }

  const summary = input.summary || `updated opportunity ${id} (${Object.keys(fields).join(', ')})`;
  try {
    const result = await claudiaUpdate(env, user, 'update_opportunity', 'opportunities', id, fields, {
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

// ---------- Stage transitions (NOT via claudia-writes — fires auto-tasks) ----------

const TERMINAL_STAGES = new Set(['closed_won', 'closed_lost', 'closed_died', 'change_order_won']);

async function changeOpportunityStage(env, user, input = {}) {
  const oppId = String(input.id || '').trim();
  const toStage = trimOrNull(input.stage);
  const reason = trimOrNull(input.reason);
  if (!oppId) throw new Error('change_opportunity_stage requires id.');
  if (!toStage) throw new Error('change_opportunity_stage requires a target stage.');

  if (TERMINAL_STAGES.has(toStage) && !reason) {
    return {
      changed: false,
      from: null,
      to: toStage,
      reason: 'reason_required_for_terminal_stage',
      message: 'Terminal stages need a reason. Ask the user "won — why? (e.g. price, timing, technical fit)" or "lost — what was the deciding factor?" and pass the answer in the reason field.',
    };
  }

  // Synthetic context: changeOppStage uses data.user for audit_events
  // attribution. Pass Claudia's user so the standard Pipeline history
  // shows her as the actor; encode the human trigger in the reason
  // string so the audit summary still names whoever asked.
  const claudiaUser = await one(
    env.DB,
    'SELECT id, email, display_name, role FROM users WHERE id = ?',
    [CLAUDIA_USER_ID]
  );
  const triggeredBy = user.display_name || user.email || user.id;
  const composedReason = reason
    ? `${reason} — triggered by ${triggeredBy}`
    : `triggered by ${triggeredBy}`;

  const ctx = {
    env,
    data: { user: claudiaUser || user },
    // No waitUntil: the auto-task fire runs synchronously instead.
    // Slightly slower, but correct — and stage changes are rare enough
    // that the latency cost is negligible.
  };

  const result = await changeOppStage(ctx, oppId, toStage, {
    reason: composedReason,
    onlyForward: input.only_forward === true,
  });

  return {
    ok: result.changed === true,
    ...result,
  };
}

// ---------- Quotes (shell-only — no line items via Claudia) ----------

async function createQuoteDraft(env, user, input = {}) {
  const oppId = String(input.opportunity_id || '').trim();
  const quoteType = trimOrNull(input.quote_type);
  if (!oppId) throw new Error('create_quote_draft requires opportunity_id.');
  if (!quoteType) throw new Error('create_quote_draft requires quote_type.');

  const opp = await one(
    env.DB,
    'SELECT id, number, transaction_type FROM opportunities WHERE id = ?',
    [oppId]
  );
  if (!opp) {
    return { error: 'opp_not_found', opportunity_id: oppId, message: `No opportunity with id ${oppId}.` };
  }

  // Validate change_order_id if provided.
  const changeOrderId = trimOrNull(input.change_order_id);
  let changeOrder = null;
  if (changeOrderId) {
    changeOrder = await one(
      env.DB,
      'SELECT id, number, opportunity_id FROM change_orders WHERE id = ?',
      [changeOrderId]
    );
    if (!changeOrder || changeOrder.opportunity_id !== oppId) {
      return {
        error: 'change_order_mismatch',
        change_order_id: changeOrderId,
        message: 'change_order_id does not exist or belongs to a different opportunity.',
      };
    }
  }

  // Allocate the next quote_seq within this opp. Mirrors the manual
  // path in functions/opportunities/[id]/quotes/index.js so the
  // numbering scheme stays consistent.
  const siblings = await all(
    env.DB,
    'SELECT quote_seq FROM quotes WHERE opportunity_id = ?',
    [oppId]
  );
  const maxSeq = siblings.reduce((m, s) => Math.max(m, Number(s.quote_seq ?? 0)), 0);
  const quoteSeq = maxSeq + 1;
  const revision = 'v1';
  const number = `Q${opp.number}-${quoteSeq}`;

  const ts = now();
  const id = uuid();
  const isCO = !!changeOrder;
  const summary = input.summary || (isCO
    ? `drafted CO quote ${number} on ${opp.number}`
    : `drafted quote ${number} on ${opp.number}`);

  // Use claudiaInsert so the write also lands in claudia_writes for
  // undo + the standard audit_events row attributes to Claudia with
  // the "(triggered by ...)" suffix.
  const result = await claudiaInsert(env, user, 'create_quote_draft', 'quotes', id, {
    number,
    opportunity_id:    oppId,
    revision,
    quote_seq:         quoteSeq,
    quote_type:        quoteType,
    change_order_id:   changeOrderId,
    status:            'draft',
    title:             trimOrNull(input.title) || '',
    description:       trimOrNull(input.description),
    valid_until:       trimOrNull(input.valid_until),
    currency:          'USD',
    subtotal_price:    0,
    tax_amount:        0,
    total_price:       0,
    incoterms:         trimOrNull(input.incoterms),
    payment_terms:     trimOrNull(input.payment_terms),
    delivery_terms:    trimOrNull(input.delivery_terms),
    delivery_estimate: trimOrNull(input.delivery_estimate),
    cost_build_id:     null,
    notes_internal:    trimOrNull(input.notes_internal),
    notes_customer:    trimOrNull(input.notes_customer),
    show_discounts:    0,
    created_at:        ts,
    updated_at:        ts,
    created_by_user_id: user.id,
  }, { batchId: input.batch_id, summary });

  // Sync the opp stage forward to quote_drafted (or change_order_drafted
  // for CO quotes). onlyForward avoids regressing already-advanced opps.
  // Failure of this step does NOT roll back the quote — mirrors the
  // human-driven handler.
  let stageResult = null;
  try {
    const claudiaUser = await one(
      env.DB,
      'SELECT id, email, display_name, role FROM users WHERE id = ?',
      [CLAUDIA_USER_ID]
    );
    const triggeredBy = user.display_name || user.email || user.id;
    const ctx = { env, data: { user: claudiaUser || user } };
    const draftedStage = isCO ? 'change_order_drafted' : 'quote_drafted';
    stageResult = await changeOppStage(ctx, oppId, draftedStage, {
      reason: isCO
        ? `New change-order quote draft ${number} (triggered by ${triggeredBy})`
        : `New quote draft ${number} (triggered by ${triggeredBy})`,
      onlyForward: true,
    });
  } catch (err) {
    console.error('[create_quote_draft] stage sync failed:', err?.message || err);
    stageResult = { changed: false, error: err?.message || String(err) };
  }

  return {
    ok: true,
    id: result.id,
    audit_id: result.audit_id,
    number,
    revision,
    quote_seq: quoteSeq,
    opportunity_id: oppId,
    opportunity_number: opp.number,
    quote_type: quoteType,
    change_order_id: changeOrderId,
    stage_sync: stageResult,
    summary,
  };
}

// ---------- Jobs (bare metadata; milestones come from quote acceptance) ----------

async function createJob(env, user, input = {}) {
  const oppId = String(input.opportunity_id || '').trim();
  if (!oppId) throw new Error('create_job requires opportunity_id.');

  const opp = await one(
    env.DB,
    `SELECT id, number, title, transaction_type, customer_po_number
       FROM opportunities WHERE id = ?`,
    [oppId]
  );
  if (!opp) {
    return { error: 'opp_not_found', opportunity_id: oppId, message: `No opportunity with id ${oppId}.` };
  }

  // One job per opp (excluding cancelled). Mirrors the manual handler
  // and the auto-create-on-closed_won path so Claudia can't double up.
  const existing = await one(
    env.DB,
    "SELECT id, number FROM jobs WHERE opportunity_id = ? AND status != 'cancelled'",
    [oppId]
  );
  if (existing) {
    return {
      error: 'duplicate_job',
      opportunity_id: oppId,
      existing_id: existing.id,
      existing_number: existing.number,
      message: `A job (${existing.number}) already exists for this opportunity.`,
    };
  }

  const id = uuid();
  const number = await nextNumber(env.DB, `JOB-${currentYear()}`);
  const ts = now();
  const title = trimOrNull(input.title) || opp.title;
  const customerPo = trimOrNull(input.customer_po_number) || opp.customer_po_number || null;
  const oppTypes = String(opp.transaction_type || '').split(',').map((s) => s.trim()).filter(Boolean);
  const isEps = oppTypes.includes('eps');
  const summary = input.summary || `created job ${number} from opp ${opp.number}`;

  const result = await claudiaInsert(env, user, 'create_job', 'jobs', id, {
    number,
    opportunity_id:     oppId,
    job_type:           opp.transaction_type,
    status:             'created',
    title,
    customer_po_number: customerPo,
    ntp_required:       isEps ? 1 : 0,
    created_at:         ts,
    updated_at:         ts,
    created_by_user_id: user.id,
  }, { batchId: input.batch_id, summary });

  return {
    ok: true,
    id: result.id,
    audit_id: result.audit_id,
    number,
    opportunity_id: oppId,
    opportunity_number: opp.number,
    title,
    job_type: opp.transaction_type,
    summary,
  };
}

// ---------- Auto-task rule firing (manual trigger) ----------

// Map entity_type → SELECT * FROM <table>. fireEvent's payload shape
// uses single-key entity sub-objects (opportunity, quote, task, job).
const AUTO_TASK_ENTITY_TABLES = {
  opportunity: 'opportunities',
  quote:       'quotes',
  activity:    'activities',
  job:         'jobs',
};
const AUTO_TASK_PAYLOAD_KEYS = {
  opportunity: 'opportunity',
  quote:       'quote',
  activity:    'task',  // auto-tasks engine uses `task` for the activity entry
  job:         'job',
};

async function fireAutoTaskChain(env, user, input = {}) {
  const eventType = trimOrNull(input.event_type);
  const entityType = trimOrNull(input.entity_type);
  const entityId = trimOrNull(input.entity_id);
  if (!eventType) throw new Error('fire_auto_task_chain requires event_type.');
  if (!entityType) throw new Error('fire_auto_task_chain requires entity_type.');
  if (!entityId) throw new Error('fire_auto_task_chain requires entity_id.');

  const table = AUTO_TASK_ENTITY_TABLES[entityType];
  const payloadKey = AUTO_TASK_PAYLOAD_KEYS[entityType];
  if (!table || !payloadKey) {
    return { error: 'unknown_entity_type', entity_type: entityType };
  }

  const entityRow = await one(env.DB, `SELECT * FROM ${table} WHERE id = ?`, [entityId]);
  if (!entityRow) {
    return { error: 'entity_not_found', entity_type: entityType, entity_id: entityId };
  }

  // Enrich the payload with adjacent rows the rule conditions may
  // reference. Mirrors what production callers pass — opps include
  // their account; quotes include their opp + account; tasks include
  // any linked opp/account.
  const payload = {
    trigger: { user: user.id, at: now(), source: 'claudia_manual_fire' },
    [payloadKey]: entityRow,
  };
  if (entityType === 'opportunity' && entityRow.account_id) {
    payload.account = await one(env.DB, 'SELECT * FROM accounts WHERE id = ?', [entityRow.account_id]);
  }
  if (entityType === 'quote' && entityRow.opportunity_id) {
    payload.opportunity = await one(env.DB, 'SELECT * FROM opportunities WHERE id = ?', [entityRow.opportunity_id]);
    if (payload.opportunity?.account_id) {
      payload.account = await one(env.DB, 'SELECT * FROM accounts WHERE id = ?', [payload.opportunity.account_id]);
    }
  }
  if (entityType === 'activity') {
    if (entityRow.opportunity_id) {
      payload.opportunity = await one(env.DB, 'SELECT * FROM opportunities WHERE id = ?', [entityRow.opportunity_id]);
    }
    if (entityRow.account_id) {
      payload.account = await one(env.DB, 'SELECT * FROM accounts WHERE id = ?', [entityRow.account_id]);
    }
  }
  if (entityType === 'job' && entityRow.opportunity_id) {
    payload.opportunity = await one(env.DB, 'SELECT * FROM opportunities WHERE id = ?', [entityRow.opportunity_id]);
    if (payload.opportunity?.account_id) {
      payload.account = await one(env.DB, 'SELECT * FROM accounts WHERE id = ?', [payload.opportunity.account_id]);
    }
  }

  const claudiaUser = await one(
    env.DB,
    'SELECT id, email, display_name, role FROM users WHERE id = ?',
    [CLAUDIA_USER_ID]
  );
  const result = await fireEvent(env, eventType, payload, claudiaUser || user);

  // Audit the manual fire so /settings/history shows it. entity_type
  // is the singular Pipeline convention (account / contact / opportunity),
  // not the table name.
  const triggeredBy = user.display_name || user.email || user.id;
  try {
    await audit(env.DB, {
      entityType: entityType,
      entityId: entityId,
      eventType: 'claudia_fired_auto_tasks',
      user: claudiaUser || user,
      summary: `Manually fired ${eventType} chain → ${result.fired} task(s) created, ${result.skipped} skipped (triggered by ${triggeredBy})`,
      changes: { event_type: eventType, fired: result.fired, skipped: result.skipped },
    });
  } catch (err) {
    console.error('[fire_auto_task_chain] audit failed:', err?.message || err);
  }

  return {
    ok: true,
    event_type: eventType,
    entity_type: entityType,
    entity_id: entityId,
    fired: result.fired,
    skipped: result.skipped,
  };
}

// ---------- Document categorization ----------

async function setDocumentCategory(env, user, { id, category } = {}) {
  if (!id) throw new Error('set_document_category requires an id.');
  const value = trimOrNull(category);
  const ts = now();
  const result = await run(
    env.DB,
    `UPDATE claudia_documents
        SET category = ?, updated_at = ?
      WHERE id = ? AND user_id = ?`,
    [value, ts, id, user.id]
  );
  return { ok: true, id, category: value, updated_at: ts, changes: result?.meta?.changes ?? null };
}

// ---------- Account / contact merging ----------

// FK columns that point at accounts(id). When merging accounts, every
// row in <table>.<column> = loser_id becomes <table>.<column> = winner_id
// before the loser is deleted. Sourced from grep on the migrations.
const ACCOUNT_FK_REWRITERS = [
  { table: 'contacts',      column: 'account_id' },
  { table: 'opportunities', column: 'account_id' },
  { table: 'activities',    column: 'account_id' },
  { table: 'documents',     column: 'account_id' },
];

const CONTACT_FK_REWRITERS = [
  { table: 'opportunities', column: 'primary_contact_id' },
  { table: 'opportunities', column: 'bant_authority_contact_id' },
  { table: 'activities',    column: 'contact_id' },
  { table: 'documents',     column: 'contact_id' },
];

async function mergeAccounts(env, user, input = {}) {
  return mergeRows(env, user, {
    entityType: 'account',
    table: 'accounts',
    fkRewriters: ACCOUNT_FK_REWRITERS,
    loserId: input.loser_id,
    winnerId: input.winner_id,
    reason: input.reason,
  });
}

async function mergeContacts(env, user, input = {}) {
  return mergeRows(env, user, {
    entityType: 'contact',
    table: 'contacts',
    fkRewriters: CONTACT_FK_REWRITERS,
    loserId: input.loser_id,
    winnerId: input.winner_id,
    reason: input.reason,
  });
}

async function mergeRows(env, user, opts) {
  const { entityType, table, fkRewriters, loserId, winnerId, reason } = opts;
  const loser = String(loserId || '').trim();
  const winner = String(winnerId || '').trim();
  const why = trimOrNull(reason);
  if (!loser) throw new Error(`merge_${table} requires loser_id.`);
  if (!winner) throw new Error(`merge_${table} requires winner_id.`);
  if (!why) throw new Error(`merge_${table} requires reason.`);
  if (loser === winner) {
    return { error: 'same_id', message: 'loser_id and winner_id must differ.' };
  }

  const loserRow = await one(env.DB, `SELECT * FROM ${table} WHERE id = ?`, [loser]);
  const winnerRow = await one(env.DB, `SELECT * FROM ${table} WHERE id = ?`, [winner]);
  if (!loserRow) return { error: 'loser_not_found', loser_id: loser };
  if (!winnerRow) return { error: 'winner_not_found', winner_id: winner };

  // Repoint each FK column. Done as a single batch with the loser
  // delete + audit row so the whole merge is atomic — partial repoints
  // would leave orphaned rows pointing at a deleted parent.
  const stmts = [];
  const repointCounts = {};
  for (const { table: refTable, column } of fkRewriters) {
    // Pre-count so we can report what moved per table; the actual
    // UPDATE below does the rewrite.
    const row = await one(
      env.DB,
      `SELECT COUNT(*) AS n FROM ${refTable} WHERE ${column} = ?`,
      [loser]
    );
    const count = row?.n ?? 0;
    repointCounts[`${refTable}.${column}`] = count;
    if (count > 0) {
      stmts.push(stmt(
        env.DB,
        `UPDATE ${refTable} SET ${column} = ? WHERE ${column} = ?`,
        [winner, loser]
      ));
    }
  }

  // Delete the loser row last, after all repoints land.
  stmts.push(stmt(env.DB, `DELETE FROM ${table} WHERE id = ?`, [loser]));

  // Standard Pipeline audit row attributed to Claudia.
  const claudiaUser = await one(
    env.DB,
    'SELECT id, email, display_name, role FROM users WHERE id = ?',
    [CLAUDIA_USER_ID]
  );
  const triggeredBy = user.display_name || user.email || user.id;
  const winnerLabel = winnerRow.name || `${winnerRow.first_name || ''} ${winnerRow.last_name || ''}`.trim() || winner;
  const loserLabel  = loserRow.name  || `${loserRow.first_name || ''} ${loserRow.last_name || ''}`.trim()  || loser;
  stmts.push(auditStmt(env.DB, {
    entityType,
    entityId: winner,
    eventType: 'merged',
    user: claudiaUser || user,
    summary: `Merged ${entityType} "${loserLabel}" → "${winnerLabel}" — ${why} (triggered by ${triggeredBy})`.slice(0, 500),
    changes: { loser_id: loser, winner_id: winner, repoints: repointCounts, deleted_loser: loserRow },
  }));

  await d1Batch(env.DB, stmts);

  return {
    ok: true,
    entity_type: entityType,
    loser_id: loser,
    winner_id: winner,
    loser_label: loserLabel,
    winner_label: winnerLabel,
    repoints: repointCounts,
    summary: `Merged "${loserLabel}" into "${winnerLabel}". ${Object.values(repointCounts).reduce((a, b) => a + b, 0)} FK references repointed.`,
  };
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
