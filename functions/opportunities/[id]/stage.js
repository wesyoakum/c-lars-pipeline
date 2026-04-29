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
import { checkInactivateBlockers, summarizeBlockers } from '../../lib/inactivate-blocker.js';
import { fireEvent } from '../../lib/auto-tasks.js';

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

  // ---- Close reason required for terminal-loss stages -----------------
  const CLOSE_REASON_REQUIRED = ['closed_lost', 'closed_died'];
  if (CLOSE_REASON_REQUIRED.includes(targetDef.stage_key) && !value.override_reason?.trim()) {
    return redirectWithFlash(
      `/opportunities/${oppId}`,
      `A close reason is required when moving to "${targetDef.label}".`,
      'error'
    );
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

  // ---- Blocker gate: can't move to a terminal stage while the opp
  //      has pending tasks or active quotes (migration 0035 rule).
  //      The existing close-reason + gate-violation checks above are
  //      orthogonal — they enforce domain rules. This check enforces
  //      the simpler "don't orphan work in flight" rule.
  if (targetDef.is_terminal) {
    const blockers = await checkInactivateBlockers(env.DB, 'opportunity', oppId);
    if (blockers.length > 0) {
      const summary = summarizeBlockers(blockers);
      const msg = `Cannot close this opportunity \u2014 ${summary}.`;
      if (ajax) return jsonResponse({ ok: false, error: msg, blockers }, 409);
      return redirectWithFlash(`/opportunities/${oppId}`, msg, 'error');
    }
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
    ? (targetDef.is_won ? 'won' : (targetDef.stage_key === 'closed_lost' ? 'lost' : 'abandoned'))
    : null;
  const isCloseLoss = targetDef.stage_key === 'closed_lost' || targetDef.stage_key === 'closed_died';
  const lossReasonTag = isCloseLoss ? (value.override_reason || null) : null;

  const statements = [
    stmt(
      env.DB,
      `UPDATE opportunities
          SET stage = ?, stage_entered_at = ?, probability = ?,
              ${isTerminal ? 'close_reason = ?, actual_close_date = ?,' : ''}
              ${isCloseLoss ? 'loss_reason_tag = ?,' : ''}
              updated_at = ?
        WHERE id = ?`,
      [
        targetDef.stage_key, ts, newProbability,
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

  await batch(env.DB, statements);

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
  if (warningMessages.length > 0) {
    flashMsg += ` ⚠ ${warningMessages.join(' · ')}`;
  }

  return redirectWithFlash(
    `/opportunities/${oppId}`,
    flashMsg,
    warningMessages.length > 0 ? 'warn' : 'success'
  );
}
