// functions/sandbox/assistant/actions/[id]/approve.js
//
// POST /sandbox/assistant/actions/:id/approve
//
// Executes the action's proposed_action_json (or edited_action_json
// if Wes edited it) by dispatching through the existing chat tool
// registry (tools.js). On success the action row flips to
// status='completed' with completed_reason='action_executed' and
// execution_audit_id pointing at the resulting claudia_writes row
// (so the standard 72h undo path applies).
//
// Path requires the action to be open and have a non-null
// proposed_action_json (or edited_action_json). Wes-only.
//
// Phase B: only the conservative set of tools listed in claudia-triage's
// ALLOWED_PROPOSED_TOOLS will appear here, since the extractor strips
// anything else before persisting. We additionally re-check that the
// tool exists in the user's current permissions catalog so a
// settings-page disable mid-flight doesn't sneak past.

import { one, run } from '../../../../lib/db.js';
import { now } from '../../../../lib/ids.js';
import { audit } from '../../../../lib/audit.js';
import {
  loadActionsAndQuestions,
  renderActionsPanel,
} from '../../../../lib/claudia-actions-render.js';
import { makeAssistantTools } from '../../tools.js';

const SANDBOX_OWNER = 'wes.yoakum@c-lars.com';

function htmlFragment(s) {
  return new Response(String(s), {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

// HTMX requests get a panel-fragment swap; plain form POSTs (e.g.
// from the per-file drill-down page) get a 303 redirect to the
// Referer so the browser lands back on a fully-rendered page with
// fresh state.
async function respond(env, user, request) {
  if (request.headers.get('HX-Request')) {
    const { actions } = await loadActionsAndQuestions(env, user.id);
    return htmlFragment(renderActionsPanel(actions));
  }
  const referer = request.headers.get('Referer') || '/sandbox/assistant';
  return new Response(null, { status: 303, headers: { Location: referer } });
}

function parseJsonField(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

export async function onRequestPost(context) {
  const { env, data, params } = context;
  const user = data?.user;
  if (!user || user.email !== SANDBOX_OWNER) {
    return new Response('Not found', { status: 404 });
  }

  const actionId = params.id;
  const action = await one(
    env.DB,
    `SELECT id, status, title, proposed_action_json, edited_action_json
       FROM claudia_actions WHERE id = ? AND user_id = ?`,
    [actionId, user.id]
  );
  if (!action) return new Response('Not found', { status: 404 });
  if (action.status !== 'open') {
    // Idempotent: re-render and return without re-execution.
    return await respond(env, user, context.request);
  }

  // Effective payload: edited overrides proposed, neither means we
  // have nothing to execute.
  const effective = parseJsonField(action.edited_action_json) || parseJsonField(action.proposed_action_json);
  if (!effective || !effective.tool || typeof effective.payload !== 'object') {
    // Nothing to execute. Same outcome as Done; flip with a distinct
    // reason so the audit trail explains why.
    return await markCompletedNoExec(env, user, action, 'no_proposed_action', context.request);
  }

  // Dispatch through the chat tool registry. makeAssistantTools applies
  // the catalog filter so a tool the user has disabled won't be in the
  // execute closure — and we get the same error shape chat sees.
  let toolset;
  try {
    toolset = await makeAssistantTools({ env, user });
  } catch (err) {
    return await markCompletedNoExec(env, user, action, `tools_load_failed:${err?.message || String(err)}`, context.request);
  }
  const exec = toolset?.execute;
  if (typeof exec !== 'function') {
    return await markCompletedNoExec(env, user, action, 'tools_dispatch_unavailable', context.request);
  }

  let result;
  try {
    result = await exec(effective.tool, effective.payload || {});
  } catch (err) {
    // Tool threw — keep the action row open so Wes can retry / edit.
    const ts = now();
    await run(
      env.DB,
      `UPDATE claudia_actions
          SET execution_error = ?,
              updated_at = ?
        WHERE id = ?`,
      [String(err?.message || err).slice(0, 500), ts, actionId]
    );
    return await respond(env, user, context.request);
  }

  // Tool returned a structured error result (not a throw). Same shape
  // as a throw — keep the row open and surface the error.
  if (result && (result.error || result.ok === false)) {
    const ts = now();
    await run(
      env.DB,
      `UPDATE claudia_actions
          SET execution_error = ?,
              updated_at = ?
        WHERE id = ?`,
      [String(result.error || result.message || 'tool_returned_error').slice(0, 500), ts, actionId]
    );
    return await respond(env, user, context.request);
  }

  // Success path. Most write tools return { audit_id, ... } from
  // claudiaInsert / claudiaUpdate. Capture it for the 72h undo path.
  const auditId = result?.audit_id || result?.id || null;
  const ts = now();
  await run(
    env.DB,
    `UPDATE claudia_actions
        SET status = 'completed',
            completed_at = ?,
            completed_reason = 'action_executed',
            decided_at = ?,
            decided_by_user_id = ?,
            execution_audit_id = ?,
            execution_error = NULL,
            updated_at = ?
      WHERE id = ?`,
    [ts, ts, user.id, auditId, ts, actionId]
  );

  try {
    await audit(env.DB, {
      entityType: 'claudia_action',
      entityId: actionId,
      eventType: 'approved',
      user,
      summary: `Approved + executed (${effective.tool}): ${(action.title || '').slice(0, 200)}`,
      changes: auditId ? { execution_audit_id: { from: null, to: auditId } } : null,
    });
  } catch { /* non-fatal */ }

  return await respond(env, user, context.request);
}

// Mark the action completed without firing a tool — used when the
// proposed payload is malformed or the tool registry isn't available.
// Distinct completed_reason values so the audit trail explains why.
async function markCompletedNoExec(env, user, action, reason, request) {
  const ts = now();
  await run(
    env.DB,
    `UPDATE claudia_actions
        SET status = 'completed',
            completed_at = ?,
            completed_reason = ?,
            decided_at = ?,
            decided_by_user_id = ?,
            updated_at = ?
      WHERE id = ?`,
    [ts, reason, ts, user.id, ts, action.id]
  );
  try {
    await audit(env.DB, {
      entityType: 'claudia_action',
      entityId: action.id,
      eventType: 'completed',
      user,
      summary: `Completed (${reason}): ${(action.title || '').slice(0, 200)}`,
    });
  } catch { /* non-fatal */ }
  return await respond(env, user, request);
}
