// functions/library/builds/[id]/index.js
//
// GET  /library/builds/:id           — full editor (pricing engine)
// GET  /library/builds/:id?sub=labor — Labor sub-tab
// GET  /library/builds/:id?sub=dm    — Direct Material sub-tab
// POST /library/builds/:id           — save all pricing fields
//
// This is the builds library editor — same pricing engine as the cost
// build editor but for standalone reusable templates. No lock/unlock,
// no opportunity context.

import { one, all, stmt, batch } from '../../../lib/db.js';
import { auditStmt } from '../../../lib/audit.js';
import { validateCostBuild, validateWorkcenterEntries } from '../../../lib/validators.js';
import { layout, htmlResponse, html, escape, raw } from '../../../lib/layout.js';
import { now } from '../../../lib/ids.js';
import { redirectWithFlash, formBody, readFlash } from '../../../lib/http.js';
import {
  loadPricingSettings,
  computeFromBundle,
  workcenterEntryCost,
  fmtDollar,
  fmtPct,
} from '../../../lib/pricing.js';

// =====================================================================
// Bundle loader for builds_library (mirrors loadCostBuildBundle)
// =====================================================================

async function loadBuildsLibraryBundle(db, buildId) {
  const build = await one(db, 'SELECT * FROM builds_library WHERE id = ?', [buildId]);
  if (!build) return null;

  const currentLabor = await all(
    db,
    'SELECT workcenter, hours, rate FROM builds_library_labor WHERE builds_library_id = ?',
    [buildId]
  );

  const dmSelections = await all(
    db,
    `SELECT dm.id, dm.description, dm.cost
       FROM builds_library_dm_selections sel
       JOIN dm_items dm ON dm.id = sel.dm_item_id
      WHERE sel.builds_library_id = ?
      ORDER BY dm.description`,
    [buildId]
  );

  const laborSelectionRows = await all(
    db,
    `SELECT li.id, li.description
       FROM builds_library_labor_selections sel
       JOIN labor_items li ON li.id = sel.labor_item_id
      WHERE sel.builds_library_id = ?
      ORDER BY li.description`,
    [buildId]
  );

  const laborSelections = [];
  for (const li of laborSelectionRows) {
    const entries = await all(
      db,
      'SELECT workcenter, hours, rate FROM labor_item_entries WHERE labor_item_id = ?',
      [li.id]
    );
    laborSelections.push({ ...li, entries });
  }

  return { build, currentLabor, dmSelections, laborSelections };
}

// =====================================================================
// GET handler
// =====================================================================

export async function onRequestGet(context) {
  return renderEditor(context, {});
}

async function renderEditor(context, { values = null, errors = {} } = {}) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const url = new URL(request.url);
  const buildId = params.id;
  const sub = url.searchParams.get('sub') || 'pricing';

  const bundle = await loadBuildsLibraryBundle(env.DB, buildId);
  if (!bundle) {
    return new Response('Build template not found', { status: 404 });
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

  // Load all labor item entries for cost display in the checklist.
  const allLaborEntries = await all(
    env.DB,
    'SELECT labor_item_id, workcenter, hours, rate FROM labor_item_entries'
  );
  const allLaborEntriesById = new Map();
  for (const e of allLaborEntries) {
    if (!allLaborEntriesById.has(e.labor_item_id)) allLaborEntriesById.set(e.labor_item_id, []);
    allLaborEntriesById.get(e.labor_item_id).push(e);
  }

  // If the user previously submitted invalid values, show those in the form.
  const build = values || bundle.build;

  const currentLaborByWc = new Map(
    (bundle.currentLabor || []).map((r) => [r.workcenter, r])
  );

  const errText = (k) => (errors[k] ? html`<small class="error">${errors[k]}</small>` : '');

  // ---------- Pricing sub-tab ----------
  const pricingTabBody = renderPricingSubtab({
    build, pricing, totals, settings, errText,
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
  });

  // ---------- DM sub-tab ----------
  const dmTabBody = renderDmSubtab({
    allDmItems,
    dmSelectedIds,
    dmLibTotal: totals.dmLibTotal,
    useDmLibrary: !!bundle.build.use_dm_library,
  });

  const subNav = html`
    <nav class="card" style="padding: 0.5rem 1rem;">
      <a class="nav-link ${sub === 'pricing' ? 'active' : ''}"
         href="/library/builds/${escape(buildId)}">Pricing engine</a>
      <a class="nav-link ${sub === 'labor' ? 'active' : ''}"
         href="/library/builds/${escape(buildId)}?sub=labor">Labor cost (${fmtDollar(totals.currentLaborTotal + totals.laborLibTotal)})</a>
      <a class="nav-link ${sub === 'dm' ? 'active' : ''}"
         href="/library/builds/${escape(buildId)}?sub=dm">Direct Material (${fmtDollar(totals.dmLibTotal || 0)})</a>
    </nav>`;

  const header = html`
    <section class="card">
      <div class="card-header">
        <div>
          <h1>${escape(build.name || '(unnamed)')}</h1>
          <p class="muted">
            <a href="/library/builds">All build templates</a>
          </p>
        </div>
        <div class="header-actions">
          <form method="post" action="/library/builds/${escape(buildId)}/delete"
                onsubmit="return confirm('Delete this build template? This cannot be undone.')">
            <button class="btn danger" type="submit">Delete</button>
          </form>
        </div>
      </div>
    </section>
  `;

  const body = html`
    ${header}
    ${subNav}
    <form method="post" action="/library/builds/${escape(buildId)}" class="cost-build-form">
      <input type="hidden" name="sub" value="${escape(sub)}">
      <script type="application/json" id="cb-pricing-data">${raw(JSON.stringify({
        targetPct: settings.targetPct,
        totalTargetPct: settings.targetPct.dm + settings.targetPct.dl + settings.targetPct.imoh + settings.targetPct.other,
        marginThresholdGood: settings.marginThresholdGood,
        defaultLaborRate: settings.defaultLaborRate,
      }))}</script>
      <div class="field">
        <label>Name</label>
        <input type="text" name="name" value="${build.name ?? ''}" required>
        ${errText('name')}
      </div>
      <div class="field">
        <label>Description</label>
        <input type="text" name="description" value="${build.description ?? ''}">
      </div>

      <div style="display: ${sub === 'pricing' ? 'block' : 'none'}">${pricingTabBody}</div>
      <div style="display: ${sub === 'labor' ? 'block' : 'none'}">${laborTabBody}</div>
      <div style="display: ${sub === 'dm' ? 'block' : 'none'}">${dmTabBody}</div>

      <div class="field">
        <label>Notes</label>
        <textarea name="notes" rows="3">${escape(build.notes ?? '')}</textarea>
      </div>

      <div class="form-actions">
        <button class="btn primary" type="submit">Save</button>
        <a class="btn" href="/library/builds">Back</a>
      </div>
    </form>
  `;

  return htmlResponse(
    layout(`${build.name || 'Build template'} — Price Builds Library`, body, {
      user,
      env: data?.env,
      activeNav: '/library',
      flash: readFlash(url),
    })
  );
}

// =====================================================================
// Sub-tab renderers (same as price build editor, without locked state)
// =====================================================================

function renderPricingSubtab({ build, pricing, totals, settings, errText }) {
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
               ${disabled ? 'disabled' : ''}
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
        <thead>
          <tr><th>Category</th><th class="num">Cost</th></tr>
        </thead>
        <tbody>
          ${categoryRow('dm',    'Direct Material (DM)',     build.dm_user_cost,    auto.dm,    linked.dm ? notes.dm : (auto.dm !== null ? notes.dm : ''), linked.dm)}
          ${categoryRow('dl',    'Direct Labor (DL)',        build.dl_user_cost,    auto.dl,    linked.labor ? notes.dl : (auto.dl !== null ? notes.dl : ''), linked.labor)}
          ${categoryRow('imoh',  'Indirect Material + OH',   build.imoh_user_cost,  auto.imoh,  auto.imoh !== null ? notes.imoh : '')}
          ${categoryRow('other', 'Other',                    build.other_user_cost, auto.other, auto.other !== null ? notes.other : '')}
        </tbody>
        <tfoot>
          <tr>
            <th>Total cost</th>
            <th class="num" id="cb-total-cost">${fmtDollar(eff.totalCost)}</th>
          </tr>
        </tfoot>
      </table>

      <div class="pricing-grid">
        <div class="pricing-box">
          <div class="muted">Quote price</div>
          <input type="text" name="quote_price_user"
                 value="${valOrAuto(build.quote_price_user, auto.quote)}"
                 class="num-input ${autoClass(build.quote_price_user, auto.quote)}"
                 placeholder="$0">
          ${errText('quote_price_user')}
          ${auto.quote !== null
            ? html`<div class="muted" style="font-size:0.75rem">${escape(notes.quote)}</div>`
            : ''}
        </div>
        <div class="pricing-box">
          <div class="muted">Target price (cost / ${fmtPct(targetPct.total, 1)})</div>
          <div class="pricing-value" id="cb-target-price">${fmtDollar(eff.targetPrice)}</div>
        </div>
        <div class="pricing-box ${marg.status === 'good' ? 'margin-good' : marg.status === 'low' ? 'margin-low' : ''}" id="cb-margin-box">
          <div class="muted">Margin</div>
          <div class="pricing-value" id="cb-margin-value">
            ${marg.amount !== null
              ? html`${fmtDollar(marg.amount)} (${fmtPct(marg.pct)})`
              : '—'}
          </div>
          <div class="muted" id="cb-margin-status" style="font-size:0.75rem">
          ${marg.status
            ? (marg.status === 'good'
                  ? `Good (> ${fmtPct(marg.threshold)})`
                  : `Too low (≤ ${fmtPct(marg.threshold)})`)
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
  useLaborLibrary, laborCalcTotal, errText,
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
                 placeholder="0">
          ${errText(`hours_${wc}`)}
        </td>
        <td class="num">
          <input type="text" name="current_rate[${escape(wc)}]"
                 value="${rate}" class="num-input"
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
        Enter hours per workcenter. Blank rate uses the
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

      <h3 style="margin-top:1rem">Direct Labor library selections</h3>
      <label class="checkbox">
        <input type="checkbox" name="use_labor_library" ${useLaborLibrary ? 'checked' : ''}>
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
                             ${checked ? 'checked' : ''}>
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

function renderDmSubtab({ allDmItems, dmSelectedIds, dmLibTotal, useDmLibrary }) {
  return html`
    <section class="card">
      <h2 class="section-h">Direct Material</h2>
      <p class="muted">
        Check the items from the shared DM library that this build template
        should include. Turn on "link DM to library" to have their sum
        override the Direct Material category on the Pricing tab.
      </p>

      <label class="checkbox">
        <input type="checkbox" name="use_dm_library" ${useDmLibrary ? 'checked' : ''}>
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
                             ${checked ? 'checked' : ''}>
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
  const buildId = params.id;

  const existing = await one(
    env.DB,
    'SELECT * FROM builds_library WHERE id = ?',
    [buildId]
  );
  if (!existing) {
    return new Response('Build template not found', { status: 404 });
  }

  const input = await formBody(request);

  // Validate name (required for builds_library, maps to label in validateCostBuild).
  const name = (input.name || '').trim();
  if (!name) {
    return renderEditor(context, {
      values: { ...existing, ...input },
      errors: { name: 'Name is required' },
    });
  }

  // Reuse the price build validator for the pricing fields.
  // We pass label so validateCostBuild doesn't complain, though we use name.
  const { ok, value, errors } = validateCostBuild({ ...input, label: name });

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

  // Normalize selection arrays.
  const asArray = (v) => v === undefined ? [] : Array.isArray(v) ? v : [v];
  const dmIds = asArray(input.dm_item_ids);
  const laborIds = asArray(input.labor_item_ids);

  const ts = now();
  const description = (input.description || '').trim() || null;

  const statements = [
    stmt(
      env.DB,
      `UPDATE builds_library
          SET name = ?, description = ?, notes = ?,
              dm_user_cost = ?, dl_user_cost = ?, imoh_user_cost = ?, other_user_cost = ?,
              quote_price_user = ?,
              use_dm_library = ?, use_labor_library = ?,
              updated_at = ?
        WHERE id = ?`,
      [
        name,
        description,
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

    // Rewrite labor workcenter entries
    stmt(env.DB, 'DELETE FROM builds_library_labor WHERE builds_library_id = ?', [buildId]),
    ...wcRes.value.map((e) =>
      stmt(
        env.DB,
        `INSERT INTO builds_library_labor (builds_library_id, workcenter, hours, rate)
         VALUES (?, ?, ?, ?)`,
        [buildId, e.workcenter, e.hours, e.rate]
      )
    ),

    // Rewrite DM selections
    stmt(env.DB, 'DELETE FROM builds_library_dm_selections WHERE builds_library_id = ?', [buildId]),
    ...dmIds.map((id) =>
      stmt(
        env.DB,
        'INSERT OR IGNORE INTO builds_library_dm_selections (builds_library_id, dm_item_id) VALUES (?, ?)',
        [buildId, id]
      )
    ),

    // Rewrite labor selections
    stmt(env.DB, 'DELETE FROM builds_library_labor_selections WHERE builds_library_id = ?', [buildId]),
    ...laborIds.map((id) =>
      stmt(
        env.DB,
        'INSERT OR IGNORE INTO builds_library_labor_selections (builds_library_id, labor_item_id) VALUES (?, ?)',
        [buildId, id]
      )
    ),

    auditStmt(env.DB, {
      entityType: 'builds_library',
      entityId: buildId,
      eventType: 'updated',
      user,
      summary: `Updated build template "${name}"`,
      changes: {
        name,
        description,
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

  // Preserve the sub-tab query param.
  const sub = input.sub || 'pricing';
  const target = sub === 'pricing'
    ? `/library/builds/${buildId}`
    : `/library/builds/${buildId}?sub=${encodeURIComponent(sub)}`;

  return redirectWithFlash(target, 'Saved.');
}
