// functions/opportunities/[id]/index.js
//
// GET  /opportunities/:id           — detail (Overview tab by default)
// GET  /opportunities/:id?tab=activity — Activity tab (audit_events feed)
// POST /opportunities/:id           — update from the edit form
//
// Tabs are rendered as simple query-string switches. Later milestones
// will add cost, quotes, docs, job tabs.

import { one, all, stmt, batch } from '../../lib/db.js';
import { auditStmt, diff } from '../../lib/audit.js';
import { validateOpportunity } from '../../lib/validators.js';
import { layout, htmlResponse, html, escape } from '../../lib/layout.js';
import { now } from '../../lib/ids.js';
import { redirectWithFlash, formBody, readFlash } from '../../lib/http.js';
import { loadStageCatalog } from '../../lib/stages.js';

const UPDATE_FIELDS = [
  'title',
  'account_id',
  'primary_contact_id',
  'description',
  'transaction_type',
  'rfq_format',
  'estimated_value_usd',
  'expected_close_date',
  'bant_budget',
  'bant_authority',
  'bant_authority_contact_id',
  'bant_need',
  'bant_timeline',
  'owner_user_id',
  'salesperson_user_id',
];

const TYPE_LABELS = {
  spares: 'Spares',
  eps: 'Engineered Product (EPS)',
  refurb: 'Refurbishment',
  service: 'Service',
};

const RFQ_FORMAT_LABELS = {
  verbal: 'Verbal (phone / in-person)',
  text: 'Text message',
  email_informal: 'Email — informal',
  email_formal: 'Email — formal',
  formal_document: 'Formal RFQ document',
  government_rfq: 'Government RFQ',
  rfi_preliminary: 'RFI / preliminary inquiry',
  none: 'None (proactive outreach)',
  other: 'Other',
};

export async function onRequestGet(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const url = new URL(request.url);
  const oppId = params.id;
  const tab = url.searchParams.get('tab') || 'overview';

  const opp = await one(
    env.DB,
    `SELECT o.*, a.name AS account_name,
            c.first_name AS contact_first, c.last_name AS contact_last,
            c.email AS contact_email, c.phone AS contact_phone,
            auth.first_name AS auth_first, auth.last_name AS auth_last,
            auth.email AS auth_email, auth.title AS auth_title,
            ou.display_name AS owner_name, ou.email AS owner_email,
            sp.display_name AS sp_name, sp.email AS sp_email
       FROM opportunities o
       LEFT JOIN accounts  a    ON a.id    = o.account_id
       LEFT JOIN contacts  c    ON c.id    = o.primary_contact_id
       LEFT JOIN contacts  auth ON auth.id = o.bant_authority_contact_id
       LEFT JOIN users     ou   ON ou.id   = o.owner_user_id
       LEFT JOIN users     sp   ON sp.id   = o.salesperson_user_id
      WHERE o.id = ?`,
    [oppId]
  );
  if (!opp) return notFound(context);

  const catalog = await loadStageCatalog(env.DB);
  const typeStages = catalog.get(opp.transaction_type) ?? [];
  const currentStage = typeStages.find((s) => s.stage_key === opp.stage);
  const currentSort = currentStage?.sort_order ?? 0;

  // Account contacts for the primary-contact dropdown in edit, and also
  // to render the contact strip under the header.
  const contacts = await all(
    env.DB,
    `SELECT id, first_name, last_name, title, email, phone, is_primary
       FROM contacts
      WHERE account_id = ?
      ORDER BY is_primary DESC, last_name, first_name`,
    [opp.account_id]
  );

  // Activity feed — this opportunity's own audit events. Later we'll
  // widen this to include child entities (cost builds, quotes, documents,
  // job events) via entity_id IN (...) unions.
  const events = await all(
    env.DB,
    `SELECT ae.event_type, ae.at, ae.summary, ae.changes_json, ae.override_reason,
            u.email AS user_email, u.display_name AS user_name
       FROM audit_events ae
       LEFT JOIN users u ON u.id = ae.user_id
      WHERE ae.entity_type = 'opportunity' AND ae.entity_id = ?
      ORDER BY ae.at DESC
      LIMIT 200`,
    [oppId]
  );

  const primaryContactName = [opp.contact_first, opp.contact_last].filter(Boolean).join(' ');
  const authorityName = [opp.auth_first, opp.auth_last].filter(Boolean).join(' ');
  const ownerLabel = opp.owner_name ?? opp.owner_email ?? '—';
  const salespersonLabel = opp.sp_name ?? opp.sp_email ?? '—';

  // Build the stage picker as a button strip. Every stage for this
  // transaction_type is rendered in order — upstream (already-passed)
  // stages are selectable but rendered muted, the current stage is
  // highlighted and disabled, downstream/terminal stages are primary
  // buttons. Clicking a button submits the single stage-move form
  // with that stage as `to_stage` (each <button> uses name=to_stage value=...).
  const stageButtons = typeStages.map((s) => {
    const isCurrent = s.stage_key === opp.stage;
    const isUpstream = s.sort_order < currentSort;
    const isTerminalLoss = s.stage_key === 'closed_lost' || s.stage_key === 'closed_died';
    let cls = 'btn stage-btn';
    if (isCurrent) cls += ' stage-btn-current';
    else if (isUpstream) cls += ' stage-btn-upstream';
    else if (isTerminalLoss) cls += ' stage-btn-loss';
    else if (s.is_won) cls += ' stage-btn-won';
    else cls += ' stage-btn-next';
    return html`
      <button type="submit" name="to_stage" value="${s.stage_key}"
              class="${cls}" ${isCurrent ? 'disabled aria-current="step"' : ''}>
        ${s.label}
      </button>`;
  });

  const estValueDisplay = opp.estimated_value_usd != null
    ? `$${formatMoney(opp.estimated_value_usd)}`
    : null;

  const overviewTab = html`
    <section class="card">
      <div class="card-header">
        <div>
          <h1>
            ${opp.title}
            ${estValueDisplay
              ? html` <span class="header-value">${estValueDisplay}</span>`
              : ''}
          </h1>
          <p class="muted">
            <code>${escape(opp.number)}</code>
            · <a href="/accounts/${escape(opp.account_id)}">${escape(opp.account_name ?? '—')}</a>
            · ${escape(TYPE_LABELS[opp.transaction_type] ?? opp.transaction_type)}
            · <span class="pill">${escape(currentStage?.label ?? opp.stage)}</span>
            ${opp.probability != null ? html` · ${opp.probability}%` : ''}
          </p>
        </div>
        <div class="header-actions">
          <a class="btn" href="/opportunities/${escape(opp.id)}/edit">Edit</a>
        </div>
      </div>

      <form method="post" action="/opportunities/${escape(opp.id)}/stage" class="stage-picker">
        <div class="stage-strip">
          ${stageButtons}
        </div>
        <label class="stage-reason">
          <span class="muted" style="font-size: 0.85rem;">Override reason (optional, recorded in audit)</span>
          <input type="text" name="override_reason"
                 placeholder="e.g. Client escalated to verbal; paperwork pending">
        </label>
      </form>

      <div class="addr-grid">
        <div>
          <strong>Estimated value</strong>
          <p class="muted" style="margin: 0.2rem 0 0">
            ${opp.estimated_value_usd != null
              ? `$${formatMoney(opp.estimated_value_usd)} ${escape(opp.currency ?? 'USD')}`
              : '—'}
          </p>
        </div>
        <div>
          <strong>Expected close</strong>
          <p class="muted" style="margin: 0.2rem 0 0">${escape(opp.expected_close_date ?? '—')}</p>
        </div>
        <div>
          <strong>RFQ format</strong>
          <p class="muted" style="margin: 0.2rem 0 0">
            ${escape(RFQ_FORMAT_LABELS[opp.rfq_format] ?? (opp.rfq_format ?? '—'))}
          </p>
        </div>
        <div>
          <strong>Owner</strong>
          <p class="muted" style="margin: 0.2rem 0 0">${escape(ownerLabel)}</p>
        </div>
        <div>
          <strong>Salesperson</strong>
          <p class="muted" style="margin: 0.2rem 0 0">${escape(salespersonLabel)}</p>
        </div>
        <div>
          <strong>Primary contact</strong>
          <p class="muted" style="margin: 0.2rem 0 0">
            ${primaryContactName ? escape(primaryContactName) : '—'}
            ${opp.contact_email ? html` · <a href="mailto:${escape(opp.contact_email)}">${opp.contact_email}</a>` : ''}
          </p>
        </div>
      </div>

      ${opp.description
        ? html`
          <div style="margin-top: 1rem;">
            <strong>Description</strong>
            <p class="notes">${escape(opp.description)}</p>
          </div>`
        : ''}

      <div style="margin-top: 1rem;">
        <strong>Qualification</strong>
        <ul class="plain">
          <li><strong>Budget:</strong> ${escape(opp.bant_budget ?? '—')}</li>
          <li>
            <strong>Authority:</strong>
            ${authorityName
              ? html`${escape(authorityName)}${opp.auth_title ? html` <span class="muted">(${escape(opp.auth_title)})</span>` : ''}${opp.auth_email ? html` · <a href="mailto:${escape(opp.auth_email)}">${escape(opp.auth_email)}</a>` : ''}`
              : opp.bant_authority
                ? html`<span class="muted">${escape(opp.bant_authority)}</span>`
                : '—'}
          </li>
          <li><strong>Need:</strong> ${escape(opp.bant_need ?? '—')}</li>
          <li><strong>Timeline:</strong> ${escape(opp.bant_timeline ?? '—')}</li>
        </ul>
      </div>
    </section>

    ${contacts.length > 0
      ? html`
        <section class="card">
          <div class="card-header">
            <h2>Contacts on ${escape(opp.account_name ?? 'this account')}</h2>
            <a class="btn" href="/accounts/${escape(opp.account_id)}/contacts/new">Add contact</a>
          </div>
          <table class="data">
            <thead>
              <tr>
                <th>Name</th>
                <th>Title</th>
                <th>Email</th>
                <th>Phone</th>
                <th>Primary</th>
              </tr>
            </thead>
            <tbody>
              ${contacts.map((c) => {
                const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || '(no name)';
                return html`
                  <tr>
                    <td><strong>${escape(name)}</strong></td>
                    <td>${escape(c.title ?? '')}</td>
                    <td>${c.email
                      ? html`<a href="mailto:${escape(c.email)}">${escape(c.email)}</a>`
                      : ''}</td>
                    <td>${escape(c.phone ?? '')}</td>
                    <td>${c.is_primary
                      ? html`<span class="pill pill-success">primary</span>`
                      : ''}</td>
                  </tr>`;
              })}
            </tbody>
          </table>
        </section>`
      : ''}
  `;

  const activityTab = html`
    <section class="card">
      <h2>Activity</h2>
      ${events.length === 0
        ? html`<p class="muted">No activity recorded yet.</p>`
        : html`
          <ul class="activity">
            ${events.map((e) => {
              const who = e.user_name ?? e.user_email ?? 'system';
              const when = formatTimestamp(e.at);
              const summary = e.summary ?? `${e.event_type}`;
              const changes = parseChangeList(e.changes_json);
              return html`
                <li>
                  <div class="activity-head">
                    <strong>${escape(who)}</strong>
                    <span class="activity-type">${escape(e.event_type)}</span>
                    <span class="activity-when muted">${escape(when)}</span>
                  </div>
                  <div>${escape(summary)}</div>
                  ${e.override_reason
                    ? html`<div class="activity-changes"><small class="muted">Override reason: ${escape(e.override_reason)}</small></div>`
                    : ''}
                  ${changes
                    ? html`<div class="activity-changes"><small class="muted">Changed: ${changes.map((k, i) => html`${i > 0 ? ', ' : ''}<code>${escape(k)}</code>`)}</small></div>`
                    : ''}
                </li>`;
            })}
          </ul>
        `}
    </section>
  `;

  const tabs = html`
    <nav class="card" style="padding: 0.5rem 1rem;">
      <a class="nav-link ${tab === 'overview' ? 'active' : ''}" href="/opportunities/${escape(opp.id)}">Overview</a>
      <a class="nav-link ${tab === 'activity' ? 'active' : ''}" href="/opportunities/${escape(opp.id)}?tab=activity">Activity (${events.length})</a>
    </nav>
  `;

  const body = html`${tabs}${tab === 'activity' ? activityTab : overviewTab}`;

  return htmlResponse(
    layout(`${opp.number} — ${opp.title}`, body, {
      user,
      env: data?.env,
      activeNav: '/opportunities',
      flash: readFlash(url),
    })
  );
}

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const oppId = params.id;

  const before = await one(env.DB, `SELECT * FROM opportunities WHERE id = ?`, [oppId]);
  if (!before) return notFound(context);

  const input = await formBody(request);
  const { ok, value, errors } = validateOpportunity(input);
  if (!ok) {
    const { renderEditForm } = await import('./edit.js');
    return renderEditForm(context, {
      opportunity: { ...before, ...input },
      errors,
    });
  }

  const ts = now();
  const after = { ...value };
  const changes = diff(before, after, UPDATE_FIELDS);

  await batch(env.DB, [
    stmt(
      env.DB,
      `UPDATE opportunities
          SET title = ?, account_id = ?, primary_contact_id = ?, description = ?,
              transaction_type = ?, rfq_format = ?,
              estimated_value_usd = ?, expected_close_date = ?,
              bant_budget = ?, bant_authority = ?, bant_authority_contact_id = ?,
              bant_need = ?, bant_timeline = ?,
              owner_user_id = ?, salesperson_user_id = ?,
              updated_at = ?
        WHERE id = ?`,
      [
        value.title,
        value.account_id,
        value.primary_contact_id,
        value.description,
        value.transaction_type,
        value.rfq_format,
        value.estimated_value_usd,
        value.expected_close_date,
        value.bant_budget,
        value.bant_authority,
        value.bant_authority_contact_id,
        value.bant_need,
        value.bant_timeline,
        value.owner_user_id,
        value.salesperson_user_id,
        ts,
        oppId,
      ]
    ),
    auditStmt(env.DB, {
      entityType: 'opportunity',
      entityId: oppId,
      eventType: 'updated',
      user,
      summary: `Updated ${before.number}`,
      changes,
    }),
  ]);

  return redirectWithFlash(`/opportunities/${oppId}`, `Saved.`);
}

// -- helpers ---------------------------------------------------------------

function formatMoney(n) {
  return Math.round(Number(n)).toLocaleString('en-US');
}

function formatTimestamp(iso) {
  if (!iso) return '';
  return iso.replace('T', ' ').replace(/\.\d+Z?$/, '').slice(0, 16);
}

function parseChangeList(json) {
  if (!json) return null;
  let obj;
  try { obj = JSON.parse(json); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  const keys = Object.keys(obj);
  if (!keys.length) return null;
  // Diff shape? Return just the keys.
  const isDiff = keys.every(
    (k) => obj[k] && typeof obj[k] === 'object' && 'from' in obj[k] && 'to' in obj[k]
  );
  return isDiff ? keys : null;
}

function notFound(context) {
  const { data } = context;
  return htmlResponse(
    layout(
      'Opportunity not found',
      `<section class="card">
        <h1>Opportunity not found</h1>
        <p><a href="/opportunities">Back to opportunities</a></p>
      </section>`,
      { user: data?.user, env: data?.env, activeNav: '/opportunities' }
    ),
    { status: 404 }
  );
}
