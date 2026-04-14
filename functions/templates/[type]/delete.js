// functions/templates/[type]/delete.js
//
// POST /templates/:type/delete — Remove a template file from R2.
// The catalog entry remains (it's code-defined), but the uploaded file is deleted.

import { TEMPLATE_CATALOG } from '../../lib/template-catalog.js';
import { auditStmt } from '../../lib/audit.js';

export async function onRequestPost(context) {
  const { env, request, data, params } = context;
  const user = data?.user;
  const entry = TEMPLATE_CATALOG[params.type];

  if (!entry) {
    return new Response('Unknown template type', { status: 404 });
  }

  // Check if file exists
  const obj = await env.DOCS.head(entry.r2Key);
  if (!obj) {
    return respondBack(request, 'Template file not found.', 'error');
  }

  // Delete from R2
  await env.DOCS.delete(entry.r2Key);

  // Audit
  context.waitUntil(
    auditStmt(env.DB, {
      entityType: 'template',
      entityId: params.type,
      eventType: 'template_deleted',
      user,
      summary: `Deleted template "${entry.label}"`,
    }).run()
  );

  return respondBack(request, `Deleted template "${entry.label}".`);
}

function respondBack(request, message, level = 'success') {
  const referer = request.headers.get('referer') || '/documents/templates';
  const clean = referer.split('?')[0];
  const url = `${clean}?flash=${encodeURIComponent(message)}&flash_level=${level}`;
  return new Response(null, { status: 303, headers: { Location: url } });
}
