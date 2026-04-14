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
import { validateOpportunity, parseTransactionTypes } from '../lib/validators.js';
import { uuid, now, nextSequenceValue } from '../lib/ids.js';
import { layout, htmlResponse, html, raw, escape } from '../lib/layout.js';
import { redirectWithFlash, formBody, readFlash } from '../lib/http.js';
import { loadStageCatalog } from '../lib/stages.js';
import { listScript, listTableHead, listToolbar, columnsMenu, rowDataAttrs } from '../lib/list-table.js';

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

  // No server-side filter form — all filtering happens in the table
  // controller (per-column + quick search). Pull every row up to a
  // generous limit and let the client narrow it down.
  const rows = await all(
    env.DB,
    `SELECT o.id, o.number, o.title, o.transaction_type, o.stage,
            o.estimated_value_usd, o.probability,
            o.created_at, o.updated_at,
            o.expected_close_date, o.rfq_received_date, o.rfq_due_date,
            o.rfi_due_date, o.quoted_date,
            a.name AS account_name, a.id AS account_id
       FROM opportunities o
       LEFT JOIN accounts a ON a.id = o.account_id
      ORDER BY o.updated_at DESC
      LIMIT 500`
  );

  // Stage catalog gives us per-row label rendering. Cached in lib/stages.js.
  const catalog = await loadStageCatalog(env.DB);

  // Column catalog — label, key, filter type, default visibility. The
  // client-side controller lets the user toggle visibility, reorder,
  // sort, and filter per column, and persists the state to localStorage
  // under `pms.oppList.v1`. The table itself is server-rendered so the
  // page is useful even without JS.
  const columns = [
    { key: 'number',       label: 'Number',       sort: 'number', filter: 'text',   default: true },
    { key: 'title',        label: 'Title',        sort: 'text',   filter: 'text',   default: true },
    { key: 'account_name', label: 'Account',      sort: 'text',   filter: 'text',   default: true },
    { key: 'type_label',   label: 'Type',         sort: 'text',   filter: 'select', default: true },
    { key: 'stage_label',  label: 'Stage',        sort: 'text',   filter: 'select', default: true },
    { key: 'value',        label: 'Value',        sort: 'number', filter: 'range',  default: true },
    { key: 'close',        label: 'Close',        sort: 'date',   filter: 'text',   default: true },
    { key: 'updated',      label: 'Updated',      sort: 'date',   filter: 'text',   default: true },
    { key: 'created',      label: 'Created',      sort: 'date',   filter: 'text',   default: false },
    { key: 'rfq_received', label: 'RFQ received', sort: 'date',   filter: 'text',   default: false },
    { key: 'rfq_due',      label: 'RFQ due',      sort: 'date',   filter: 'text',   default: false },
    { key: 'rfi_due',      label: 'RFI due',      sort: 'date',   filter: 'text',   default: false },
    { key: 'quoted',       label: 'Quoted',       sort: 'date',   filter: 'text',   default: false },
  ];

  // Shape rows once so each <tr> knows its sort/filter values and the
  // controller can read them off data- attributes without parsing text.
  const rowData = rows.map((r) => ({
    id: r.id,
    number: r.number ?? '',
    title: r.title ?? '',
    account_id: r.account_id ?? '',
    account_name: r.account_name ?? '',
    type_label: parseTransactionTypes(r.transaction_type).map(t => TYPE_LABELS[t] ?? t).join(', ') || '—',
    stage_label: stageLabel(catalog, parseTransactionTypes(r.transaction_type)[0] ?? 'spares', r.stage),
    value: r.estimated_value_usd == null ? '' : Number(r.estimated_value_usd),
    value_display:
      r.estimated_value_usd != null ? `$${formatMoney(r.estimated_value_usd)}` : '',
    close: r.expected_close_date ?? '',
    updated: (r.updated_at ?? '').slice(0, 10),
    created: (r.created_at ?? '').slice(0, 10),
    rfq_received: r.rfq_received_date ?? '',
    rfq_due: r.rfq_due_date ?? '',
    rfi_due: r.rfi_due_date ?? '',
    quoted: r.quoted_date ?? '',
  }));

  const body = html`
    <section class="card">
      <div class="card-header">
        <h1 class="page-title">Opportunities</h1>
        ${listToolbar({ id: 'opp', count: rows.length, newHref: '/opportunities/new', newLabel: 'New opportunity' })}
      </div>

      ${rows.length === 0
        ? html`<p class="muted">
            No opportunities match. Start by
            <a href="/opportunities/new">creating one</a>.
          </p>`
        : html`
          <div class="opp-list" data-columns="${escape(JSON.stringify(columns))}">
            ${columnsMenu(columns)}
            <table class="data opp-list-table">
              ${listTableHead(columns, rowData)}
              <tbody data-role="rows">
                ${rowData.map(
                  (r) => html`
                    <tr data-row-id="${escape(r.id)}"
                        data-number="${escape(r.number)}"
                        data-title="${escape(r.title)}"
                        data-account_name="${escape(r.account_name)}"
                        data-type_label="${escape(r.type_label)}"
                        data-stage_label="${escape(r.stage_label)}"
                        data-value="${escape(r.value === '' ? '' : String(r.value))}"
                        data-close="${escape(r.close)}"
                        data-updated="${escape(r.updated)}"
                        data-created="${escape(r.created)}"
                        data-rfq_received="${escape(r.rfq_received)}"
                        data-rfq_due="${escape(r.rfq_due)}"
                        data-rfi_due="${escape(r.rfi_due)}"
                        data-quoted="${escape(r.quoted)}">
                      <td class="col-number" data-col="number"><a href="/opportunities/${escape(r.id)}"><code>${escape(r.number)}</code></a></td>
                      <td class="col-title" data-col="title">
                        <a href="/opportunities/${escape(r.id)}"><strong>${escape(r.title)}</strong></a>
                      </td>
                      <td class="col-account_name" data-col="account_name">
                        ${r.account_id
                          ? html`<a href="/accounts/${escape(r.account_id)}">${escape(r.account_name || '—')}</a>`
                          : html`<span class="muted">—</span>`}
                      </td>
                      <td class="col-type_label" data-col="type_label">${escape(r.type_label)}</td>
                      <td class="col-stage_label" data-col="stage_label">${escape(r.stage_label)}</td>
                      <td class="col-value" data-col="value">${escape(r.value_display)}</td>
                      <td class="col-close" data-col="close"><small class="muted">${escape(r.close)}</small></td>
                      <td class="col-updated" data-col="updated"><small class="muted">${escape(r.updated)}</small></td>
                      <td class="col-created" data-col="created"><small class="muted">${escape(r.created)}</small></td>
                      <td class="col-rfq_received" data-col="rfq_received"><small class="muted">${escape(r.rfq_received)}</small></td>
                      <td class="col-rfq_due" data-col="rfq_due"><small class="muted">${escape(r.rfq_due)}</small></td>
                      <td class="col-rfi_due" data-col="rfi_due"><small class="muted">${escape(r.rfi_due)}</small></td>
                      <td class="col-quoted" data-col="quoted"><small class="muted">${escape(r.quoted)}</small></td>
                    </tr>`
                )}
              </tbody>
            </table>
          </div>
          <script>${raw(listScript('pms.oppList.v1'))}</script>
        `}
    </section>
  `;

  return htmlResponse(
    layout('Opportunities', body, {
      user,
      env: data?.env,
      activeNav: '/opportunities',
      flash: readFlash(url),
      breadcrumbs: [
        { label: 'Opportunities' },
      ],
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

  // Number: if the user typed one, use it as-is (UNIQUE index catches
  // collisions below). Otherwise allocate the next sequential value from
  // the 'opportunity' scope and zero-pad it to 5 digits (25001+).
  let number = value.number;
  if (!number) {
    const allocated = await nextSequenceValue(env.DB, 'opportunity');
    number = String(allocated).padStart(5, '0');
  }

  // Default starting stage is 'lead'. Probability defaults from the stage
  // catalog if the user didn't provide an explicit override.
  const catalog = await loadStageCatalog(env.DB);
  const primaryType = parseTransactionTypes(value.transaction_type)[0] ?? 'spares';
  const typeStages = catalog.get(primaryType) ?? [];
  const leadStage = typeStages.find((s) => s.stage_key === 'lead');
  const probability = value.probability != null
    ? value.probability
    : (leadStage?.default_probability ?? 0);

  try {
    await batch(env.DB, [
      stmt(
        env.DB,
        `INSERT INTO opportunities
           (id, number, account_id, primary_contact_id, title, description,
            transaction_type, stage, stage_entered_at, probability,
            estimated_value_usd, currency,
            expected_close_date, rfq_received_date, rfq_due_date,
            rfi_due_date, quoted_date,
            rfq_format, source,
            bant_budget, bant_authority, bant_authority_contact_id,
            bant_need, bant_timeline,
            owner_user_id, salesperson_user_id,
            created_at, updated_at, created_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          value.rfq_received_date,
          value.rfq_due_date,
          value.rfi_due_date,
          value.quoted_date,
          value.rfq_format,
          value.source,
          value.bant_budget,
          value.bant_authority,
          value.bant_authority_contact_id,
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
  } catch (e) {
    if (isUniqueNumberError(e)) {
      const { renderNewForm } = await import('./new.js');
      return renderNewForm(context, {
        values: input,
        errors: { number: 'That number is already in use' },
      });
    }
    throw e;
  }

  return redirectWithFlash(
    `/opportunities/${id}`,
    `Opportunity ${number} created.`
  );
}

function isUniqueNumberError(e) {
  const msg = String(e?.message ?? e ?? '');
  return /UNIQUE/i.test(msg) && /opportunities\.number|opportunities_number|\.number/i.test(msg);
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

