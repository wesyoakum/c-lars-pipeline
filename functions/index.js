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
import { layout, htmlResponse, html, raw } from './lib/layout.js';

export async function onRequestGet(context) {
  const { env, data } = context;
  const user = data?.user;

  // Quick schema health-check: count key seed tables so a visible number
  // on the page proves migrations applied cleanly.
  const [stageCount, govCount, userCount] = await Promise.all([
    one(env.DB, 'SELECT COUNT(*) AS n FROM stage_definitions'),
    one(env.DB, 'SELECT COUNT(*) AS n FROM governing_documents'),
    one(env.DB, 'SELECT COUNT(*) AS n FROM users'),
  ]);

  const governingDocs = await all(
    env.DB,
    `SELECT doc_key, revision, title, effective_date
       FROM governing_documents
      ORDER BY doc_key`
  );

  const body = html`
    <section class="card">
      <h1>Hello, ${user?.display_name ?? user?.email ?? 'friend'}</h1>
      <p class="muted">
        You are signed in as <code>${user?.email}</code> with role
        <strong>${user?.role}</strong>.
      </p>
      <p class="muted">
        This is the M1 landing page for C-LARS PMS — it proves that
        Cloudflare Access, the Pages Functions middleware, the D1 schema,
        and the seed data are all wired up correctly.
      </p>
    </section>

    <section class="card">
      <h2>Schema health</h2>
      <ul class="plain">
        <li><strong>${stageCount?.n ?? 0}</strong> stage definitions
          (4 transaction types × 13 stages = 52 expected)</li>
        <li><strong>${govCount?.n ?? 0}</strong> governing documents
          (4 expected at Rev A)</li>
        <li><strong>${userCount?.n ?? 0}</strong> users registered</li>
      </ul>
    </section>

    <section class="card">
      <h2>Controlled governing documents</h2>
      <table class="data">
        <thead>
          <tr>
            <th>Key</th>
            <th>Rev</th>
            <th>Title</th>
            <th>Effective</th>
          </tr>
        </thead>
        <tbody>
          ${raw(
            governingDocs
              .map(
                (d) => `<tr>
                  <td><code>${d.doc_key}</code></td>
                  <td>${d.revision}</td>
                  <td>${d.title}</td>
                  <td>${d.effective_date}</td>
                </tr>`
              )
              .join('')
          )}
        </tbody>
      </table>
    </section>

    <section class="card">
      <h2>Next up</h2>
      <p>M2 — Accounts &amp; Contacts CRUD. See the P0 plan in
      <code>.claude/plans/mutable-dreaming-liskov.md</code>.</p>
    </section>
  `;

  return htmlResponse(layout('Hello', body, { user, env: data?.env }));
}
