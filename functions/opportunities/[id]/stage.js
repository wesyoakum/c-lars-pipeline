// functions/opportunities/[id]/stage.js
//
// POST /opportunities/:id/stage — advance / move an opportunity to a
// new stage.
//
// Gate checks evaluate real data (account, contacts, price builds, quotes,
// documents) and produce warnings or blockers depending on GATE_MODE.
// In 'warn' mode (current default), all violations are shown as warnings
// but the transition always proceeds. Switch to 'enforce' in lib/stages.js
// to make hard gates block transitions.

import { one, all, stmt, batch } from '../../lib/db.js';
import { auditStmt } from '../../lib/audit.js';
import { validateStageTransition, parseTransactionTypes } from '../../lib/validators.js';
import { uuid, now, nextNumber, currentYear } from '../../lib/ids.js';
import { redirectWithFlash, formBody } from '../../lib/http.js';
import { stageDef, stagesFor, evaluateGate, loadGateContext, GATE_MODE } from '../../lib/stages.js';
import { notifyStmt } from '../../lib/notify.js';
import { notifyExternal, NOTIFICATION_EVENTS } from '../../lib/notify-external.js';

import { fireEvent } from '../../lib/auto-tasks.js';
import { queueClaudiaEvent } from '../../lib/claudia-events.js';

function isAjaxRequest(request, input) {
  if (input?.source === 'wizard' || input?.source === 'modal') return true;
  const xrw = request.headers.get('x-requested-with');
  if (xrw && xrw.toLowerCase() === 'xmlhttprequest') return true;
  const accept = request.headers.get('accept') || '';
  return accept.includes('application/json') && !accept.includes('text/html');
}
function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const oppId = params.id;

  const opp = await one(
    env.DB,
    `SELECT * FROM opportunities WHERE id = ?`,
    [oppId]
  );
  if (!opp) {
    return redirectWithFlash('/opportunities', 'Opportunity not found.', 'error');
  }

  const input = await formBody(request);
  const ajax = isAjaxRequest(request, input);
  const { ok, value, errors } = validateStageTransition(input);
  if (!ok) {
    const firstError = Object.values(errors)[0] || 'Bad stage transition';
    if (ajax) return jsonResponse({ ok: false, error: firstError }, 400);
    return redirectWithFlash(`/opportunities/${oppId}`, firstError, 'error');
  }

  // Confirm the target stage is real for this transaction_type.
  // Multi-type opps share stages, so use the primary (first) type.
  const primaryType = parseTransactionTypes(opp.transaction_type)[0] ?? 'spares';
  const targetDef = await stageDef(env.DB, primaryType, value.to_stage);
  if (!targetDef) {
    const legal = (await stagesFor(env.DB, primaryType))
      .map((s) => s.stage_key)
      .join(', ');
    return redirectWithFlash(
      `/opportunities/${oppId}`,
      `Unknown stage "${value.to_stage}" for ${primaryType}. Legal stages: ${legal}`,
      'error'
    );
  }

  if (targetDef.stage_key === opp.stage) {
    return redirectWithFlash(
      `/opportunities/${oppId}`,
      'Already at that stage.',
      'info'
    );
  }

  // Close reason is optional — captured if provided but not required.

  // ---- Customer PO required to enter the won / OC / job phase ---------
  // Mirrors the close-reason hard guard above: a human cannot push a
  // deal into any is_won stage (won, oc_drafted, oc_submitted,
  // job_in_progress, the change-order stages, completed) via the picker
  // without a recorded customer PO. The auto-accept path bypasses this
  // intentionally (changeOppStage, not this endpoint) so drafting can
  // begin pre-PO; issuing the OC then enforces the PO too (issue-oc.js).
  if (targetDef.is_won && !String(opp.customer_po_number || '').trim()) {
    const msg = `A customer PO number is required to move to "${targetDef.label}". Add the PO on the opportunity first.`;
    if (ajax) return jsonResponse({ ok: false, error: msg }, 400);
    return redirectWithFlash(`/opportunities/${oppId}`, msg, 'error');
  }

  // ---- Gate evaluation ------------------------------------------------
  const gateCtx = await loadGateContext(env.DB, opp);
  const gateResult = await evaluateGate(env.DB, primaryType, targetDef.stage_key, gateCtx);

  // In enforce mode, block on hard violations (unless override_reason given)
  if (!gateResult.allowed && !value.override_reason) {
    const hardMessages = gateResult.violations
      .filter(v => v.severity === 'hard')
      .map(v => v.message);
    return redirectWithFlash(
      `/opportunities/${oppId}`,
      `Blocked: ${hardMessages.join('; ')}. Provide an override reason to proceed.`,
      'error'
    );
  }

  // ---- Terminal stage: auto-close active quotes and pending tasks.
  //      Active quotes → 'dead', pending tasks → 'completed'.
  //      This replaces the old blocker gate that refused the transition.
  let autoClosedQuotes = 0;
  let autoCompletedTasks = 0;
  if (targetDef.is_terminal) {
    const activeQuoteList = ['draft','issued','revision_draft','revision_issued','accepted','expired']
      .map(s => `'${s}'`).join(', ');
    const activeQuotes = await all(env.DB,
      `SELECT id, number FROM quotes
        WHERE opportunity_id = ? AND status IN (${activeQuoteList}) AND deleted_at IS NULL`,
      [oppId]);
    autoClosedQuotes = activeQuotes.length;

    const pendingTasks = await all(env.DB,
      `SELECT id FROM activities
        WHERE opportunity_id = ? AND status = 'pending'`,
      [oppId]);
    autoCompletedTasks = pendingTasks.length;
  }

  // ---- Perform the transition -----------------------------------------
  const ts = now();
  const newProbability = targetDef.default_probability ?? opp.probability;

  // Build audit summary with gate info
  const warningMessages = gateResult.warnings.map(w => w.message);
  let summary =
    `Stage changed from ${opp.stage} → ${targetDef.stage_key}`;
  if (value.override_reason) {
    summary += ` (override: ${value.override_reason})`;
  }
  if (warningMessages.length > 0) {
    summary += ` [warnings: ${warningMessages.join('; ')}]`;
  }

  // If moving to a terminal stage, set close_reason and actual_close_date
  const isTerminal = !!targetDef.is_terminal;
  const closeReason = isTerminal
    ? (targetDef.is_won ? 'won' : (targetDef.stage_key === 'lost' ? 'lost' : 'closed_died'))
    : null;
  const isCloseLoss = targetDef.stage_key === 'lost' || targetDef.stage_key === 'closed_died';
  const lossReasonTag = isCloseLoss ? (value.override_reason || null) : null;

  // Entering the RFQ stage stamps the RFQ received date with today
  // (when not already set). The RFQ due date is prompted client-side.
  const setRfqReceived =
    targetDef.stage_key === 'rfq_received' && !opp.rfq_received_date;
  const todayDate = ts.slice(0, 10);

  const statements = [
    stmt(
      env.DB,
      `UPDATE opportunities
          SET stage = ?, stage_entered_at = ?, probability = ?,
              ${setRfqReceived ? 'rfq_received_date = ?,' : ''}
              ${isTerminal ? 'close_reason = ?, actual_close_date = ?,' : ''}
              ${isCloseLoss ? 'loss_reason_tag = ?,' : ''}
              updated_at = ?
        WHERE id = ?`,
      [
        targetDef.stage_key, ts, newProbability,
        ...(setRfqReceived ? [todayDate] : []),
        ...(isTerminal ? [closeReason, ts] : []),
        ...(isCloseLoss ? [lossReasonTag] : []),
        ts, oppId,
      ]
    ),
    auditStmt(env.DB, {
      entityType: 'opportunity',
      entityId: oppId,
      eventType: 'stage_changed',
      user,
      summary,
      changes: {
        stage: { from: opp.stage, to: targetDef.stage_key },
        probability: { from: opp.probability, to: newProbability },
        ...(isTerminal ? { close_reason: { from: opp.close_reason, to: closeReason } } : {}),
        gate_warnings: warningMessages.length > 0 ? warningMessages : undefined,
      },
      overrideReason: value.override_reason,
    }),
  ];

  // Auto-close active quotes → 'dead' and pending tasks → 'completed'
  if (autoClosedQuotes > 0) {
    const activeQuoteList = ['draft','issued','revision_draft','revision_issued','accepted','expired']
      .map(s => `'${s}'`).join(', ');
    statements.push(stmt(env.DB,
      `UPDATE quotes SET status = 'dead', updated_at = ?
        WHERE opportunity_id = ? AND status IN (${activeQuoteList}) AND deleted_at IS NULL`,
      [ts, oppId]));
    statements.push(auditStmt(env.DB, {
      entityType: 'opportunity',
      entityId: oppId,
      eventType: 'quotes_auto_closed',
      user,
      summary: `${autoClosedQuotes} active quote${autoClosedQuotes === 1 ? '' : 's'} moved to Dead (opportunity closed)`,
    }));
  }
  if (autoCompletedTasks > 0) {
    statements.push(stmt(env.DB,
      `UPDATE activities SET status = 'completed', is_completed = 1, completed_at = ?, updated_at = ?
        WHERE opportunity_id = ? AND status = 'pending'`,
      [ts, ts, oppId]));
    statements.push(auditStmt(env.DB, {
      entityType: 'opportunity',
      entityId: oppId,
      eventType: 'tasks_auto_completed',
      user,
      summary: `${autoCompletedTasks} pending task${autoCompletedTasks === 1 ? '' : 's'} auto-completed (opportunity closed)`,
    }));
  }

  await batch(env.DB, statements);

  // Best-effort enqueue for Claudia's hourly tick. Never throws.
  await queueClaudiaEvent(
    env,
    user,
    'opp_stage_change',
    oppId,
    `Opp ${opp.number} (${opp.title}): ${opp.stage} → ${targetDef.stage_key}`
  );

  // T4.2 Phase 1 — fan out an in-app notification to every other active
  // user so they see the stage change as a toast. Failures here should
  // never roll back the stage transition — they're wrapped in a try/catch
  // and logged instead.
  try {
    const recipients = await all(
      env.DB,
      `SELECT id FROM users
        WHERE active = 1 AND id != ?`,
      [user?.id ?? '']
    );
    if (recipients.length > 0) {
      const actorName = user?.display_name || user?.email || 'Someone';
      const title = `${opp.number}: ${opp.title}`;
      const body = `${actorName} moved to ${targetDef.label}`;
      const linkUrl = `/opportunities/${oppId}`;
      const notifyStmts = recipients.map((r) =>
        notifyStmt(env.DB, {
          userId:     r.id,
          type:       'stage_changed',
          title,
          body,
          linkUrl,
          entityType: 'opportunity',
          entityId:   oppId,
        })
      );
      await batch(env.DB, notifyStmts);
    }
  } catch (err) {
    console.error('stage-change notify fan-out failed:', err?.message || err);
  }

  // Phase 7d-2 — fire the external (Teams / email) notification to
  // the opportunity owner. Skip-self protection is applied inside
  // notifyExternal() based on the recipient's notify_self_actions
  // setting; the actor (user.id) is passed so the dispatcher can
  // make that decision. Owner missing or equal to actor with default
  // settings → no-op. Wrapped in waitUntil so the user-facing
  // redirect doesn't block on outbound HTTP.
  if (opp.owner_user_id) {
    context.waitUntil(
      notifyExternal(env, {
        userId: opp.owner_user_id,
        actorUserId: user?.id || null,
        eventType: NOTIFICATION_EVENTS.OPP_STAGE_CHANGED,
        data: {
          opp_label: `${opp.number}: ${opp.title}`,
          previous_stage: opp.stage,
          new_stage: targetDef.label || targetDef.stage_key,
          actor: user?.display_name || user?.email || 'Someone',
          link: `/opportunities/${oppId}`,
        },
        context: { ref_type: 'opportunity', ref_id: oppId },
        idempotencyKey: `opp_stage_changed:${oppId}:${ts}`,
      }).catch(err => console.error('notifyExternal(opp_stage_changed) failed:', err?.message || err))
    );
  }

  // Auto-tasks Phase 1 — fire opportunity.stage_changed into the rules
  // engine. The payload carries the updated opp plus explicit
  // stage_from / stage_to so condition DSLs can reference them without
  // digging into the activity row.
  context.waitUntil(
    (async () => {
      try {
        const fresh = await one(env.DB, 'SELECT * FROM opportunities WHERE id = ?', [oppId]);
        const account = fresh?.account_id
          ? await one(env.DB, 'SELECT * FROM accounts WHERE id = ?', [fresh.account_id])
          : null;
        await fireEvent(env, 'opportunity.stage_changed', {
          trigger: { user, at: ts },
          opportunity: fresh,
          account,
          stage_from: opp.stage,
          stage_to: targetDef.stage_key,
        }, user);
      } catch (err) {
        console.error('fireEvent(opportunity.stage_changed) failed:', err?.message || err);
      }
    })()
  );

  // Auto-create Job when closing as won
  let jobNumber = null;
  if (targetDef.is_won) {
    // Check if a job already exists for this opportunity
    const existingJob = await one(env.DB,
      'SELECT id FROM jobs WHERE opportunity_id = ? AND status != ?',
      [oppId, 'cancelled']);
    if (!existingJob) {
      const jobId = uuid();
      jobNumber = await nextNumber(env.DB, `JOB-${currentYear()}`);
      const oppTypes = parseTransactionTypes(opp.transaction_type);
      const isEps = oppTypes.includes('eps');
      await batch(env.DB, [
        stmt(env.DB,
          `INSERT INTO jobs
             (id, number, opportunity_id, job_type, status, title,
              customer_po_number, ntp_required, created_at, updated_at,
              created_by_user_id)
           VALUES (?, ?, ?, ?, 'created', ?, ?, ?, ?, ?, ?)`,
          [jobId, jobNumber, oppId, opp.transaction_type,
           opp.title, opp.customer_po_number || null,
           isEps ? 1 : 0, ts, ts, user?.id]),
        auditStmt(env.DB, {
          entityType: 'job',
          entityId: jobId,
          eventType: 'created',
          user,
          summary: `Job ${jobNumber} auto-created from opportunity ${opp.number} (${opp.transaction_type})`,
        }),
      ]);
    }
  }

  // Flash: show the success + any warnings
  let flashMsg = `Moved to ${targetDef.label}.`;
  if (jobNumber) flashMsg += ` Job ${jobNumber} created.`;
  if (autoClosedQuotes > 0) flashMsg += ` ${autoClosedQuotes} quote${autoClosedQuotes === 1 ? '' : 's'} moved to Dead.`;
  if (autoCompletedTasks > 0) flashMsg += ` ${autoCompletedTasks} task${autoCompletedTasks === 1 ? '' : 's'} completed.`;
  if (warningMessages.length > 0) {
    flashMsg += ` ⚠ ${warningMessages.join(' · ')}`;
  }

  return redirectWithFlash(
    `/opportunities/${oppId}`,
    flashMsg,
    warningMessages.length > 0 ? 'warn' : 'success'
  );
}
