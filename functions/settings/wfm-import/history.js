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
    `SELECT id, mode, started_at, finished_at, triggered_by, ok, summary,
            counts_json, errors_json, links_json,
            selection_summary_json, selection_size, total_planned
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
        One row per import run — sample/commit selections, full imports,
        and delta refreshes all land here.
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

            // Build the plain-text dump that the Copy buttons paste.
            // Two flavors: full entry, or errors-only.
            const fullDump = [
              'WFM Import Run — ' + fmtTs(row.started_at),
              'Status: ' + (row.ok ? 'ok' : 'failed'),
              'By: ' + (row.triggered_by || '?'),
              'Run ID: ' + row.id,
              'Selection size: ' + row.selection_size,
              '',
              'Summary:',
              '  ' + (row.summary || '(none)'),
              '',
              'Counts:',
              ...Object.entries(counts).map(([k, v]) => '  ' + k + ': ' + v),
              '',
              'Submitted records:',
              ...(selection.length === 0
                ? ['  (empty selection)']
                : selection.map((s) =>
                    '  - ' + (s.kind || '?') + ': ' +
                    (s.name || s.id || s.uuid || '?') +
                    (s.uuid ? ' (' + s.uuid + ')' : ''))),
              '',
              'Imported records:',
              ...(links.length === 0
                ? ['  (none)']
                : links.map((l) => '  - ' + l.label + ' → ' + l.url)),
              '',
              'Errors / skip reasons:',
              ...(errors.length === 0
                ? ['  (none)']
                : errors.map((e) => '  - ' + e)),
            ].join('\n');

            const errorsDump = errors.length === 0
              ? '(no errors recorded)'
              : ['Errors / skip reasons — ' + fmtTs(row.started_at) + ':',
                 ...errors.map((e) => '  - ' + e)].join('\n');

            // Selection-summary entries come in three shapes depending
            // on which path produced the run:
            //   - sample/commit  → per-record entries with name/id/uuid
            //   - full import    → per-kind entries { kind, count }
            //   - delta refresh  → per-kind entries { kind, fetched, queued }
            // Detect by looking at the first entry's shape so the
            // Submitted panel below can render each correctly.
            const isPerRecord = selection.length > 0 &&
              selection[0] && (selection[0].name || selection[0].id || selection[0].uuid);
            const isDeltaSummary = selection.length > 0 &&
              selection[0] && Object.prototype.hasOwnProperty.call(selection[0], 'fetched');
            const isFullSummary = selection.length > 0 && !isPerRecord && !isDeltaSummary;

            // Delta runs: compute totals fetched vs queued so the header
            // can carry the savings line ("queued 23 of 5847 fetched").
            let deltaTotals = null;
            if (isDeltaSummary) {
              const fetched = selection.reduce((s, e) => s + (Number(e.fetched) || 0), 0);
              const queued  = selection.reduce((s, e) => s + (Number(e.queued)  || 0), 0);
              deltaTotals = { fetched, queued, skipped: Math.max(fetched - queued, 0) };
            }

            const modeLabel = row.mode || 'selective';
            const modeBadgeStyle = modeLabel === 'delta'
              ? 'background:#dbeafe;color:#1e40af;border:1px solid #93c5fd;'
              : modeLabel === 'full'
                ? 'background:#fef3c7;color:#854d0e;border:1px solid #fcd34d;'
                : 'background:#f3f4f6;color:#444;border:1px solid #d1d5db;';

            return html`
              <details class="card" style="margin:0;padding:.4rem .8rem">
                <summary style="cursor:pointer;display:flex;gap:.6rem;align-items:baseline;flex-wrap:wrap;list-style:revert">
                  <code style="font-size:.78rem;color:#666">${escape(fmtTs(row.started_at))}</code>
                  <span style="font-size:.7rem;padding:.05rem .35rem;border-radius:3px;font-variant:small-caps;letter-spacing:.02em;${modeBadgeStyle}">${escape(modeLabel)}</span>
                  ${okBadge}
                  <span class="muted" style="font-size:.82rem">
                    by <strong>${escape(row.triggered_by || '?')}</strong>
                  </span>
                  <span class="muted" style="font-size:.82rem">
                    ${deltaTotals
                      ? html`${deltaTotals.queued} queued / ${deltaTotals.fetched} fetched${deltaTotals.skipped > 0 ? html` <span style="color:#1a7f37">(skipped ${deltaTotals.skipped} unchanged)</span>` : ''}`
                      : html`${row.selection_size} record${row.selection_size === 1 ? '' : 's'} submitted`}
                  </span>
                  <span style="font-size:.85rem;flex:1;min-width:0">
                    ${escape(row.summary || '(no summary)')}
                  </span>
                </summary>

                <!-- Copy bar -->
                <div style="margin-top:.5rem;display:flex;gap:.4rem;flex-wrap:wrap;align-items:center">
                  <button type="button" class="btn js-copy-run"
                          data-run-id="${escape(row.id)}"
                          data-copy-payload="${escape(fullDump)}"
                          style="font-size:.78rem">Copy entry</button>
                  ${errors.length > 0 ? html`
                    <button type="button" class="btn js-copy-run"
                            data-run-id="${escape(row.id)}"
                            data-copy-payload="${escape(errorsDump)}"
                            style="font-size:.78rem">Copy errors only (${errors.length})</button>
                  ` : ''}
                  <span class="js-copy-status" data-run-id="${escape(row.id)}"
                        style="font-size:.78rem;color:#1a7f37"></span>
                </div>

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

                  <!-- Selection summary — what was submitted (or, for
                       full / delta runs, per-kind aggregate counts). -->
                  <div>
                    <strong style="font-size:.82rem">${isDeltaSummary ? 'Per-kind delta breakdown' : (isFullSummary ? 'Per-kind import breakdown' : 'Submitted')}</strong>
                    ${selection.length === 0
                      ? html`<p class="muted" style="font-size:.78rem;margin:.3rem 0 0 0">(empty selection)</p>`
                      : isDeltaSummary
                        ? html`
                          <table style="margin-top:.3rem;border-collapse:collapse;font-size:.78rem;width:100%">
                            <thead>
                              <tr style="color:#666;font-weight:normal;border-bottom:1px solid #e5e7eb">
                                <td style="padding:.15rem .35rem .15rem 0">kind</td>
                                <td style="padding:.15rem .35rem;text-align:right">fetched</td>
                                <td style="padding:.15rem .35rem;text-align:right">queued</td>
                                <td style="padding:.15rem 0;text-align:right">skipped</td>
                              </tr>
                            </thead>
                            <tbody>
                              ${selection.map((s) => {
                                const fetched = Number(s.fetched) || 0;
                                const queued  = Number(s.queued)  || 0;
                                const skipped = Math.max(fetched - queued, 0);
                                return html`
                                  <tr>
                                    <td style="padding:.1rem .35rem .1rem 0;font-variant:small-caps;color:#444">${escape(s.kind || '?')}</td>
                                    <td style="padding:.1rem .35rem;font-family:ui-monospace,monospace;text-align:right">${escape(fetched)}</td>
                                    <td style="padding:.1rem .35rem;font-family:ui-monospace,monospace;text-align:right;color:${queued > 0 ? '#1a7f37' : '#999'}">${escape(queued)}</td>
                                    <td style="padding:.1rem 0;font-family:ui-monospace,monospace;text-align:right;color:#666">${escape(skipped)}</td>
                                  </tr>
                                `;
                              })}
                            </tbody>
                          </table>
                          <p class="muted" style="font-size:.72rem;margin:.4rem 0 0 0;line-height:1.4">
                            <em>queued</em> rows had a changed JSON payload; <em>skipped</em> rows had byte-identical payloads and were left untouched (no <code>updated_at</code> bump).
                          </p>
                        `
                        : isFullSummary
                          ? html`
                            <table style="margin-top:.3rem;border-collapse:collapse;font-size:.78rem">
                              ${selection.map((s) => html`
                                <tr>
                                  <td style="padding:.1rem .5rem .1rem 0;font-variant:small-caps;color:#666">${escape(s.kind || '?')}</td>
                                  <td style="padding:.1rem 0;font-family:ui-monospace,monospace;text-align:right">${escape(Number(s.count) || 0)}</td>
                                </tr>
                              `)}
                            </table>
                          `
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

      <script>
        // Copy-to-clipboard for any history row's payload. Uses the
        // modern Clipboard API; falls back to a hidden textarea +
        // execCommand if the page is served over an insecure context
        // (rare here, but cheap insurance).
        document.addEventListener('click', async function (e) {
          const btn = e.target.closest('.js-copy-run');
          if (!btn) return;
          const payload = btn.getAttribute('data-copy-payload') || '';
          const runId   = btn.getAttribute('data-run-id') || '';
          const status  = document.querySelector('.js-copy-status[data-run-id="' + runId + '"]');
          let ok = false;
          try {
            await navigator.clipboard.writeText(payload);
            ok = true;
          } catch (_) {
            try {
              const ta = document.createElement('textarea');
              ta.value = payload;
              ta.style.position = 'fixed';
              ta.style.opacity = '0';
              document.body.appendChild(ta);
              ta.focus(); ta.select();
              ok = document.execCommand('copy');
              document.body.removeChild(ta);
            } catch (_) { ok = false; }
          }
          if (status) {
            status.textContent = ok ? '✓ Copied' : '✗ Copy failed';
            status.style.color = ok ? '#1a7f37' : '#cf222e';
            setTimeout(function () { status.textContent = ''; }, 2000);
          }
        });
      </script>
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
