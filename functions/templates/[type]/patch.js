// functions/templates/[type]/patch.js
//
// POST /templates/:type/patch — Update template metadata (label, category).
// Stores overrides in R2 custom metadata alongside the existing file.

import { TEMPLATE_CATALOG } from '../../lib/template-catalog.js';

export async function onRequestPost(context) {
  const { env, request, params } = context;
  const entry = TEMPLATE_CATALOG[params.type];

  if (!entry) {
    return json({ ok: false, error: 'Unknown template type' }, 404);
  }

  let body;
  try { body = await request.json(); } catch {
    return json({ ok: false, error: 'Invalid JSON' }, 400);
  }

  const { field, value } = body;
  if (field !== 'label') {
    return json({ ok: false, error: `Field "${field}" is not editable` }, 400);
  }

  const newValue = (typeof value === 'string' ? value.trim() : value) || entry.label;

  // Read existing object to preserve the file and other metadata
  const obj = await env.DOCS.head(entry.r2Key);
  if (!obj) {
    return json({ ok: false, error: 'Template not uploaded yet' }, 404);
  }

  // Update custom metadata — must re-put with the same body
  // R2 doesn't support metadata-only updates, so we copy in place
  const fullObj = await env.DOCS.get(entry.r2Key);
  const existing = obj.customMetadata || {};
  await env.DOCS.put(entry.r2Key, fullObj.body, {
    httpMetadata: obj.httpMetadata,
    customMetadata: { ...existing, customLabel: newValue },
  });

  return json({ ok: true, field, value: newValue });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
