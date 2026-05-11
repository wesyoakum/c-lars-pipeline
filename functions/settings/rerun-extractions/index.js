// functions/settings/rerun-extractions/index.js
//
// GET /settings/rerun-extractions — admin tool that lists items whose
// extraction failed (status='error') in either the AI Inbox pipeline
// or the WFM Import pipeline, with per-row "Retry" buttons.
//
// Before this page existed, retrying a failed AI Inbox item meant
// finding the id and POSTing to /ai-inbox/:id/process, and retrying a
// failed WFM plan required hand-editing the DB. This consolidates both
// behind one auth-gated UI.

import { all } from '../../lib/db.js';
import { layout, htmlResponse, html, escape } from '../../lib/layout.js';
import { readFlash } from '../../lib/http.js';
import { hasRole } from '../../lib/auth.js';
import { settingsSubNav } from '../../lib/settings-subnav.js';

function shortTs(s) {
  if (!s) return '—';
  return String(s).slice(0, 16).replace('T', ' ');
}

function truncate(s, n = 200) {
  const v = String(s ?? '');
  if (v.length <= n) return v;
  return v.slice(0, n - 1) + '…';
}

export async function onRequestGet(context) {
  const { env, data, request } = context;
  const user = data?.user;
  if (!user) return new Response('Sign in required', { status: 401 });
  if (!hasRole(user, 'admin')) {
    return htmlResponse(layout('Rerun extractions',
      '<section class="card"><h1>Rerun extractions</h1><p>Admin only.</p></section>',
      { user }), { status: 403 });
  }

  const url = new URL(request.url);

  const aiRows = await all(env.DB,
    `SELECT i.id, i.created_at, i.updated_at, i.source, i.error_message,
            i.audio_filename, i.context_type,
            u.display_name AS user_name, u.email AS user_email
       FROM ai_inbox_items i
       LEFT JOIN users u ON u.id = i.user_id
      WHERE i.status = 'error'
      ORDER BY i.updated_at DESC
      LIMIT 100`);

  const wfmRows = await all(env.DB,
    `SELECT p.id, p.run_id, p.kind, p.external_uuid, p.sequence,
            p.error_message, p.updated_at,
            r.mode AS run_mode, r.status AS run_status, r.started_at AS run_started_at
       FROM wfm_import_plans p
       LEFT JOIN wfm_import_runs r ON r.id = p.run_id
      WHERE p.status = 'error'
      ORDER BY p.updated_at DESC
      LIMIT 100`);

  const body = html`
    ${settingsSubNav('rerun-extractions', true, user?.email === 'wes.yoakum@c-lars.com')}

    <section class="card" style="margin-top:1rem">
      <div class="card-header">
        <h1>Rerun extractions</h1>
      </div>
      <p class="muted" style="margin-top:0">
        Failed AI Inbox items and WFM Import plans surface here so you can
        retry them without touching the DB. Retrying re-runs the
        extraction; rows that succeed leave the list on the next reload.
      </p>

      <h2 style="margin-top:1.25rem">AI Inbox failures
        <span class="muted" style="font-weight:400">(${aiRows.length})</span>
      </h2>
      ${aiRows.length === 0
        ? html`<p class="muted" style="margin:0">No failures.</p>`
        : html`
          <table class="data-table" style="width:100%;border-collapse:collapse;margin-top:0.5rem">
            <thead>
              <tr>
                <th style="text-align:left;padding:0.35rem 0.5rem;border-bottom:1px solid var(--border)">Item</th>
                <th style="text-align:left;padding:0.35rem 0.5rem;border-bottom:1px solid var(--border)">User</th>
                <th style="text-align:left;padding:0.35rem 0.5rem;border-bottom:1px solid var(--border)">Updated</th>
                <th style="text-align:left;padding:0.35rem 0.5rem;border-bottom:1px solid var(--border)">Error</th>
                <th style="padding:0.35rem 0.5rem;border-bottom:1px solid var(--border)"></th>
              </tr>
            </thead>
            <tbody>
              ${aiRows.map(r => html`
                <tr>
                  <td style="padding:0.35rem 0.5rem;border-bottom:1px solid var(--border-subtle);vertical-align:top">
                    <a href="/ai-inbox/${escape(r.id)}" style="font-family:monospace;font-size:0.85rem">${escape(r.id.slice(0, 8))}</a>
                    ${r.audio_filename ? html`<div class="muted" style="font-size:0.8rem">${escape(r.audio_filename)}</div>` : ''}
                    ${r.context_type ? html`<div class="muted" style="font-size:0.8rem">${escape(r.context_type)}</div>` : ''}
                  </td>
                  <td style="padding:0.35rem 0.5rem;border-bottom:1px solid var(--border-subtle);vertical-align:top">
                    ${escape(r.user_name || r.user_email || '—')}
                  </td>
                  <td style="padding:0.35rem 0.5rem;border-bottom:1px solid var(--border-subtle);vertical-align:top;font-size:0.85rem">
                    ${escape(shortTs(r.updated_at))}
                  </td>
                  <td style="padding:0.35rem 0.5rem;border-bottom:1px solid var(--border-subtle);vertical-align:top;font-size:0.85rem">
                    ${escape(truncate(r.error_message))}
                  </td>
                  <td style="padding:0.35rem 0.5rem;border-bottom:1px solid var(--border-subtle);vertical-align:top;text-align:right">
                    <form method="post" action="/settings/rerun-extractions/retry-ai-inbox"
                          style="display:inline"
                          onsubmit="return confirm('Re-run extraction for item ${escape(r.id.slice(0,8))}? This re-processes attachments and may overwrite extracted_json.');">
                      <input type="hidden" name="id" value="${escape(r.id)}">
                      <button type="submit" class="btn btn-sm">Retry</button>
                    </form>
                  </td>
                </tr>
              `)}
            </tbody>
          </table>
        `}

      <h2 style="margin-top:1.5rem">WFM Import failures
        <span class="muted" style="font-weight:400">(${wfmRows.length})</span>
      </h2>
      ${wfmRows.length === 0
        ? html`<p class="muted" style="margin:0">No failures.</p>`
        : html`
          <table class="data-table" style="width:100%;border-collapse:collapse;margin-top:0.5rem">
            <thead>
              <tr>
                <th style="text-align:left;padding:0.35rem 0.5rem;border-bottom:1px solid var(--border)">Plan</th>
                <th style="text-align:left;padding:0.35rem 0.5rem;border-bottom:1px solid var(--border)">Kind</th>
                <th style="text-align:left;padding:0.35rem 0.5rem;border-bottom:1px solid var(--border)">Run</th>
                <th style="text-align:left;padding:0.35rem 0.5rem;border-bottom:1px solid var(--border)">Updated</th>
                <th style="text-align:left;padding:0.35rem 0.5rem;border-bottom:1px solid var(--border)">Error</th>
                <th style="padding:0.35rem 0.5rem;border-bottom:1px solid var(--border)"></th>
              </tr>
            </thead>
            <tbody>
              ${wfmRows.map(r => html`
                <tr>
                  <td style="padding:0.35rem 0.5rem;border-bottom:1px solid var(--border-subtle);vertical-align:top;font-family:monospace;font-size:0.85rem">
                    ${escape(r.id.slice(0, 8))}
                    <div class="muted" style="font-size:0.75rem">${escape((r.external_uuid || '').slice(0, 8))}</div>
                  </td>
                  <td style="padding:0.35rem 0.5rem;border-bottom:1px solid var(--border-subtle);vertical-align:top">
                    ${escape(r.kind)}
                  </td>
                  <td style="padding:0.35rem 0.5rem;border-bottom:1px solid var(--border-subtle);vertical-align:top;font-size:0.85rem">
                    ${escape(r.run_mode || '?')} <span class="muted">/ ${escape(r.run_status || '?')}</span>
                    <div class="muted" style="font-size:0.75rem">${escape(shortTs(r.run_started_at))}</div>
                  </td>
                  <td style="padding:0.35rem 0.5rem;border-bottom:1px solid var(--border-subtle);vertical-align:top;font-size:0.85rem">
                    ${escape(shortTs(r.updated_at))}
                  </td>
                  <td style="padding:0.35rem 0.5rem;border-bottom:1px solid var(--border-subtle);vertical-align:top;font-size:0.85rem">
                    ${escape(truncate(r.error_message))}
                  </td>
                  <td style="padding:0.35rem 0.5rem;border-bottom:1px solid var(--border-subtle);vertical-align:top;text-align:right">
                    <form method="post" action="/settings/rerun-extractions/retry-wfm"
                          style="display:inline"
                          onsubmit="return confirm('Re-queue WFM plan ${escape(r.id.slice(0,8))} (${escape(r.kind)})? It will be re-imported on the next cron tick — this writes to D1/R2 and may produce side effects.');">
                      <input type="hidden" name="id" value="${escape(r.id)}">
                      <button type="submit" class="btn btn-sm">Retry</button>
                    </form>
                  </td>
                </tr>
              `)}
            </tbody>
          </table>
        `}
    </section>
  `;

  return htmlResponse(layout('Rerun extractions', body, {
    user,
    activeNav: '/settings',
    flash: readFlash(url),
    breadcrumbs: [
      { label: 'Settings', href: '/settings' },
      { label: 'Rerun extractions' },
    ],
  }));
}
