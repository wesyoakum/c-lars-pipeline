// functions/templates/[type]/upload.js
//
// POST /templates/:type/upload — Replace a .docx template in R2.

import { TEMPLATE_CATALOG } from '../../lib/template-catalog.js';
import { auditStmt } from '../../lib/audit.js';

export async function onRequestPost(context) {
  const { env, request, data, params } = context;
  const user = data?.user;
  const entry = TEMPLATE_CATALOG[params.type];

  if (!entry) {
    return new Response('Unknown template type', { status: 404 });
  }

  // Parse the multipart form
  const formData = await request.formData();
  const file = formData.get('file');
  if (!file || !file.size) {
    return respondBack(request, 'No file selected.', 'error');
  }

  // Basic validation: must be a .docx
  const name = file.name || '';
  if (!name.toLowerCase().endsWith('.docx')) {
    return respondBack(request, 'Template must be a .docx file.', 'error');
  }

  // Upload to R2, replacing the existing template
  const buffer = await file.arrayBuffer();
  await env.DOCS.put(entry.r2Key, buffer, {
    httpMetadata: {
      contentType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    },
    customMetadata: {
      uploadedBy: user?.email ?? 'system',
      uploadedAt: new Date().toISOString(),
      originalFilename: name,
    },
  });

  // Audit
  context.waitUntil(
    auditStmt(env.DB, {
      entityType: 'template',
      entityId: params.type,
      eventType: 'template_uploaded',
      user,
      summary: `Replaced template "${entry.label}" with ${name} (${formatSize(file.size)})`,
    }).run()
  );

  return respondBack(request, `Template "${entry.label}" updated successfully.`);
}

// Redirect back to the referring page with a flash message.
function respondBack(request, message, level = 'success') {
  const referer = request.headers.get('referer') || '/';
  const sep = referer.includes('?') ? '&' : '?';
  const url = `${referer}${sep}flash=${encodeURIComponent(message)}&flash_level=${level}`;
  return Response.redirect(url, 303);
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
