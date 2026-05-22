// functions/settings/katana-search-test/index.js
//
// GET  /settings/katana-search-test — admin-only test page for Katana product search
// POST /settings/katana-search-test — run a search and return results

import { apiGet, listRecords } from '../../lib/katana-client.js';
import { layout, htmlResponse, html, raw, escape } from '../../lib/layout.js';
import { hasRole } from '../../lib/auth.js';
import { formBody, readFlash } from '../../lib/http.js';
import { settingsSubNav } from '../../lib/settings-subnav.js';

export async function onRequestGet(context) {
  const { data, request } = context;
  const user = data?.user;
  if (!hasRole(user, 'admin')) {
    return htmlResponse(layout('Katana Search Test', '<section class="card"><p>Admin required.</p></section>', { user, env: data?.env, activeNav: '/settings' }), { status: 403 });
  }
  return renderPage(context, { q: '', results: null });
}

export async function onRequestPost(context) {
  const { env, data, request } = context;
  const user = data?.user;
  if (!hasRole(user, 'admin')) {
    return new Response('Forbidden', { status: 403 });
  }

  const input = await formBody(request);
  const q = (input.q || '').trim();
  if (!q) return renderPage(context, { q, results: null });

  const results = { products: null, variants: null, services: null, errors: [] };
  const start = Date.now();

  // Run all three searches in parallel
  const [prodRes, varRes, svcRes] = await Promise.allSettled([
    apiGet(env, '/products', { query: { name: q, limit: 15 } }),
    apiGet(env, '/variants', { query: { sku: [q], limit: 15 } }),
    apiGet(env, '/services', { query: { name: q, limit: 15 } }),
  ]);

  if (prodRes.status === 'fulfilled' && prodRes.value.ok) {
    results.products = {
      records: listRecords(prodRes.value.body),
      duration: prodRes.value.durationMs,
      raw: prodRes.value.body,
    };
  } else {
    results.errors.push('Products: ' + (prodRes.reason?.message || prodRes.value?.status || 'failed'));
  }

  if (varRes.status === 'fulfilled' && varRes.value.ok) {
    results.variants = {
      records: listRecords(varRes.value.body),
      duration: varRes.value.durationMs,
      raw: varRes.value.body,
    };
  } else {
    results.errors.push('Variants: ' + (varRes.reason?.message || varRes.value?.status || 'failed'));
  }

  if (svcRes.status === 'fulfilled' && svcRes.value.ok) {
    results.services = {
      records: listRecords(svcRes.value.body),
      duration: svcRes.value.durationMs,
      raw: svcRes.value.body,
    };
  } else {
    results.errors.push('Services: ' + (svcRes.reason?.message || svcRes.value?.status || 'failed'));
  }

  results.totalMs = Date.now() - start;

  return renderPage(context, { q, results });
}

function renderPage(context, { q, results }) {
  const { data } = context;
  const user = data?.user;
  const url = new URL(context.request.url);

  const body = html`
    ${settingsSubNav('katana-search-test', true, user?.email === 'wes.yoakum@c-lars.com')}

    <section class="card">
      <h1>Katana Search Test</h1>
      <p class="muted">
        Searches Katana products (by name), variants (by SKU), and services (by name) in parallel.
        This simulates what the typeahead would do.
      </p>

      <form method="post" style="display:flex;gap:0.5rem;align-items:center;margin:1rem 0">
        <input type="text" name="q" value="${escape(q)}" placeholder="Search products, SKUs, services..."
               style="flex:1;padding:0.4rem 0.6rem;font-size:1rem" autofocus>
        <button class="btn primary" type="submit">Search Katana</button>
      </form>

      ${results ? html`
        <p class="muted" style="margin-bottom:0.75rem">
          Total time: <strong>${results.totalMs}ms</strong>
          ${results.errors.length ? html` · <span style="color:#cf222e">${results.errors.length} error(s)</span>` : ''}
        </p>

        ${results.errors.map(e => html`<p style="color:#cf222e">${escape(e)}</p>`)}

        ${results.products ? html`
          <details open>
            <summary style="font-weight:600;cursor:pointer;margin-bottom:0.5rem">
              Products — ${results.products.records.length} results (${results.products.duration}ms)
            </summary>
            ${results.products.records.length === 0 ? html`<p class="muted">No products matched.</p>` : html`
              <table class="data" style="font-size:0.85rem;margin-bottom:1rem">
                <thead><tr><th>ID</th><th>Name</th><th>Category</th><th>UoM</th><th>Sellable</th><th>Variants</th></tr></thead>
                <tbody>
                  ${results.products.records.map(p => html`
                    <tr>
                      <td>${p.id}</td>
                      <td><strong>${escape(p.name || '')}</strong></td>
                      <td>${escape(p.category_name || '')}</td>
                      <td>${escape(p.uom || '')}</td>
                      <td>${p.is_sellable ? 'Yes' : 'No'}</td>
                      <td>${(p.variants || []).length}</td>
                    </tr>
                  `)}
                </tbody>
              </table>
              <details style="margin-bottom:1rem">
                <summary class="muted" style="cursor:pointer">Raw JSON</summary>
                <pre style="font-size:0.75rem;max-height:300px;overflow:auto;background:#f5f5f5;padding:0.5rem;border-radius:4px">${escape(JSON.stringify(results.products.raw, null, 2))}</pre>
              </details>
            `}
          </details>
        ` : ''}

        ${results.variants ? html`
          <details open>
            <summary style="font-weight:600;cursor:pointer;margin-bottom:0.5rem">
              Variants — ${results.variants.records.length} results (${results.variants.duration}ms)
            </summary>
            ${results.variants.records.length === 0 ? html`<p class="muted">No variants matched.</p>` : html`
              <table class="data" style="font-size:0.85rem;margin-bottom:1rem">
                <thead><tr><th>ID</th><th>SKU</th><th>Product ID</th><th>Sales Price</th><th>Purchase Price</th><th>Barcode</th></tr></thead>
                <tbody>
                  ${results.variants.records.map(v => html`
                    <tr>
                      <td>${v.id}</td>
                      <td><strong>${escape(v.sku || '')}</strong></td>
                      <td>${v.product_id || ''}</td>
                      <td>${v.sales_price != null ? '$' + Number(v.sales_price).toFixed(2) : ''}</td>
                      <td>${v.purchase_price != null ? '$' + Number(v.purchase_price).toFixed(2) : ''}</td>
                      <td>${escape(v.registered_barcode || v.internal_barcode || '')}</td>
                    </tr>
                  `)}
                </tbody>
              </table>
              <details style="margin-bottom:1rem">
                <summary class="muted" style="cursor:pointer">Raw JSON</summary>
                <pre style="font-size:0.75rem;max-height:300px;overflow:auto;background:#f5f5f5;padding:0.5rem;border-radius:4px">${escape(JSON.stringify(results.variants.raw, null, 2))}</pre>
              </details>
            `}
          </details>
        ` : ''}

        ${results.services ? html`
          <details open>
            <summary style="font-weight:600;cursor:pointer;margin-bottom:0.5rem">
              Services — ${results.services.records.length} results (${results.services.duration}ms)
            </summary>
            ${results.services.records.length === 0 ? html`<p class="muted">No services matched.</p>` : html`
              <table class="data" style="font-size:0.85rem;margin-bottom:1rem">
                <thead><tr><th>ID</th><th>Name</th><th>Category</th><th>UoM</th><th>Sellable</th></tr></thead>
                <tbody>
                  ${results.services.records.map(s => html`
                    <tr>
                      <td>${s.id}</td>
                      <td><strong>${escape(s.name || '')}</strong></td>
                      <td>${escape(s.category_name || '')}</td>
                      <td>${escape(s.uom || '')}</td>
                      <td>${s.is_sellable ? 'Yes' : 'No'}</td>
                    </tr>
                  `)}
                </tbody>
              </table>
              <details style="margin-bottom:1rem">
                <summary class="muted" style="cursor:pointer">Raw JSON</summary>
                <pre style="font-size:0.75rem;max-height:300px;overflow:auto;background:#f5f5f5;padding:0.5rem;border-radius:4px">${escape(JSON.stringify(results.services.raw, null, 2))}</pre>
              </details>
            `}
          </details>
        ` : ''}
      ` : ''}
    </section>
  `;

  return htmlResponse(
    layout('Katana Search Test', body, {
      user,
      env: data?.env,
      activeNav: '/settings',
      flash: readFlash(new URL(context.request.url)),
      breadcrumbs: [
        { label: 'Settings', href: '/settings' },
        { label: 'Katana Search Test' },
      ],
    })
  );
}
