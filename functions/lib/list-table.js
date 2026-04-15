// functions/lib/list-table.js
//
// Shared list-table controller. Provides a reusable client-side script
// that adds sorting, per-column filtering, quick search, column toggle,
// column reordering, and localStorage persistence to any server-rendered
// HTML table that follows the conventions below.
//
// HTML conventions:
//   Container: <div class="opp-list" data-columns='[...]'>
//   Header:    <tr data-role="header-row"> with <th data-col="KEY">
//   Filter:    <tr data-role="filter-row"> with filter inputs
//   Body:      <tbody data-role="rows"> with <tr data-row-id="ID" data-KEY="VALUE">
//   Cells:     <td data-col="KEY">
//   Toolbar:   data-role="quicksearch", data-role="count", data-role="columns-menu"
//
// Usage:
//   import { listScript, listTableHead, listToolbar } from '../lib/list-table.js';
//   // ... render HTML following conventions ...
//   ${listToolbar({ id: 'quotes', count: rows.length, columns })}
//   html`<script>${raw(listScript('pms.quotes.v1'))}</script>`
//
// Pass `columns` to listToolbar() to get a working hamburger-icon
// dropdown with per-column show/hide checkboxes, up/down reorder
// buttons, and a Reset button. The dropdown panel lives inside the
// toolbar <details> element so the CSS `.opp-list-columns[open]
// .opp-list-columns-menu` rule shows it on click. The client script
// queries these elements via document.querySelector because they
// live in the toolbar (a sibling of .opp-list), not inside it.

import { html, escape } from './layout.js';

/* ------------------------------------------------------------------ */
/*  Server-side HTML helpers                                          */
/* ------------------------------------------------------------------ */

/**
 * Standard toolbar: quicksearch + count + optional columns-menu + optional new button.
 *
 *   listToolbar({ id: 'quotes', count: rows.length, columns, newHref: '/quotes/new' })
 *
 * When `columns` (array of column defs) is provided, a hamburger icon
 * is rendered; clicking it opens a dropdown with show/hide checkboxes
 * and up/down reorder buttons for each column. Pass `null`/omit to
 * suppress the columns menu entirely.
 */
export function listToolbar({ id, count, columns = null, newHref, newLabel = 'New' } = {}) {
  const showMenu = Array.isArray(columns) && columns.length > 0;
  return html`
    <div class="toolbar-right">
      <div class="search-expand">
        <label class="search-icon" for="${id}-quicksearch">
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="8.5" cy="8.5" r="5.5"/><line x1="13" y1="13" x2="18" y2="18"/></svg>
        </label>
        <input type="search" id="${id}-quicksearch" data-role="quicksearch" placeholder="Search...">
      </div>
      <span class="muted" data-role="count" style="font-size:0.8em;white-space:nowrap">${count}</span>
      ${showMenu ? html`
        <details class="opp-list-columns" data-role="columns-menu" style="display:inline-block">
          <summary class="icon-btn" title="Columns">
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="4" x2="17" y2="4"/><line x1="3" y1="10" x2="17" y2="10"/><line x1="3" y1="16" x2="17" y2="16"/></svg>
          </summary>
          <div class="opp-list-columns-menu" data-role="columns-list">
            ${columns.map((c, idx) => html`
              <div class="opp-list-column-row" data-column-row="${c.key}">
                <label class="checkbox">
                  <input type="checkbox" data-column-toggle="${c.key}"
                         ${c.default !== false ? 'checked' : ''}>
                  <span>${c.label}</span>
                </label>
                <div class="opp-list-column-move">
                  <button type="button" class="btn btn-xs"
                          data-column-move="up" data-key="${c.key}"
                          ${idx === 0 ? 'disabled' : ''}>&#8593;</button>
                  <button type="button" class="btn btn-xs"
                          data-column-move="down" data-key="${c.key}"
                          ${idx === columns.length - 1 ? 'disabled' : ''}>&#8595;</button>
                </div>
              </div>`)}
            <div class="opp-list-columns-actions">
              <button type="button" class="btn btn-xs" data-role="reset">Reset</button>
            </div>
          </div>
        </details>
      ` : ''}
      ${newHref ? html`
        <a class="icon-btn primary" href="${escape(newHref)}" title="${escape(newLabel)}">
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="10" y1="4" x2="10" y2="16"/><line x1="4" y1="10" x2="16" y2="10"/></svg>
        </a>
      ` : ''}
    </div>`;
}

/**
 * Render a filter cell (<th>) for a column based on its filter type.
 */
function filterCell(col, rowData) {
  if (col.filter === 'text') {
    return html`<th class="col-${col.key}" data-col="${col.key}"><input type="text" data-filter="${col.key}" data-filter-type="text" placeholder="Filter\u2026"></th>`;
  }
  if (col.filter === 'select') {
    const vals = Array.from(
      new Set(rowData.map(r => r[col.key]).filter(v => v != null && v !== ''))
    ).sort();
    return html`<th class="col-${col.key}" data-col="${col.key}"><select data-filter="${col.key}" data-filter-type="select"><option value="">All</option>${vals.map(v => html`<option value="${escape(v)}">${v}</option>`)}</select></th>`;
  }
  if (col.filter === 'range') {
    return html`<th class="col-${col.key}" data-col="${col.key}"><div class="filter-range"><input type="number" data-filter="${col.key}" data-filter-type="min" placeholder="min"><input type="number" data-filter="${col.key}" data-filter-type="max" placeholder="max"></div></th>`;
  }
  return html`<th class="col-${col.key}" data-col="${col.key}"></th>`;
}

/**
 * Render the <thead> with a sortable header row and a filter row.
 *
 *   listTableHead(columns, rowData)
 */
export function listTableHead(columns, rowData) {
  return html`
    <thead>
      <tr data-role="header-row">
        ${columns.map(c => html`
          <th class="col-${c.key}" data-col="${c.key}">
            <button type="button" class="col-sort" data-sort="${c.key}" data-sort-type="${c.sort}">
              <span>${c.label}</span>
              <span class="sort-indicator" data-role="sort-indicator"></span>
            </button>
          </th>`)}
      </tr>
      <tr class="opp-list-filter-row filters-hidden" data-role="filter-row">
        ${columns.map(c => filterCell(c, rowData))}
      </tr>
    </thead>`;
}

/**
 * Build a data-attribute string for a <tr> from column defs + row object.
 *
 *   html`<tr data-row-id="${r.id}" ${raw(rowDataAttrs(columns, r))}>`
 */
export function rowDataAttrs(columns, row) {
  return columns.map(c => `data-${c.key}="${String(row[c.key] ?? '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;')}"`).join(' ');
}

/* ------------------------------------------------------------------ */
/*  Client-side script (plain string, injected via raw())             */
/* ------------------------------------------------------------------ */

/**
 * Generic client-side table controller. Reads column definitions from
 * the host element's `data-columns` attribute and persists user prefs
 * to localStorage under the given key.
 *
 * Features:
 *   - Per-column sort (click sort indicator) — text / number / date
 *   - Per-column filter (click column label) — text / select / range
 *   - Quick-search across visible columns
 *   - Column visibility toggle + reorder (when columns menu exists)
 *   - localStorage persistence
 *
 * @param {string} storageKey   e.g. 'pms.quotes.v1'
 * @param {string} defaultSortKey  column key to sort by initially (default 'updated')
 * @param {string} defaultSortDir  'asc' or 'desc' (default 'desc')
 */
export function listScript(storageKey, defaultSortKey = 'updated', defaultSortDir = 'desc') {
  return `
(function() {
  try {
    var STORAGE_KEY = '${storageKey}';
    var host = document.querySelector('.opp-list');
    if (!host) return;

    var columns = [];
    try { columns = JSON.parse(host.dataset.columns || '[]'); } catch (e) {}
    if (!columns.length) return;

    var tbody = host.querySelector('[data-role="rows"]');
    if (!tbody) return;
    var allRows = Array.prototype.slice.call(tbody.querySelectorAll('tr[data-row-id]'));
    var totalRows = allRows.length;
    var countEl = document.querySelector('[data-role="count"]');
    var quickSearchInput = document.querySelector('[data-role="quicksearch"]');
    // Columns-menu elements live in the toolbar (a sibling of .opp-list),
    // not inside it, so queries go through document instead of host.
    var menuScope = host.closest('.card') || document;

    // -- State -----------------------------------------------------------

    var state = {
      order: columns.map(function(c) { return c.key; }),
      visible: {},
      widths: {},
      sort: { key: '${defaultSortKey}', dir: '${defaultSortDir}' },
    };
    columns.forEach(function(c) { state.visible[c.key] = c.default !== false; });

    // Merge saved state.
    try {
      var saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (saved) {
        if (Array.isArray(saved.order)) {
          var known = {};
          columns.forEach(function(c) { known[c.key] = true; });
          var newOrder = [];
          saved.order.forEach(function(k) { if (known[k]) newOrder.push(k); });
          columns.forEach(function(c) { if (newOrder.indexOf(c.key) === -1) newOrder.push(c.key); });
          state.order = newOrder;
        }
        if (saved.visible && typeof saved.visible === 'object') {
          columns.forEach(function(c) {
            if (saved.visible[c.key] !== undefined) state.visible[c.key] = !!saved.visible[c.key];
          });
        }
        if (saved.widths && typeof saved.widths === 'object') {
          columns.forEach(function(c) {
            var w = Number(saved.widths[c.key]);
            if (w > 0) state.widths[c.key] = w;
          });
        }
        if (saved.sort && saved.sort.key) state.sort = saved.sort;
      }
    } catch (e) {}

    function save() {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
    }

    function columnMeta(key) {
      for (var i = 0; i < columns.length; i++) {
        if (columns[i].key === key) return columns[i];
      }
      return null;
    }

    // -- Column visibility + reordering ----------------------------------

    function applyColumnVisibility() {
      columns.forEach(function(c) {
        var hide = !state.visible[c.key];
        host.querySelectorAll('[data-col="' + c.key + '"]').forEach(function(el) {
          el.style.display = hide ? 'none' : '';
        });
      });
    }

    function applyColumnOrder() {
      var parents = [
        host.querySelector('[data-role="header-row"]'),
        host.querySelector('[data-role="filter-row"]'),
      ].concat(allRows);
      parents.forEach(function(parent) {
        if (!parent) return;
        state.order.forEach(function(key) {
          var cell = parent.querySelector('[data-col="' + key + '"]');
          if (cell) parent.appendChild(cell);
        });
      });

      var menu = menuScope.querySelector('[data-role="columns-list"]');
      if (menu) {
        state.order.forEach(function(key) {
          var row = menu.querySelector('[data-column-row="' + key + '"]');
          if (row) menu.insertBefore(row, menu.querySelector('.opp-list-columns-actions'));
        });
        state.order.forEach(function(key, idx) {
          var up = menu.querySelector('[data-column-move="up"][data-key="' + key + '"]');
          var down = menu.querySelector('[data-column-move="down"][data-key="' + key + '"]');
          if (up) up.disabled = idx === 0;
          if (down) down.disabled = idx === state.order.length - 1;
        });
      }
    }

    function moveColumn(key, delta) {
      var idx = state.order.indexOf(key);
      if (idx < 0) return;
      var j = idx + delta;
      if (j < 0 || j >= state.order.length) return;
      state.order.splice(idx, 1);
      state.order.splice(j, 0, key);
      applyColumnOrder();
      save();
    }

    // -- Column resizing -------------------------------------------------
    //
    // Drag the right edge of any header cell to resize its column. On
    // first load we measure the browser-computed natural widths, create
    // a <colgroup> if none exists, lock the table into table-layout:
    // fixed, and apply saved/natural widths. Widths persist in
    // state.widths (localStorage). Double-click a grip to reset to
    // the originally-measured natural width.

    var naturalWidths = {};

    function ensureColgroup() {
      var table = host.querySelector('.opp-list-table');
      if (!table) return null;
      var colgroup = table.querySelector('colgroup');
      if (!colgroup) {
        colgroup = document.createElement('colgroup');
        var thead = table.querySelector('thead');
        table.insertBefore(colgroup, thead || table.firstChild);
        state.order.forEach(function(key) {
          var col = document.createElement('col');
          col.dataset.col = key;
          colgroup.appendChild(col);
        });
      } else {
        // Ensure every column in state.order has a <col>. Pages that
        // declared their own <colgroup> may be missing data-col attrs
        // on some entries; add them where needed, creating cols for
        // unknown keys at the end so visibility toggling works.
        var byKey = {};
        colgroup.querySelectorAll('col').forEach(function(col) {
          if (col.dataset.col) byKey[col.dataset.col] = col;
        });
        state.order.forEach(function(key) {
          if (!byKey[key]) {
            var col = document.createElement('col');
            col.dataset.col = key;
            colgroup.appendChild(col);
          }
        });
      }
      return colgroup;
    }

    function initColumnResize() {
      var table = host.querySelector('.opp-list-table');
      if (!table) return;

      // Measure natural widths BEFORE switching layout mode or hiding
      // columns. Every column is still visible at this point.
      columns.forEach(function(c) {
        var th = host.querySelector('tr[data-role="header-row"] th[data-col="' + c.key + '"]');
        if (th && th.offsetWidth > 0) naturalWidths[c.key] = th.offsetWidth;
      });

      var colgroup = ensureColgroup();
      if (!colgroup) return;

      // Switch to fixed layout so explicit col widths are honored.
      table.style.tableLayout = 'fixed';

      // Apply widths: saved > natural > 100px (with a 40px floor).
      columns.forEach(function(c) {
        var col = colgroup.querySelector('col[data-col="' + c.key + '"]');
        if (!col) return;
        var w = state.widths[c.key] || naturalWidths[c.key] || 100;
        if (w < 40) w = 40;
        col.style.width = w + 'px';
      });

      // Add a resize grip to each header cell. Grips float over the
      // right 6px of each th and intercept mouse events before the
      // sort button underneath.
      host.querySelectorAll('tr[data-role="header-row"] th[data-col]').forEach(function(th) {
        if (th.querySelector('.col-resize-grip')) return;
        var key = th.dataset.col;
        var grip = document.createElement('div');
        grip.className = 'col-resize-grip';
        grip.dataset.col = key;
        grip.title = 'Drag to resize \u2014 double-click to reset';
        grip.addEventListener('mousedown', function(e) {
          e.preventDefault();
          e.stopPropagation();
          startResize(key, e.clientX, grip);
        });
        grip.addEventListener('click', function(e) { e.stopPropagation(); });
        grip.addEventListener('dblclick', function(e) {
          e.preventDefault();
          e.stopPropagation();
          resetColumnWidth(key);
        });
        th.appendChild(grip);
      });
    }

    function startResize(key, startX, grip) {
      var col = host.querySelector('.opp-list-table colgroup col[data-col="' + key + '"]');
      if (!col) return;
      var startWidth = col.offsetWidth || parseInt(col.style.width, 10) || 100;
      grip.classList.add('dragging');
      document.body.classList.add('col-resizing');

      function onMove(e) {
        var delta = e.clientX - startX;
        var newWidth = Math.max(40, startWidth + delta);
        col.style.width = newWidth + 'px';
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        grip.classList.remove('dragging');
        document.body.classList.remove('col-resizing');
        state.widths[key] = parseInt(col.style.width, 10);
        save();
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    }

    function resetColumnWidth(key) {
      var col = host.querySelector('.opp-list-table colgroup col[data-col="' + key + '"]');
      if (!col) return;
      var natural = naturalWidths[key];
      if (natural) col.style.width = natural + 'px';
      delete state.widths[key];
      save();
    }

    // -- Filtering + quick search ----------------------------------------

    function rowMatches(tr) {
      var data = tr.dataset;
      var qs = (quickSearchInput && quickSearchInput.value || '').trim().toLowerCase();
      if (qs) {
        var hit = false;
        for (var i = 0; i < columns.length; i++) {
          var c = columns[i];
          if (!state.visible[c.key]) continue;
          var v = data[c.key];
          if (v != null && String(v).toLowerCase().indexOf(qs) !== -1) { hit = true; break; }
        }
        if (!hit) return false;
      }
      for (var k = 0; k < columns.length; k++) {
        var col = columns[k];
        if (col.filter === 'text') {
          var input = host.querySelector('input[data-filter="' + col.key + '"][data-filter-type="text"]');
          if (!input) continue;
          var f = input.value.trim().toLowerCase();
          if (!f) continue;
          var v2 = data[col.key];
          if (v2 == null || String(v2).toLowerCase().indexOf(f) === -1) return false;
        } else if (col.filter === 'select') {
          var sel = host.querySelector('select[data-filter="' + col.key + '"]');
          if (!sel) continue;
          var sv = sel.value;
          if (!sv) continue;
          if (String(data[col.key] || '') !== String(sv)) return false;
        } else if (col.filter === 'range') {
          var minI = host.querySelector('input[data-filter="' + col.key + '"][data-filter-type="min"]');
          var maxI = host.querySelector('input[data-filter="' + col.key + '"][data-filter-type="max"]');
          var rv = data[col.key];
          if (minI && minI.value !== '' && (rv === '' || Number(rv) < Number(minI.value))) return false;
          if (maxI && maxI.value !== '' && (rv === '' || Number(rv) > Number(maxI.value))) return false;
        }
      }
      return true;
    }

    function applyFilters() {
      var shown = 0;
      allRows.forEach(function(tr) {
        var match = rowMatches(tr);
        tr.style.display = match ? '' : 'none';
        if (match) shown++;
      });
      if (countEl) countEl.textContent = 'Showing ' + shown + ' of ' + totalRows;
    }

    // -- Sorting ---------------------------------------------------------

    function applySort() {
      var key = state.sort.key;
      var dir = state.sort.dir === 'asc' ? 1 : -1;
      var meta = columnMeta(key);
      var type = meta ? meta.sort : 'text';
      var sorted = allRows.slice();
      sorted.sort(function(a, b) {
        var av = a.dataset[key];
        var bv = b.dataset[key];
        if (av == null || av === '') av = null;
        if (bv == null || bv === '') bv = null;
        if (av === null && bv === null) return 0;
        if (av === null) return 1;
        if (bv === null) return -1;
        if (type === 'number') return (Number(av) - Number(bv)) * dir;
        return String(av).localeCompare(String(bv)) * dir;
      });
      var frag = document.createDocumentFragment();
      sorted.forEach(function(tr) { frag.appendChild(tr); });
      tbody.appendChild(frag);
    }

    function updateSortIndicators() {
      host.querySelectorAll('[data-role="sort-indicator"]').forEach(function(el) {
        var btn = el.closest('[data-sort]');
        var isActive = btn && state.sort.key === btn.dataset.sort;
        el.textContent = isActive
          ? (state.sort.dir === 'asc' ? '\\u25B2' : '\\u25BC')
          : '\\u25B2';
        el.classList.toggle('active', !!isActive);
      });
    }

    function showFilterForColumn(key) {
      var filterRow = host.querySelector('[data-role="filter-row"]');
      if (!filterRow) return;
      filterRow.classList.remove('filters-hidden');
      var input = filterRow.querySelector('[data-filter="' + key + '"]');
      if (input) setTimeout(function() { input.focus(); }, 50);
    }

    // -- Wire events -----------------------------------------------------

    host.querySelectorAll('[data-sort]').forEach(function(btn) {
      var indicator = btn.querySelector('[data-role="sort-indicator"]');
      var labelSpan = btn.querySelector('span:not([data-role])');

      if (labelSpan) {
        labelSpan.style.cursor = 'pointer';
        labelSpan.addEventListener('click', function(e) {
          e.stopPropagation();
          showFilterForColumn(btn.dataset.sort);
        });
      }

      btn.addEventListener('click', function(e) {
        if (e.target === labelSpan || (labelSpan && labelSpan.contains(e.target))) return;
        var key = btn.dataset.sort;
        if (state.sort.key === key) {
          state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
        } else {
          state.sort = { key: key, dir: 'asc' };
        }
        updateSortIndicators();
        applySort();
        save();
      });
    });

    host.querySelectorAll('[data-filter]').forEach(function(input) {
      var ev = input.tagName === 'SELECT' ? 'change' : 'input';
      input.addEventListener(ev, applyFilters);
    });

    if (quickSearchInput) quickSearchInput.addEventListener('input', applyFilters);

    menuScope.querySelectorAll('[data-column-toggle]').forEach(function(cb) {
      var key = cb.dataset.columnToggle;
      cb.checked = !!state.visible[key];
      cb.addEventListener('change', function() {
        state.visible[key] = cb.checked;
        applyColumnVisibility();
        save();
      });
    });

    menuScope.querySelectorAll('[data-column-move]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var dir = btn.dataset.columnMove === 'up' ? -1 : 1;
        moveColumn(btn.dataset.key, dir);
      });
    });

    var resetBtn = menuScope.querySelector('[data-role="reset"]');
    if (resetBtn) {
      resetBtn.addEventListener('click', function() {
        try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
        location.reload();
      });
    }

    // -- Init ------------------------------------------------------------

    // Only reorder columns if the columns menu exists (some pages skip it).
    if (menuScope.querySelector('[data-role="columns-list"]')) {
      applyColumnOrder();
    }
    // Column resize must run BEFORE applyColumnVisibility so natural
    // widths can be measured from fully-rendered header cells.
    initColumnResize();
    applyColumnVisibility();
    updateSortIndicators();
    applySort();
    applyFilters();
  } catch (err) {
    console.error('list controller failed:', err);
  }
})();
`;
}
