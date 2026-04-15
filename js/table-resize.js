// js/table-resize.js
//
// Global drop-in table column resize helper. Loaded on every page via
// layout.js. Auto-wires resizable columns on every `<table class="data">`
// that is NOT already managed by the shared list-table controller
// (functions/lib/list-table.js) — those tables live inside a `.opp-list`
// container and handle their own resize in listScript.
//
// Behavior (matches list-table.js):
//   - Drag the right edge of any <th> to resize.
//   - Double-click the grip to AutoFit: measures the widest visible cell
//     in the column and locks the column to that width (Excel-style).
//   - Widths persist in localStorage keyed by
//     `pms.tblResize::<path>::<tableIdx>::<labelsHash>`.
//
// Scoping:
//   - Only tables with class "data" are wired. Ad-hoc tables (quote
//     meta, nested ref tables, modal tables) without `class="data"`
//     are ignored.
//   - Tables inside an element with class `.opp-list` are skipped
//     because listScript() already handles them.
//   - Tables with `data-no-resize` attribute are explicitly opted out.

(function () {
  'use strict';

  function init() {
    var tables = document.querySelectorAll('table.data');
    var seen = 0;
    tables.forEach(function (table) {
      if (table.hasAttribute('data-no-resize')) return;
      // Skip list-table controller tables (they're managed by listScript).
      if (table.closest('.opp-list')) return;
      // Need a thead with at least one row of ths.
      var headerRow = table.querySelector('thead tr');
      if (!headerRow) return;
      var ths = headerRow.querySelectorAll('th');
      if (ths.length === 0) return;

      var storageKey = computeStorageKey(table, ths, seen);
      wireTable(table, ths, storageKey);
      seen++;
    });
  }

  function computeStorageKey(table, ths, idx) {
    var labels = [];
    for (var i = 0; i < ths.length; i++) {
      var t = (ths[i].textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
      labels.push(t);
    }
    // Tiny non-cryptographic hash of labels so the key stays short but
    // still changes when columns are added/removed/renamed.
    var s = labels.join('|');
    var h = 0;
    for (var j = 0; j < s.length; j++) {
      h = ((h << 5) - h + s.charCodeAt(j)) | 0;
    }
    return 'pms.tblResize::' + location.pathname + '::' + idx + '::' + ths.length + '::' + (h >>> 0).toString(36);
  }

  function wireTable(table, ths, storageKey) {
    // Load saved widths.
    var saved = {};
    try {
      saved = JSON.parse(localStorage.getItem(storageKey) || '{}') || {};
    } catch (e) { saved = {}; }

    // Measure natural widths BEFORE we touch the layout.
    var naturalWidths = [];
    for (var i = 0; i < ths.length; i++) {
      naturalWidths[i] = ths[i].offsetWidth || 0;
    }

    // Ensure <colgroup>.
    var colgroup = table.querySelector('colgroup');
    if (!colgroup) {
      colgroup = document.createElement('colgroup');
      table.insertBefore(colgroup, table.firstChild);
    }
    // Ensure one <col> per <th>. If the page pre-rendered its own colgroup
    // with fewer cols (or none), pad it out.
    var existingCols = colgroup.querySelectorAll('col');
    for (var k = existingCols.length; k < ths.length; k++) {
      colgroup.appendChild(document.createElement('col'));
    }
    var cols = colgroup.querySelectorAll('col');

    // Switch to fixed layout so explicit col widths are honored.
    table.style.tableLayout = 'fixed';

    // Apply widths: saved > natural > 100 (40px floor).
    for (var m = 0; m < ths.length; m++) {
      var w = Number(saved[m]) > 0 ? Number(saved[m]) : naturalWidths[m] || 100;
      if (w < 40) w = 40;
      cols[m].style.width = w + 'px';
    }

    // Lock the table width to the sum of col widths. Without this,
    // `table-layout: fixed` + `width: 100%` causes the browser to
    // redistribute any freed space among other columns when one column
    // shrinks — so dragging a column narrower visually widens its
    // neighbors and the drag appears not to stick.
    syncTableWidth();

    // Attach a grip to each th. The grip needs th{position:relative}.
    ths.forEach(function (th, idx) {
      if (th.querySelector('.col-resize-grip')) return;
      // Only set position if not already positioned — don't stomp on
      // pages that already use `position: relative` for their own purposes.
      var cs = window.getComputedStyle(th).position;
      if (cs === 'static' || !cs) {
        th.style.position = 'relative';
      }
      var grip = document.createElement('div');
      grip.className = 'col-resize-grip';
      grip.title = 'Drag to resize \u2014 double-click to autofit';
      grip.addEventListener('mousedown', function (e) {
        e.preventDefault();
        e.stopPropagation();
        startResize(cols[idx], e.clientX, grip, save, syncTableWidth);
      });
      grip.addEventListener('click', function (e) { e.stopPropagation(); });
      grip.addEventListener('dblclick', function (e) {
        e.preventDefault();
        e.stopPropagation();
        autofitColumn(table, cols[idx], idx, th, save, syncTableWidth);
      });
      th.appendChild(grip);
    });

    function syncTableWidth() {
      var total = 0;
      for (var i = 0; i < cols.length; i++) {
        // Skip hidden cols so a hidden column's width doesn't
        // inflate the table.
        if (cols[i].style.display === 'none') continue;
        var wpx = parseInt(cols[i].style.width, 10);
        if (wpx > 0) total += wpx;
      }
      if (total > 0) table.style.width = total + 'px';
    }

    function save() {
      var out = {};
      for (var i = 0; i < cols.length; i++) {
        var wpx = parseInt(cols[i].style.width, 10);
        if (wpx > 0) out[i] = wpx;
      }
      try { localStorage.setItem(storageKey, JSON.stringify(out)); } catch (e) {}
    }
  }

  function startResize(col, startX, grip, save, syncTableWidth) {
    var startWidth = col.offsetWidth || parseInt(col.style.width, 10) || 100;
    grip.classList.add('dragging');
    document.body.classList.add('col-resizing');

    function onMove(e) {
      var delta = e.clientX - startX;
      var newWidth = Math.max(40, startWidth + delta);
      col.style.width = newWidth + 'px';
      if (syncTableWidth) syncTableWidth();
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      grip.classList.remove('dragging');
      document.body.classList.remove('col-resizing');
      save();
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  // Excel-style AutoFit — briefly flip to auto layout with just this
  // column unconstrained, read offsetWidth of the widest visible cell,
  // then relock at that width.
  function autofitColumn(table, col, idx, th, save, syncTableWidth) {
    var prevColWidth = col.style.width;
    var prevTableWidth = table.style.width;
    col.style.width = 'auto';
    table.style.tableLayout = 'auto';
    // Let the table size to its content while we measure.
    table.style.width = '';

    var max = th.offsetWidth || 0;
    var rows = table.querySelectorAll('tbody tr');
    rows.forEach(function (tr) {
      // Walk children by index; don't trust data-col because ad-hoc
      // tables may not set it.
      var cell = tr.children[idx];
      if (!cell) return;
      if (cell.offsetParent !== null && cell.offsetWidth > max) max = cell.offsetWidth;
    });

    table.style.tableLayout = 'fixed';
    if (max <= 0) {
      col.style.width = prevColWidth || '100px';
      table.style.width = prevTableWidth;
      return;
    }
    // Tiny fudge so ellipsis doesn't re-trigger on the next paint.
    var newWidth = Math.max(40, Math.round(max) + 2);
    col.style.width = newWidth + 'px';
    if (syncTableWidth) syncTableWidth();
    save();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
