// functions/documents/filenames/index.js
//
// GET /documents/filenames — Admin page for configurable download
// filenames. Lists every row in the filename_templates table and
// lets the user inline-edit the template string. Tokens are
// substituted at document-generation time by renderFilenameTemplate
// in functions/lib/filename-templates.js.
//
// The preview column shows what a filename would look like for a
// fake but plausible quote, updated live as the user types in the
// template field. Good for catching formatting mistakes before
// they land in a real download.

import { layout, htmlResponse, html, raw, escape } from '../../lib/layout.js';
import { readFlash } from '../../lib/http.js';
import { docsSubNav } from '../../lib/docs-subnav.js';
import {
  listFilenameTemplates,
  renderFilenameTemplate,
  FILENAME_TOKENS,
} from '../../lib/filename-templates.js';

/** Sample context used to render the live preview column. */
const PREVIEW_CONTEXT = {
  quoteNumber:       '25-00042',
  revision:          'v2',
  revisionSuffix:    '-v2',
  quoteTitle:        'Q2 Spares Refresh',
  accountName:       'Helix Robotics',
  accountAlias:      'Helix',
  opportunityNumber: 'OPP-25-0042',
  opportunityTitle:  'Helix robot spares',
  date:              new Date().toISOString().slice(0, 10),
};

export async function onRequestGet(context) {
  const { env, data, request } = context;
  const user = data?.user;
  const url = new URL(request.url);

  const rows = await listFilenameTemplates(env);
  const rowsWithPreview = rows.map((r) => ({
    ...r,
    preview: renderFilenameTemplate(r.template, PREVIEW_CONTEXT),
  }));

  const body = html`
    ${docsSubNav('filenames')}

    <section class="card">
      <div class="card-header">
        <h1 class="page-title">Download filenames</h1>
      </div>

      <p class="muted" style="padding:0 1rem">
        Customize the filenames used when generating quote PDFs and Word
        documents. Use <code>{token}</code> placeholders — click on one
        below to see what it means. Changes take effect immediately on
        the next generation.
      </p>

      <details class="token-cheat" style="margin:0.25rem 1rem 0.75rem;font-size:0.9em">
        <summary style="cursor:pointer;color:var(--muted)">Available tokens</summary>
        <ul style="margin:0.4rem 0 0 1.25rem;padding:0;line-height:1.55">
          ${FILENAME_TOKENS.map((t) => html`
            <li>
              <code>{${escape(t.token)}}</code>
              <span class="muted"> — ${escape(t.label)}</span>
            </li>
          `)}
        </ul>
      </details>

      <div style="padding:0 1rem 1rem">
        <table class="data" style="width:100%;table-layout:fixed">
          <colgroup>
            <col style="width:130px">
            <col style="width:auto">
            <col style="width:auto">
            <col style="width:140px">
          </colgroup>
          <thead>
            <tr>
              <th style="text-align:left">Kind</th>
              <th style="text-align:left">Template</th>
              <th style="text-align:left">Preview (sample data)</th>
              <th style="text-align:left">Updated</th>
            </tr>
          </thead>
          <tbody>
            ${rowsWithPreview.map((r) => html`
              <tr x-data="filenameRow('${escape(r.key)}', ${escape(JSON.stringify(r.template))}, ${escape(JSON.stringify(PREVIEW_CONTEXT))})">
                <td style="vertical-align:top">
                  <code>${escape(r.key)}</code>
                  ${r.description ? html`<br><small class="muted">${escape(r.description)}</small>` : ''}
                </td>
                <td style="vertical-align:top">
                  <input type="text" x-model="val"
                         @blur="save()"
                         @keydown.enter.prevent="save(); $event.target.blur()"
                         @keydown.escape="val = initial; $event.target.blur()"
                         style="width:100%;font:inherit;padding:0.35rem 0.5rem;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace">
                  <small class="muted" x-show="dirty" x-cloak>unsaved…</small>
                  <small class="pill pill-success" x-show="saved" x-cloak
                         x-transition.opacity.duration.600ms
                         style="margin-top:0.25rem;display:inline-block">saved</small>
                </td>
                <td style="vertical-align:top;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:0.88em"
                    x-text="preview()">
                  ${escape(r.preview)}
                </td>
                <td class="muted" style="vertical-align:top;font-size:0.85em;white-space:nowrap">
                  ${escape((r.updated_at || '').slice(0, 16).replace('T', ' '))}
                </td>
              </tr>
            `)}
          </tbody>
        </table>
      </div>

      <script>${raw(`
document.addEventListener('alpine:init', function() {
  Alpine.data('filenameRow', function(key, initial, previewCtx) {
    return {
      key: key,
      initial: initial,
      val: initial,
      saved: false,
      get dirty() { return this.val !== this.initial; },
      preview() {
        return renderFilenamePreview(this.val, previewCtx);
      },
      save: function() {
        if (this.val === this.initial) return;
        var self = this;
        var payload = this.val;
        fetch('/documents/filenames/' + encodeURIComponent(this.key) + '/patch', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ template: payload }),
        }).then(function(res) {
          if (!res.ok) {
            self.val = self.initial;
            return;
          }
          self.initial = payload;
          self.saved = true;
          setTimeout(function() { self.saved = false; }, 1200);
        }).catch(function() {
          self.val = self.initial;
        });
      },
    };
  });
});

// Mirror of renderFilenameTemplate in functions/lib/filename-templates.js
// so the live preview matches server-side rendering exactly.
function renderFilenamePreview(template, context) {
  if (!template) return '';
  var rendered = template.replace(/\\{(\\w+)\\}/g, function(_m, token) {
    var v = context && context[token];
    if (v == null) return '';
    return String(v);
  });
  return rendered
    .replace(/[\\\\/:*?"<>|]/g, '')
    .replace(/\\s+/g, ' ')
    .trim();
}
      `)}</script>
    </section>
  `;

  return htmlResponse(
    layout('Download filenames', body, {
      user,
      env: data?.env,
      activeNav: '/documents',
      flash: readFlash(url),
      breadcrumbs: [
        { label: 'Documents', href: '/documents/library' },
        { label: 'Filenames' },
      ],
    })
  );
}
