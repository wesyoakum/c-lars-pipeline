// js/account-picker.js
//
// Shared logic for the account picker "group by parent group" toggle.
//
// How it works:
//
//   1. A <select> participates in grouping by setting `data-groupable="true"`.
//      Each real account <option> carries `data-group="<parent group label>"`
//      on the server-rendered markup (empty/missing means ungrouped).
//
//   2. This script, on DOMContentLoaded, walks every groupable <select>
//      and rebuilds its options according to the current localStorage
//      toggle state. The initial server render is always flat so the
//      page is usable without JS and without having to duplicate the
//      option set.
//
//   3. Toggle pills (rendered elsewhere) flip the state and dispatch a
//      `pms:account-picker-toggle` CustomEvent on `window`, which re-runs
//      the regroup pass. The same event is also dispatched on explicit
//      "rebuild" calls (e.g. after HTMX swaps in new markup).
//
//   4. For inline-edit pickers (opportunity detail page), the <select>
//      is created lazily when the user clicks the field. Those call
//      `window.pmsAccountPicker.buildSelectOptions(select, items)` with
//      the parsed options array — that helper reads the toggle state
//      from localStorage and appends the right <option>/<optgroup> tree.
//
// Toggle state:
//   localStorage key `pms.accountPicker.grouped` = '1' (on) | '0' (off)
//   Default: off.

(function () {
  'use strict';

  var LS_KEY = 'pms.accountPicker.grouped';
  var EVENT_NAME = 'pms:account-picker-toggle';

  function isGrouped() {
    try {
      return window.localStorage.getItem(LS_KEY) === '1';
    } catch (e) {
      return false;
    }
  }

  function setGrouped(on) {
    try {
      window.localStorage.setItem(LS_KEY, on ? '1' : '0');
    } catch (e) { /* ignore */ }
    window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: { grouped: on } }));
  }

  function toggle() {
    setGrouped(!isGrouped());
  }

  // Collect the real account options from a <select> that was rendered
  // server-side as a flat list. Returns an array of:
  //   { value, label, group, isPlaceholder, isAddNew }
  // in the same order the server emitted them. Placeholder (empty value)
  // and "+ Add new account" (__new__) options are flagged so we can pin
  // them to the top/bottom regardless of grouping.
  function collectOptionsFromSelect(sel) {
    var out = [];
    var options = sel.querySelectorAll('option');
    for (var i = 0; i < options.length; i++) {
      var o = options[i];
      out.push({
        value: o.value,
        label: o.textContent,
        group: o.getAttribute('data-group') || '',
        selected: o.selected,
        isPlaceholder: o.value === '',
        isAddNew: o.value === '__new__',
      });
    }
    return out;
  }

  // Rebuild a <select>'s children from an array of option items. `items`
  // is a flat list; this helper groups them (or not) based on the
  // current toggle state. Preserves the selected value across rebuilds.
  //
  // Used both by the auto-init pass (on groupable <select>s) and by the
  // opportunity detail page's inline-edit activator.
  function buildSelectOptions(sel, items) {
    var grouped = isGrouped();

    // Remember the current selection so we can restore it after reshuffling.
    var currentValue = sel.value;

    // Clear everything.
    while (sel.firstChild) sel.removeChild(sel.firstChild);

    if (!grouped) {
      // Flat mode — emit in the order the server gave us (already
      // name-sorted at the query). Placeholder/__new__ stay wherever
      // they were in the source list.
      items.forEach(function (it) {
        sel.appendChild(makeOption(it));
      });
    } else {
      // Grouped mode —
      //   (1) placeholders (empty value) first
      //   (2) optgroups alphabetically by group label
      //   (3) ungrouped accounts under an "Ungrouped" optgroup
      //   (4) __new__ / special sentinels at the bottom
      var placeholders = [];
      var ungrouped = [];
      var specials = [];
      var byGroup = {};
      items.forEach(function (it) {
        if (it.isPlaceholder) { placeholders.push(it); return; }
        if (it.isAddNew) { specials.push(it); return; }
        var g = (it.group || '').trim();
        if (!g) { ungrouped.push(it); return; }
        if (!byGroup[g]) byGroup[g] = [];
        byGroup[g].push(it);
      });

      placeholders.forEach(function (it) { sel.appendChild(makeOption(it)); });

      Object.keys(byGroup).sort(function (a, b) {
        return a.toLowerCase().localeCompare(b.toLowerCase());
      }).forEach(function (g) {
        var og = document.createElement('optgroup');
        og.label = g;
        byGroup[g].forEach(function (it) { og.appendChild(makeOption(it)); });
        sel.appendChild(og);
      });

      if (ungrouped.length) {
        var og2 = document.createElement('optgroup');
        og2.label = 'Ungrouped';
        ungrouped.forEach(function (it) { og2.appendChild(makeOption(it)); });
        sel.appendChild(og2);
      }

      specials.forEach(function (it) { sel.appendChild(makeOption(it)); });
    }

    // Restore selection.
    if (currentValue !== null && currentValue !== undefined) {
      sel.value = currentValue;
    }
  }

  function makeOption(it) {
    var opt = document.createElement('option');
    opt.value = it.value;
    opt.textContent = it.label;
    if (it.group) opt.setAttribute('data-group', it.group);
    if (it.selected) opt.selected = true;
    return opt;
  }

  // Run through every groupable <select> currently in the DOM and
  // rebuild it. Called on page load and whenever the toggle flips.
  function refreshAll() {
    var selects = document.querySelectorAll('select[data-groupable="true"]');
    for (var i = 0; i < selects.length; i++) {
      var sel = selects[i];
      // Snapshot the source options once, so repeated toggles don't
      // lose the flat order. We stash them on the element.
      if (!sel.__pmsItems) {
        sel.__pmsItems = collectOptionsFromSelect(sel);
      }
      buildSelectOptions(sel, sel.__pmsItems);
    }
    // Also refresh any visible toggle pills so their active state
    // tracks the shared localStorage value.
    refreshTogglePills();
  }

  // Every toggle pill on the page is a <button data-role="account-picker-toggle">.
  // We set `aria-pressed` and a `.is-active` class on it so CSS can
  // style the on/off states. Pills wire up their click handler in this
  // init pass too.
  function refreshTogglePills() {
    var pills = document.querySelectorAll('[data-role="account-picker-toggle"]');
    var on = isGrouped();
    for (var i = 0; i < pills.length; i++) {
      var pill = pills[i];
      pill.setAttribute('aria-pressed', on ? 'true' : 'false');
      pill.classList.toggle('is-active', on);
    }
  }

  function bindTogglePills() {
    var pills = document.querySelectorAll('[data-role="account-picker-toggle"]');
    for (var i = 0; i < pills.length; i++) {
      var pill = pills[i];
      if (pill.__pmsBound) continue;
      pill.__pmsBound = true;
      pill.addEventListener('click', function (e) {
        e.preventDefault();
        toggle();
      });
    }
  }

  // Expose a tiny API so other inline scripts (e.g. the opp detail
  // inline-edit activator) can reuse the grouping logic.
  window.pmsAccountPicker = {
    isGrouped: isGrouped,
    setGrouped: setGrouped,
    toggle: toggle,
    buildSelectOptions: buildSelectOptions,
    refreshAll: refreshAll,
  };

  // Boot.
  function init() {
    bindTogglePills();
    refreshAll();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
  window.addEventListener(EVENT_NAME, function () {
    bindTogglePills();
    refreshAll();
  });
})();
