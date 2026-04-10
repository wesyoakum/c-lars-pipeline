// functions/index.js
//
// GET /
// M1 checkpoint landing page: confirms Cloudflare Access + D1 + middleware
// wiring all work by greeting the authenticated user and reporting a
// handful of row counts from the seeded schema.
//
// Later milestones will replace this with a real dashboard
// (my pipeline, open tasks, recent activity).

import { all, one } from './lib/db.js';
import { layout, htmlResponse, html, escape } from './lib/layout.js';
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

  // My pipeline: open opportunities owned by the current user, plus
  // open opportunities with no owner (so nothing falls through a gap).
  // Excludes terminal stages.
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

  // Small pipeline summary by stage, for a glanceable "where's the work sitting" view.
  const stageSummary = await all(
    env.DB,
    `SELECT stage, COUNT(*) AS n, COALESCE(SUM(estimated_value_usd), 0) AS total_value
       FROM opportunities
      WHERE stage NOT IN ('closed_won', 'closed_lost', 'closed_abandoned')
      GROUP BY stage
      ORDER BY n DESC`
  );

  const catalog = await loadStageCatalog(env.DB);
  // A lookup: stage_key -> first matching label (all types share the shared-early keys).
  const stageLabels = new Map();
  for (const list of catalog.values()) {
    for (const s of list) if (!stageLabels.has(s.stage_key)) stageLabels.set(s.stage_key, s.label);
  }

  const [oppCount, acctCount] = await Promise.all([
    one(env.DB, 'SELECT COUNT(*) AS n FROM opportunities'),
    one(env.DB, 'SELECT COUNT(*) AS n FROM accounts'),
  ]);

  const body = html`
    <section class="card">
      <h1>Hello, ${escape(user?.display_name ?? user?.email ?? 'friend')}</h1>
      <p class="muted">
        Signed in as <code>${escape(user?.email)}</code> ·
        role <strong>${escape(user?.role)}</strong> ·
        <strong>${oppCount?.n ?? 0}</strong> opportunities ·
        <strong>${acctCount?.n ?? 0}</strong> accounts
      </p>
    </section>

    <section class="card">
      <div class="card-header">
        <h2>My pipeline</h2>
        <div class="header-actions">
          <a class="btn" href="/opportunities">All opportunities</a>
          <a class="btn primary" href="/opportunities/new">New opportunity</a>
        </div>
      </div>

      ${myPipeline.length === 0
        ? html`<p class="muted">
            No open opportunities yet. Start by
            <a href="/opportunities/new">creating one</a>.
          </p>`
        : html`
          <table class="data">
            <thead>
              <tr>
                <th>Number</th>
                <th>Title</th>
                <th>Account</th>
                <th>Type</th>
                <th>Stage</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              ${myPipeline.map(
                (o) => html`
                  <tr>
                    <td><code>${escape(o.number)}</code></td>
                    <td><a href="/opportunities/${escape(o.id)}"><strong>${escape(o.title)}</strong></a></td>
                    <td>${o.account_id
                      ? html`<a href="/accounts/${escape(o.account_id)}">${escape(o.account_name ?? '—')}</a>`
                      : html`<span class="muted">—</span>`}</td>
                    <td>${escape(TYPE_LABELS[o.transaction_type] ?? o.transaction_type)}</td>
                    <td>${escape(stageLabels.get(o.stage) ?? o.stage)}</td>
                    <td>${o.estimated_value_usd != null ? `$${formatMoney(o.estimated_value_usd)}` : ''}</td>
                  </tr>`
              )}
            </tbody>
          </table>`}
    </section>

    ${stageSummary.length > 0
      ? html`
        <section class="card">
          <h2>Pipeline by stage</h2>
          <table class="data">
            <thead>
              <tr>
                <th>Stage</th>
                <th>Count</th>
                <th>Total value</th>
              </tr>
            </thead>
            <tbody>
              ${stageSummary.map(
                (s) => html`
                  <tr>
                    <td>${escape(stageLabels.get(s.stage) ?? s.stage)}</td>
                    <td>${s.n}</td>
                    <td>$${formatMoney(s.total_value)}</td>
                  </tr>`
              )}
            </tbody>
          </table>
        </section>`
      : ''}
  `;

  // No activeNav on the dashboard — the home link in the brand is the
  // implicit "you're here" affordance, and we don't want navLink's
  // startsWith('/') match to light up every link in the top nav.
  return htmlResponse(layout('Dashboard', body, { user, env: data?.env }));
}

function formatMoney(n) {
  return Math.round(Number(n ?? 0)).toLocaleString('en-US');
}
