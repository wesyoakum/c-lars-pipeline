// functions/opportunities/[id]/quotes/[quoteId]/lines/[lineId]/price-build/index.js
//
// GET  — show price build editor (or create prompt if none exists)
// POST — create or save the price build for this line item
//
// Each quote line item has at most one price build (1:1). The build is
// stored in cost_builds with quote_line_id set. The pricing engine is
// identical to the old opp-level price builds.

import { one, all, stmt, batch } from '../../../../../../../lib/db.js';
import { auditStmt } from '../../../../../../../lib/audit.js';
import { validateCostBuild, validateWorkcenterEntries, normalizePriceBuildKind } from '../../../../../../../lib/validators.js';
import { layout, htmlResponse, html, escape, raw } from '../../../../../../../lib/layout.js';
import { uuid, now } from '../../../../../../../lib/ids.js';
import { redirectWithFlash, formBody, readFlash } from '../../../../../../../lib/http.js';
import {
  loadPricingSettings,
  loadCostBuildBundle,
  computeFromBundle,
  kindConfig,
  computeLineExtendedPrice,
  quoteTotalsRecomputeStmt,
  fmtDollar,
  fmtPct,
} from '../../../../../../../lib/pricing.js';

// ── Context loader ──────────────────────────────────────────────
async function loadContext(env, params) {
  const { id: oppId, quoteId, lineId } = params;
  const line = await one(
    env.DB,
    `SELECT ql.*, q.opportunity_id, q.number AS quote_number, q.revision,
            q.quote_type AS quote_type,
            q.show_discounts AS quote_show_discounts,
            o.number AS opp_number, o.title AS opp_title
       FROM quote_lines ql
       JOIN quotes q ON q.id = ql.quote_id
       JOIN opportunities o ON o.id = q.opportunity_id
      WHERE ql.id = ? AND ql.deleted_at IS NULL AND q.id = ? AND o.id = ?`,
    [lineId, quoteId, oppId]
  );
  if (!line) return null;

  const build = await one(
    env.DB,
    'SELECT * FROM cost_builds WHERE quote_line_id = ?',
    [lineId]
  );

  return { line, build, oppId, quoteId, lineId };
}

function baseUrl(oppId, quoteId, lineId) {
  return `/opportunities/${oppId}/quotes/${quoteId}/lines/${lineId}/price-build`;
}

function quoteUrl(oppId, quoteId) {
  return `/opportunities/${oppId}/quotes/${quoteId}`;
}

// ── GET ─────────────────────────────────────────────────────────
export async function onRequestGet(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const url = new URL(request.url);
  const ctx = await loadContext(env, params);
  if (!ctx) return new Response('Line item not found', { status: 404 });

  if (!ctx.build) {
    return renderCreatePrompt(context, ctx);
  }
  return renderEditor(context, ctx, {});
}

// ── Render "Create price build" page ────────────────────────────
async function renderCreatePrompt(context, ctx) {
  const { env, data, request } = context;
  const user = data?.user;
  const url = new URL(request.url);
  const { line, oppId, quoteId, lineId } = ctx;

  // Load builds library templates for the "clone from template" option
  const templates = await all(
    env.DB,
    `SELECT id, name, description FROM builds_library WHERE active = 1 ORDER BY name`
  );

  const body = html`
    <section class="card">
      <div class="card-header">
        <div>
          <h1>Price Build</h1>
          <p class="muted">
            Line item: <strong>${escape(line.description)}</strong>
            · Quote <a href="${quoteUrl(oppId, quoteId)}">${escape(line.quote_number)} Rev ${escape(line.revision)}</a>
            · <a href="/opportunities/${escape(oppId)}">${escape(line.opp_number)}</a>
          </p>
        </div>
        <div class="header-actions">
          <a class="btn" href="${quoteUrl(oppId, quoteId)}">Back to quote</a>
        </div>
      </div>
    </section>

    <section class="card">
      <h2>No price build yet</h2>
      <p class="muted">Create a price build to define the cost structure for this line item.</p>

      <form method="post" action="${baseUrl(oppId, quoteId, lineId)}" class="stack-form">
        <input type="hidden" name="_action" value="create">
        <label>
          Label
          <input type="text" name="label" value="${escape(line.description)}" placeholder="Price build label">
        </label>
        ${templates.length > 0 ? html`
          <label>
            Clone from template (optional)
            <select name="builds_library_id">
              <option value="">— blank build —</option>
              ${templates.map((t) => html`
                <option value="${escape(t.id)}">${escape(t.name)}${t.description ? html` — ${escape(t.description)}` : ''}</option>
              `)}
            </select>
          </label>
        ` : ''}
        <div class="form-actions">
          <button class="btn primary" type="submit">Create price build</button>
          <a class="btn" href="${quoteUrl(oppId, quoteId)}">Cancel</a>
        </div>
      </form>
    </section>
  `;

  return htmlResponse(
    layout(`Price build — ${line.description}`, body, {
      user,
      env: data?.env,
      activeNav: '/opportunities',
      flash: readFlash(url),
      breadcrumbs: [
        { label: 'Opportunities', href: '/opportunities' },
        { label: ctx.line.opp_number, href: `/opportunities/${oppId}` },
        { label: `${ctx.line.quote_number} ${ctx.line.revision}`, href: quoteUrl(oppId, quoteId) },
        { label: `Price build — ${line.description || line.title || 'Line'}` },
      ],
    })
  );
}

// ── Render full editor ──────────────────────────────────────────
async function renderEditor(context, ctx, { values = null, errors = {} } = {}) {
  const { env, data, request, params } = context;
  const user = data?.user;
  // Per-quote display toggle (migration 0027) — hides the build
  // discount editor when the parent quote has show_discounts off.
  const showDiscounts =
    ctx.line.quote_show_discounts === 1 || ctx.line.quote_show_discounts === true;
  const url = new URL(request.url);
  const { line, oppId, quoteId, lineId } = ctx;
  const buildId = ctx.build.id;

  const bundle = await loadCostBuildBundle(env.DB, buildId);
  if (!bundle) return new Response('Price build not found', { status: 404 });

  // Documents linked to this price build
  const docs = await all(
    env.DB,
    `SELECT d.id, d.title, d.kind, d.mime_type, d.size_bytes, d.original_filename,
            d.uploaded_at, u.display_name AS uploaded_by_name, u.email AS uploaded_by_email
       FROM documents d
       LEFT JOIN users u ON u.id = d.uploaded_by_user_id
      WHERE d.cost_build_id = ?
        AND d.superseded_at IS NULL
      ORDER BY d.uploaded_at DESC`,
    [buildId]
  );

  const settings = await loadPricingSettings(env.DB);
  const { pricing, totals } = computeFromBundle(bundle, settings);

  const build = values || bundle.build;
  const locked = bundle.build.status === 'locked';
  const kc = kindConfig(normalizePriceBuildKind(bundle.build.build_kind));

  const errText = (k) => (errors[k] ? html`<small class="error">${errors[k]}</small>` : '');
  const base = baseUrl(oppId, quoteId, lineId);

  const pricingTabBody = renderPricingSubtab({ build, pricing, totals, settings, errText, locked, showDiscounts, kc });

  const lineDesc = line.description || line.title || 'Line';
  const lineUrl = `/opportunities/${oppId}/quotes/${quoteId}/lines/${lineId}`;
  const header = html`
    <section class="card">
      <div class="card-header">
        <div>
          <h1 x-data="lineTitle(${escape(JSON.stringify(lineDesc))})">
            <span x-show="!editing" @click="editing = true" style="cursor:pointer;border-bottom:1px dashed var(--border)" x-text="val">${escape(lineDesc)}</span>
            <input x-show="editing" x-cloak type="text" :value="val"
                   @blur="save($event.target.value)" @keydown.enter="save($event.target.value)"
                   @keydown.escape="editing = false"
                   x-ref="inp" style="width:100%;font:inherit;padding:0.15rem 0.3rem"
                   x-effect="if(editing) $nextTick(() => $refs.inp?.focus())">
            ${locked ? html`<span class="pill pill-locked" style="margin-left:0.5rem">locked</span>` : ''}
          </h1>
          <p class="muted">
            Quote <a href="${quoteUrl(oppId, quoteId)}">${escape(line.quote_number)} Rev ${escape(line.revision)}</a>
            · <a href="/opportunities/${escape(oppId)}">${escape(line.opp_number)}</a>
          </p>
          <div class="muted" style="font-size:.8rem;margin-top:.3rem">Standard pricing — 28.5% target margin</div>
        </div>
        <div class="header-actions">
          ${locked
            ? html`
              <form method="post" action="${base}/unlock"
                    onsubmit="return confirm('Unlock this price build for editing?')">
                <button class="btn" type="submit">Unlock</button>
              </form>`
            : html`
              <form method="post" action="${base}/lock"
                    onsubmit="return confirm('Lock this price build? It will become view-only.')">
                <button class="btn" type="submit">Lock</button>
              </form>
              <form method="post" action="${base}/delete"
                    onsubmit="return confirm('Delete this price build? This cannot be undone.')">
                <button class="btn danger" type="submit">Delete</button>
              </form>`}
          <a class="btn" href="${quoteUrl(oppId, quoteId)}">Back to quote</a>
        </div>
      </div>
    </section>
    <script>
    document.addEventListener('alpine:init', function() {
      Alpine.data('lineTitle', function(initial) {
        return {
          val: initial, editing: false,
          save: function(v) {
            this.editing = false;
            if (v === this.val) return;
            this.val = v;
            var fd = new FormData();
            fd.append('description', v);
            fetch('${lineUrl}', { method: 'POST', headers: { 'Accept': 'application/json' }, body: fd });
          },
        };
      });
    });
    </script>
  `;

  // Document upload + list for reference files
  const docsSection = html`
    <section class="card">
      <div class="card-header">
        <h2>Reference documents</h2>
      </div>

      <div x-data="dropUpload()" style="margin-bottom:0.75rem;">
        <form method="post" action="/documents" enctype="multipart/form-data" x-ref="uploadForm">
          <input type="hidden" name="opportunity_id" value="${escape(oppId)}">
          <input type="hidden" name="cost_build_id" value="${escape(buildId)}">
          <input type="hidden" name="kind" value="supplier_quote">
          <input type="hidden" name="return_to" value="${base}">
          <div class="drop-zone" :class="{ 'drop-zone-active': dragging }"
               @dragover.prevent="dragging = true"
               @dragleave.prevent="dragging = false"
               @drop.prevent="handleDrop($event)"
               @click="$refs.fileInput.click()">
            <input type="file" name="file" required x-ref="fileInput" hidden @change="fileSelected($event)">
            <div class="drop-zone-content">
              <span x-show="!fileName" class="muted">Drop vendor quote, spreadsheet, email, etc. or click to browse</span>
              <span x-show="fileName" x-text="fileName" x-cloak></span>
            </div>
          </div>
          <div x-show="fileName" x-cloak style="margin-top:0.4rem;display:flex;gap:0.5rem;align-items:center">
            <select name="kind" style="padding:0.3rem 0.5rem;border:1px solid var(--border);border-radius:var(--radius);font:inherit;background:var(--bg)">
              <option value="supplier_quote">Vendor quote</option>
              <option value="specification">Spreadsheet / spec</option>
              <option value="image">Image / photo</option>
              <option value="other">Email / other</option>
            </select>
            <button class="btn primary small" type="submit">Upload</button>
            <button class="btn small" type="button" @click="clear()">Cancel</button>
          </div>
        </form>
      </div>

      ${docs.length > 0 ? html`
        <table class="data compact">
          <thead>
            <tr>
              <th>Document</th>
              <th>Type</th>
              <th>Size</th>
              <th>Uploaded</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${docs.map(d => html`
              <tr>
                <td><a href="/documents/${escape(d.id)}/download">${escape(d.title || d.original_filename)}</a></td>
                <td><span class="pill" style="font-size:0.8em">${escape(d.kind)}</span></td>
                <td class="muted">${formatSize(d.size_bytes)}</td>
                <td class="muted"><small>${escape((d.uploaded_at || '').slice(0, 16).replace('T', ' '))}</small></td>
                <td class="row-actions">
                  <form method="post" action="/documents/${escape(d.id)}/delete" style="display:inline"
                        onsubmit="return confirm('Delete this document?')">
                    <input type="hidden" name="return_to" value="${base}">
                    <button class="btn small danger" type="submit">\u00d7</button>
                  </form>
                </td>
              </tr>
            `)}
          </tbody>
        </table>
      ` : html`<p class="muted">No reference documents uploaded yet.</p>`}
    </section>
  `;

  const body = html`
    ${header}
    <div class="cost-build-form" id="cb-form" data-patch-url="${base}/patch">
      ${pricingTabBody}

      <div class="field" style="width:100%;margin-top:1rem">
        <label>Notes</label>
        <textarea name="notes" ${locked ? 'disabled' : ''} style="width:100%; field-sizing:content; min-height:2.5rem; resize:none; padding:0.4rem 0.55rem; border:1px solid var(--border); border-radius:var(--radius); font:inherit; background:var(--bg);">${escape(build.notes ?? '')}</textarea>
      </div>

      ${locked
        ? html`<p class="muted">This price build is locked. Unlock it to make changes.</p>`
        : html`<div style="display:flex;align-items:center;gap:0.5rem;margin-top:0.5rem">
            <span id="cb-save-status" class="muted" style="font-size:0.8rem"></span>
          </div>`}
    </div>
    ${docsSection}
    <div style="margin-top:1rem;text-align:center">
      <a class="btn" href="${quoteUrl(oppId, quoteId)}">Back to quote</a>
    </div>
    <script>
    function dropUpload() {
      return {
        dragging: false,
        fileName: '',
        handleDrop: function(e) {
          this.dragging = false;
          var files = e.dataTransfer && e.dataTransfer.files;
          if (files && files.length) {
            this.$refs.fileInput.files = files;
            this.fileName = files[0].name;
          }
        },
        fileSelected: function(e) {
          var f = e.target.files && e.target.files[0];
          this.fileName = f ? f.name : '';
        },
        clear: function() {
          this.$refs.fileInput.value = '';
          this.fileName = '';
        },
      };
    }

    /* ── Pricing engine auto-save ──────────────────────────── */
    (function() {
      var form = document.getElementById('cb-form');
      if (!form) return;
      var patchUrl = form.dataset.patchUrl;
      if (!patchUrl) return;
      var statusEl = document.getElementById('cb-save-status');
      var timer = null;
      var saving = false;

      function fmtDollar(n) {
        if (n === null || n === undefined || isNaN(n)) return '\u2014';
        return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
      }
      // Format a 0-1 ratio as a percentage. Mirrors the server-side
      // helper in lib/pricing.js \u2014 earlier we omitted the *100 here,
      // so the GM card displayed "$121,097 (0.3%)" for a real margin
      // of 28.5%. The threshold-status hint ("Good (> 0.3%)") used the
      // same broken helper. All callers in this file pass ratios.
      function fmtPct(n, d) {
        if (n === null || n === undefined || isNaN(n)) return '\u2014';
        return (Number(n) * 100).toFixed(d !== undefined ? d : 1) + '%';
      }

      function parseDollar(s) {
        if (s === undefined || s === null || s === '') return 0;
        var n = Number(String(s).replace(/[$,\s]/g, ''));
        return isFinite(n) ? n : 0;
      }

      // Instant client-side recalc — runs on every keystroke before the
      // server save roundtrip so the user sees numbers update immediately.
      function recalcLocal() {
        var dm = parseDollar(form.querySelector('input[name="dm_user_cost"]')?.value);
        var dl = parseDollar(form.querySelector('input[name="dl_user_cost"]')?.value);
        var other = parseDollar(form.querySelector('input[name="other_user_cost"]')?.value);
        var directCosts = dm + dl + other;
        var targetPrice = directCosts > 0 ? directCosts / 0.55 : 0;
        var imoh = targetPrice * 0.165;
        var totalCost = directCosts + imoh;

        // Price override
        var overrideEl = form.querySelector('input[name="quote_price_user"]');
        var overrideRaw = overrideEl ? overrideEl.value.trim() : '';
        var overridePrice = parseDollar(overrideRaw);
        var useOverride = overrideRaw !== '' && overridePrice > 0;
        var effectivePrice = useOverride ? overridePrice : targetPrice;

        // When using override, IMOH is still based on target price (costs don't change)
        var margin = effectivePrice > 0 ? effectivePrice - totalCost : 0;
        var marginPct = effectivePrice > 0 ? margin / effectivePrice : 0;

        var tcEl = document.getElementById('cb-total-cost');
        if (tcEl) tcEl.textContent = fmtDollar(totalCost);

        var tpEl = document.getElementById('cb-target-price');
        if (tpEl) tpEl.textContent = fmtDollar(targetPrice);

        var hiEl = document.getElementById('cb-hidden-imoh');
        if (hiEl) hiEl.value = fmtDollar(imoh);

        var mvEl = document.getElementById('cb-margin-value');
        if (mvEl) {
          if (effectivePrice > 0) {
            mvEl.innerHTML = fmtDollar(margin) + ' (' + fmtPct(marginPct) + ')';
          } else {
            mvEl.textContent = '\u2014';
          }
        }
        var msEl = document.getElementById('cb-margin-status');
        if (msEl) {
          if (effectivePrice > 0) {
            msEl.textContent = marginPct > 0.284 ? 'Target: 28.5%' : 'Below 28.5% target';
          } else {
            msEl.textContent = '';
          }
        }
        var mbEl = document.getElementById('cb-margin-box');
        if (mbEl) {
          mbEl.classList.remove('margin-good', 'margin-low');
          if (effectivePrice > 0) {
            mbEl.classList.add(marginPct > 0.284 ? 'margin-good' : 'margin-low');
          }
        }
      }

      function collectPayload() {
        var data = {};
        var notesEl = form.querySelector('textarea[name="notes"]');
        if (notesEl) data.notes = notesEl.value;

        // Cost inputs + price override
        ['dm_user_cost', 'dl_user_cost', 'other_user_cost', 'quote_price_user'].forEach(function(name) {
          var el = form.querySelector('input[name="' + name + '"]');
          if (el) data[name] = el.value;
        });

        // Discount fields
        ['discount_amount', 'discount_pct', 'discount_description'].forEach(function(name) {
          var el = form.querySelector('input[name="' + name + '"]');
          if (el) data[name] = el.value;
        });
        var phantomEl = form.querySelector('input[name="discount_is_phantom"]');
        if (phantomEl) data.discount_is_phantom = phantomEl.checked ? '1' : '';

        return data;
      }

      function applyResponse(res) {
        // After a server save, just run recalcLocal() to update all
        // display values from the current input state. This avoids
        // the server response overwriting client-side recalc with
        // stale or differently-computed values.
        recalcLocal();

      function setStatus(text, type) {
        if (!statusEl) return;
        statusEl.textContent = text;
        statusEl.style.color = type === 'error' ? 'var(--danger)' : type === 'ok' ? 'var(--success)' : 'var(--fg-muted)';
      }

      function doSave() {
        if (saving) { timer = setTimeout(doSave, 300); return; }
        saving = true;
        setStatus('Saving\u2026', 'muted');
        var payload = collectPayload();
        fetch(patchUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        })
          .then(function(r) { return r.json(); })
          .then(function(res) {
            saving = false;
            if (res.ok) {
              setStatus('Saved', 'ok');
              applyResponse(res);
            } else {
              setStatus(res.error || 'Save failed', 'error');
            }
          })
          .catch(function(e) {
            saving = false;
            setStatus('Network error', 'error');
          });
      }

      function scheduleAutoSave() {
        if (timer) clearTimeout(timer);
        timer = setTimeout(doSave, 500);
      }

      // Listen for changes on all inputs, selects, textareas, and checkboxes.
      // The price override field only saves on blur/Enter (not keystroke) to
      // avoid saving intermediate values while the user is still typing.
      form.addEventListener('input', function(e) {
        if (e.target.matches('input:not([type="file"]):not([type="hidden"]), textarea')) {
          recalcLocal();
          if (e.target.name !== 'quote_price_user') {
            scheduleAutoSave();
          }
        }
      });
      form.addEventListener('change', function(e) {
        if (e.target.matches('input, select, textarea')) {
          recalcLocal();
          scheduleAutoSave();
        }
      });
    })();
    </script>
  `;

  return htmlResponse(
    layout(`Price build — ${line.description}`, body, {
      user,
      env: data?.env,
      activeNav: '/opportunities',
      flash: readFlash(url),
      breadcrumbs: [
        { label: 'Opportunities', href: '/opportunities' },
        { label: ctx.line.opp_number, href: `/opportunities/${oppId}` },
        { label: `${ctx.line.quote_number} ${ctx.line.revision}`, href: quoteUrl(oppId, quoteId) },
        { label: `Price build — ${line.description || line.title || 'Line'}` },
      ],
    })
  );
}

// ── Sub-tab renderers (same as old price build editor) ───────────

// T3.2 Phase 3 — build-level discount editor. Renders a collapsible
// section under the Pricing cost-summary table. When the build carries
// a discount it flows through to the linked quote_line on save (see
// patch.js / handleSave in this file).
function renderBuildDiscountEditor({ build, locked, errText }) {
  const hasDiscount =
    (build.discount_amount !== null && build.discount_amount !== undefined && build.discount_amount !== '' && Number(build.discount_amount) > 0) ||
    (build.discount_pct    !== null && build.discount_pct    !== undefined && build.discount_pct    !== '' && Number(build.discount_pct)    > 0) ||
    !!build.discount_is_phantom ||
    (build.discount_description !== null && build.discount_description !== undefined && build.discount_description !== '');
  const amtVal = build.discount_amount == null || build.discount_amount === '' ? '' : String(build.discount_amount);
  const pctVal = build.discount_pct    == null || build.discount_pct    === '' ? '' : String(build.discount_pct);
  const descVal = build.discount_description == null ? '' : String(build.discount_description);
  const phantomChecked = !!build.discount_is_phantom;

  return html`
    <div class="build-discount" x-data="buildDiscount(${hasDiscount ? 'true' : 'false'})" style="margin-top:1rem">
      <div x-show="!open" x-cloak>
        <a href="#" @click.prevent="open = true" class="muted" style="font-size:0.85rem; text-decoration:underline dotted; cursor:pointer">
          + Add build discount
        </a>
      </div>
      <div x-show="open" x-cloak style="border:1px solid var(--border); border-radius:var(--radius); padding:0.6rem 0.75rem; background:var(--bg-subtle, transparent)">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.5rem">
          <strong style="font-size:0.85rem">Build discount</strong>
          <a href="#" @click.prevent="open = false" class="muted" style="font-size:0.75rem" x-show="!${hasDiscount ? 'true' : 'false'}">collapse</a>
        </div>
        <p class="muted" style="font-size:0.75rem; margin:0 0 0.5rem 0">
          Applies to the linked quote line when this build saves. Amount wins over percent. Phantom discounts don't reduce the stored extended price — they mark up at render time on the PDF.
        </p>
        <div style="display:grid; grid-template-columns: 1fr 1fr; gap:0.5rem">
          <label style="font-size:0.8rem">
            Discount amount ($)
            <input type="text" name="discount_amount" value="${escape(amtVal)}"
                   class="num-input"
                   ${locked ? 'disabled' : ''}
                   placeholder="$0">
            ${errText('discount_amount')}
          </label>
          <label style="font-size:0.8rem">
            Discount percent (%)
            <input type="text" name="discount_pct" value="${escape(pctVal)}"
                   class="num-input"
                   ${locked ? 'disabled' : ''}
                   placeholder="0">
            ${errText('discount_pct')}
          </label>
        </div>
        <label style="display:block; margin-top:0.4rem; font-size:0.8rem">
          Description (optional)
          <input type="text" name="discount_description" value="${escape(descVal)}"
                 ${locked ? 'disabled' : ''}
                 placeholder="Shown on the PDF as the discount line label"
                 style="width:100%; padding:0.3rem 0.4rem; border:1px solid var(--border); border-radius:var(--radius); font:inherit; background:var(--bg)">
        </label>
        <label class="checkbox" style="display:flex; align-items:center; gap:0.4rem; margin-top:0.4rem; font-size:0.8rem">
          <input type="checkbox" name="discount_is_phantom" value="1" ${phantomChecked ? 'checked' : ''} ${locked ? 'disabled' : ''}>
          Phantom (display only — markup to list price at render time)
        </label>
      </div>
    </div>
    <script>
    document.addEventListener('alpine:init', function() {
      Alpine.data('buildDiscount', function(initialOpen) {
        return { open: !!initialOpen };
      });
    });
    </script>
  `;
}

function renderPricingSubtab({ build, pricing, totals, settings, errText, locked, showDiscounts, kc }) {
  const eff = pricing.effective;
  const marg = pricing.margin;

  const fmtInput = (n) => {
    if (n === null || n === undefined || n === '') return '';
    const num = Number(n);
    if (Number.isNaN(num)) return String(n);
    return '$' + num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  // Target price is always (DM + DL + Other) / 0.55, independent of override
  const directCosts = (Number(build.dm_user_cost) || 0) + (Number(build.dl_user_cost) || 0) + (Number(build.other_user_cost) || 0);
  const formulaTargetPrice = directCosts > 0 ? directCosts / 0.55 : null;
  const formulaImoh = formulaTargetPrice ? formulaTargetPrice * 0.165 : null;
  const formulaTotalCost = formulaTargetPrice ? directCosts + formulaImoh : null;
  // Margin uses override price if set, otherwise target
  const effectivePrice = (build.quote_price_user != null && build.quote_price_user !== '' && Number(build.quote_price_user) > 0)
    ? Number(build.quote_price_user) : formulaTargetPrice;
  const marginAmt = effectivePrice && formulaTotalCost ? effectivePrice - formulaTotalCost : null;
  const marginPct = effectivePrice && marginAmt !== null ? marginAmt / effectivePrice : null;
  const marginStatus = marginPct !== null ? (marginPct > 0.284 ? 'good' : 'low') : null;

  return html`
    <section class="card">
      <h2 class="section-h">Costs</h2>

      <table class="data compact cost-summary-table">
        <thead>
          <tr><th></th><th class="num" style="width:10rem">Amount</th></tr>
        </thead>
        <tbody>
          <tr>
            <td><strong>Direct Material (DM)</strong></td>
            <td class="num">
              <input type="text" name="dm_user_cost"
                     value="${build.dm_user_cost != null && build.dm_user_cost !== '' ? fmtInput(build.dm_user_cost) : ''}"
                     class="num-input" ${locked ? 'disabled' : ''} placeholder="$0">
              ${errText('dm_user_cost')}
            </td>
          </tr>
          <tr>
            <td><strong>Direct Labor (DL)</strong></td>
            <td class="num">
              <input type="text" name="dl_user_cost"
                     value="${build.dl_user_cost != null && build.dl_user_cost !== '' ? fmtInput(build.dl_user_cost) : ''}"
                     class="num-input" ${locked ? 'disabled' : ''} placeholder="$0">
              ${errText('dl_user_cost')}
            </td>
          </tr>
          <tr>
            <td><strong>Other</strong></td>
            <td class="num">
              <input type="text" name="other_user_cost"
                     value="${build.other_user_cost != null && build.other_user_cost !== '' ? fmtInput(build.other_user_cost) : ''}"
                     class="num-input" ${locked ? 'disabled' : ''} placeholder="$0">
              ${errText('other_user_cost')}
            </td>
          </tr>
          <tr style="color:var(--fg-muted)">
            <td>IMOH (16.5%)</td>
            <td class="num">
              <input type="text" id="cb-hidden-imoh"
                     value="${fmtInput(formulaImoh)}"
                     class="num-input" disabled
                     style="background:var(--bg-alt);color:var(--fg-muted)">
            </td>
          </tr>
        </tbody>
        <tfoot>
          <tr>
            <th>Total Cost</th>
            <th class="num" id="cb-total-cost">${fmtDollar(formulaTotalCost)}</th>
          </tr>
        </tfoot>
      </table>

      <div class="pricing-grid" style="margin-top:1rem;display:grid;grid-template-columns:1fr 1fr 1fr;gap:0.75rem">
        <div class="pricing-box">
          <div class="muted">Target Price</div>
          <div class="pricing-value" id="cb-target-price">${fmtDollar(formulaTargetPrice)}</div>
          <div class="muted" style="font-size:0.7rem">= (DM + DL + Other) / 0.55</div>
        </div>
        <div class="pricing-box">
          <div class="muted">Your Price</div>
          <input type="text" name="quote_price_user"
                 value="${build.quote_price_user != null && build.quote_price_user !== '' ? fmtInput(build.quote_price_user) : ''}"
                 class="num-input pricing-input" id="cb-price-override"
                 ${locked ? 'disabled' : ''} placeholder="Use target"
                 style="font-size:1.1rem;text-align:center;margin-top:0.2rem">
          <div class="muted" style="font-size:0.7rem">Leave blank to use target</div>
        </div>
        <div class="pricing-box ${marginStatus === 'good' ? 'margin-good' : marginStatus === 'low' ? 'margin-low' : ''}" id="cb-margin-box">
          <div class="muted">Gross Margin</div>
          <div class="pricing-value" id="cb-margin-value">
            ${marginAmt !== null
              ? html`${fmtDollar(marginAmt)} (${fmtPct(marginPct)})`
              : '\u2014'}
          </div>
          <div class="muted" id="cb-margin-status" style="font-size:0.75rem">
            ${marginStatus ? (marginStatus === 'good' ? 'Target: 28.5%' : `Below 28.5% target`) : ''}
          </div>
        </div>
      </div>

      ${showDiscounts ? renderBuildDiscountEditor({ build, locked, errText }) : ''}
    </section>
  `;
}

function renderLaborSubtab({
  workcenters, settings, currentLaborByWc, currentLaborTotal,
  allLaborItems, laborSelectedIds, allLaborEntriesById, laborLibTotal,
  useLaborLibrary, laborCalcTotal, errText, locked,
}) {
  const wcRows = workcenters.map((wc) => {
    const entry = currentLaborByWc.get(wc);
    const hours = entry?.hours ?? '';
    const rate = (entry?.rate === null || entry?.rate === undefined) ? '' : entry.rate;
    const cost = entry ? workcenterEntryCost(entry.hours, entry.rate, settings) : 0;
    return html`
      <tr data-labor-wc="${escape(wc)}">
        <td>${escape(wc)}</td>
        <td class="num">
          <input type="text" name="current_hours[${escape(wc)}]" value="${hours}" class="num-input" ${locked ? 'disabled' : ''} placeholder="0">
          ${errText(`hours_${wc}`)}
        </td>
        <td class="num">
          <input type="text" name="current_rate[${escape(wc)}]" value="${rate}" class="num-input" ${locked ? 'disabled' : ''} placeholder="${settings.defaultLaborRate}">
          ${errText(`rate_${wc}`)}
        </td>
        <td class="num" data-labor-cost>${cost ? fmtDollar(cost) : '\u2014'}</td>
      </tr>`;
  });

  return html`
    <section class="card">
      <h2 class="section-h">Labor cost</h2>
      <p class="muted">
        Enter Current Project hours per workcenter. Blank rate uses the
        default ${fmtDollar(settings.defaultLaborRate)}/hr. You can also
        pull in shared labor packages from the library below.
      </p>

      <h3>Current project</h3>
      <table class="data compact">
        <thead><tr><th>Workcenter</th><th class="num">Hours</th><th class="num">Rate</th><th class="num">Cost</th></tr></thead>
        <tbody>${wcRows}</tbody>
        <tfoot><tr><th colspan="3">Current project total</th><th class="num" id="cb-labor-total">${fmtDollar(currentLaborTotal)}</th></tr></tfoot>
      </table>

      <h3 style="margin-top:1rem">Direct Labor library selections</h3>
      <label class="checkbox">
        <input type="checkbox" name="use_labor_library" ${useLaborLibrary ? 'checked' : ''} ${locked ? 'disabled' : ''}>
        Link labor cost to library selections + current project hours
      </label>
      ${allLaborItems.length === 0
        ? html`<p class="muted">No labor items in the library yet. <a href="/library/labor-items">Add one</a>.</p>`
        : html`
          <table class="data compact">
            <thead><tr><th></th><th>Description</th><th class="num">Cost</th></tr></thead>
            <tbody>
              ${allLaborItems.map((li) => {
                const entries = allLaborEntriesById.get(li.id) || [];
                const cost = entries.reduce((a, e) => a + workcenterEntryCost(e.hours, e.rate, settings), 0);
                const checked = laborSelectedIds.has(li.id);
                return html`
                  <tr>
                    <td><input type="checkbox" name="labor_item_ids" value="${escape(li.id)}" data-cost="${cost}" ${checked ? 'checked' : ''} ${locked ? 'disabled' : ''}></td>
                    <td>${escape(li.description)}</td>
                    <td class="num">${fmtDollar(cost)}</td>
                  </tr>`;
              })}
            </tbody>
            <tfoot>
              <tr><th colspan="2">Selected library total</th><th class="num" id="cb-labor-selected-total">${fmtDollar(laborLibTotal)}</th></tr>
              ${useLaborLibrary ? html`<tr><th colspan="2">DL linked total (current + library)</th><th class="num" id="cb-labor-linked-total">${fmtDollar(laborCalcTotal ?? (currentLaborTotal + laborLibTotal))}</th></tr>` : ''}
            </tfoot>
          </table>
        `}
    </section>
  `;
}

function renderDmSubtab({ allDmItems, dmSelectedIds, dmLibTotal, useDmLibrary, locked }) {
  return html`
    <section class="card">
      <h2 class="section-h">Direct Material</h2>
      <p class="muted">
        Check the items from the shared DM library that this price build
        should include. Turn on "link DM to library" to have their sum
        override the Direct Material category on the Pricing tab.
      </p>

      <label class="checkbox">
        <input type="checkbox" name="use_dm_library" ${useDmLibrary ? 'checked' : ''} ${locked ? 'disabled' : ''}>
        Link DM cost to selected library items
      </label>

      ${allDmItems.length === 0
        ? html`<p class="muted">No DM items in the library yet. <a href="/library/dm-items">Add one</a>.</p>`
        : html`
          <table class="data compact">
            <thead><tr><th></th><th>Description</th><th class="num">Cost</th></tr></thead>
            <tbody>
              ${allDmItems.map((it) => {
                const checked = dmSelectedIds.has(it.id);
                return html`
                  <tr>
                    <td><input type="checkbox" name="dm_item_ids" value="${escape(it.id)}" data-cost="${it.cost ?? 0}" ${checked ? 'checked' : ''} ${locked ? 'disabled' : ''}></td>
                    <td>${escape(it.description)}</td>
                    <td class="num">${fmtDollar(it.cost)}</td>
                  </tr>`;
              })}
            </tbody>
            <tfoot><tr><th colspan="2">Selected total</th><th class="num" id="cb-dm-selected-total">${fmtDollar(dmLibTotal ?? 0)}</th></tr></tfoot>
          </table>
        `}
    </section>
  `;
}

// ── POST handler ────────────────────────────────────────────────
export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const ctx = await loadContext(env, params);
  if (!ctx) return new Response('Line item not found', { status: 404 });

  const input = await formBody(request);
  const action = input._action;

  if (action === 'create') {
    return handleCreate(context, ctx, input);
  }
  return handleSave(context, ctx, input);
}

async function handleCreate(context, ctx, input) {
  const { env, data } = context;
  const user = data?.user;
  const { line, oppId, quoteId, lineId } = ctx;

  if (ctx.build) {
    return redirectWithFlash(
      baseUrl(oppId, quoteId, lineId),
      'Price build already exists for this line.',
      'info'
    );
  }

  const id = uuid();
  const ts = now();
  const label = input.label || line.description || 'Price build';
  const templateId = input.builds_library_id || null;

  const buildKind = 'standard';

  // Auto-generate price build number: P{quoteSeq}.{lineIndex}
  // quoteSeq is the quote's position (1, 2, 3...) and lineIndex is
  // the build's position within the quote (1, 2, 3...).
  const quote = await one(env.DB, 'SELECT quote_seq FROM quotes WHERE id = ?', [quoteId]);
  const quoteSeqNum = quote?.quote_seq ?? 1;
  const existingBuilds = await one(env.DB,
    `SELECT COUNT(*) AS n FROM cost_builds cb
       JOIN quote_lines ql ON ql.id = cb.quote_line_id
      WHERE ql.quote_id = ?`, [quoteId]);
  const buildIndex = (existingBuilds?.n ?? 0) + 1;
  const buildNumber = `P${quoteSeqNum}.${buildIndex}`;

  const statements = [];

  if (templateId) {
    // Clone from builds library template
    const tmpl = await one(env.DB, 'SELECT * FROM builds_library WHERE id = ?', [templateId]);
    if (!tmpl) {
      return redirectWithFlash(baseUrl(oppId, quoteId, lineId), 'Template not found.', 'error');
    }

    statements.push(
      stmt(env.DB,
        `INSERT INTO cost_builds
           (id, opportunity_id, quote_line_id, builds_library_id, label, number, status, build_kind,
            dm_user_cost, dl_user_cost, imoh_user_cost, other_user_cost,
            quote_price_user, use_dm_library, use_labor_library,
            notes, created_at, updated_at, created_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, line.opportunity_id, lineId, templateId, label, buildNumber, buildKind,
         tmpl.dm_user_cost, tmpl.dl_user_cost, tmpl.imoh_user_cost, tmpl.other_user_cost,
         tmpl.quote_price_user, tmpl.use_dm_library, tmpl.use_labor_library,
         tmpl.notes, ts, ts, user?.id ?? null]
      )
    );

    // Clone DM selections
    const dmSels = await all(env.DB, 'SELECT dm_item_id FROM builds_library_dm_selections WHERE builds_library_id = ?', [templateId]);
    for (const s of dmSels) {
      statements.push(stmt(env.DB, 'INSERT INTO cost_build_dm_selections (cost_build_id, dm_item_id) VALUES (?, ?)', [id, s.dm_item_id]));
    }

    // Clone labor selections
    const laborSels = await all(env.DB, 'SELECT labor_item_id FROM builds_library_labor_selections WHERE builds_library_id = ?', [templateId]);
    for (const s of laborSels) {
      statements.push(stmt(env.DB, 'INSERT INTO cost_build_labor_selections (cost_build_id, labor_item_id) VALUES (?, ?)', [id, s.labor_item_id]));
    }

    // Clone workcenter entries
    const laborEntries = await all(env.DB, 'SELECT workcenter, hours, rate FROM builds_library_labor WHERE builds_library_id = ?', [templateId]);
    for (const e of laborEntries) {
      statements.push(stmt(env.DB, 'INSERT INTO cost_build_labor (cost_build_id, workcenter, hours, rate) VALUES (?, ?, ?, ?)', [id, e.workcenter, e.hours, e.rate]));
    }
  } else {
    const defaultOther = null;
    statements.push(
      stmt(env.DB,
        `INSERT INTO cost_builds
           (id, opportunity_id, quote_line_id, label, number, status, build_kind,
            dm_user_cost, dl_user_cost, imoh_user_cost, other_user_cost,
            quote_price_user, use_dm_library, use_labor_library,
            notes, created_at, updated_at, created_by_user_id)
         VALUES (?, ?, ?, ?, ?, 'draft', ?, NULL, NULL, NULL, ?, NULL, 0, 0, NULL, ?, ?, ?)`,
        [id, line.opportunity_id, lineId, label, buildNumber, buildKind,
         defaultOther, ts, ts, user?.id ?? null]
      )
    );
  }

  // Update the quote_line's cost_build_id to point to this build
  statements.push(
    stmt(env.DB, 'UPDATE quote_lines SET cost_build_id = ?, updated_at = ? WHERE id = ?', [id, ts, lineId])
  );

  statements.push(
    auditStmt(env.DB, {
      entityType: 'cost_build',
      entityId: id,
      eventType: 'created',
      user,
      summary: `Created price build for line "${line.description}"${templateId ? ' (from template)' : ''}`,
      changes: { quote_line_id: lineId, label },
    })
  );

  await batch(env.DB, statements);

  return redirectWithFlash(baseUrl(oppId, quoteId, lineId), `Created price build.`);
}

async function handleSave(context, ctx, input) {
  const { env, data } = context;
  const user = data?.user;
  const { line, oppId, quoteId, lineId } = ctx;

  if (!ctx.build) {
    return redirectWithFlash(baseUrl(oppId, quoteId, lineId), 'No price build to save.', 'error');
  }

  const buildId = ctx.build.id;
  if (ctx.build.status === 'locked') {
    return new Response('Price build is locked', { status: 409 });
  }

  const { ok, value, errors } = validateCostBuild(input);
  const settings = await loadPricingSettings(env.DB);
  const wcRes = validateWorkcenterEntries(input.current_hours, input.current_rate, settings.workcenters);

  const allErrors = { ...(ok ? {} : errors), ...(wcRes.ok ? {} : wcRes.errors) };
  if (Object.keys(allErrors).length) {
    return renderEditor(context, ctx, {
      values: { ...ctx.build, ...input },
      errors: allErrors,
    });
  }

  const asArray = (v) => v === undefined ? [] : Array.isArray(v) ? v : [v];
  const dmIds = asArray(input.dm_item_ids);
  const laborIds = asArray(input.labor_item_ids);
  const ts = now();

  const statements = [
    stmt(env.DB,
      `UPDATE cost_builds
          SET label = ?, notes = ?,
              dm_user_cost = ?, dl_user_cost = ?, imoh_user_cost = ?, other_user_cost = ?,
              quote_price_user = ?,
              use_dm_library = ?, use_labor_library = ?,
              discount_amount = ?, discount_pct = ?,
              discount_description = ?, discount_is_phantom = ?,
              updated_at = ?
        WHERE id = ?`,
      [value.label, value.notes,
       value.dm_user_cost, value.dl_user_cost, value.imoh_user_cost, value.other_user_cost,
       value.quote_price_user, value.use_dm_library, value.use_labor_library,
       value.discount_amount, value.discount_pct,
       value.discount_description, value.discount_is_phantom,
       ts, buildId]
    ),
    stmt(env.DB, 'DELETE FROM cost_build_labor WHERE cost_build_id = ?', [buildId]),
    ...wcRes.value.map((e) =>
      stmt(env.DB, 'INSERT INTO cost_build_labor (cost_build_id, workcenter, hours, rate) VALUES (?, ?, ?, ?)', [buildId, e.workcenter, e.hours, e.rate])
    ),
    stmt(env.DB, 'DELETE FROM cost_build_dm_selections WHERE cost_build_id = ?', [buildId]),
    ...dmIds.map((id) =>
      stmt(env.DB, 'INSERT OR IGNORE INTO cost_build_dm_selections (cost_build_id, dm_item_id) VALUES (?, ?)', [buildId, id])
    ),
    stmt(env.DB, 'DELETE FROM cost_build_labor_selections WHERE cost_build_id = ?', [buildId]),
    ...laborIds.map((id) =>
      stmt(env.DB, 'INSERT OR IGNORE INTO cost_build_labor_selections (cost_build_id, labor_item_id) VALUES (?, ?)', [buildId, id])
    ),
  ];

  // Also update the line item's unit_price from the computed quote price
  const bundle = await loadCostBuildBundle(env.DB, buildId);
  if (bundle) {
    // Temporarily apply new values to bundle for computation
    bundle.build.dm_user_cost = value.dm_user_cost;
    bundle.build.dl_user_cost = value.dl_user_cost;
    bundle.build.imoh_user_cost = value.imoh_user_cost;
    bundle.build.other_user_cost = value.other_user_cost;
    bundle.build.quote_price_user = value.quote_price_user;
    bundle.build.use_dm_library = value.use_dm_library;
    bundle.build.use_labor_library = value.use_labor_library;
    const { pricing } = computeFromBundle(bundle, settings);

    // T3.2 Phase 3 — mirror the JSON patch handler: push unit_price
    // (+ optionally the build's discount) down to the linked line and
    // recompute the parent quote's totals. Discount flows through when
    // the build previously had one OR now has one — see patch.js for
    // the full rule derivation.
    if (pricing.effective.quote !== null) {
      const unitPrice = pricing.effective.quote;
      const qty = Number(line.quantity) || 1;

      const hasDiscount = (row) =>
        (row.discount_amount !== null && row.discount_amount !== undefined && Number(row.discount_amount) > 0) ||
        (row.discount_pct    !== null && row.discount_pct    !== undefined && Number(row.discount_pct)    > 0) ||
        Number(row.discount_is_phantom) === 1;

      const buildPrevHasDiscount = hasDiscount(ctx.build);
      const buildNowHasDiscount  = hasDiscount(value);
      const shouldPushDiscount   = buildPrevHasDiscount || buildNowHasDiscount;

      const effDiscAmt  = shouldPushDiscount ? value.discount_amount      : line.discount_amount;
      const effDiscPct  = shouldPushDiscount ? value.discount_pct         : line.discount_pct;
      const effDiscDesc = shouldPushDiscount ? value.discount_description : line.discount_description;
      const effDiscPh   = shouldPushDiscount ? value.discount_is_phantom  : line.discount_is_phantom;

      const extended = computeLineExtendedPrice({
        quantity: qty,
        unit_price: unitPrice,
        discount_amount:     effDiscAmt,
        discount_pct:        effDiscPct,
        discount_is_phantom: effDiscPh,
      });

      if (shouldPushDiscount) {
        statements.push(
          stmt(env.DB,
            `UPDATE quote_lines
                SET unit_price = ?, extended_price = ?,
                    discount_amount = ?, discount_pct = ?,
                    discount_description = ?, discount_is_phantom = ?,
                    updated_at = ?
              WHERE id = ?`,
            [unitPrice, extended,
             value.discount_amount, value.discount_pct,
             value.discount_description, value.discount_is_phantom,
             ts, lineId]
          )
        );
      } else {
        statements.push(
          stmt(env.DB,
            'UPDATE quote_lines SET unit_price = ?, extended_price = ?, updated_at = ? WHERE id = ?',
            [unitPrice, extended, ts, lineId]
          )
        );
      }

      statements.push(quoteTotalsRecomputeStmt(env.DB, quoteId, ts));
    }
  }

  statements.push(
    auditStmt(env.DB, {
      entityType: 'cost_build',
      entityId: buildId,
      eventType: 'updated',
      user,
      summary: `Updated price build for "${line.description}"`,
      changes: { label: value.label },
    })
  );

  await batch(env.DB, statements);

  const sub = input.sub || 'pricing';
  const target = sub === 'pricing'
    ? baseUrl(oppId, quoteId, lineId)
    : `${baseUrl(oppId, quoteId, lineId)}?sub=${encodeURIComponent(sub)}`;

  return redirectWithFlash(target, 'Saved.');
}

function formatSize(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
