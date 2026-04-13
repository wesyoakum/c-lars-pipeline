// functions/index.js
//
// GET /
// Dashboard with pipeline overview, charts, and key metrics.

import { all, one } from './lib/db.js';
import { layout, htmlResponse, html, escape, raw } from './lib/layout.js';
import { loadStageCatalog } from './lib/stages.js';

const TYPE_LABELS = {
  spares: 'Spares',
  eps: 'EPS',
  refurb: 'Refurb',
  service: 'Service',
};

export async function onRequestGet(context) {
  const { env, data } = context;
  const user = data?.user;

  // My pipeline: open opportunities owned by the current user
  const myPipeline = user?.id
    ? await all(
        env.DB,
        `SELECT o.id, o.number, o.title, o.transaction_type, o.stage,
                o.estimated_value_usd, o.expected_close_date, o.updated_at,
                a.name AS account_name, a.id AS account_id
           FROM opportunities o
           LEFT JOIN accounts a ON a.id = o.account_id
          WHERE o.stage NOT IN ('closed_won', 'closed_lost', 'closed_abandoned')
            AND (o.owner_user_id = ? OR o.owner_user_id IS NULL)
          ORDER BY o.updated_at DESC
          LIMIT 20`,
        [user.id]
      )
    : [];

  // Pipeline summary by stage
  const stageSummary = await all(
    env.DB,
    `SELECT stage, COUNT(*) AS n, COALESCE(SUM(estimated_value_usd), 0) AS total_value
       FROM opportunities
      WHERE stage NOT IN ('closed_won', 'closed_lost', 'closed_abandoned')
      GROUP BY stage
      ORDER BY n DESC`
  );

  // Pipeline by type
  const typeSummary = await all(
    env.DB,
    `SELECT transaction_type, COUNT(*) AS n, COALESCE(SUM(estimated_value_usd), 0) AS total_value
       FROM opportunities
      WHERE stage NOT IN ('closed_won', 'closed_lost', 'closed_abandoned')
      GROUP BY transaction_type
      ORDER BY total_value DESC`
  );

  // Win/loss stats (last 90 days)
  const winLoss = await all(
    env.DB,
    `SELECT stage, COUNT(*) AS n, COALESCE(SUM(estimated_value_usd), 0) AS total_value
       FROM opportunities
      WHERE stage IN ('closed_won', 'closed_lost')
        AND updated_at >= datetime('now', '-90 days')
      GROUP BY stage`
  );

  // My open tasks
  const myTasks = user?.id
    ? await all(
        env.DB,
        `SELECT a.id, a.type, a.subject, a.due_at, a.status,
                o.id AS opp_id, o.number AS opp_number, o.title AS opp_title
           FROM activities a
           LEFT JOIN opportunities o ON o.id = a.opportunity_id
          WHERE a.status = 'pending'
            AND a.assigned_user_id = ?
          ORDER BY
            CASE WHEN a.due_at IS NOT NULL THEN 0 ELSE 1 END,
            a.due_at ASC,
            a.created_at DESC
          LIMIT 10`,
        [user.id]
      )
    : [];

  // Recent quotes
  const recentQuotes = await all(
    env.DB,
    `SELECT q.id, q.number, q.revision, q.status, q.total_price, q.updated_at,
            o.id AS opp_id, o.number AS opp_number, o.title AS opp_title
       FROM quotes q
       JOIN opportunities o ON o.id = q.opportunity_id
      ORDER BY q.updated_at DESC
      LIMIT 5`
  );

  const catalog = await loadStageCatalog(env.DB);
  const stageLabels = new Map();
  for (const list of catalog.values()) {
    for (const s of list) if (!stageLabels.has(s.stage_key)) stageLabels.set(s.stage_key, s.label);
  }

  const [oppCount, acctCount, quoteCount] = await Promise.all([
    one(env.DB, 'SELECT COUNT(*) AS n FROM opportunities'),
    one(env.DB, 'SELECT COUNT(*) AS n FROM accounts'),
    one(env.DB, 'SELECT COUNT(*) AS n FROM quotes'),
  ]);

  const totalPipelineValue = stageSummary.reduce((a, s) => a + Number(s.total_value), 0);
  const wonRow = winLoss.find(w => w.stage === 'closed_won');
  const lostRow = winLoss.find(w => w.stage === 'closed_lost');
  const wonCount = wonRow?.n ?? 0;
  const lostCount = lostRow?.n ?? 0;
  const winRate = (wonCount + lostCount) > 0
    ? Math.round(wonCount / (wonCount + lostCount) * 100)
    : 0;

  // Chart data as JSON for client-side rendering
  const stageChartData = JSON.stringify({
    labels: stageSummary.map(s => stageLabels.get(s.stage) ?? s.stage),
    values: stageSummary.map(s => Number(s.total_value)),
    counts: stageSummary.map(s => s.n),
  });

  const typeChartData = JSON.stringify({
    labels: typeSummary.map(s => TYPE_LABELS[s.transaction_type] ?? s.transaction_type),
    values: typeSummary.map(s => Number(s.total_value)),
    counts: typeSummary.map(s => s.n),
  });

  const body = html`
    <section class="card">
      <h1 class="page-title">Dashboard</h1>
    </section>

    <div class="dashboard-metrics">
      <div class="metric-card">
        <span class="metric-value">${oppCount?.n ?? 0}</span>
        <span class="metric-label">Opportunities</span>
      </div>
      <div class="metric-card">
        <span class="metric-value">$${formatMoney(totalPipelineValue)}</span>
        <span class="metric-label">Pipeline value</span>
      </div>
      <div class="metric-card">
        <span class="metric-value">${quoteCount?.n ?? 0}</span>
        <span class="metric-label">Quotes</span>
      </div>
      <div class="metric-card">
        <span class="metric-value">${winRate}%</span>
        <span class="metric-label">Win rate (90d)</span>
      </div>
      <div class="metric-card">
        <span class="metric-value">${acctCount?.n ?? 0}</span>
        <span class="metric-label">Accounts</span>
      </div>
    </div>

    <div class="dashboard-charts">
      <section class="card">
        <h2>Pipeline by stage</h2>
        <canvas id="chart-stage" height="220"></canvas>
      </section>
      <section class="card">
        <h2>Pipeline by type</h2>
        <canvas id="chart-type" height="220"></canvas>
      </section>
    </div>

    ${myTasks.length > 0 ? html`
      <section class="card">
        <div class="card-header">
          <h2>My open tasks <span class="muted">(${myTasks.length})</span></h2>
          <a class="btn btn-sm" href="/activities">All tasks</a>
        </div>
        <table class="data compact">
          <thead>
            <tr>
              <th style="width:2rem"></th>
              <th>Subject</th>
              <th>Opportunity</th>
              <th>Due</th>
            </tr>
          </thead>
          <tbody>
            ${myTasks.map(t => {
              const isOverdue = t.due_at && t.due_at < new Date().toISOString().slice(0, 10);
              return html`
                <tr class="${isOverdue ? 'row-overdue' : ''}">
                  <td>
                    <form method="post" action="/activities/${escape(t.id)}/complete" style="display:inline">
                      <button type="submit" class="check-btn" title="Mark complete">
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2">
                          <circle cx="8" cy="8" r="6"/>
                        </svg>
                      </button>
                    </form>
                  </td>
                  <td><a href="/activities/${escape(t.id)}"><strong>${escape(t.subject || '(no subject)')}</strong></a></td>
                  <td>${t.opp_id
                    ? html`<a href="/opportunities/${escape(t.opp_id)}"><code>${escape(t.opp_number ?? '')}</code></a>`
                    : html`<span class="muted">—</span>`}
                  </td>
                  <td class="${isOverdue ? 'overdue-text' : ''}">${t.due_at ? escape(t.due_at.slice(0, 10)) : html`<span class="muted">—</span>`}</td>
                </tr>
              `;
            })}
          </tbody>
        </table>
      </section>
    ` : ''}

    <section class="card">
      <div class="card-header">
        <h2>My pipeline</h2>
        <div class="header-actions">
          <a class="btn btn-sm" href="/opportunities">All opportunities</a>
          <a class="btn btn-sm primary" href="/opportunities/new">+ New</a>
        </div>
      </div>

      ${myPipeline.length === 0
        ? html`<p class="muted">
            No open opportunities yet. Start by
            <a href="/opportunities/new">creating one</a>.
          </p>`
        : html`
          <table class="data compact">
            <thead>
              <tr>
                <th>Number</th>
                <th>Title</th>
                <th>Account</th>
                <th>Type</th>
                <th>Stage</th>
                <th class="num">Value</th>
              </tr>
            </thead>
            <tbody>
              ${myPipeline.map(
                (o) => html`
                  <tr>
                    <td><a href="/opportunities/${escape(o.id)}"><code>${escape(o.number)}</code></a></td>
                    <td><a href="/opportunities/${escape(o.id)}"><strong>${escape(o.title)}</strong></a></td>
                    <td>${o.account_id
                      ? html`<a href="/accounts/${escape(o.account_id)}">${escape(o.account_name ?? '—')}</a>`
                      : html`<span class="muted">—</span>`}</td>
                    <td>${escape(TYPE_LABELS[o.transaction_type] ?? o.transaction_type)}</td>
                    <td><span class="pill">${escape(stageLabels.get(o.stage) ?? o.stage)}</span></td>
                    <td class="num">${o.estimated_value_usd != null ? `$${formatMoney(o.estimated_value_usd)}` : ''}</td>
                  </tr>`
              )}
            </tbody>
          </table>`}
    </section>

    ${recentQuotes.length > 0 ? html`
      <section class="card">
        <div class="card-header">
          <h2>Recent quotes</h2>
        </div>
        <table class="data compact">
          <thead>
            <tr>
              <th>Quote</th>
              <th>Opportunity</th>
              <th>Status</th>
              <th class="num">Total</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            ${recentQuotes.map(q => html`
              <tr>
                <td><a href="/opportunities/${escape(q.opp_id)}/quotes/${escape(q.id)}"><code>${escape(q.number)}</code> ${escape(q.revision)}</a></td>
                <td><a href="/opportunities/${escape(q.opp_id)}">${escape(q.opp_number)} — ${escape(q.opp_title ?? '')}</a></td>
                <td><span class="pill">${escape(q.status)}</span></td>
                <td class="num">${q.total_price != null ? `$${formatMoney(q.total_price)}` : '—'}</td>
                <td><small class="muted">${escape((q.updated_at ?? '').slice(0, 10))}</small></td>
              </tr>
            `)}
          </tbody>
        </table>
      </section>
    ` : ''}

    <script>
    document.addEventListener('DOMContentLoaded', function() {
      if (typeof Chart === 'undefined') return;

      var colors = [
        'rgba(9,105,218,0.7)', 'rgba(26,127,55,0.7)', 'rgba(191,135,0,0.7)',
        'rgba(207,34,46,0.7)', 'rgba(130,80,223,0.7)', 'rgba(17,138,178,0.7)',
        'rgba(219,112,60,0.7)', 'rgba(100,116,139,0.7)'
      ];
      var borderColors = colors.map(function(c) { return c.replace('0.7', '1'); });

      Chart.defaults.font.family = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif";
      Chart.defaults.font.size = 12;
      Chart.defaults.plugins.legend.position = 'bottom';

      var stageData = ${raw(stageChartData)};
      if (stageData.labels.length > 0) {
        new Chart(document.getElementById('chart-stage'), {
          type: 'bar',
          data: {
            labels: stageData.labels,
            datasets: [{
              label: 'Value ($)',
              data: stageData.values,
              backgroundColor: colors.slice(0, stageData.labels.length),
              borderColor: borderColors.slice(0, stageData.labels.length),
              borderWidth: 1,
              borderRadius: 4,
            }]
          },
          options: {
            responsive: true,
            plugins: {
              legend: { display: false },
              tooltip: {
                callbacks: {
                  label: function(ctx) {
                    return '$' + ctx.parsed.y.toLocaleString() + ' (' + stageData.counts[ctx.dataIndex] + ' opps)';
                  }
                }
              }
            },
            scales: {
              y: {
                ticks: {
                  callback: function(v) { return '$' + (v >= 1000 ? (v/1000) + 'k' : v); }
                }
              }
            }
          }
        });
      }

      var typeData = ${raw(typeChartData)};
      if (typeData.labels.length > 0) {
        new Chart(document.getElementById('chart-type'), {
          type: 'doughnut',
          data: {
            labels: typeData.labels,
            datasets: [{
              data: typeData.values,
              backgroundColor: colors.slice(0, typeData.labels.length),
              borderWidth: 2,
            }]
          },
          options: {
            responsive: true,
            plugins: {
              tooltip: {
                callbacks: {
                  label: function(ctx) {
                    return ctx.label + ': $' + ctx.parsed.toLocaleString() + ' (' + typeData.counts[ctx.dataIndex] + ' opps)';
                  }
                }
              }
            }
          }
        });
      }
    });
    </script>
  `;

  return htmlResponse(layout('Dashboard', body, { user, env: data?.env, charts: true }));
}

function formatMoney(n) {
  return Math.round(Number(n ?? 0)).toLocaleString('en-US');
}
