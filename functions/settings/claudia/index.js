// functions/settings/claudia/index.js
//
// GET /settings/claudia — Wes-only settings page for Claudia's per-tool
// permissions. Shows one toggle per row in claudia_permissions, grouped
// by category. Toggling a row POSTs to /settings/claudia/toggle and
// HTMX swaps just that row back in with its new state.
//
// Bootstraps any missing catalog rows on every GET so adding a new
// gated tool only requires editing claudia-permissions.js — no new
// migration needed.
//
// Disabled tools are filtered out of the toolset Claudia sees on her
// next chat turn (functions/sandbox/assistant/tools.js loads the same
// permission map and removes disabled action definitions before
// sending them to Claude). Defense in depth: the execute() switch in
// tools.js also rejects disabled actions if a stale schema slips
// through.

import { layout, htmlResponse, html, escape } from '../../lib/layout.js';
import { hasRole } from '../../lib/auth.js';
import { settingsSubNav } from '../../lib/settings-subnav.js';
import {
  PERMISSION_GATED_ACTIONS_CATALOG,
  PERMISSION_CATEGORIES,
  ensurePermissionRows,
} from '../../lib/claudia-permissions.js';

const SANDBOX_OWNER = 'wes.yoakum@c-lars.com';

export async function onRequestGet(context) {
  const { env, data } = context;
  const user = data?.user;

  // Wes-only — 404 for everyone else (matches the gate on the chat
  // and sandbox surfaces themselves).
  if (!user || user.email !== SANDBOX_OWNER) {
    return new Response('Not found', { status: 404 });
  }

  const isAdmin = hasRole(user, 'admin');
  const rowsByAction = await ensurePermissionRows(env);

  // Render rows grouped by category, in catalog order so the page
  // reads consistently as new tools land. Categories with no items
  // get filtered out (returns null → renderValue() drops it).
  const sections = PERMISSION_CATEGORIES.map((cat) => {
    const items = PERMISSION_GATED_ACTIONS_CATALOG.filter((a) => a.category === cat.key);
    if (items.length === 0) return null;
    return html`
      <section class="card" style="margin-top:1rem">
        <div class="card-header">
          <h2>${cat.label}</h2>
        </div>
        <p class="muted">${cat.blurb}</p>
        <div class="settings-prefs-list" id="claudia-perms-${cat.key}">
          ${items.map((item) => renderRow(item, rowsByAction[item.action]))}
        </div>
      </section>
    `;
  });

  const body = html`
    ${settingsSubNav('claudia', isAdmin, true)}

    <section class="card">
      <div class="card-header">
        <h1>Claudia &mdash; permissions</h1>
      </div>
      <p class="muted">
        Toggle individual write tools on or off. Disabled tools are
        invisible to Claudia &mdash; she can&rsquo;t propose using them
        because they&rsquo;re filtered out of her toolset before each
        turn. Read-only tools (search, list, read, calendar, memory,
        query_db) are always available and not listed here. Every
        toggle is recorded in the audit trail under
        <code>entity_type = 'claudia_permission'</code>.
      </p>
    </section>

    ${sections}
  `;

  return htmlResponse(
    layout('Claudia — permissions', body, { env: data?.env, activeNav: '/settings', user })
  );
}

/**
 * Render one permission row. Toggling the checkbox HTMX-posts to
 * /settings/claudia/toggle, which returns the updated row HTML — we
 * swap the whole row (outerHTML) so the visual state, the "updated
 * by" line, and the form's idempotent-toggle params all stay in sync.
 */
function renderRow(catalogEntry, dbRow) {
  const enabled = dbRow ? dbRow.enabled === 1 : true;
  const updatedAt = dbRow?.updated_at || '';
  const updatedBy = dbRow?.updated_by_name || '';
  const updatedLine = updatedAt
    ? html`<span class="muted" style="font-size:0.75rem">Updated ${escape(updatedAt.slice(0, 16).replace('T', ' '))}${updatedBy ? html` by ${escape(updatedBy)}` : ''}</span>`
    : '';
  // The new state we want to set when this is toggled is the OPPOSITE
  // of the current state — encode that into the form so the POST is
  // idempotent and a double-submit/refresh can't desync.
  const next = enabled ? '0' : '1';
  return html`
    <div class="settings-pref-row" id="claudia-perm-${escape(catalogEntry.action)}">
      <div class="settings-pref-label">
        <strong>${escape(catalogEntry.label)}</strong>
        <span class="muted">${escape(catalogEntry.description)}</span>
        ${updatedLine}
      </div>
      <form
        hx-post="/settings/claudia/toggle"
        hx-target="#claudia-perm-${escape(catalogEntry.action)}"
        hx-swap="outerHTML"
        style="margin:0">
        <input type="hidden" name="action" value="${escape(catalogEntry.action)}">
        <input type="hidden" name="enabled" value="${next}">
        <button
          type="submit"
          class="toggle-switch ${enabled ? 'toggle-switch--on' : ''}"
          aria-pressed="${enabled ? 'true' : 'false'}"
          aria-label="${enabled ? 'Disable' : 'Enable'} ${escape(catalogEntry.label)}"
          style="border:0;padding:0;background:transparent">
          <span class="toggle-slider"></span>
        </button>
      </form>
    </div>
  `;
}

