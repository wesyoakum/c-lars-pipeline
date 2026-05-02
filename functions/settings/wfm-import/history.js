// functions/settings/wfm-import/history.js
//
// GET /settings/wfm-import/history
//
// Lists past WFM import runs (newest first), each expandable to show:
//   - the human-readable summary line
//   - the full counts object
//   - the selection summary (which WFM records were submitted)
//   - the per-record errors / skip reasons
//   - the success links
//
// Persisted by /settings/wfm-import/commit on every invocation
// (wfm_import_runs table — see migrations/0070_wfm_import_runs.sql).
//
// Admin-only.

import { layout, htmlResponse, html, escape } from '../../lib/layout.js';
import { hasRole } from '../../lib/auth.js';
import { settingsSubNav } from '../../lib/settings-subnav.js';
import { all } from '../../lib/db.js';

const MAX_ROWS = 100;

function safeParse(s, fallback) {
  if (s == null || s === '') return fallback;
  try { return JSON.parse(s); }
  catch { return fallback; }
}

function fmtTs(s) {
  if (!s) return '';
  // Strip the ".sssZ" tail for compactness.
  return String(s).replace(/\.\d+Z$/, 'Z').replace('T', ' ');
}

export async function onRequestGet(context) {
  const { env, data } = context;
  const user = data?.user;
  if (!user) return new Response('Sign in required', { status: 401 });
  if (!hasRole(user, 'admin')) {
    return htmlResponse(layout('WFM import history',
      '<section class="card"><h1>WFM import history</h1><p>Admin only.</p></section>',
      { user }), { status: 403 });
  }

  const rows = await all(env.DB,
    `SELECT id, started_at, finished_at, triggered_by, ok, summary,
            counts_json, errors_json, links_json,
            selection_summary_json, selection_size
       FROM wfm_import_runs
       ORDER BY started_at DESC
       LIMIT ?`,
    [MAX_ROWS]);

  const body = html`
    ${settingsSubNav('wfm-import', true)}

    <section class="card" style="margin-top:1rem">
      <div class="card-header" style="display:flex;justify-content:space-between;align-items:center;gap:.5rem;flex-wrap:wrap">
        <h1 style="margin:0">WFM import history</h1>
        <a href="/settings/wfm-import" class="btn" style="font-size:.85rem">← Back to import</a>
      </div>
      <p class="muted" style="margin-top:0">
        One row per call to <code>/settings/wfm-import/commit</code>.
        Showing the ${rows.length === 1 ? 'most recent run' : 'last ' + rows.length + ' runs'}
        (newest first; cap ${MAX_ROWS}). Click a row to expand details.
      </p>

      ${rows.length === 0 ? html`
        <p class="muted" style="margin-top:1rem">
          No imports have been recorded yet. Runs are persisted starting at v0.494.
        </p>
      ` : html`
        <div style="margin-top:1rem;display:flex;flex-direction:column;gap:.5rem">
          ${rows.map((row) => {
            const counts        = safeParse(row.counts_json, {});
            const errors        = safeParse(row.errors_json, []);
            const links         = safeParse(row.links_json, []);
            const selection     = safeParse(row.selection_summary_json, []);
            const okBadge = row.ok
              ? html`<span style="color:#1a7f37;font-weight:600">✓ ok</span>`
              : html`<span style="color:#cf222e;font-weight:600">✗ failed</span>`;
            return html`
              <details class="card" style="margin:0;padding:.4rem .8rem">
                <summary style="cursor:pointer;display:flex;gap:.6rem;align-items:baseline;flex-wrap:wrap;list-style:revert">
                  <code style="font-size:.78rem;color:#666">${escape(fmtTs(row.started_at))}</code>
                  ${okBadge}
                  <span class="muted" style="font-size:.82rem">
                    by <strong>${escape(row.triggered_by || '?')}</strong>
                  </span>
                  <span class="muted" style="font-size:.82rem">
                    ${row.selection_size} record${row.selection_size === 1 ? '' : 's'} submitted
                  </span>
                  <span style="font-size:.85rem;flex:1;min-width:0">
                    ${escape(row.summary || '(no summary)')}
                  </span>
                </summary>

                <div style="margin-top:.6rem;display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:.7rem">
                  <!-- Counts -->
                  <div>
                    <strong style="font-size:.82rem">Counts</strong>
                    <table style="margin-top:.3rem;border-collapse:collapse;font-size:.8rem">
                      ${Object.entries(counts).map(([k, v]) => html`
                        <tr>
                          <td style="padding:.1rem .5rem .1rem 0;color:#666">${escape(k)}</td>
                          <td style="padding:.1rem 0;font-family:ui-monospace,monospace;text-align:right">${escape(v)}</td>
                        </tr>
                      `)}
                    </table>
                  </div>

                  <!-- Selection summary — what was submitted -->
                  <div>
                    <strong style="font-size:.82rem">Submitted</strong>
                    ${selection.length === 0
                      ? html`<p class="muted" style="font-size:.78rem;margin:.3rem 0 0 0">(empty selection)</p>`
                      : html`
                        <ul style="margin:.3rem 0 0 0;padding-left:1.1rem;font-size:.78rem;line-height:1.5">
                          ${selection.map((s) => html`
                            <li>
                              <span style="color:#666;font-variant:small-caps">${escape(s.kind || '?')}</span>
                              ${' '}<strong>${escape(s.name || s.id || s.uuid || '?')}</strong>
                              ${s.uuid ? html` <code style="font-size:.7rem;color:#999">${escape(String(s.uuid).slice(0, 8))}…</code>` : ''}
                            </li>
                          `)}
                        </ul>
                      `}
                  </div>

                  <!-- Result links -->
                  ${links.length > 0 ? html`
                    <div>
                      <strong style="font-size:.82rem">Imported records</strong>
                      <ul style="margin:.3rem 0 0 0;padding-left:1.1rem;font-size:.78rem;line-height:1.5">
                        ${links.map((l) => html`
                          <li><a href="${escape(l.url)}" target="_blank">${escape(l.label)}</a></li>
                        `)}
                      </ul>
                    </div>
                  ` : ''}
                </div>

                <!-- Errors / skip reasons -->
                ${errors.length > 0 ? html`
                  <div style="margin-top:.6rem;padding:.4rem .6rem;background:#fff8c5;border:1px solid #d4a72c;border-radius:4px">
                    <strong style="font-size:.82rem">Errors / skip reasons</strong>
                    <ul style="margin:.3rem 0 0 0;padding-left:1.1rem;font-size:.78rem;line-height:1.5;font-family:ui-monospace,monospace">
                      ${errors.map((e) => html`<li>${escape(e)}</li>`)}
                    </ul>
                  </div>
                ` : ''}
              </details>
            `;
          })}
        </div>
      `}
    </section>
  `;

  return htmlResponse(layout('WFM import history', body, {
    user, activeNav: '/settings',
    breadcrumbs: [
      { label: 'Settings', href: '/settings' },
      { label: 'WFM import', href: '/settings/wfm-import' },
      { label: 'History' },
    ],
  }));
}
