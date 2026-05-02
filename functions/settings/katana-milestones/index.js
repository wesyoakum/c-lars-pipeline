// functions/settings/katana-milestones/index.js
//
// GET /settings/katana-milestones — admin-only milestone-map editor.
//
// Phase 2c. Pairs each EPS milestone (% + label) with the Katana
// variant_id it pushes against. The "Push to Katana" route on the
// quote detail page reads this map to compute the sales-order rows.
//
// Layout:
//   1. Status banner — saved? auto-discovered? unconfigured?
//   2. "Auto-discover from Katana" button — pulls Katana products
//      with category MILESTONE or SKU pattern MS-*, parses each SKU,
//      pre-fills the editor.
//   3. Editable table — reorder rows, edit percent + label per row,
//      pick variant from the Katana product list, see SKU + id.
//   4. Save button — validates (sum-to-100) and persists to
//      site_prefs.katana_milestone_map.

import { layout, htmlResponse, html, escape, raw } from '../../lib/layout.js';
import { hasRole } from '../../lib/auth.js';
import { settingsSubNav } from '../../lib/settings-subnav.js';
import { apiGetAll } from '../../lib/katana-client.js';
import { loadMilestoneMap, autoDiscoverFromProducts } from '../../lib/katana-milestones.js';

export async function onRequestGet(context) {
  const { env, data } = context;
  const user = data?.user;
  if (!user) return new Response('Sign in required', { status: 401 });
  if (!hasRole(user, 'admin')) {
    return htmlResponse(layout('Katana milestones',
      '<section class="card"><h1>Katana milestones</h1><p>Admin only.</p></section>',
      { user, env: data?.env }), { status: 403 });
  }

  // Pull saved map (may be null if never configured).
  const saved = await loadMilestoneMap(env);

  // Pull every Katana product so the picker can display every
  // candidate variant. We also derive the auto-discover suggestion
  // from this list.
  let products = [];
  let katanaError = null;
  try {
    products = await apiGetAll(env, '/products', {});
  } catch (err) {
    katanaError = String(err && err.message || err);
  }

  const autoDiscovered = autoDiscoverFromProducts(products);

  // Flatten products -> { id (variant id), label, sku, product_name }
  // for the picker dropdown. Variants without a SKU (e.g. Adam's
  // unfinished "TEST ITEM WELDMENT" config variants) are skipped.
  const variantOptions = [];
  for (const p of products) {
    const variants = Array.isArray(p.variants) ? p.variants : [];
    for (const v of variants) {
      if (!v.id || !v.sku) continue;
      variantOptions.push({
        id: v.id,
        sku: String(v.sku).trim(),
        product_name: String(p.name || '').trim(),
        // Sort key — milestone variants float to the top.
        is_milestone: String(p.category_name || '').toUpperCase() === 'MILESTONE'
                      || /^MS-/i.test(v.sku),
      });
    }
  }
  // Milestone variants first, then alphabetical by SKU.
  variantOptions.sort((a, b) => {
    if (a.is_milestone !== b.is_milestone) return a.is_milestone ? -1 : 1;
    return a.sku.localeCompare(b.sku);
  });

  const initial = saved
    ? saved.milestones
    : (autoDiscovered.length > 0 ? autoDiscovered : []);
  const status = saved ? 'saved' : (autoDiscovered.length > 0 ? 'discovered' : 'empty');

  const pageState = {
    initial,
    autoDiscovered,
    variantOptions,
    saved: !!saved,
  };
  const pageStateJson = JSON.stringify(pageState).replace(/</g, '\\u003c');

  const body = html`
    ${settingsSubNav('katana-milestones', true, user?.email === 'wes.yoakum@c-lars.com')}

    <section class="card" style="margin-top:1rem" x-data="katanaMilestones()" x-init="init()">
      <div class="card-header">
        <h1>Katana milestones</h1>
      </div>
      <p class="muted" style="margin-top:0">
        Map each EPS payment milestone to the Katana variant it bills
        against. The "Push to Katana" button on a won quote uses this
        map to build the sales-order rows. Percentages must sum to 100.
      </p>

      ${katanaError ? html`
        <div style="margin-top:1rem;padding:.75rem 1rem;background:#fdecea;border:1px solid #f5c2bf;border-radius:4px">
          <strong>Couldn't reach Katana:</strong> <code>${escape(katanaError)}</code>.
          You can edit / save the map locally but the variant picker is empty.
        </div>
      ` : ''}

      <div style="margin-top:1rem;padding:.75rem 1rem;background:var(--bg-elev);border:1px solid var(--border);border-radius:4px;display:flex;gap:1rem;flex-wrap:wrap;align-items:center">
        <strong>Status:</strong>
        ${status === 'saved'      ? html`<span style="color:#1a7f37">&check; Saved (${saved.milestones.length} milestones)</span>` : ''}
        ${status === 'discovered' ? html`<span style="color:#9a6700">&#9888; Auto-discovered from Katana SKUs (not yet saved)</span>` : ''}
        ${status === 'empty'      ? html`<span style="color:#9a6700">&#9888; Not configured</span>` : ''}
        <span class="muted" style="font-size:.85em">${variantOptions.length} variant${variantOptions.length === 1 ? '' : 's'} available in Katana</span>
        <span style="margin-left:auto">
          <button type="button" class="btn" @click="rediscover()" :disabled="busy">Auto-discover from Katana</button>
        </span>
      </div>

      <table class="meta-table" style="width:100%;margin-top:1rem;font-size:.9rem">
        <thead>
          <tr>
            <th style="text-align:right;width:6rem">%</th>
            <th style="text-align:left">Label (Pipeline-side)</th>
            <th style="text-align:left;width:34%">Katana variant</th>
            <th style="width:8rem">Order</th>
            <th style="width:3rem"></th>
          </tr>
        </thead>
        <tbody>
          <template x-for="(m, idx) in milestones" :key="idx">
            <tr>
              <td style="text-align:right">
                <input type="number" min="0.01" max="100" step="0.01"
                       x-model.number="m.percent"
                       style="width:5rem;text-align:right">
              </td>
              <td>
                <input type="text" x-model="m.label" placeholder="Order Confirmation"
                       style="width:100%">
              </td>
              <td>
                <select x-model.number="m.katana_variant_id"
                        @change="syncSku(m)"
                        style="width:100%;font-size:.85em">
                  <option value="">— pick a variant —</option>
                  <template x-for="v in variantOptions" :key="v.id">
                    <option :value="v.id" x-text="v.sku + ' — ' + v.product_name"></option>
                  </template>
                </select>
                <div class="muted" style="font-size:.75em;margin-top:.15rem" x-show="m.katana_sku">
                  SKU: <code x-text="m.katana_sku"></code>, id <code x-text="m.katana_variant_id"></code>
                </div>
              </td>
              <td style="text-align:center;white-space:nowrap">
                <button type="button" class="btn btn-xs" @click="moveUp(idx)"   :disabled="idx === 0" title="Move up">&uarr;</button>
                <button type="button" class="btn btn-xs" @click="moveDown(idx)" :disabled="idx === milestones.length - 1" title="Move down">&darr;</button>
              </td>
              <td style="text-align:center">
                <button type="button" class="btn btn-xs" @click="removeRow(idx)" title="Remove row">&times;</button>
              </td>
            </tr>
          </template>
          <tr>
            <td style="text-align:right">
              <strong x-text="totalPct + '%'"></strong>
            </td>
            <td class="muted" colspan="4" x-text="totalLabel"></td>
          </tr>
        </tbody>
      </table>

      <div style="margin-top:.75rem;display:flex;gap:.5rem;flex-wrap:wrap">
        <button type="button" class="btn"           @click="addRow()" :disabled="busy">+ Add milestone</button>
        <button type="button" class="btn primary"   @click="save()"   :disabled="busy || !isValid" x-text="saveLabel"></button>
        <button type="button" class="btn"           @click="reset()"  :disabled="busy">Reset to last saved</button>
      </div>
    </section>

    <script>${raw(MILESTONES_SCRIPT)}</script>
    <script>window.__KATANA_MILESTONES_STATE__ = ${raw(pageStateJson)};</script>
  `;

  return htmlResponse(layout('Katana milestones', body, {
    user,
    env: data?.env,
    activeNav: '/settings',
    breadcrumbs: [{ label: 'Settings', href: '/settings' }, { label: 'Katana milestones' }],
  }));
}

const MILESTONES_SCRIPT = `
document.addEventListener('alpine:init', function () {
  Alpine.data('katanaMilestones', function () {
    return {
      milestones: [],
      variantOptions: [],
      autoDiscovered: [],
      saved: false,
      busy: false,
      saveLabel: 'Save milestones',
      init: function () {
        var s = window.__KATANA_MILESTONES_STATE__ || {};
        this.milestones = (s.initial || []).map(function (m) {
          return {
            percent: m.percent != null ? Number(m.percent) : 0,
            label: m.label || '',
            katana_variant_id: m.katana_variant_id != null ? Number(m.katana_variant_id) : '',
            katana_sku: m.katana_sku || '',
          };
        });
        this.autoDiscovered = s.autoDiscovered || [];
        this.variantOptions = s.variantOptions || [];
        this.saved = !!s.saved;
      },
      get totalPct() {
        var sum = 0;
        this.milestones.forEach(function (m) {
          var n = Number(m.percent);
          if (Number.isFinite(n)) sum += n;
        });
        return Math.round(sum * 100) / 100;
      },
      get totalLabel() {
        var t = this.totalPct;
        if (Math.abs(t - 100) <= 0.01) return 'Total: 100% ✓';
        return 'Total: ' + t + '% (must equal 100)';
      },
      get isValid() {
        if (this.milestones.length === 0) return false;
        if (Math.abs(this.totalPct - 100) > 0.01) return false;
        for (var i = 0; i < this.milestones.length; i++) {
          var m = this.milestones[i];
          var p = Number(m.percent);
          if (!Number.isFinite(p) || p <= 0 || p > 100) return false;
          if (!m.label || !String(m.label).trim()) return false;
          var v = parseInt(m.katana_variant_id, 10);
          if (!Number.isFinite(v) || v <= 0) return false;
        }
        return true;
      },
      syncSku: function (m) {
        var v = this.variantOptions.find(function (vo) { return Number(vo.id) === Number(m.katana_variant_id); });
        m.katana_sku = v ? v.sku : '';
      },
      addRow: function () {
        this.milestones.push({ percent: 0, label: '', katana_variant_id: '', katana_sku: '' });
      },
      removeRow: function (idx) {
        this.milestones.splice(idx, 1);
      },
      moveUp: function (idx) {
        if (idx <= 0) return;
        var tmp = this.milestones[idx - 1];
        this.milestones[idx - 1] = this.milestones[idx];
        this.milestones[idx] = tmp;
      },
      moveDown: function (idx) {
        if (idx >= this.milestones.length - 1) return;
        var tmp = this.milestones[idx + 1];
        this.milestones[idx + 1] = this.milestones[idx];
        this.milestones[idx] = tmp;
      },
      rediscover: function () {
        if (this.autoDiscovered.length === 0) {
          alert('No milestone-pattern SKUs found in Katana. Manually pick variants below.');
          return;
        }
        if (this.milestones.length > 0 && !confirm('Replace the current ' + this.milestones.length + ' milestones with auto-discovered defaults from Katana?')) return;
        this.milestones = this.autoDiscovered.map(function (m) {
          return {
            percent: Number(m.percent),
            label: m.label,
            katana_variant_id: Number(m.katana_variant_id),
            katana_sku: m.katana_sku,
          };
        });
      },
      reset: function () {
        if (!confirm('Discard unsaved changes and reload from server?')) return;
        window.location.reload();
      },
      save: function () {
        var self = this;
        if (!self.isValid) return;
        self.busy = true;
        self.saveLabel = 'Saving…';
        fetch('/settings/katana-milestones/save', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            milestones: self.milestones.map(function (m) {
              return {
                percent: Number(m.percent),
                label: String(m.label).trim(),
                katana_variant_id: parseInt(m.katana_variant_id, 10),
                katana_sku: String(m.katana_sku || '').trim(),
              };
            }),
          }),
        }).then(function (r) {
          if (!r.ok) return r.json().then(function (d) { throw new Error(d && d.error || ('HTTP ' + r.status)); });
          return r.json();
        }).then(function () {
          self.saveLabel = 'Saved ✓';
          self.busy = false;
          self.saved = true;
          setTimeout(function () { self.saveLabel = 'Save milestones'; }, 1500);
        }).catch(function (err) {
          self.busy = false;
          self.saveLabel = 'Save milestones';
          alert('Could not save: ' + (err && err.message ? err.message : 'unknown error'));
        });
      },
    };
  });
});
`;
