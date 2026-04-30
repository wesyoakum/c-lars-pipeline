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
//   Body:      <tbody data-role="rows"> with <tr data-row-id="ID" data-KEY="VALUE">
//   Cells:     <td data-col="KEY">
//   Toolbar:   data-role="quicksearch", data-role="count", data-role="columns-menu"
//
// Per-column filters are rendered client-side as a popover (not a
// persistent filter row) — see showPopoverForColumn in listScript.
//
// Usage:
//   import { listScript, listTableHead, listToolbar } from '../lib/list-table.js';
//   // ... render HTML following conventions ...
//   ${listToolbar({ id: 'quotes', count: rows.length, columns })}
//   html`<script>${raw(listScript('pipeline.quotes.v1'))}</script>`
//
// Pass `columns` to listToolbar() to get a working hamburger-icon
// dropdown with per-column show/hide checkboxes, up/down reorder
// buttons, and a Reset button. The dropdown panel lives inside the
// toolbar <details> element so the CSS `.opp-list-columns[open]
// .opp-list-columns-menu` rule shows it on click. The client script
// queries these elements via document.querySelector because they
// live in the toolbar (a sibling of .opp-list), not inside it.

import { html, escape, raw } from './layout.js';

/* ------------------------------------------------------------------ */
/*  Server-side HTML helpers                                          */
/* ------------------------------------------------------------------ */

/**
 * Standard "+" icon-button (the consistent "create" affordance used
 * everywhere — list-page toolbars, detail-page section headers, etc.).
 *
 *   iconAddButton({ onClick: "window.Pipeline.openWizard('contact', {})", label: 'New contact' })
 *   iconAddButton({ href: '/quotes/new', label: 'New quote' })
 *
 * Pass exactly one of `onClick` (renders <button>) or `href` (renders
 * <a>). The label populates `title` and `aria-label` only — the button
 * face is the icon. Pass `extraClass` to add classes alongside
 * `icon-btn primary`.
 */
export function iconAddButton({ onClick, href, label = 'New', extraClass = '' } = {}) {
  const cls = ['icon-btn', 'primary', extraClass].filter(Boolean).join(' ');
  const svg = '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="10" y1="4" x2="10" y2="16"/><line x1="4" y1="10" x2="16" y2="10"/></svg>';
  if (onClick) {
    return html`<button type="button" class="${cls}" onclick="${escape(onClick)}" title="${escape(label)}" aria-label="${escape(label)}">${raw(svg)}</button>`;
  }
  if (href) {
    return html`<a class="${cls}" href="${escape(href)}" title="${escape(label)}" aria-label="${escape(label)}">${raw(svg)}</a>`;
  }
  return '';
}

/**
 * Standard toolbar: quicksearch + count + optional columns-menu + optional new button.
 *
 *   listToolbar({ id: 'quotes', count: rows.length, columns, newHref: '/quotes/new' })
 *   listToolbar({ id: 'acct',   count, columns, newOnClick: "window.Pipeline.openWizard('account', {})", newLabel: 'New account' })
 *
 * Exactly one of `newHref` (renders an <a>) or `newOnClick` (renders a
 * <button> with the given onclick JS expression) should be provided to
 * get a "+ New" button. Pass neither to omit the button entirely.
 *
 * When `columns` (array of column defs) is provided, a hamburger icon
 * is rendered; clicking it opens a dropdown with show/hide checkboxes
 * and up/down reorder buttons for each column. Pass `null`/omit to
 * suppress the columns menu entirely.
 */
export function listToolbar({ id, count, columns = null, newHref, newOnClick, newLabel = 'New' } = {}) {
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
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="3" x2="4" y2="17"/><line x1="10" y1="3" x2="10" y2="17"/><line x1="16" y1="3" x2="16" y2="17"/></svg>
          </summary>
          <div class="opp-list-columns-menu" data-role="columns-list">
            ${columns.map(c => html`
              <div class="opp-list-column-row" data-column-row="${c.key}" draggable="true">
                <span class="opp-list-column-grip" title="Drag to reorder" aria-hidden="true">⋮⋮</span>
                <label class="checkbox">
                  <input type="checkbox" data-column-toggle="${c.key}"
                         ${c.default !== false ? 'checked' : ''}>
                  <span>${c.label}</span>
                </label>
              </div>`)}
            <div class="opp-list-columns-actions">
              <button type="button" class="btn btn-xs" data-role="reset">Reset</button>
            </div>
          </div>
        </details>
      ` : ''}
      ${iconAddButton({ onClick: newOnClick, href: newHref, label: newLabel })}
    </div>`;
}

/**
 * Render the <thead> with a sortable header row.
 *
 *   listTableHead(columns, rowData)
 *
 * The `rowData` argument is retained for backward-compatibility with
 * existing call sites but is no longer used — per-column filters are
 * now rendered client-side in a popover by listScript(), which computes
 * distinct values on the fly from the rendered row data attributes.
 */
export function listTableHead(columns /* , rowData */) {
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
 * @param {string} storageKey   e.g. 'pipeline.quotes.v1'
 * @param {string} defaultSortKey  column key to sort by initially (default 'updated')
 * @param {string} defaultSortDir  'asc' or 'desc' (default 'desc')
 * @param {object} defaultFilters  optional initial filterState, keyed by
 *                                 column key. Shape per type:
 *                                   text   -> { text: 'foo' }
 *                                   select -> { values: ['Draft','Issued'] }
 *                                   range  -> { min: '10', max: '99' }
 *                                 Used only if the user has no saved filter
 *                                 state for this storageKey; once the user
 *                                 touches any filter, the full filterState
 *                                 persists to localStorage alongside sort /
 *                                 column visibility / order / widths.
 */
export function listScript(storageKey, defaultSortKey = 'updated', defaultSortDir = 'desc', defaultFilters = {}) {
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

    // Populated from localStorage (or the site-wide fallback) inside the
    // merge block below; applied to filterState once it's declared
    // further down.
    var savedFilters = null;

    // Merge saved state. Prefer localStorage, but fall back to the
    // admin-blessed site defaults injected into window.Pipeline by the
    // layout boot script (see layout.js displayPrefsBootScript +
    // migration 0039). Site defaults are keyed by storageKey so each
    // list page can have its own admin-snapshotted starting state.
    try {
      var saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (!saved) {
        try {
          var siteDefaults = window.Pipeline && window.Pipeline.listTableSiteDefaults;
          if (siteDefaults && siteDefaults[STORAGE_KEY]) {
            saved = siteDefaults[STORAGE_KEY];
          }
        } catch (_) {}
      }
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
        if (saved.filters && typeof saved.filters === 'object') {
          savedFilters = saved.filters;
        }
      }
    } catch (e) {}

    function save() {
      try {
        var payload = {
          order: state.order,
          visible: state.visible,
          widths: state.widths,
          sort: state.sort,
          filters: filterState,
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      } catch (e) {}
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
      // Resync the pinned table width so hidden columns don't leave a
      // gap (and newly-shown ones don't spill past the pinned width).
      // Safe to call before initColumnResize runs the first time: if
      // there's no colgroup yet, syncTableWidth bails.
      syncTableWidth();
    }

    function applyColumnOrder() {
      // Reorder header <th>, colgroup <col>, and each tbody <tr>'s cells
      // to match state.order. Reordering the <col> elements is what
      // keeps column widths glued to columns (not positions) when the
      // user moves a column via the columns menu.
      var parents = [
        host.querySelector('[data-role="header-row"]'),
        host.querySelector('.opp-list-table colgroup'),
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

      // Lock the table width to the sum of visible col widths. Without
      // this, table-layout:fixed + width:100% causes the browser to
      // redistribute any freed space among other columns when one
      // column shrinks — so dragging a column narrower visually widens
      // its neighbors and the drag appears not to stick. By pinning
      // the table width to the exact sum, shrinking a column simply
      // leaves empty space on the right of the table.
      syncTableWidth();

      // Add a resize grip to each header cell. Grips float over the
      // right 6px of each th and intercept mouse events before the
      // sort button underneath.
      host.querySelectorAll('tr[data-role="header-row"] th[data-col]').forEach(function(th) {
        if (th.querySelector('.col-resize-grip')) return;
        var key = th.dataset.col;
        var grip = document.createElement('div');
        grip.className = 'col-resize-grip';
        grip.dataset.col = key;
        grip.title = 'Drag to resize \u2014 double-click to autofit';
        grip.addEventListener('mousedown', function(e) {
          e.preventDefault();
          e.stopPropagation();
          startResize(key, e.clientX, grip);
        });
        grip.addEventListener('click', function(e) { e.stopPropagation(); });
        grip.addEventListener('dblclick', function(e) {
          e.preventDefault();
          e.stopPropagation();
          autofitColumn(key);
        });
        th.appendChild(grip);
      });
    }

    // Sum the explicit widths of all currently-visible <col> elements
    // and pin the table width to that total. Called on init, after any
    // resize/autofit, and after visibility changes.
    function syncTableWidth() {
      var table = host.querySelector('.opp-list-table');
      if (!table) return;
      var colgroup = table.querySelector('colgroup');
      if (!colgroup) return;
      var total = 0;
      colgroup.querySelectorAll('col').forEach(function(col) {
        if (col.style.display === 'none') return;
        var wpx = parseInt(col.style.width, 10);
        if (wpx > 0) total += wpx;
      });
      if (total > 0) table.style.width = total + 'px';
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
        syncTableWidth();
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

    // Excel-style AutoFit: measure the widest currently-visible cell in
    // the column and shrink/grow the column to match. We briefly switch
    // the table back to table-layout:auto with this column unconstrained,
    // read the browser-computed offsetWidth of the header cell and every
    // visible <td>, take the max, then restore table-layout:fixed and
    // lock the column to that width. Other columns are not touched
    // because their <col> elements still carry explicit widths, which
    // auto layout respects as hints.
    function autofitColumn(key) {
      var table = host.querySelector('.opp-list-table');
      var col = table && table.querySelector('colgroup col[data-col="' + key + '"]');
      if (!table || !col) return;

      var prevColWidth = col.style.width;
      var prevLayout = table.style.tableLayout;
      var prevTableWidth = table.style.width;

      col.style.width = 'auto';
      table.style.tableLayout = 'auto';
      // Let the table size to its content while we measure — a locked
      // table width would squish the unconstrained column.
      table.style.width = '';

      var max = 0;
      var th = host.querySelector('tr[data-role="header-row"] th[data-col="' + key + '"]');
      if (th && th.offsetWidth > max) max = th.offsetWidth;
      tbody.querySelectorAll('tr[data-row-id] td[data-col="' + key + '"]').forEach(function(td) {
        // offsetParent === null means hidden (display:none row or cell).
        if (td.offsetParent !== null && td.offsetWidth > max) max = td.offsetWidth;
      });

      // Restore layout before committing the new width so we don't leave
      // the table in auto layout if the measurement returned nothing.
      table.style.tableLayout = 'fixed';
      if (max <= 0) {
        col.style.width = prevColWidth || (naturalWidths[key] ? naturalWidths[key] + 'px' : '100px');
        table.style.width = prevTableWidth;
        return;
      }
      // Add a tiny fudge so the browser doesn't round-trip us into
      // ellipsis truncation on the very next paint.
      var newWidth = Math.max(40, Math.round(max) + 2);
      col.style.width = newWidth + 'px';
      state.widths[key] = newWidth;
      syncTableWidth();
      save();
    }

    // -- Filtering + quick search ----------------------------------------
    //
    // Per-column filter state lives in this in-memory object. The UI
    // for editing it is a popover (see showPopoverForColumn below), not
    // a persistent filter row. Shape per column key:
    //   text  -> { text: 'foo' }
    //   select-> { values: ['a','b'] }   (empty array = no filter)
    //   range -> { min: '5', max: '100' } (strings from <input type=number>)
    //
    // Seeded from defaultFilters passed at listScript() construction time,
    // then overlaid with whatever the user last saved to localStorage for
    // this storageKey (see savedFilters up top). Any filter mutation via
    // the popover persists the full filterState back via save().
    var filterState = ${JSON.stringify(defaultFilters)};
    if (savedFilters) {
      Object.keys(savedFilters).forEach(function(k) {
        filterState[k] = savedFilters[k];
      });
    }

    function isFilterActive(key) {
      var fs = filterState[key];
      if (!fs) return false;
      if (fs.text) return true;
      if (fs.values && fs.values.length > 0) return true;
      if ((fs.min != null && fs.min !== '') || (fs.max != null && fs.max !== '')) return true;
      return false;
    }

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
        var fs = filterState[col.key];
        if (!fs) continue;
        if (col.filter === 'text') {
          if (fs.text) {
            var needle = String(fs.text).trim().toLowerCase();
            if (needle) {
              var v2 = data[col.key];
              if (v2 == null || String(v2).toLowerCase().indexOf(needle) === -1) return false;
            }
          }
        } else if (col.filter === 'select') {
          if (fs.values && fs.values.length > 0) {
            if (fs.values.indexOf(String(data[col.key] || '')) === -1) return false;
          }
        } else if (col.filter === 'range') {
          var rv = data[col.key];
          if (fs.min != null && fs.min !== '' && (rv === '' || Number(rv) < Number(fs.min))) return false;
          if (fs.max != null && fs.max !== '' && (rv === '' || Number(rv) > Number(fs.max))) return false;
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
      updateFilterIndicators();
    }

    function updateFilterIndicators() {
      columns.forEach(function(c) {
        var th = host.querySelector('tr[data-role="header-row"] th[data-col="' + c.key + '"]');
        if (!th) return;
        th.classList.toggle('col-filter-active', isFilterActive(c.key));
      });
    }

    function distinctValuesForColumn(key) {
      var set = {};
      allRows.forEach(function(tr) {
        var v = tr.dataset[key];
        if (v != null && v !== '') set[v] = true;
      });
      var arr = Object.keys(set);
      arr.sort(function(a, b) { return String(a).localeCompare(String(b)); });
      return arr;
    }

    // -- Filter popover --------------------------------------------------
    //
    // Single shared popover element attached to <body>. Only one column's
    // filter UI is shown at a time. Mouseleave from either the anchor
    // <th> or the popover itself schedules a 250ms hide; mouseenter on
    // either cancels the hide, so moving the cursor between the header
    // and the popover doesn't dismiss it.

    var popover = null;
    var popContent = null;
    var currentPopoverKey = null;
    var currentAnchor = null;
    var hideTimer = null;

    function escHtml(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function ensurePopover() {
      if (popover) return popover;
      popover = document.createElement('div');
      popover.className = 'col-filter-popover';
      popover.style.display = 'none';
      popContent = document.createElement('div');
      popover.appendChild(popContent);
      document.body.appendChild(popover);
      popover.addEventListener('mouseenter', cancelHide);
      popover.addEventListener('mouseleave', scheduleHide);
      // Stop clicks inside the popover from bubbling to document listeners
      // (e.g. details toggles, outside-click handlers).
      popover.addEventListener('mousedown', function(e) { e.stopPropagation(); });
      popover.addEventListener('click',     function(e) { e.stopPropagation(); });
      return popover;
    }

    function scheduleHide() {
      cancelHide();
      hideTimer = setTimeout(hidePopover, 250);
    }
    function cancelHide() {
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    }
    function hidePopover() {
      if (!popover) return;
      popover.style.display = 'none';
      if (currentAnchor) {
        currentAnchor.removeEventListener('mouseleave', scheduleHide);
        currentAnchor.removeEventListener('mouseenter', cancelHide);
        currentAnchor = null;
      }
      currentPopoverKey = null;
    }

    function showPopoverForColumn(key) {
      var col = columnMeta(key);
      if (!col || !col.filter) return;
      var th = host.querySelector('tr[data-role="header-row"] th[data-col="' + key + '"]');
      if (!th) return;
      ensurePopover();
      cancelHide();

      // Re-clicking the already-open column just re-focuses.
      if (currentPopoverKey === key && popover.style.display !== 'none') {
        var inp = popContent.querySelector('input, select, textarea');
        if (inp) inp.focus();
        return;
      }

      // Detach from previous anchor, if any.
      if (currentAnchor) {
        currentAnchor.removeEventListener('mouseleave', scheduleHide);
        currentAnchor.removeEventListener('mouseenter', cancelHide);
      }

      popContent.innerHTML = buildPopoverContent(col);
      popover.style.display = '';

      // Position the popover below the th, left-aligned. Clamp to
      // viewport so it doesn't spill off the right edge.
      var rect = th.getBoundingClientRect();
      var top = rect.bottom + window.scrollY + 2;
      var left = rect.left + window.scrollX;
      popover.style.left = '0px';
      popover.style.top = top + 'px';
      // Measure actual popover width after content is rendered, then
      // clamp horizontally.
      var popWidth = popover.offsetWidth;
      var viewportRight = window.scrollX + document.documentElement.clientWidth;
      if (left + popWidth > viewportRight - 8) {
        left = Math.max(8, viewportRight - popWidth - 8);
      }
      popover.style.left = left + 'px';

      currentPopoverKey = key;
      currentAnchor = th;
      th.addEventListener('mouseleave', scheduleHide);
      th.addEventListener('mouseenter', cancelHide);

      wirePopoverInputs(col);

      // Focus the first input for keyboard users.
      var firstInput = popContent.querySelector('input, select, textarea');
      if (firstInput && firstInput.type !== 'checkbox') {
        setTimeout(function() { firstInput.focus(); }, 0);
      }
    }

    function buildPopoverContent(col) {
      var fs = filterState[col.key] || {};
      var out = '<div class="col-filter-title">' + escHtml(col.label) + '</div>';
      if (col.filter === 'text') {
        var cur = fs.text || '';
        out += '<input type="text" class="col-filter-text" placeholder="Contains\u2026" value="' + escHtml(cur) + '">';
      } else if (col.filter === 'select') {
        var vals = distinctValuesForColumn(col.key);
        var selected = fs.values || [];
        var selSet = {};
        selected.forEach(function(v) { selSet[v] = true; });
        // Optional per-column quick-filter presets — row of small
        // buttons that apply a named subset (e.g. "Active" = draft,
        // issued, expired on the quotes status column).
        if (col.quickFilters && col.quickFilters.length) {
          out += '<div class="col-filter-quick">';
          col.quickFilters.forEach(function(qf, i) {
            out += '<button type="button" data-quick-idx="' + i + '">' +
                   escHtml(qf.label) + '</button>';
          });
          out += '</div>';
        }
        out += '<div class="col-filter-actions">' +
               '<button type="button" data-action="all">Select all</button>' +
               '<button type="button" data-action="none">Clear</button>' +
               '</div>';
        out += '<div class="col-filter-list">';
        if (vals.length === 0) {
          out += '<div class="muted" style="padding:0.3rem 0.25rem">No values</div>';
        } else {
          vals.forEach(function(v) {
            var checked = selSet[v] ? ' checked' : '';
            out += '<label class="col-filter-item">' +
                   '<input type="checkbox" value="' + escHtml(v) + '"' + checked + '>' +
                   '<span>' + escHtml(v) + '</span>' +
                   '</label>';
          });
        }
        out += '</div>';
      } else if (col.filter === 'range') {
        out += '<div class="col-filter-range">' +
               '<input type="number" class="col-filter-min" placeholder="min" value="' + escHtml(fs.min != null ? fs.min : '') + '">' +
               '<input type="number" class="col-filter-max" placeholder="max" value="' + escHtml(fs.max != null ? fs.max : '') + '">' +
               '</div>';
      }
      return out;
    }

    function wirePopoverInputs(col) {
      var key = col.key;
      if (col.filter === 'text') {
        var textInput = popContent.querySelector('.col-filter-text');
        if (textInput) {
          textInput.addEventListener('input', function() {
            filterState[key] = { text: textInput.value };
            applyFilters();
            save();
          });
        }
      } else if (col.filter === 'select') {
        var checkboxes = Array.prototype.slice.call(
          popContent.querySelectorAll('.col-filter-list input[type="checkbox"]')
        );
        function readSelected() {
          var arr = [];
          checkboxes.forEach(function(cb) { if (cb.checked) arr.push(cb.value); });
          filterState[key] = { values: arr };
          applyFilters();
          save();
        }
        checkboxes.forEach(function(cb) { cb.addEventListener('change', readSelected); });
        var allBtn = popContent.querySelector('[data-action="all"]');
        var noneBtn = popContent.querySelector('[data-action="none"]');
        if (allBtn) allBtn.addEventListener('click', function(e) {
          e.preventDefault();
          checkboxes.forEach(function(cb) { cb.checked = true; });
          readSelected();
        });
        if (noneBtn) noneBtn.addEventListener('click', function(e) {
          e.preventDefault();
          checkboxes.forEach(function(cb) { cb.checked = false; });
          readSelected();
        });
        // Wire quick-filter preset buttons: each applies a named
        // subset of values as the active filter.
        var quickBtns = Array.prototype.slice.call(
          popContent.querySelectorAll('.col-filter-quick [data-quick-idx]')
        );
        quickBtns.forEach(function(btn) {
          btn.addEventListener('click', function(e) {
            e.preventDefault();
            var idx = parseInt(btn.getAttribute('data-quick-idx'), 10);
            var preset = col.quickFilters && col.quickFilters[idx];
            if (!preset) return;
            var wantSet = {};
            (preset.values || []).forEach(function(v) { wantSet[v] = true; });
            checkboxes.forEach(function(cb) { cb.checked = !!wantSet[cb.value]; });
            readSelected();
          });
        });
      } else if (col.filter === 'range') {
        var minInput = popContent.querySelector('.col-filter-min');
        var maxInput = popContent.querySelector('.col-filter-max');
        function readRange() {
          filterState[key] = {
            min: minInput ? minInput.value : '',
            max: maxInput ? maxInput.value : '',
          };
          applyFilters();
          save();
        }
        if (minInput) minInput.addEventListener('input', readRange);
        if (maxInput) maxInput.addEventListener('input', readRange);
      }
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

    // -- Wire events -----------------------------------------------------

    host.querySelectorAll('[data-sort]').forEach(function(btn) {
      var indicator = btn.querySelector('[data-role="sort-indicator"]');
      var labelSpan = btn.querySelector('span:not([data-role])');
      var colKey = btn.dataset.sort;
      var meta = columnMeta(colKey);
      var hasFilter = meta && !!meta.filter;

      if (labelSpan && hasFilter) {
        labelSpan.style.cursor = 'pointer';
        labelSpan.addEventListener('click', function(e) {
          e.stopPropagation();
          showPopoverForColumn(colKey);
        });
      }

      btn.addEventListener('click', function(e) {
        if (hasFilter && (e.target === labelSpan || (labelSpan && labelSpan.contains(e.target)))) return;
        if (state.sort.key === colKey) {
          state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
        } else {
          state.sort = { key: colKey, dir: 'asc' };
        }
        updateSortIndicators();
        applySort();
        save();
      });
    });

    if (quickSearchInput) quickSearchInput.addEventListener('input', applyFilters);

    // Dismiss the filter popover when clicking anywhere else on the page.
    document.addEventListener('mousedown', function(e) {
      if (!popover || popover.style.display === 'none') return;
      if (popover.contains(e.target)) return;
      if (currentAnchor && currentAnchor.contains(e.target)) return;
      hidePopover();
    });
    // Also hide on scroll so the popover doesn't drift away from its anchor.
    window.addEventListener('scroll', function() {
      if (popover && popover.style.display !== 'none') hidePopover();
    }, true);

    menuScope.querySelectorAll('[data-column-toggle]').forEach(function(cb) {
      var key = cb.dataset.columnToggle;
      cb.checked = !!state.visible[key];
      cb.addEventListener('change', function() {
        state.visible[key] = cb.checked;
        applyColumnVisibility();
        save();
      });
    });

    // Drag-and-drop column reorder. Each .opp-list-column-row in the
    // menu has draggable="true"; on drop we splice state.order to
    // match the new visual position and re-apply.
    var dragKey = null;
    menuScope.querySelectorAll('.opp-list-column-row').forEach(function(row) {
      row.addEventListener('dragstart', function(e) {
        dragKey = row.getAttribute('data-column-row');
        row.classList.add('is-dragging');
        try {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', dragKey);
        } catch (_) {}
      });
      row.addEventListener('dragend', function() {
        dragKey = null;
        menuScope.querySelectorAll('.opp-list-column-row').forEach(function(r) {
          r.classList.remove('is-dragging', 'drop-before', 'drop-after');
        });
      });
      row.addEventListener('dragover', function(e) {
        if (!dragKey) return;
        if (row.getAttribute('data-column-row') === dragKey) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        // Visual hint: show the drop position based on cursor Y.
        var rect = row.getBoundingClientRect();
        var before = (e.clientY - rect.top) < rect.height / 2;
        row.classList.toggle('drop-before', before);
        row.classList.toggle('drop-after', !before);
      });
      row.addEventListener('dragleave', function() {
        row.classList.remove('drop-before', 'drop-after');
      });
      row.addEventListener('drop', function(e) {
        if (!dragKey) return;
        var targetKey = row.getAttribute('data-column-row');
        if (targetKey === dragKey) return;
        e.preventDefault();
        var rect = row.getBoundingClientRect();
        var dropBefore = (e.clientY - rect.top) < rect.height / 2;
        var fromIdx = state.order.indexOf(dragKey);
        if (fromIdx < 0) return;
        state.order.splice(fromIdx, 1);
        var toIdx = state.order.indexOf(targetKey);
        if (toIdx < 0) return;
        state.order.splice(dropBefore ? toIdx : toIdx + 1, 0, dragKey);
        applyColumnOrder();
        save();
      });
    });

    var resetBtn = menuScope.querySelector('[data-role="reset"]');
    if (resetBtn) {
      resetBtn.addEventListener('click', function() {
        try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
        location.reload();
      });
    }

    // -- Proxy horizontal scrollbar --------------------------------------
    //
    // .opp-list uses overflow-x: clip so sticky thead can latch to the
    // body scrollport. clip forbids scrollLeft, so horizontal scroll
    // is driven externally: this proxy scrollbar renders at the top of
    // the viewport, and its scrollLeft sets the table style.left so
    // the table slides behind .opp-list clip rect. Hidden when the
    // table fits.

    var hscroll = null;
    var hscrollInner = null;

    function getTableEl() {
      return host.querySelector('.opp-list-table');
    }

    function applyTableOffset() {
      var table = getTableEl();
      if (!table || !hscroll) return;
      table.style.position = 'relative';
      table.style.left = (-hscroll.scrollLeft) + 'px';
    }

    function ensureHScroll() {
      if (hscroll) return hscroll;
      hscroll = document.createElement('div');
      hscroll.className = 'opp-list-hscroll';
      hscrollInner = document.createElement('div');
      hscrollInner.className = 'opp-list-hscroll-inner';
      hscroll.appendChild(hscrollInner);
      host.parentNode.insertBefore(hscroll, host);
      hscroll.addEventListener('scroll', applyTableOffset);
      return hscroll;
    }

    function syncHScroll() {
      ensureHScroll();
      var table = getTableEl();
      var tableW = table ? table.offsetWidth : 0;
      var hostW = host.clientWidth;
      if (tableW > hostW + 1) {
        hscrollInner.style.width = tableW + 'px';
        hscroll.hidden = false;
        // Clamp scroll position if the table got narrower.
        var max = Math.max(0, tableW - hostW);
        if (hscroll.scrollLeft > max) hscroll.scrollLeft = max;
        applyTableOffset();
      } else {
        hscroll.hidden = true;
        hscroll.scrollLeft = 0;
        if (table) table.style.left = '0px';
      }
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
    syncHScroll();

    // Close the <details> columns menu when the user clicks outside it.
    // Native <details> only closes on summary click; with the panel
    // floating over the table, expecting users to "click the gear
    // again to close" is annoying. Watch document clicks and close
    // the menu when the click target sits outside the <details>.
    var columnsDetails = menuScope.querySelector('details[data-role="columns-menu"]');
    if (columnsDetails) {
      document.addEventListener('click', function(e) {
        if (!columnsDetails.open) return;
        if (columnsDetails.contains(e.target)) return;
        columnsDetails.open = false;
      });
      // Esc also closes (matches the native popup close affordance).
      document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape' && columnsDetails.open) {
          columnsDetails.open = false;
        }
      });
    }

    // Re-measure on viewport resize — the table width or the container
    // clientWidth may change, toggling whether the proxy is needed.
    window.addEventListener('resize', syncHScroll);
    // Also re-sync after any column resize/visibility change. The
    // existing syncTableWidth() already runs after these, so we wrap it.
    var _origSyncTableWidth = syncTableWidth;
    syncTableWidth = function() {
      _origSyncTableWidth();
      syncHScroll();
    };
  } catch (err) {
    console.error('list controller failed:', err);
  }
})();
`;
}
