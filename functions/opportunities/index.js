// functions/opportunities/index.js
//
// GET  /opportunities   — list with filters (?q, ?type, ?stage, ?account)
// POST /opportunities   — create a new opportunity
//
// M3 keeps the list simple: one flat table, a few dropdown filters,
// and a full-text LIKE over title/number/description. Stage labels
// come from the stage_definitions table so adding a stage later
// doesn't require touching this route.

import { all, one, stmt, batch } from '../lib/db.js';
import { auditStmt } from '../lib/audit.js';
import { validateOpportunity, ENUMS } from '../lib/validators.js';
import { uuid, now, nextNumber, currentYear } from '../lib/ids.js';
import { layout, htmlResponse, html, raw, escape } from '../lib/layout.js';
import { redirectWithFlash, formBody, readFlash } from '../lib/http.js';
import { loadStageCatalog } from '../lib/stages.js';

const TYPE_LABELS = {
  spares: 'Spares',
  eps: 'Engineered Product (EPS)',
  refurb: 'Refurbishment',
  service: 'Service',
};

export async function onRequestGet(context) {
  const { env, data, request } = context;
  const user = data?.user;
  const url = new URL(request.url);

  const q = (url.searchParams.get('q') || '').trim();
  const typeFilter = (url.searchParams.get('type') || '').trim();
  const stageFilter = (url.searchParams.get('stage') || '').trim();
  const accountFilter = (url.searchParams.get('account') || '').trim();

  // Build the WHERE clause dynamically. Keep it paranoid: only accept
  // known enum values so we never splice user input into SQL.
  const where = [];
  const params = [];
  if (q) {
    where.push('(o.title LIKE ? COLLATE NOCASE OR o.number LIKE ? COLLATE NOCASE OR o.description LIKE ? COLLATE NOCASE)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (typeFilter && ENUMS.TRANSACTION_TYPES.has(typeFilter)) {
    where.push('o.transaction_type = ?');
    params.push(typeFilter);
  }
  if (stageFilter) {
    where.push('o.stage = ?');
    params.push(stageFilter);
  }
  if (accountFilter) {
    where.push('o.account_id = ?');
    params.push(accountFilter);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = await all(
    env.DB,
    `SELECT o.id, o.number, o.title, o.transaction_type, o.stage,
            o.estimated_value_usd, o.probability, o.updated_at,
            o.expected_close_date,
            a.name AS account_name, a.id AS account_id
       FROM opportunities o
       LEFT JOIN accounts a ON a.id = o.account_id
       ${whereSql}
      ORDER BY o.updated_at DESC
      LIMIT 200`,
    params
  );

  // Pull stage catalog (for the filter dropdown) and accounts list (for
  // the account filter). Catalog is cached in lib/stages.js.
  const [catalog, accounts] = await Promise.all([
    loadStageCatalog(env.DB),
    all(env.DB, 'SELECT id, name FROM accounts ORDER BY name'),
  ]);

  // Flatten stage keys across all transaction types, de-duped, for the filter.
  // Sort order uses the spares catalog (all four share the same shared-early
  // stage sequence, with the same keys).
  const stageKeysSeen = new Map();
  for (const stages of catalog.values()) {
    for (const s of stages) {
      if (!stageKeysSeen.has(s.stage_key)) {
        stageKeysSeen.set(s.stage_key, { key: s.stage_key, label: s.label, sort_order: s.sort_order });
      }
    }
  }
  const stageOptions = Array.from(stageKeysSeen.values()).sort((a, b) => a.sort_order - b.sort_order);

  const body = html`
    <section class="card">
      <div class="card-header">
        <h1>Opportunities</h1>
        <a class="btn primary" href="/opportunities/new">New opportunity</a>
      </div>

      <form method="get" action="/opportunities" class="inline-form">
        <input type="search" name="q" value="${escape(q)}"
               placeholder="Search title, number, description">
        <select name="type">
          <option value="">All types</option>
          ${Object.entries(TYPE_LABELS).map(
            ([k, label]) =>
              html`<option value="${k}" ${typeFilter === k ? 'selected' : ''}>${label}</option>`
          )}
        </select>
        <select name="stage">
          <option value="">All stages</option>
          ${stageOptions.map(
            (s) =>
              html`<option value="${s.key}" ${stageFilter === s.key ? 'selected' : ''}>${s.label}</option>`
          )}
        </select>
        <select name="account">
          <option value="">All accounts</option>
          ${accounts.map(
            (a) =>
              html`<option value="${escape(a.id)}" ${accountFilter === a.id ? 'selected' : ''}>${a.name}</option>`
          )}
        </select>
        <button class="btn" type="submit">Filter</button>
        ${q || typeFilter || stageFilter || accountFilter
          ? html`<a class="btn" href="/opportunities">Clear</a>`
          : ''}
      </form>

      ${rows.length === 0
        ? html`<p class="muted">
            No opportunities match. Start by
            <a href="/opportunities/new">creating one</a>.
          </p>`
        : html`
          <table class="data">
            <thead>
              <tr>
                <th>Number</th>
                <th>Title</th>
                <th>Account</th>
                <th>Type</th>
                <th>Stage</th>
                <th>Value</th>
                <th>Close</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map(
                (r) => html`
                  <tr>
                    <td><code>${escape(r.number)}</code></td>
                    <td><a href="/opportunities/${escape(r.id)}"><strong>${escape(r.title)}</strong></a></td>
                    <td>${r.account_id
                      ? html`<a href="/accounts/${escape(r.account_id)}">${escape(r.account_name ?? '—')}</a>`
                      : html`<span class="muted">—</span>`}</td>
                    <td>${escape(TYPE_LABELS[r.transaction_type] ?? r.transaction_type)}</td>
                    <td>${escape(stageLabel(catalog, r.transaction_type, r.stage))}</td>
                    <td>${r.estimated_value_usd != null ? `$${formatMoney(r.estimated_value_usd)}` : ''}</td>
                    <td><small class="muted">${escape(r.expected_close_date ?? '')}</small></td>
                  </tr>`
              )}
            </tbody>
          </table>
        `}
    </section>
  `;

  return htmlResponse(
    layout('Opportunities', body, {
      user,
      env: data?.env,
      activeNav: '/opportunities',
      flash: readFlash(url),
    })
  );
}

export async function onRequestPost(context) {
  const { env, data, request } = context;
  const user = data?.user;
  const input = await formBody(request);

  const { ok, value, errors } = validateOpportunity(input);
  if (!ok) {
    const { renderNewForm } = await import('./new.js');
    return renderNewForm(context, { values: input, errors });
  }

  // Confirm account exists — cheap sanity check so an FK error doesn't
  // blow up mid-batch with a cryptic D1 error.
  const acct = await one(env.DB, 'SELECT id, name FROM accounts WHERE id = ?', [value.account_id]);
  if (!acct) {
    const { renderNewForm } = await import('./new.js');
    return renderNewForm(context, {
      values: input,
      errors: { account_id: 'Account not found' },
    });
  }

  const id = uuid();
  const ts = now();
  const number = await nextNumber(env.DB, `OPP-${currentYear()}`);

  // Default starting stage is 'lead'. Default probability copied from
  // the stage catalog so the UI has something sensible to show.
  const catalog = await loadStageCatalog(env.DB);
  const typeStages = catalog.get(value.transaction_type) ?? [];
  const leadStage = typeStages.find((s) => s.stage_key === 'lead');
  const probability = leadStage?.default_probability ?? 0;

  await batch(env.DB, [
    stmt(
      env.DB,
      `INSERT INTO opportunities
         (id, number, account_id, primary_contact_id, title, description,
          transaction_type, stage, stage_entered_at, probability,
          estimated_value_usd, currency, expected_close_date,
          rfq_format, bant_budget, bant_authority, bant_need, bant_timeline,
          owner_user_id, salesperson_user_id,
          created_at, updated_at, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        number,
        value.account_id,
        value.primary_contact_id,
        value.title,
        value.description,
        value.transaction_type,
        'lead',
        ts,
        probability,
        value.estimated_value_usd,
        'USD',
        value.expected_close_date,
        value.rfq_format,
        value.bant_budget,
        value.bant_authority,
        value.bant_need,
        value.bant_timeline,
        value.owner_user_id ?? user?.id ?? null,
        value.salesperson_user_id ?? user?.id ?? null,
        ts,
        ts,
        user?.id ?? null,
      ]
    ),
    auditStmt(env.DB, {
      entityType: 'opportunity',
      entityId: id,
      eventType: 'created',
      user,
      summary: `Created ${number}: "${value.title}" for ${acct.name}`,
      changes: {
        ...value,
        number,
        stage: 'lead',
      },
    }),
  ]);

  return redirectWithFlash(
    `/opportunities/${id}`,
    `Opportunity ${number} created.`
  );
}

// -- helpers ---------------------------------------------------------------

function stageLabel(catalog, txType, stageKey) {
  const list = catalog.get(txType) ?? [];
  const def = list.find((s) => s.stage_key === stageKey);
  return def?.label ?? stageKey;
}

function formatMoney(n) {
  // Keep it boring: integer US dollars with thousands separators.
  return Math.round(Number(n)).toLocaleString('en-US');
}
