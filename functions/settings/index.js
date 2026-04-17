// functions/settings/index.js
//
// GET /settings — landing grid for admin-only configuration pages.
//
// Currently hosts one entry (Auto-Task Rules). Keep this file thin —
// as we add more admin pages (filename templates, governing docs
// management, etc.) they become sibling cards in the grid below.

import { one } from '../lib/db.js';
import { layout, htmlResponse, html } from '../lib/layout.js';
import { readFlash } from '../lib/http.js';
import { hasRole } from '../lib/auth.js';

export async function onRequestGet(context) {
  const { env, data, request } = context;
  const user = data?.user;
  const url = new URL(request.url);

  if (!hasRole(user, 'admin')) {
    return htmlResponse(
      layout('Settings', `
        <section class="card">
          <h1>Settings</h1>
          <p>Admin role required to view this page.</p>
        </section>`,
        { user, env: data?.env, activeNav: '/settings' }),
      { status: 403 }
    );
  }

  const ruleCount = await one(
    env.DB,
    'SELECT COUNT(*) AS n FROM task_rules'
  );
  const activeCount = await one(
    env.DB,
    'SELECT COUNT(*) AS n FROM task_rules WHERE active = 1'
  );

  const body = html`
    <section class="card">
      <div class="card-header">
        <h1>Settings</h1>
      </div>
      <p class="muted">
        Admin-only configuration. Changes here affect every user.
      </p>

      <div class="library-grid">
        <a class="library-card" href="/settings/auto-tasks">
          <h2>Auto-Task Rules</h2>
          <p class="muted">Rules that automatically create tasks in response to events (quote issued, opportunity stage changed, PDF errors, ...).</p>
          <p class="library-count">
            <strong>${activeCount?.n ?? 0}</strong> active
            ${ruleCount?.n !== activeCount?.n
              ? html` / ${ruleCount?.n ?? 0} total`
              : ''}
          </p>
        </a>
      </div>
    </section>
  `;

  return htmlResponse(
    layout('Settings', body, {
      user,
      env: data?.env,
      activeNav: '/settings',
      flash: readFlash(url),
      breadcrumbs: [{ label: 'Settings' }],
    })
  );
}
