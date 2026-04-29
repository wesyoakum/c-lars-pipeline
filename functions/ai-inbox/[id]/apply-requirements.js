// functions/ai-inbox/[id]/apply-requirements.js
//
// POST /ai-inbox/:id/apply-requirements
//
// Append the entry's extracted `requirements` (technical specs /
// performance criteria) to `notes_internal` on a linked opportunity
// or quote. The body picks the target:
//
//   { target_kind: 'opportunity' | 'quote', target_id: '<uuid>' }
//
// The text written is a small block prefixed with the entry's title
// + date so multiple pushes accumulate readably:
//
//   --- Tech specs from AI Inbox: <title> (<YYYY-MM-DD>) ---
//   [performance] 10–20 ton load capacity
//   [environmental] 500 m water depth rating
//   ...
//
// Idempotent in spirit but not enforced: a second push appends a
// second copy. The audit row makes that recoverable.

import { one, run, batch, stmt } from '../../lib/db.js';
import { auditStmt } from '../../lib/audit.js';
import { now } from '../../lib/ids.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

const TARGET_TABLES = {
  opportunity: 'opportunities',
  quote:       'quotes',
};

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  if (!user) return json({ ok: false, error: 'unauthenticated' }, 401);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: 'invalid_json' }, 400); }

  const targetKind = String(body?.target_kind || '').toLowerCase();
  const targetId = body?.target_id;
  if (!TARGET_TABLES[targetKind]) return json({ ok: false, error: 'bad_target_kind' }, 400);
  if (!targetId)                  return json({ ok: false, error: 'missing_target_id' }, 400);

  // Load the entry, ownership-check.
  const entry = await one(
    env.DB,
    'SELECT id, user_id, extracted_json FROM ai_inbox_items WHERE id = ?',
    [params.id]
  );
  if (!entry)                     return json({ ok: false, error: 'not_found' }, 404);
  if (entry.user_id !== user.id) return json({ ok: false, error: 'forbidden' }, 403);

  let extracted = {};
  try { extracted = JSON.parse(entry.extracted_json || '{}'); } catch { extracted = {}; }
  const requirements = Array.isArray(extracted.requirements) ? extracted.requirements : [];
  if (requirements.length === 0) {
    return json({ ok: false, error: 'no_requirements' }, 400);
  }

  // Load the target row + its current notes_internal.
  const table = TARGET_TABLES[targetKind];
  const target = await one(env.DB,
    `SELECT id, notes_internal FROM ${table} WHERE id = ?`,
    [targetId]);
  if (!target) return json({ ok: false, error: 'target_not_found' }, 404);

  // Compose the appended block.
  const dateLabel = new Date().toISOString().slice(0, 10);
  const titleLabel = (extracted.title || '').trim() || '(untitled entry)';
  const lines = [
    `--- Tech specs from AI Inbox: ${titleLabel} (${dateLabel}) ---`,
    ...requirements.map(r => {
      const cat = (r?.category || 'other').toLowerCase();
      const text = String(r?.text || '').trim();
      return `[${cat}] ${text}`;
    }).filter(s => !s.endsWith('] ')),
  ];
  const block = lines.join('\n');

  const existing = target.notes_internal || '';
  const newNotes = existing.trim()
    ? existing.trimEnd() + '\n\n' + block
    : block;

  const ts = now();
  const auditEntityType = targetKind === 'opportunity' ? 'opportunity' : 'quote';
  await batch(env.DB, [
    stmt(env.DB,
      `UPDATE ${table}
          SET notes_internal = ?, updated_at = ?
        WHERE id = ?`,
      [newNotes, ts, targetId]),
    auditStmt(env.DB, {
      entityType: auditEntityType,
      entityId: targetId,
      eventType: 'updated',
      user,
      summary: `Appended ${requirements.length} tech spec${requirements.length === 1 ? '' : 's'} from AI Inbox entry`,
      changes: { notes_internal: { from: existing, to: newNotes } },
    }),
  ]);

  return json({ ok: true, count: requirements.length, target_kind: targetKind, target_id: targetId });
}
