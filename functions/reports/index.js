// functions/reports/index.js
//
// GET /reports — Reporting hub with executive and sales team reports.
// Charts are rendered via Chart.js (vendored at /js/chart.min.js).

import { all, one } from '../lib/db.js';
import { layout, htmlResponse, html, escape, raw } from '../lib/layout.js';
import { loadStageCatalog } from '../lib/stages.js';
import { fmtDollar } from '../lib/pricing.js';
import { readFlash } from '../lib/http.js';

const TYPE_LABELS = {
  spares: 'Spares',
  eps: 'EPS',
  refurb: 'Refurb',
  service: 'Service',
};

export async function onRequestGet(context) {
  const { env, data, request } = context;
  const user = data?.user;
  const url = new URL(request.url);
  const tab = url.searchParams.get('tab') || 'executive';

  const catalog = await loadStageCatalog(env.DB);
  const stageLabels = new Map();
  for (const list of catalog.values()) {
    for (const s of list) if (!stageLabels.has(s.stage_key)) stageLabels.set(s.stage_key, s.label);
  }

  // ── Executive summary data ──────────────────────────────────
  const pipelineByStage = await all(env.DB,
    `SELECT stage, COUNT(*) AS n, COALESCE(SUM(estimated_value_usd), 0) AS total_value
       FROM opportunities
      WHERE stage NOT IN ('closed_won', 'closed_lost', 'closed_abandoned')
      GROUP BY stage ORDER BY total_value DESC`);

  const pipelineByType = await all(env.DB,
    `SELECT transaction_type, COUNT(*) AS n, COALESCE(SUM(estimated_value_usd), 0) AS total_value
       FROM opportunities
      WHERE stage NOT IN ('closed_won', 'closed_lost', 'closed_abandoned')
      GROUP BY transaction_type ORDER BY total_value DESC`);

  const pipelineByOwner = await all(env.DB,
    `SELECT COALESCE(u.display_name, u.email, 'Unassigned') AS owner_name,
            COUNT(*) AS n, COALESCE(SUM(o.estimated_value_usd), 0) AS total_value
       FROM opportunities o
       LEFT JOIN users u ON u.id = o.owner_user_id
      WHERE o.stage NOT IN ('closed_won', 'closed_lost', 'closed_abandoned')
      GROUP BY o.owner_user_id ORDER BY total_value DESC`);

  // Win/loss over time (monthly, last 12 months)
  const monthlyWinLoss = await all(env.DB,
    `SELECT strftime('%Y-%m', updated_at) AS month,
            SUM(CASE WHEN stage = 'closed_won' THEN 1 ELSE 0 END) AS won,
            SUM(CASE WHEN stage = 'closed_lost' THEN 1 ELSE 0 END) AS lost,
            SUM(CASE WHEN stage = 'closed_won' THEN estimated_value_usd ELSE 0 END) AS won_value,
            SUM(CASE WHEN stage = 'closed_lost' THEN estimated_value_usd ELSE 0 END) AS lost_value
       FROM opportunities
      WHERE stage IN ('closed_won', 'closed_lost')
        AND updated_at >= datetime('now', '-12 months')
      GROUP BY month ORDER BY month`);

  // Quote conversion metrics
  const quoteMetrics = await one(env.DB,
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) AS accepted,
            SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
            SUM(CASE WHEN status = 'submitted' THEN 1 ELSE 0 END) AS pending,
            SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) AS drafts
       FROM quotes`);

  // Recently won
  const recentWins = await all(env.DB,
    `SELECT o.number, o.title, o.estimated_value_usd, o.updated_at,
            a.name AS account_name
       FROM opportunities o
       LEFT JOIN accounts a ON a.id = o.account_id
      WHERE o.stage = 'closed_won'
      ORDER BY o.updated_at DESC LIMIT 10`);

  const totalPipeline = pipelineByStage.reduce((a, s) => a + Number(s.total_value), 0);
  const totalOppCount = pipelineByStage.reduce((a, s) => a + s.n, 0);

  // Chart data JSON
  const stageChartJSON = JSON.stringify({
    labels: pipelineByStage.map(s => stageLabels.get(s.stage) ?? s.stage),
    values: pipelineByStage.map(s => Number(s.total_value)),
  });
  const typeChartJSON = JSON.stringify({
    labels: pipelineByType.map(s => TYPE_LABELS[s.transaction_type] ?? s.transaction_type),
    values: pipelineByType.map(s => Number(s.total_value)),
  });
  const ownerChartJSON = JSON.stringify({
    labels: pipelineByOwner.map(s => s.owner_name),
    values: pipelineByOwner.map(s => Number(s.total_value)),
  });
  const winLossChartJSON = JSON.stringify({
    labels: monthlyWinLoss.map(m => m.month),
    won: monthlyWinLoss.map(m => Number(m.won_value ?? 0)),
    lost: monthlyWinLoss.map(m => Number(m.lost_value ?? 0)),
  });

  const executiveTab = html`
    <div class="dashboard-metrics" style="margin-bottom:1rem">
      <div class="metric-card">
        <span class="metric-value">$${formatMoney(totalPipeline)}</span>
        <span class="metric-label">Total pipeline</span>
      </div>
      <div class="metric-card">
        <span class="metric-value">${totalOppCount}</span>
        <span class="metric-label">Active opps</span>
      </div>
      <div class="metric-card">
        <span class="metric-value">${quoteMetrics?.accepted ?? 0}</span>
        <span class="metric-label">Quotes won</span>
      </div>
      <div class="metric-card">
        <span class="metric-value">${quoteMetrics?.pending ?? 0}</span>
        <span class="metric-label">Quotes pending</span>
      </div>
      <div class="metric-card">
        <span class="metric-value">${quoteMetrics?.drafts ?? 0}</span>
        <span class="metric-label">Quotes in draft</span>
      </div>
    </div>

    <div class="dashboard-charts">
      <section class="card">
        <h2>Pipeline by stage</h2>
        <canvas id="rpt-stage" height="250"></canvas>
      </section>
      <section class="card">
        <h2>Pipeline by type</h2>
        <canvas id="rpt-type" height="250"></canvas>
      </section>
      <section class="card">
        <h2>Pipeline by owner</h2>
        <canvas id="rpt-owner" height="250"></canvas>
      </section>
      <section class="card">
        <h2>Win / Loss trend (12 months)</h2>
        <canvas id="rpt-winloss" height="250"></canvas>
      </section>
    </div>

    ${recentWins.length > 0 ? html`
      <section class="card" style="margin-top:1rem">
        <h2>Recent wins</h2>
        <table class="data compact">
          <thead><tr><th>Number</th><th>Title</th><th>Account</th><th class="num">Value</th><th>Closed</th></tr></thead>
          <tbody>
            ${recentWins.map(w => html`
              <tr>
                <td><code>${escape(w.number)}</code></td>
                <td>${escape(w.title)}</td>
                <td>${escape(w.account_name ?? '—')}</td>
                <td class="num">${w.estimated_value_usd != null ? `$${formatMoney(w.estimated_value_usd)}` : '—'}</td>
                <td><small class="muted">${escape((w.updated_at ?? '').slice(0, 10))}</small></td>
              </tr>
            `)}
          </tbody>
        </table>
      </section>
    ` : ''}
  `;

  const salesTab = html`
    <section class="card">
      <h2>Pipeline detail by owner</h2>
      <table class="data">
        <thead><tr><th>Owner</th><th class="num">Opps</th><th class="num">Value</th></tr></thead>
        <tbody>
          ${pipelineByOwner.map(o => html`
            <tr>
              <td>${escape(o.owner_name)}</td>
              <td class="num">${o.n}</td>
              <td class="num">$${formatMoney(o.total_value)}</td>
            </tr>
          `)}
        </tbody>
      </table>
    </section>

    <section class="card">
      <h2>Pipeline detail by stage</h2>
      <table class="data">
        <thead><tr><th>Stage</th><th class="num">Opps</th><th class="num">Value</th></tr></thead>
        <tbody>
          ${pipelineByStage.map(s => html`
            <tr>
              <td>${escape(stageLabels.get(s.stage) ?? s.stage)}</td>
              <td class="num">${s.n}</td>
              <td class="num">$${formatMoney(s.total_value)}</td>
            </tr>
          `)}
        </tbody>
      </table>
    </section>

    <section class="card">
      <h2>Quote metrics</h2>
      <div class="detail-grid">
        <div class="detail-pair">
          <span class="detail-label">Total quotes</span>
          <span class="detail-value">${quoteMetrics?.total ?? 0}</span>
        </div>
        <div class="detail-pair">
          <span class="detail-label">Accepted</span>
          <span class="detail-value">${quoteMetrics?.accepted ?? 0}</span>
        </div>
        <div class="detail-pair">
          <span class="detail-label">Rejected</span>
          <span class="detail-value">${quoteMetrics?.rejected ?? 0}</span>
        </div>
        <div class="detail-pair">
          <span class="detail-label">Pending</span>
          <span class="detail-value">${quoteMetrics?.pending ?? 0}</span>
        </div>
      </div>
    </section>
  `;

  const tabs = html`
    <nav class="card" style="padding: 0.5rem 1rem;">
      <a class="nav-link ${tab === 'executive' ? 'active' : ''}" href="/reports">Executive summary</a>
      <a class="nav-link ${tab === 'sales' ? 'active' : ''}" href="/reports?tab=sales">Sales team</a>
    </nav>
  `;

  const body = html`
    <section class="card">
      <h1 class="page-title">Reports</h1>
    </section>
    ${tabs}
    ${tab === 'sales' ? salesTab : executiveTab}

    <script>
    document.addEventListener('DOMContentLoaded', function() {
      if (typeof Chart === 'undefined') return;
      var colors = [
        'rgba(9,105,218,0.7)', 'rgba(26,127,55,0.7)', 'rgba(191,135,0,0.7)',
        'rgba(207,34,46,0.7)', 'rgba(130,80,223,0.7)', 'rgba(17,138,178,0.7)',
        'rgba(219,112,60,0.7)', 'rgba(100,116,139,0.7)'
      ];
      Chart.defaults.font.family = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif";

      var stage = ${raw(stageChartJSON)};
      if (stage.labels.length && document.getElementById('rpt-stage')) {
        new Chart(document.getElementById('rpt-stage'), {
          type: 'bar',
          data: { labels: stage.labels, datasets: [{ label: 'Value ($)', data: stage.values, backgroundColor: colors, borderRadius: 4 }] },
          options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { ticks: { callback: function(v) { return '$' + (v >= 1000 ? (v/1000) + 'k' : v); } } } } }
        });
      }

      var type = ${raw(typeChartJSON)};
      if (type.labels.length && document.getElementById('rpt-type')) {
        new Chart(document.getElementById('rpt-type'), {
          type: 'doughnut',
          data: { labels: type.labels, datasets: [{ data: type.values, backgroundColor: colors }] },
          options: { responsive: true }
        });
      }

      var owner = ${raw(ownerChartJSON)};
      if (owner.labels.length && document.getElementById('rpt-owner')) {
        new Chart(document.getElementById('rpt-owner'), {
          type: 'bar',
          data: { labels: owner.labels, datasets: [{ label: 'Value ($)', data: owner.values, backgroundColor: colors, borderRadius: 4 }] },
          options: { responsive: true, indexAxis: 'y', plugins: { legend: { display: false } }, scales: { x: { ticks: { callback: function(v) { return '$' + (v >= 1000 ? (v/1000) + 'k' : v); } } } } }
        });
      }

      var wl = ${raw(winLossChartJSON)};
      if (wl.labels.length && document.getElementById('rpt-winloss')) {
        new Chart(document.getElementById('rpt-winloss'), {
          type: 'bar',
          data: {
            labels: wl.labels,
            datasets: [
              { label: 'Won ($)', data: wl.won, backgroundColor: 'rgba(26,127,55,0.7)', borderRadius: 4 },
              { label: 'Lost ($)', data: wl.lost, backgroundColor: 'rgba(207,34,46,0.5)', borderRadius: 4 },
            ]
          },
          options: { responsive: true, scales: { y: { ticks: { callback: function(v) { return '$' + (v >= 1000 ? (v/1000) + 'k' : v); } } } } }
        });
      }
    });
    </script>
  `;

  return htmlResponse(layout('Reports', body, {
    user,
    env: data?.env,
    charts: true,
    breadcrumbs: [{ label: 'Reports' }],
  }));
}

function formatMoney(n) {
  return Math.round(Number(n ?? 0)).toLocaleString('en-US');
}
