// functions/settings/claudia/toggle.js
//
// POST /settings/claudia/toggle — flip one claudia_permissions row.
//
// Form body:
//   action  — required. The catalog action key (e.g. 'create_contact').
//   enabled — required. '1' to enable, '0' to disable.
//
// Returns just the updated row's HTML so the parent page's HTMX swap
// (outerHTML on #claudia-perm-<action>) replaces only the row that
// moved.
//
// Wes-only — 404 for everyone else. Validates the action against the
// catalog so a forged POST can't insert arbitrary rows. Each toggle
// writes both the claudia_permissions row AND an audit_events entry
// (entity_type='claudia_permission'), so the change shows up in the
// standard Pipeline history surfaces.

import { one, run } from '../../lib/db.js';
import { now } from '../../lib/ids.js';
import { html, escape } from '../../lib/layout.js';
import { audit } from '../../lib/audit.js';
import { formBody } from '../../lib/http.js';
import {
  PERMISSION_GATED_ACTIONS,
  PERMISSION_GATED_ACTIONS_CATALOG,
} from '../../lib/claudia-permissions.js';

const SANDBOX_OWNER = 'wes.yoakum@c-lars.com';

export async function onRequestPost(context) {
  const { env, data, request } = context;
  const user = data?.user;

  if (!user || user.email !== SANDBOX_OWNER) {
    return new Response('Not found', { status: 404 });
  }

  const form = await formBody(request);
  const action = String(form.action || '').trim();
  const enabledRaw = String(form.enabled || '').trim();

  if (!PERMISSION_GATED_ACTIONS.has(action)) {
    return new Response(`Unknown action: ${action}`, { status: 400 });
  }
  if (enabledRaw !== '0' && enabledRaw !== '1') {
    return new Response(`Invalid enabled value: ${enabledRaw}`, { status: 400 });
  }
  const enabled = enabledRaw === '1' ? 1 : 0;

  const ts = now();

  // Look up the prior state for the audit row's "from → to" line.
  const prior = await one(
    env.DB,
    'SELECT enabled FROM claudia_permissions WHERE action = ?',
    [action]
  );
  const priorEnabled = prior ? prior.enabled === 1 : true;

  await run(
    env.DB,
    `UPDATE claudia_permissions
        SET enabled = ?,
            updated_at = ?,
            updated_by_user_id = ?
      WHERE action = ?`,
    [enabled, ts, user.id, action]
  );

  // Standard Pipeline audit row so the toggle shows up in /settings/history.
  // entity_id is the action key itself — there's no surrogate id for a
  // permission row, and the action key is stable.
  await audit(env.DB, {
    entityType: 'claudia_permission',
    entityId: action,
    eventType: enabled ? 'enabled' : 'disabled',
    user,
    summary: `Claudia: ${enabled ? 'enabled' : 'disabled'} ${action}`,
    changes: { enabled: { from: priorEnabled ? 1 : 0, to: enabled } },
  });

  // Re-render this one row so HTMX outerHTML-swaps it cleanly.
  const fresh = await one(
    env.DB,
    `SELECT cp.action, cp.enabled, cp.updated_at, cp.updated_by_user_id,
            u.display_name AS updated_by_name
       FROM claudia_permissions cp
       LEFT JOIN users u ON u.id = cp.updated_by_user_id
      WHERE cp.action = ?`,
    [action]
  );
  const catalogEntry = PERMISSION_GATED_ACTIONS_CATALOG.find((a) => a.action === action);

  const fragment = renderRow(catalogEntry, fresh);
  return new Response(String(fragment), {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

// Mirrors renderRow() in functions/settings/claudia/index.js. Kept
// in-file to avoid a third file just for shared markup; if a third
// surface ever needs it, lift to a shared module.
function renderRow(catalogEntry, dbRow) {
  const enabled = dbRow ? dbRow.enabled === 1 : true;
  const updatedAt = dbRow?.updated_at || '';
  const updatedBy = dbRow?.updated_by_name || '';
  const updatedLine = updatedAt
    ? html`<span class="muted" style="font-size:0.75rem">Updated ${escape(updatedAt.slice(0, 16).replace('T', ' '))}${updatedBy ? html` by ${escape(updatedBy)}` : ''}</span>`
    : '';
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
