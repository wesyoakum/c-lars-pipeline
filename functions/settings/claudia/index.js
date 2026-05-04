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
import { claudiaAuditTabs } from '../../lib/claudia-audit-render.js';
import { getGmailConnectionStatus } from '../../lib/gmail-oauth.js';

const SANDBOX_OWNER = 'wes.yoakum@c-lars.com';

export async function onRequestGet(context) {
  const { env, data, request } = context;
  const user = data?.user;

  // Wes-only — 404 for everyone else (matches the gate on the chat
  // and sandbox surfaces themselves).
  if (!user || user.email !== SANDBOX_OWNER) {
    return new Response('Not found', { status: 404 });
  }

  const isAdmin = hasRole(user, 'admin');
  const rowsByAction = await ensurePermissionRows(env);
  const gmail = await getGmailConnectionStatus(env, user.id);
  const url = new URL(request.url);
  const gmailFlash = url.searchParams.get('gmail');

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
    ${claudiaAuditTabs('permissions')}

    ${gmailFlash ? renderGmailFlash(gmailFlash, url) : ''}

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

    ${renderGmailSection(gmail, env)}

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

/**
 * Render the Gmail connection card. Shows different states:
 *   - OAuth client not configured (server missing GMAIL_CLIENT_*)
 *   - Not connected (Connect button)
 *   - Connected (Account email + Disconnect button + last refresh)
 *   - Connected but last refresh errored (Reconnect button + error
 *     detail; common in Testing mode after 7d when refresh tokens
 *     expire)
 */
function renderGmailSection(gmail, env) {
  const hasOauthApp = !!(env?.GMAIL_CLIENT_ID && env?.GMAIL_CLIENT_SECRET);

  return html`
    <section class="card" style="margin-top:1rem">
      <div class="card-header">
        <h2>Gmail connection</h2>
      </div>
      <p class="muted">
        Read-only Gmail access for Claudia. When connected, she can search and read your Gmail
        through her chat tools (search_gmail, read_gmail_message, list_gmail_threads,
        read_gmail_thread). She can&rsquo;t send, can&rsquo;t modify, can&rsquo;t delete.
      </p>

      ${!hasOauthApp ? html`
        <div class="claudia-gmail-state claudia-gmail-state--missing">
          <strong>OAuth client not configured.</strong>
          <p style="margin:0.4rem 0 0">
            Set <code>GMAIL_CLIENT_ID</code> and <code>GMAIL_CLIENT_SECRET</code> via:
            <br>
            <code>npx wrangler pages secret put GMAIL_CLIENT_ID --project-name=c-lars-pms</code>
            <br>
            <code>npx wrangler pages secret put GMAIL_CLIENT_SECRET --project-name=c-lars-pms</code>
            <br>
            Get the values from a Google Cloud Console OAuth client (Web application type, with
            redirect URI <code>https://&lt;your-host&gt;/sandbox/assistant/gmail/callback</code>).
          </p>
        </div>
      ` : !gmail.connected ? html`
        <div class="claudia-gmail-state claudia-gmail-state--off">
          <strong>Not connected.</strong>
          <p style="margin:0.4rem 0 0.8rem">
            Click Connect to authenticate with Google. You&rsquo;ll see Google&rsquo;s consent
            screen, grant the gmail.readonly scope, and be redirected back here.
          </p>
          <a class="btn primary" href="/sandbox/assistant/gmail/connect">Connect Gmail</a>
        </div>
      ` : html`
        <div class="claudia-gmail-state ${gmail.last_error ? 'claudia-gmail-state--err' : 'claudia-gmail-state--on'}">
          ${gmail.last_error ? html`
            <strong>Connected, but last refresh failed.</strong>
            <p style="margin:0.4rem 0">
              <code style="color:#991b1b">${escape(String(gmail.last_error).slice(0, 240))}</code>
            </p>
            <p class="muted" style="margin:0.4rem 0 0.8rem;font-size:0.85rem">
              Most common cause: in Google Cloud &ldquo;Testing&rdquo; mode, refresh tokens expire
              after 7 days. Reconnect to mint fresh ones.
            </p>
          ` : html`
            <strong>Connected as ${escape(gmail.connected_email || '(unknown email)')}.</strong>
            <p class="muted" style="margin:0.4rem 0 0.8rem;font-size:0.85rem">
              Connected ${escape(formatRelative(gmail.connected_at))}
              ${gmail.last_refreshed_at ? html` &middot; last refresh ${escape(formatRelative(gmail.last_refreshed_at))}` : ''}
              ${gmail.scopes ? html`<br>Scopes: <code style="font-size:0.8rem">${escape(gmail.scopes)}</code>` : ''}
            </p>
          `}
          <a class="btn ${gmail.last_error ? 'primary' : ''}" href="/sandbox/assistant/gmail/connect">
            ${gmail.last_error ? 'Reconnect' : 'Reconnect (force re-auth)'}
          </a>
          <form method="post" action="/sandbox/assistant/gmail/disconnect"
                style="display:inline;margin-left:0.5rem"
                onsubmit="return confirm('Disconnect Gmail? Claudia will lose Gmail access until reconnected.');">
            <button type="submit" class="btn">Disconnect</button>
          </form>
        </div>
      `}

      <style>
        .claudia-gmail-state {
          padding: 0.75rem 1rem;
          border-radius: 6px;
          margin-top: 0.5rem;
        }
        .claudia-gmail-state p { margin-top: 0.25rem; }
        .claudia-gmail-state--missing {
          background: #fef3c7;
          border: 1px solid #fcd34d;
          color: #78350f;
        }
        .claudia-gmail-state--off {
          background: #f1f5f9;
          border: 1px solid #cbd5e1;
        }
        .claudia-gmail-state--on {
          background: #ecfdf5;
          border: 1px solid #6ee7b7;
          color: #065f46;
        }
        .claudia-gmail-state--err {
          background: #fef2f2;
          border: 1px solid #fca5a5;
          color: #7f1d1d;
        }
      </style>
    </section>
  `;
}

/**
 * Render the small flash banner shown after a connect/disconnect/error
 * round-trip from the OAuth flow endpoints. The query-string param is
 * set by callback.js / disconnect.js.
 */
function renderGmailFlash(state, url) {
  const reason = url.searchParams.get('reason') || '';
  switch (state) {
    case 'connected':
      return html`<div class="claudia-flash success" style="margin:0.75rem 0;padding:0.6rem 0.85rem;background:#ecfdf5;border:1px solid #6ee7b7;border-radius:6px;color:#065f46">
        Gmail connected.
      </div>`;
    case 'disconnected':
      return html`<div class="claudia-flash" style="margin:0.75rem 0;padding:0.6rem 0.85rem;background:#f1f5f9;border:1px solid #cbd5e1;border-radius:6px">
        Gmail disconnected.
      </div>`;
    case 'denied':
      return html`<div class="claudia-flash" style="margin:0.75rem 0;padding:0.6rem 0.85rem;background:#fef3c7;border:1px solid #fcd34d;border-radius:6px;color:#78350f">
        Connection canceled${reason ? html` (${escape(reason)})` : ''}.
      </div>`;
    case 'no_refresh_token':
      return html`<div class="claudia-flash" style="margin:0.75rem 0;padding:0.6rem 0.85rem;background:#fef2f2;border:1px solid #fca5a5;border-radius:6px;color:#7f1d1d">
        Google didn&rsquo;t return a refresh token. Visit <a href="https://myaccount.google.com/permissions" target="_blank" rel="noopener">Google permissions</a>, remove the app, then click Connect again.
      </div>`;
    case 'error':
    case 'save_error':
      return html`<div class="claudia-flash" style="margin:0.75rem 0;padding:0.6rem 0.85rem;background:#fef2f2;border:1px solid #fca5a5;border-radius:6px;color:#7f1d1d">
        Connection error${reason ? html`: <code>${escape(reason)}</code>` : ''}.
      </div>`;
    default:
      return '';
  }
}

function formatRelative(iso) {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
