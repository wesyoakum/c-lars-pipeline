// functions/settings/katana-customer-map/index.js
//
// GET /settings/katana-customer-map — admin-only Katana customer
// mapping workbench.
//
// Phase 2b. Pairs every Pipeline account with its corresponding
// Katana customer. Once mapped, accounts.katana_customer_id is what
// the future "push won opp -> Katana sales order" flow uses on its
// POST body. Migration 0070 added the columns.
//
// Logic:
//   1. Load every Pipeline account (id, name, alias, current
//      katana_customer_id / name).
//   2. Pull every Katana customer (paginated until exhausted).
//   3. For each unmapped account, compute the top 3 smart-suggest
//      candidates by token overlap + substring score.
//   4. Render an Alpine table — each row supports inline link / unlink
//      / "Create in Katana" actions that POST to sibling routes.
//
// If the Katana fetch fails the page still renders; mappings can be
// edited from cached state but suggestions / picker are empty.

import { layout, htmlResponse, html, escape, raw } from '../../lib/layout.js';
import { hasRole } from '../../lib/auth.js';
import { settingsSubNav } from '../../lib/settings-subnav.js';
import { all } from '../../lib/db.js';
import { apiGetAll } from '../../lib/katana-client.js';

// Words we drop when tokenizing for smart-suggest. Common corporate
// suffixes carry no signal — "Acme Inc" vs "Acme LLC" are the same
// company.
const STOPWORDS = new Set([
  'inc', 'llc', 'ltd', 'co', 'corp', 'corporation', 'company', 'companies',
  'the', 'and', 'group', 'holdings', 'limited', 'plc', 'sa', 'gmbh',
  'usa', 'us', 'international', 'intl',
]);

function tokenize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[.,\-_/&']/g, ' ')
    .split(/\s+/)
    .filter((t) => t && t.length >= 3 && !STOPWORDS.has(t));
}

/**
 * Score one (account, katana customer) pair. Higher is a stronger
 * suggested match. Zero means no overlap (won't be suggested).
 *
 * Heuristics:
 *   * Exact case-insensitive name/alias equality            : +100
 *   * Katana name appears as a substring inside the account : +30
 *   * Account name appears as a substring inside Katana     : +25
 *   * Per-token overlap (after stopword strip, len >= 3)    : +5 each
 */
function scoreMatch(account, katanaName) {
  const aName = String(account.name || '').trim();
  const aAlias = String(account.alias || '').trim();
  const kName = String(katanaName || '').trim();
  if (!kName) return 0;

  const aLower = aName.toLowerCase();
  const aliasLower = aAlias.toLowerCase();
  const kLower = kName.toLowerCase();

  let score = 0;
  if (aLower === kLower || aliasLower === kLower) score += 100;
  if (aLower.length >= 3 && aLower.includes(kLower)) score += 30;
  if (aliasLower.length >= 3 && aliasLower.includes(kLower)) score += 30;
  if (kLower.length >= 3 && kLower.includes(aLower)) score += 25;
  if (kLower.length >= 3 && aliasLower && kLower.includes(aliasLower)) score += 25;

  const aTokens = new Set([...tokenize(aName), ...tokenize(aAlias)]);
  for (const kt of tokenize(kName)) {
    if (aTokens.has(kt)) score += 5;
  }
  return score;
}

function topMatches(account, katanaCustomers, n = 3) {
  if (account.katana_customer_id) return [];
  const scored = [];
  for (const kc of katanaCustomers) {
    const score = scoreMatch(account, kc.name);
    if (score > 0) scored.push({ kc, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, n).map((s) => ({ id: s.kc.id, name: s.kc.name, score: s.score }));
}

export async function onRequestGet(context) {
  const { env, data } = context;
  const user = data?.user;
  if (!user) return new Response('Sign in required', { status: 401 });
  if (!hasRole(user, 'admin')) {
    return htmlResponse(layout('Katana customers',
      '<section class="card"><h1>Katana customers</h1><p>Admin only.</p></section>',
      { user, env: data?.env }), { status: 403 });
  }

  // Load every account row. Excluding soft-deleted ones — those won't
  // ever push to Katana. Active state and is_archived are fine to
  // include (an archived account might still need its Katana mapping
  // for historical sales orders).
  const accountRows = await all(env.DB,
    `SELECT id, name, alias, is_active, is_archived,
            katana_customer_id, katana_customer_name
       FROM accounts
      WHERE COALESCE(is_deleted, 0) = 0
      ORDER BY LOWER(name) ASC`);

  // Pull every Katana customer (paginated). If the API fails (key
  // revoked, network blip), render the page anyway — admin can still
  // unlink stale mappings even with no suggestions.
  let katanaCustomers = [];
  let katanaError = null;
  try {
    katanaCustomers = await apiGetAll(env, '/customers', {});
  } catch (err) {
    katanaError = String(err && err.message || err);
  }

  // Compute per-account suggestions server-side. Cheaper than shipping
  // all customers to the client and scoring there, and keeps the
  // suggestion algorithm in one place.
  const enriched = accountRows.map((a) => ({
    ...a,
    suggestions: topMatches(a, katanaCustomers),
  }));

  const mappedCount = enriched.filter((a) => a.katana_customer_id).length;
  const totalCount = enriched.length;

  // Pre-serialize what the Alpine component needs as a single JSON
  // blob. Includes the full Katana customer list so the manual picker
  // can search-as-you-type without a round trip.
  const pageState = {
    accounts: enriched.map((a) => ({
      id: a.id,
      name: a.name,
      alias: a.alias || '',
      is_active: a.is_active ? 1 : 0,
      is_archived: a.is_archived ? 1 : 0,
      katana_customer_id: a.katana_customer_id || null,
      katana_customer_name: a.katana_customer_name || '',
      suggestions: a.suggestions,
    })),
    katanaCustomers: katanaCustomers.map((kc) => ({ id: kc.id, name: (kc.name || '').trim() }))
      .filter((kc) => kc.name)
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
  // Escape `<` so an account name containing `</script>` can't break
  // out of the inline <script> below. Escaping just `<` is enough; the
  // JSON parser decodes `<` correctly.
  const pageStateJson = JSON.stringify(pageState).replace(/</g, '\\u003c');

  const body = html`
    ${settingsSubNav('katana-customer-map', true)}

    <section class="card" style="margin-top:1rem" x-data="katanaCustomerMap()" x-init="init()">
      <div class="card-header">
        <h1>Katana customers</h1>
      </div>
      <p class="muted" style="margin-top:0">
        One-time mapping of Pipeline accounts to Katana customers.
        Required prep for the won-opportunity &rarr; Katana sales-order
        push. Each link sets <code>accounts.katana_customer_id</code>
        on the row; clicking <strong>Create in Katana</strong> creates
        a new Katana customer using the Pipeline account's name and
        links it.
      </p>

      ${katanaError ? html`
        <div style="margin-top:1rem;padding:.75rem 1rem;background:#fdecea;border:1px solid #f5c2bf;border-radius:4px">
          <strong>Couldn't reach Katana:</strong> <code>${escape(katanaError)}</code>.
          You can still unlink existing mappings; suggestions and the picker are empty.
        </div>
      ` : ''}

      <!-- =============== Status banner =============== -->
      <div style="margin-top:1rem;padding:.75rem 1rem;background:var(--bg-elev);border:1px solid var(--border);border-radius:4px;display:flex;gap:1rem;flex-wrap:wrap;align-items:center">
        <strong>${mappedCount} of ${totalCount}</strong> accounts mapped
        <span class="muted" style="font-size:.85em">${katanaCustomers.length} customer${katanaCustomers.length === 1 ? '' : 's'} in Katana</span>
        <span style="margin-left:auto">
          <label style="font-size:.85em">
            Show:
            <select x-model="filter" style="font-size:.85em">
              <option value="all">All</option>
              <option value="unmapped">Unmapped only</option>
              <option value="mapped">Mapped only</option>
              <option value="suggested">Has suggestions</option>
            </select>
          </label>
          <input type="search" x-model="search" placeholder="Filter by name…" style="font-size:.85em;margin-left:.5rem;padding:.1rem .3rem">
        </span>
      </div>

      <!-- =============== Table =============== -->
      <table class="meta-table" style="width:100%;margin-top:1rem;font-size:.9rem">
        <thead>
          <tr>
            <th style="text-align:left">Pipeline account</th>
            <th style="text-align:left;width:30%">Katana mapping</th>
            <th style="text-align:left;width:35%">Suggestions / actions</th>
          </tr>
        </thead>
        <tbody>
          <template x-for="row in visibleRows" :key="row.id">
            <tr :class="row.busy ? 'busy' : ''" :style="row.is_active ? '' : 'opacity:.6'">
              <td>
                <a :href="'/accounts/' + row.id" x-text="row.name" style="text-decoration:none"></a>
                <template x-if="row.alias">
                  <span class="muted" style="font-size:.85em" x-text="' (' + row.alias + ')'"></span>
                </template>
                <template x-if="row.is_archived">
                  <span class="muted" style="font-size:.75em;margin-left:.4rem">[archived]</span>
                </template>
              </td>
              <td>
                <template x-if="row.katana_customer_id">
                  <span style="display:inline-flex;align-items:center;gap:.4rem;padding:.1rem .5rem;background:#e6f4ea;border:1px solid #9bcfa6;border-radius:3px">
                    <strong x-text="row.katana_customer_name || ('#' + row.katana_customer_id)"></strong>
                    <button type="button" @click="unlink(row)" :disabled="row.busy" title="Unlink" style="border:none;background:transparent;cursor:pointer;font-size:1rem;line-height:1;padding:0">&times;</button>
                  </span>
                </template>
                <template x-if="!row.katana_customer_id">
                  <span class="muted">—</span>
                </template>
              </td>
              <td>
                <template x-if="!row.katana_customer_id">
                  <div style="display:flex;flex-wrap:wrap;gap:.4rem;align-items:center">
                    <template x-for="s in row.suggestions" :key="s.id">
                      <button type="button" class="btn btn-xs" @click="link(row, s)" :disabled="row.busy"
                              :title="'score ' + s.score">
                        &rarr; <span x-text="s.name"></span>
                      </button>
                    </template>
                    <select x-model="row.pickId" :disabled="row.busy || katanaCustomers.length === 0" style="font-size:.8em;max-width:14rem">
                      <option value="">— pick from Katana —</option>
                      <template x-for="kc in katanaCustomers" :key="kc.id">
                        <option :value="kc.id" x-text="kc.name"></option>
                      </template>
                    </select>
                    <button type="button" class="btn btn-xs" @click="linkPicked(row)" :disabled="row.busy || !row.pickId">Link</button>
                    <button type="button" class="btn btn-xs" @click="createInKatana(row)" :disabled="row.busy" title="Create a new Katana customer using this account's name">+ Create in Katana</button>
                  </div>
                </template>
                <template x-if="row.katana_customer_id">
                  <span class="muted" style="font-size:.85em">linked</span>
                </template>
              </td>
            </tr>
          </template>
          <template x-if="visibleRows.length === 0">
            <tr><td colspan="3" class="muted" style="padding:1rem;text-align:center">No accounts match the current filter.</td></tr>
          </template>
        </tbody>
      </table>
    </section>

    <script>${raw(MAP_SCRIPT)}</script>
    <script>window.__KATANA_MAP_STATE__ = ${raw(pageStateJson)};</script>
  `;

  return htmlResponse(layout('Katana customers', body, {
    user,
    env: data?.env,
    activeNav: '/settings',
    breadcrumbs: [{ label: 'Settings', href: '/settings' }, { label: 'Katana customers' }],
  }));
}

// Alpine component. Lives on window so we can keep it inside a normal
// <script> string (no nested-backtick interpolation in the html`` block).
const MAP_SCRIPT = `
document.addEventListener('alpine:init', function () {
  Alpine.data('katanaCustomerMap', function () {
    return {
      rows: [],
      katanaCustomers: [],
      filter: 'all',
      search: '',
      init: function () {
        var state = window.__KATANA_MAP_STATE__ || { accounts: [], katanaCustomers: [] };
        this.rows = (state.accounts || []).map(function (r) {
          return Object.assign({ busy: false, pickId: '' }, r);
        });
        this.katanaCustomers = state.katanaCustomers || [];
      },
      get visibleRows() {
        var f = this.filter;
        var q = (this.search || '').trim().toLowerCase();
        return this.rows.filter(function (r) {
          if (f === 'mapped'    && !r.katana_customer_id) return false;
          if (f === 'unmapped'  &&  r.katana_customer_id) return false;
          if (f === 'suggested' && (r.katana_customer_id || (r.suggestions || []).length === 0)) return false;
          if (q) {
            var hay = (r.name + ' ' + (r.alias || '') + ' ' + (r.katana_customer_name || '')).toLowerCase();
            if (hay.indexOf(q) === -1) return false;
          }
          return true;
        });
      },
      link: function (row, suggestion) {
        var self = this;
        row.busy = true;
        fetch('/settings/katana-customer-map/link', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            account_id: row.id,
            katana_customer_id: suggestion.id,
            katana_customer_name: suggestion.name,
          }),
        }).then(function (r) {
          if (!r.ok) return r.text().then(function (t) { throw new Error('HTTP ' + r.status + ': ' + t); });
          return r.json();
        }).then(function () {
          row.katana_customer_id = suggestion.id;
          row.katana_customer_name = suggestion.name;
          row.busy = false;
        }).catch(function (err) {
          row.busy = false;
          alert('Could not link: ' + (err && err.message ? err.message : 'unknown error'));
        });
      },
      linkPicked: function (row) {
        if (!row.pickId) return;
        var picked = this.katanaCustomers.find(function (kc) { return String(kc.id) === String(row.pickId); });
        if (!picked) return;
        this.link(row, { id: picked.id, name: picked.name, score: 0 });
      },
      unlink: function (row) {
        if (!confirm('Unlink ' + row.name + ' from Katana customer "' + (row.katana_customer_name || row.katana_customer_id) + '"?')) return;
        var self = this;
        row.busy = true;
        fetch('/settings/katana-customer-map/unlink', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ account_id: row.id }),
        }).then(function (r) {
          if (!r.ok) return r.text().then(function (t) { throw new Error('HTTP ' + r.status + ': ' + t); });
          return r.json();
        }).then(function () {
          row.katana_customer_id = null;
          row.katana_customer_name = '';
          row.pickId = '';
          row.busy = false;
        }).catch(function (err) {
          row.busy = false;
          alert('Could not unlink: ' + (err && err.message ? err.message : 'unknown error'));
        });
      },
      createInKatana: function (row) {
        var name = (row.alias || row.name || '').trim();
        if (!name) { alert('Account has no name to use.'); return; }
        var defaultName = name.length > 60 ? name.slice(0, 60) : name;
        var katanaName = prompt('Create a new Katana customer with this name?', defaultName);
        if (!katanaName) return;
        katanaName = katanaName.trim();
        if (!katanaName) return;
        var self = this;
        row.busy = true;
        fetch('/settings/katana-customer-map/create', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ account_id: row.id, katana_name: katanaName }),
        }).then(function (r) {
          if (!r.ok) return r.text().then(function (t) { throw new Error('HTTP ' + r.status + ': ' + t); });
          return r.json();
        }).then(function (data) {
          row.katana_customer_id = data.katana_customer_id;
          row.katana_customer_name = data.katana_customer_name;
          // Add the freshly-created customer to the picker list so it
          // appears in subsequent Link dropdowns without a page reload.
          if (data.katana_customer_id && !self.katanaCustomers.some(function (kc) { return kc.id === data.katana_customer_id; })) {
            self.katanaCustomers.push({ id: data.katana_customer_id, name: data.katana_customer_name });
            self.katanaCustomers.sort(function (a, b) { return a.name.localeCompare(b.name); });
          }
          row.busy = false;
        }).catch(function (err) {
          row.busy = false;
          alert('Could not create in Katana: ' + (err && err.message ? err.message : 'unknown error'));
        });
      },
    };
  });
});
`;
