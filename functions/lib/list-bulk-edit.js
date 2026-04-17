// functions/lib/list-bulk-edit.js
//
// Bulk-edit framework for list tables. Layered on top of list-table.js
// (sort/filter/columns) and list-inline-edit.js (per-row edit). Adds:
//
//   1. A toggle button in the toolbar (rendered by listToolbar({bulk:true}))
//      that, when on, reveals a checkbox column on every row + an
//      "action bar" above the table.
//   2. A per-row checkbox + a select-all checkbox in the header.
//   3. The action bar offers two operations across all selected rows:
//        - Set <column> to <value>: loops POST to the page's patchUrl
//          (same endpoint inline-edit uses).
//        - Delete selected: loops POST to the page's deleteUrl.
//
// Both operations issue one HTTP request per selected row (no special
// server endpoint needed — we reuse what already exists). After the
// loop completes the page reloads so the user sees the new state.
//
// Server side:
//   import { listBulkEditScript } from '../lib/list-bulk-edit.js';
//   ...
//   ${listToolbar({ id: 'acct', count, columns, bulk: true, ... })}
//   ...
//   <script>${raw(listBulkEditScript({
//     patchUrl: '/accounts/:id/patch',
//     deleteUrl: '/accounts/:id/delete',
//   }))}</script>
//
// The bulk-set column dropdown lists every column whose `filter` is
// 'select' (those have a finite set of valid values, which is the
// safest UX for "apply to many at once"). Other columns are still
// patchable per-row via inline edit.
//
// State note: bulk mode and selection are NOT persisted — they reset
// on page reload. This is intentional: bulk operations are short-
// duration, and reloading is the simplest way to pick up the server
// truth after a batch of changes.

export function listBulkEditScript({ patchUrl, deleteUrl } = {}) {
  if (!patchUrl && !deleteUrl) {
    throw new Error('listBulkEditScript: at least one of patchUrl / deleteUrl is required');
  }
  return `
(function() {
  try {
    var PATCH_URL_TEMPLATE = ${JSON.stringify(patchUrl || '')};
    var DELETE_URL_TEMPLATE = ${JSON.stringify(deleteUrl || '')};
    var HAS_PATCH = ${JSON.stringify(!!patchUrl)};
    var HAS_DELETE = ${JSON.stringify(!!deleteUrl)};

    var host = document.querySelector('.opp-list');
    if (!host) return;
    var thead = host.querySelector('[data-role="header-row"]');
    var tbody = host.querySelector('[data-role="rows"]');
    if (!thead || !tbody) return;
    var card = host.closest('.card') || host.parentNode;
    var toggle = card.querySelector('[data-role="bulk-edit-toggle"]');
    if (!toggle) return;

    var columns = [];
    try { columns = JSON.parse(host.dataset.columns || '[]'); } catch (e) {}

    // -- Inject checkbox column ----------------------------------------
    //
    // We add a real <th> + per-row <td> to the leftmost slot. The cells
    // carry data-col="__bulk__" so list-table.js's sort/filter/visibility
    // code (which only touches columns it knows about) leaves them alone.
    // They also carry data-col-bulk so CSS can hide/show the whole column
    // based on the .bulk-on class on the host.

    var headerCheckbox = injectHeaderCheckbox();
    injectRowCheckboxes();

    // -- Action bar ----------------------------------------------------

    var bar = createBar();

    // Populate the column dropdown with filter:'select' columns. These
    // have a finite set of valid values, which makes "apply to many"
    // safe (no free-text typos propagating across N rows).
    var settable = columns.filter(function(c) { return c.filter === 'select'; });
    var colSelect = bar.querySelector('[data-bulk-col]');
    if (colSelect) {
      settable.forEach(function(c) {
        var opt = document.createElement('option');
        opt.value = c.key;
        opt.textContent = c.label;
        colSelect.appendChild(opt);
      });
    }

    var valueSlot = bar.querySelector('[data-bulk-value]');
    var applyBtn  = bar.querySelector('[data-bulk-apply]');
    var deleteBtn = bar.querySelector('[data-bulk-delete]');
    var countEl   = bar.querySelector('[data-bulk-count]');

    if (colSelect) {
      colSelect.addEventListener('change', function() {
        renderValueInput(colSelect.value);
        updateButtons();
      });
    }

    // -- Wire selection -----------------------------------------------

    headerCheckbox.addEventListener('change', function() {
      tbody.querySelectorAll('tr[data-row-id]').forEach(function(tr) {
        if (tr.style.display === 'none') return;
        var cb = tr.querySelector('.bulk-row-select');
        if (cb) cb.checked = headerCheckbox.checked;
      });
      updateButtons();
    });

    tbody.addEventListener('change', function(e) {
      if (!e.target.classList.contains('bulk-row-select')) return;
      // If a row is unchecked, also uncheck the header (otherwise it
      // misleads the user into thinking everything is selected).
      if (!e.target.checked) headerCheckbox.checked = false;
      updateButtons();
    });

    // -- Toggle bulk mode ---------------------------------------------

    toggle.addEventListener('click', function() {
      setBulkMode(!host.classList.contains('bulk-on'));
    });

    function setBulkMode(on) {
      host.classList.toggle('bulk-on', on);
      bar.style.display = on ? '' : 'none';
      toggle.classList.toggle('active', on);
      toggle.setAttribute('aria-pressed', on ? 'true' : 'false');

      // Grow/shrink the bulk column so it doesn't permanently steal
      // 32px from the other columns. listScript locked the table
      // width at init from the original column sum; we bump that lock
      // by 32 on each toggle so the bulk checkbox has actual space to
      // render, and undo it on toggle-off. Without this the existing
      // columns get squeezed whenever bulk mode is on, and when it's
      // off the table is 32px too narrow (or too wide, depending on
      // timing of the sync).
      var bulkCol = host.querySelector('.opp-list-table col[data-col="__bulk__"]');
      var table = host.querySelector('.opp-list-table');
      if (bulkCol && table) {
        var targetColW = on ? 32 : 0;
        var prevColW = parseInt(bulkCol.style.width, 10) || 0;
        bulkCol.style.width = targetColW + 'px';
        // Only adjust locked table width if listScript actually set one.
        if (table.style.width) {
          var tableW = parseInt(table.style.width, 10) || 0;
          table.style.width = (tableW + (targetColW - prevColW)) + 'px';
        }
      }

      if (!on) {
        // Clear all selections when turning off so the next on-click
        // starts with a clean slate.
        headerCheckbox.checked = false;
        tbody.querySelectorAll('.bulk-row-select').forEach(function(cb) { cb.checked = false; });
        updateButtons();
      }
    }

    // -- Bulk delete --------------------------------------------------

    if (deleteBtn) deleteBtn.addEventListener('click', async function() {
      var ids = getSelectedIds();
      if (!ids.length) return;
      if (!confirm('Delete ' + ids.length + ' row' + (ids.length === 1 ? '' : 's') + '? This cannot be undone.')) return;

      busy(true, 'Deleting…');
      var failed = 0;
      var firstError = null;
      for (var i = 0; i < ids.length; i++) {
        var url = DELETE_URL_TEMPLATE.replace(/:id/g, encodeURIComponent(ids[i]));
        try {
          var res = await fetch(url, { method: 'POST', headers: { 'accept': 'application/json' } });
          // Delete handlers return JSON {ok, error?} when accept:json.
          // Fall back to res.ok for older endpoints that still redirect.
          var data = await res.json().catch(function() { return null; });
          var ok = data ? !!data.ok : res.ok;
          if (!ok) {
            failed++;
            if (!firstError && data && data.error) firstError = data.error;
          }
        } catch (e) { failed++; }
      }
      busy(false);
      if (failed > 0) {
        var msg = 'Deleted ' + (ids.length - failed) + ', failed ' + failed + '.';
        if (firstError) msg += '\\n\\nFirst error: ' + firstError;
        alert(msg);
      }
      location.reload();
    });

    // -- Bulk set -----------------------------------------------------

    if (applyBtn) applyBtn.addEventListener('click', async function() {
      var ids = getSelectedIds();
      var key = colSelect.value;
      var input = valueSlot.querySelector('[data-bulk-value-input]');
      var value = input ? input.value : '';
      if (!ids.length || !key) return;

      var col = settable.find(function(c) { return c.key === key; });
      var label = col ? col.label : key;
      var displayValue = value || '(empty)';
      if (!confirm('Set "' + label + '" to "' + displayValue + '" for ' + ids.length + ' row' + (ids.length === 1 ? '' : 's') + '?')) return;

      busy(true, 'Saving…');
      var failed = 0;
      for (var i = 0; i < ids.length; i++) {
        var url = PATCH_URL_TEMPLATE.replace(/:id/g, encodeURIComponent(ids[i]));
        try {
          var res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'accept': 'application/json' },
            body: JSON.stringify({ field: key, value: value }),
          });
          var data = await res.json().catch(function() { return null; });
          if (!res.ok || !data || !data.ok) failed++;
        } catch (e) { failed++; }
      }
      busy(false);
      if (failed > 0) alert('Updated ' + (ids.length - failed) + ', failed ' + failed + '.');
      location.reload();
    });

    // -- Helpers ------------------------------------------------------

    function injectHeaderCheckbox() {
      var th = document.createElement('th');
      th.className = 'col-bulk-select';
      th.dataset.col = '__bulk__';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'bulk-select-all';
      cb.title = 'Select all visible rows';
      th.appendChild(cb);
      thead.insertBefore(th, thead.firstChild);
      return cb;
    }

    function injectRowCheckboxes() {
      tbody.querySelectorAll('tr[data-row-id]').forEach(function(tr) {
        var td = document.createElement('td');
        td.className = 'col-bulk-select';
        td.dataset.col = '__bulk__';
        // Skip synthetic group-rollup rows (data-is-group="1") on the
        // accounts list — they aren't real accounts and have no
        // editable fields or delete URL. They still get a placeholder
        // td so column alignment stays consistent across the table.
        if (!tr.hasAttribute('data-is-group')) {
          var cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.className = 'bulk-row-select';
          td.appendChild(cb);
        }
        // Stop the row-level click delegation (inline-edit) from firing
        // when the user just wants to tick the checkbox.
        td.addEventListener('click', function(e) { e.stopPropagation(); });
        tr.insertBefore(td, tr.firstChild);
      });
      // Also inject a <col> at the front of any colgroup so
      // table-layout:fixed doesn't squish the checkbox when bulk mode
      // is on. Width stays at 0 while bulk is OFF — otherwise the
      // extra 32px would steal space from the existing columns
      // (listScript.syncTableWidth locked the table width before
      // bulk-edit ran, so anything we reserve here just shrinks the
      // real columns). setBulkMode handles the 0 \u2194 32 swap.
      var colgroup = host.querySelector('.opp-list-table colgroup');
      if (colgroup) {
        var col = document.createElement('col');
        col.dataset.col = '__bulk__';
        col.style.width = '0';
        colgroup.insertBefore(col, colgroup.firstChild);
      }
      // Bump any tfoot colspan attributes by 1 so summary rows still
      // span the full table width in bulk mode. Reverted on toggle off
      // by simply being inert when the bulk column collapses.
      host.querySelectorAll('tfoot [colspan]').forEach(function(el) {
        var n = parseInt(el.getAttribute('colspan'), 10);
        if (n > 0) {
          el.setAttribute('colspan', String(n + 1));
          el.dataset.bulkBumped = '1';
        }
      });
    }

    function createBar() {
      var b = document.createElement('div');
      b.className = 'bulk-edit-bar';
      b.style.display = 'none';
      b.innerHTML =
        '<span class="bulk-count" data-bulk-count>0 selected</span>' +
        (HAS_PATCH
          ? '<span class="bulk-set-group">' +
              '<span>Set</span>' +
              '<select data-bulk-col><option value="">column\u2026</option></select>' +
              '<span>to</span>' +
              '<span class="bulk-value-slot" data-bulk-value></span>' +
              '<button type="button" class="btn btn-sm" data-bulk-apply disabled>Apply</button>' +
            '</span>'
          : '') +
        (HAS_DELETE
          ? '<button type="button" class="btn btn-sm danger" data-bulk-delete disabled>Delete selected</button>'
          : '');
      // Insert ABOVE .opp-list inside its containing card so it lives
      // above the toolbar/table area without disturbing layout.
      host.parentNode.insertBefore(b, host);
      return b;
    }

    function renderValueInput(key) {
      if (!valueSlot) return;
      valueSlot.innerHTML = '';
      if (!key) return;
      var col = settable.find(function(c) { return c.key === key; });
      // Build option list from distinct rendered values for that column.
      var distinct = {};
      tbody.querySelectorAll('tr[data-row-id]').forEach(function(tr) {
        var v = tr.dataset[key];
        if (v != null) distinct[v] = true;
      });
      var values = Object.keys(distinct).sort(function(a, b) { return String(a).localeCompare(String(b)); });
      var sel = document.createElement('select');
      sel.dataset.bulkValueInput = '';
      var blank = document.createElement('option');
      blank.value = '';
      blank.textContent = '\u2014 value \u2014';
      sel.appendChild(blank);
      values.forEach(function(v) {
        var o = document.createElement('option');
        o.value = v;
        o.textContent = v;
        sel.appendChild(o);
      });
      sel.addEventListener('change', updateButtons);
      valueSlot.appendChild(sel);
    }

    function getSelectedIds() {
      var ids = [];
      tbody.querySelectorAll('.bulk-row-select:checked').forEach(function(cb) {
        var tr = cb.closest('tr[data-row-id]');
        if (tr) ids.push(tr.dataset.rowId);
      });
      return ids;
    }

    function updateButtons() {
      var n = getSelectedIds().length;
      if (countEl) countEl.textContent = n + ' selected';
      var hasCol = colSelect && !!colSelect.value;
      if (deleteBtn) deleteBtn.disabled = n === 0;
      if (applyBtn) applyBtn.disabled = n === 0 || !hasCol;
    }

    function busy(on, msg) {
      bar.classList.toggle('busy', !!on);
      [applyBtn, deleteBtn, colSelect, headerCheckbox, toggle].forEach(function(el) { if (el) el.disabled = !!on; });
      if (on && msg && countEl) countEl.textContent = msg;
    }

    // Init: hidden bar, mode off.
    setBulkMode(false);
  } catch (err) {
    console.error('list bulk-edit init failed:', err);
  }
})();
`;
}
