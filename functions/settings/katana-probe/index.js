// functions/settings/katana-probe/index.js
//
// GET /settings/katana-probe — admin-only Katana connection probe.
//
// Phase 1 of the Katana integration. Read-only. Hits a handful of
// list endpoints in parallel and renders the JSON in collapsible
// blocks so we can:
//   1. Confirm KATANA_API_KEY works at all.
//   2. See what products / variants / customers / tax rates /
//      locations already exist in Katana — those will drive the
//      design of the Phase 2 "Push won opportunity → Katana sales
//      order" flow (especially the SKU-mapping approach).
//
// No writes, no schema changes, no migrations. Self-contained;
// removing this file is the rollback.

import { layout, htmlResponse, html, escape, raw } from '../../lib/layout.js';
import { hasRole } from '../../lib/auth.js';
import { settingsSubNav } from '../../lib/settings-subnav.js';
import { apiGet } from '../../lib/katana-client.js';

// The probes we run on page load. limit=25 is enough to surface the
// full shape of small-tenant resources (milestone products, customer
// list) without paying for huge payloads. Adding /sales_orders and
// /services since both are central to the Phase 2 design — sales
// orders show how Adam structures existing project billing, services
// show whether non-physical line items have a separate resource.
const PROBES = [
  { key: 'products',      label: 'Products',     path: '/products',      query: { limit: 25 } },
  { key: 'variants',      label: 'Variants',     path: '/variants',      query: { limit: 25 } },
  { key: 'customers',     label: 'Customers',    path: '/customers',     query: { limit: 25 } },
  { key: 'sales_orders',  label: 'Sales orders', path: '/sales_orders',  query: { limit: 10 } },
  { key: 'services',      label: 'Services',     path: '/services',      query: { limit: 25 } },
  { key: 'tax_rates',     label: 'Tax rates',    path: '/tax_rates',     query: {} },
  { key: 'locations',     label: 'Locations',    path: '/locations',     query: {} },
  { key: 'user_info',     label: 'User info',    path: '/user_info',     query: {} },
];

export async function onRequestGet(context) {
  const { env, data } = context;
  const user = data?.user;
  if (!user) return new Response('Sign in required', { status: 401 });
  if (!hasRole(user, 'admin')) {
    return htmlResponse(layout('Katana probe',
      '<section class="card"><h1>Katana probe</h1><p>Admin only.</p></section>',
      { user, env: data?.env }), { status: 403 });
  }

  const hasApiKey = !!env.KATANA_API_KEY;

  // Run all probes in parallel. Each returns a uniform shape we can
  // render below. We catch per-probe so one bad endpoint doesn't take
  // down the page.
  const results = hasApiKey
    ? await Promise.all(PROBES.map(async (p) => {
        try {
          const r = await apiGet(env, p.path, { query: p.query });
          return { ...p, ok: r.ok, status: r.status, durationMs: r.durationMs, body: r.body, rawText: r.rawText, error: null };
        } catch (err) {
          return { ...p, ok: false, status: 0, durationMs: 0, body: null, rawText: '', error: String(err && err.message || err) };
        }
      }))
    : PROBES.map((p) => ({ ...p, ok: false, status: 0, durationMs: 0, body: null, rawText: '', error: 'KATANA_API_KEY not set' }));

  const overallOk = hasApiKey && results.every((r) => r.ok);

  // Bundle the full probe payload for the "Download as JSON" button.
  // We include a top-level wrapper with metadata (timestamp, base URL,
  // tenant identifier if exposed) so the file is self-describing — when
  // the user pastes it back to me, I have everything I need without
  // asking follow-ups.
  const downloadPayload = {
    schema: 'katana-probe-v1',
    captured_at: new Date().toISOString(),
    base_url: 'https://api.katanamrp.com/v1',
    overall_ok: overallOk,
    probes: results.map((r) => ({
      key: r.key,
      label: r.label,
      path: r.path,
      query: r.query,
      ok: r.ok,
      status: r.status,
      duration_ms: r.durationMs,
      error: r.error,
      sample_count: r.body && Array.isArray(r.body.data) ? r.body.data.length : null,
      body: r.body,
    })),
  };
  const probeJson = JSON.stringify(downloadPayload);

  const body = html`
    ${settingsSubNav('katana-probe', true, user?.email === 'wes.yoakum@c-lars.com')}

    <section class="card" style="margin-top:1rem">
      <div class="card-header">
        <h1>Katana probe</h1>
      </div>
      <p class="muted" style="margin-top:0">
        Phase 1 read-only diagnostic for the Katana integration. Confirms
        the API key works and surfaces a small sample of your existing
        Katana data so we can design the won-opportunity &rarr; sales-order
        push flow against real shapes.
      </p>

      <!-- =============== Connection status =============== -->
      <div style="margin-top:1rem;padding:.75rem 1rem;background:${overallOk ? '#e6f4ea' : '#fff8e1'};border-radius:4px;border:1px solid ${overallOk ? '#9bcfa6' : '#e0c97a'}">
        <div style="display:flex;align-items:center;gap:.5rem;flex-wrap:wrap">
          <strong>Status:</strong>
          ${overallOk
            ? html`<span style="color:#1a7f37">&check; Connected</span>`
            : html`<span style="color:#9a6700">&#9888; ${hasApiKey ? 'One or more probes failed' : 'Not connected'}</span>`}
          <span class="muted" style="font-size:.85em">base URL: <code>https://api.katanamrp.com/v1</code></span>
        </div>
        ${!hasApiKey ? html`
          <p class="muted" style="margin:.5rem 0 0 0;font-size:.85em">
            Set the API key (one-time, or after rotation in Katana &rarr; Settings &rarr; API):
            <br>
            <code style="background:rgba(0,0,0,0.05);padding:.1rem .3rem;border-radius:3px">echo &lt;key&gt; | npx wrangler pages secret put KATANA_API_KEY --project-name=c-lars-pms</code>
          </p>` : ''}
      </div>

      <!-- =============== Toolbar — download / expand all =============== -->
      <div style="margin-top:1rem;display:flex;gap:.5rem;flex-wrap:wrap;align-items:center">
        <button type="button" class="btn primary" id="katana-probe-download">Download as JSON</button>
        <button type="button" class="btn" id="katana-probe-expand-all">Expand all</button>
        <button type="button" class="btn" id="katana-probe-collapse-all">Collapse all</button>
        <span class="muted" style="font-size:.85em">The download bundles every response body (including any names/emails) — review before sharing.</span>
      </div>

      <!-- =============== Per-probe results =============== -->
      <div id="katana-probe-results" style="margin-top:1rem;display:flex;flex-direction:column;gap:.5rem">
        ${results.map((r) => html`
          <details class="katana-probe-row" style="border:1px solid var(--border);border-radius:4px;background:var(--bg-elev)">
            <summary style="padding:.5rem .75rem;cursor:pointer;display:flex;align-items:center;gap:.75rem;flex-wrap:wrap">
              <strong style="min-width:8rem">${escape(r.label)}</strong>
              <code style="font-size:.85em;color:var(--fg-muted)">GET ${escape(r.path)}</code>
              ${r.ok
                ? html`<span style="color:#1a7f37;font-size:.85em">&check; ${r.status}</span>`
                : html`<span style="color:#b3261e;font-size:.85em">&#10005; ${r.status || 'error'}</span>`}
              <span class="muted" style="font-size:.8em">${r.durationMs} ms</span>
              ${r.ok && r.body && Array.isArray(r.body.data) ? html`
                <span class="muted" style="font-size:.8em">${r.body.data.length} record${r.body.data.length === 1 ? '' : 's'}</span>
              ` : ''}
              ${r.error ? html`<span style="color:#b3261e;font-size:.8em">${escape(r.error)}</span>` : ''}
            </summary>
            <div style="padding:.5rem .75rem;border-top:1px solid var(--border)">
              <pre style="margin:0;max-height:24rem;overflow:auto;font-size:.78rem;line-height:1.4;background:var(--bg);padding:.5rem;border-radius:3px;white-space:pre-wrap;word-break:break-word">${escape(prettyJson(r.body, r.rawText))}</pre>
            </div>
          </details>
        `)}
      </div>

      <!-- =============== Next steps note =============== -->
      <div style="margin-top:1rem;padding:.75rem 1rem;background:var(--bg-elev);border-radius:4px;border:1px solid var(--border)">
        <strong>What this tells us:</strong>
        <ul style="margin:.25rem 0 0 1rem;padding:0;font-size:.9em">
          <li>If <em>Products</em> &amp; <em>Variants</em> are non-empty, Phase 3 (catalog sync into Pipeline) has real data to pull.</li>
          <li>If <em>Customers</em> is non-empty, Phase 2 should smart-match by name/email before creating new customers on push.</li>
          <li><em>Tax rates</em> and <em>Locations</em> are referenced from every sales order, so Phase 2 needs at least one of each (we'll pick a default).</li>
          <li><em>User info</em> confirms the API key's scope and tenant.</li>
        </ul>
      </div>
    </section>

    <script>
      (function () {
        window.__KATANA_PROBES__ = ${raw(probeJson)};

        // Download button — package the bundled probe payload as a
        // JSON file. Filename includes a timestamp so multiple downloads
        // don't collide.
        var downloadBtn = document.getElementById('katana-probe-download');
        if (downloadBtn) {
          downloadBtn.addEventListener('click', function () {
            var payload = window.__KATANA_PROBES__ || { error: 'no probe data' };
            var pretty  = JSON.stringify(payload, null, 2);
            var blob    = new Blob([pretty], { type: 'application/json' });
            var url     = URL.createObjectURL(blob);
            var stamp   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            var a       = document.createElement('a');
            a.href      = url;
            a.download  = 'katana-probe-' + stamp + '.json';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
          });
        }

        // Expand-all / Collapse-all — toggle every <details.katana-probe-row>.
        function setAllOpen(open) {
          var rows = document.querySelectorAll('details.katana-probe-row');
          for (var i = 0; i < rows.length; i++) rows[i].open = open;
        }
        var expandBtn   = document.getElementById('katana-probe-expand-all');
        var collapseBtn = document.getElementById('katana-probe-collapse-all');
        if (expandBtn)   expandBtn.addEventListener('click',   function () { setAllOpen(true); });
        if (collapseBtn) collapseBtn.addEventListener('click', function () { setAllOpen(false); });
      })();
    </script>
  `;

  return htmlResponse(layout('Katana probe', body, {
    user,
    env: data?.env,
    activeNav: '/settings',
    breadcrumbs: [{ label: 'Settings', href: '/settings' }, { label: 'Katana probe' }],
  }));
}

// Render a body for display. Prefer parsed JSON pretty-printed; fall
// back to the raw text if parsing failed.
function prettyJson(body, rawText) {
  try {
    if (body && typeof body === 'object') return JSON.stringify(body, null, 2);
  } catch (_) { /* fall through */ }
  return rawText || '(empty)';
}
