// functions/lib/claudia-audit-render.js
//
// Render helpers for /settings/claudia/audit. Shared between the GET
// page handler and the per-row undo POST handler so a successful undo
// returns byte-identical row HTML for the HTMX outerHTML swap.
//
// Lives under functions/lib/ rather than the route tree because the
// Pages Functions bundler can't reliably resolve sibling-module
// imports out of bracketed [id]/ directories (same constraint as
// claudia-threads-render.js).

import { html, escape } from './layout.js';

const UNDO_WINDOW_HOURS = 24;

/**
 * Map of action_key → human label for the audit dropdown facet. Keeps
 * the picker readable when the action list grows. Unknown actions
 * fall back to the raw action key in the rendered <option>.
 */
export const ACTION_LABEL_MAP = {
  create_account: 'Create account',
  update_account: 'Update account',
  create_contact: 'Create contact',
  update_contact: 'Update contact',
  create_activity: 'Create activity',
  update_activity: 'Update activity',
  complete_activity: 'Complete activity',
  create_opportunity: 'Create opportunity',
  update_opportunity: 'Update opportunity',
  create_quote_draft: 'Draft quote',
  create_job: 'Create job',
};

/**
 * Per-action color band on the action pill. Lets Wes scan the table
 * by category at a glance — creates green, updates amber, merges pink,
 * stage moves blue.
 */
function actionColorClass(action) {
  if (action.startsWith('create_')) return 'claudia-audit-action--create';
  if (action.startsWith('update_')) return 'claudia-audit-action--update';
  if (action === 'change_opportunity_stage') return 'claudia-audit-action--stage';
  if (action.startsWith('merge_')) return 'claudia-audit-action--merge';
  return '';
}

/**
 * Tab strip shared between /settings/claudia (permissions) and
 * /settings/claudia/audit. Active key: 'permissions' or 'audit'.
 *
 * Emits its own <style> block so callers don't have to re-declare the
 * CSS per page. Duplicate <style> blocks are harmless.
 */
export function claudiaAuditTabs(active) {
  return html`
    <style>
      .claudia-audit-tabs {
        display: flex; gap: 0.4rem; padding: 0.6rem 0;
        border-bottom: 1px solid #e2e8f0; margin-bottom: 0.75rem;
      }
      .claudia-audit-tabs a {
        padding: 6px 14px; text-decoration: none; color: #475569;
        border-radius: 6px; font-size: 13px; font-weight: 500;
      }
      .claudia-audit-tabs a:hover { background: #f1f5f9; color: #1a1a22; }
      .claudia-audit-tabs a.active { background: #2566ff; color: #fff; }
    </style>
    <div class="claudia-audit-tabs">
      <a href="/settings/claudia"        class="${active === 'permissions' ? 'active' : ''}">Permissions</a>
      <a href="/settings/claudia/audit"  class="${active === 'audit' ? 'active' : ''}">Audit log</a>
    </div>
  `;
}

/**
 * Render one row of the audit table. The <tr>'s id is
 * `claudia-audit-row-<writeId>` so the undo POST handler can
 * outerHTML-swap it after the undo lands.
 *
 * `label` is the human-readable name for the targeted entity (e.g.
 * "KCS" for an account write); the loader in audit.js batches that
 * lookup. Falls back to a short-id slice if the row was deleted.
 */
export function renderClaudiaAuditRow(w, label) {
  const colorClass = actionColorClass(w.action);
  const ts = w.created_at || '';
  const when = formatAuditWhen(ts);
  const ageHours = ts ? (Date.now() - Date.parse(ts)) / 3_600_000 : Infinity;
  const isUndone = !!w.undone_at;
  const isUndoableNow = !isUndone && ageHours <= UNDO_WINDOW_HOURS && w.action !== 'change_opportunity_stage';
  const isExpired = !isUndone && ageHours > UNDO_WINDOW_HOURS;
  const detailHref = entityDetailHref(w.ref_table, w.ref_id);
  const subjectLabel = label || `${w.ref_table.slice(0, -1)} ${String(w.ref_id || '').slice(0, 8)}`;

  return html`
    <tr id="claudia-audit-row-${escape(w.id)}">
      <td class="claudia-audit-when">${escape(when)}</td>
      <td>
        <span class="claudia-audit-action ${colorClass}">${escape(ACTION_LABEL_MAP[w.action] || w.action)}</span>
      </td>
      <td>
        <div class="claudia-audit-subject">
          ${detailHref
            ? html`<a class="claudia-audit-subject-link" href="${detailHref}">${escape(subjectLabel)}</a>`
            : html`<span>${escape(subjectLabel)}</span>`}
          <span class="claudia-audit-subject-id">${escape(w.ref_table)} · ${escape(String(w.ref_id || '').slice(0, 8))}</span>
        </div>
      </td>
      <td>
        <div class="claudia-audit-summary">${escape(w.summary || '(no summary)')}</div>
        ${w.batch_id
          ? html`<a class="claudia-audit-batch" href="/settings/claudia/audit?batch=${escape(w.batch_id)}" title="Filter to this batch">batch: ${escape(String(w.batch_id).slice(0, 12))}</a>`
          : ''}
      </td>
      <td class="claudia-audit-undo-col">
        ${isUndone
          ? html`<span class="claudia-audit-status claudia-audit-status--undone">undone${w.undone_at ? ` ${formatAuditWhen(w.undone_at)}` : ''}</span>${w.undo_reason ? html`<div class="claudia-audit-status" style="margin-top:2px">${escape(w.undo_reason)}</div>` : ''}`
          : isExpired
            ? html`<span class="claudia-audit-status claudia-audit-status--expired">undo window closed (>${UNDO_WINDOW_HOURS}h)</span>`
            : isUndoableNow
              ? html`<button type="button" class="claudia-audit-undo-btn"
                          hx-post="/settings/claudia/audit/${escape(w.id)}/undo"
                          hx-target="#claudia-audit-row-${escape(w.id)}"
                          hx-swap="outerHTML"
                          hx-confirm="Undo this write? It will be reversed and the audit row will be marked undone.">
                    Undo
                  </button>`
              : html`<span class="claudia-audit-status">stage changes can&rsquo;t be undone</span>`}
      </td>
    </tr>
  `;
}

/**
 * Map a (ref_table, ref_id) pair to its detail-page URL so the audit
 * row's subject can deep-link. Returns null for tables that don't have
 * a stable detail route.
 */
function entityDetailHref(refTable, refId) {
  if (!refId) return null;
  switch (refTable) {
    case 'accounts':       return `/accounts/${encodeURIComponent(refId)}`;
    case 'contacts':       return `/contacts/${encodeURIComponent(refId)}`;
    case 'activities':     return `/activities/${encodeURIComponent(refId)}`;
    case 'opportunities':  return `/opportunities/${encodeURIComponent(refId)}`;
    case 'quotes':         // quote detail lives nested under the opp
    case 'jobs':           return `/jobs/${encodeURIComponent(refId)}`;
    default:               return null;
  }
}

/**
 * Compact "when" string for audit rows. Newest writes show as relative
 * ("3m ago"); older ones get a short calendar date so dense scans
 * don't have to mentally translate "47h ago" into "yesterday."
 */
function formatAuditWhen(iso) {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return String(iso).slice(0, 16);
  const diff = Date.now() - ms;
  if (diff < 60_000)        return 'just now';
  if (diff < 3_600_000)     return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 24 * 3_600_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  const d = new Date(ms);
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
