// functions/index.js
//
// GET /
// Dashboard with pipeline overview, hero chart carousel, KPI strip,
// my tasks, my pipeline, and recent quotes.
//
// The chart carousel is an auto-rotating showcase whose slides are
// defined by CHART_SLIDES in functions/lib/chart-data.js (the /reports
// page reuses the same data helper). Slides advance every 7 seconds and
// pause on hover; users can click prev/next arrows, dot indicators,
// or the pause toggle. All canvases/grids are always in the DOM
// (toggled via opacity+pointer-events, not display:none) so Chart.js
// can measure them correctly on first init. The slide markup below MUST
// match CHART_SLIDES one-for-one, in order.

import { all, one } from './lib/db.js';
import { layout, htmlResponse, html, escape, raw } from './lib/layout.js';
import { loadStageCatalog } from './lib/stages.js';
import { parseTransactionTypes } from './lib/validators.js';
import {
  gatherDashboardCharts,
  renderHeatmapGrid,
  buildChartInitScript,
  CHART_SLIDES,
} from './lib/chart-data.js';

const TYPE_LABELS = {
  spares: 'Spares',
  eps: 'New Product',
  refurb: 'Refurb',
  service: 'Service',
};
function multiTypeLabel(csv) {
  return parseTransactionTypes(csv).map(t => TYPE_LABELS[t] ?? t).join(', ') || csv;
}

export async function onRequestGet(context) {
  const { env, data } = context;
  const user = data?.user;

  // Shared 10-chart data bundle (same as /reports).
  const dashboard = await gatherDashboardCharts(env.DB);
  const { charts, chartsJson, totals } = dashboard;

  // My pipeline: open opportunities owned by the current user
  const myPipeline = user?.id
    ? await all(
        env.DB,
        `SELECT o.id, o.number, o.title, o.transaction_type, o.stage,
                o.estimated_value_usd, o.expected_close_date, o.updated_at,
                a.name AS account_name, a.id AS account_id
           FROM opportunities o
           LEFT JOIN accounts a ON a.id = o.account_id
          WHERE o.stage NOT IN ('completed', 'lost', 'closed_died')
            AND (o.owner_user_id = ? OR o.owner_user_id IS NULL)
          ORDER BY o.updated_at DESC
          LIMIT 20`,
        [user.id]
      )
    : [];

  // Win/loss stats (last 90 days) for the "win rate" KPI
  const winLoss = await all(
    env.DB,
    `SELECT stage, COUNT(*) AS n, COALESCE(SUM(estimated_value_usd), 0) AS total_value
       FROM opportunities
      WHERE stage IN ('completed', 'job_in_progress', 'lost', 'closed_died', 'quote_expired')
        AND updated_at >= datetime('now', '-90 days')
        AND deleted_at IS NULL
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
            -- Hide tasks until ~a week before due (overdue / no-due
            -- always show).
            AND (a.due_at IS NULL OR date(a.due_at) <= date('now', '+7 days'))
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

  // Stage label map — used by the my-pipeline table below.
  const catalog = await loadStageCatalog(env.DB);
  const stageLabels = new Map();
  for (const list of catalog.values()) {
    for (const s of list) if (!stageLabels.has(s.stage_key)) stageLabels.set(s.stage_key, s.label);
  }

  const [oppCount, quoteCount, bookings2026] = await Promise.all([
    one(env.DB, `SELECT COUNT(*) AS n FROM opportunities WHERE deleted_at IS NULL AND stage IN ('lead','rfq_received','quote_drafted','quote_submitted','quote_under_revision','revised_quote_submitted')`),
    one(env.DB, `SELECT COUNT(*) AS n FROM quotes WHERE deleted_at IS NULL AND status IN ('draft','issued','revision_draft','revision_issued')`),
    one(env.DB, `SELECT COALESCE(SUM(estimated_value_usd), 0) AS total FROM opportunities WHERE stage IN ('completed','job_in_progress') AND deleted_at IS NULL AND actual_close_date >= '2026-01-01'`),
  ]);

  const wonStages = new Set(['completed', 'job_in_progress']);
  const lostStages = new Set(['lost', 'closed_died', 'quote_expired']);
  let wonCount = 0, lostCount = 0;
  for (const w of winLoss) {
    if (wonStages.has(w.stage)) wonCount += w.n;
    else if (lostStages.has(w.stage)) lostCount += w.n;
  }
  const winRate = (wonCount + lostCount) > 0
    ? Math.round(wonCount / (wonCount + lostCount) * 100)
    : 0;

  // Slide metadata for the Alpine component — titles + captions the
  // carousel header will bind to. Embedded as raw JSON so Alpine can
  // reactively swap the header as current changes.
  const slidesJSON = JSON.stringify(CHART_SLIDES.map(s => ({
    key: s.key,
    title: s.title,
    caption: s.caption,
    kind: s.kind,
  })));

  // Drill-through URLs for KPI cards
  const kpiActiveStages = ['lead', 'rfq_received', 'quote_drafted', 'quote_submitted', 'quote_under_revision', 'revised_quote_submitted'];
  const kpiPipelineStages = [...kpiActiveStages, 'quote_expired'];
  const kpiWonStages = ['completed', 'job_in_progress'];
  const kpiTerminalStages = [...kpiWonStages, 'lost', 'closed_died', 'quote_expired'];
  function oppFilterUrl(keys) {
    return '/opportunities?f_stage_label=' + keys.map(k => stageLabels.get(k)).filter(Boolean).map(encodeURIComponent).join(',');
  }
  const kpiUrls = {
    pipeline: oppFilterUrl(kpiPipelineStages),
    activeOpps: oppFilterUrl(kpiActiveStages),
    activeQuotes: '/quotes?f_status_label=' + ['Draft', 'Issued', 'Revision Draft', 'Revision Issued'].map(encodeURIComponent).join(','),
    winRate: oppFilterUrl(kpiTerminalStages),
    bookingsYTD: oppFilterUrl(kpiWonStages),
  };

  // Which slide to show for each index (used to render the stage
  // container below). Order matches CHART_SLIDES.
  const body = html`
    <section class="card">
      <h1 class="page-title">Dashboard</h1>
    </section>

    <style>.metric-card-link{text-decoration:none;color:inherit;display:block}.metric-card-link:hover{box-shadow:0 0 0 2px var(--accent,#3b82f6);border-radius:var(--radius,6px)}
      .sc-toggle{display:inline-flex;border:1px solid var(--border,#d8d8d8);border-radius:4px;overflow:hidden;background:#fff}
      .sc-toggle button{background:transparent;border:0;padding:.1rem .55rem;cursor:pointer;font-size:.7rem;color:var(--muted,#666);line-height:1.4}
      .sc-toggle button + button{border-left:1px solid var(--border,#d8d8d8)}
      .sc-toggle button.sc-active{background:#eef2ff;color:#1d4ed8;font-weight:600}
      .car-chart-toggle{position:absolute;top:8px;right:8px;z-index:2}</style>
    <div class="dashboard-metrics">
      <a href="${kpiUrls.activeOpps}" class="metric-card metric-card-link">
        <span class="metric-value">${oppCount?.n ?? 0}</span>
        <span class="metric-label">Active opportunities</span>
      </a>
      <a href="${kpiUrls.pipeline}" class="metric-card metric-card-link">
        <span class="metric-value">$${formatMoney(totals.pipeline)}</span>
        <span class="metric-label">Pipeline value</span>
      </a>
      <a href="${kpiUrls.activeQuotes}" class="metric-card metric-card-link">
        <span class="metric-value">${quoteCount?.n ?? 0}</span>
        <span class="metric-label">Active quotes</span>
      </a>
      <a href="${kpiUrls.winRate}" class="metric-card metric-card-link">
        <span class="metric-value">${winRate}%</span>
        <span class="metric-label">Win rate (90d)</span>
      </a>
      <a href="${kpiUrls.bookingsYTD}" class="metric-card metric-card-link">
        <span class="metric-value">$${formatMoney(bookings2026?.total ?? 0)}</span>
        <span class="metric-label">Bookings YTD 2026</span>
      </a>
    </div>

    <!-- Hero chart carousel — auto-rotates through 10 portfolio charts -->
    <section class="card chart-carousel"
             x-data="chartCarousel"
             x-cloak
             @mouseenter="pause()"
             @mouseleave="resume()">
      <div class="carousel-header">
        <div>
          <h2 class="carousel-title" x-text="slides[current].title">Pipeline</h2>
        </div>
        <div class="carousel-controls">
          <button type="button" class="carousel-btn" @click="prev()" title="Previous" aria-label="Previous">&lsaquo;</button>
          <span class="carousel-indicator"><span x-text="current + 1"></span> / <span x-text="slides.length"></span></span>
          <button type="button" class="carousel-btn" @click="next()" title="Next" aria-label="Next">&rsaquo;</button>
          <button type="button" class="carousel-btn" @click="togglePause()"
                  :title="userPaused ? 'Resume auto-advance' : 'Pause auto-advance'"
                  x-text="userPaused ? '▶' : '⏸'"></button>
          <a class="carousel-btn" href="/reports" title="Open full reports" aria-label="Open full reports">⛶</a>
        </div>
      </div>
      <p class="carousel-caption" x-text="slides[current].caption"></p>

      <!-- Slide order MUST stay in lock-step with CHART_SLIDES in
           lib/chart-data.js — the Alpine `slides` array (titles, captions,
           dots, count) is driven by that constant, so a mismatch shows the
           wrong title over a chart and makes trailing slides unreachable. -->
      <div class="carousel-stage">
        <div class="carousel-slide" :class="{active: current === 0}"><canvas id="car-stage"></canvas></div>
        <div class="carousel-slide" :class="{active: current === 1}">
          <div class="sc-toggle car-chart-toggle" id="car-type-toggle">
            <button type="button" data-mode="value" class="sc-active">Revenue</button>
            <button type="button" data-mode="count">Count</button>
          </div>
          <canvas id="car-type"></canvas>
        </div>
        <div class="carousel-slide" :class="{active: current === 2}"><canvas id="car-owner"></canvas></div>
        <div class="carousel-slide" :class="{active: current === 3}"><canvas id="car-topAccounts"></canvas></div>
        <div class="carousel-slide" :class="{active: current === 4}"><canvas id="car-aging"></canvas></div>
        <div class="carousel-slide" :class="{active: current === 5}"><canvas id="car-sparesWinRate"></canvas></div>
        <div class="carousel-slide" :class="{active: current === 6}">
          <div class="carousel-heatmap-wrap">
            ${renderHeatmapGrid(charts.heatmap)}
          </div>
        </div>
      </div>

      <div class="carousel-dots">
        <template x-for="(slide, i) in slides" :key="slide.key">
          <button type="button"
                  class="carousel-dot"
                  :class="{active: current === i}"
                  @click="goto(i)"
                  :aria-label="'Go to slide ' + (i + 1) + ': ' + slide.title"></button>
        </template>
      </div>
      <div class="carousel-progress" :style="'width: ' + progressPct + '%'"></div>
    </section>

    ${myTasks.length > 0 ? html`
      <section class="card">
        <div class="card-header">
          <h2>My open tasks <span class="muted">(${myTasks.length})</span></h2>
          <div style="display:flex;gap:0.5rem;">
            <button class="btn btn-sm primary" type="button"
                    onclick="window.Pipeline && window.Pipeline.openTaskModal({})">+ Add task</button>
            <a class="btn btn-sm" href="/activities">All tasks</a>
          </div>
        </div>
        <style>.dash-tasks td,.dash-tasks th{vertical-align:middle}</style>
        <table class="data compact dash-tasks">
          <thead>
            <tr>
              <th style="width:2rem">\u2713</th>
              <th>Subject</th>
              <th>Opportunity</th>
              <th>Due</th>
              <th style="width:2rem"></th>
            </tr>
          </thead>
          <tbody>
            ${myTasks.map(t => {
              const isOverdue = t.due_at && t.due_at < new Date().toISOString().slice(0, 10);
              return html`
                <tr class="${isOverdue ? 'row-overdue' : ''}">
                  <td>
                    <form method="post" action="/activities/${escape(t.id)}/complete" style="display:inline">
                      <button type="submit" class="task-complete-toggle" title="Mark complete" aria-label="Mark complete"></button>
                    </form>
                  </td>
                  <td><a href="/activities/${escape(t.id)}"><strong>${escape(t.subject || '(no subject)')}</strong></a></td>
                  <td>${t.opp_id
                    ? html`<a href="/opportunities/${escape(t.opp_id)}"><code>${escape(t.opp_number ?? '')}</code></a>`
                    : html`<span class="muted">\u2014</span>`}
                  </td>
                  <td class="${isOverdue ? 'overdue-text' : ''}">${t.due_at ? escape(t.due_at.slice(0, 10)) : html`<span class="muted">\u2014</span>`}</td>
                  <td style="text-align:center">
                    <form method="post" action="/activities/${escape(t.id)}/delete" style="display:inline;margin:0" onsubmit="return confirm('Delete this task?')">
                      <input type="hidden" name="return_to" value="/">
                      <button type="submit" class="row-delete-btn" title="Delete task" aria-label="Delete task" style="display:inline-flex;align-items:center;justify-content:center">&times;</button>
                    </form>
                  </td>
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
                    <td>${escape(multiTypeLabel(o.transaction_type))}</td>
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
    // Register the carousel Alpine component early so x-data can find
    // it the moment Alpine boots. Using alpine:init so we don't race.
    document.addEventListener('alpine:init', function () {
      Alpine.data('chartCarousel', function () {
        return {
          slides: ${raw(slidesJSON)},
          current: 0,
          intervalMs: 7000,
          tickMs: 100,
          elapsed: 0,
          progressPct: 0,
          userPaused: false,
          hoverPaused: false,
          tickHandle: null,
          init: function () {
            var self = this;
            this.start();
            // Kick Chart.js re-layout whenever the active slide changes.
            // Hidden charts (opacity:0) don't need resize; the active one
            // might need it if the stage box size changed.
            this.$watch('current', function () {
              self.elapsed = 0;
              self.progressPct = 0;
            });
          },
          start: function () {
            this.stop();
            if (this.userPaused || this.hoverPaused) return;
            var self = this;
            this.tickHandle = setInterval(function () {
              self.elapsed += self.tickMs;
              self.progressPct = Math.min(100, (self.elapsed / self.intervalMs) * 100);
              if (self.elapsed >= self.intervalMs) {
                self.next();
                self.elapsed = 0;
                self.progressPct = 0;
              }
            }, this.tickMs);
          },
          stop: function () {
            if (this.tickHandle) { clearInterval(this.tickHandle); this.tickHandle = null; }
          },
          next: function () {
            this.current = (this.current + 1) % this.slides.length;
          },
          prev: function () {
            this.current = (this.current - 1 + this.slides.length) % this.slides.length;
          },
          goto: function (i) {
            this.current = i;
            this.elapsed = 0;
            this.progressPct = 0;
          },
          pause: function () {
            this.hoverPaused = true;
            this.stop();
          },
          resume: function () {
            this.hoverPaused = false;
            if (!this.userPaused) this.start();
          },
          togglePause: function () {
            this.userPaused = !this.userPaused;
            if (this.userPaused) this.stop();
            else this.start();
          },
        };
      });
    });

    // Chart.js init has to wait until Alpine has mounted the carousel
    // and removed x-cloak -- otherwise the stage container has 0 size
    // (display-none via x-cloak) and Chart.js measures 0 by 0. The
    // alpine-initialized event fires after every x-data component
    // has finished its init hook, which is exactly what we need.
    document.addEventListener('alpine:initialized', function () {
      // Double requestAnimationFrame so layout settles after Alpine strips
      // x-cloak before Chart.js measures the canvas parents. Without this
      // the first slide may still be reporting 0 height when init runs.
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          ${raw(buildChartInitScript('car-', chartsJson))}
        });
      });
    });
    </script>
  `;

  return htmlResponse(layout('Dashboard', body, { user, env: data?.env, charts: true }));
}

function formatMoney(n) {
  const num = Number(n ?? 0);
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + 'M';
  if (num >= 1_000) return Math.round(num / 1_000) + 'k';
  return Math.round(num).toLocaleString('en-US');
}
