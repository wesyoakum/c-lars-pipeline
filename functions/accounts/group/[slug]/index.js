// functions/accounts/group/[slug]/index.js
//
// GET /accounts/group/:slug — Synthetic rollup page for a parent group.
//
// There is no `groups` table. `accounts.parent_group` is just a free-
// text label, and this route computes a read-only rollup by loading
// every account whose `parent_group` slugifies to `:slug`, then
// aggregating their contacts, opportunities, and open quote value.
//
// The rollup is deliberately thin: it links out to the real account
// and opportunity pages for anything interactive. A group is not a
// first-class entity — contacts, addresses, terms, and stages all
// live on the real accounts.

import { all } from '../../../lib/db.js';
import { layout, htmlResponse, html, raw, escape } from '../../../lib/layout.js';
import { readFlash } from '../../../lib/http.js';
import { findGroupMembers } from '../../../lib/account-groups.js';
import { parseTransactionTypes } from '../../../lib/validators.js';
import { loadStageCatalog } from '../../../lib/stages.js';
import { listScript, listTableHead, listToolbar, rowDataAttrs } from '../../../lib/list-table.js';
import { ieText, ieSelect, listInlineEditScript } from '../../../lib/list-inline-edit.js';

// Keep in sync with functions/accounts/index.js::SEGMENT_OPTIONS. The
// member table on this page reuses it for inline segment editing.
const SEGMENT_OPTIONS = [
  { value: '',           label: '\u2014 None \u2014' },
  { value: 'WROV',       label: 'WROV' },
  { value: 'Research',   label: 'Research' },
  { value: 'Defense',    label: 'Defense' },
  { value: 'Commercial', label: 'Commercial' },
  { value: 'Other',      label: 'Other' },
];

const TYPE_LABELS = {
  spares: 'Spares',
  eps: 'New Product',
  refurb: 'Refurbishment',
  service: 'Service',
};

function formatMoney(n) {
  const num = Number(n ?? 0);
  return num.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

function stageLabel(catalog, txType, stageKey) {
  if (!stageKey) return '';
  const forType = catalog?.[txType] || catalog?.spares || [];
  const hit = forType.find((s) => s.key === stageKey);
  return hit?.label || stageKey;
}

export async function onRequestGet(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const url = new URL(request.url);
  const slug = params.slug;

  const group = await findGroupMembers(env, slug);
  if (!group) {
    return htmlResponse(
      layout(
        'Group not found',
        html`<section class="card">
          <h1>Group not found</h1>
          <p class="muted">No accounts are currently tagged with this parent group label.</p>
          <p><a href="/accounts">Back to accounts</a></p>
        </section>`,
        { user, env: data?.env, activeNav: '/accounts' }
      ),
      { status: 404 }
    );
  }

  const memberIds = group.accounts.map((a) => a.id);
  const placeholders = memberIds.map(() => '?').join(',');

  // Per-account counts for the member table.
  const counts = await all(
    env.DB,
    `SELECT a.id,
            (SELECT COUNT(*) FROM contacts c WHERE c.account_id = a.id)      AS contact_count,
            (SELECT COUNT(*) FROM opportunities o WHERE o.account_id = a.id) AS opp_count
       FROM accounts a
      WHERE a.id IN (${placeholders})`,
    memberIds
  );
  const countById = new Map(counts.map((c) => [c.id, c]));

  // Every opportunity across the member accounts.
  const opps = memberIds.length
    ? await all(
        env.DB,
        `SELECT o.id, o.number, o.title, o.transaction_type, o.stage,
                o.estimated_value_usd, o.updated_at,
                a.id AS account_id, a.name AS account_name, a.alias AS account_alias
           FROM opportunities o
           JOIN accounts a ON a.id = o.account_id
          WHERE o.account_id IN (${placeholders})
          ORDER BY o.updated_at DESC`,
        memberIds
      )
    : [];

  // Open quote rollup (issued/revision_issued quotes, summed value).
  const openQuoteRow = memberIds.length
    ? await all(
        env.DB,
        `SELECT COUNT(*) AS open_quote_count, COALESCE(SUM(q.total_price), 0) AS open_quote_value
           FROM quotes q
           JOIN opportunities o ON o.id = q.opportunity_id
          WHERE o.account_id IN (${placeholders})
            AND q.status IN ('issued', 'revision_issued')`,
        memberIds
      )
    : [{ open_quote_count: 0, open_quote_value: 0 }];
  const openQuoteStats = openQuoteRow[0] || { open_quote_count: 0, open_quote_value: 0 };

  const catalog = await loadStageCatalog(env.DB);

  const totalContacts = counts.reduce((n, c) => n + (c.contact_count || 0), 0);
  const totalOpps = counts.reduce((n, c) => n + (c.opp_count || 0), 0);
  const totalOppValue = opps.reduce(
    (n, o) => n + (Number(o.estimated_value_usd) || 0),
    0
  );

  const body = html`
    <section class="card" x-data="groupInline('${escape(slug)}')">
      <div class="card-header">
        <div>
          <h1 class="page-title">
            <span class="ie ie-group-label" data-field="label" data-type="text">
              <span class="ie-display">${escape(group.label)}</span>
            </span>
          </h1>
          <div class="muted" style="font-size:0.9em;margin-top:0.15rem">
            Group rollup across ${group.accounts.length} account${group.accounts.length === 1 ? '' : 's'}
            \u2014 click the name above to rename the group across every member.
          </div>
        </div>
        <div class="header-actions">
          <a class="btn" href="/accounts">All accounts</a>
        </div>
      </div>

      <div class="detail-grid" style="padding:0 1rem 1rem">
        <div class="detail-pair">
          <span class="detail-label">Member accounts</span>
          <span class="detail-value"><strong>${group.accounts.length}</strong></span>
        </div>
        <div class="detail-pair">
          <span class="detail-label">Total contacts</span>
          <span class="detail-value"><strong>${totalContacts}</strong></span>
        </div>
        <div class="detail-pair">
          <span class="detail-label">Total opportunities</span>
          <span class="detail-value"><strong>${totalOpps}</strong></span>
        </div>
        <div class="detail-pair">
          <span class="detail-label">Total opp value</span>
          <span class="detail-value"><strong>$${escape(formatMoney(totalOppValue))}</strong></span>
        </div>
        <div class="detail-pair">
          <span class="detail-label">Open quotes</span>
          <span class="detail-value">
            <strong>${openQuoteStats.open_quote_count}</strong>
            <span class="muted"> — $${escape(formatMoney(openQuoteStats.open_quote_value))}</span>
          </span>
        </div>
      </div>
    </section>

    ${(() => {
      const maCols = [
        { key: 'name',     label: 'Account',   sort: 'text',   filter: 'text',   default: true },
        { key: 'alias',    label: 'Alias',     sort: 'text',   filter: 'text',   default: true },
        { key: 'segment',  label: 'Segment',   sort: 'text',   filter: 'select', default: true },
        { key: 'contacts', label: 'Contacts',  sort: 'number', filter: null,     default: true },
        { key: 'opps',     label: 'Opps',      sort: 'number', filter: null,     default: true },
      ];
      const maData = group.accounts.map(a => {
        const c = countById.get(a.id) || {};
        return {
          id: a.id,
          name: a.name ?? '',
          alias: a.alias ?? '',
          segment: a.segment ?? '',
          contacts: c.contact_count ?? 0,
          opps: c.opp_count ?? 0,
        };
      });
      return html`
    <section class="card">
      <div class="card-header">
        <h2>Member accounts</h2>
        ${listToolbar({ id: 'grp-members', count: group.accounts.length, columns: maCols, compact: true })}
      </div>
      <div class="opp-list" data-list-id="grp-members" data-columns="${escape(JSON.stringify(maCols))}">
        <table class="data opp-list-table" style="width:100%">
          ${listTableHead(maCols)}
          <tbody data-role="rows">
            ${maData.map(r => html`<tr data-row-id="${escape(r.id)}"
                data-row-href="/accounts/${escape(r.id)}"
                ${raw(rowDataAttrs(maCols, r))}>
              <td class="col-name" data-col="name">
                <a href="/accounts/${escape(r.id)}" style="float:right;margin-left:0.5rem">\u2197</a>
                ${ieText('name', r.name)}
              </td>
              <td class="col-alias" data-col="alias">${ieText('alias', r.alias)}</td>
              <td class="col-segment" data-col="segment">${ieSelect('segment', r.segment, SEGMENT_OPTIONS)}</td>
              <td class="col-contacts num" data-col="contacts">${r.contacts}</td>
              <td class="col-opps num" data-col="opps">${r.opps}</td>
            </tr>`)}
          </tbody>
        </table>
      </div>
      <script>${raw(listScript('pipeline.grp.members.v1', 'name', 'asc', {}, { listId: 'grp-members' }))}</script>
      <script>${raw(listInlineEditScript('/accounts/:id/patch', { listId: 'grp-members' }))}</script>
    </section>`;
    })()}

    ${(() => {
      const goCols = [
        { key: 'number',  label: 'Number',       sort: 'text',   filter: 'text',   default: true },
        { key: 'title',   label: 'Title',        sort: 'text',   filter: 'text',   default: true },
        { key: 'account', label: 'From account',  sort: 'text',   filter: 'text',   default: true },
        { key: 'type',    label: 'Type',          sort: 'text',   filter: 'select', default: true },
        { key: 'stage',   label: 'Stage',         sort: 'text',   filter: 'select', default: true },
        { key: 'value',   label: 'Value',         sort: 'number', filter: null,     default: true },
        { key: 'updated', label: 'Updated',       sort: 'date',   filter: 'text',   default: true },
      ];
      const goData = opps.map(o => {
        const types = parseTransactionTypes(o.transaction_type);
        return {
          id: o.id,
          number: o.number || '',
          title: o.title || '',
          account: o.account_alias || o.account_name || '',
          account_id: o.account_id,
          type: types.map(t => TYPE_LABELS[t] ?? t).join(', ') || '\u2014',
          stage: stageLabel(catalog, types[0] ?? 'spares', o.stage),
          value: o.estimated_value_usd != null ? Number(o.estimated_value_usd) : '',
          value_display: o.estimated_value_usd != null ? `$${formatMoney(o.estimated_value_usd)}` : '',
          updated: (o.updated_at || '').slice(0, 10),
        };
      });
      return html`
    <section class="card">
      <div class="card-header">
        <h2>Opportunities in this group (${opps.length})</h2>
        ${listToolbar({ id: 'grp-opps', count: opps.length, columns: goCols, compact: true })}
      </div>
      ${opps.length === 0
        ? html`<p class="muted" style="padding:0 1rem 1rem">No opportunities yet across this group.</p>`
        : html`
          <div class="opp-list" data-list-id="grp-opps" data-columns="${escape(JSON.stringify(goCols))}">
            <table class="data opp-list-table" style="width:100%">
              ${listTableHead(goCols)}
              <tbody data-role="rows">
                ${goData.map(r => html`<tr data-row-id="${escape(r.id)}"
                    data-row-href="/opportunities/${escape(r.id)}"
                    ${raw(rowDataAttrs(goCols, r))}>
                  <td class="col-number" data-col="number"><a href="/opportunities/${escape(r.id)}"><code>${escape(r.number)}</code></a></td>
                  <td class="col-title" data-col="title">${escape(r.title)}</td>
                  <td class="col-account" data-col="account"><a href="/accounts/${escape(r.account_id)}" class="muted">${escape(r.account)}</a></td>
                  <td class="col-type" data-col="type">${escape(r.type)}</td>
                  <td class="col-stage" data-col="stage">${escape(r.stage)}</td>
                  <td class="col-value num" data-col="value">${escape(r.value_display)}</td>
                  <td class="col-updated" data-col="updated" class="muted"><small>${escape(r.updated)}</small></td>
                </tr>`)}
              </tbody>
            </table>
          </div>
          <script>${raw(listScript('pipeline.grp.opps.v1', 'updated', 'desc', {}, { listId: 'grp-opps' }))}</script>
        `}
    </section>`;
    })()}
  `;

  const scriptBlock = html`
    <script>${raw(groupInlineScript())}</script>
  `;

  return htmlResponse(
    layout(`${group.label} — Group`, html`${body}${scriptBlock}`, {
      user,
      env: data?.env,
      activeNav: '/accounts',
      flash: readFlash(url),
      breadcrumbs: [
        { label: 'Accounts', href: '/accounts' },
        { label: `${group.label} (group)` },
      ],
    })
  );
}

/**
 * Alpine component for the group-label rename in the H1.
 * Member-account inline-edit is now handled by the standard
 * listInlineEditScript — this only covers the label rename which
 * POSTs to /accounts/group/:slug/rename and navigates to the new
 * slug URL on success.
 */
function groupInlineScript() {
  return `
function groupInline(slug) {
  var renameUrl = '/accounts/group/' + slug + '/rename';
  return {
    init: function () {
      var self = this;
      var el = this.$el.querySelector('.ie-group-label');
      if (el) el.addEventListener('click', function () { self.activate(el); });
    },
    activate: function (el) {
      if (el.querySelector('.ie-input')) return;
      var display = el.querySelector('.ie-display');
      var currentValue = display.textContent.trim();
      var self = this;
      var input = document.createElement('input');
      input.type = 'text';
      input.className = 'ie-input';
      input.value = currentValue;
      input.addEventListener('blur', function () { self.save(el, input); });
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); self.save(el, input); }
        if (e.key === 'Escape') { self.deactivate(el, input); }
      });
      display.style.display = 'none';
      el.appendChild(input);
      input.focus();
      input.select();
    },
    save: async function (el, input) {
      var value = input.value;
      this.deactivate(el, input);
      el.classList.add('ie-saving');
      try {
        var res = await fetch(renameUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ newLabel: value }),
        });
        var data = await res.json();
        if (!data.ok) {
          el.classList.add('ie-error');
          el.title = data.error || 'Rename failed';
          setTimeout(function () { el.classList.remove('ie-error'); el.removeAttribute('title'); }, 2500);
          return;
        }
        if (data.newSlug && data.newSlug !== slug) {
          window.location.href = '/accounts/group/' + encodeURIComponent(data.newSlug);
          return;
        }
        var display = el.querySelector('.ie-display');
        display.textContent = data.newLabel || value;
        el.classList.add('ie-saved');
        setTimeout(function () { el.classList.remove('ie-saved'); }, 1200);
      } catch (err) {
        el.classList.add('ie-error');
        setTimeout(function () { el.classList.remove('ie-error'); }, 2500);
      } finally {
        el.classList.remove('ie-saving');
      }
    },
    deactivate: function (el, input) {
      if (input && input.parentNode === el) el.removeChild(input);
      var display = el.querySelector('.ie-display');
      if (display) display.style.display = '';
    },
  };
}
`;
}
