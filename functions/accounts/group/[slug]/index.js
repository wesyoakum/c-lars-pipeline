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
  eps: 'Engineered Product (EPS)',
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

  const segmentOptionsJson = JSON.stringify(SEGMENT_OPTIONS);

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

    <section class="card">
      <div class="card-header">
        <h2>Member accounts</h2>
      </div>
      <table class="data" style="width:100%">
        <thead>
          <tr>
            <th style="text-align:left">Account</th>
            <th style="text-align:left">Alias</th>
            <th style="text-align:left">Segment</th>
            <th style="text-align:right">Contacts</th>
            <th style="text-align:right">Opps</th>
          </tr>
        </thead>
        <tbody>
          ${group.accounts.map((a) => {
            const c = countById.get(a.id) || {};
            return html`
              <tr data-acct-id="${escape(a.id)}">
                <td>
                  <a href="/accounts/${escape(a.id)}" style="float:right;margin-left:0.5rem">\u2197</a>
                  <span class="ie" data-field="name" data-type="text" data-acct="${escape(a.id)}">
                    <span class="ie-display"><strong>${escape(a.name)}</strong></span>
                  </span>
                </td>
                <td>
                  <span class="ie" data-field="alias" data-type="text" data-acct="${escape(a.id)}">
                    <span class="ie-display ${a.alias ? '' : 'muted'}">${escape(a.alias || '\u2014')}</span>
                  </span>
                </td>
                <td>
                  <span class="ie" data-field="segment" data-type="select" data-acct="${escape(a.id)}"
                        data-options='${escape(segmentOptionsJson)}'>
                    <span class="ie-display ${a.segment ? '' : 'muted'}">${escape(a.segment || '\u2014')}</span>
                  </span>
                </td>
                <td class="num">${c.contact_count ?? 0}</td>
                <td class="num">${c.opp_count ?? 0}</td>
              </tr>
            `;
          })}
        </tbody>
      </table>
    </section>

    <section class="card">
      <div class="card-header">
        <h2>Opportunities in this group (${opps.length})</h2>
      </div>
      ${opps.length === 0
        ? html`<p class="muted" style="padding:0 1rem 1rem">No opportunities yet across this group.</p>`
        : html`
          <table class="data" style="width:100%">
            <thead>
              <tr>
                <th style="text-align:left">Number</th>
                <th style="text-align:left">Title</th>
                <th style="text-align:left">From account</th>
                <th style="text-align:left">Type</th>
                <th style="text-align:left">Stage</th>
                <th style="text-align:right">Value</th>
                <th style="text-align:left">Updated</th>
              </tr>
            </thead>
            <tbody>
              ${opps.map((o) => {
                const types = parseTransactionTypes(o.transaction_type);
                const typeText = types.map((t) => TYPE_LABELS[t] ?? t).join(', ') || '—';
                const stage = stageLabel(catalog, types[0] ?? 'spares', o.stage);
                const value = o.estimated_value_usd != null ? `$${formatMoney(o.estimated_value_usd)}` : '';
                return html`
                  <tr>
                    <td><a href="/opportunities/${escape(o.id)}"><code>${escape(o.number || '')}</code></a></td>
                    <td>${escape(o.title || '')}</td>
                    <td><a href="/accounts/${escape(o.account_id)}" class="muted">${escape(o.account_alias || o.account_name || '')}</a></td>
                    <td>${escape(typeText)}</td>
                    <td>${escape(stage)}</td>
                    <td class="num">${escape(value)}</td>
                    <td class="muted"><small>${escape((o.updated_at || '').slice(0, 10))}</small></td>
                  </tr>
                `;
              })}
            </tbody>
          </table>
        `}
    </section>
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
 * Alpine component + DOM wiring for inline-edit on the group page.
 *
 * Two targets on this page:
 *   1. The group label in the H1 (data-field="label", no data-acct)
 *      → POSTs to /accounts/group/:slug/rename and, on success,
 *        navigates to the new slug URL (since slug is derived from
 *        the label).
 *   2. Member-account fields (name / alias / segment) inside the
 *      member table rows (data-field + data-acct on the <span>)
 *      → POSTs to /accounts/:id/patch, the same endpoint the
 *        /accounts list and /accounts/:id detail page use.
 *
 * Kept inline here rather than added to lib/list-inline-edit.js
 * because this page isn't a standard list-table setup — it's a
 * rollup with two different save behaviors.
 */
function groupInlineScript() {
  return `
function groupInline(slug) {
  var renameUrl = '/accounts/group/' + slug + '/rename';
  return {
    init: function () {
      var self = this;
      this.$el.querySelectorAll('.ie').forEach(function (el) {
        el.addEventListener('click', function () { self.activate(el); });
      });
    },
    activate: function (el) {
      if (el.querySelector('.ie-input')) return;
      var field = el.dataset.field;
      var type = el.dataset.type;
      var display = el.querySelector('.ie-display');
      var currentValue = display.classList.contains('muted') ? '' : display.textContent.trim();
      if (currentValue === '\u2014') currentValue = '';

      var input;
      var self = this;
      if (type === 'select') {
        input = document.createElement('select');
        input.className = 'ie-input';
        var options = [];
        try { options = JSON.parse(el.dataset.options || '[]'); } catch (e) {}
        options.forEach(function (o) {
          var opt = document.createElement('option');
          opt.value = o.value;
          opt.textContent = o.label;
          if (o.value === (currentValue || '')) opt.selected = true;
          input.appendChild(opt);
        });
        input.addEventListener('change', function () { self.save(el, input); });
        input.addEventListener('blur', function () {
          setTimeout(function () { self.deactivate(el, input); }, 150);
        });
      } else {
        input = document.createElement('input');
        input.type = 'text';
        input.className = 'ie-input';
        input.value = currentValue;
        input.addEventListener('blur', function () { self.save(el, input); });
        input.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { e.preventDefault(); self.save(el, input); }
          if (e.key === 'Escape') { self.deactivate(el, input); }
        });
      }

      display.style.display = 'none';
      el.appendChild(input);
      input.focus();
      if (input.select) input.select();
    },
    save: async function (el, input) {
      var field = el.dataset.field;
      var acctId = el.dataset.acct;
      var value = input.value;
      this.deactivate(el, input);
      el.classList.add('ie-saving');
      try {
        if (field === 'label' && !acctId) {
          // Group rename path.
          var res = await fetch(renameUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ newLabel: value }),
          });
          var data = await res.json();
          if (!data.ok) { this.flash(el, 'error', data.error || 'Rename failed'); return; }
          if (data.newSlug && data.newSlug !== slug) {
            // Slug changed — navigate to the new URL so every link /
            // breadcrumb on the page reflects the rename.
            window.location.href = '/accounts/group/' + encodeURIComponent(data.newSlug);
            return;
          }
          var display = el.querySelector('.ie-display');
          display.textContent = data.newLabel || value;
          this.flash(el, 'saved');
          return;
        }
        // Member-account field patch.
        var res2 = await fetch('/accounts/' + encodeURIComponent(acctId) + '/patch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ field: field, value: value }),
        });
        var data2 = await res2.json();
        if (!data2.ok) { this.flash(el, 'error', data2.error || 'Save failed'); return; }
        var display2 = el.querySelector('.ie-display');
        var saved = data2.value != null ? data2.value : value;
        if (el.dataset.type === 'select') {
          var opts = [];
          try { opts = JSON.parse(el.dataset.options || '[]'); } catch (e) {}
          var match = opts.filter(function (o) { return o.value === (saved || ''); })[0];
          display2.textContent = match ? match.label : (saved || '\u2014');
        } else {
          display2.textContent = saved || '\u2014';
        }
        display2.classList.toggle('muted', !saved);
        this.flash(el, 'saved');
      } catch (err) {
        this.flash(el, 'error', err && err.message ? err.message : 'Save failed');
      } finally {
        el.classList.remove('ie-saving');
      }
    },
    deactivate: function (el, input) {
      if (input && input.parentNode === el) el.removeChild(input);
      var display = el.querySelector('.ie-display');
      if (display) display.style.display = '';
    },
    flash: function (el, kind, msg) {
      el.classList.add('ie-' + kind);
      if (msg) el.title = msg;
      setTimeout(function () {
        el.classList.remove('ie-' + kind);
        if (msg) el.removeAttribute('title');
      }, kind === 'saved' ? 1200 : 2500);
    },
  };
}
`;
}
