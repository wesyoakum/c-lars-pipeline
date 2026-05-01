// functions/settings/wfm-import/index.js
//
// GET /settings/wfm-import — admin-only WFM → Pipeline import workbench.
//
// Layout:
//   1. Credentials section — shows whether the OAuth setup is complete.
//      First-time users land here, fill in the refresh token (one-time),
//      and the page flips to the import controls.
//   2. Import section — "Get 5 random samples" button. Pressed, it
//      fetches a random sample of clients/leads/quotes/jobs/staff,
//      renders cards. Each card shows the WFM source on top and the
//      proposed Pipeline row(s) below. An "Import these" button
//      commits the batch.
//
// Logic lives client-side via Alpine.js. Server endpoints:
//   POST /settings/wfm-import/sample          — fetch random samples
//   POST /settings/wfm-import/commit          — apply the import
//   POST /settings/wfm-import/set-credentials — seed/update refresh token

import { layout, htmlResponse, html, escape } from '../../lib/layout.js';
import { readFlash } from '../../lib/http.js';
import { hasRole } from '../../lib/auth.js';
import { settingsSubNav } from '../../lib/settings-subnav.js';
import { one } from '../../lib/db.js';

export async function onRequestGet(context) {
  const { env, data, request } = context;
  const user = data?.user;
  if (!user) return new Response('Sign in required', { status: 401 });
  if (!hasRole(user, 'admin')) {
    return htmlResponse(layout('WFM import',
      '<section class="card"><h1>WFM import</h1><p>Admin only.</p></section>',
      { user }), { status: 403 });
  }

  const url = new URL(request.url);

  // Credential status — single-row config table.
  const creds = await one(env.DB,
    `SELECT refresh_token IS NOT NULL AS has_refresh,
            org_id,
            access_expires_at,
            updated_at
       FROM wfm_credentials WHERE id = 1`);

  const hasOauthApp = !!(env.WFM_CLIENT_ID && env.WFM_CLIENT_SECRET);
  const hasRefresh  = !!(creds && creds.has_refresh);
  const ready       = hasOauthApp && hasRefresh;

  const body = html`
    ${settingsSubNav('wfm-import', true)}

    <section class="card" style="margin-top:1rem">
      <div class="card-header">
        <h1>WFM import</h1>
      </div>
      <p class="muted" style="margin-top:0">
        Pull records from WorkflowMax (BlueRock) into Pipeline.
        Sample a handful first, eyeball the mapping, then commit.
        See <code>docs/wfm-mapping.md</code> for the full rule set.
      </p>

      <!-- =============== Connection status =============== -->
      <div style="margin-top:1rem;padding:0.75rem 1rem;background:${ready ? '#e6f4ea' : '#fff8e1'};border-radius:4px;border:1px solid ${ready ? '#9bcfa6' : '#e0c97a'}">
        <div style="display:flex;align-items:center;gap:.5rem;flex-wrap:wrap">
          <strong>Status:</strong>
          ${ready
            ? html`<span style="color:#1a7f37">✓ Connected</span>`
            : html`<span style="color:#9a6700">⚠ Not connected</span>`}
          ${creds?.org_id
            ? html`<span class="muted" style="font-size:.85em">org: <code>${escape(creds.org_id)}</code></span>`
            : ''}
          ${creds?.updated_at
            ? html`<span class="muted" style="font-size:.85em">last refreshed: ${escape(creds.updated_at)}</span>`
            : ''}
        </div>
        ${!hasOauthApp ? html`
          <p class="muted" style="margin:.5rem 0 0 0;font-size:.85em">
            <strong>Set up the OAuth app first.</strong>
            Run these commands locally (one-time):
            <br>
            <code style="background:rgba(0,0,0,0.05);padding:.1rem .3rem;border-radius:3px">npx wrangler pages secret put WFM_CLIENT_ID --project-name=c-lars-pms</code>
            <br>
            <code style="background:rgba(0,0,0,0.05);padding:.1rem .3rem;border-radius:3px">npx wrangler pages secret put WFM_CLIENT_SECRET --project-name=c-lars-pms</code>
            <br>
            Paste the values from <code>.env.local</code> when prompted, then refresh this page.
          </p>` : ''}
      </div>

      ${!ready ? html`
        <!-- =============== First-time refresh-token form =============== -->
        <section class="card" style="margin-top:1rem;border-color:#d4a72c">
          <h2 style="margin-top:0">Connect WFM</h2>
          <p class="muted" style="margin-top:0">
            Paste the <code>WFM_REFRESH_TOKEN</code> from your local
            <code>.env.local</code>. The server stores it in the
            <code>wfm_credentials</code> table; on every API call it
            uses the token to fetch a fresh access token (and rolls
            the refresh token forward — BlueRock rotates it on every
            use).
          </p>
          <form id="creds-form" style="display:flex;gap:.5rem;align-items:flex-start;flex-wrap:wrap">
            <input type="password" name="refresh_token" placeholder="WFM refresh token" required
                   style="flex:1;min-width:280px;font-family:ui-monospace,monospace;font-size:.85rem;padding:.4rem .6rem;border:1px solid var(--border);border-radius:4px">
            <button type="submit" class="btn primary">Save & test</button>
          </form>
          <p id="creds-status" class="muted" style="margin-top:.6rem;font-size:.85em"></p>
        </section>
        <script>
          document.getElementById('creds-form').addEventListener('submit', async function (e) {
            e.preventDefault();
            var fd = new FormData(e.target);
            var status = document.getElementById('creds-status');
            status.textContent = 'Saving and testing…';
            try {
              var res = await fetch('/settings/wfm-import/set-credentials', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ refresh_token: fd.get('refresh_token') }),
              });
              var j = await res.json();
              if (!j.ok) {
                status.textContent = 'Failed: ' + (j.error || 'unknown');
                return;
              }
              status.textContent = '✓ Saved. Reloading…';
              window.location.reload();
            } catch (err) {
              status.textContent = 'Failed: ' + (err.message || err);
            }
          });
        </script>
      ` : ''}

      ${ready ? html`
        <!-- =============== Sampling controls =============== -->
        <section class="card" style="margin-top:1rem"
                 x-data="wfmImportInit()">
          <h2 style="margin-top:0">Sample & import</h2>
          <p class="muted" style="margin-top:0">
            <strong>1.</strong> Click "Get random samples" to pull 5
            random records of each kind from WFM (no DB writes yet).
            <strong>2.</strong> Eyeball the proposed Pipeline rows.
            <strong>3.</strong> If happy, click "Import these" — the
            same 5 land in Pipeline. Re-run for a fresh shuffle.
          </p>

          <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.5rem">
            <button type="button" class="btn" @click="fetchSamples()" :disabled="busy">
              <span x-show="!busy">Get random samples</span>
              <span x-show="busy && phase === 'sampling'">Sampling…</span>
            </button>
            <button type="button" class="btn danger"
                    @click="commitImport()"
                    :disabled="busy || !samples"
                    x-show="samples">
              <span x-show="!busy || phase !== 'committing'">Import these</span>
              <span x-show="busy && phase === 'committing'">Importing…</span>
            </button>
          </div>

          <p class="aii-err-inline" x-show="error" x-text="error" style="color:#cf222e;margin-top:.6rem"></p>

          <!-- =============== Sample cards =============== -->
          <template x-if="samples">
            <div style="margin-top:1rem">
              <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(420px,1fr));gap:.75rem">
                <template x-for="(group, kind) in samples" :key="kind">
                  <section class="card" style="margin:0;padding:.75rem 1rem">
                    <h3 style="margin:0 0 .5rem 0;text-transform:capitalize;display:flex;justify-content:space-between;align-items:baseline;gap:.5rem">
                      <span x-text="kind"></span>
                      <span class="muted" style="font-size:.8rem;font-weight:400" x-text="group.length + ' sampled'"></span>
                    </h3>
                    <ul style="list-style:none;padding:0;margin:0">
                      <template x-for="rec in group" :key="rec.UUID || rec.ID || rec.UUID || JSON.stringify(rec).slice(0,40)">
                        <li style="padding:.4rem .5rem;border-bottom:1px dashed #eee;font-size:.85rem;line-height:1.4">
                          <strong x-text="rec.Name || rec.ID || rec.UUID || '(unnamed)'"></strong>
                          <template x-if="rec.UUID">
                            <code style="font-size:.75rem;color:#999;display:block">UUID: <span x-text="rec.UUID"></span></code>
                          </template>
                          <template x-if="rec.State || rec.Category || rec.Type">
                            <span class="muted" style="display:block;font-size:.75rem">
                              <template x-if="rec.State"><span>State: <span x-text="rec.State"></span></span></template>
                              <template x-if="rec.Category"><span style="margin-left:.6rem">Cat: <span x-text="rec.Category"></span></span></template>
                              <template x-if="rec.Type"><span style="margin-left:.6rem">Type: <span x-text="rec.Type"></span></span></template>
                            </span>
                          </template>
                          <template x-if="rec.Client && rec.Client.Name">
                            <span class="muted" style="display:block;font-size:.75rem">Client: <span x-text="rec.Client.Name"></span></span>
                          </template>
                          <template x-if="rec.Email">
                            <span class="muted" style="display:block;font-size:.75rem">Email: <span x-text="rec.Email"></span></span>
                          </template>
                          <template x-if="rec.EstimatedValue || rec.Amount || rec.AmountIncludingTax">
                            <span class="muted" style="display:block;font-size:.75rem">
                              Value: $<span x-text="(rec.AmountIncludingTax || rec.Amount || rec.EstimatedValue || '0')"></span>
                            </span>
                          </template>
                        </li>
                      </template>
                    </ul>
                  </section>
                </template>
              </div>
            </div>
          </template>

          <!-- =============== Import result =============== -->
          <template x-if="importResult">
            <section class="card" style="margin-top:1rem;background:#e6f4ea;border-color:#9bcfa6">
              <h3 style="margin:0 0 .5rem 0">✓ Import complete</h3>
              <p class="muted" style="margin:.2rem 0">
                <span x-text="importResult.summary"></span>
              </p>
              <ul style="margin:.4rem 0 0 0;padding-left:1.2rem;font-size:.85em">
                <template x-for="link in importResult.links" :key="link.url">
                  <li><a :href="link.url" x-text="link.label"></a></li>
                </template>
              </ul>
            </section>
          </template>

          <script>
            window.wfmImportInit = function () {
              return {
                busy: false,
                phase: '',
                error: '',
                samples: null,
                importResult: null,

                async fetchSamples() {
                  this.busy = true; this.phase = 'sampling'; this.error = ''; this.importResult = null;
                  try {
                    const res = await fetch('/settings/wfm-import/sample', {
                      method: 'POST', credentials: 'same-origin',
                      headers: { 'content-type': 'application/json' },
                    });
                    const j = await res.json();
                    if (!j.ok) throw new Error(j.error || 'sample failed');
                    this.samples = j.samples;
                  } catch (e) {
                    this.error = String(e.message || e);
                  } finally {
                    this.busy = false; this.phase = '';
                  }
                },

                async commitImport() {
                  if (!this.samples) return;
                  if (!confirm('Import these into Pipeline? Idempotent — re-running with the same WFM IDs updates existing rows rather than duplicating.')) return;
                  this.busy = true; this.phase = 'committing'; this.error = '';
                  try {
                    const res = await fetch('/settings/wfm-import/commit', {
                      method: 'POST', credentials: 'same-origin',
                      headers: { 'content-type': 'application/json' },
                      body: JSON.stringify({ samples: this.samples }),
                    });
                    const j = await res.json();
                    if (!j.ok) throw new Error(j.error || 'import failed');
                    this.importResult = j;
                    this.samples = null;  // hide the preview now that they're imported
                  } catch (e) {
                    this.error = String(e.message || e);
                  } finally {
                    this.busy = false; this.phase = '';
                  }
                },
              };
            };
          </script>
        </section>
      ` : ''}
    </section>
  `;

  return htmlResponse(layout('WFM import', body, {
    user, activeNav: '/settings',
    flash: readFlash(url),
    breadcrumbs: [{ label: 'Settings', href: '/settings' }, { label: 'WFM import' }],
  }));
}
