// functions/reports/index.js
//
// GET /reports — Reporting hub with executive and sales team reports.
// Charts are rendered via Chart.js (vendored at /js/chart.min.js).
//
// The executive tab is a 10-chart portfolio that showcases what PMS can
// do with the data already in D1 — funnel/stage analysis, weighted
// forecasting, segment win rates, bottleneck detection, quote aging,
// and a 12-week team activity heatmap. Each chart is self-contained:
// one SQL query, one JSON payload, one Chart.js init block (or a plain
// CSS grid for the heatmap). No extra CSS is needed — layout uses the
// existing `.dashboard-charts` 2-col grid and a few `grid-column:1/-1`
// overrides for full-width rows.

import { all, one } from '../lib/db.js';
import { layout, htmlResponse, html, escape, raw } from '../lib/layout.js';
import { loadStageCatalog } from '../lib/stages.js';
import { parseTransactionTypes } from '../lib/validators.js';

const TYPE_LABELS = {
  spares: 'Spares',
  eps: 'EPS',
  refurb: 'Refurb',
  service: 'Service',
};
function multiTypeLabel(csv) {
  return parseTransactionTypes(csv).map(t => TYPE_LABELS[t] ?? t).join(', ') || csv;
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export async function onRequestGet(context) {
  const { env, data, request } = context;
  const user = data?.user;
  const url = new URL(request.url);
  const tab = url.searchParams.get('tab') || 'executive';

  // Stage catalog → label + sort-order lookup (use MIN sort across types
  // because the same stage key appears under 4 transaction types).
  const catalog = await loadStageCatalog(env.DB);
  const stageLabels = new Map();
  const stageSortOrder = new Map();
  for (const list of catalog.values()) {
    for (const s of list) {
      if (!stageLabels.has(s.stage_key)) stageLabels.set(s.stage_key, s.label);
      const prev = stageSortOrder.get(s.stage_key);
      if (prev == null || s.sort_order < prev) stageSortOrder.set(s.stage_key, s.sort_order);
    }
  }

  // ── Run all queries in parallel ─────────────────────────────
  const [
    pipelineByStage,
    pipelineByType,
    pipelineByOwner,
    quoteMetrics,
    recentWins,
    topAccounts,
    weightedForecast,
    bookingsTrend,
    winYTD,
    winRateBySegment,
    quoteAging,
    stageAging,
    activityHeatmap,
    thisMonthWins,
  ] = await Promise.all([
    // #1 Pipeline funnel by stage
    all(env.DB,
      `SELECT stage, COUNT(*) AS n, COALESCE(SUM(estimated_value_usd), 0) AS total_value
         FROM opportunities
        WHERE stage NOT IN ('closed_won', 'closed_lost', 'closed_abandoned')
        GROUP BY stage`),
    // #2 Pipeline by type
    all(env.DB,
      `SELECT transaction_type, COUNT(*) AS n, COALESCE(SUM(estimated_value_usd), 0) AS total_value
         FROM opportunities
        WHERE stage NOT IN ('closed_won', 'closed_lost', 'closed_abandoned')
        GROUP BY transaction_type ORDER BY total_value DESC`),
    // #3 Pipeline by owner
    all(env.DB,
      `SELECT COALESCE(u.display_name, u.email, 'Unassigned') AS owner_name,
              COUNT(*) AS n, COALESCE(SUM(o.estimated_value_usd), 0) AS total_value
         FROM opportunities o
         LEFT JOIN users u ON u.id = o.owner_user_id
        WHERE o.stage NOT IN ('closed_won', 'closed_lost', 'closed_abandoned')
        GROUP BY o.owner_user_id ORDER BY total_value DESC`),
    // Quote metrics (used for KPI cards)
    one(env.DB,
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) AS accepted,
              SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
              SUM(CASE WHEN status = 'submitted' THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) AS drafts
         FROM quotes`),
    // Recent wins table
    all(env.DB,
      `SELECT o.number, o.title, o.estimated_value_usd, o.updated_at,
              a.name AS account_name
         FROM opportunities o
         LEFT JOIN accounts a ON a.id = o.account_id
        WHERE o.stage = 'closed_won'
        ORDER BY o.updated_at DESC LIMIT 10`),
    // #4 Top 10 accounts by pipeline
    all(env.DB,
      `SELECT a.id, a.name, a.alias,
              COUNT(o.id) AS opp_count,
              COALESCE(SUM(o.estimated_value_usd), 0) AS pipeline
         FROM opportunities o
         JOIN accounts a ON a.id = o.account_id
        WHERE o.stage NOT IN ('closed_won', 'closed_lost', 'closed_abandoned')
        GROUP BY a.id ORDER BY pipeline DESC LIMIT 10`),
    // #5 Weighted forecast — next 6 months
    all(env.DB,
      `SELECT strftime('%Y-%m', expected_close_date) AS month,
              COALESCE(SUM(estimated_value_usd), 0) AS committed,
              COALESCE(SUM(estimated_value_usd * COALESCE(probability, 0) / 100.0), 0) AS weighted,
              COUNT(*) AS n
         FROM opportunities
        WHERE stage NOT IN ('closed_won', 'closed_lost', 'closed_abandoned')
          AND expected_close_date IS NOT NULL
          AND expected_close_date >= date('now', 'start of month')
          AND expected_close_date < date('now', 'start of month', '+6 months')
        GROUP BY month ORDER BY month`),
    // #6 Bookings trend — closed-won $ per month, last 12 months
    all(env.DB,
      `SELECT strftime('%Y-%m', COALESCE(actual_close_date, updated_at)) AS month,
              COALESCE(SUM(estimated_value_usd), 0) AS value,
              COUNT(*) AS n
         FROM opportunities
        WHERE stage = 'closed_won'
          AND COALESCE(actual_close_date, updated_at) >= date('now', 'start of month', '-12 months')
        GROUP BY month ORDER BY month`),
    // YTD wins (KPI)
    one(env.DB,
      `SELECT COALESCE(SUM(estimated_value_usd), 0) AS value, COUNT(*) AS n
         FROM opportunities
        WHERE stage = 'closed_won'
          AND COALESCE(actual_close_date, updated_at) >= date('now', 'start of year')`),
    // #7 Win rate by segment
    all(env.DB,
      `SELECT COALESCE(a.segment, 'Other') AS segment,
              SUM(CASE WHEN o.stage = 'closed_won' THEN 1 ELSE 0 END) AS won,
              SUM(CASE WHEN o.stage = 'closed_lost' THEN 1 ELSE 0 END) AS lost,
              SUM(CASE WHEN o.stage = 'closed_abandoned' THEN 1 ELSE 0 END) AS abandoned
         FROM opportunities o
         LEFT JOIN accounts a ON a.id = o.account_id
        WHERE o.stage IN ('closed_won', 'closed_lost', 'closed_abandoned')
        GROUP BY segment ORDER BY segment`),
    // #8 Quote aging — raw rows, bucketed in JS
    all(env.DB,
      `SELECT q.id, q.total_price,
              CAST(julianday('now') - julianday(q.submitted_at) AS INTEGER) AS days_old
         FROM quotes q
        WHERE q.status IN ('submitted', 'approved_internal', 'internal_review')
          AND q.submitted_at IS NOT NULL`),
    // #9 Bottleneck — avg days in current stage
    all(env.DB,
      `SELECT stage,
              AVG(julianday('now') - julianday(stage_entered_at)) AS avg_days,
              COUNT(*) AS n
         FROM opportunities
        WHERE stage NOT IN ('closed_won', 'closed_lost', 'closed_abandoned')
        GROUP BY stage`),
    // #10 Activity heatmap — completed activities in last 84 days
    all(env.DB,
      `SELECT date(COALESCE(completed_at, created_at)) AS day, COUNT(*) AS n
         FROM activities
        WHERE type IN ('task', 'call', 'meeting', 'email', 'note')
          AND COALESCE(completed_at, created_at) >= date('now', '-84 days')
        GROUP BY day ORDER BY day`),
    // Won this month (KPI)
    one(env.DB,
      `SELECT COALESCE(SUM(estimated_value_usd), 0) AS value, COUNT(*) AS n
         FROM opportunities
        WHERE stage = 'closed_won'
          AND COALESCE(actual_close_date, updated_at) >= date('now', 'start of month')`),
  ]);

  // Sort stage-based charts by catalog sort_order so they render as a
  // proper funnel (Lead → RFQ → Qualifying → … → Closed Won) instead
  // of a random order.
  pipelineByStage.sort((a, b) =>
    (stageSortOrder.get(a.stage) ?? 999) - (stageSortOrder.get(b.stage) ?? 999));
  stageAging.sort((a, b) =>
    (stageSortOrder.get(a.stage) ?? 999) - (stageSortOrder.get(b.stage) ?? 999));

  const totalPipeline = pipelineByStage.reduce((a, s) => a + Number(s.total_value), 0);
  const totalOppCount = pipelineByStage.reduce((a, s) => a + s.n, 0);

  // ── Chart data payloads (JSON for client) ────────────────────
  const stageChartJSON = JSON.stringify({
    labels: pipelineByStage.map(s => stageLabels.get(s.stage) ?? s.stage),
    values: pipelineByStage.map(s => Number(s.total_value)),
    counts: pipelineByStage.map(s => s.n),
  });

  const typeChartJSON = JSON.stringify({
    labels: pipelineByType.map(s => multiTypeLabel(s.transaction_type)),
    values: pipelineByType.map(s => Number(s.total_value)),
  });

  const ownerChartJSON = JSON.stringify({
    labels: pipelineByOwner.map(s => s.owner_name),
    values: pipelineByOwner.map(s => Number(s.total_value)),
  });

  const topAccountsChartJSON = JSON.stringify({
    labels: topAccounts.map(a => a.alias ? `${a.name} (${a.alias})` : a.name),
    values: topAccounts.map(a => Number(a.pipeline)),
    counts: topAccounts.map(a => a.opp_count),
  });

  // Weighted forecast — fill in any missing months in the 6-month window
  // so the chart shows a complete x-axis even when a month has zero opps.
  const today = new Date();
  const forecastMonths = [];
  for (let i = 0; i < 6; i++) {
    const d = new Date(today.getFullYear(), today.getMonth() + i, 1);
    forecastMonths.push(d.toISOString().slice(0, 7));
  }
  const forecastMap = new Map(weightedForecast.map(r => [r.month, r]));
  const forecastChartJSON = JSON.stringify({
    labels: forecastMonths.map(m => {
      const [y, mm] = m.split('-');
      return `${MONTH_SHORT[parseInt(mm, 10) - 1]} ${y.slice(2)}`;
    }),
    committed: forecastMonths.map(m => Number(forecastMap.get(m)?.committed ?? 0)),
    weighted: forecastMonths.map(m => Number(forecastMap.get(m)?.weighted ?? 0)),
  });

  // Bookings trend — same pattern: fill missing months back 12 months.
  const bookingMonths = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    bookingMonths.push(d.toISOString().slice(0, 7));
  }
  const bookingsMap = new Map(bookingsTrend.map(r => [r.month, r]));
  const bookingsChartJSON = JSON.stringify({
    labels: bookingMonths.map(m => {
      const [y, mm] = m.split('-');
      return `${MONTH_SHORT[parseInt(mm, 10) - 1]} ${y.slice(2)}`;
    }),
    values: bookingMonths.map(m => Number(bookingsMap.get(m)?.value ?? 0)),
    counts: bookingMonths.map(m => Number(bookingsMap.get(m)?.n ?? 0)),
  });

  const segmentChartJSON = JSON.stringify({
    labels: winRateBySegment.map(s => s.segment),
    won: winRateBySegment.map(s => Number(s.won ?? 0)),
    lost: winRateBySegment.map(s => Number(s.lost ?? 0)),
    abandoned: winRateBySegment.map(s => Number(s.abandoned ?? 0)),
  });

  // Quote aging — client-side bucketing keeps the bucket order stable
  // (SQL CASE statements can't easily order by the CASE itself).
  const buckets = [
    { label: '0–7 d', max: 7, n: 0, value: 0 },
    { label: '8–14 d', max: 14, n: 0, value: 0 },
    { label: '15–30 d', max: 30, n: 0, value: 0 },
    { label: '31–60 d', max: 60, n: 0, value: 0 },
    { label: '61–90 d', max: 90, n: 0, value: 0 },
    { label: '90+ d', max: Infinity, n: 0, value: 0 },
  ];
  for (const q of quoteAging) {
    const d = Number(q.days_old ?? 0);
    for (const b of buckets) {
      if (d <= b.max) { b.n += 1; b.value += Number(q.total_price ?? 0); break; }
    }
  }
  const quoteAgingChartJSON = JSON.stringify({
    labels: buckets.map(b => b.label),
    counts: buckets.map(b => b.n),
    values: buckets.map(b => b.value),
  });

  const stageAgingChartJSON = JSON.stringify({
    labels: stageAging.map(s => stageLabels.get(s.stage) ?? s.stage),
    days: stageAging.map(s => Math.round(Number(s.avg_days ?? 0) * 10) / 10),
    counts: stageAging.map(s => Number(s.n ?? 0)),
  });

  // Activity heatmap — build a 7-row × 12-column grid anchored to the
  // current week (latest column = this week). We iterate day-by-day
  // starting from "12 weeks ago Sunday" so each cell is a specific
  // calendar date. Color intensity is relative to the busiest day in
  // the window (max=1.0, scaled down to 5 buckets).
  const heatmapMap = new Map(activityHeatmap.map(r => [r.day, Number(r.n)]));
  const weeksBack = 12;
  // Anchor the grid: find the Sunday of the week that is (weeksBack-1)
  // weeks before today, so the rightmost column ends on Saturday of
  // the current week.
  const endOfThisWeek = new Date(today);
  endOfThisWeek.setDate(today.getDate() + (6 - today.getDay()));
  const gridStart = new Date(endOfThisWeek);
  gridStart.setDate(gridStart.getDate() - (weeksBack * 7 - 1));
  const heatmapCells = []; // 7 rows (Sun..Sat) × 12 cols (weeks)
  for (let dayRow = 0; dayRow < 7; dayRow++) {
    const row = [];
    for (let w = 0; w < weeksBack; w++) {
      const d = new Date(gridStart);
      d.setDate(d.getDate() + (w * 7) + dayRow);
      const key = d.toISOString().slice(0, 10);
      row.push({ date: key, count: heatmapMap.get(key) ?? 0, isFuture: d > today });
    }
    heatmapCells.push(row);
  }
  const heatmapTotal = heatmapCells.flat().reduce((a, c) => a + c.count, 0);
  const maxCount = Math.max(1, ...heatmapCells.flat().map(c => c.count));
  function heatColor(count, isFuture) {
    if (isFuture) return 'transparent';
    if (count === 0) return '#eef4f9';
    const t = count / maxCount;
    if (t <= 0.2) return '#b8d4ee';
    if (t <= 0.4) return '#7ab3e0';
    if (t <= 0.6) return '#3b8acb';
    if (t <= 0.8) return '#1968b3';
    return '#0969da';
  }

  // ── Executive tab body ──────────────────────────────────────
  const executiveTab = html`
    <div class="dashboard-metrics" style="margin-bottom:1rem">
      <div class="metric-card">
        <span class="metric-value">$${formatMoney(totalPipeline)}</span>
        <span class="metric-label">Open pipeline</span>
      </div>
      <div class="metric-card">
        <span class="metric-value">${totalOppCount}</span>
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
        <h2>1 · Pipeline funnel by stage</h2>
        <p class="muted" style="margin-top:-0.5rem;font-size:0.8rem">Open opportunities ordered along the lifecycle — earliest stages on top.</p>
        <canvas id="rpt-stage" height="260"></canvas>
      </section>
      <section class="card">
        <h2>2 · Pipeline by transaction type</h2>
        <p class="muted" style="margin-top:-0.5rem;font-size:0.8rem">Line-of-business mix across the open pipeline.</p>
        <canvas id="rpt-type" height="260"></canvas>
      </section>

      <!-- Row 2 -->
      <section class="card">
        <h2>3 · Pipeline by owner</h2>
        <p class="muted" style="margin-top:-0.5rem;font-size:0.8rem">Open opportunity value assigned to each account owner.</p>
        <canvas id="rpt-owner" height="260"></canvas>
      </section>
      <section class="card">
        <h2>4 · Top 10 accounts by pipeline</h2>
        <p class="muted" style="margin-top:-0.5rem;font-size:0.8rem">Biggest single-account concentrations of open value.</p>
        <canvas id="rpt-topacct" height="260"></canvas>
      </section>

      <!-- Row 3 -->
      <section class="card">
        <h2>5 · Win rate by customer segment</h2>
        <p class="muted" style="margin-top:-0.5rem;font-size:0.8rem">Won / lost / abandoned counts grouped by segment.</p>
        <canvas id="rpt-segment" height="260"></canvas>
      </section>
      <section class="card">
        <h2>6 · Quote aging</h2>
        <p class="muted" style="margin-top:-0.5rem;font-size:0.8rem">How long submitted-but-still-open quotes have been waiting.</p>
        <canvas id="rpt-aging" height="260"></canvas>
      </section>

      <!-- Row 4 - full width -->
      <section class="card" style="grid-column: 1 / -1">
        <h2>7 · Bookings trend — last 12 months</h2>
        <p class="muted" style="margin-top:-0.5rem;font-size:0.8rem">Closed-won value by close month. Dots show count of wins per month.</p>
        <canvas id="rpt-bookings" height="180"></canvas>
      </section>

      <!-- Row 5 - full width -->
      <section class="card" style="grid-column: 1 / -1">
        <h2>8 · Weighted forecast — next 6 months</h2>
        <p class="muted" style="margin-top:-0.5rem;font-size:0.8rem">Committed (100%) vs. probability-weighted forecast by expected close month.</p>
        <canvas id="rpt-forecast" height="180"></canvas>
      </section>

      <!-- Row 6 - full width -->
      <section class="card" style="grid-column: 1 / -1">
        <h2>9 · Bottleneck — average days in current stage</h2>
        <p class="muted" style="margin-top:-0.5rem;font-size:0.8rem">How long open opps have been sitting in each stage. Tall bars are where deals stall.</p>
        <canvas id="rpt-bottleneck" height="200"></canvas>
      </section>

      <!-- Row 7 - full width: heatmap (custom CSS grid, not Chart.js) -->
      <section class="card" style="grid-column: 1 / -1">
        <h2>10 · Team activity heatmap — last 12 weeks</h2>
        <p class="muted" style="margin-top:-0.5rem;font-size:0.8rem">${heatmapTotal} tasks, notes, calls, meetings, and emails logged in the last 84 days.</p>
        <div style="overflow-x:auto;padding:0.5rem 0">
          <div style="display:grid;grid-template-columns:2.5rem repeat(12, minmax(28px, 1fr));gap:3px;max-width:760px;font-size:0.7rem">
            <div></div>
            ${Array.from({ length: weeksBack }, (_, w) => html`<div style="text-align:center;color:var(--fg-muted)">${w === weeksBack - 1 ? 'now' : (w === 0 ? '12w' : '')}</div>`)}
            ${heatmapCells.map((row, dayIdx) => html`
              <div style="color:var(--fg-muted);padding-right:0.4rem;text-align:right;align-self:center">${DAY_LABELS[dayIdx]}</div>
              ${row.map(cell => html`<div title="${escape(cell.date)}: ${cell.count} ${cell.count === 1 ? 'activity' : 'activities'}" style="aspect-ratio:1;background:${heatColor(cell.count, cell.isFuture)};border-radius:3px;border:${cell.isFuture ? '1px dashed var(--border)' : 'none'}"></div>`)}
            `)}
          </div>
        </div>
        <div style="margin-top:0.75rem;font-size:0.7rem;color:var(--fg-muted);display:flex;gap:0.4rem;align-items:center">
          <span>Less</span>
          <div style="width:12px;height:12px;background:#eef4f9;border-radius:2px"></div>
          <div style="width:12px;height:12px;background:#b8d4ee;border-radius:2px"></div>
          <div style="width:12px;height:12px;background:#7ab3e0;border-radius:2px"></div>
          <div style="width:12px;height:12px;background:#3b8acb;border-radius:2px"></div>
          <div style="width:12px;height:12px;background:#1968b3;border-radius:2px"></div>
          <div style="width:12px;height:12px;background:#0969da;border-radius:2px"></div>
          <span>More</span>
          <span style="margin-left:1rem">Busiest day: <strong>${maxCount}</strong> activities</span>
        </div>
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

  // ── Sales team tab (unchanged from before) ──────────────────
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
      var palette = [
        'rgba(9,105,218,0.75)', 'rgba(26,127,55,0.75)', 'rgba(191,135,0,0.75)',
        'rgba(207,34,46,0.75)', 'rgba(130,80,223,0.75)', 'rgba(17,138,178,0.75)',
        'rgba(219,112,60,0.75)', 'rgba(100,116,139,0.75)', 'rgba(234,88,12,0.75)',
        'rgba(5,150,105,0.75)', 'rgba(217,70,239,0.75)', 'rgba(14,116,144,0.75)'
      ];
      Chart.defaults.font.family = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif";
      Chart.defaults.font.size = 12;

      function fmt$(v) {
        if (v >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
        if (v >= 1e3) return '$' + Math.round(v / 1e3) + 'k';
        return '$' + Math.round(v);
      }

      // ── #1 Pipeline funnel by stage ─────────────────────
      var stage = ${raw(stageChartJSON)};
      if (stage.labels.length && document.getElementById('rpt-stage')) {
        new Chart(document.getElementById('rpt-stage'), {
          type: 'bar',
          data: {
            labels: stage.labels,
            datasets: [{
              label: 'Pipeline ($)',
              data: stage.values,
              backgroundColor: palette,
              borderRadius: 4,
            }]
          },
          options: {
            responsive: true,
            indexAxis: 'y',
            plugins: {
              legend: { display: false },
              tooltip: {
                callbacks: {
                  label: function(ctx) {
                    return fmt$(ctx.parsed.x) + ' · ' + stage.counts[ctx.dataIndex] + ' opps';
                  }
                }
              }
            },
            scales: { x: { ticks: { callback: function(v) { return fmt$(v); } } } }
          }
        });
      }

      // ── #2 Pipeline by type ─────────────────────────────
      var type = ${raw(typeChartJSON)};
      if (type.labels.length && document.getElementById('rpt-type')) {
        new Chart(document.getElementById('rpt-type'), {
          type: 'doughnut',
          data: { labels: type.labels, datasets: [{ data: type.values, backgroundColor: palette }] },
          options: {
            responsive: true,
            plugins: {
              tooltip: {
                callbacks: { label: function(ctx) { return ctx.label + ': ' + fmt$(ctx.parsed); } }
              }
            }
          }
        });
      }

      // ── #3 Pipeline by owner ────────────────────────────
      var owner = ${raw(ownerChartJSON)};
      if (owner.labels.length && document.getElementById('rpt-owner')) {
        new Chart(document.getElementById('rpt-owner'), {
          type: 'bar',
          data: {
            labels: owner.labels,
            datasets: [{
              label: 'Pipeline ($)',
              data: owner.values,
              backgroundColor: palette,
              borderRadius: 4,
            }]
          },
          options: {
            responsive: true,
            indexAxis: 'y',
            plugins: { legend: { display: false } },
            scales: { x: { ticks: { callback: function(v) { return fmt$(v); } } } }
          }
        });
      }

      // ── #4 Top 10 accounts ──────────────────────────────
      var topacct = ${raw(topAccountsChartJSON)};
      if (topacct.labels.length && document.getElementById('rpt-topacct')) {
        new Chart(document.getElementById('rpt-topacct'), {
          type: 'bar',
          data: {
            labels: topacct.labels,
            datasets: [{
              label: 'Pipeline ($)',
              data: topacct.values,
              backgroundColor: 'rgba(9,105,218,0.75)',
              borderRadius: 4,
            }]
          },
          options: {
            responsive: true,
            indexAxis: 'y',
            plugins: {
              legend: { display: false },
              tooltip: {
                callbacks: {
                  label: function(ctx) {
                    return fmt$(ctx.parsed.x) + ' · ' + topacct.counts[ctx.dataIndex] + ' opps';
                  }
                }
              }
            },
            scales: { x: { ticks: { callback: function(v) { return fmt$(v); } } } }
          }
        });
      }

      // ── #5 Win rate by segment (stacked) ────────────────
      var seg = ${raw(segmentChartJSON)};
      if (seg.labels.length && document.getElementById('rpt-segment')) {
        new Chart(document.getElementById('rpt-segment'), {
          type: 'bar',
          data: {
            labels: seg.labels,
            datasets: [
              { label: 'Won', data: seg.won, backgroundColor: 'rgba(26,127,55,0.75)', borderRadius: 3 },
              { label: 'Lost', data: seg.lost, backgroundColor: 'rgba(207,34,46,0.75)', borderRadius: 3 },
              { label: 'Abandoned', data: seg.abandoned, backgroundColor: 'rgba(100,116,139,0.65)', borderRadius: 3 },
            ]
          },
          options: {
            responsive: true,
            indexAxis: 'y',
            plugins: { legend: { position: 'bottom' } },
            scales: {
              x: { stacked: true, beginAtZero: true, ticks: { precision: 0 } },
              y: { stacked: true }
            }
          }
        });
      }

      // ── #6 Quote aging ──────────────────────────────────
      var aging = ${raw(quoteAgingChartJSON)};
      if (aging.labels.length && document.getElementById('rpt-aging')) {
        new Chart(document.getElementById('rpt-aging'), {
          type: 'bar',
          data: {
            labels: aging.labels,
            datasets: [{
              label: 'Quotes',
              data: aging.counts,
              backgroundColor: [
                'rgba(26,127,55,0.75)',   // 0-7
                'rgba(26,127,55,0.55)',   // 8-14
                'rgba(191,135,0,0.75)',   // 15-30
                'rgba(219,112,60,0.75)',  // 31-60
                'rgba(207,34,46,0.70)',   // 61-90
                'rgba(207,34,46,0.95)',   // 90+
              ],
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
                    var n = ctx.parsed.y;
                    var v = aging.values[ctx.dataIndex];
                    return n + ' quote' + (n === 1 ? '' : 's') + ' · ' + fmt$(v);
                  }
                }
              }
            },
            scales: { y: { beginAtZero: true, ticks: { precision: 0 } } }
          }
        });
      }

      // ── #7 Bookings trend (line) ────────────────────────
      var book = ${raw(bookingsChartJSON)};
      if (book.labels.length && document.getElementById('rpt-bookings')) {
        new Chart(document.getElementById('rpt-bookings'), {
          type: 'line',
          data: {
            labels: book.labels,
            datasets: [{
              label: 'Closed-won $',
              data: book.values,
              borderColor: 'rgba(26,127,55,1)',
              backgroundColor: 'rgba(26,127,55,0.15)',
              tension: 0.35,
              fill: true,
              pointRadius: 4,
              pointHoverRadius: 6,
              pointBackgroundColor: 'rgba(26,127,55,1)',
            }]
          },
          options: {
            responsive: true,
            plugins: {
              legend: { display: false },
              tooltip: {
                callbacks: {
                  label: function(ctx) {
                    return fmt$(ctx.parsed.y) + ' · ' + book.counts[ctx.dataIndex] + ' wins';
                  }
                }
              }
            },
            scales: { y: { beginAtZero: true, ticks: { callback: function(v) { return fmt$(v); } } } }
          }
        });
      }

      // ── #8 Weighted forecast (grouped bar) ──────────────
      var fc = ${raw(forecastChartJSON)};
      if (fc.labels.length && document.getElementById('rpt-forecast')) {
        new Chart(document.getElementById('rpt-forecast'), {
          type: 'bar',
          data: {
            labels: fc.labels,
            datasets: [
              { label: 'Committed (100%)', data: fc.committed, backgroundColor: 'rgba(100,116,139,0.55)', borderRadius: 4 },
              { label: 'Weighted forecast', data: fc.weighted, backgroundColor: 'rgba(9,105,218,0.85)', borderRadius: 4 },
            ]
          },
          options: {
            responsive: true,
            plugins: {
              legend: { position: 'bottom' },
              tooltip: { callbacks: { label: function(ctx) { return ctx.dataset.label + ': ' + fmt$(ctx.parsed.y); } } }
            },
            scales: { y: { beginAtZero: true, ticks: { callback: function(v) { return fmt$(v); } } } }
          }
        });
      }

      // ── #9 Bottleneck — avg days in stage ───────────────
      var bn = ${raw(stageAgingChartJSON)};
      if (bn.labels.length && document.getElementById('rpt-bottleneck')) {
        new Chart(document.getElementById('rpt-bottleneck'), {
          type: 'bar',
          data: {
            labels: bn.labels,
            datasets: [{
              label: 'Avg days in stage',
              data: bn.days,
              backgroundColor: bn.days.map(function(d) {
                if (d > 45) return 'rgba(207,34,46,0.80)';
                if (d > 21) return 'rgba(191,135,0,0.80)';
                return 'rgba(26,127,55,0.80)';
              }),
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
                    return ctx.parsed.y.toFixed(1) + ' days avg · ' + bn.counts[ctx.dataIndex] + ' opps';
                  }
                }
              }
            },
            scales: { y: { beginAtZero: true, title: { display: true, text: 'Average days' } } }
          }
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
  const num = Number(n ?? 0);
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + 'M';
  if (num >= 1_000) return Math.round(num / 1_000) + 'k';
  return Math.round(num).toLocaleString('en-US');
}
