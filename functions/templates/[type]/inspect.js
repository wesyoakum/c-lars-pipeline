// functions/templates/[type]/inspect.js
//
// GET /templates/:type/inspect — diagnostic for "my generated PDF is
// blank in places" issues. Pulls the .docx from R2, scans it for
// `{placeholder}` tokens, and reports them alongside the data keys
// the server provides for that template type.
//
// Output is JSON or HTML (Accept-driven). Read-only — admin-only on
// the principle that template internals are infrastructure, not user
// data.

import PizZip from 'pizzip';
import { TEMPLATE_CATALOG } from '../../lib/template-catalog.js';
import { hasRole } from '../../lib/auth.js';
import { getQuoteDocData, getOcDocData } from '../../lib/doc-generate.js';
import { layout, htmlResponse, html, escape } from '../../lib/layout.js';
import { all } from '../../lib/db.js';

function wantsJson(request) {
  const a = request.headers.get('accept') || '';
  return a.includes('application/json') && !a.includes('text/html');
}

/** Pull all `{...}` and `{#...}` / `{/...}` / `{^...}` tokens out of
 * the document.xml inside a .docx. Strips internal Word XML noise so
 * a placeholder split across runs (`<w:t>{Quote</w:t>...<w:t>Number}</w:t>`)
 * still parses as a single `QuoteNumber`. */
function extractPlaceholders(docxBuf) {
  const zip = new PizZip(docxBuf);
  const xmlFiles = Object.keys(zip.files).filter(n =>
    n.endsWith('.xml') && (n.startsWith('word/') || n.startsWith('docProps/')));
  const found = new Set();
  for (const name of xmlFiles) {
    const xml = zip.files[name].asText();
    // Strip XML tags so placeholders split across runs reunite. This
    // mirrors what docxtemplater does internally.
    const text = xml.replace(/<[^>]+>/g, '');
    const re = /\{([#\/^]?)([^{}]+)\}/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const raw = m[2].trim();
      if (raw && !raw.includes('w:') && raw.length < 100) {
        found.add(raw);
      }
    }
  }
  return Array.from(found).sort();
}

export async function onRequestGet(context) {
  const { env, data, params, request } = context;
  const user = data?.user;
  if (!user) return new Response('Sign in required', { status: 401 });
  if (!hasRole(user, 'admin')) return new Response('Admin only', { status: 403 });

  const entry = TEMPLATE_CATALOG[params.type];
  if (!entry) return new Response('Unknown template type', { status: 404 });

  const obj = await env.DOCS.get(entry.r2Key);
  if (!obj) {
    return new Response(`Template not uploaded: ${entry.r2Key}`, { status: 404 });
  }

  const buf = await obj.arrayBuffer();
  const placeholders = extractPlaceholders(buf);

  // Build a sample data object for this template type so we can
  // compare placeholder names against what the server provides. We
  // pick the most-recently-updated quote (or job, for OC templates)
  // as a stand-in.
  let providedKeys = [];
  let sampleId = null;
  let sampleFor = null;
  try {
    if (params.type.startsWith('quote-')) {
      const recent = await all(env.DB,
        `SELECT id FROM quotes ORDER BY updated_at DESC LIMIT 1`, []);
      if (recent[0]) {
        sampleId = recent[0].id;
        sampleFor = 'quote';
        const sample = await getQuoteDocData(env, sampleId);
        if (sample) providedKeys = Object.keys(sample).filter(k => !k.startsWith('_'));
      }
    } else if (params.type.startsWith('oc-')) {
      const recent = await all(env.DB,
        `SELECT id FROM jobs ORDER BY updated_at DESC LIMIT 1`, []);
      if (recent[0]) {
        sampleId = recent[0].id;
        sampleFor = 'job';
        const sample = await getOcDocData(env, sampleId);
        if (sample) providedKeys = Object.keys(sample).filter(k => !k.startsWith('_'));
      }
    }
  } catch (_) { /* best-effort; provided list may be empty */ }

  const providedSet = new Set(providedKeys);
  const matched = placeholders.filter(p => {
    // For loop tags `#name` / `/name` / `^name`, the underlying key
    // is `name`. Strip the prefix.
    const k = p.replace(/^[#\/^]/, '');
    return providedSet.has(k);
  });
  const unmatched = placeholders.filter(p => {
    const k = p.replace(/^[#\/^]/, '');
    return !providedSet.has(k);
  });

  if (wantsJson(request)) {
    return new Response(JSON.stringify({
      template_type: params.type,
      r2_key: entry.r2Key,
      sample_for: sampleFor,
      sample_id: sampleId,
      placeholders_in_template: placeholders,
      provided_by_server: providedKeys,
      matched, unmatched,
    }, null, 2), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  const body = html`
    <div class="card" style="max-width:980px;margin:1.5rem auto">
      <h1>Template diagnostic — ${escape(entry.label || params.type)}</h1>
      <p class="muted">
        R2 key: <code>${escape(entry.r2Key)}</code>
        ${sampleFor ? html` · sample data from ${escape(sampleFor)} <code>${escape(String(sampleId))}</code>` : ''}
      </p>

      <h2>Placeholders in your template (${placeholders.length})</h2>
      <p class="muted" style="font-size:0.85rem">
        Tokens like <code>{Foo}</code>, <code>{#Bar}…{/Bar}</code> we
        found inside the .docx file's XML.
      </p>
      <ul style="columns:3;font-family:monospace;font-size:0.85rem">
        ${placeholders.map(p => {
          const isMatched = matched.includes(p);
          return html`<li style="color:${isMatched ? '#1a7f37' : '#cf222e'}"
                          title="${isMatched ? 'matched by server' : 'no data — will render empty'}">
            ${escape(p)}${isMatched ? '' : ' ⚠'}
          </li>`;
        })}
      </ul>

      ${unmatched.length > 0 ? html`
        <h2 style="color:#cf222e">Unmatched placeholders (${unmatched.length})</h2>
        <p class="muted" style="font-size:0.85rem">
          These appear in your template but the server doesn't provide
          a key with this exact name. They'll render as empty strings.
          Either rename the placeholder in your template to match a
          provided key (see below), or open a request to add the alias
          on the server.
        </p>
        <ul style="font-family:monospace;font-size:0.85rem">
          ${unmatched.map(p => html`<li>${escape(p)}</li>`)}
        </ul>
      ` : html`<p style="color:#1a7f37"><strong>All placeholders matched.</strong> The data layer should fill every token.</p>`}

      <h2>Keys the server provides (${providedKeys.length})</h2>
      <p class="muted" style="font-size:0.85rem">
        Use any of these names inside <code>{}</code> in your template.
        Loops use <code>{#name}…{/name}</code> for arrays
        (lines, items, sections, options, Task, Cost).
      </p>
      <ul style="columns:3;font-family:monospace;font-size:0.85rem">
        ${providedKeys.map(k => html`<li>${escape(k)}</li>`)}
      </ul>

      <p style="margin-top:1.5rem">
        <a href="/templates/${escape(params.type)}/download" class="btn">Download current template</a>
      </p>
    </div>
  `;

  return htmlResponse(layout('Template diagnostic', body, { user }));
}
