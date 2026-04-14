// functions/opportunities/[id]/cost-builds/[buildId]/index.js
//
// GET  /opportunities/:id/cost-builds/:buildId           — full editor
// GET  /opportunities/:id/cost-builds/:buildId?sub=labor — Labor sub-tab
// GET  /opportunities/:id/cost-builds/:buildId?sub=dm    — Direct Material sub-tab
// POST /opportunities/:id/cost-builds/:buildId           — save all pricing fields
//
// All three sub-tabs live on one page so the pricing engine
// computation can pool the DB loads. The sub parameter just selects
// which panel is visible (the others collapse). Lock/unlock are
// separate routes under /lock and /unlock.
//
// Locked builds render read-only — all inputs get `disabled` and the
// Save button is hidden; lock status shows as a banner.

import { one, all, stmt, batch } from '../../../../lib/db.js';
import { auditStmt } from '../../../../lib/audit.js';
import { validateCostBuild, validateWorkcenterEntries } from '../../../../lib/validators.js';
import { layout, htmlResponse, html, escape, raw } from '../../../../lib/layout.js';
import { now } from '../../../../lib/ids.js';
import { redirectWithFlash, formBody, readFlash } from '../../../../lib/http.js';
import {
  loadPricingSettings,
  loadCostBuildBundle,
  computeFromBundle,
  workcenterEntryCost,
  fmtDollar,
  fmtPct,
} from '../../../../lib/pricing.js';

export async function onRequestGet(context) {
  return renderEditor(context, {});
}

async function renderEditor(context, { values = null, errors = {} } = {}) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const url = new URL(request.url);
  const oppId = params.id;
  const buildId = params.buildId;
  const sub = url.searchParams.get('sub') || 'pricing';

  const opp = await one(
    env.DB,
    'SELECT id, number, title FROM opportunities WHERE id = ?',
    [oppId]
  );
  if (!opp) return new Response('Opportunity not found', { status: 404 });

  const bundle = await loadCostBuildBundle(env.DB, buildId);
  if (!bundle || bundle.build.opportunity_id !== oppId) {
    return new Response('Price build not found', { status: 404 });
  }

  const settings = await loadPricingSettings(env.DB);
  const { pricing, totals } = computeFromBundle(bundle, settings);
  const workcenters = settings.workcenters;

  // All DM and labor library items (for the selection toggles).
  const allDmItems = await all(
    env.DB,
    'SELECT id, description, cost FROM dm_items ORDER BY description'
  );
  const dmSelectedIds = new Set(bundle.dmSelections.map((it) => it.id));

  const allLaborItems = await all(
    env.DB,
    'SELECT id, description FROM labor_items ORDER BY description'
  );
  const laborSelectedIds = new Set(bundle.laborSelections.map((it) => it.id));
  const laborEntriesById = new Map(
    bundle.laborSelections.map((it) => [it.id, it.entries || []])
  );
  // We also need the cost of every library labor item (even unselected)
  // so the checklist can show "(N hrs = $X)" hints.
  const allLaborEntries = await all(
    env.DB,
    'SELECT labor_item_id, workcenter, hours, rate FROM labor_item_entries'
  );
  const allLaborEntriesById = new Map();
  for (const e of allLaborEntries) {
    if (!allLaborEntriesById.has(e.labor_item_id)) allLaborEntriesById.set(e.labor_item_id, []);
    allLaborEntriesById.get(e.labor_item_id).push(e);
  }

  // If the user previously submitted invalid values, show those values
  // in the form instead of the stored bundle. (validated pricing uses
  // bundle values regardless — that's the read-from-db snapshot.)
  const build = values || bundle.build;
  const locked = bundle.build.status === 'locked';

  const currentLaborByWc = new Map(
    (bundle.currentLabor || []).map((r) => [r.workcenter, r])
  );

  const errText = (k) => (errors[k] ? html`<small class="error">${errors[k]}</small>` : '');

  // ---------- Pricing sub-tab ----------
  const pricingTabBody = renderPricingSubtab({
    build, pricing, totals, settings, errText, locked,
  });

  // ---------- Labor sub-tab ----------
  const laborTabBody = renderLaborSubtab({
    workcenters,
    settings,
    currentLaborByWc,
    currentLaborTotal: totals.currentLaborTotal,
    allLaborItems,
    laborSelectedIds,
    allLaborEntriesById,
    laborLibTotal: totals.laborLibTotal,
    useLaborLibrary: !!bundle.build.use_labor_library,
    laborCalcTotal: totals.laborCalcTotal,
    errText,
    locked,
  });

  // ---------- DM sub-tab ----------
  const dmTabBody = renderDmSubtab({
    allDmItems,
    dmSelectedIds,
    dmLibTotal: totals.dmLibTotal,
    useDmLibrary: !!bundle.build.use_dm_library,
    locked,
  });

  const subNav = html`
    <nav class="card" style="padding: 0.5rem 1rem;">
      <a class="nav-link ${sub === 'pricing' ? 'active' : ''}"
         href="/opportunities/${escape(oppId)}/cost-builds/${escape(buildId)}">Pricing engine</a>
      <a class="nav-link ${sub === 'labor' ? 'active' : ''}"
         href="/opportunities/${escape(oppId)}/cost-builds/${escape(buildId)}?sub=labor">Labor cost (${fmtDollar(totals.currentLaborTotal + totals.laborLibTotal)})</a>
      <a class="nav-link ${sub === 'dm' ? 'active' : ''}"
         href="/opportunities/${escape(oppId)}/cost-builds/${escape(buildId)}?sub=dm">Direct Material (${fmtDollar(totals.dmLibTotal || 0)})</a>
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
            <a href="/opportunities/${escape(oppId)}">${escape(opp.number)} — ${escape(opp.title)}</a>
            · <a href="/opportunities/${escape(oppId)}?tab=cost">All price builds</a>
          </p>
        </div>
        <div class="header-actions">
          ${locked
            ? html`
              <form method="post" action="/opportunities/${escape(oppId)}/cost-builds/${escape(buildId)}/unlock"
                    onsubmit="return confirm('Unlock this price build for editing?')">
                <button class="btn" type="submit">Unlock</button>
              </form>`
            : html`
              <form method="post" action="/opportunities/${escape(oppId)}/cost-builds/${escape(buildId)}/lock"
                    onsubmit="return confirm('Lock this price build? It will become view-only.')">
                <button class="btn" type="submit">Lock</button>
              </form>
              <form method="post" action="/opportunities/${escape(oppId)}/cost-builds/${escape(buildId)}/delete"
                    onsubmit="return confirm('Delete this price build? This cannot be undone.')">
                <button class="btn danger" type="submit">Delete</button>
              </form>`}
        </div>
      </div>
    </section>
  `;

  const body = html`
    ${header}
    ${subNav}
    <form method="post" action="/opportunities/${escape(oppId)}/cost-builds/${escape(buildId)}" class="cost-build-form">
      <input type="hidden" name="sub" value="${escape(sub)}">
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

      <div class="field">
        <label>Notes</label>
        <textarea name="notes" rows="3" ${locked ? 'disabled' : ''}>${escape(build.notes ?? '')}</textarea>
      </div>

      ${locked
        ? html`<p class="muted">This price build is locked. Unlock it to make changes.</p>`
        : html`<div class="form-actions">
            <button class="btn primary" type="submit">Save</button>
            <a class="btn" href="/opportunities/${escape(oppId)}?tab=cost">Back</a>
          </div>`}
    </form>
  `;

  return htmlResponse(
    layout(`${build.label || 'Price build'} — ${opp.number}`, body, {
      user,
      env: data?.env,
      activeNav: '/opportunities',
      flash: readFlash(url),
    })
  );
}

// =====================================================================
// Sub-tab renderers
// =====================================================================

function renderPricingSubtab({ build, pricing, totals, settings, errText, locked }) {
  const eff = pricing.effective;
  const auto = pricing.auto;
  const notes = pricing.notes;
  const marg = pricing.margin;
  const refs = pricing.references;
  const targetPct = pricing.targetPct;
  const linked = pricing.linked;

  const fmtInput = (n) => {
    if (n === null || n === undefined || n === '') return '';
    const num = Number(n);
    if (Number.isNaN(num)) return String(n);
    return '$' + num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
  const valOrAuto = (userVal, autoVal) => {
    if (userVal !== null && userVal !== undefined && userVal !== '') return fmtInput(userVal);
    if (autoVal !== null && autoVal !== undefined) return fmtInput(autoVal);
    return '';
  };
  const autoClass = (userVal, autoVal) => {
    if (userVal === null || userVal === undefined || userVal === '') {
      if (autoVal !== null && autoVal !== undefined) return 'auto-filled';
    }
    return '';
  };

  const pctOf = (cost, base) => {
    if (cost == null || base == null || base === 0) return '\u2014';
    return fmtPct(cost / base, 1);
  };

  const categoryRow = (id, label, userVal, autoVal, noteText, disabled, effCost) => html`
    <tr>
      <td><strong>${label}</strong></td>
      <td class="num">
        <input type="text" name="${id}_user_cost"
               value="${valOrAuto(userVal, autoVal)}"
               class="num-input ${autoClass(userVal, autoVal)}"
               ${disabled || locked ? 'disabled' : ''} placeholder="$0">
        ${errText(id + '_user_cost')}
        ${noteText ? html`<div class="muted" style="font-size:0.75rem">${escape(noteText)}</div>` : ''}
      </td>
      <td class="num muted">${fmtPct(targetPct[id], 1)}</td>
      <td class="num" id="cb-pct-target-${id}">${pctOf(effCost, eff.targetPrice)}</td>
      <td class="num" id="cb-pct-quote-${id}">${pctOf(effCost, eff.quote)}</td>
    </tr>`;

  return html`
    <section class="card">
      <h2 class="section-h">Pricing</h2>

      <div class="pricing-target-line">
        <span class="muted">Target Price</span>
        <span id="cb-target-price">${fmtDollar(eff.targetPrice)}</span>
      </div>

      <div class="pricing-grid pricing-grid-2">
        <div class="pricing-box pricing-box-quote">
          <div class="muted">Quote Price</div>
          <input type="text" name="quote_price_user"
                 value="${valOrAuto(build.quote_price_user, auto.quote)}"
                 class="num-input pricing-input ${autoClass(build.quote_price_user, auto.quote)}"
                 ${locked ? 'disabled' : ''} placeholder="$0">
          ${errText('quote_price_user')}
          ${auto.quote !== null
            ? html`<div class="muted" style="font-size:0.75rem">${escape(notes.quote)}</div>`
            : ''}
        </div>
        <div class="pricing-box ${marg.status === 'good' ? 'margin-good' : marg.status === 'low' ? 'margin-low' : ''}" id="cb-margin-box">
          <div class="muted">Estimated Gross Margin</div>
          <div class="pricing-value" id="cb-margin-value">
            ${marg.amount !== null
              ? html`${fmtDollar(marg.amount)} (${fmtPct(marg.pct)})`
              : '\u2014'}
          </div>
          <div class="muted" id="cb-margin-status" style="font-size:0.75rem">
          ${marg.status
            ? (marg.status === 'good'
                  ? `Good (> ${fmtPct(marg.threshold)})`
                  : `Too Low (\u2264 ${fmtPct(marg.threshold)})`)
            : ''}</div>
        </div>
      </div>

      <h2 class="section-h">Cost Inputs &amp; Summary</h2>
      <p class="muted" style="margin-top:-0.5rem">
        Blanks auto-fill from quote \u00d7 target %. Linked DM/labor totals override manual values.
      </p>

      <table class="data compact cost-summary-table">
        <thead>
          <tr><th></th><th class="num">Cost</th><th class="num">Target %</th><th class="num">% of Target</th><th class="num">% of Quote</th></tr>
        </thead>
        <tbody>
          ${categoryRow('dm',    'Direct Material (DM)',        build.dm_user_cost,   auto.dm,   linked.dm ? notes.dm : (auto.dm !== null ? notes.dm : ''),       linked.dm,    eff.dm)}
          ${categoryRow('dl',    'Direct Labor (DL)',           build.dl_user_cost,   auto.dl,   linked.labor ? notes.dl : (auto.dl !== null ? notes.dl : ''),    linked.labor, eff.dl)}
          ${categoryRow('imoh',  'Indirect Material + OH', build.imoh_user_cost, auto.imoh, auto.imoh !== null ? notes.imoh : '',                       false,        eff.imoh)}
          ${categoryRow('other', 'Other',                       build.other_user_cost, auto.other, auto.other !== null ? notes.other : '',                        false,        eff.other)}
        </tbody>
        <tfoot>
          <tr>
            <th>Total Est. Cost</th>
            <th class="num" id="cb-total-cost">${fmtDollar(eff.totalCost)}</th>
            <th class="num muted">${fmtPct(targetPct.total, 1)}</th>
            <th class="num" id="cb-pct-target-total">${pctOf(eff.totalCost, eff.targetPrice)}</th>
            <th class="num" id="cb-pct-quote-total">${pctOf(eff.totalCost, eff.quote)}</th>
          </tr>
        </tfoot>
      </table>

      <div class="reference-estimates">
        <div class="ref-heading">Reference Estimates</div>
        <div class="ref-grid">
          <div>
            <div class="ref-subhead">Estimates based on Quote Price</div>
            <table class="ref-table">
              <tr><td>DM</td><td class="num" id="cb-ref-fq-dm">${fmtDollar(refs.fromQuote.dm)}</td></tr>
              <tr><td>DL</td><td class="num" id="cb-ref-fq-dl">${fmtDollar(refs.fromQuote.dl)}</td></tr>
              <tr><td>IMOH</td><td class="num" id="cb-ref-fq-imoh">${fmtDollar(refs.fromQuote.imoh)}</td></tr>
              <tr><td>Other</td><td class="num" id="cb-ref-fq-other">${fmtDollar(refs.fromQuote.other)}</td></tr>
            </table>
          </div>
          <div>
            <div class="ref-subhead">Estimates from DM only</div>
            <table class="ref-table">
              <tr><td>Price</td><td class="num" id="cb-ref-fdm-price">${fmtDollar(refs.fromDm.price)}</td></tr>
              <tr><td>Labor</td><td class="num" id="cb-ref-fdm-dl">${fmtDollar(refs.fromDm.dl)}</td></tr>
              <tr><td>IMOH</td><td class="num" id="cb-ref-fdm-imoh">${fmtDollar(refs.fromDm.imoh)}</td></tr>
              <tr><td>Other</td><td class="num" id="cb-ref-fdm-other">${fmtDollar(refs.fromDm.other)}</td></tr>
            </table>
          </div>
          <div>
            <div class="ref-subhead">Estimates from DM + DL</div>
            <table class="ref-table">
              <tr><td>Price</td><td class="num" id="cb-ref-fdmdl-price">${fmtDollar(refs.fromDmDl.price)}</td></tr>
              <tr><td>IMOH</td><td class="num" id="cb-ref-fdmdl-imoh">${fmtDollar(refs.fromDmDl.imoh)}</td></tr>
              <tr><td>Other</td><td class="num" id="cb-ref-fdmdl-other">${fmtDollar(refs.fromDmDl.other)}</td></tr>
            </table>
          </div>
        </div>
      </div>
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
    const cost = entry
      ? workcenterEntryCost(entry.hours, entry.rate, settings)
      : 0;
    return html`
      <tr data-labor-wc="${escape(wc)}">
        <td>${escape(wc)}</td>
        <td class="num">
          <input type="text" name="current_hours[${escape(wc)}]"
                 value="${hours}" class="num-input"
                 ${locked ? 'disabled' : ''} placeholder="0">
          ${errText(`hours_${wc}`)}
        </td>
        <td class="num">
          <input type="text" name="current_rate[${escape(wc)}]"
                 value="${rate}" class="num-input"
                 ${locked ? 'disabled' : ''}
                 placeholder="${settings.defaultLaborRate}">
          ${errText(`rate_${wc}`)}
        </td>
        <td class="num" data-labor-cost>${cost ? fmtDollar(cost) : '—'}</td>
      </tr>
    `;
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
        <thead>
          <tr>
            <th>Workcenter</th>
            <th class="num">Hours</th>
            <th class="num">Rate</th>
            <th class="num">Cost</th>
          </tr>
        </thead>
        <tbody>${wcRows}</tbody>
        <tfoot>
          <tr>
            <th colspan="3">Current project total</th>
            <th class="num" id="cb-labor-total">${fmtDollar(currentLaborTotal)}</th>
          </tr>
        </tfoot>
      </table>

      <h3 style="margin-top:1rem">Labor library selections</h3>
      <label class="checkbox">
        <input type="checkbox" name="use_labor_library" ${useLaborLibrary ? 'checked' : ''}
               ${locked ? 'disabled' : ''}>
        Link labor cost to library selections + current project hours
      </label>
      ${allLaborItems.length === 0
        ? html`<p class="muted">No labor items in the library yet. <a href="/library/labor-items">Add one</a>.</p>`
        : html`
          <table class="data compact">
            <thead>
              <tr>
                <th></th>
                <th>Description</th>
                <th class="num">Cost</th>
              </tr>
            </thead>
            <tbody>
              ${allLaborItems.map((li) => {
                const entries = allLaborEntriesById.get(li.id) || [];
                const cost = entries.reduce(
                  (a, e) => a + workcenterEntryCost(e.hours, e.rate, settings),
                  0
                );
                const checked = laborSelectedIds.has(li.id);
                return html`
                  <tr>
                    <td>
                      <input type="checkbox" name="labor_item_ids" value="${escape(li.id)}"
                             data-cost="${cost}"
                             ${checked ? 'checked' : ''} ${locked ? 'disabled' : ''}>
                    </td>
                    <td>${escape(li.description)}</td>
                    <td class="num">${fmtDollar(cost)}</td>
                  </tr>`;
              })}
            </tbody>
            <tfoot>
              <tr>
                <th colspan="2">Selected library total</th>
                <th class="num" id="cb-labor-selected-total">${fmtDollar(laborLibTotal)}</th>
              </tr>
              ${useLaborLibrary
                ? html`<tr>
                  <th colspan="2">DL linked total (current + library)</th>
                  <th class="num" id="cb-labor-linked-total">${fmtDollar(laborCalcTotal ?? (currentLaborTotal + laborLibTotal))}</th>
                </tr>`
                : ''}
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
        <input type="checkbox" name="use_dm_library" ${useDmLibrary ? 'checked' : ''}
               ${locked ? 'disabled' : ''}>
        Link DM cost to selected library items
      </label>

      ${allDmItems.length === 0
        ? html`<p class="muted">No DM items in the library yet. <a href="/library/dm-items">Add one</a>.</p>`
        : html`
          <table class="data compact">
            <thead>
              <tr>
                <th></th>
                <th>Description</th>
                <th class="num">Cost</th>
              </tr>
            </thead>
            <tbody>
              ${allDmItems.map((it) => {
                const checked = dmSelectedIds.has(it.id);
                return html`
                  <tr>
                    <td>
                      <input type="checkbox" name="dm_item_ids" value="${escape(it.id)}"
                             data-cost="${it.cost ?? 0}"
                             ${checked ? 'checked' : ''} ${locked ? 'disabled' : ''}>
                    </td>
                    <td>${escape(it.description)}</td>
                    <td class="num">${fmtDollar(it.cost)}</td>
                  </tr>`;
              })}
            </tbody>
            <tfoot>
              <tr>
                <th colspan="2">Selected total</th>
                <th class="num" id="cb-dm-selected-total">${fmtDollar(dmLibTotal ?? 0)}</th>
              </tr>
            </tfoot>
          </table>
        `}
    </section>
  `;
}

// =====================================================================
// POST handler — save everything in one shot
// =====================================================================

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const oppId = params.id;
  const buildId = params.buildId;

  const existing = await one(
    env.DB,
    'SELECT * FROM cost_builds WHERE id = ?',
    [buildId]
  );
  if (!existing || existing.opportunity_id !== oppId) {
    return new Response('Price build not found', { status: 404 });
  }
  if (existing.status === 'locked') {
    return new Response('Price build is locked', { status: 409 });
  }

  const input = await formBody(request);
  const { ok, value, errors } = validateCostBuild(input);

  const settings = await loadPricingSettings(env.DB);
  const wcRes = validateWorkcenterEntries(
    input.current_hours,
    input.current_rate,
    settings.workcenters
  );

  const allErrors = { ...(ok ? {} : errors), ...(wcRes.ok ? {} : wcRes.errors) };
  if (Object.keys(allErrors).length) {
    return renderEditor(context, {
      values: { ...existing, ...input },
      errors: allErrors,
    });
  }

  // Normalize selection arrays (<input name="dm_item_ids" value="..."> —
  // formBody returns either a string (one checkbox) or an array.)
  const asArray = (v) => v === undefined ? [] : Array.isArray(v) ? v : [v];
  const dmIds = asArray(input.dm_item_ids);
  const laborIds = asArray(input.labor_item_ids);

  const ts = now();

  const statements = [
    stmt(
      env.DB,
      `UPDATE cost_builds
          SET label = ?, notes = ?,
              dm_user_cost = ?, dl_user_cost = ?, imoh_user_cost = ?, other_user_cost = ?,
              quote_price_user = ?,
              use_dm_library = ?, use_labor_library = ?,
              updated_at = ?
        WHERE id = ?`,
      [
        value.label,
        value.notes,
        value.dm_user_cost,
        value.dl_user_cost,
        value.imoh_user_cost,
        value.other_user_cost,
        value.quote_price_user,
        value.use_dm_library,
        value.use_labor_library,
        ts,
        buildId,
      ]
    ),

    // Rewrite labor workcenter entries for "Current project"
    stmt(env.DB, 'DELETE FROM cost_build_labor WHERE cost_build_id = ?', [buildId]),
    ...wcRes.value.map((e) =>
      stmt(
        env.DB,
        `INSERT INTO cost_build_labor (cost_build_id, workcenter, hours, rate)
         VALUES (?, ?, ?, ?)`,
        [buildId, e.workcenter, e.hours, e.rate]
      )
    ),

    // Rewrite DM selections
    stmt(env.DB, 'DELETE FROM cost_build_dm_selections WHERE cost_build_id = ?', [buildId]),
    ...dmIds.map((id) =>
      stmt(
        env.DB,
        'INSERT OR IGNORE INTO cost_build_dm_selections (cost_build_id, dm_item_id) VALUES (?, ?)',
        [buildId, id]
      )
    ),

    // Rewrite labor selections
    stmt(env.DB, 'DELETE FROM cost_build_labor_selections WHERE cost_build_id = ?', [buildId]),
    ...laborIds.map((id) =>
      stmt(
        env.DB,
        'INSERT OR IGNORE INTO cost_build_labor_selections (cost_build_id, labor_item_id) VALUES (?, ?)',
        [buildId, id]
      )
    ),

    auditStmt(env.DB, {
      entityType: 'cost_build',
      entityId: buildId,
      eventType: 'updated',
      user,
      summary: `Updated ${value.label || 'price build'}`,
      changes: {
        label: value.label,
        dm_user_cost: value.dm_user_cost,
        dl_user_cost: value.dl_user_cost,
        imoh_user_cost: value.imoh_user_cost,
        other_user_cost: value.other_user_cost,
        quote_price_user: value.quote_price_user,
        use_dm_library: value.use_dm_library,
        use_labor_library: value.use_labor_library,
        dm_selections: dmIds.length,
        labor_selections: laborIds.length,
        current_labor_entries: wcRes.value.length,
      },
    }),
  ];

  await batch(env.DB, statements);

  // Preserve the sub-tab query param so the user lands back on the same
  // panel they were editing.
  const sub = input.sub || 'pricing';
  const target = sub === 'pricing'
    ? `/opportunities/${oppId}/cost-builds/${buildId}`
    : `/opportunities/${oppId}/cost-builds/${buildId}?sub=${encodeURIComponent(sub)}`;

  return redirectWithFlash(target, 'Saved.');
}
