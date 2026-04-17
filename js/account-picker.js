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

  // Per-user server-side pref. When on, the picker switches from the
  // optgroup-based flat/grouped toggle to a true two-stage flow:
  // primary list shows groups + ungrouped; picking a group swaps the
  // <select> to that group's member list.
  function isGroupRollup() {
    return !!(window.PMS && window.PMS.userPrefs && window.PMS.userPrefs.group_rollup);
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
    // When the per-user `group_rollup` pref is on, dispatch to the
    // two-stage builder instead of the optgroup-based flat/grouped
    // path. The two-stage flow shows groups + ungrouped at the top
    // level; picking a group swaps the same <select> to that group's
    // member accounts.
    if (isGroupRollup()) {
      buildTwoStage(sel, items);
      return;
    }

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

  // Two-stage <select> builder, used when the per-user `group_rollup`
  // pref is on. The primary stage lists groups (one option per parent
  // group) + ungrouped accounts. Picking a group swaps the same
  // <select> to a member-pick stage with a "← Back to groups" sentinel.
  // A single-member group auto-selects without an extra click.
  //
  // The form submits the real account_id once a member is chosen — the
  // group sentinel value (`__group:<label>`) never reaches the server
  // because we only allow it as a transient picker state.
  function buildTwoStage(sel, items) {
    var initialValue = sel.value;
    var placeholders = [], specials = [], ungrouped = [], byGroup = {};
    items.forEach(function (it) {
      if (it.isPlaceholder) { placeholders.push(it); return; }
      if (it.isAddNew) { specials.push(it); return; }
      var g = (it.group || '').trim();
      if (!g) { ungrouped.push(it); return; }
      if (!byGroup[g]) byGroup[g] = [];
      byGroup[g].push(it);
    });

    // Stash the partition so re-renders (e.g. after a Back) don't have
    // to re-walk the source items.
    sel.__pmsTwoStage = {
      placeholders: placeholders,
      specials: specials,
      ungrouped: ungrouped,
      byGroup: byGroup,
    };

    // If the initially-selected account belongs to a group, jump
    // straight into that group's member list so the user sees their
    // current selection in context.
    var initialGroupLabel = '';
    if (initialValue) {
      Object.keys(byGroup).some(function (g) {
        if (byGroup[g].some(function (it) { return it.value === initialValue; })) {
          initialGroupLabel = g;
          return true;
        }
        return false;
      });
    }

    if (initialGroupLabel) {
      renderMembers(sel, initialGroupLabel, initialValue);
    } else {
      renderTopLevel(sel, initialValue);
    }

    if (!sel.__pmsTwoStageBound) {
      sel.__pmsTwoStageBound = true;
      sel.addEventListener('change', function () {
        var v = sel.value;
        if (v && v.indexOf('__group:') === 0) {
          var label = v.slice('__group:'.length);
          var members = (sel.__pmsTwoStage.byGroup[label]) || [];
          // Single-member group: auto-pick the only member without
          // forcing a second click.
          if (members.length === 1) {
            renderTopLevel(sel, members[0].value);
            sel.value = members[0].value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            return;
          }
          renderMembers(sel, label, '');
        } else if (v === '__back__') {
          renderTopLevel(sel, '');
        }
      });
    }
  }

  function renderTopLevel(sel, restoreValue) {
    var s = sel.__pmsTwoStage;
    while (sel.firstChild) sel.removeChild(sel.firstChild);
    s.placeholders.forEach(function (it) { sel.appendChild(makeOption(it)); });
    Object.keys(s.byGroup).sort(function (a, b) {
      return a.toLowerCase().localeCompare(b.toLowerCase());
    }).forEach(function (g) {
      var opt = document.createElement('option');
      opt.value = '__group:' + g;
      var n = s.byGroup[g].length;
      opt.textContent = g + (n === 1 ? ' \u2014 1 account' : ' \u2014 ' + n + ' accounts');
      opt.setAttribute('data-is-group', '1');
      sel.appendChild(opt);
    });
    s.ungrouped.forEach(function (it) { sel.appendChild(makeOption(it)); });
    s.specials.forEach(function (it) { sel.appendChild(makeOption(it)); });
    if (restoreValue) sel.value = restoreValue;
  }

  function renderMembers(sel, label, restoreValue) {
    var s = sel.__pmsTwoStage;
    var members = (s.byGroup[label]) || [];
    while (sel.firstChild) sel.removeChild(sel.firstChild);
    var back = document.createElement('option');
    back.value = '__back__';
    back.textContent = '\u2190 Back to groups';
    sel.appendChild(back);
    var heading = document.createElement('option');
    heading.value = '';
    heading.textContent = '\u2014 Pick an account in ' + label + ' \u2014';
    heading.disabled = true;
    sel.appendChild(heading);
    members.forEach(function (it) { sel.appendChild(makeOption(it)); });
    if (restoreValue) sel.value = restoreValue;
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
