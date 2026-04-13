// js/live-calc.js
//
// Client-side live calculation for:
//   1. Cost build pricing tab  — total cost, target price, margin
//   2. Cost build labor tab    — per-workcenter cost, current project total
//   3. Quote lines             — extended price per line, subtotal, total
//
// Auto-initializes on DOMContentLoaded by detecting data attributes
// on the page. Pages that don't have cost builds or quote lines get
// a zero-cost no-op.
//
// No dependencies — vanilla JS. Works alongside HTMX / Alpine.

(function () {
  'use strict';

  // -- Utilities --------------------------------------------------------

  function parseMoney(s) {
    if (s === undefined || s === null) return null;
    s = String(s).trim();
    if (s === '') return null;
    var n = Number(s.replace(/[$,\s]/g, ''));
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  function fmtDollar(n) {
    if (n === null || n === undefined || !Number.isFinite(n)) return '\u2014'; // em-dash
    return '$' + Math.round(n).toLocaleString('en-US');
  }

  function fmtPct(n, d) {
    if (n === null || n === undefined || !Number.isFinite(n)) return '\u2014';
    d = d !== undefined ? d : 1;
    return (n * 100).toFixed(d) + '%';
  }

  function setText(id, text) {
    var el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  // =====================================================================
  // 1. COST BUILD — pricing + labor + DM live calc
  // =====================================================================

  function initCostBuild() {
    var dataEl = document.getElementById('cb-pricing-data');
    if (!dataEl) return;

    var cfg;
    try { cfg = JSON.parse(dataEl.textContent); } catch (e) { return; }

    var form = document.querySelector('.cost-build-form');
    if (!form) return;

    function val(name) {
      var el = form.querySelector('[name="' + name + '"]');
      return el ? parseMoney(el.value) : null;
    }

    // --- Labor total (current project) ---

    function computeCurrentLaborTotal() {
      var total = 0;
      var rows = form.querySelectorAll('[data-labor-wc]');
      rows.forEach(function (row) {
        var wc = row.getAttribute('data-labor-wc');
        var hInput = form.querySelector('[name="current_hours[' + wc + ']"]');
        var rInput = form.querySelector('[name="current_rate[' + wc + ']"]');
        var costCell = row.querySelector('[data-labor-cost]');

        var h = parseMoney(hInput ? hInput.value : null);
        var r = parseMoney(rInput ? rInput.value : null);
        var cost = 0;
        if (h !== null && h > 0) {
          cost = h * ((r !== null && r > 0) ? r : cfg.defaultLaborRate);
        }
        total += cost;
        if (costCell) costCell.textContent = cost > 0 ? fmtDollar(cost) : '\u2014';
      });

      setText('cb-labor-total', fmtDollar(total));
      return total;
    }

    // --- DM library total (from checked items) ---

    function computeDmLibTotal() {
      var total = 0;
      form.querySelectorAll('[name="dm_item_ids"]:checked').forEach(function (cb) {
        total += Number(cb.getAttribute('data-cost') || 0);
      });
      return total;
    }

    // --- Labor library total (from checked items) ---

    function computeLaborLibTotal() {
      var total = 0;
      form.querySelectorAll('[name="labor_item_ids"]:checked').forEach(function (cb) {
        total += Number(cb.getAttribute('data-cost') || 0);
      });
      return total;
    }

    // --- Main pricing recalc ---

    function recalc() {
      var p = cfg.targetPct;
      var pTotal = cfg.totalTargetPct;

      // Compute live totals from the sub-tabs
      var currentLaborTotal = computeCurrentLaborTotal();
      var dmLibTotal = computeDmLibTotal();
      var laborLibTotal = computeLaborLibTotal();
      var laborCalcTotal = currentLaborTotal + laborLibTotal;

      var dmLinked = !!(form.querySelector('[name="use_dm_library"]') || {}).checked;
      var laborLinked = !!(form.querySelector('[name="use_labor_library"]') || {}).checked;

      // Update DM/Labor library selection totals in footers
      setText('cb-dm-selected-total', fmtDollar(dmLibTotal));
      setText('cb-labor-selected-total', fmtDollar(laborLibTotal));
      if (laborLinked) {
        setText('cb-labor-linked-total', fmtDollar(laborCalcTotal));
      }

      // Effective values: linked → library total, else user input
      var dm = dmLinked ? dmLibTotal : val('dm_user_cost');
      var dl = laborLinked ? laborCalcTotal : val('dl_user_cost');
      var imoh = val('imoh_user_cost');
      var other = val('other_user_cost');
      var quote = val('quote_price_user');

      // Sum known costs
      var costs = [dm, dl, imoh, other];
      var known = costs.filter(function (v) { return v !== null; });
      var totalCost = known.length > 0 ? known.reduce(function (a, b) { return a + b; }, 0) : null;

      // Target price
      var targetPrice = totalCost !== null ? totalCost / pTotal : null;

      // Margin
      var marginAmt = null, marginPct = null, marginStatus = '';
      if (quote !== null && totalCost !== null) {
        marginAmt = quote - totalCost;
        marginPct = quote !== 0 ? marginAmt / quote : null;
        if (marginPct !== null) {
          marginStatus = marginPct > cfg.marginThresholdGood ? 'good' : 'low';
        }
      }

      // --- Update pricing DOM ---
      setText('cb-total-cost', fmtDollar(totalCost));
      setText('cb-target-price', fmtDollar(targetPrice));

      var marginEl = document.getElementById('cb-margin-value');
      if (marginEl) {
        marginEl.textContent = marginAmt !== null
          ? fmtDollar(marginAmt) + ' (' + fmtPct(marginPct) + ')'
          : '\u2014';
      }

      var marginBox = document.getElementById('cb-margin-box');
      if (marginBox) {
        marginBox.classList.remove('margin-good', 'margin-low');
        if (marginStatus) marginBox.classList.add('margin-' + marginStatus);
      }

      var marginStatusEl = document.getElementById('cb-margin-status');
      if (marginStatusEl) {
        if (marginStatus === 'good') {
          marginStatusEl.textContent = 'Good (> ' + fmtPct(cfg.marginThresholdGood) + ')';
        } else if (marginStatus === 'low') {
          marginStatusEl.textContent = 'Too low (\u2264 ' + fmtPct(cfg.marginThresholdGood) + ')';
        } else {
          marginStatusEl.textContent = '';
        }
      }

      // --- Reference estimates ---
      // From Quote Price
      if (quote !== null) {
        setText('cb-ref-fq-dm', fmtDollar(quote * p.dm));
        setText('cb-ref-fq-dl', fmtDollar(quote * p.dl));
        setText('cb-ref-fq-imoh', fmtDollar(quote * p.imoh));
        setText('cb-ref-fq-other', fmtDollar(quote * p.other));
      }
      // From DM
      var effDm = dm;
      if (effDm !== null && p.dm > 0) {
        var ipDm = effDm / p.dm;
        setText('cb-ref-fdm-price', fmtDollar(ipDm));
        setText('cb-ref-fdm-dl', fmtDollar(ipDm * p.dl));
        setText('cb-ref-fdm-imoh', fmtDollar(ipDm * p.imoh));
        setText('cb-ref-fdm-other', fmtDollar(ipDm * p.dl)); // parity with server bug
      }
      // From DM + DL
      var effDl = dl;
      var pDmDl = p.dm + p.dl;
      if (effDm !== null && effDl !== null && pDmDl > 0) {
        var ipDmDl = (effDm + effDl) / pDmDl;
        setText('cb-ref-fdmdl-price', fmtDollar(ipDmDl));
        setText('cb-ref-fdmdl-imoh', fmtDollar(ipDmDl * p.imoh));
        setText('cb-ref-fdmdl-other', fmtDollar(ipDmDl * p.other));
      }
    }

    // Delegate on the entire form — covers all inputs + checkboxes
    form.addEventListener('input', recalc);
    form.addEventListener('change', recalc);

    // Run once on load to sync (handles pre-filled values)
    recalc();
  }

  // =====================================================================
  // 2. QUOTE LINES live calc
  // =====================================================================

  function initQuoteLines() {
    var table = document.querySelector('[data-live-calc="quote-lines"]');
    if (!table) return;

    function recalc() {
      var subtotal = 0;

      table.querySelectorAll('[data-line-row]').forEach(function (row) {
        // qty and unit_price belong to a form identified by <form id="line-form-{id}">
        // but they might also be direct children via the `form` attribute.
        // Use the row itself as the search scope.
        var qtyInput = row.querySelector('[name="quantity"]');
        var priceInput = row.querySelector('[name="unit_price"]');
        var extCell = row.querySelector('[data-line-extended]');

        var qty = parseMoney(qtyInput ? qtyInput.value : null);
        var price = parseMoney(priceInput ? priceInput.value : null);
        if (qty === null) qty = 0;
        if (price === null) price = 0;
        var ext = qty * price;
        subtotal += ext;
        if (extCell) extCell.textContent = fmtDollar(ext);
      });

      var taxInput = document.querySelector('input[name="tax_amount"]');
      var tax = parseMoney(taxInput ? taxInput.value : null);
      if (tax === null) tax = 0;
      var total = subtotal + tax;

      setText('q-subtotal', fmtDollar(subtotal));
      setText('q-total', fmtDollar(total));
      setText('q-header-total', fmtDollar(total));

      var linesSubEl = document.getElementById('q-lines-subtotal');
      if (linesSubEl) linesSubEl.textContent = fmtDollar(subtotal) + ' subtotal';
    }

    // Event delegation on the lines table
    table.addEventListener('input', recalc);

    // Tax input lives in the header form (outside the lines table)
    var taxInput = document.querySelector('input[name="tax_amount"]');
    if (taxInput) taxInput.addEventListener('input', recalc);

    // "Add a line" preview
    var addForm = document.querySelector('.add-line-form');
    if (addForm) {
      addForm.addEventListener('input', function () {
        var qty = parseMoney((addForm.querySelector('[name="quantity"]') || {}).value);
        var price = parseMoney((addForm.querySelector('[name="unit_price"]') || {}).value);
        if (qty === null) qty = 0;
        if (price === null) price = 0;
        var preview = addForm.querySelector('[data-add-preview]');
        if (preview) preview.textContent = fmtDollar(qty * price);
      });
    }

    // Initial calc
    recalc();
  }

  // =====================================================================
  // Bootstrap
  // =====================================================================

  document.addEventListener('DOMContentLoaded', function () {
    initCostBuild();
    initQuoteLines();
  });
})();
