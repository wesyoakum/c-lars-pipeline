// functions/reports/index.js
//
// GET /reports — Reporting hub with executive and sales team reports.
// Charts are rendered via Chart.js (vendored at /js/chart.min.js).
//
// The executive tab is a 10-chart portfolio that showcases what PMS
// can do with the data already in D1. All 10 chart queries live in
// functions/lib/chart-data.js so the dashboard carousel can reuse
// them. The reports page adds a few extra queries (KPI strip,
// recent wins table) and renders everything in full-page layout.

import { all, one } from '../lib/db.js';
import { layout, htmlResponse, html, escape, raw } from '../lib/layout.js';
import {
  gatherDashboardCharts,
  renderHeatmapGrid,
  buildChartInitScript,
  CHART_SLIDES,
} from '../lib/chart-data.js';

export async function onRequestGet(context) {
  const { env, data, request } = context;
  const user = data?.user;
  const url = new URL(request.url);
  const tab = url.searchParams.get('tab') || 'executive';

  // Gather the 10-chart portfolio via the shared helper.
  const dashboard = await gatherDashboardCharts(env.DB);
  const { stageLabels, totals, charts, chartsJson } = dashboard;

  // Reports-specific extras (KPI strip, tables).
  const [
    pipelineByOwner,
    pipelineByStage,
    quoteMetrics,
    recentWins,
    winYTD,
    thisMonthWins,
  ] = await Promise.all([
    all(env.DB,
      `SELECT COALESCE(u.display_name, u.email, 'Unassigned') AS owner_name,
              COUNT(*) AS n, COALESCE(SUM(o.estimated_value_usd), 0) AS total_value
         FROM opportunities o
         LEFT JOIN users u ON u.id = o.owner_user_id
        WHERE o.stage NOT IN ('closed_won', 'closed_lost', 'closed_abandoned')
        GROUP BY o.owner_user_id ORDER BY total_value DESC`),
    all(env.DB,
      `SELECT stage, COUNT(*) AS n, COALESCE(SUM(estimated_value_usd), 0) AS total_value
         FROM opportunities
        WHERE stage NOT IN ('closed_won', 'closed_lost', 'closed_abandoned')
        GROUP BY stage ORDER BY n DESC`),
    one(env.DB,
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) AS accepted,
              SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
              SUM(CASE WHEN status = 'submitted' THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) AS drafts
         FROM quotes`),
    all(env.DB,
      `SELECT o.number, o.title, o.estimated_value_usd, o.updated_at,
              a.name AS account_name
         FROM opportunities o
         LEFT JOIN accounts a ON a.id = o.account_id
        WHERE o.stage = 'closed_won'
        ORDER BY o.updated_at DESC LIMIT 10`),
    one(env.DB,
      `SELECT COALESCE(SUM(estimated_value_usd), 0) AS value, COUNT(*) AS n
         FROM opportunities
        WHERE stage = 'closed_won'
          AND COALESCE(actual_close_date, updated_at) >= date('now', 'start of year')`),
    one(env.DB,
      `SELECT COALESCE(SUM(estimated_value_usd), 0) AS value, COUNT(*) AS n
         FROM opportunities
        WHERE stage = 'closed_won'
          AND COALESCE(actual_close_date, updated_at) >= date('now', 'start of month')`),
  ]);

  // Slide index → catalog entry (for titles, captions)
  function slideByKey(key) { return CHART_SLIDES.find(s => s.key === key); }

  const executiveTab = html`
    <div class="dashboard-metrics" style="margin-bottom:1rem">
      <div class="metric-card">
        <span class="metric-value">$${formatMoney(totals.pipeline)}</span>
        <span class="metric-label">Open pipeline</span>
      </div>
      <div class="metric-card">
        <span class="metric-value">${totals.opps}</span>
        <span class="metric-label">Active opps</span>
      </div>
      <div class="metric-card">
        <span class="metric-value">$${formatMoney(thisMonthWins?.value ?? 0)}</span>
        <span class="metric-label">Won this month</span>
      </div>
      <div class="metric-card">
        <span class="metric-value">$${formatMoney(winYTD?.value ?? 0)}</span>
        <span class="metric-label">Won YTD</span>
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
      <!-- Row 1 -->
      <section class="card">
        <h2>1 · ${escape(slideByKey('stage').title)}</h2>
        <p class="muted" style="margin-top:-0.5rem;font-size:0.8rem">${escape(slideByKey('stage').caption)}</p>
        <div class="chart-wrap"><canvas id="rpt-stage"></canvas></div>
      </section>
      <section class="card">
        <h2>2 · ${escape(slideByKey('type').title)}</h2>
        <p class="muted" style="margin-top:-0.5rem;font-size:0.8rem">${escape(slideByKey('type').caption)}</p>
        <div class="chart-wrap"><canvas id="rpt-type"></canvas></div>
      </section>

      <!-- Row 2 -->
      <section class="card">
        <h2>3 · ${escape(slideByKey('owner').title)}</h2>
        <p class="muted" style="margin-top:-0.5rem;font-size:0.8rem">${escape(slideByKey('owner').caption)}</p>
        <div class="chart-wrap"><canvas id="rpt-owner"></canvas></div>
      </section>
      <section class="card">
        <h2>4 · ${escape(slideByKey('topAccounts').title)}</h2>
        <p class="muted" style="margin-top:-0.5rem;font-size:0.8rem">${escape(slideByKey('topAccounts').caption)}</p>
        <div class="chart-wrap"><canvas id="rpt-topAccounts"></canvas></div>
      </section>

      <!-- Row 3 -->
      <section class="card">
        <h2>5 · ${escape(slideByKey('segment').title)}</h2>
        <p class="muted" style="margin-top:-0.5rem;font-size:0.8rem">${escape(slideByKey('segment').caption)}</p>
        <div class="chart-wrap"><canvas id="rpt-segment"></canvas></div>
      </section>
      <section class="card">
        <h2>6 · ${escape(slideByKey('aging').title)}</h2>
        <p class="muted" style="margin-top:-0.5rem;font-size:0.8rem">${escape(slideByKey('aging').caption)}</p>
        <div class="chart-wrap"><canvas id="rpt-aging"></canvas></div>
      </section>

      <!-- Row 4 - full width -->
      <section class="card" style="grid-column: 1 / -1">
        <h2>7 · ${escape(slideByKey('bookings').title)}</h2>
        <p class="muted" style="margin-top:-0.5rem;font-size:0.8rem">${escape(slideByKey('bookings').caption)}</p>
        <div class="chart-wrap chart-wrap-wide"><canvas id="rpt-bookings"></canvas></div>
      </section>

      <!-- Row 5 - full width -->
      <section class="card" style="grid-column: 1 / -1">
        <h2>8 · ${escape(slideByKey('forecast').title)}</h2>
        <p class="muted" style="margin-top:-0.5rem;font-size:0.8rem">${escape(slideByKey('forecast').caption)}</p>
        <div class="chart-wrap chart-wrap-wide"><canvas id="rpt-forecast"></canvas></div>
      </section>

      <!-- Row 6 - full width -->
      <section class="card" style="grid-column: 1 / -1">
        <h2>9 · ${escape(slideByKey('bottleneck').title)}</h2>
        <p class="muted" style="margin-top:-0.5rem;font-size:0.8rem">${escape(slideByKey('bottleneck').caption)}</p>
        <div class="chart-wrap chart-wrap-wide"><canvas id="rpt-bottleneck"></canvas></div>
      </section>

      <!-- Row 7 - full width - heatmap -->
      <section class="card" style="grid-column: 1 / -1">
        <h2>10 · ${escape(slideByKey('heatmap').title)}</h2>
        <p class="muted" style="margin-top:-0.5rem;font-size:0.8rem">${escape(slideByKey('heatmap').caption)}</p>
        ${renderHeatmapGrid(charts.heatmap)}
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
      ${raw(buildChartInitScript('rpt-', chartsJson))}
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
  const num = Number(n ?? 0);
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + 'M';
  if (num >= 1_000) return Math.round(num / 1_000) + 'k';
  return Math.round(num).toLocaleString('en-US');
}
