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

import { one, stmt, batch } from '../../lib/db.js';
import { auditStmt } from '../../lib/audit.js';
import { validateStageTransition, parseTransactionTypes } from '../../lib/validators.js';
import { uuid, now, nextNumber, currentYear } from '../../lib/ids.js';
import { redirectWithFlash, formBody } from '../../lib/http.js';
import { stageDef, stagesFor, evaluateGate, loadGateContext, GATE_MODE } from '../../lib/stages.js';

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
  const { ok, value, errors } = validateStageTransition(input);
  if (!ok) {
    const firstError = Object.values(errors)[0] || 'Bad stage transition';
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
