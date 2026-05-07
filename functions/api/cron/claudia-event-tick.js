// functions/api/cron/claudia-event-tick.js
//
// POST /api/cron/claudia-event-tick — fired by the workers/claudia-consumer
// Worker for each cf-claudia-events queue message, OR by a manual
// /__run on the consumer worker for testing.
//
// Lives under /api/cron/ so it's covered by the same Cloudflare Access
// "Bypass" policy as the existing cron endpoints (sweep, notifications,
// claudia-tick, wfm-step). Despite the name, it's not on a cron
// schedule — the shared path just keeps the Access policy simple.
//
// Responsibility: turn ONE pending event into the right downstream
// artifacts.
//
//   1. Validate the shared secret + (optionally) the CF Access
//      service-token headers.
//   2. Resolve the event by id from claudia_events_pending. If already
//      dispatched, return 200 idempotent (queue redrives are common).
//   3. Run claudia-enrich.enrichEvent() — pure data gathering.
//   4. Run claudia-triage.extractActions() — Sonnet call returning
//      a structured decision.
//   5. Persist the decision:
//        decision='extract' → INSERT 1..N claudia_actions rows + any
//                              linked claudia_questions rows.
//        decision='observe' → INSERT one claudia_observations row
//                              (matches the legacy hourly-tick output
//                              shape so existing UI keeps working).
//        decision='noop'    → no rows written.
//   6. UPDATE claudia_events_pending SET dispatched_at, action_summary
//      so the row is excluded from the hourly sweeper's drain query.
//
// Errors return 5xx so the consumer worker retries with backoff. Logic
// errors (missing event row, missing user) return 4xx so retries don't
// burn budget on something that won't change.
//
// Sandbox scope today: only the assistant owner (Wes). Events for any
// other user are ack'd-as-skipped.

import { all, one, run } from '../../lib/db.js';
import { now, uuid } from '../../lib/ids.js';
import { audit } from '../../lib/audit.js';
import { enrichEvent } from '../../lib/claudia-enrich.js';
import { extractActions } from '../../lib/claudia-triage.js';

const SANDBOX_OWNER_EMAIL = 'wes.yoakum@c-lars.com';

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function checkSecret(request, env) {
  const provided = request.headers.get('x-cron-secret') || '';
  const expected = env.CRON_SECRET || '';
  if (!expected) return false;
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return diff === 0;
}

export async function onRequestPost(context) {
  const { env, request } = context;
  if (!checkSecret(request, env)) {
    return new Response('Unauthorized', { status: 401 });
  }

  let body = {};
  try { body = await request.json(); } catch { /* empty body ok */ }
  const eventId = body?.event_id ?? null;
  if (!eventId) {
    return jsonResponse({ ok: false, error: 'event_id_required' }, 400);
  }

  // Load the canonical row from D1. The queue payload is best-effort
  // and may have stale fields if D1 wrote slowly; trust the row.
  const event = await one(
    env.DB,
    `SELECT id, user_id, type, ref_id, summary, created_at, processed_at, dispatched_at
       FROM claudia_events_pending WHERE id = ?`,
    [eventId]
  );
  if (!event) {
    return jsonResponse({ ok: false, error: 'event_not_found', event_id: eventId }, 404);
  }

  // Idempotency: queue redrives + the hourly sweeper can both target
  // the same id. If we already dispatched, return success without
  // re-processing.
  if (event.dispatched_at) {
    return jsonResponse({
      ok: true,
      skipped: 'already_dispatched',
      event_id: eventId,
      dispatched_at: event.dispatched_at,
    });
  }

  const user = await one(
    env.DB,
    'SELECT id, email, display_name, role FROM users WHERE id = ? LIMIT 1',
    [event.user_id]
  );
  if (!user) {
    await markDispatched(env, eventId, 'noop:user_not_found');
    return jsonResponse({ ok: false, error: 'user_not_found', event_id: eventId }, 404);
  }

  // Phase A scope guard: only the sandbox owner runs the new worker
  // path. Other users' events get marked dispatched-as-skipped so the
  // sweeper doesn't keep retrying them.
  if (user.email !== SANDBOX_OWNER_EMAIL) {
    await markDispatched(env, eventId, 'noop:not_sandbox_owner');
    return jsonResponse({
      ok: true,
      skipped: 'not_sandbox_owner',
      event_id: eventId,
    });
  }

  // ── Enrich ────────────────────────────────────────────────────────
  const enrichment = await enrichEvent(env, {
    id: event.id,
    type: event.type,
    refId: event.ref_id,
    summary: event.summary,
    userId: event.user_id,
  });

  // ── Extract ───────────────────────────────────────────────────────
  const today = new Date().toISOString().slice(0, 10);
  const displayName = user.display_name || user.email;

  const decision = await extractActions(env, {
    event: { id: event.id, type: event.type, ref_id: event.ref_id, summary: event.summary, created_at: event.created_at },
    enrichment,
    displayName,
    today,
  });

  // ── Persist ───────────────────────────────────────────────────────
  const ts = now();
  let actionsInserted = 0;
  let questionsInserted = 0;
  let observationInserted = false;
  let actionSummary = 'noop';

  // Source-kind / source-ref columns inferred from the event type so
  // the per-file drill-down query works without a separate lookup.
  // event types follow `${entity_type}.${event_type}` from auditAndQueue.
  const { sourceKind, sourceRefTable, sourceRefId } = inferSource(event);

  if (decision.decision === 'extract' && decision.actions.length > 0) {
    const insertedIds = [];
    for (const a of decision.actions) {
      const actionId = uuid();
      await run(
        env.DB,
        `INSERT INTO claudia_actions (
            id, user_id,
            source_kind, source_ref_table, source_ref_id, source_event_id,
            raised_by,
            title, detail, rationale,
            quadrant, importance, urgency, due_at,
            proposed_action_json, edited_action_json,
            context_json,
            status, evaluation_count,
            created_at, updated_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          actionId, user.id,
          sourceKind, sourceRefTable, sourceRefId, event.id,
          'claudia',
          a.title, a.detail ?? null, a.rationale ?? null,
          a.quadrant, a.importance ?? null, a.urgency ?? null, a.due_at ?? null,
          a.proposed_action ? JSON.stringify(a.proposed_action) : null,
          null,
          enrichment ? JSON.stringify(trimContext(enrichment)) : null,
          'open', 1,
          ts, ts,
        ]
      );
      insertedIds[a.idx ?? insertedIds.length] = actionId;
      actionsInserted++;
    }

    // Questions: tie back to inserted action ids when source_action_idx is set.
    for (const q of decision.questions || []) {
      const qid = uuid();
      const linkedActionId =
        typeof q.source_action_idx === 'number' ? insertedIds[q.source_action_idx] ?? null : null;
      await run(
        env.DB,
        `INSERT INTO claudia_questions (
            id, user_id, source_action_id, question, context, status, created_at, updated_at
         ) VALUES (?,?,?,?,?,?,?,?)`,
        [qid, user.id, linkedActionId, q.question, q.context ?? null, 'open', ts, ts]
      );
      questionsInserted++;
    }

    // Standard audit_events row for each new action so the per-entity
    // history view shows them. One per action keeps the trail tidy.
    for (const id of insertedIds.filter(Boolean)) {
      try {
        await audit(env.DB, {
          entityType: 'claudia_action',
          entityId: id,
          eventType: 'created',
          user, // attributed to Claudia's actor (the user this fired for)
          summary: `Claudia raised an action from event ${event.type}`,
        });
      } catch {
        // Audit failure is non-fatal — the action row already exists.
      }
    }

    actionSummary = `extract:${decision.actions.length}_actions${questionsInserted ? `+${questionsInserted}q` : ''}`;
  } else if (decision.decision === 'observe' && decision.observation) {
    await run(
      env.DB,
      `INSERT INTO claudia_observations (id, user_id, body, source_kind, created_at)
       VALUES (?, ?, ?, 'event_tick', ?)`,
      [uuid(), user.id, decision.observation, ts]
    );
    observationInserted = true;
    actionSummary = 'observe';
  } else {
    actionSummary = 'noop';
  }

  // Free-floating questions (not tied to any action) — also persist
  // them; this path fires when decision='observe' or when the model
  // raised a clarification without producing an action yet.
  if (decision.decision === 'observe' || actionsInserted === 0) {
    for (const q of decision.questions || []) {
      // If there's no action to link to, source_action_id is null.
      if (typeof q.source_action_idx === 'number') continue; // already linked above
      const qid = uuid();
      await run(
        env.DB,
        `INSERT INTO claudia_questions (
            id, user_id, source_action_id, question, context, status, created_at, updated_at
         ) VALUES (?,?,?,?,?,?,?,?)`,
        [qid, user.id, null, q.question, q.context ?? null, 'open', ts, ts]
      );
      questionsInserted++;
    }
  }

  await markDispatched(env, eventId, actionSummary, decision.modelError ?? null);

  // Also flip processed_at so the legacy claudia-tick path doesn't
  // re-pick this row in its drain. Keeps the two paths in sync.
  await run(
    env.DB,
    `UPDATE claudia_events_pending SET processed_at = ? WHERE id = ? AND processed_at IS NULL`,
    [ts, eventId]
  );

  return jsonResponse({
    ok: true,
    event_id: eventId,
    type: event.type,
    decision: decision.decision,
    actions_inserted: actionsInserted,
    questions_inserted: questionsInserted,
    observation_inserted: observationInserted,
    action_summary: actionSummary,
    model_error: decision.modelError ?? null,
    usage: decision.usage ?? null,
  });
}

async function markDispatched(env, eventId, actionSummary, error = null) {
  await run(
    env.DB,
    `UPDATE claudia_events_pending
        SET dispatched_at = ?, action_summary = ?, dispatch_error = ?
      WHERE id = ?`,
    [now(), actionSummary, error, eventId]
  );
}

// Map an event type like 'document.email_ingested' onto source_kind +
// source_ref_table + source_ref_id for the new claudia_actions row.
// Also handles legacy event types from before the rename pivot.
function inferSource(event) {
  const type = String(event.type || '');
  const refId = event.ref_id ?? null;
  const prefix = type.split('.', 1)[0];

  // Default = treat as a Pipeline event with the entity prefix as the
  // table singular. Worker can override later if needed.
  let sourceKind = 'event';
  let sourceRefTable = null;
  let sourceRefId = refId;

  switch (prefix) {
    case 'document':
    case 'claudia_documents':
      sourceKind = 'file';
      sourceRefTable = 'claudia_documents';
      break;
    case 'ai_inbox_items':
    case 'ai_inbox_item':
      sourceKind = 'file';
      sourceRefTable = 'ai_inbox_items';
      break;
    case 'account':
      sourceRefTable = 'accounts';
      break;
    case 'contact':
      sourceRefTable = 'contacts';
      break;
    case 'opportunity':
      sourceRefTable = 'opportunities';
      break;
    case 'activity':
      sourceRefTable = 'activities';
      break;
    case 'quote':
      sourceRefTable = 'quotes';
      break;
    case 'job':
      sourceRefTable = 'jobs';
      break;
    default:
      sourceRefTable = null;
      sourceRefId = null;
  }

  return { sourceKind, sourceRefTable, sourceRefId };
}

// Drop bulky text from the enrichment payload before persisting on
// claudia_actions.context_json. The model already saw the long
// snippets; the row only needs IDs/names for the UI to re-render.
function trimContext(enrichment) {
  const out = {
    event: enrichment.event,
    principal: enrichment.principal,
    related: {
      docs: (enrichment.related?.docs || []).map((d) => ({
        id: d.id, seq: d.seq ?? null, subject: d.subject ?? null, sender_name: d.sender_name ?? null, created_at: d.created_at ?? null,
      })),
      inbox_items: (enrichment.related?.inbox_items || []).map((i) => ({ id: i.id, title: i.title ?? null })),
      accounts: (enrichment.related?.accounts || []).map((a) => ({ id: a.id, name: a.name })),
      opportunities: (enrichment.related?.opportunities || []).map((o) => ({ id: o.id, number: o.number, title: o.title })),
      contacts: (enrichment.related?.contacts || []).map((c) => ({ id: c.id, name: c.name })),
      activities: (enrichment.related?.activities || []).map((t) => ({ id: t.id, subject: t.subject ?? null })),
      quotes: (enrichment.related?.quotes || []).map((q) => ({ id: q.id, number: q.number ?? null })),
    },
    open_actions: enrichment.open_actions || [],
  };
  return out;
}
