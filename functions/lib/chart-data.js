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
  eps: 'New Product',
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
  { key: 'aging',      title: 'Quote expiration',
    caption: 'Quotes by time to expiration — red = expired, yellow = expiring soon, green = healthy.',
    kind: 'chart' },
  { key: 'sparesWinRate', title: 'Spares win rate',
    caption: 'Won vs lost/expired/died across all spares opps that reached a terminal outcome.',
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
/**
 * @returns {{
 *   stageLabels: Map<string,string>,
 *   stageSortOrder: Map<string,number>,
 *   totals: object,
 *   charts: object,
 *   chartsJson: object,
 * }}
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
        WHERE stage IN ('lead', 'rfq_received', 'quote_drafted', 'quote_submitted', 'quote_under_revision', 'revised_quote_submitted', 'quote_expired')
          AND deleted_at IS NULL
        GROUP BY stage`),
    all(db,
      `SELECT transaction_type, COUNT(*) AS n, COALESCE(SUM(estimated_value_usd), 0) AS total_value
         FROM opportunities
        WHERE stage IN ('lead', 'rfq_received', 'quote_drafted', 'quote_submitted', 'quote_under_revision', 'revised_quote_submitted', 'quote_expired')
          AND deleted_at IS NULL
        GROUP BY transaction_type ORDER BY total_value DESC`),
    all(db,
      `SELECT COALESCE(u.display_name, u.email, 'Unassigned') AS owner_name,
              COUNT(*) AS n, COALESCE(SUM(o.estimated_value_usd), 0) AS total_value
         FROM opportunities o
         LEFT JOIN users u ON u.id = o.owner_user_id
        WHERE o.stage IN ('lead', 'rfq_received', 'quote_drafted', 'quote_submitted', 'quote_under_revision', 'revised_quote_submitted', 'quote_expired')
          AND o.deleted_at IS NULL
        GROUP BY o.owner_user_id ORDER BY total_value DESC`),
    all(db,
      `SELECT a.id, a.name, a.alias,
              COUNT(o.id) AS opp_count,
              COALESCE(SUM(o.estimated_value_usd), 0) AS pipeline
         FROM opportunities o
         JOIN accounts a ON a.id = o.account_id
        WHERE o.stage IN ('lead', 'rfq_received', 'quote_drafted', 'quote_submitted', 'quote_under_revision', 'revised_quote_submitted', 'quote_expired')
          AND o.deleted_at IS NULL
        GROUP BY a.id ORDER BY pipeline DESC LIMIT 10`),
    all(db,
      `SELECT strftime('%Y-%m', expected_close_date) AS month,
              COALESCE(SUM(estimated_value_usd), 0) AS committed,
              COALESCE(SUM(estimated_value_usd * COALESCE(probability, 0) / 100.0), 0) AS weighted,
              COUNT(*) AS n
         FROM opportunities
        WHERE stage IN ('lead', 'rfq_received', 'quote_drafted', 'quote_submitted', 'quote_under_revision', 'revised_quote_submitted', 'quote_expired')
          AND deleted_at IS NULL
          AND expected_close_date IS NOT NULL
          AND expected_close_date >= date('now', 'start of month')
          AND expected_close_date < date('now', 'start of month', '+6 months')
        GROUP BY month ORDER BY month`),
    all(db,
      `SELECT strftime('%Y-%m', COALESCE(actual_close_date, updated_at)) AS month,
              COALESCE(SUM(estimated_value_usd), 0) AS value,
              COUNT(*) AS n
         FROM opportunities
        WHERE stage = 'completed'
          AND deleted_at IS NULL
          AND COALESCE(actual_close_date, updated_at) >= date('now', 'start of month', '-12 months')
        GROUP BY month ORDER BY month`),
    all(db,
      `SELECT COALESCE(a.segment, 'Other') AS segment,
              SUM(CASE WHEN o.stage = 'completed' THEN 1 ELSE 0 END) AS won,
              SUM(CASE WHEN o.stage = 'lost' THEN 1 ELSE 0 END) AS lost,
              SUM(CASE WHEN o.stage = 'closed_died' THEN 1 ELSE 0 END) AS abandoned
         FROM opportunities o
         LEFT JOIN accounts a ON a.id = o.account_id
        WHERE o.stage IN ('completed', 'lost', 'closed_died')
          AND o.deleted_at IS NULL
        GROUP BY segment ORDER BY segment`),
    all(db,
      `SELECT q.id, q.total_price, q.valid_until,
              CAST(julianday(q.valid_until) - julianday('now') AS INTEGER) AS days_until
         FROM quotes q
        WHERE q.status IN ('draft', 'issued', 'revision_draft', 'revision_issued', 'expired')
          AND q.valid_until IS NOT NULL
          AND q.deleted_at IS NULL`),
    all(db,
      `SELECT stage,
              AVG(julianday('now') - julianday(stage_entered_at)) AS avg_days,
              COUNT(*) AS n
         FROM opportunities
        WHERE stage IN ('lead', 'rfq_received', 'quote_drafted', 'quote_submitted', 'quote_under_revision', 'revised_quote_submitted', 'quote_expired')
          AND deleted_at IS NULL
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
    names: topAccountsRows.map(a => a.name),
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

  // Expiration buckets: negative = already expired, positive = expiring soon.
  // Ordered from most expired → expiring soonest → furthest out.
  const agingBuckets = [
    { label: 'Expired 4+ wks', min: -Infinity, max: -28, n: 0, value: 0, color: '#991b1b' },
    { label: 'Expired 3 wks',  min: -28,       max: -21, n: 0, value: 0, color: '#b91c1c' },
    { label: 'Expired 2 wks',  min: -21,       max: -14, n: 0, value: 0, color: '#dc2626' },
    { label: 'Expired 1 wk',   min: -14,       max: -7,  n: 0, value: 0, color: '#ef4444' },
    { label: 'Expired < 1 wk', min: -7,        max: 0,   n: 0, value: 0, color: '#f87171' },
    { label: 'Within 1 wk',    min: 0,         max: 7,   n: 0, value: 0, color: '#f59e0b' },
    { label: 'Within 2 wks',   min: 7,         max: 14,  n: 0, value: 0, color: '#eab308' },
    { label: 'Within 3 wks',   min: 14,        max: 21,  n: 0, value: 0, color: '#84cc16' },
    { label: '3+ wks out',     min: 21,        max: Infinity, n: 0, value: 0, color: '#10b981' },
  ];
  for (const q of quoteAgingRows) {
    const d = Number(q.days_until ?? 0);
    for (const b of agingBuckets) {
      if (d > b.min && d <= b.max) { b.n += 1; b.value += Number(q.total_price ?? 0); break; }
    }
  }
  const aging = {
    labels: agingBuckets.map(b => b.label),
    counts: agingBuckets.map(b => b.n),
    values: agingBuckets.map(b => b.value),
    colors: agingBuckets.map(b => b.color),
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

  // Spares win rate — out of all spares opps that reached a terminal
  // outcome (quote_expired, job_in_progress, completed, lost, closed_died).
  // Won = completed + job_in_progress. Lost = the rest.
  const sparesWinRows = await all(db,
    `SELECT stage, COUNT(*) AS n
       FROM opportunities
      WHERE transaction_type LIKE '%spares%'
        AND stage IN ('quote_expired', 'job_in_progress', 'completed', 'lost', 'closed_died')
        AND deleted_at IS NULL
      GROUP BY stage`);
  const sparesWonStages = new Set(['completed', 'job_in_progress']);
  let sparesWon = 0, sparesExpired = 0, sparesLost = 0, sparesDied = 0;
  for (const r of sparesWinRows) {
    if (sparesWonStages.has(r.stage)) sparesWon += r.n;
    else if (r.stage === 'quote_expired') sparesExpired += r.n;
    else if (r.stage === 'lost') sparesLost += r.n;
    else if (r.stage === 'closed_died') sparesDied += r.n;
  }
  const sparesTotal = sparesWon + sparesExpired + sparesLost + sparesDied;
  const sparesWinPct = sparesTotal > 0 ? Math.round((sparesWon / sparesTotal) * 100) : 0;
  const sparesWinRate = {
    labels: ['Won', 'Expired', 'Lost', 'Died'],
    values: [sparesWon, sparesExpired, sparesLost, sparesDied],
    colors: ['#10b981', '#991b1b', '#ef4444', '#dc2626'],
    pct: sparesWinPct,
    total: sparesTotal,
    stageLabelMap: {
      Won: [stageLabels.get('completed'), stageLabels.get('job_in_progress')].filter(Boolean),
      Expired: [stageLabels.get('quote_expired')].filter(Boolean),
      Lost: [stageLabels.get('lost')].filter(Boolean),
      Died: [stageLabels.get('closed_died')].filter(Boolean),
    },
  };

  const charts = { stage, type, owner, topAccounts, segment, aging, bookings, forecast, bottleneck, heatmap, sparesWinRate };

  // Pre-serialize each payload so the caller can drop straight into
  // a template via raw(). Heatmap is rendered via CSS grid, not a
  // Chart.js canvas, so it doesn't need a JSON blob on the client —
  // but we include it for symmetry.
  const chartsJson = {};
  for (const [k, v] of Object.entries(charts)) chartsJson[k] = JSON.stringify(v);

  return {
    stageLabels,
    stageSortOrder,
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
  const prefixJson = JSON.stringify(prefix);
  return `
    (function() {
      var PREFIX = ${prefixJson};
      var LOG = '[' + PREFIX.replace(/-$/, '') + '-charts]';
      if (typeof Chart === 'undefined') {
        console.error(LOG, 'Chart.js not loaded — aborting init');
        return;
      }
      console.log(LOG, 'init starting, Chart.js version:', Chart.version);

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
      function el(id) { return document.getElementById(PREFIX + id); }

      // Per-chart creation wrapper: logs result, wraps errors, reports
      // parent dimensions (Chart.js measures parentNode). If the parent
      // has 0 width or 0 height, the chart renders as 0x0 (invisible),
      // which is the most common "silent failure" mode.
      var created = 0, skipped = 0, failed = 0;
      function make(key, factory) {
        var canvas = el(key);
        if (!canvas) { skipped++; return; }
        var parent = canvas.parentNode;
        var pw = parent ? parent.clientWidth : 0;
        var ph = parent ? parent.clientHeight : 0;
        if (pw === 0 || ph === 0) {
          console.warn(LOG, key, 'parent has 0 size:', pw + 'x' + ph, '— chart will not render');
        }
        try {
          factory(canvas);
          created++;
          console.log(LOG, key, 'OK, parent', pw + 'x' + ph);
        } catch (err) {
          failed++;
          console.error(LOG, key, 'FAILED:', err && err.message, err);
        }
      }

      var stage = ${chartsJson.stage};
      if (stage.labels.length) make('stage', function(canvas) {
        new Chart(canvas, {
          type: 'bar',
          data: { labels: stage.labels, datasets: [{ label: 'Pipeline ($)', data: stage.values, backgroundColor: palette, borderRadius: 4 }] },
          options: {
            responsive: true, maintainAspectRatio: false, indexAxis: 'y',
            plugins: {
              legend: { display: false },
              tooltip: { callbacks: { label: function(ctx) { return fmt$(ctx.parsed.x) + ' · ' + stage.counts[ctx.dataIndex] + ' opps'; } } }
            },
            // Data is sorted earliest -> latest stage. Chart.js v3 horizontal-
            // bar default puts the first label at the BOTTOM; reverse to
            // match the dropdown menus + the chart's own caption
            // ("earliest stages on top").
            scales: {
              x: { ticks: { callback: function(v) { return fmt$(v); } } },
              y: { reverse: false }
            }
          }
        });
      });

      var type = ${chartsJson.type};
      if (type.labels.length) make('type', function(canvas) {
        new Chart(canvas, {
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
      });

      var owner = ${chartsJson.owner};
      if (owner.labels.length) make('owner', function(canvas) {
        new Chart(canvas, {
          type: 'bar',
          data: { labels: owner.labels, datasets: [{ label: 'Pipeline ($)', data: owner.values, backgroundColor: palette, borderRadius: 4 }] },
          options: {
            responsive: true, maintainAspectRatio: false, indexAxis: 'y',
            plugins: { legend: { display: false } },
            scales: { x: { ticks: { callback: function(v) { return fmt$(v); } } } }
          }
        });
      });

      var topacct = ${chartsJson.topAccounts};
      if (topacct.labels.length) make('topAccounts', function(canvas) {
        new Chart(canvas, {
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
      });

      var fc = ${chartsJson.forecast};
      if (fc.labels.length) make('forecast', function(canvas) {
        new Chart(canvas, {
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
      });

      var bn = ${chartsJson.bottleneck};
      if (bn.labels.length) make('bottleneck', function(canvas) {
        new Chart(canvas, {
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
      });

      var ag = ${chartsJson.aging};
      if (ag.labels.length) make('aging', function(canvas) {
        new Chart(canvas, {
          type: 'bar',
          data: {
            labels: ag.labels,
            datasets: [{
              label: 'Quotes',
              data: ag.counts,
              backgroundColor: ag.colors,
              borderRadius: 4
            }]
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
              legend: { display: false },
              tooltip: {
                callbacks: {
                  label: function(ctx) { return ctx.parsed.y + ' quotes · ' + fmt$(ag.values[ctx.dataIndex]); }
                }
              }
            },
            scales: {
              y: { beginAtZero: true, ticks: { stepSize: 1 } }
            }
          }
        });
      });

      var swr = ${chartsJson.sparesWinRate};
      if (swr.total > 0) make('sparesWinRate', function(canvas) {
        new Chart(canvas, {
          type: 'pie',
          data: {
            labels: swr.labels,
            datasets: [{
              data: swr.values,
              backgroundColor: swr.colors
            }]
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
              legend: { position: 'bottom' },
              title: {
                display: true,
                text: swr.pct + '% win rate (' + swr.total + ' resolved spares opps)',
                font: { size: 16, weight: '600' }
              },
              tooltip: {
                callbacks: {
                  label: function(ctx) {
                    var total = swr.values.reduce(function(a,b){return a+b},0);
                    var pct = total > 0 ? Math.round(ctx.parsed / total * 100) : 0;
                    return ctx.label + ': ' + ctx.parsed + ' (' + pct + '%)';
                  }
                }
              }
            }
          }
        });
      });

      // -- Drill-through: click a bar/slice → filtered list page ----------
      function drillTo(base, filters) {
        var p = [];
        for (var k in filters) {
          if (filters[k] == null) continue;
          var v = Array.isArray(filters[k]) ? filters[k].map(encodeURIComponent).join(',') : encodeURIComponent(filters[k]);
          p.push('f_' + k + '=' + v);
        }
        window.location.href = base + (p.length ? '?' + p.join('&') : '');
      }
      var drill = {
        stage: function(i) { return ['/opportunities', {stage_label: stage.labels[i]}]; },
        type: function(i) { return ['/opportunities', {type_label: type.labels[i]}]; },
        owner: function(i) { return ['/opportunities', {owner: owner.labels[i]}]; },
        topAccounts: function(i) { return ['/opportunities', {account_name: topacct.names ? topacct.names[i] : topacct.labels[i]}]; },
        bottleneck: function(i) { return ['/opportunities', {stage_label: bn.labels[i]}]; },
        aging: function(i) {
          var lbl = ag.labels[i];
          if (lbl.indexOf('Expired') === 0) return ['/quotes', {status_label: 'Expired'}];
          return ['/quotes', {status_label: ['Draft','Issued','Revision Draft','Revision Issued']}];
        },
        sparesWinRate: function(i) {
          var lbl = swr.labels[i];
          var stgs = swr.stageLabelMap && swr.stageLabelMap[lbl];
          return stgs && stgs.length ? ['/opportunities', {stage_label: stgs, type_label: 'Spares'}] : null;
        },
      };
      Object.keys(drill).forEach(function(key) {
        var canvas = el(key);
        if (!canvas) return;
        var chart = Chart.getChart(canvas);
        if (!chart) return;
        chart.options.onClick = function(e, elements) {
          if (!elements.length) return;
          var target = drill[key](elements[0].index);
          if (target) drillTo(target[0], target[1]);
        };
        chart.options.onHover = function(e, elements, ch) {
          ch.canvas.style.cursor = elements.length ? 'pointer' : 'default';
        };
      });

      console.log(LOG, 'done. created:', created, 'skipped:', skipped, 'failed:', failed);
    })();
  `;
}
