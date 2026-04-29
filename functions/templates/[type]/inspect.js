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

  // Discover loop arrays in the provided data so we can recognize when
  // a placeholder is "inside a loop" (and would resolve against the
  // array element, not the top-level object). E.g. {Amount} inside
  // {TableStart:Cost}…{TableEnd:Cost} maps to Cost[i].Amount, which
  // the top-level set wouldn't include.
  let arrayElementKeys = new Set();
  try {
    if (params.type.startsWith('quote-')) {
      // We already pulled `sample` for provided keys; reuse it.
      // But sample isn't accessible from this scope — re-derive.
    }
    // Inspect a sample of the provided data to find array values and
    // their first-element keys.
    const sample = params.type.startsWith('quote-')
      ? (sampleId ? await getQuoteDocData(env, sampleId) : null)
      : (sampleId ? await getOcDocData(env, sampleId) : null);
    if (sample) {
      for (const [k, v] of Object.entries(sample)) {
        if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'object') {
          for (const innerKey of Object.keys(v[0])) {
            if (!innerKey.startsWith('_')) arrayElementKeys.add(innerKey);
          }
        }
      }
    }
  } catch (_) { /* best-effort */ }

  // Resolve each placeholder name. We strip:
  //   - `{#name}` / `{/name}` / `{^name}` loop markers
  //   - `{TableStart:name}` / `{TableEnd:name}` table-loop markers
  // After stripping, we check both the top-level provided keys and
  // the array-element keys (so `{Amount}` inside a loop doesn't
  // mis-flag).
  function resolveBaseName(p) {
    let s = p.trim();
    if (/^TableStart:/i.test(s)) return s.replace(/^TableStart:/i, '');
    if (/^TableEnd:/i.test(s))   return s.replace(/^TableEnd:/i, '');
    return s.replace(/^[#\/^]/, '');
  }
  function isMatched(p) {
    const k = resolveBaseName(p);
    return providedSet.has(k) || arrayElementKeys.has(k);
  }
  const matched = placeholders.filter(isMatched);
  const unmatched = placeholders.filter(p => !isMatched(p));

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
