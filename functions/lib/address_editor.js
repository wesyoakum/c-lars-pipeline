// functions/lib/address_editor.js
//
// Multi-address editor used by the account new / edit forms and the
// account detail page.
//
// UI model: accounts have a flat list of address rows, each with
//   { id, kind, label, address, is_default }
// where kind ∈ {'billing', 'physical'}.
//
// Client side: Alpine.js component keeps an array of rows in memory and
// re-renders on add/remove. On submit, the current list is serialized
// into a single hidden <input name="addresses_json"> so the server
// handler only has to JSON.parse one value.
//
// Server side: parseAddressForm() reads that JSON, normalizes it, and
// applyAddresses() produces the D1 statements needed to reconcile the
// account's existing rows with the submitted list (INSERT new rows,
// UPDATE changed rows, DELETE removed rows) — these statements go into
// the same batch() as the primary accounts UPDATE so the whole save is
// atomic.

import { all, stmt } from './db.js';
import { uuid, now } from './ids.js';
import { html, raw, escape } from './layout.js';

const VALID_KINDS = new Set(['billing', 'physical']);

/**
 * Render the Alpine-powered address editor block. `initial` is an array
 * of addresses to prefill (empty array for new accounts). Returns an
 * html tagged-template result suitable for interpolation.
 */
export function renderAddressEditor(initial = []) {
  const initialJson = JSON.stringify(
    initial.map((a) => ({
      id: a.id ?? '',
      kind: a.kind,
      label: a.label ?? '',
      address: a.address ?? '',
      is_default: !!a.is_default,
    }))
  );

  // We pass the initial array via a data-initial attribute rather than
  // embedding the JSON inside the x-data expression. Trying to inline
  // JSON into an Alpine expression trips over nested quote escaping —
  // data-initial just uses the browser's HTML attribute parser, which
  // handles &quot;/&amp; cleanly.
  return html`
    <div class="address-editor" data-initial="${escape(initialJson)}"
         x-data="pmsAddressEditor()">
      <div class="address-editor-header">
        <strong>Addresses</strong>
        <div class="address-editor-actions">
          <button type="button" class="btn btn-sm" @click="add('billing')">+ Billing</button>
          <button type="button" class="btn btn-sm" @click="add('physical')">+ Physical</button>
        </div>
      </div>

      <template x-if="addresses.length === 0">
        <p class="muted">No addresses yet. Use the buttons above to add a billing or physical address.</p>
      </template>

      <template x-for="(a, i) in addresses" :key="i">
        <div class="address-row" :class="'address-row-' + a.kind">
          <div class="address-row-head">
            <select x-model="a.kind" class="address-row-kind">
              <option value="billing">Billing</option>
              <option value="physical">Physical</option>
            </select>
            <input type="text" x-model="a.label" placeholder="Label (e.g. HQ, Main shop, Houston delivery)"
                   class="address-row-label">
            <label class="checkbox address-row-default">
              <input type="checkbox" x-model="a.is_default" @change="enforceDefault(i)">
              <span>Default</span>
            </label>
            <button type="button" class="btn btn-sm danger" @click="remove(i)">Remove</button>
          </div>
          <textarea x-model="a.address" rows="3"
                    placeholder="Street address" class="address-row-text"></textarea>
        </div>
      </template>

      <input type="hidden" name="addresses_json" :value="JSON.stringify(addresses)">
    </div>
  `;
}

/**
 * Client-side Alpine component used by the editor. Returned as a plain
 * JS source string so it can be injected via raw() in the page <script>
 * block. Register with Alpine via `Alpine.data('pmsAddressEditor', ...)`
 * on the same element you render the editor into (the x-data binding
 * above calls it by name).
 *
 * The outer bridge is defined at window scope so it's available by the
 * time Alpine evaluates the x-data expression during its initial sweep.
 */
export function addressEditorScript() {
  return `
(function() {
  function pmsAddressEditor() {
    return {
      addresses: [],
      init: function() {
        // Initial rows come in via data-initial on the x-data element,
        // not as a function argument — trying to pass JSON through the
        // Alpine x-data expression runs into nested-quote escaping hell.
        var raw = '[]';
        try {
          if (this.$el && this.$el.dataset && this.$el.dataset.initial) {
            raw = this.$el.dataset.initial;
          }
        } catch (e) {}
        var initial = [];
        try { initial = JSON.parse(raw) || []; } catch (e) { initial = []; }
        this.addresses = initial.map(function(a) {
          return {
            id: a.id || '',
            kind: a.kind === 'physical' ? 'physical' : 'billing',
            label: a.label || '',
            address: a.address || '',
            is_default: !!a.is_default,
          };
        });
      },
      add: function(kind) {
        this.addresses.push({
          id: '',
          kind: kind,
          label: '',
          address: '',
          is_default: this.addresses.filter(function(a) { return a.kind === kind; }).length === 0,
        });
      },
      remove: function(i) {
        this.addresses.splice(i, 1);
      },
      enforceDefault: function(i) {
        // Only one default per kind.
        var row = this.addresses[i];
        if (!row.is_default) return;
        var kind = row.kind;
        this.addresses.forEach(function(a, j) {
          if (j !== i && a.kind === kind) a.is_default = false;
        });
      },
    };
  }
  // Make it available at window scope so the x-data attribute can see it
  // when Alpine does its initial pass.
  window.pmsAddressEditor = pmsAddressEditor;
  document.addEventListener('alpine:init', function() {
    if (window.Alpine && window.Alpine.data) {
      window.Alpine.data('pmsAddressEditor', pmsAddressEditor);
    }
  });
})();
`;
}

/**
 * Parse the `addresses_json` hidden field out of a form-body object and
 * return a normalized array of address entries. Drops entries with empty
 * addresses. Returns [] on missing/invalid input.
 */
export function parseAddressForm(formValues) {
  const raw = formValues?.addresses_json;
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const kind = entry.kind === 'physical' ? 'physical' : 'billing';
    const address = typeof entry.address === 'string' ? entry.address.trim() : '';
    if (!address) continue;
    out.push({
      id: typeof entry.id === 'string' && entry.id ? entry.id : null,
      kind,
      label: typeof entry.label === 'string' ? entry.label.trim() : '',
      address,
      is_default: !!entry.is_default,
    });
  }
  // Enforce one default per kind: if multiple are flagged, first wins.
  // If none are flagged for a kind that has rows, promote the first.
  const seenDefault = { billing: false, physical: false };
  for (const row of out) {
    if (row.is_default) {
      if (seenDefault[row.kind]) row.is_default = false;
      else seenDefault[row.kind] = true;
    }
  }
  for (const kind of ['billing', 'physical']) {
    if (seenDefault[kind]) continue;
    const first = out.find((r) => r.kind === kind);
    if (first) first.is_default = true;
  }
  return out;
}

/**
 * Load the current addresses for an account. Returns an array sorted by
 * kind then is_default DESC then label.
 */
export async function loadAddresses(db, accountId) {
  return all(
    db,
    `SELECT id, account_id, kind, label, address, is_default, notes, created_at, updated_at
       FROM account_addresses
      WHERE account_id = ?
      ORDER BY kind, is_default DESC, label, created_at`,
    [accountId]
  );
}

/**
 * Compute the D1 statements required to reconcile an account's stored
 * addresses with a submitted list. Returns { statements, changes }.
 *
 * Strategy:
 *   - For each submitted row with an id, update-or-insert (update if id
 *     exists in DB, insert if it doesn't).
 *   - For each submitted row without an id, insert a new one with a
 *     freshly generated uuid.
 *   - Delete rows that exist in DB but whose id is not in the submitted set.
 *
 * `existing` is the return value of loadAddresses(); if omitted the
 * caller is expected to be in "new account" mode and everything becomes
 * an INSERT.
 */
export function buildAddressStatements(db, accountId, submitted, existing = [], user = null) {
  const ts = now();
  const existingById = new Map(existing.map((r) => [r.id, r]));
  const submittedIds = new Set();
  const statements = [];
  const changes = { inserted: 0, updated: 0, deleted: 0 };

  for (const row of submitted) {
    if (row.id && existingById.has(row.id)) {
      // UPDATE existing row only if something actually changed.
      const prev = existingById.get(row.id);
      submittedIds.add(row.id);
      const dirty =
        prev.kind !== row.kind ||
        (prev.label ?? '') !== row.label ||
        prev.address !== row.address ||
        !!prev.is_default !== !!row.is_default;
      if (dirty) {
        statements.push(
          stmt(
            db,
            `UPDATE account_addresses
                SET kind = ?, label = ?, address = ?, is_default = ?, updated_at = ?
              WHERE id = ? AND account_id = ?`,
            [row.kind, row.label, row.address, row.is_default ? 1 : 0, ts, row.id, accountId]
          )
        );
        changes.updated += 1;
      }
    } else {
      // INSERT new row.
      const id = uuid();
      if (row.id) submittedIds.add(row.id); // defensive — ignore stale ids
      statements.push(
        stmt(
          db,
          `INSERT INTO account_addresses
             (id, account_id, kind, label, address, is_default, created_at, updated_at, created_by_user_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            accountId,
            row.kind,
            row.label,
            row.address,
            row.is_default ? 1 : 0,
            ts,
            ts,
            user?.id ?? null,
          ]
        )
      );
      changes.inserted += 1;
    }
  }

  // DELETE rows that vanished from the submitted set.
  for (const prev of existing) {
    if (!submittedIds.has(prev.id)) {
      statements.push(
        stmt(db, `DELETE FROM account_addresses WHERE id = ? AND account_id = ?`, [prev.id, accountId])
      );
      changes.deleted += 1;
    }
  }

  return { statements, changes };
}

/**
 * Render a compact read-only view of addresses for the account detail page.
 */
export function renderAddressView(addresses) {
  if (!addresses || addresses.length === 0) {
    return html`<p class="muted">No addresses on file.</p>`;
  }
  const billing = addresses.filter((a) => a.kind === 'billing');
  const physical = addresses.filter((a) => a.kind === 'physical');
  return html`
    <div class="address-view">
      ${billing.length > 0
        ? html`
          <div class="address-view-group">
            <strong>Billing</strong>
            ${billing.map(
              (a) => html`
                <div class="address-view-row">
                  <div class="address-view-head">
                    ${a.label ? html`<span class="address-view-label">${a.label}</span>` : ''}
                    ${a.is_default ? html`<span class="pill pill-success">default</span>` : ''}
                  </div>
                  <pre class="addr">${escape(a.address)}</pre>
                </div>`
            )}
          </div>`
        : ''}
      ${physical.length > 0
        ? html`
          <div class="address-view-group">
            <strong>Physical</strong>
            ${physical.map(
              (a) => html`
                <div class="address-view-row">
                  <div class="address-view-head">
                    ${a.label ? html`<span class="address-view-label">${a.label}</span>` : ''}
                    ${a.is_default ? html`<span class="pill pill-success">default</span>` : ''}
                  </div>
                  <pre class="addr">${escape(a.address)}</pre>
                </div>`
            )}
          </div>`
        : ''}
    </div>
  `;
}

export const ADDRESS_VALID_KINDS = VALID_KINDS;
