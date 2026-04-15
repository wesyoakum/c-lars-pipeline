// functions/lib/chart-data.js
//
// Shared data-gathering for the 10-chart portfolio used on both
// the /reports page and the dashboard carousel on /.
//
// One call — `gatherDashboardCharts(db)` — runs every query in
// parallel and returns a bundle of JSON-ready payloads plus the
// stage-label Map and pipeline totals. Each payload matches the
// shape the client-side Chart.js init blocks expect; the heatmap
// payload is a pre-built 7×12 cell grid ready for a CSS-grid render.
//
// The helper also exports `renderHeatmapGrid()` which returns the
// HTML chunk for chart #10 so both consumers stay DRY.

import { all, one } from './db.js';
import { loadStageCatalog } from './stages.js';
import { parseTransactionTypes } from './validators.js';
import { html, escape } from './layout.js';

const TYPE_LABELS = {
  spares: 'Spares',
  eps: 'EPS',
  refurb: 'Refurb',
  service: 'Service',
};

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function multiTypeLabel(csv) {
  return parseTransactionTypes(csv).map(t => TYPE_LABELS[t] ?? t).join(', ') || csv;
}

/**
 * Chart slide catalog — ordered list of the 10 showcase charts with
 * machine-readable keys, human-readable titles, short captions, and
 * the canvas/container type ('chart' or 'heatmap'). Shared between
 * reports and dashboard so both show the same order and titles.
 */
export const CHART_SLIDES = [
  { key: 'stage',      title: 'Pipeline funnel by stage',
    caption: 'Open opportunities ordered along the lifecycle — earliest stages on top.',
    kind: 'chart' },
  { key: 'type',       title: 'Pipeline by transaction type',
    caption: 'Line-of-business mix across the open pipeline.',
    kind: 'chart' },
  { key: 'owner',      title: 'Pipeline by owner',
    caption: 'Open opportunity value assigned to each account owner.',
    kind: 'chart' },
  { key: 'topAccounts', title: 'Top 10 accounts by pipeline',
    caption: 'Biggest single-account concentrations of open value.',
    kind: 'chart' },
  { key: 'segment',    title: 'Win rate by customer segment',
    caption: 'Won / lost / abandoned counts grouped by segment.',
    kind: 'chart' },
  { key: 'aging',      title: 'Quote aging',
    caption: 'How long submitted-but-still-open quotes have been waiting.',
    kind: 'chart' },
  { key: 'bookings',   title: 'Bookings trend — last 12 months',
    caption: 'Closed-won value by close month.',
    kind: 'chart' },
  { key: 'forecast',   title: 'Weighted forecast — next 6 months',
    caption: 'Committed (100%) vs. probability-weighted forecast by expected close month.',
    kind: 'chart' },
  { key: 'bottleneck', title: 'Bottleneck — avg days in current stage',
    caption: 'How long open opps have been sitting in each stage.',
    kind: 'chart' },
  { key: 'heatmap',    title: 'Team activity heatmap — last 12 weeks',
    caption: 'Tasks, notes, calls, meetings, and emails logged day-by-day.',
    kind: 'heatmap' },
];

/**
 * Run all 10 portfolio queries in parallel and return a bundle
 * containing:
 *   - stageLabels     Map<stage_key, label>  (for tables that need it)
 *   - totals          { pipeline: number, opps: number }
 *   - charts          { stage, type, owner, topAccounts, segment,
 *                       aging, bookings, forecast, bottleneck, heatmap }
 *   - chartsJson      same but each entry pre-serialized for raw() use
 */
export async function gatherDashboardCharts(db) {
  const catalog = await loadStageCatalog(db);
  const stageLabels = new Map();
  const stageSortOrder = new Map();
  for (const list of catalog.values()) {
    for (const s of list) {
      if (!stageLabels.has(s.stage_key)) stageLabels.set(s.stage_key, s.label);
      const prev = stageSortOrder.get(s.stage_key);
      if (prev == null || s.sort_order < prev) stageSortOrder.set(s.stage_key, s.sort_order);
    }
  }

  const [
    pipelineByStageRows,
    pipelineByTypeRows,
    pipelineByOwnerRows,
    topAccountsRows,
    weightedForecastRows,
    bookingsTrendRows,
    winRateBySegmentRows,
    quoteAgingRows,
    stageAgingRows,
    activityHeatmapRows,
  ] = await Promise.all([
    all(db,
      `SELECT stage, COUNT(*) AS n, COALESCE(SUM(estimated_value_usd), 0) AS total_value
         FROM opportunities
        WHERE stage NOT IN ('closed_won', 'closed_lost', 'closed_abandoned')
        GROUP BY stage`),
    all(db,
      `SELECT transaction_type, COUNT(*) AS n, COALESCE(SUM(estimated_value_usd), 0) AS total_value
         FROM opportunities
        WHERE stage NOT IN ('closed_won', 'closed_lost', 'closed_abandoned')
        GROUP BY transaction_type ORDER BY total_value DESC`),
    all(db,
      `SELECT COALESCE(u.display_name, u.email, 'Unassigned') AS owner_name,
              COUNT(*) AS n, COALESCE(SUM(o.estimated_value_usd), 0) AS total_value
         FROM opportunities o
         LEFT JOIN users u ON u.id = o.owner_user_id
        WHERE o.stage NOT IN ('closed_won', 'closed_lost', 'closed_abandoned')
        GROUP BY o.owner_user_id ORDER BY total_value DESC`),
    all(db,
      `SELECT a.id, a.name, a.alias,
              COUNT(o.id) AS opp_count,
              COALESCE(SUM(o.estimated_value_usd), 0) AS pipeline
         FROM opportunities o
         JOIN accounts a ON a.id = o.account_id
        WHERE o.stage NOT IN ('closed_won', 'closed_lost', 'closed_abandoned')
        GROUP BY a.id ORDER BY pipeline DESC LIMIT 10`),
    all(db,
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
    all(db,
      `SELECT strftime('%Y-%m', COALESCE(actual_close_date, updated_at)) AS month,
              COALESCE(SUM(estimated_value_usd), 0) AS value,
              COUNT(*) AS n
         FROM opportunities
        WHERE stage = 'closed_won'
          AND COALESCE(actual_close_date, updated_at) >= date('now', 'start of month', '-12 months')
        GROUP BY month ORDER BY month`),
    all(db,
      `SELECT COALESCE(a.segment, 'Other') AS segment,
              SUM(CASE WHEN o.stage = 'closed_won' THEN 1 ELSE 0 END) AS won,
              SUM(CASE WHEN o.stage = 'closed_lost' THEN 1 ELSE 0 END) AS lost,
              SUM(CASE WHEN o.stage = 'closed_abandoned' THEN 1 ELSE 0 END) AS abandoned
         FROM opportunities o
         LEFT JOIN accounts a ON a.id = o.account_id
        WHERE o.stage IN ('closed_won', 'closed_lost', 'closed_abandoned')
        GROUP BY segment ORDER BY segment`),
    all(db,
      `SELECT q.id, q.total_price,
              CAST(julianday('now') - julianday(q.submitted_at) AS INTEGER) AS days_old
         FROM quotes q
        WHERE q.status IN ('submitted', 'approved_internal', 'internal_review')
          AND q.submitted_at IS NOT NULL`),
    all(db,
      `SELECT stage,
              AVG(julianday('now') - julianday(stage_entered_at)) AS avg_days,
              COUNT(*) AS n
         FROM opportunities
        WHERE stage NOT IN ('closed_won', 'closed_lost', 'closed_abandoned')
        GROUP BY stage`),
    all(db,
      `SELECT date(COALESCE(completed_at, created_at)) AS day, COUNT(*) AS n
         FROM activities
        WHERE type IN ('task', 'call', 'meeting', 'email', 'note')
          AND COALESCE(completed_at, created_at) >= date('now', '-84 days')
        GROUP BY day ORDER BY day`),
  ]);

  pipelineByStageRows.sort((a, b) =>
    (stageSortOrder.get(a.stage) ?? 999) - (stageSortOrder.get(b.stage) ?? 999));
  stageAgingRows.sort((a, b) =>
    (stageSortOrder.get(a.stage) ?? 999) - (stageSortOrder.get(b.stage) ?? 999));

  const totalPipeline = pipelineByStageRows.reduce((a, s) => a + Number(s.total_value), 0);
  const totalOppCount = pipelineByStageRows.reduce((a, s) => a + s.n, 0);

  // ── Build per-chart JSON payloads ───────────────────────────
  const stage = {
    labels: pipelineByStageRows.map(s => stageLabels.get(s.stage) ?? s.stage),
    values: pipelineByStageRows.map(s => Number(s.total_value)),
    counts: pipelineByStageRows.map(s => s.n),
  };

  const type = {
    labels: pipelineByTypeRows.map(s => multiTypeLabel(s.transaction_type)),
    values: pipelineByTypeRows.map(s => Number(s.total_value)),
  };

  const owner = {
    labels: pipelineByOwnerRows.map(s => s.owner_name),
    values: pipelineByOwnerRows.map(s => Number(s.total_value)),
  };

  const topAccounts = {
    labels: topAccountsRows.map(a => a.alias ? `${a.name} (${a.alias})` : a.name),
    values: topAccountsRows.map(a => Number(a.pipeline)),
    counts: topAccountsRows.map(a => a.opp_count),
  };

  // Forecast — pad missing months.
  const today = new Date();
  const forecastMonths = [];
  for (let i = 0; i < 6; i++) {
    const d = new Date(today.getFullYear(), today.getMonth() + i, 1);
    forecastMonths.push(d.toISOString().slice(0, 7));
  }
  const forecastMap = new Map(weightedForecastRows.map(r => [r.month, r]));
  const forecast = {
    labels: forecastMonths.map(m => {
      const [y, mm] = m.split('-');
      return `${MONTH_SHORT[parseInt(mm, 10) - 1]} ${y.slice(2)}`;
    }),
    committed: forecastMonths.map(m => Number(forecastMap.get(m)?.committed ?? 0)),
    weighted:  forecastMonths.map(m => Number(forecastMap.get(m)?.weighted ?? 0)),
  };

  // Bookings trend — pad 12 months.
  const bookingMonths = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    bookingMonths.push(d.toISOString().slice(0, 7));
  }
  const bookingsMap = new Map(bookingsTrendRows.map(r => [r.month, r]));
  const bookings = {
    labels: bookingMonths.map(m => {
      const [y, mm] = m.split('-');
      return `${MONTH_SHORT[parseInt(mm, 10) - 1]} ${y.slice(2)}`;
    }),
    values: bookingMonths.map(m => Number(bookingsMap.get(m)?.value ?? 0)),
    counts: bookingMonths.map(m => Number(bookingsMap.get(m)?.n ?? 0)),
  };

  const segment = {
    labels: winRateBySegmentRows.map(s => s.segment),
    won:  winRateBySegmentRows.map(s => Number(s.won ?? 0)),
    lost: winRateBySegmentRows.map(s => Number(s.lost ?? 0)),
    abandoned: winRateBySegmentRows.map(s => Number(s.abandoned ?? 0)),
  };

  const buckets = [
    { label: '0–7 d',  max: 7,        n: 0, value: 0 },
    { label: '8–14 d', max: 14,       n: 0, value: 0 },
    { label: '15–30 d', max: 30,      n: 0, value: 0 },
    { label: '31–60 d', max: 60,      n: 0, value: 0 },
    { label: '61–90 d', max: 90,      n: 0, value: 0 },
    { label: '90+ d',  max: Infinity, n: 0, value: 0 },
  ];
  for (const q of quoteAgingRows) {
    const d = Number(q.days_old ?? 0);
    for (const b of buckets) {
      if (d <= b.max) { b.n += 1; b.value += Number(q.total_price ?? 0); break; }
    }
  }
  const aging = {
    labels: buckets.map(b => b.label),
    counts: buckets.map(b => b.n),
    values: buckets.map(b => b.value),
  };

  const bottleneck = {
    labels: stageAgingRows.map(s => stageLabels.get(s.stage) ?? s.stage),
    days:   stageAgingRows.map(s => Math.round(Number(s.avg_days ?? 0) * 10) / 10),
    counts: stageAgingRows.map(s => Number(s.n ?? 0)),
  };

  // Heatmap — build a 7-row × 12-column grid anchored to the current week.
  const heatmapMap = new Map(activityHeatmapRows.map(r => [r.day, Number(r.n)]));
  const weeksBack = 12;
  const endOfThisWeek = new Date(today);
  endOfThisWeek.setDate(today.getDate() + (6 - today.getDay()));
  const gridStart = new Date(endOfThisWeek);
  gridStart.setDate(gridStart.getDate() - (weeksBack * 7 - 1));
  const cells = [];
  for (let dayRow = 0; dayRow < 7; dayRow++) {
    const row = [];
    for (let w = 0; w < weeksBack; w++) {
      const d = new Date(gridStart);
      d.setDate(d.getDate() + (w * 7) + dayRow);
      const key = d.toISOString().slice(0, 10);
      row.push({ date: key, count: heatmapMap.get(key) ?? 0, isFuture: d > today });
    }
    cells.push(row);
  }
  const heatmapTotal = cells.flat().reduce((a, c) => a + c.count, 0);
  const maxCount = Math.max(1, ...cells.flat().map(c => c.count));
  const heatmap = { cells, weeksBack, total: heatmapTotal, maxCount };

  const charts = { stage, type, owner, topAccounts, segment, aging, bookings, forecast, bottleneck, heatmap };

  // Pre-serialize each payload so the caller can drop straight into
  // a template via raw(). Heatmap is rendered via CSS grid, not a
  // Chart.js canvas, so it doesn't need a JSON blob on the client —
  // but we include it for symmetry.
  const chartsJson = {};
  for (const [k, v] of Object.entries(charts)) chartsJson[k] = JSON.stringify(v);

  return {
    stageLabels,
    totals: { pipeline: totalPipeline, opps: totalOppCount },
    charts,
    chartsJson,
  };
}

/**
 * Heatmap color ramp — 6 buckets from "zero" to "busiest day".
 * Exposed for callers that want to render cells themselves.
 */
export function heatColor(count, maxCount, isFuture) {
  if (isFuture) return 'transparent';
  if (count === 0) return '#eef4f9';
  const t = count / Math.max(1, maxCount);
  if (t <= 0.2) return '#b8d4ee';
  if (t <= 0.4) return '#7ab3e0';
  if (t <= 0.6) return '#3b8acb';
  if (t <= 0.8) return '#1968b3';
  return '#0969da';
}

/**
 * Render the activity heatmap as a tagged-template HTML chunk.
 *
 * The grid is 13 columns (1 label + 12 weeks) × 8 rows (1 header +
 * 7 days). Cells get an inline background color from heatColor()
 * and a title tooltip with date + count.
 *
 * `includeLegend` — show the "Less … More" gradient underneath.
 */
export function renderHeatmapGrid(heatmap, { includeLegend = true } = {}) {
  const { cells, weeksBack, total, maxCount } = heatmap;
  return html`
    <div style="overflow-x:auto;padding:0.5rem 0">
      <div style="display:grid;grid-template-columns:2.5rem repeat(${weeksBack}, minmax(28px, 1fr));gap:3px;max-width:760px;font-size:0.7rem">
        <div></div>
        ${Array.from({ length: weeksBack }, (_, w) =>
          html`<div style="text-align:center;color:var(--fg-muted)">${w === weeksBack - 1 ? 'now' : (w === 0 ? '12w' : '')}</div>`)}
        ${cells.map((row, dayIdx) => html`
          <div style="color:var(--fg-muted);padding-right:0.4rem;text-align:right;align-self:center">${DAY_LABELS[dayIdx]}</div>
          ${row.map(cell => html`<div title="${escape(cell.date)}: ${cell.count} ${cell.count === 1 ? 'activity' : 'activities'}" style="aspect-ratio:1;background:${heatColor(cell.count, maxCount, cell.isFuture)};border-radius:3px;border:${cell.isFuture ? '1px dashed var(--border)' : 'none'}"></div>`)}
        `)}
      </div>
    </div>
    ${includeLegend ? html`
      <div style="margin-top:0.75rem;font-size:0.7rem;color:var(--fg-muted);display:flex;gap:0.4rem;align-items:center;flex-wrap:wrap">
        <span>${total} activities · last 84 days</span>
        <span style="margin-left:auto">Less</span>
        <div style="width:12px;height:12px;background:#eef4f9;border-radius:2px"></div>
        <div style="width:12px;height:12px;background:#b8d4ee;border-radius:2px"></div>
        <div style="width:12px;height:12px;background:#7ab3e0;border-radius:2px"></div>
        <div style="width:12px;height:12px;background:#3b8acb;border-radius:2px"></div>
        <div style="width:12px;height:12px;background:#1968b3;border-radius:2px"></div>
        <div style="width:12px;height:12px;background:#0969da;border-radius:2px"></div>
        <span>More</span>
      </div>
    ` : ''}
  `;
}

/**
 * Shared Chart.js init script for the 10 portfolio charts.
 *
 * Both the reports page and the dashboard carousel need the same
 * drawing logic. Call this with a prefix (so canvas IDs don't
 * collide when multiple instances are on the same page in the
 * future) and the chartsJson bundle. Returns a script body string
 * (no <script> wrapper) that the caller drops into its page.
 *
 * Each chart's init block checks `document.getElementById(prefix + key)`
 * — if that canvas doesn't exist on the page, the block is a no-op.
 */
export function buildChartInitScript(prefix, chartsJson) {
  return `
    (function() {
      if (typeof Chart === 'undefined') return;
      var palette = [
        'rgba(9,105,218,0.75)','rgba(26,127,55,0.75)','rgba(191,135,0,0.75)',
        'rgba(207,34,46,0.75)','rgba(130,80,223,0.75)','rgba(17,138,178,0.75)',
        'rgba(219,112,60,0.75)','rgba(100,116,139,0.75)','rgba(234,88,12,0.75)',
        'rgba(5,150,105,0.75)','rgba(217,70,239,0.75)','rgba(14,116,144,0.75)'
      ];
      Chart.defaults.font.family = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif";
      Chart.defaults.font.size = 12;
      Chart.defaults.maintainAspectRatio = false;
      function fmt$(v) {
        if (v >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
        if (v >= 1e3) return '$' + Math.round(v / 1e3) + 'k';
        return '$' + Math.round(v);
      }
      function el(id) { return document.getElementById(${JSON.stringify(prefix)} + id); }

      var stage = ${chartsJson.stage};
      if (stage.labels.length && el('stage')) {
        new Chart(el('stage'), {
          type: 'bar',
          data: { labels: stage.labels, datasets: [{ label: 'Pipeline ($)', data: stage.values, backgroundColor: palette, borderRadius: 4 }] },
          options: {
            responsive: true, maintainAspectRatio: false, indexAxis: 'y',
            plugins: {
              legend: { display: false },
              tooltip: { callbacks: { label: function(ctx) { return fmt$(ctx.parsed.x) + ' · ' + stage.counts[ctx.dataIndex] + ' opps'; } } }
            },
            scales: { x: { ticks: { callback: function(v) { return fmt$(v); } } } }
          }
        });
      }

      var type = ${chartsJson.type};
      if (type.labels.length && el('type')) {
        new Chart(el('type'), {
          type: 'doughnut',
          data: { labels: type.labels, datasets: [{ data: type.values, backgroundColor: palette }] },
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
              legend: { position: 'bottom' },
              tooltip: { callbacks: { label: function(ctx) { return ctx.label + ': ' + fmt$(ctx.parsed); } } }
            }
          }
        });
      }

      var owner = ${chartsJson.owner};
      if (owner.labels.length && el('owner')) {
        new Chart(el('owner'), {
          type: 'bar',
          data: { labels: owner.labels, datasets: [{ label: 'Pipeline ($)', data: owner.values, backgroundColor: palette, borderRadius: 4 }] },
          options: {
            responsive: true, maintainAspectRatio: false, indexAxis: 'y',
            plugins: { legend: { display: false } },
            scales: { x: { ticks: { callback: function(v) { return fmt$(v); } } } }
          }
        });
      }

      var topacct = ${chartsJson.topAccounts};
      if (topacct.labels.length && el('topAccounts')) {
        new Chart(el('topAccounts'), {
          type: 'bar',
          data: { labels: topacct.labels, datasets: [{ label: 'Pipeline ($)', data: topacct.values, backgroundColor: 'rgba(9,105,218,0.75)', borderRadius: 4 }] },
          options: {
            responsive: true, maintainAspectRatio: false, indexAxis: 'y',
            plugins: {
              legend: { display: false },
              tooltip: { callbacks: { label: function(ctx) { return fmt$(ctx.parsed.x) + ' · ' + topacct.counts[ctx.dataIndex] + ' opps'; } } }
            },
            scales: { x: { ticks: { callback: function(v) { return fmt$(v); } } } }
          }
        });
      }

      var seg = ${chartsJson.segment};
      if (seg.labels.length && el('segment')) {
        new Chart(el('segment'), {
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
            responsive: true, maintainAspectRatio: false, indexAxis: 'y',
            plugins: { legend: { position: 'bottom' } },
            scales: { x: { stacked: true, beginAtZero: true, ticks: { precision: 0 } }, y: { stacked: true } }
          }
        });
      }

      var aging = ${chartsJson.aging};
      if (aging.labels.length && el('aging')) {
        new Chart(el('aging'), {
          type: 'bar',
          data: {
            labels: aging.labels,
            datasets: [{
              label: 'Quotes',
              data: aging.counts,
              backgroundColor: ['rgba(26,127,55,0.75)','rgba(26,127,55,0.55)','rgba(191,135,0,0.75)','rgba(219,112,60,0.75)','rgba(207,34,46,0.70)','rgba(207,34,46,0.95)'],
              borderRadius: 4
            }]
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
              legend: { display: false },
              tooltip: {
                callbacks: {
                  label: function(ctx) {
                    var n = ctx.parsed.y; var v = aging.values[ctx.dataIndex];
                    return n + ' quote' + (n === 1 ? '' : 's') + ' · ' + fmt$(v);
                  }
                }
              }
            },
            scales: { y: { beginAtZero: true, ticks: { precision: 0 } } }
          }
        });
      }

      var book = ${chartsJson.bookings};
      if (book.labels.length && el('bookings')) {
        new Chart(el('bookings'), {
          type: 'line',
          data: {
            labels: book.labels,
            datasets: [{
              label: 'Closed-won $',
              data: book.values,
              borderColor: 'rgba(26,127,55,1)',
              backgroundColor: 'rgba(26,127,55,0.15)',
              tension: 0.35, fill: true, pointRadius: 4, pointHoverRadius: 6,
              pointBackgroundColor: 'rgba(26,127,55,1)'
            }]
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
              legend: { display: false },
              tooltip: {
                callbacks: {
                  label: function(ctx) { return fmt$(ctx.parsed.y) + ' · ' + book.counts[ctx.dataIndex] + ' wins'; }
                }
              }
            },
            scales: { y: { beginAtZero: true, ticks: { callback: function(v) { return fmt$(v); } } } }
          }
        });
      }

      var fc = ${chartsJson.forecast};
      if (fc.labels.length && el('forecast')) {
        new Chart(el('forecast'), {
          type: 'bar',
          data: {
            labels: fc.labels,
            datasets: [
              { label: 'Committed (100%)', data: fc.committed, backgroundColor: 'rgba(100,116,139,0.55)', borderRadius: 4 },
              { label: 'Weighted forecast', data: fc.weighted,  backgroundColor: 'rgba(9,105,218,0.85)',  borderRadius: 4 }
            ]
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
              legend: { position: 'bottom' },
              tooltip: { callbacks: { label: function(ctx) { return ctx.dataset.label + ': ' + fmt$(ctx.parsed.y); } } }
            },
            scales: { y: { beginAtZero: true, ticks: { callback: function(v) { return fmt$(v); } } } }
          }
        });
      }

      var bn = ${chartsJson.bottleneck};
      if (bn.labels.length && el('bottleneck')) {
        new Chart(el('bottleneck'), {
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
              borderRadius: 4
            }]
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
              legend: { display: false },
              tooltip: {
                callbacks: {
                  label: function(ctx) { return ctx.parsed.y.toFixed(1) + ' days avg · ' + bn.counts[ctx.dataIndex] + ' opps'; }
                }
              }
            },
            scales: { y: { beginAtZero: true, title: { display: true, text: 'Average days' } } }
          }
        });
      }
    })();
  `;
}
