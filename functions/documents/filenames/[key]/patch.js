// functions/documents/filenames/[key]/patch.js
//
// POST /documents/filenames/:key/patch — Inline-save the filename
// template for a given document kind. Accepts JSON { template: "..." }
// and writes the trimmed string straight to filename_templates.

import { stmt, batch, one } from '../../../lib/db.js';
import { auditStmt } from '../../../lib/audit.js';

export async function onRequestPost(context) {
  const { env, request, params, data } = context;
  const user = data?.user;
  const key = params.key;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON' }, 400);
  }

  const template = typeof body?.template === 'string'
    ? body.template.trim()
    : '';

  if (!template) {
    return json({ ok: false, error: 'Template cannot be empty' }, 400);
  }

  // Verify the row exists — we don't want the patch endpoint silently
  // inserting brand-new kinds the generators don't know about.
  const existing = await one(
    env.DB,
    'SELECT key, template FROM filename_templates WHERE key = ?',
    [key]
  );
  if (!existing) {
    return json({ ok: false, error: `Unknown template key: ${key}` }, 404);
  }

  if (existing.template === template) {
    return json({ ok: true, template, unchanged: true });
  }

  await batch(env.DB, [
    stmt(
      env.DB,
      'UPDATE filename_templates SET template = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ?',
      [template, key]
    ),
    auditStmt(env.DB, {
      entityType: 'filename_template',
      entityId: key,
      eventType: 'updated',
      user,
      summary: `Updated ${key} filename template`,
      changes: { template: { from: existing.template, to: template } },
    }),
  ]);

  return json({ ok: true, template });
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
