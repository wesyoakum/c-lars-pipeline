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
            <strong>1.</strong> Pick a sample size and click "Get
            random samples" — no DB writes yet.
            <strong>2.</strong> Uncheck any record you don't want.
            <strong>3.</strong> Click "Import selected" — only the
            checked records land in Pipeline. Re-run for a fresh
            shuffle.
          </p>

          <!-- Random sample row -->
          <div style="display:flex;gap:.6rem;flex-wrap:wrap;margin-top:.5rem;align-items:center">
            <label style="display:flex;align-items:center;gap:.4rem">
              <span class="muted" style="font-size:.85rem">Sample size per entity:</span>
              <input type="number" min="1" max="50" x-model.number="count"
                     style="width:4.5rem;padding:.3rem .4rem;border:1px solid var(--border);border-radius:4px;font-family:ui-monospace,monospace"
                     :disabled="busy">
            </label>
            <button type="button" class="btn" @click="fetchSamples()" :disabled="busy || !count || count < 1">
              <span x-show="!busy">Get random samples</span>
              <span x-show="busy && phase === 'sampling'">Sampling…</span>
            </button>
          </div>

          <!-- Search row -->
          <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.5rem;align-items:center">
            <span class="muted" style="font-size:.85rem">— or search:</span>
            <select x-model="searchKind" :disabled="busy"
                    style="padding:.32rem .4rem;border:1px solid var(--border);border-radius:4px;font-size:.9rem">
              <option value="client">Clients</option>
              <option value="lead">Leads</option>
              <option value="quote">Quotes</option>
              <option value="job">Jobs</option>
              <option value="staff">Staff</option>
            </select>
            <input type="text" x-model="searchQuery"
                   placeholder="search by name / id / description…"
                   @keyup.enter="doSearch()"
                   :disabled="busy"
                   style="flex:1;min-width:14rem;padding:.32rem .5rem;border:1px solid var(--border);border-radius:4px;font-size:.9rem">
            <button type="button" class="btn" @click="doSearch()" :disabled="busy || !searchQuery.trim()">
              <span x-show="!busy || phase !== 'searching'">Search</span>
              <span x-show="busy && phase === 'searching'">Searching…</span>
            </button>
          </div>

          <!-- Import button (shows once a batch is loaded, regardless of source) -->
          <div style="margin-top:.6rem" x-show="samples">
            <button type="button" class="btn danger"
                    @click="commitImport()"
                    :disabled="busy || !samples || totalSelected() === 0">
              <span x-show="!busy || phase !== 'committing'">
                Import selected (<span x-text="totalSelected()"></span>)
              </span>
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
                    <h3 style="margin:0 0 .5rem 0;display:flex;justify-content:space-between;align-items:baseline;gap:.5rem;flex-wrap:wrap">
                      <span style="text-transform:capitalize" x-text="kind"></span>
                      <span style="display:flex;gap:.4rem;align-items:center;font-size:.78rem;font-weight:400">
                        <span class="muted" x-text="selectedCountInGroup(kind) + ' / ' + group.length + ' selected'"></span>
                        <button type="button" @click="selectAllInGroup(kind, true)"
                                style="background:none;border:none;color:#1f6feb;cursor:pointer;padding:0 .15rem;font-size:.78rem;text-decoration:underline">all</button>
                        <button type="button" @click="selectAllInGroup(kind, false)"
                                style="background:none;border:none;color:#1f6feb;cursor:pointer;padding:0 .15rem;font-size:.78rem;text-decoration:underline">none</button>
                      </span>
                    </h3>
                    <ul style="list-style:none;padding:0;margin:0">
                      <template x-for="(rec, idx) in group" :key="idx + '-' + (rec.UUID || rec.ID || '')">
                        <li style="display:flex;gap:.5rem;align-items:flex-start;padding:.4rem .5rem;border-bottom:1px dashed #eee;font-size:.85rem;line-height:1.4;cursor:pointer"
                            @click="toggleSelect(kind, rec)">
                          <input type="checkbox"
                                 :checked="isSelected(kind, rec)"
                                 @click.stop="toggleSelect(kind, rec)"
                                 style="margin-top:.25rem">
                          <div style="flex:1;min-width:0">
                            <strong x-text="rec.Name || rec.ID || rec.UUID || '(unnamed)'"></strong>
                            <span x-show="rec.UUID" style="display:block">
                              <code style="font-size:.72rem;color:#999;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">UUID: <span x-text="rec.UUID"></span></code>
                            </span>
                            <span x-show="rec.State || rec.Category || rec.Type" class="muted" style="display:block;font-size:.75rem">
                              <span x-show="rec.State">State: <span x-text="rec.State"></span></span>
                              <span x-show="rec.Category" style="margin-left:.6rem">Cat: <span x-text="rec.Category"></span></span>
                              <span x-show="rec.Type" style="margin-left:.6rem">Type: <span x-text="rec.Type"></span></span>
                            </span>
                            <span x-show="rec.Client && rec.Client.Name" class="muted" style="display:block;font-size:.75rem">
                              Client: <span x-text="rec.Client && rec.Client.Name"></span>
                            </span>
                            <span x-show="rec.Email" class="muted" style="display:block;font-size:.75rem">
                              Email: <span x-text="rec.Email"></span>
                            </span>
                            <span x-show="rec.EstimatedValue || rec.Amount || rec.AmountIncludingTax" class="muted" style="display:block;font-size:.75rem">
                              Value: $<span x-text="rec.AmountIncludingTax || rec.Amount || rec.EstimatedValue || '0'"></span>
                            </span>
                          </div>
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
                count: 5,
                samples: null,
                selected: {},   // { kind: { recordKey: true } }
                importResult: null,
                searchKind: 'client',
                searchQuery: '',

                keyOf(rec) {
                  return rec.UUID || rec.ID || JSON.stringify(rec).slice(0, 40);
                },

                isSelected(kind, rec) {
                  return !!(this.selected[kind] && this.selected[kind][this.keyOf(rec)]);
                },

                toggleSelect(kind, rec) {
                  if (!this.selected[kind]) this.selected[kind] = {};
                  const k = this.keyOf(rec);
                  this.selected[kind][k] = !this.selected[kind][k];
                  // Force Alpine to notice the nested-object mutation.
                  this.selected = Object.assign({}, this.selected);
                },

                selectAllInGroup(kind, value) {
                  const next = {};
                  for (const rec of (this.samples[kind] || [])) {
                    if (value) next[this.keyOf(rec)] = true;
                  }
                  this.selected = Object.assign({}, this.selected, { [kind]: next });
                },

                selectedCountInGroup(kind) {
                  if (!this.samples || !this.samples[kind]) return 0;
                  return this.samples[kind].filter((r) => this.isSelected(kind, r)).length;
                },

                totalSelected() {
                  if (!this.samples) return 0;
                  let n = 0;
                  for (const kind of Object.keys(this.samples)) {
                    n += this.selectedCountInGroup(kind);
                  }
                  return n;
                },

                selectedSamples() {
                  const out = {};
                  if (!this.samples) return out;
                  for (const kind of Object.keys(this.samples)) {
                    out[kind] = (this.samples[kind] || [])
                      .filter((r) => this.isSelected(kind, r));
                  }
                  return out;
                },

                // Search WFM for records matching searchQuery of the
                // selected searchKind. Results populate the same
                // samples state so the existing card UI + import
                // flow work unchanged.
                async doSearch() {
                  const q = (this.searchQuery || '').trim();
                  if (!q) return;
                  this.busy = true; this.phase = 'searching';
                  this.error = ''; this.importResult = null;
                  try {
                    const res = await fetch('/settings/wfm-import/search', {
                      method: 'POST', credentials: 'same-origin',
                      headers: { 'content-type': 'application/json' },
                      body: JSON.stringify({ kind: this.searchKind, query: q }),
                    });
                    const j = await res.json();
                    if (!j.ok) throw new Error(j.error || 'search failed');
                    this.samples = j.samples;
                    const sel = {};
                    for (const kind of Object.keys(this.samples)) {
                      sel[kind] = {};
                      for (const rec of this.samples[kind]) {
                        sel[kind][this.keyOf(rec)] = true;
                      }
                    }
                    this.selected = sel;
                    if (j.count === 0) {
                      this.error = 'No matches.';
                    } else if (j.truncated) {
                      this.error = 'Showing first ' + j.count + ' matches — narrow the query for more specificity.';
                    }
                  } catch (e) {
                    this.error = String(e.message || e);
                  } finally {
                    this.busy = false; this.phase = '';
                  }
                },

                async fetchSamples() {
                  this.busy = true; this.phase = 'sampling';
                  this.error = ''; this.importResult = null;
                  try {
                    const res = await fetch('/settings/wfm-import/sample', {
                      method: 'POST', credentials: 'same-origin',
                      headers: { 'content-type': 'application/json' },
                      body: JSON.stringify({ count: Number(this.count) || 5 }),
                    });
                    const j = await res.json();
                    if (!j.ok) throw new Error(j.error || 'sample failed');
                    this.samples = j.samples;
                    // Default: pre-select every record so a quick "Import"
                    // brings the whole batch in.
                    const sel = {};
                    for (const kind of Object.keys(this.samples)) {
                      sel[kind] = {};
                      for (const rec of this.samples[kind]) {
                        sel[kind][this.keyOf(rec)] = true;
                      }
                    }
                    this.selected = sel;
                  } catch (e) {
                    this.error = String(e.message || e);
                  } finally {
                    this.busy = false; this.phase = '';
                  }
                },

                async commitImport() {
                  const filtered = this.selectedSamples();
                  const total = Object.values(filtered)
                    .reduce((sum, arr) => sum + arr.length, 0);
                  if (total === 0) {
                    alert('Nothing selected.');
                    return;
                  }
                  if (!confirm('Import ' + total + ' record(s) into Pipeline? Idempotent — re-running with the same WFM IDs updates existing rows rather than duplicating.')) return;
                  this.busy = true; this.phase = 'committing'; this.error = '';
                  try {
                    const res = await fetch('/settings/wfm-import/commit', {
                      method: 'POST', credentials: 'same-origin',
                      headers: { 'content-type': 'application/json' },
                      body: JSON.stringify({ samples: filtered }),
                    });
                    const j = await res.json();
                    if (!j.ok) throw new Error(j.error || 'import failed');
                    this.importResult = j;
                    this.samples = null;
                    this.selected = {};
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
