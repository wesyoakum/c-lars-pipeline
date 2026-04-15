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

  const body = html`
    <section class="card">
      <div class="card-header">
        <div>
          <h1 class="page-title">${escape(group.label)}</h1>
          <div class="muted" style="font-size:0.9em;margin-top:0.15rem">
            Group rollup across ${group.accounts.length} account${group.accounts.length === 1 ? '' : 's'}
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
              <tr>
                <td><a href="/accounts/${escape(a.id)}"><strong>${escape(a.name)}</strong></a></td>
                <td class="muted">${escape(a.alias || '')}</td>
                <td>${escape(a.segment || '')}</td>
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

  return htmlResponse(
    layout(`${group.label} — Group`, body, {
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
