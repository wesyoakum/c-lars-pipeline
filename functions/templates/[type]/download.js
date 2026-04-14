// functions/templates/[type]/download.js
//
// GET /templates/:type/download — Download the current .docx template from R2.

import { TEMPLATE_CATALOG } from '../../lib/template-catalog.js';

export async function onRequestGet(context) {
  const { env, params } = context;
  const entry = TEMPLATE_CATALOG[params.type];

  if (!entry) {
    return new Response('Unknown template type', { status: 404 });
  }

  const obj = await env.DOCS.get(entry.r2Key);
  if (!obj) {
    return new Response('Template not yet uploaded', { status: 404 });
  }

  const headers = new Headers();
  headers.set('content-type',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  headers.set('content-disposition',
    `attachment; filename="${entry.filename}"`);

  return new Response(obj.body, { status: 200, headers });
}
