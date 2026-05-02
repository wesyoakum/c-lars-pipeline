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
    ${settingsSubNav('wfm-import', true, user?.email === 'wes.yoakum@c-lars.com')}

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

          <!-- Search row (simple) -->
          <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.5rem;align-items:center">
            <span class="muted" style="font-size:.85rem">— or search:</span>
            <select x-model="searchKind"
                    @change="onSearchKindChange()"
                    :disabled="busy"
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
            <button type="button" class="btn" @click="doSearch()"
                    :disabled="busy || (!searchQuery.trim() && activeFilterCount() === 0)">
              <span x-show="!busy || phase !== 'searching'">Search</span>
              <span x-show="busy && phase === 'searching'">Searching…</span>
            </button>
            <button type="button" class="btn"
                    @click="searchAdvanced = !searchAdvanced"
                    style="font-size:.85rem"
                    x-text="(searchAdvanced ? 'Hide filters' : 'Advanced filters') + (activeFilterCount() ? ' (' + activeFilterCount() + ')' : '')"></button>
          </div>

          <!-- Advanced filters panel -->
          <div x-show="searchAdvanced" x-cloak
               style="margin-top:.6rem;padding:.7rem .85rem;border:1px solid var(--border);border-radius:6px;background:#fafafa">
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:.7rem">

              <!-- Date range -->
              <div x-show="availableDateFields().length > 0"
                   style="display:flex;flex-direction:column;gap:.3rem">
                <label class="muted" style="font-size:.78rem;font-weight:600;letter-spacing:.02em">Date range</label>
                <div style="display:flex;gap:.3rem;flex-wrap:wrap;align-items:center">
                  <select x-model="searchFilters.date_field" :disabled="busy"
                          style="padding:.25rem .35rem;border:1px solid var(--border);border-radius:4px;font-size:.82rem;flex:1;min-width:7rem">
                    <option value="">— field —</option>
                    <template x-for="opt in availableDateFields()" :key="opt">
                      <option :value="opt" x-text="opt"></option>
                    </template>
                  </select>
                  <select x-model="searchFilters.date_preset"
                          @change="applyDatePreset()"
                          :disabled="busy || !searchFilters.date_field"
                          style="padding:.25rem .35rem;border:1px solid var(--border);border-radius:4px;font-size:.82rem;flex:1;min-width:7rem">
                    <option value="">Custom</option>
                    <option value="last_7_days">Last 7 days</option>
                    <option value="last_30_days">Last 30 days</option>
                    <option value="last_90_days">Last 90 days</option>
                    <option value="this_month">This month</option>
                    <option value="last_month">Last month</option>
                    <option value="this_quarter">This quarter</option>
                    <option value="this_year">This year</option>
                    <option value="last_year">Last year</option>
                    <option value="year_2026">All of 2026</option>
                    <option value="year_2025">All of 2025</option>
                    <option value="year_2024">All of 2024</option>
                  </select>
                </div>
                <div style="display:flex;gap:.3rem;align-items:center">
                  <input type="date" x-model="searchFilters.date_from"
                         :disabled="busy || !searchFilters.date_field"
                         style="padding:.25rem .35rem;border:1px solid var(--border);border-radius:4px;font-size:.82rem;flex:1;min-width:0">
                  <span class="muted" style="font-size:.75rem">to</span>
                  <input type="date" x-model="searchFilters.date_to"
                         :disabled="busy || !searchFilters.date_field"
                         style="padding:.25rem .35rem;border:1px solid var(--border);border-radius:4px;font-size:.82rem;flex:1;min-width:0">
                </div>
              </div>

              <!-- State multi-select -->
              <div x-show="availableStates().length > 0"
                   style="display:flex;flex-direction:column;gap:.3rem">
                <label class="muted" style="font-size:.78rem;font-weight:600;letter-spacing:.02em">State</label>
                <div style="display:flex;gap:.3rem;flex-wrap:wrap">
                  <template x-for="opt in availableStates()" :key="opt">
                    <button type="button" :disabled="busy"
                            @click="toggleArrayFilter('state', opt)"
                            :style="chipStyle(searchFilters.state.includes(opt))"
                            x-text="opt"></button>
                  </template>
                </div>
              </div>

              <!-- Category multi-select (lead) -->
              <div x-show="availableCategories().length > 0"
                   style="display:flex;flex-direction:column;gap:.3rem">
                <label class="muted" style="font-size:.78rem;font-weight:600;letter-spacing:.02em">Category</label>
                <div style="display:flex;gap:.3rem;flex-wrap:wrap">
                  <template x-for="opt in availableCategories()" :key="opt">
                    <button type="button" :disabled="busy"
                            @click="toggleArrayFilter('category', opt)"
                            :style="chipStyle(searchFilters.category.includes(opt))"
                            x-text="opt"></button>
                  </template>
                </div>
              </div>

              <!-- Type multi-select (job) -->
              <div x-show="availableTypes().length > 0"
                   style="display:flex;flex-direction:column;gap:.3rem">
                <label class="muted" style="font-size:.78rem;font-weight:600;letter-spacing:.02em">Type</label>
                <div style="display:flex;gap:.3rem;flex-wrap:wrap">
                  <template x-for="opt in availableTypes()" :key="opt">
                    <button type="button" :disabled="busy"
                            @click="toggleArrayFilter('type', opt)"
                            :style="chipStyle(searchFilters.type.includes(opt))"
                            x-text="opt"></button>
                  </template>
                </div>
              </div>

              <!-- Relation-name substrings -->
              <div style="display:flex;flex-direction:column;gap:.3rem"
                   x-show="searchKind === 'lead' || searchKind === 'quote' || searchKind === 'job'">
                <label class="muted" style="font-size:.78rem;font-weight:600;letter-spacing:.02em">Client name contains</label>
                <input type="text" x-model="searchFilters.client_name"
                       :disabled="busy" placeholder="e.g. rovop"
                       style="padding:.25rem .4rem;border:1px solid var(--border);border-radius:4px;font-size:.82rem">
              </div>
              <div style="display:flex;flex-direction:column;gap:.3rem"
                   x-show="searchKind === 'lead' || searchKind === 'quote'">
                <label class="muted" style="font-size:.78rem;font-weight:600;letter-spacing:.02em">Contact name contains</label>
                <input type="text" x-model="searchFilters.contact_name"
                       :disabled="busy" placeholder="e.g. doug"
                       style="padding:.25rem .4rem;border:1px solid var(--border);border-radius:4px;font-size:.82rem">
              </div>
              <div style="display:flex;flex-direction:column;gap:.3rem"
                   x-show="searchKind === 'lead'">
                <label class="muted" style="font-size:.78rem;font-weight:600;letter-spacing:.02em">Owner name contains</label>
                <input type="text" x-model="searchFilters.owner_name"
                       :disabled="busy" placeholder="e.g. wes"
                       style="padding:.25rem .4rem;border:1px solid var(--border);border-radius:4px;font-size:.82rem">
              </div>
              <div style="display:flex;flex-direction:column;gap:.3rem"
                   x-show="searchKind === 'job'">
                <label class="muted" style="font-size:.78rem;font-weight:600;letter-spacing:.02em">Manager name contains</label>
                <input type="text" x-model="searchFilters.manager_name"
                       :disabled="busy" placeholder="e.g. falynne"
                       style="padding:.25rem .4rem;border:1px solid var(--border);border-radius:4px;font-size:.82rem">
              </div>

              <!-- Amount range -->
              <div x-show="availableAmountFields().length > 0"
                   style="display:flex;flex-direction:column;gap:.3rem">
                <label class="muted" style="font-size:.78rem;font-weight:600;letter-spacing:.02em">Amount range (USD)</label>
                <select x-model="searchFilters.amount_field" :disabled="busy"
                        style="padding:.25rem .35rem;border:1px solid var(--border);border-radius:4px;font-size:.82rem">
                  <option value="">— field —</option>
                  <template x-for="opt in availableAmountFields()" :key="opt">
                    <option :value="opt" x-text="opt"></option>
                  </template>
                </select>
                <div style="display:flex;gap:.3rem;align-items:center">
                  <input type="number" min="0" step="any" x-model="searchFilters.amount_min"
                         :disabled="busy || !searchFilters.amount_field" placeholder="min"
                         style="padding:.25rem .4rem;border:1px solid var(--border);border-radius:4px;font-size:.82rem;flex:1;min-width:0">
                  <span class="muted" style="font-size:.75rem">to</span>
                  <input type="number" min="0" step="any" x-model="searchFilters.amount_max"
                         :disabled="busy || !searchFilters.amount_field" placeholder="max"
                         style="padding:.25rem .4rem;border:1px solid var(--border);border-radius:4px;font-size:.82rem;flex:1;min-width:0">
                </div>
              </div>

              <!-- Client flags -->
              <div x-show="searchKind === 'client'"
                   style="display:flex;flex-direction:column;gap:.3rem">
                <label class="muted" style="font-size:.78rem;font-weight:600;letter-spacing:.02em">Flags</label>
                <div style="display:flex;gap:.3rem;align-items:center;flex-wrap:wrap">
                  <span class="muted" style="font-size:.78rem">Archived:</span>
                  <select x-model="searchFilters.is_archived" :disabled="busy"
                          style="padding:.2rem .35rem;border:1px solid var(--border);border-radius:4px;font-size:.78rem">
                    <option value="">any</option>
                    <option value="yes">yes</option>
                    <option value="no">no</option>
                  </select>
                  <span class="muted" style="font-size:.78rem">Prospect:</span>
                  <select x-model="searchFilters.is_prospect" :disabled="busy"
                          style="padding:.2rem .35rem;border:1px solid var(--border);border-radius:4px;font-size:.78rem">
                    <option value="">any</option>
                    <option value="yes">yes</option>
                    <option value="no">no</option>
                  </select>
                </div>
              </div>

              <!-- Limit -->
              <div style="display:flex;flex-direction:column;gap:.3rem">
                <label class="muted" style="font-size:.78rem;font-weight:600;letter-spacing:.02em">Result limit</label>
                <input type="number" min="1" max="500" x-model.number="searchLimit"
                       :disabled="busy"
                       style="padding:.25rem .4rem;border:1px solid var(--border);border-radius:4px;font-size:.82rem;width:6rem">
              </div>
            </div>

            <div style="margin-top:.6rem;display:flex;gap:.4rem;align-items:center;flex-wrap:wrap">
              <button type="button" class="btn"
                      @click="clearFilters()"
                      :disabled="busy"
                      style="font-size:.82rem">Clear filters</button>
              <span class="muted" style="font-size:.75rem"
                    x-text="activeFilterCount() ? activeFilterCount() + ' filter' + (activeFilterCount() === 1 ? '' : 's') + ' active' : 'No filters set'"></span>
            </div>
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

              <!-- Surface any per-record errors so the user can see when a
                   row didn't import cleanly even when overall ok=true. -->
              <template x-if="importResult.errors && importResult.errors.length > 0">
                <div style="margin-top:.7rem;padding:.5rem .7rem;background:#fff8c5;border:1px solid #d4a72c;border-radius:4px;font-size:.85em">
                  <strong>Errors during import:</strong>
                  <ul style="margin:.3rem 0 0 0;padding-left:1.2rem">
                    <template x-for="(err, idx) in importResult.errors" :key="idx">
                      <li style="font-family:ui-monospace,monospace;font-size:.85em" x-text="err"></li>
                    </template>
                  </ul>
                </div>
              </template>
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
                searchAdvanced: false,
                searchLimit: 100,
                searchFilters: {
                  date_field: '', date_preset: '', date_from: '', date_to: '',
                  state: [], category: [], type: [],
                  client_name: '', contact_name: '', owner_name: '', manager_name: '',
                  amount_field: '', amount_min: '', amount_max: '',
                  is_archived: '', is_prospect: '',
                },

                // Per-kind static catalogs. The UI hides irrelevant
                // controls based on these maps; the server independently
                // re-validates on filter dispatch.
                STATES_BY_KIND: {
                  lead:   ['Current', 'Won', 'Lost'],
                  quote:  ['Draft', 'Issued', 'Accepted', 'Declined', 'Archived'],
                  job:    ['PLANNED', 'PRODUCTION', 'COMPLETED', 'CANCELLED'],
                  client: [],
                  staff:  [],
                },
                CATEGORIES_BY_KIND: {
                  lead: ['1 Identified', '2 Qualifying', '3 Opportunity',
                         '4 Quoted', '5 Won', '6 Lost'],
                },
                TYPES_BY_KIND: {
                  job: ['NEW EQUIPMENT', 'SPARES', 'REFURBISHMENT', 'SERVICE',
                        'SUPPLIES', 'WARRANTY', 'CYLINDERS', 'REFURB CYLINDERS'],
                },
                DATE_FIELDS_BY_KIND: {
                  lead:   ['Date', 'DateWonLost'],
                  quote:  ['Date', 'ValidDate'],
                  job:    ['StartDate', 'DueDate', 'DateCreatedUtc', 'DateModifiedUtc'],
                  client: [],
                  staff:  [],
                },
                AMOUNT_FIELDS_BY_KIND: {
                  lead:  ['EstimatedValue'],
                  quote: ['AmountIncludingTax', 'Amount', 'EstimatedCost'],
                  job:   ['Budget'],
                  client: [],
                  staff:  [],
                },

                availableStates()       { return this.STATES_BY_KIND[this.searchKind]   || []; },
                availableCategories()   { return this.CATEGORIES_BY_KIND[this.searchKind] || []; },
                availableTypes()        { return this.TYPES_BY_KIND[this.searchKind]     || []; },
                availableDateFields()   { return this.DATE_FIELDS_BY_KIND[this.searchKind]  || []; },
                availableAmountFields() { return this.AMOUNT_FIELDS_BY_KIND[this.searchKind] || []; },

                chipStyle(active) {
                  return {
                    padding: '.2rem .5rem',
                    border: '1px solid ' + (active ? '#1f6feb' : 'var(--border)'),
                    borderRadius: '12px',
                    background: active ? '#dbeafe' : '#fff',
                    fontSize: '.78rem',
                    cursor: 'pointer',
                  };
                },

                onSearchKindChange() {
                  // Drop filters that don't apply to the new kind so the
                  // payload is clean and the UI doesn't misrepresent
                  // active-filter count.
                  const f = this.searchFilters;
                  if (!this.availableDateFields().includes(f.date_field)) {
                    f.date_field = ''; f.date_preset = '';
                    f.date_from = ''; f.date_to = '';
                  }
                  // State / Category / Type lists differ per kind — clear.
                  f.state = []; f.category = []; f.type = [];
                  if (!this.availableAmountFields().includes(f.amount_field)) {
                    f.amount_field = ''; f.amount_min = ''; f.amount_max = '';
                  }
                  if (this.searchKind !== 'client') {
                    f.is_archived = ''; f.is_prospect = '';
                  }
                  this.searchFilters = Object.assign({}, f);
                },

                toggleArrayFilter(key, value) {
                  const arr = (this.searchFilters[key] || []).slice();
                  const idx = arr.indexOf(value);
                  if (idx >= 0) arr.splice(idx, 1);
                  else arr.push(value);
                  this.searchFilters = Object.assign({}, this.searchFilters, { [key]: arr });
                },

                applyDatePreset() {
                  const preset = this.searchFilters.date_preset;
                  if (!preset) return;   // Custom — leave from/to alone
                  const fmt = (d) => {
                    const y = d.getFullYear();
                    const m = String(d.getMonth() + 1).padStart(2, '0');
                    const dd = String(d.getDate()).padStart(2, '0');
                    return y + '-' + m + '-' + dd;
                  };
                  const today = new Date(); today.setHours(0, 0, 0, 0);
                  let from = null, to = null;
                  if (preset === 'last_7_days')   { to = today; from = new Date(today); from.setDate(from.getDate() - 7); }
                  else if (preset === 'last_30_days')  { to = today; from = new Date(today); from.setDate(from.getDate() - 30); }
                  else if (preset === 'last_90_days')  { to = today; from = new Date(today); from.setDate(from.getDate() - 90); }
                  else if (preset === 'this_month')    { from = new Date(today.getFullYear(), today.getMonth(), 1); to = today; }
                  else if (preset === 'last_month')    {
                    from = new Date(today.getFullYear(), today.getMonth() - 1, 1);
                    to   = new Date(today.getFullYear(), today.getMonth(), 0);
                  }
                  else if (preset === 'this_quarter')  {
                    const q = Math.floor(today.getMonth() / 3);
                    from = new Date(today.getFullYear(), q * 3, 1);
                    to = today;
                  }
                  else if (preset === 'this_year')     { from = new Date(today.getFullYear(), 0, 1); to = today; }
                  else if (preset === 'last_year')     {
                    from = new Date(today.getFullYear() - 1, 0, 1);
                    to   = new Date(today.getFullYear() - 1, 11, 31);
                  }
                  else if (preset === 'year_2026')     { from = new Date(2026, 0, 1); to = new Date(2026, 11, 31); }
                  else if (preset === 'year_2025')     { from = new Date(2025, 0, 1); to = new Date(2025, 11, 31); }
                  else if (preset === 'year_2024')     { from = new Date(2024, 0, 1); to = new Date(2024, 11, 31); }
                  if (from) this.searchFilters.date_from = fmt(from);
                  if (to)   this.searchFilters.date_to   = fmt(to);
                },

                activeFilterCount() {
                  const f = this.searchFilters;
                  let n = 0;
                  if (f.date_field && (f.date_from || f.date_to)) n++;
                  if (f.state && f.state.length)       n++;
                  if (f.category && f.category.length) n++;
                  if (f.type && f.type.length)         n++;
                  if (f.client_name)  n++;
                  if (f.contact_name) n++;
                  if (f.owner_name)   n++;
                  if (f.manager_name) n++;
                  if (f.amount_field && (f.amount_min !== '' || f.amount_max !== '')) n++;
                  if (f.is_archived) n++;
                  if (f.is_prospect) n++;
                  return n;
                },

                clearFilters() {
                  this.searchFilters = {
                    date_field: '', date_preset: '', date_from: '', date_to: '',
                    state: [], category: [], type: [],
                    client_name: '', contact_name: '', owner_name: '', manager_name: '',
                    amount_field: '', amount_min: '', amount_max: '',
                    is_archived: '', is_prospect: '',
                  };
                },

                buildSearchPayload() {
                  const f = this.searchFilters;
                  const out = {
                    kind: this.searchKind,
                    query: (this.searchQuery || '').trim(),
                    limit: Number(this.searchLimit) || 100,
                    filters: {},
                  };
                  if (f.date_field && (f.date_from || f.date_to)) {
                    out.filters.date_field = f.date_field;
                    if (f.date_from) out.filters.date_from = f.date_from;
                    if (f.date_to)   out.filters.date_to   = f.date_to;
                  }
                  if (f.state && f.state.length)       out.filters.state    = f.state.slice();
                  if (f.category && f.category.length) out.filters.category = f.category.slice();
                  if (f.type && f.type.length)         out.filters.type     = f.type.slice();
                  if (f.client_name)  out.filters.client_name  = f.client_name.trim();
                  if (f.contact_name) out.filters.contact_name = f.contact_name.trim();
                  if (f.owner_name)   out.filters.owner_name   = f.owner_name.trim();
                  if (f.manager_name) out.filters.manager_name = f.manager_name.trim();
                  if (f.amount_field && (f.amount_min !== '' || f.amount_max !== '')) {
                    out.filters.amount_field = f.amount_field;
                    if (f.amount_min !== '') out.filters.amount_min = Number(f.amount_min);
                    if (f.amount_max !== '') out.filters.amount_max = Number(f.amount_max);
                  }
                  if (f.is_archived) out.filters.is_archived = f.is_archived === 'yes';
                  if (f.is_prospect) out.filters.is_prospect = f.is_prospect === 'yes';
                  return out;
                },

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

                // Search WFM with the current text query and structured
                // filters. Results populate the same samples state so
                // the existing card UI + import flow work unchanged.
                async doSearch() {
                  const payload = this.buildSearchPayload();
                  if (!payload.query && Object.keys(payload.filters).length === 0) {
                    this.error = 'Enter a search term or set at least one filter.';
                    return;
                  }
                  this.busy = true; this.phase = 'searching';
                  this.error = ''; this.importResult = null;
                  try {
                    const res = await fetch('/settings/wfm-import/search', {
                      method: 'POST', credentials: 'same-origin',
                      headers: { 'content-type': 'application/json' },
                      body: JSON.stringify(payload),
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
                      this.error = 'Showing first ' + j.count + ' matches (limit hit) — narrow filters or raise the limit.';
                    } else {
                      this.error = j.count + ' match' + (j.count === 1 ? '' : 'es') + '.';
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
