// functions/opportunities/[id]/stage.js
//
// POST /opportunities/:id/stage — advance / move an opportunity to a
// new stage.
//
// M3 keeps this simple: it verifies the target stage is a legal
// stage_key for the opportunity's transaction_type (via the
// stage_definitions catalog), records a `stage_changed` audit event
// with before/after, and writes an override_reason if one was supplied.
//
// Gate rule enforcement is deferred to M7 (see lib/stages.js) — for
// now, every transition is allowed. We still capture override_reason
// because it costs us nothing and makes M7 a drop-in upgrade.

import { one, stmt, batch } from '../../lib/db.js';
import { auditStmt } from '../../lib/audit.js';
import { validateStageTransition } from '../../lib/validators.js';
import { now } from '../../lib/ids.js';
import { redirectWithFlash, formBody } from '../../lib/http.js';
import { stageDef, stagesFor } from '../../lib/stages.js';

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const oppId = params.id;

  const opp = await one(
    env.DB,
    `SELECT id, number, transaction_type, stage, probability FROM opportunities WHERE id = ?`,
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
  const targetDef = await stageDef(env.DB, opp.transaction_type, value.to_stage);
  if (!targetDef) {
    // Dump the legal stage keys into the flash so the user knows what went wrong.
    const legal = (await stagesFor(env.DB, opp.transaction_type))
      .map((s) => s.stage_key)
      .join(', ');
    return redirectWithFlash(
      `/opportunities/${oppId}`,
      `Unknown stage "${value.to_stage}" for ${opp.transaction_type}. Legal stages: ${legal}`,
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

  // TODO(M7): call evaluateGate(env.DB, opp.transaction_type, targetDef.stage_key, ctx)
  // and block on hard violations / require override_reason on soft violations.

  const ts = now();
  const newProbability = targetDef.default_probability ?? opp.probability;

  // Build the audit summary so it's informative in the activity feed.
  const summary =
    `Stage changed from ${opp.stage} → ${targetDef.stage_key}` +
    (value.override_reason ? ` (override: ${value.override_reason})` : '');

  const statements = [
    stmt(
      env.DB,
      `UPDATE opportunities
          SET stage = ?, stage_entered_at = ?, probability = ?, updated_at = ?
        WHERE id = ?`,
      [targetDef.stage_key, ts, newProbability, ts, oppId]
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
      },
      overrideReason: value.override_reason,
    }),
  ];

  await batch(env.DB, statements);

  return redirectWithFlash(
    `/opportunities/${oppId}`,
    `Moved to ${targetDef.label}.`
  );
}
