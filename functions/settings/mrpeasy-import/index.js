// functions/settings/mrpeasy-import/index.js
//
// GET /settings/mrpeasy-import — admin-only MRPeasy raw-export
// workbench (Phase 1). MRPeasy is the frozen pre-WFM ERP; this page
// connects, discovers the API surface, and dumps everything to R2.
// Pipeline mapping is Phase 2 (see docs/mrpeasy-mapping.md).
//
// Server endpoints used by this page:
//   POST /settings/mrpeasy-import/set-credentials
//   GET  /settings/mrpeasy-import/probe
//   POST /settings/mrpeasy-import/export

import { layout, htmlResponse, html, escape } from '../../lib/layout.js';
import { readFlash } from '../../lib/http.js';
import { hasRole } from '../../lib/auth.js';
import { settingsSubNav } from '../../lib/settings-subnav.js';
import { one, all } from '../../lib/db.js';

export async function onRequestGet(context) {
  const { env, data, request } = context;
  const user = data?.user;
  if (!user) return new Response('Sign in required', { status: 401 });
  if (!hasRole(user, 'admin')) {
    return htmlResponse(layout('MRPeasy export',
      '<section class="card"><h1>MRPeasy export</h1><p>Admin only.</p></section>',
      { user }), { status: 403 });
  }

  const url = new URL(request.url);

  const creds = await one(env.DB,
    `SELECT api_key IS NOT NULL AND api_secret IS NOT NULL AS has_creds,
            api_base, last_verified_at, last_export_at, updated_at
       FROM mrpeasy_credentials WHERE id = 1`);
  const connected = !!(creds && creds.has_creds && creds.last_verified_at);
  const hasCreds  = !!(creds && creds.has_creds);

  const runs = await all(env.DB,
    `SELECT id, started_at, finished_at, triggered_by, ok, r2_prefix, summary
       FROM mrpeasy_export_runs
       ORDER BY started_at DESC LIMIT 25`);

  const body = html`
    ${settingsSubNav('mrpeasy-import', true)}

    <section class="card" style="margin-top:1rem">
      <div class="card-header">
        <h1 style="margin:0">MRPeasy export</h1>
      </div>
      <p class="muted" style="margin-top:0">
        MRPeasy is the ERP C-LARS used before WorkflowMax — frozen, no
        new data. <strong>Phase 1:</strong> connect, discover the API
        surface, and dump every entity verbatim to R2 as the defensive
        archive. Pipeline mapping comes later. See
        <code>docs/mrpeasy-mapping.md</code>.
      </p>

      <!-- Connection status -->
      <div style="margin-top:1rem;padding:.75rem 1rem;border-radius:4px;background:${connected ? '#e6f4ea' : '#fff8e1'};border:1px solid ${connected ? '#9bcfa6' : '#e0c97a'}">
        <div style="display:flex;align-items:center;gap:.5rem;flex-wrap:wrap">
          <strong>Status:</strong>
          ${connected
            ? html`<span style="color:#1a7f37">✓ Connected</span>`
            : html`<span style="color:#9a6700">⚠ ${hasCreds ? 'Credentials saved, not verified' : 'Not connected'}</span>`}
          ${creds?.last_verified_at
            ? html`<span class="muted" style="font-size:.85em">verified: ${escape(creds.last_verified_at)}</span>` : ''}
          ${creds?.last_export_at
            ? html`<span class="muted" style="font-size:.85em">last export: ${escape(creds.last_export_at)}</span>` : ''}
        </div>
        <p class="muted" style="margin:.5rem 0 0 0;font-size:.85em">
          Requires the MRPeasy <strong>Unlimited</strong> plan. Get the
          api-key + api-secret from MRPeasy →
          <em>Settings → Integration → API access</em>.
        </p>
      </div>

      <section class="card" style="margin-top:1rem" x-data="mrpeasyInit(${connected ? 'true' : 'false'})">

        <!-- Credentials form -->
        <h2 style="margin-top:0">Connect</h2>
        <form @submit.prevent="saveCreds()" style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:flex-start">
          <input type="text" x-model="apiKey" placeholder="api-key" :disabled="busy" autocomplete="off"
                 style="flex:1;min-width:14rem;padding:.4rem .6rem;border:1px solid var(--border);border-radius:4px;font-family:ui-monospace,monospace;font-size:.85rem">
          <input type="password" x-model="apiSecret" placeholder="api-secret" :disabled="busy" autocomplete="off"
                 style="flex:1;min-width:14rem;padding:.4rem .6rem;border:1px solid var(--border);border-radius:4px;font-family:ui-monospace,monospace;font-size:.85rem">
          <button type="submit" class="btn primary" :disabled="busy || !apiKey.trim() || !apiSecret.trim()">
            <span x-show="!busy || phase !== 'saving'">Save & test</span>
            <span x-show="busy && phase === 'saving'">Testing…</span>
          </button>
        </form>
        <p class="muted" style="margin:.4rem 0 0 0;font-size:.78rem">
          Optional API base override (leave blank for default
          <code>app.mrpeasy.com/rest/v1</code>):
          <input type="text" x-model="apiBase" placeholder="https://app.mrpeasy.com/rest/v1" :disabled="busy"
                 style="margin-left:.3rem;min-width:18rem;padding:.2rem .4rem;border:1px solid var(--border);border-radius:4px;font-size:.78rem">
        </p>
        <p x-show="credMsg" x-text="credMsg" :style="credOk ? 'color:#1a7f37' : 'color:#cf222e'" style="margin-top:.5rem;font-size:.85rem"></p>

        <!-- Discover + export (only meaningful once connected) -->
        <div style="margin-top:1.2rem;border-top:1px solid var(--border);padding-top:1rem">
          <h2 style="margin-top:0">Discover &amp; export</h2>
          <div style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:center">
            <button type="button" class="btn" @click="discover()" :disabled="busy">
              <span x-show="!busy || phase !== 'probing'">1. Discover entities</span>
              <span x-show="busy && phase === 'probing'">Probing…</span>
            </button>
            <button type="button" class="btn danger" @click="exportSelected()"
                    :disabled="busy || selectedPaths().length === 0">
              <span x-show="!busy || phase !== 'exporting'">
                2. Export selected (<span x-text="selectedPaths().length"></span>) → R2
              </span>
              <span x-show="busy && phase === 'exporting'">Exporting… (serial, can be slow)</span>
            </button>
          </div>
          <p x-show="probeMsg" x-text="probeMsg" style="margin-top:.5rem;font-size:.85rem;color:#cf222e"></p>

          <!-- Discovered entities -->
          <template x-if="entities.length > 0">
            <div style="margin-top:.8rem">
              <div style="display:flex;gap:.5rem;align-items:baseline;flex-wrap:wrap;margin-bottom:.4rem">
                <strong style="font-size:.85rem" x-text="accessibleCount() + ' / ' + entities.length + ' accessible'"></strong>
                <button type="button" @click="selectAll(true)"  style="background:none;border:none;color:#1f6feb;cursor:pointer;font-size:.8rem;text-decoration:underline">all</button>
                <button type="button" @click="selectAll(false)" style="background:none;border:none;color:#1f6feb;cursor:pointer;font-size:.8rem;text-decoration:underline">none</button>
              </div>
              <ul style="list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:.3rem">
                <template x-for="e in entities" :key="e.path">
                  <li style="display:flex;gap:.5rem;align-items:center;padding:.3rem .5rem;border:1px solid var(--border);border-radius:4px;font-size:.82rem"
                      :style="!e.ok ? 'opacity:.45' : ''">
                    <input type="checkbox" :disabled="!e.ok || busy"
                           :checked="sel[e.path]" @change="sel[e.path] = !sel[e.path]">
                    <span style="flex:1;font-family:ui-monospace,monospace" x-text="e.path"></span>
                    <span class="muted" x-show="e.ok" x-text="(e.total ?? '?') + ' rows'"></span>
                    <span class="muted" x-show="!e.ok" x-text="'HTTP ' + e.status"></span>
                  </li>
                </template>
              </ul>
            </div>
          </template>

          <!-- Export result -->
          <template x-if="exportResult">
            <div style="margin-top:1rem;padding:.6rem .8rem;border-radius:4px"
                 :style="exportResult.ok ? 'background:#e6f4ea;border:1px solid #9bcfa6' : 'background:#fff8c5;border:1px solid #d4a72c'">
              <strong x-text="exportResult.ok ? '✓ Export complete' : '⚠ Export finished with errors'"></strong>
              <p style="margin:.3rem 0;font-size:.85rem" x-text="exportResult.summary"></p>
              <p class="muted" style="font-size:.78rem">R2 prefix: <code x-text="exportResult.r2_prefix"></code></p>
              <template x-if="exportResult.errors && exportResult.errors.length">
                <ul style="margin:.3rem 0 0 0;padding-left:1.1rem;font-size:.78rem;font-family:ui-monospace,monospace">
                  <template x-for="er in exportResult.errors" :key="er"><li x-text="er"></li></template>
                </ul>
              </template>
            </div>
          </template>
        </div>
      </section>

      <!-- Past export runs -->
      <section class="card" style="margin-top:1rem">
        <h2 style="margin-top:0">Export history</h2>
        ${runs.length === 0 ? html`
          <p class="muted">No exports yet.</p>
        ` : html`
          <table style="width:100%;border-collapse:collapse;font-size:.82rem">
            <thead>
              <tr style="text-align:left;border-bottom:1px solid var(--border)">
                <th style="padding:.3rem .5rem">When</th>
                <th style="padding:.3rem .5rem">By</th>
                <th style="padding:.3rem .5rem">OK</th>
                <th style="padding:.3rem .5rem">Summary</th>
                <th style="padding:.3rem .5rem">R2 prefix</th>
              </tr>
            </thead>
            <tbody>
              ${runs.map((r) => html`
                <tr style="border-bottom:1px solid #eee">
                  <td style="padding:.3rem .5rem;white-space:nowrap"><code style="font-size:.75rem">${escape(String(r.started_at).replace('T', ' ').replace(/\.\d+Z$/, 'Z'))}</code></td>
                  <td style="padding:.3rem .5rem">${escape(r.triggered_by || '?')}</td>
                  <td style="padding:.3rem .5rem">${r.ok ? html`<span style="color:#1a7f37">✓</span>` : html`<span style="color:#cf222e">✗</span>`}</td>
                  <td style="padding:.3rem .5rem">${escape(r.summary || '')}</td>
                  <td style="padding:.3rem .5rem"><code style="font-size:.72rem">${escape(r.r2_prefix || '')}</code></td>
                </tr>
              `)}
            </tbody>
          </table>
        `}
      </section>
    </section>

    <script>
      window.mrpeasyInit = function (connected) {
        return {
          busy: false, phase: '',
          apiKey: '', apiSecret: '', apiBase: '',
          credMsg: '', credOk: false,
          probeMsg: '',
          entities: [], sel: {},
          exportResult: null,

          async saveCreds() {
            this.busy = true; this.phase = 'saving'; this.credMsg = '';
            try {
              const res = await fetch('/settings/mrpeasy-import/set-credentials', {
                method: 'POST', credentials: 'same-origin',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  api_key: this.apiKey.trim(),
                  api_secret: this.apiSecret.trim(),
                  api_base: this.apiBase.trim(),
                }),
              });
              const j = await res.json();
              this.credOk = !!j.ok;
              if (j.ok) {
                this.credMsg = '✓ Connected. ' + (j.customer_count != null ? j.customer_count + ' customers visible.' : '') + ' Reloading…';
                setTimeout(() => window.location.reload(), 900);
              } else {
                this.credMsg = (j.error || 'failed') + (j.detail ? ' — ' + (typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail)) : '');
              }
            } catch (e) {
              this.credOk = false; this.credMsg = String(e.message || e);
            } finally {
              this.busy = false; this.phase = '';
            }
          },

          async discover() {
            this.busy = true; this.phase = 'probing'; this.probeMsg = ''; this.exportResult = null;
            try {
              const res = await fetch('/settings/mrpeasy-import/probe', { credentials: 'same-origin' });
              const j = await res.json();
              if (!j.ok) throw new Error(j.error || 'probe failed');
              this.entities = j.results || [];
              const s = {};
              for (const e of this.entities) if (e.ok) s[e.path] = true;
              this.sel = s;
              if (this.accessibleCount() === 0) this.probeMsg = 'No endpoints resolved — check plan tier / api_base.';
            } catch (e) {
              this.probeMsg = String(e.message || e);
            } finally {
              this.busy = false; this.phase = '';
            }
          },

          accessibleCount() { return this.entities.filter((e) => e.ok).length; },
          selectedPaths() { return Object.keys(this.sel).filter((p) => this.sel[p]); },
          selectAll(v) {
            const s = {};
            for (const e of this.entities) if (e.ok) s[e.path] = v;
            this.sel = s;
          },

          async exportSelected() {
            const paths = this.selectedPaths();
            if (paths.length === 0) return;
            if (!confirm('Export ' + paths.length + ' entit' + (paths.length === 1 ? 'y' : 'ies') + ' to R2? Runs strictly serially — large accounts can take a while.')) return;
            this.busy = true; this.phase = 'exporting'; this.exportResult = null;
            try {
              const res = await fetch('/settings/mrpeasy-import/export', {
                method: 'POST', credentials: 'same-origin',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ paths }),
              });
              const j = await res.json();
              this.exportResult = j;
              if (!j.ok && j.error) this.probeMsg = j.error;
            } catch (e) {
              this.probeMsg = String(e.message || e);
            } finally {
              this.busy = false; this.phase = '';
            }
          },
        };
      };
    </script>
  `;

  return htmlResponse(layout('MRPeasy export', body, {
    user, activeNav: '/settings',
    flash: readFlash(url),
    breadcrumbs: [{ label: 'Settings', href: '/settings' }, { label: 'MRPeasy export' }],
  }));
}
