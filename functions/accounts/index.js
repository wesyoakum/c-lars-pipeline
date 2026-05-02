// functions/accounts/index.js
//
// GET  /accounts        — list all accounts with sort/filter/search
// POST /accounts        — create a new account (called by the new form)

import { all, stmt, batch } from '../lib/db.js';
import { auditStmt } from '../lib/audit.js';
import { validateAccount } from '../lib/validators.js';
import { layout, htmlResponse, html, raw, escape, subnavTabs } from '../lib/layout.js';
import { uuid, now } from '../lib/ids.js';
import {
  redirectWithFlash,
  formBody,
  readFlash,
  isPopupMode,
  popupCloseResponse,
} from '../lib/http.js';
import { parseAddressForm, buildAddressStatements } from '../lib/address_editor.js';
import { listScript, listTableHead, listToolbar, rowDataAttrs } from '../lib/list-table.js';
import { ieText, ieSelect, listInlineEditScript } from '../lib/list-inline-edit.js';
import { slugifyGroup, displayAccountName } from '../lib/account-groups.js';
import { isActiveOnly, accountActivePredicate } from '../lib/activeness.js';

// Keep in sync with functions/accounts/[id]/index.js::SEGMENT_OPTIONS.
// Used by the inline-edit select in the segment column.
const SEGMENT_OPTIONS = [
  { value: '', label: '— None —' },
  { value: 'WROV', label: 'WROV' },
  { value: 'Research', label: 'Research' },
  { value: 'Defense', label: 'Defense' },
  { value: 'Commercial', label: 'Commercial' },
  { value: 'Other', label: 'Other' },
];

// Active/Inactive options for the Status inline-edit select.
// String values (not 0/1) so list-table's select-filter dropdown shows
// them verbatim and the patch handler's coerce() maps them back to ints.
const ACTIVE_OPTIONS = [
  { value: 'active',   label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
];

/**
 * GET /accounts — list accounts with full client-side sort/filter/search.
 *
 * Honors two per-user prefs from migration 0034 (set via the gear-icon
 * settings popup in the header):
 *
 *   show_alias    — the Name column displays the alias as plain text
 *                   (inline-edit disabled for that cell, since the
 *                   underlying `name` field would still be the patch
 *                   target). The Alias column always shows alias.
 *                   Initial server sort is alias-aware.
 *
 *   group_rollup  — accounts sharing a parent_group label collapse
 *                   into one synthetic row per group, with summed
 *                   counts and a link to /accounts/group/:slug.
 *                   Inline-edit is disabled on grouped rows.
 */
export async function onRequestGet(context) {
  const { env, data, request } = context;
  const user = data?.user;
  const prefs = {
    show_alias: !!user?.show_alias,
    group_rollup: !!user?.group_rollup,
  };
  const url = new URL(request.url);

  const orderBy = prefs.show_alias
    ? `COALESCE(NULLIF(a.alias, ''), a.name)`
    : `a.name`;

  // When the user's `active_only` pref is on, hide is_active=0 rows.
  // Detail-page navigation still works — it's a list filter, not a
  // soft-delete.
  const activeWhere = isActiveOnly(user) ? `WHERE ${accountActivePredicate('a')}` : '';

  const rows = await all(
    env.DB,
    `SELECT a.id, a.name, a.alias, a.parent_group, a.segment, a.phone, a.website, a.updated_at,
            a.is_active, a.external_source,
            (SELECT COUNT(*) FROM contacts c WHERE c.account_id = a.id) AS contact_count,
            (SELECT COUNT(*) FROM opportunities o WHERE o.account_id = a.id) AS opp_count
       FROM accounts a
      ${activeWhere}
      ORDER BY ${orderBy}
      LIMIT 500`
  );

  // Collect the set of distinct parent_group labels already in use so
  // the inline-edit select for that column can offer them as options.
  // Includes a trailing "+ Add new group…" sentinel that the client
  // controller swaps for a free-text input when picked.
  const existingGroupLabels = Array.from(
    new Set(rows.map((r) => r.parent_group).filter(Boolean))
  ).sort();
  const groupOptions = [
    { value: '', label: '— None —' },
    ...existingGroupLabels.map((g) => ({ value: g, label: g })),
    { value: '__new__', label: '+ Add new group\u2026' },
  ];

  const columns = [
    { key: 'name',          label: 'Name',      sort: 'text',   filter: 'text',   default: true },
    { key: 'alias',         label: 'Alias',     sort: 'text',   filter: 'text',   default: true },
    { key: 'parent_group',  label: 'Group',     sort: 'text',   filter: 'select', default: false },
    { key: 'segment',       label: 'Segment',   sort: 'text',   filter: 'select', default: true },
    { key: 'status',        label: 'Status',    sort: 'text',   filter: 'select', default: true },
    // Source distinguishes WFM-imported rows from Pipeline-native ones.
    // Off by default to keep the list compact; turn on via the column-
    // picker (gear icon) when auditing what came from WFM vs. what
    // didn't.
    { key: 'source',        label: 'Source',    sort: 'text',   filter: 'select', default: false },
    { key: 'phone',         label: 'Phone',     sort: 'text',   filter: 'text',   default: true },
    { key: 'contact_count', label: 'Contacts',  sort: 'number', filter: 'range',  default: true },
    { key: 'opp_count',     label: 'Opps',      sort: 'number', filter: 'range',  default: true },
    { key: 'website',       label: 'Website',   sort: 'text',   filter: 'text',   default: false },
    { key: 'updated',       label: 'Updated',   sort: 'date',   filter: 'text',   default: true },
    { key: 'delete',        label: '',          sort: null,     filter: null,     default: true },
  ];

  // Build the per-row payload. When `prefs.show_alias` is on we swap the
  // value rendered in the Name column to the alias (the legal name is
  // still on r.name and accessible from the detail page) — the Alias
  // column always shows alias. The quicksearch blob stays the union of
  // name + alias + parent_group regardless, so typing any of them works.
  const baseRows = rows.map(r => ({
    id: r.id,
    is_group: false,
    open_href: `/accounts/${r.id}`,
    // `name` is the quicksearch text blob (name + alias + parent_group
    // joined) so typing "helix", "HR" (alias), or "Super Big Corp"
    // (group) all find Helix Robotics Inc. After an inline edit the
    // client rebuilds this from data-name_display / data-alias /
    // data-parent_group via the data-combined-name hint on the row.
    name: [r.name ?? '', r.alias ?? '', r.parent_group ?? '']
      .filter(Boolean)
      .join(' '),
    name_display: displayAccountName(r, prefs),
    legal_name: r.name ?? '',
    // Raw alias. Unaliased rows sort as empty strings (list-table.js
    // pushes empty/null to the end). Display uses a muted fallback to
    // the name, handled by ieText({ fallbackText }).
    alias: r.alias ?? '',
    parent_group: r.parent_group ?? '',
    segment: r.segment ?? '',
    // `status` is the string form ('active'/'inactive') used by the
    // inline-edit select, the select-filter dropdown, and sort. The
    // raw 0/1 lives on `is_active` for any callers that care.
    is_active: r.is_active,
    status: r.is_active === 0 ? 'inactive' : 'active',
    phone: r.phone ?? '',
    contact_count: r.contact_count ?? 0,
    opp_count: r.opp_count ?? 0,
    website: r.website ?? '',
    updated: (r.updated_at ?? '').slice(0, 10),
    // Coarse source tag: WFM-imported rows have a non-null
    // external_source ('wfm'/'wfm-lead'/etc.); Pipeline-native rows
    // have NULL. Normalized to 'wfm' / 'pipeline' so the select-filter
    // dropdown is binary.
    source: r.external_source ? 'wfm' : 'pipeline',
  }));

  // When `prefs.group_rollup` is on, accounts that share a parent_group
  // collapse into one synthetic row each. Counts are summed; segment
  // and status fall back to "Multiple" / "mixed" when members differ.
  // The synthetic row's open link points to the existing group view
  // at /accounts/group/:slug.
  let rowData;
  if (prefs.group_rollup) {
    const groupBuckets = new Map();
    const standalone = [];
    for (const r of baseRows) {
      const g = (r.parent_group || '').trim();
      if (!g) { standalone.push(r); continue; }
      if (!groupBuckets.has(g)) groupBuckets.set(g, []);
      groupBuckets.get(g).push(r);
    }
    const grouped = [...groupBuckets.entries()].map(([label, members]) => {
      const slug = slugifyGroup(label);
      const segments = new Set(members.map((m) => m.segment).filter(Boolean));
      const statuses = new Set(members.map((m) => m.status));
      const updated = members.reduce(
        (max, m) => (m.updated > max ? m.updated : max),
        ''
      );
      const segmentCell = segments.size === 1 ? [...segments][0]
        : segments.size === 0 ? '' : 'Multiple';
      const statusCell = statuses.size === 1 ? [...statuses][0] : 'mixed';
      const sources = new Set(members.map((m) => m.source));
      const sourceCell = sources.size === 1 ? [...sources][0] : 'mixed';
      return {
        id: 'group:' + slug,
        is_group: true,
        open_href: `/accounts/group/${slug}`,
        // Quicksearch blob: group label + member names + member aliases
        // so typing the group OR any member still finds the row.
        name: [label, ...members.map((m) => m.legal_name), ...members.map((m) => m.alias)]
          .filter(Boolean)
          .join(' '),
        name_display: label,
        legal_name: label,
        alias: '',
        parent_group: label,
        segment: segmentCell,
        is_active: statuses.size > 1 ? null : (members[0].is_active),
        status: statusCell,
        source: sourceCell,
        phone: '',
        contact_count: members.reduce((s, m) => s + (m.contact_count || 0), 0),
        opp_count: members.reduce((s, m) => s + (m.opp_count || 0), 0),
        website: '',
        updated,
      };
    });
    // Merge groups + standalone rows, sorted by display name (matches
    // the alphabetic ORDER BY behavior the user expects).
    rowData = [...grouped, ...standalone].sort((a, b) =>
      (a.name_display || '').toLowerCase().localeCompare((b.name_display || '').toLowerCase())
    );
  } else {
    rowData = baseRows;
  }

  const tabs = subnavTabs(
    [
      { href: '/accounts', label: 'Accounts' },
      { href: '/accounts/contacts', label: 'Contacts' },
    ],
    '/accounts'
  );

  const body = html`
    ${tabs}
    <section class="card">
      <div class="card-header">
        <h1 class="page-title">Accounts</h1>
        ${listToolbar({ id: 'acct', count: rows.length, columns, newOnClick: "window.Pipeline.openWizard('account', {})", newLabel: 'New account' })}
      </div>

      ${rows.length === 0
        ? html`<p class="muted">
            No accounts yet. Start by
            <a href="/accounts/new">creating one</a>.
          </p>`
        : html`
          <div class="opp-list" data-columns="${escape(JSON.stringify(columns))}">
            <table class="data opp-list-table">
              ${listTableHead(columns, rowData)}
              <tbody data-role="rows">
                ${rowData.map(r => html`
                  <tr data-row-id="${escape(r.id)}"
                      data-row-href="${escape(r.open_href)}"
                      data-name_display="${escape(r.name_display)}"
                      data-combined-name="name_display alias parent_group"
                      ${r.is_group ? raw('data-is-group="1"') : ''}
                      ${raw(rowDataAttrs(columns, r))}>
                    <td class="col-name" data-col="name">
                      ${r.is_group
                        ? html`<span class="ie-display">${escape(r.name_display)}</span>`
                        : (prefs.show_alias
                            ? html`<span class="cell-text">${escape(r.name_display)}</span>`
                            : ieText('name', r.name_display))}
                    </td>
                    <td class="col-alias" data-col="alias">
                      ${r.is_group
                        ? html`<span class="cell-text muted">\u2014</span>`
                        : ieText('alias', r.alias, { fallbackText: r.legal_name })}
                    </td>
                    <td class="col-parent_group" data-col="parent_group">
                      ${r.is_group
                        ? html`<span class="cell-text">${escape(r.parent_group)}</span>`
                        : ieSelect('parent_group', r.parent_group, groupOptions, { allowNew: true })}
                    </td>
                    <td class="col-segment" data-col="segment">
                      ${r.is_group
                        ? html`<span class="cell-text">${escape(r.segment)}</span>`
                        : ieSelect('segment', r.segment, SEGMENT_OPTIONS)}
                    </td>
                    <td class="col-status" data-col="status">
                      ${r.is_group
                        ? html`<span class="cell-text">${escape(r.status)}</span>`
                        : ieSelect('is_active', r.status, ACTIVE_OPTIONS)}
                    </td>
                    <td class="col-source" data-col="source">
                      <span class="cell-text muted" style="font-size:.78rem">${escape(r.source)}</span>
                    </td>
                    <td class="col-phone" data-col="phone">
                      ${r.is_group
                        ? html`<span class="cell-text muted">\u2014</span>`
                        : ieText('phone', r.phone, { inputType: 'tel' })}
                    </td>
                    <td class="col-contact_count num" data-col="contact_count">${r.contact_count}</td>
                    <td class="col-opp_count num" data-col="opp_count">${r.opp_count}</td>
                    <td class="col-website" data-col="website">
                      ${r.is_group
                        ? html`<span class="cell-text muted">\u2014</span>`
                        : ieText('website', r.website, { inputType: 'url' })}
                    </td>
                    <td class="col-updated" data-col="updated"><small class="muted">${escape(r.updated)}</small></td>
                    <td class="col-delete" data-col="delete">
                      ${r.is_group
                        ? html`<span class="muted">—</span>`
                        : html`<form method="post" action="/accounts/${escape(r.id)}/delete" style="display:inline;"
                                onsubmit="return confirm('Delete account ${escape((r.legal_name || r.name_display || '').slice(0, 80))} and all its contacts? This cannot be undone.');">
                            <button type="submit" class="row-delete-btn" title="Delete account" aria-label="Delete account">×</button>
                          </form>`}
                    </td>
                  </tr>
                `)}
              </tbody>
            </table>
          </div>
          <script>${raw(listScript('pipeline.accounts.v1', 'name', 'asc'))}</script>
          <script>${raw(listInlineEditScript('/accounts/:id/patch', {
            // Column key `status` ↔ patch field `is_active`. The patch
            // handler accepts 'active'/'inactive' string values and
            // coerces them to 0/1 for storage.
            fieldAttrMap: { is_active: 'status' },
          }))}</script>
        `}
    </section>
  `;

  return htmlResponse(
    layout('Accounts', body, {
      user,
      env: data?.env,
      activeNav: '/accounts',
      flash: readFlash(url),
      breadcrumbs: [{ label: 'Accounts' }],
    })
  );
}

/**
 * Detects a request coming from the wizard modal or any XHR-style
 * client. We check three signals:
 *   - the wizard posts `source=wizard` in the form body
 *   - most clients send `x-requested-with: XMLHttpRequest`
 *   - an `accept: application/json` header with no text/html preference
 * Any of those is enough to switch the handler into JSON mode.
 */
function isAjaxRequest(request, input) {
  if (input?.source === 'wizard' || input?.source === 'modal') return true;
  const xrw = request.headers.get('x-requested-with');
  if (xrw && xrw.toLowerCase() === 'xmlhttprequest') return true;
  const accept = request.headers.get('accept') || '';
  return accept.includes('application/json') && !accept.includes('text/html');
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

/**
 * POST /accounts — create a new account.
 *
 * Three response modes:
 *   1. AJAX (source=wizard, x-requested-with, or JSON accept header):
 *      returns { ok: true, id, redirectUrl } or { ok: false, error, errors }
 *   2. Popup mode (isPopupMode true): postMessage + close the popup
 *   3. Classic form submit: re-render with errors or redirect-with-flash
 */
export async function onRequestPost(context) {
  const { env, data, request } = context;
  const user = data?.user;
  const input = await formBody(request);
  const ajax = isAjaxRequest(request, input);
  const { ok, value, errors } = validateAccount(input);
  const submittedAddresses = parseAddressForm(input);

  if (!ok) {
    if (ajax) {
      const firstError = Object.values(errors)[0] || 'Invalid input.';
      return jsonResponse({ ok: false, error: firstError, errors }, 400);
    }
    // Re-render the new form with the errors inline. Hand back the parsed
    // address rows so the user doesn't lose them.
    const { renderNewForm } = await import('./new.js');
    return renderNewForm(context, {
      values: input,
      errors,
      addresses: submittedAddresses,
    });
  }

  const id = uuid();
  const ts = now();

  // Denormalized convenience columns on accounts: pick the first default
  // billing / physical (or just the first of each kind) so legacy readers
  // that still hit accounts.address_billing / address_physical keep working.
  // 'both' rows count toward either slot.
  const isBilling = (a) => a.kind === 'billing' || a.kind === 'both';
  const isPhysical = (a) => a.kind === 'physical' || a.kind === 'both';
  const firstBilling =
    submittedAddresses.find((a) => isBilling(a) && a.is_default) ||
    submittedAddresses.find((a) => isBilling(a));
  const firstPhysical =
    submittedAddresses.find((a) => isPhysical(a) && a.is_default) ||
    submittedAddresses.find((a) => isPhysical(a));

  const statements = [
    stmt(
      env.DB,
      `INSERT INTO accounts
         (id, name, alias, segment, address_billing, address_physical,
          phone, website, notes, owner_user_id, is_active,
          created_at, updated_at, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        value.name,
        value.alias,
        value.segment,
        firstBilling?.address ?? null,
        firstPhysical?.address ?? null,
        value.phone,
        value.website,
        value.notes,
        value.owner_user_id ?? user?.id ?? null,
        value.is_active,
        ts,
        ts,
        user?.id ?? null,
      ]
    ),
  ];

  // Insert the normalized address rows (no existing rows on create).
  const { statements: addrStmts } = buildAddressStatements(
    env.DB,
    id,
    submittedAddresses,
    [],
    user
  );
  statements.push(...addrStmts);

  statements.push(
    auditStmt(env.DB, {
      entityType: 'account',
      entityId: id,
      eventType: 'created',
      user,
      summary: `Created account "${value.name}"`,
      changes: { ...value, address_count: submittedAddresses.length },
    })
  );

  await batch(env.DB, statements);

  if (ajax) {
    return jsonResponse({
      ok: true,
      id,
      name: value.name,
      redirectUrl: `/accounts/${id}`,
    });
  }

  if (isPopupMode(request, input)) {
    return popupCloseResponse('pipeline.account.created', {
      account: { id, name: value.name },
    });
  }

  return redirectWithFlash(`/accounts/${id}`, `Account "${value.name}" created.`);
}
