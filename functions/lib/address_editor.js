// functions/lib/address_editor.js
//
// Multi-address editor used by the account new / edit forms and the
// account detail page.
//
// UI model: accounts have a flat list of address rows, each with
//   { id, kind, label, address, is_default }
// where kind ∈ {'billing', 'physical', 'both'}. The UI presents kind
// as two independent checkboxes (Billing / Physical); storing as
// 'both' is just the serialized form of "both checkboxes checked".
// A 'both' row counts as both the billing and physical address when
// callers pick a default.
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

const VALID_KINDS = new Set(['billing', 'physical', 'both']);

// Returns true when this row counts toward the given denormalized kind.
// 'both' rows count for both billing and physical; plain billing/physical
// rows only count for their own kind.
function matchesKind(row, kind) {
  if (!row) return false;
  if (row.kind === kind) return true;
  if (row.kind === 'both' && (kind === 'billing' || kind === 'physical')) return true;
  return false;
}

/**
 * Render the Alpine-powered address editor block. `initial` is an array
 * of addresses to prefill (empty array for new accounts).
 *
 * Options:
 *   saveUrl   — when provided, the editor auto-saves on change by POSTing
 *               JSON to this URL (debounced). A blank trailing row is
 *               kept at the end so you can keep adding without clicking.
 *
 * Returns an html tagged-template result suitable for interpolation.
 */
export function renderAddressEditor(initial = [], { saveUrl = '' } = {}) {
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
         data-save-url="${escape(saveUrl)}"
         x-data="pipelineAddressEditor()">
      <div class="address-editor-header">
        <strong>Addresses</strong>
        <div class="address-editor-actions">
          <button type="button" class="btn btn-sm" @click="add()" x-show="!saveUrl">+ Address</button>
          <span class="address-editor-status" x-show="saveUrl" x-text="statusText" :class="statusClass"></span>
        </div>
      </div>

      <template x-if="addresses.length === 0 && !saveUrl">
        <p class="muted">No addresses yet. Use the button above to add one.</p>
      </template>

      <template x-for="(a, i) in addresses" :key="a._key">
        <div class="address-row"
             :class="{
               'address-row-billing':  a.kind === 'billing',
               'address-row-physical': a.kind === 'physical',
               'address-row-both':     a.kind === 'both',
               'address-row-blank':    isBlank(a),
             }">
          <div class="address-row-head">
            <div class="address-row-kind-pills">
              <button type="button" class="pill pill-toggle"
                      :class="{ 'pill-active': a.kind === 'billing' || a.kind === 'both' }"
                      @click="setKindFlag(i, 'billing', !(a.kind === 'billing' || a.kind === 'both'))">Billing</button>
              <button type="button" class="pill pill-toggle"
                      :class="{ 'pill-active': a.kind === 'physical' || a.kind === 'both' }"
                      @click="setKindFlag(i, 'physical', !(a.kind === 'physical' || a.kind === 'both'))">Physical</button>
            </div>
            <input type="text" x-model="a.label" placeholder="Label (e.g. HQ, Main shop, Houston delivery)"
                   class="address-row-label" @input="onEdit()">
            <label class="checkbox address-row-default" x-show="!isBlank(a)">
              <input type="checkbox" x-model="a.is_default" @change="enforceDefault(i); onEdit()">
              <span>Default</span>
            </label>
            <button type="button" class="btn btn-sm danger" @click="remove(i)" x-show="!isBlank(a) || addresses.length > 1">Remove</button>
          </div>
          <textarea x-model="a.address" rows="3"
                    :placeholder="isBlank(a) ? 'Type a new address here…' : 'Street address'"
                    class="address-row-text" @input="onEdit()"></textarea>
        </div>
      </template>

      <input type="hidden" name="addresses_json" :value="serialize()">
    </div>
  `;
}

/**
 * Client-side Alpine component used by the editor. Returned as a plain
 * JS source string so it can be injected via raw() in the page <script>
 * block. Register with Alpine via `Alpine.data('pipelineAddressEditor', ...)`
 * on the same element you render the editor into (the x-data binding
 * above calls it by name).
 *
 * The outer bridge is defined at window scope so it's available by the
 * time Alpine evaluates the x-data expression during its initial sweep.
 */
export function addressEditorScript() {
  return `
(function() {
  var _keySeq = 1;
  function newKey() { return 'k' + (_keySeq++); }
  function pipelineAddressEditor() {
    return {
      addresses: [],
      saveUrl: '',
      statusText: '',
      statusClass: '',
      _saveTimer: null,
      _saveInFlight: false,
      _saveQueued: false,
      init: function() {
        // Initial rows come in via data-initial on the x-data element,
        // not as a function argument — trying to pass JSON through the
        // Alpine x-data expression runs into nested-quote escaping hell.
        var raw = '[]';
        try {
          if (this.$el && this.$el.dataset && this.$el.dataset.initial) {
            raw = this.$el.dataset.initial;
          }
          if (this.$el && this.$el.dataset) {
            this.saveUrl = this.$el.dataset.saveUrl || '';
          }
        } catch (e) {}
        var initial = [];
        try { initial = JSON.parse(raw) || []; } catch (e) { initial = []; }
        this.addresses = initial.map(function(a) {
          var kind = 'billing';
          if (a.kind === 'physical') kind = 'physical';
          else if (a.kind === 'both') kind = 'both';
          return {
            _key: newKey(),
            id: a.id || '',
            kind: kind,
            label: a.label || '',
            address: a.address || '',
            is_default: !!a.is_default,
          };
        });
        // In auto-save mode, always keep a trailing blank row available
        // for typing. In form-submit mode, the user clicks + Address.
        if (this.saveUrl) this.ensureTrailingBlank();
      },
      isBlank: function(a) {
        return !a || ((a.address || '').trim() === '');
      },
      ensureTrailingBlank: function() {
        var last = this.addresses[this.addresses.length - 1];
        if (!last || !this.isBlank(last)) {
          this.addresses.push({
            _key: newKey(),
            id: '',
            kind: 'billing',
            label: '',
            address: '',
            is_default: false,
          });
        }
      },
      add: function(kind) {
        // Default new rows to 'billing' when no explicit kind is supplied
        // (the header now has a single "+ Address" button; kind is then
        // toggled via the per-row pills).
        var k = kind || 'billing';
        this.addresses.push({
          _key: newKey(),
          id: '',
          kind: k,
          label: '',
          address: '',
          // New row claims default for every slot it covers that has no
          // existing defaulted row. 'both' rows check both slots.
          is_default: !this.hasDefaultForAnySlot(k),
        });
      },
      remove: function(i) {
        this.addresses.splice(i, 1);
        if (this.saveUrl) {
          this.ensureTrailingBlank();
          this.onEdit();
        }
      },
      setKindFlag: function(i, flag, on) {
        // Toggle one of the two kind pills (Billing / Physical).
        // The stored kind field is the combined state: neither active is
        // treated as falling back to billing (a row has to be one or
        // the other — address rows without a designated use arent
        // meaningful).
        var row = this.addresses[i];
        if (!row) return;
        var bill = row.kind === 'billing' || row.kind === 'both';
        var phys = row.kind === 'physical' || row.kind === 'both';
        if (flag === 'billing') bill = !!on;
        if (flag === 'physical') phys = !!on;
        if (bill && phys) row.kind = 'both';
        else if (phys) row.kind = 'physical';
        else row.kind = 'billing'; // fallback when user unchecks everything
        this.onEdit();
      },
      hasDefaultForAnySlot: function(kind) {
        // Does any existing row already claim the default flag for one
        // of the slots this new kind would occupy?
        var slots = kind === 'both' ? ['billing', 'physical']
                  : kind === 'physical' ? ['physical']
                  : ['billing'];
        return this.addresses.some(function(a) {
          if (!a.is_default) return false;
          return slots.some(function(s) {
            return a.kind === s || a.kind === 'both';
          });
        });
      },
      enforceDefault: function(i) {
        // Only one default per slot. A 'both' row claims both slots,
        // so flipping its default on must clear any competing default
        // in either slot.
        var row = this.addresses[i];
        if (!row.is_default) return;
        var slotsClaimed = row.kind === 'both' ? ['billing', 'physical']
                         : [row.kind];
        this.addresses.forEach(function(a, j) {
          if (j === i) return;
          if (!a.is_default) return;
          var aSlots = a.kind === 'both' ? ['billing', 'physical']
                     : [a.kind];
          var overlap = aSlots.some(function(s) { return slotsClaimed.indexOf(s) !== -1; });
          if (overlap) a.is_default = false;
        });
      },
      serialize: function() {
        // Strip client-only fields and blank rows before shipping to server.
        var rows = this.addresses
          .filter(function(a) { return (a.address || '').trim() !== ''; })
          .map(function(a) {
            return {
              id: a.id || '',
              kind: a.kind,
              label: a.label || '',
              address: a.address,
              is_default: !!a.is_default,
            };
          });
        return JSON.stringify(rows);
      },
      onEdit: function() {
        if (!this.saveUrl) return;
        if (this._saveTimer) clearTimeout(this._saveTimer);
        this.statusText = 'Editing…';
        this.statusClass = 'muted';
        var self = this;
        this._saveTimer = setTimeout(function() { self.save(); }, 700);
        this.ensureTrailingBlank();
      },
      save: function() {
        var self = this;
        if (this._saveInFlight) { this._saveQueued = true; return; }
        this._saveInFlight = true;
        this.statusText = 'Saving…';
        this.statusClass = 'muted';
        var body = new URLSearchParams();
        body.set('addresses_json', this.serialize());
        fetch(this.saveUrl, {
          method: 'POST',
          headers: { 'accept': 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
          credentials: 'same-origin',
        })
        .then(function(r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        })
        .then(function(j) {
          // Merge server-assigned ids back onto client rows. For rows
          // that already have an id we match by id; for freshly-inserted
          // rows we fall back to matching by address text. Also pull
          // is_default back because the server auto-promotes a default
          // per slot when none is set.
          if (j && Array.isArray(j.addresses)) {
            var saved = j.addresses.slice();
            self.addresses.forEach(function(row) {
              if (row.id) {
                var byId = saved.find(function(s) { return s.id === row.id && !s._claimed; });
                if (byId) {
                  row.is_default = !!byId.is_default;
                  byId._claimed = true;
                }
                return;
              }
              var txt = (row.address || '').trim();
              if (!txt) return;
              var match = saved.findIndex(function(s) {
                return (s.address || '').trim() === txt && !s._claimed;
              });
              if (match >= 0) {
                row.id = saved[match].id;
                row.is_default = !!saved[match].is_default;
                saved[match]._claimed = true;
              }
            });
          }
          self.statusText = 'Saved';
          self.statusClass = 'ok';
          self.ensureTrailingBlank();
        })
        .catch(function(err) {
          self.statusText = 'Save failed';
          self.statusClass = 'error';
          try { console.error('address save failed', err); } catch(e) {}
        })
        .then(function() {
          self._saveInFlight = false;
          if (self._saveQueued) {
            self._saveQueued = false;
            self.save();
          }
        });
      },
    };
  }
  // Make it available at window scope so the x-data attribute can see it
  // when Alpine does its initial pass.
  window.pipelineAddressEditor = pipelineAddressEditor;
  document.addEventListener('alpine:init', function() {
    if (window.Alpine && window.Alpine.data) {
      window.Alpine.data('pipelineAddressEditor', pipelineAddressEditor);
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
    let kind = 'billing';
    if (entry.kind === 'physical') kind = 'physical';
    else if (entry.kind === 'both') kind = 'both';
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
  // Enforce one default per denormalized kind. 'both' rows compete
  // with billing rows AND with physical rows — so if a billing row
  // and a 'both' row both claim is_default, the first one wins for
  // the billing slot and the 'both' row also contends for the
  // physical slot. We track the two slots independently.
  const seenDefault = { billing: false, physical: false };
  for (const row of out) {
    if (!row.is_default) continue;
    const bSlot = row.kind === 'billing' || row.kind === 'both';
    const pSlot = row.kind === 'physical' || row.kind === 'both';
    if (bSlot && seenDefault.billing) row.is_default = false;
    else if (pSlot && seenDefault.physical) row.is_default = false;
    if (row.is_default) {
      if (bSlot) seenDefault.billing = true;
      if (pSlot) seenDefault.physical = true;
    }
  }
  // Promote-first: ensure each slot has a default if any candidate exists.
  if (!seenDefault.billing) {
    const first = out.find((r) => r.kind === 'billing' || r.kind === 'both');
    if (first) first.is_default = true;
  }
  if (!seenDefault.physical) {
    const first = out.find((r) => r.kind === 'physical' || r.kind === 'both');
    // Avoid double-promoting a row we just marked default above.
    if (first && !first.is_default) first.is_default = true;
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
  // 'both' rows appear under each section; the 'both' marker lets viewers
  // see the row is pulling double-duty in either grouping.
  const billing = addresses.filter((a) => a.kind === 'billing' || a.kind === 'both');
  const physical = addresses.filter((a) => a.kind === 'physical' || a.kind === 'both');
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
