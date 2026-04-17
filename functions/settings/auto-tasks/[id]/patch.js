// functions/settings/auto-tasks/[id]/patch.js
//
// POST /settings/auto-tasks/:id/patch — inline-save a single field.
//
// Accepts JSON { field, value } and updates one column on task_rules.
// Returns { ok, field, value, error? }. Admin-only.
//
// Trigger validation uses the same enum as functions/lib/auto-tasks.js
// so changing the trigger to an unsupported key isn't possible.

import { one, stmt, batch } from '../../../lib/db.js';
import { auditStmt } from '../../../lib/audit.js';
import { now } from '../../../lib/ids.js';
import { hasRole } from '../../../lib/auth.js';
import { TRIGGERS } from '../index.js';

const PATCHABLE = new Set([
  'name', 'description', 'trigger', 'conditions_json',
  'task_json', 'tz', 'active',
]);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function coerce(field, raw) {
  const v = typeof raw === 'string' ? raw.trim() : raw;

  if (field === 'active') {
    if (v === true || v === 'true' || v === '1' || v === 'on' || v === 1) return 1;
    return 0;
  }
  if (field === 'conditions_json' || field === 'task_json') {
    // Store null for empty. Otherwise validate it parses.
    if (!v) return field === 'task_json' ? null : null;
    try { JSON.parse(v); }
    catch (err) { throw new Error(`Invalid JSON: ${err.message}`); }
    return v;
  }
  if (field === 'trigger') {
    if (!TRIGGERS.some((t) => t.key === v)) {
      throw new Error(`Unknown trigger "${v}"`);
    }
    return v;
  }
  if (v === '' || v === null || v === undefined) {
    // Disallow blanking required fields.
    if (field === 'name') throw new Error('Name is required');
    return null;
  }
  return v;
}

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const id = params.id;

  if (!hasRole(user, 'admin')) {
    return json({ ok: false, error: 'Admin role required' }, 403);
  }

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: 'Invalid request body' }, 400); }

  const { field, value: rawValue } = body;
  if (!field || !PATCHABLE.has(field)) {
    return json({ ok: false, error: `Field "${field}" is not editable` }, 400);
  }

  const before = await one(env.DB, 'SELECT * FROM task_rules WHERE id = ?', [id]);
  if (!before) return json({ ok: false, error: 'Rule not found' }, 404);

  let newValue;
  try { newValue = coerce(field, rawValue); }
  catch (err) { return json({ ok: false, error: err.message }, 400); }

  // Extra validation: task_json must have a title if set.
  if (field === 'task_json' && newValue) {
    try {
      const parsed = JSON.parse(newValue);
      if (!parsed || typeof parsed !== 'object' || !parsed.title) {
        return json({ ok: false, error: 'task template must include a "title" field' }, 400);
      }
    } catch (err) {
      return json({ ok: false, error: `Invalid task_json: ${err.message}` }, 400);
    }
  }

  const ts = now();
  const changes = {};
  if (before[field] !== newValue) {
    changes[field] = { from: before[field], to: newValue };
  }

  try {
    const stmts = [
      stmt(
        env.DB,
        `UPDATE task_rules SET ${field} = ?, updated_at = ? WHERE id = ?`,
        [newValue, ts, id]
      ),
    ];
    if (Object.keys(changes).length) {
      stmts.push(
        auditStmt(env.DB, {
          entityType: 'task_rule',
          entityId: id,
          eventType: 'updated',
          user,
          summary: `Updated rule "${before.name}" ${field}`,
          changes,
        })
      );
    }
    await batch(env.DB, stmts);
  } catch (err) {
    return json({ ok: false, error: String(err?.message ?? err) }, 500);
  }

  return json({ ok: true, field, value: newValue });
}
