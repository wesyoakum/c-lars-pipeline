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

  // ---- Activity-tab queries --------------------------------------------
  //
  // Weekly buckets use strftime('%Y-%W', d). %W is Monday-start week of
  // year. We pull 26 weeks of history for the two weekly charts; the
  // pie chart pulls 12 months and the client filters by range + type.
  //
  // For both quote queries we use "latest issued revision per quote" —
  // a row with submitted_at IS NOT NULL that no other row on the same
  // (opportunity_id, quote_seq) supersedes with a later submitted_at.
  // supersedes_quote_id is reliable (set by revise.js) but we use the
  // submitted_at-based predicate because it handles the edge case where
  // a revision hasn't been issued yet — we want to keep the earlier
  // revision counted until the new one actually ships.
  // SQLite's date() modifiers don't include "weeks" — we express 26
  // weeks as 182 days. Without this the cutoff evaluates to NULL,
  // WHERE created_at >= NULL is always false, and the chart looks
  // empty even when data exists. (Same trap bit us shipping v0.205.)
  const weekCutoff = `date('now', '-182 days')`;
  const monthCutoff = `date('now', '-12 months')`;
  const [
    newOppsWeekly,
    quotesIssuedWeekly,
    quoteOutcomeRows,
    pipelineByOwner,
    pipelineByStage,
    quoteMetrics,
    recentWins,
    winYTD,
    thisMonthWins,
  ] = await Promise.all([
    all(env.DB,
      `SELECT strftime('%Y-%W', created_at) AS week,
              date(MIN(created_at)) AS any_day,
              COUNT(*) AS n,
              COALESCE(SUM(estimated_value_usd), 0) AS total_value
         FROM opportunities
        WHERE created_at >= ${weekCutoff}
        GROUP BY week
        ORDER BY week`),
    all(env.DB,
      `SELECT strftime('%Y-%W', q.submitted_at) AS week,
              date(MIN(q.submitted_at)) AS any_day,
              COUNT(*) AS n,
              COALESCE(SUM(q.total_price), 0) AS total_value
         FROM quotes q
        WHERE q.submitted_at IS NOT NULL
          AND q.submitted_at >= ${weekCutoff}
          AND NOT EXISTS (
            SELECT 1 FROM quotes q2
             WHERE q2.opportunity_id = q.opportunity_id
               AND q2.quote_seq = q.quote_seq
               AND q2.submitted_at IS NOT NULL
               AND q2.submitted_at > q.submitted_at
          )
        GROUP BY week
        ORDER BY week`),
    all(env.DB,
      `SELECT q.id, q.submitted_at, q.status, q.quote_type, q.total_price
         FROM quotes q
        WHERE q.submitted_at IS NOT NULL
          AND q.submitted_at >= ${monthCutoff}
          AND NOT EXISTS (
            SELECT 1 FROM quotes q2
             WHERE q2.opportunity_id = q.opportunity_id
               AND q2.quote_seq = q.quote_seq
               AND q2.submitted_at IS NOT NULL
               AND q2.submitted_at > q.submitted_at
          )
        ORDER BY q.submitted_at DESC`),
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

  // ---- Weekly-chart label computation ---------------------------------
  //
  // The queries above give us one row per ISO week with a sample date
  // inside it. We roll that forward to the Monday of each week for
  // consistent labels ("Apr 13" etc.), and we backfill zero weeks so
  // the chart is continuous even when no opp / quote landed that week.
  const mondayFromIso = (iso) => {
    const d = new Date(iso + 'T00:00:00Z');
    const dow = d.getUTCDay();               // 0=Sun..6=Sat
    const diff = dow === 0 ? 6 : dow - 1;    // back to Monday
    d.setUTCDate(d.getUTCDate() - diff);
    return d;
  };
  const weekLabel = (d) => {
    const m = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()];
    return `${m} ${d.getUTCDate()}`;
  };

  function weekSeries(rows) {
    // Build a Map keyed by ISO date of the Monday, so back-fill and
    // real-row lookup both operate on the same key.
    const byMonday = new Map();
    for (const r of rows) {
      if (!r.any_day) continue;
      const mon = mondayFromIso(r.any_day);
      const key = mon.toISOString().slice(0, 10);
      byMonday.set(key, {
        mondayIso: key,
        label: weekLabel(mon),
        n: r.n || 0,
        value: r.total_value || 0,
      });
    }
    // Back-fill 26 weeks ending on this week's Monday.
    const out = [];
    const today = new Date();
    const thisMonday = mondayFromIso(today.toISOString().slice(0, 10));
    for (let i = 25; i >= 0; i--) {
      const m = new Date(thisMonday);
      m.setUTCDate(m.getUTCDate() - i * 7);
      const key = m.toISOString().slice(0, 10);
      const existing = byMonday.get(key);
      out.push(existing || {
        mondayIso: key,
        label: weekLabel(m),
        n: 0,
        value: 0,
      });
    }
    return out;
  }

  const newOppsSeries = weekSeries(newOppsWeekly);
  const quotesIssuedSeries = weekSeries(quotesIssuedWeekly);

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

  // Outcome bucketing — the pie chart only cares about terminal states
  // of issued quotes. Each row already has submitted_at + status; we
  // classify the four end-states the user asked for, plus "pending"
  // for still-open ones. The client filter can optionally hide pending.
  const OUTCOME_BUCKET = {
    accepted:  'accepted',
    completed: 'accepted',   // completed is a post-acceptance terminal state; roll up
    rejected:  'rejected',
    expired:   'expired',
    dead:      'cancelled',  // "cancelled" = superseded / abandoned quote
  };
  const outcomeRows = quoteOutcomeRows.map((r) => ({
    submitted_at: r.submitted_at ? r.submitted_at.slice(0, 10) : '',
    outcome: OUTCOME_BUCKET[r.status] || 'pending',
    quote_type: r.quote_type || 'spares',
    value: Number(r.total_price) || 0,
  }));

  const activityPayload = JSON.stringify({
    newOpps: newOppsSeries,
    quotesIssued: quotesIssuedSeries,
    outcomes: outcomeRows,
  });

  const activityTab = html`
    <section class="card">
      <h2>New opportunities by week</h2>
      <p class="muted" style="margin-top:-0.5rem;font-size:0.8rem">
        Count (left axis) and total estimated value (right axis) of opportunities created
        each week, last 26 weeks. Week of the Monday.
      </p>
      <div class="chart-wrap chart-wrap-wide"><canvas id="act-new-opps"></canvas></div>
    </section>

    <section class="card">
      <h2>Quotes issued by week</h2>
      <p class="muted" style="margin-top:-0.5rem;font-size:0.8rem">
        Count (left axis) and total quoted value (right axis) of quotes issued each week,
        last 26 weeks. Revisions count once \u2014 each quote is bucketed by its most recent
        issued revision, with the latest revision's total_price.
      </p>
      <div class="chart-wrap chart-wrap-wide"><canvas id="act-quotes-issued"></canvas></div>
    </section>

    <section class="card" x-data="outcomePie()" x-init="init()">
      <div class="card-header">
        <h2>Outcome of issued quotes</h2>
        <div style="display:flex;gap:0.75rem;flex-wrap:wrap;align-items:center">
          <div style="display:inline-flex;gap:0.25rem;flex-wrap:wrap">
            <button type="button" class="pill pill-toggle" :class="{'pill-active': range==='3m'}" @click="range='3m'; render()">3 months</button>
            <button type="button" class="pill pill-toggle" :class="{'pill-active': range==='6m'}" @click="range='6m'; render()">6 months</button>
            <button type="button" class="pill pill-toggle" :class="{'pill-active': range==='12m'}" @click="range='12m'; render()">12 months</button>
          </div>
          <select x-model="quoteType" @change="render()" style="max-width:220px">
            <option value="">All types</option>
            <option value="spares">Spares</option>
            <option value="eps">EPS</option>
            <option value="service">Service</option>
            <option value="refurb_baseline">Refurb \u2014 Baseline</option>
            <option value="refurb_modified">Refurb \u2014 Modified</option>
            <option value="refurb_supplemental">Refurb \u2014 Supplemental</option>
          </select>
        </div>
      </div>
      <p class="muted" style="margin-top:-0.25rem;font-size:0.8rem">
        How each issued quote ended up, by latest revision. Active quotes still in flight
        (issued / revision_issued) are excluded.
      </p>
      <div class="chart-wrap"><canvas id="act-outcomes"></canvas></div>
      <p class="muted" style="margin-top:0.5rem;font-size:0.8rem" x-show="total === 0">
        No matching quotes in this range.
      </p>
    </section>
  `;

  const tabs = html`
    <nav class="card" style="padding: 0.5rem 1rem;">
      <a class="nav-link ${tab === 'executive' ? 'active' : ''}" href="/reports">Executive summary</a>
      <a class="nav-link ${tab === 'activity' ? 'active' : ''}" href="/reports?tab=activity">Activity</a>
      <a class="nav-link ${tab === 'sales' ? 'active' : ''}" href="/reports?tab=sales">Sales team</a>
    </nav>
  `;

  const bodyMain = (
    tab === 'sales' ? salesTab :
    tab === 'activity' ? activityTab :
    executiveTab
  );

  const body = html`
    <section class="card">
      <h1 class="page-title">Reports</h1>
    </section>
    ${tabs}
    ${bodyMain}

    <script>
    document.addEventListener('DOMContentLoaded', function() {
      ${tab === 'executive' ? raw(buildChartInitScript('rpt-', chartsJson)) : ''}
      ${tab === 'activity' ? raw(buildActivityChartsScript(activityPayload)) : ''}
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

/**
 * Builds the client-side JS for the three Activity-tab charts.
 *
 * Two weekly bar charts (dual-axis: count on y-left, value on y-right)
 * and one pie/doughnut of quote outcomes with Alpine-driven toggles
 * for range (3m / 6m / 12m) and quote type.
 *
 * `payloadJson` is the pre-rendered JSON string already ready to drop
 * into a `var data = ${payloadJson};` assignment — we stringify the
 * object in the route handler, not here.
 */
function buildActivityChartsScript(payloadJson) {
  return `
(function () {
  if (typeof Chart === 'undefined') { console.error('Chart.js not loaded'); return; }
  var DATA = ${payloadJson};

  Chart.defaults.font.family = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif";
  Chart.defaults.font.size = 12;
  Chart.defaults.maintainAspectRatio = false;

  function fmt$(v) {
    if (v >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
    if (v >= 1e3) return '$' + Math.round(v / 1e3) + 'k';
    return '$' + Math.round(v);
  }

  // ---- Weekly dual-axis chart factory -------------------------------
  function makeWeeklyChart(canvasId, series, countLabel, valueLabel) {
    var canvas = document.getElementById(canvasId);
    if (!canvas) return;
    var labels = series.map(function (s) { return s.label; });
    var counts = series.map(function (s) { return s.n; });
    var values = series.map(function (s) { return s.value; });
    return new Chart(canvas, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [
          {
            label: countLabel,
            data: counts,
            backgroundColor: 'rgba(9,105,218,0.75)',
            borderRadius: 4,
            yAxisID: 'yCount',
            order: 2,
          },
          {
            type: 'line',
            label: valueLabel,
            data: values,
            borderColor: 'rgba(191,135,0,0.9)',
            backgroundColor: 'rgba(191,135,0,0.18)',
            tension: 0.25,
            yAxisID: 'yValue',
            order: 1,
          },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'bottom' },
          tooltip: {
            callbacks: {
              label: function (ctx) {
                if (ctx.dataset.yAxisID === 'yValue') {
                  return ctx.dataset.label + ': ' + fmt$(ctx.parsed.y);
                }
                return ctx.dataset.label + ': ' + ctx.parsed.y;
              }
            }
          }
        },
        scales: {
          yCount: {
            position: 'left',
            beginAtZero: true,
            ticks: { precision: 0 },
            title: { display: true, text: countLabel }
          },
          yValue: {
            position: 'right',
            beginAtZero: true,
            grid: { drawOnChartArea: false },
            ticks: { callback: function (v) { return fmt$(v); } },
            title: { display: true, text: valueLabel }
          },
        },
      },
    });
  }

  makeWeeklyChart('act-new-opps', DATA.newOpps, 'New opportunities', 'Estimated value');
  makeWeeklyChart('act-quotes-issued', DATA.quotesIssued, 'Quotes issued', 'Quoted value');

  // ---- Outcome doughnut with Alpine-driven toggles ------------------
  //
  // Exposed as Alpine.data('outcomePie', ...). The card in the HTML
  // uses x-init="init()" so the chart renders immediately, and
  // @click handlers call render() to re-draw after mutating range /
  // quoteType.
  document.addEventListener('alpine:init', function () {
    Alpine.data('outcomePie', function () {
      return {
        range: '12m',
        quoteType: '',
        chart: null,
        total: 0,
        init: function () {
          var self = this;
          // Defer until the canvas is in the DOM.
          requestAnimationFrame(function () { self.render(); });
        },
        render: function () {
          var canvas = document.getElementById('act-outcomes');
          if (!canvas) return;
          var cutoff = new Date();
          var months = this.range === '3m' ? 3 : this.range === '6m' ? 6 : 12;
          cutoff.setMonth(cutoff.getMonth() - months);
          var cutoffIso = cutoff.toISOString().slice(0, 10);
          var typeFilter = this.quoteType;
          var counts = { accepted: 0, rejected: 0, expired: 0, cancelled: 0 };
          var total = 0;
          DATA.outcomes.forEach(function (r) {
            if (!r.submitted_at || r.submitted_at < cutoffIso) return;
            if (typeFilter && r.quote_type !== typeFilter) return;
            if (!counts.hasOwnProperty(r.outcome)) return; // pending etc.
            counts[r.outcome] += 1;
            total += 1;
          });
          this.total = total;
          var labels = ['Accepted', 'Rejected', 'Expired', 'Cancelled'];
          var values = [counts.accepted, counts.rejected, counts.expired, counts.cancelled];
          var colors = [
            'rgba(26,127,55,0.75)',    // accepted — green
            'rgba(207,34,46,0.75)',    // rejected — red
            'rgba(191,135,0,0.75)',    // expired — amber
            'rgba(130,80,223,0.75)',   // cancelled — purple
          ];
          if (this.chart) {
            this.chart.data.labels = labels;
            this.chart.data.datasets[0].data = values;
            this.chart.update();
            return;
          }
          this.chart = new Chart(canvas, {
            type: 'doughnut',
            data: {
              labels: labels,
              datasets: [{ data: values, backgroundColor: colors }]
            },
            options: {
              responsive: true, maintainAspectRatio: false,
              plugins: {
                legend: { position: 'bottom' },
                tooltip: {
                  callbacks: {
                    label: function (ctx) {
                      var v = ctx.parsed;
                      var pct = total > 0 ? Math.round((v / total) * 100) : 0;
                      return ctx.label + ': ' + v + ' (' + pct + '%)';
                    }
                  }
                }
              }
            }
          });
        }
      };
    });
  });
})();
`;
}
