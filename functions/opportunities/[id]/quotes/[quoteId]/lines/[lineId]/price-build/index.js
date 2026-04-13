// functions/opportunities/[id]/quotes/[quoteId]/lines/[lineId]/price-build/index.js
//
// GET  — show price build editor (or create prompt if none exists)
// POST — create or save the price build for this line item
//
// Each quote line item has at most one price build (1:1). The build is
// stored in cost_builds with quote_line_id set. The pricing engine is
// identical to the old opp-level cost builds.

import { one, all, stmt, batch } from '../../../../../../../lib/db.js';
import { auditStmt } from '../../../../../../../lib/audit.js';
import { validateCostBuild, validateWorkcenterEntries } from '../../../../../../../lib/validators.js';
import { layout, htmlResponse, html, escape, raw } from '../../../../../../../lib/layout.js';
import { uuid, now } from '../../../../../../../lib/ids.js';
import { redirectWithFlash, formBody, readFlash } from '../../../../../../../lib/http.js';
import {
  loadPricingSettings,
  loadCostBuildBundle,
  computeFromBundle,
  workcenterEntryCost,
  fmtDollar,
  fmtPct,
} from '../../../../../../../lib/pricing.js';

// ── Context loader ──────────────────────────────────────────────
async function loadContext(env, params) {
  const { id: oppId, quoteId, lineId } = params;
  const line = await one(
    env.DB,
    `SELECT ql.*, q.opportunity_id, q.number AS quote_number, q.revision,
            o.number AS opp_number, o.title AS opp_title
       FROM quote_lines ql
       JOIN quotes q ON q.id = ql.quote_id
       JOIN opportunities o ON o.id = q.opportunity_id
      WHERE ql.id = ? AND q.id = ? AND o.id = ?`,
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
          <h1>Price build</h1>
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
  const url = new URL(request.url);
  const sub = url.searchParams.get('sub') || 'pricing';
  const { line, oppId, quoteId, lineId } = ctx;
  const buildId = ctx.build.id;

  const bundle = await loadCostBuildBundle(env.DB, buildId);
  if (!bundle) return new Response('Price build not found', { status: 404 });

  const settings = await loadPricingSettings(env.DB);
  const { pricing, totals } = computeFromBundle(bundle, settings);
  const workcenters = settings.workcenters;

  const allDmItems = await all(env.DB, 'SELECT id, description, cost FROM dm_items ORDER BY description');
  const dmSelectedIds = new Set(bundle.dmSelections.map((it) => it.id));

  const allLaborItems = await all(env.DB, 'SELECT id, description FROM labor_items ORDER BY description');
  const laborSelectedIds = new Set(bundle.laborSelections.map((it) => it.id));
  const allLaborEntries = await all(env.DB, 'SELECT labor_item_id, workcenter, hours, rate FROM labor_item_entries');
  const allLaborEntriesById = new Map();
  for (const e of allLaborEntries) {
    if (!allLaborEntriesById.has(e.labor_item_id)) allLaborEntriesById.set(e.labor_item_id, []);
    allLaborEntriesById.get(e.labor_item_id).push(e);
  }

  const build = values || bundle.build;
  const locked = bundle.build.status === 'locked';

  const currentLaborByWc = new Map(
    (bundle.currentLabor || []).map((r) => [r.workcenter, r])
  );

  const errText = (k) => (errors[k] ? html`<small class="error">${errors[k]}</small>` : '');
  const base = baseUrl(oppId, quoteId, lineId);

  const pricingTabBody = renderPricingSubtab({ build, pricing, totals, settings, errText, locked });
  const laborTabBody = renderLaborSubtab({
    workcenters, settings, currentLaborByWc,
    currentLaborTotal: totals.currentLaborTotal,
    allLaborItems, laborSelectedIds, allLaborEntriesById,
    laborLibTotal: totals.laborLibTotal,
    useLaborLibrary: !!bundle.build.use_labor_library,
    laborCalcTotal: totals.laborCalcTotal,
    errText, locked,
  });
  const dmTabBody = renderDmSubtab({
    allDmItems, dmSelectedIds, dmLibTotal: totals.dmLibTotal,
    useDmLibrary: !!bundle.build.use_dm_library, locked,
  });

  const subNav = html`
    <nav class="card" style="padding: 0.5rem 1rem;">
      <a class="nav-link ${sub === 'pricing' ? 'active' : ''}" href="${base}">Pricing engine</a>
      <a class="nav-link ${sub === 'labor' ? 'active' : ''}" href="${base}?sub=labor">Labor cost (${fmtDollar(totals.currentLaborTotal + totals.laborLibTotal)})</a>
      <a class="nav-link ${sub === 'dm' ? 'active' : ''}" href="${base}?sub=dm">Direct Material (${fmtDollar(totals.dmLibTotal || 0)})</a>
    </nav>`;

  const header = html`
    <section class="card">
      <div class="card-header">
        <div>
          <h1>
            ${escape(build.label || '(unlabeled)')}
            ${locked ? html`<span class="pill pill-locked" style="margin-left:0.5rem">locked</span>` : ''}
          </h1>
          <p class="muted">
            Price build for: <strong>${escape(line.description)}</strong>
            · Quote <a href="${quoteUrl(oppId, quoteId)}">${escape(line.quote_number)} Rev ${escape(line.revision)}</a>
            · <a href="/opportunities/${escape(oppId)}">${escape(line.opp_number)}</a>
          </p>
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
  `;

  const body = html`
    ${header}
    ${subNav}
    <form method="post" action="${base}" class="cost-build-form">
      <input type="hidden" name="sub" value="${escape(sub)}">
      <input type="hidden" name="_action" value="save">
      <script type="application/json" id="cb-pricing-data">${raw(JSON.stringify({
        targetPct: settings.targetPct,
        totalTargetPct: settings.targetPct.dm + settings.targetPct.dl + settings.targetPct.imoh + settings.targetPct.other,
        marginThresholdGood: settings.marginThresholdGood,
        defaultLaborRate: settings.defaultLaborRate,
      }))}</script>
      <div class="field">
        <label>Label</label>
        <input type="text" name="label" value="${build.label ?? ''}" ${locked ? 'disabled' : ''}>
      </div>

      <div style="display: ${sub === 'pricing' ? 'block' : 'none'}">${pricingTabBody}</div>
      <div style="display: ${sub === 'labor' ? 'block' : 'none'}">${laborTabBody}</div>
      <div style="display: ${sub === 'dm' ? 'block' : 'none'}">${dmTabBody}</div>

      <div class="field" style="width:100%">
        <label>Notes</label>
        <textarea name="notes" ${locked ? 'disabled' : ''} style="width:100%; field-sizing:content; min-height:2.5rem; resize:none; padding:0.4rem 0.55rem; border:1px solid var(--border); border-radius:var(--radius); font:inherit; background:var(--bg);">${escape(build.notes ?? '')}</textarea>
      </div>

      ${locked
        ? html`<p class="muted">This price build is locked. Unlock it to make changes.</p>`
        : html`<div class="form-actions">
            <button class="btn primary" type="submit">Save</button>
            <a class="btn" href="${quoteUrl(oppId, quoteId)}">Back</a>
          </div>`}
    </form>
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

// ── Sub-tab renderers (same as old cost build editor) ───────────

function renderPricingSubtab({ build, pricing, totals, settings, errText, locked }) {
  const eff = pricing.effective;
  const auto = pricing.auto;
  const notes = pricing.notes;
  const marg = pricing.margin;
  const refs = pricing.references;
  const targetPct = pricing.targetPct;
  const linked = pricing.linked;

  const valOrAuto = (userVal, autoVal) => {
    if (userVal !== null && userVal !== undefined && userVal !== '') return String(userVal);
    if (autoVal !== null && autoVal !== undefined) return Math.round(autoVal).toString();
    return '';
  };
  const autoClass = (userVal, autoVal) => {
    if (userVal === null || userVal === undefined || userVal === '') {
      if (autoVal !== null && autoVal !== undefined) return 'auto-filled';
    }
    return '';
  };

  const categoryRow = (id, label, userVal, autoVal, noteText, disabled = false) => html`
    <tr>
      <td><strong>${label}</strong><div class="muted" style="font-size:0.75rem">target ${fmtPct(targetPct[id === 'quote' ? 'total' : id], 1)}</div></td>
      <td class="num">
        <input type="text"
               name="${id === 'quote' ? 'quote_price_user' : id + '_user_cost'}"
               value="${valOrAuto(userVal, autoVal)}"
               class="num-input ${autoClass(userVal, autoVal)}"
               ${disabled || locked ? 'disabled' : ''}
               placeholder="$0">
        ${errText(id === 'quote' ? 'quote_price_user' : id + '_user_cost')}
        ${noteText ? html`<div class="muted" style="font-size:0.75rem">${escape(noteText)}</div>` : ''}
      </td>
    </tr>`;

  return html`
    <section class="card">
      <h2 class="section-h">Pricing engine</h2>
      <p class="muted">
        Fill in any combination below. Blanks auto-fill from the effective
        quote x target %. If you link DM to the library or labor to the
        Labor Cost tab, those totals win over user-entered values.
      </p>

      <table class="data compact">
        <thead><tr><th>Category</th><th class="num">Cost</th></tr></thead>
        <tbody>
          ${categoryRow('dm',    'Direct Material (DM)',     build.dm_user_cost,    auto.dm,    linked.dm ? notes.dm : (auto.dm !== null ? notes.dm : ''), linked.dm)}
          ${categoryRow('dl',    'Direct Labor (DL)',        build.dl_user_cost,    auto.dl,    linked.labor ? notes.dl : (auto.dl !== null ? notes.dl : ''), linked.labor)}
          ${categoryRow('imoh',  'Indirect Material + OH',   build.imoh_user_cost,  auto.imoh,  auto.imoh !== null ? notes.imoh : '')}
          ${categoryRow('other', 'Other',                    build.other_user_cost, auto.other, auto.other !== null ? notes.other : '')}
        </tbody>
        <tfoot>
          <tr><th>Total cost</th><th class="num" id="cb-total-cost">${fmtDollar(eff.totalCost)}</th></tr>
        </tfoot>
      </table>

      <div class="pricing-grid">
        <div class="pricing-box">
          <div class="muted">Quote price</div>
          <input type="text" name="quote_price_user"
                 value="${valOrAuto(build.quote_price_user, auto.quote)}"
                 class="num-input ${autoClass(build.quote_price_user, auto.quote)}"
                 ${locked ? 'disabled' : ''} placeholder="$0">
          ${errText('quote_price_user')}
          ${auto.quote !== null ? html`<div class="muted" style="font-size:0.75rem">${escape(notes.quote)}</div>` : ''}
        </div>
        <div class="pricing-box">
          <div class="muted">Target price (cost / ${fmtPct(targetPct.total, 1)})</div>
          <div class="pricing-value" id="cb-target-price">${fmtDollar(eff.targetPrice)}</div>
        </div>
        <div class="pricing-box ${marg.status === 'good' ? 'margin-good' : marg.status === 'low' ? 'margin-low' : ''}" id="cb-margin-box">
          <div class="muted">Margin</div>
          <div class="pricing-value" id="cb-margin-value">
            ${marg.amount !== null ? html`${fmtDollar(marg.amount)} (${fmtPct(marg.pct)})` : '\u2014'}
          </div>
          <div class="muted" id="cb-margin-status" style="font-size:0.75rem">
          ${marg.status
            ? (marg.status === 'good' ? `Good (> ${fmtPct(marg.threshold)})` : `Too low (< ${fmtPct(marg.threshold)})`)
            : ''}</div>
        </div>
      </div>

      <details class="reference-details">
        <summary>Reference estimates</summary>
        <div class="addr-grid">
          <div>
            <strong>From Quote Price</strong>
            <ul class="plain">
              <li>DM (${fmtPct(targetPct.dm, 1)}): <span id="cb-ref-fq-dm">${fmtDollar(refs.fromQuote.dm)}</span></li>
              <li>DL (${fmtPct(targetPct.dl, 1)}): <span id="cb-ref-fq-dl">${fmtDollar(refs.fromQuote.dl)}</span></li>
              <li>IMOH (${fmtPct(targetPct.imoh, 1)}): <span id="cb-ref-fq-imoh">${fmtDollar(refs.fromQuote.imoh)}</span></li>
              <li>Other (${fmtPct(targetPct.other, 1)}): <span id="cb-ref-fq-other">${fmtDollar(refs.fromQuote.other)}</span></li>
            </ul>
          </div>
          <div>
            <strong>From DM</strong>
            <ul class="plain">
              <li>Implied price: <span id="cb-ref-fdm-price">${fmtDollar(refs.fromDm.price)}</span></li>
              <li>Implied DL: <span id="cb-ref-fdm-dl">${fmtDollar(refs.fromDm.dl)}</span></li>
              <li>Implied IMOH: <span id="cb-ref-fdm-imoh">${fmtDollar(refs.fromDm.imoh)}</span></li>
              <li>Implied Other: <span id="cb-ref-fdm-other">${fmtDollar(refs.fromDm.other)}</span></li>
            </ul>
          </div>
          <div>
            <strong>From DM + DL</strong>
            <ul class="plain">
              <li>Implied price: <span id="cb-ref-fdmdl-price">${fmtDollar(refs.fromDmDl.price)}</span></li>
              <li>Implied IMOH: <span id="cb-ref-fdmdl-imoh">${fmtDollar(refs.fromDmDl.imoh)}</span></li>
              <li>Implied Other: <span id="cb-ref-fdmdl-other">${fmtDollar(refs.fromDmDl.other)}</span></li>
            </ul>
          </div>
        </div>
      </details>
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

      <h3 style="margin-top:1rem">Labor library selections</h3>
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
           (id, opportunity_id, quote_line_id, builds_library_id, label, status,
            dm_user_cost, dl_user_cost, imoh_user_cost, other_user_cost,
            quote_price_user, use_dm_library, use_labor_library,
            notes, created_at, updated_at, created_by_user_id)
         VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, line.opportunity_id, lineId, templateId, label,
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
    statements.push(
      stmt(env.DB,
        `INSERT INTO cost_builds
           (id, opportunity_id, quote_line_id, label, status,
            dm_user_cost, dl_user_cost, imoh_user_cost, other_user_cost,
            quote_price_user, use_dm_library, use_labor_library,
            notes, created_at, updated_at, created_by_user_id)
         VALUES (?, ?, ?, ?, 'draft', NULL, NULL, NULL, NULL, NULL, 0, 0, NULL, ?, ?, ?)`,
        [id, line.opportunity_id, lineId, label, ts, ts, user?.id ?? null]
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
              updated_at = ?
        WHERE id = ?`,
      [value.label, value.notes,
       value.dm_user_cost, value.dl_user_cost, value.imoh_user_cost, value.other_user_cost,
       value.quote_price_user, value.use_dm_library, value.use_labor_library,
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
    if (pricing.effective.quote !== null) {
      const unitPrice = pricing.effective.quote;
      const qty = Number(line.quantity) || 1;
      const extended = qty * unitPrice;
      statements.push(
        stmt(env.DB,
          'UPDATE quote_lines SET unit_price = ?, extended_price = ?, updated_at = ? WHERE id = ?',
          [unitPrice, extended, ts, lineId]
        )
      );
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
