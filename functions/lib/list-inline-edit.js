// functions/lib/list-inline-edit.js
//
// Inline-edit helpers for list tables (the pages that use list-table.js:
// accounts, opportunities, quotes, jobs, activities, …). They produce
// the same .ie / .ie-display / .ie-input DOM the detail pages use, so
// css/pipeline.css Section "Inline-edit fields" (line ~2298) styles them for
// free.
//
// Server side:
//   import { ieText, ieSelect, ieTextarea, listInlineEditScript } from '../lib/list-inline-edit.js';
//
//   <td data-col="phone">${ieText('phone', r.phone)}</td>
//   <td data-col="segment">${ieSelect('segment', r.segment, SEGMENT_OPTIONS)}</td>
//
//   <script>${raw(listInlineEditScript('/accounts/:id/patch'))}</script>
//
// Client side:
//   The script uses event delegation on the <tbody data-role="rows">, so
//   sort/filter reorders (which move <tr> nodes around) don't break it.
//   On click it resolves the row id via closest('tr').dataset.rowId and
//   substitutes it into the patch URL template.
//
// Fallback display (the "alias shows account name when empty" pattern):
//   Pass { fallbackText: name } to ieText. The helper renders the
//   fallback in muted grey and stores the real (possibly empty) value
//   in a hidden .ie-raw span so click-to-edit starts from the real
//   value, not from the fallback text.

import { html, raw, escape } from './layout.js';

/* ------------------------------------------------------------------ */
/*  Server-side HTML helpers                                          */
/* ------------------------------------------------------------------ */

/**
 * Inline-editable text cell.
 *
 * opts:
 *   - placeholder   — what to show when empty (default: '—')
 *   - inputType     — HTML input type (text|number|date|email|url|tel …)
 *   - fallbackText  — display this (muted) when value is empty; the
 *                     real value still lives in a hidden .ie-raw span
 *                     so the editor opens with the correct starting
 *                     value. Used by the accounts alias column, where
 *                     an empty alias displays the account name.
 *   - displayText   — when set AND value is present, show this string
 *                     in the cell instead of the raw value. The raw
 *                     value still lives in .ie-raw so the editor opens
 *                     with it. Used for formatted numeric columns
 *                     (e.g. "$1,000" displayed / 1000 edited).
 */
export function ieText(field, value, opts = {}) {
  const hasValue = value != null && value !== '';
  const inputTypeAttr = opts.inputType ? ` data-input-type="${escape(opts.inputType)}"` : '';
  const fallbackAttr = opts.fallbackText
    ? ` data-fallback-text="${escape(opts.fallbackText)}"`
    : '';

  // Display text: displayText (when value is present) > raw value >
  // fallback > placeholder > em-dash.
  const display = hasValue
    ? (opts.displayText ?? value)
    : opts.fallbackText ?? opts.placeholder ?? '\u2014';
  const displayClass = hasValue ? '' : 'muted';

  return html`<span class="ie" data-field="${field}" data-type="text"${raw(inputTypeAttr)}${raw(fallbackAttr)}>
    <span class="ie-display ${displayClass}">${escape(display)}</span>
    <span class="ie-raw" hidden>${escape(hasValue ? value : '')}</span>
  </span>`;
}

/**
 * Inline-editable select cell. `options` is [{ value, label }…].
 *
 * opts:
 *   - placeholder — what to show when value is empty (default: first
 *                   matching option's label or '—')
 *   - allowNew    — honor the __new__ sentinel option to swap in a
 *                   free-text input (same as the detail page).
 */
export function ieSelect(field, value, options, opts = {}) {
  const selectedOpt = options.find((o) => o.value === (value ?? ''));
  const hasValue = value != null && value !== '';
  const display = hasValue
    ? (selectedOpt?.label || value)
    : (opts.placeholder || selectedOpt?.label || '\u2014');
  const displayClass = hasValue ? '' : 'muted';
  const optJson = JSON.stringify(options);
  const allowNewAttr = opts.allowNew ? ' data-allow-new="true"' : '';

  return html`<span class="ie" data-field="${field}" data-type="select" data-options='${escape(optJson)}'${raw(allowNewAttr)}>
    <span class="ie-display ${displayClass}">${escape(display)}</span>
    <span class="ie-raw" hidden>${escape(hasValue ? value : '')}</span>
  </span>`;
}

/**
 * Inline-editable textarea cell. Multi-line notes, etc.
 */
export function ieTextarea(field, value, opts = {}) {
  const hasValue = value != null && value !== '';
  const display = hasValue ? value : opts.placeholder || '\u2014';
  const displayClass = hasValue ? '' : 'muted';

  return html`<span class="ie" data-field="${field}" data-type="textarea">
    <span class="ie-display ${displayClass}">${escape(display)}</span>
    <span class="ie-raw" hidden>${escape(hasValue ? value : '')}</span>
  </span>`;
}

/* ------------------------------------------------------------------ */
/*  Client-side controller (plain JS string, injected via raw())      */
/* ------------------------------------------------------------------ */

/**
 * Client script that wires click-to-edit on every .ie cell inside the
 * list table's <tbody data-role="rows">. Uses event delegation so DOM
 * reordering (from sort/filter/column-move) doesn't break listeners.
 *
 * @param {string} patchUrlTemplate  e.g. '/accounts/:id/patch' — ':id'
 *                                   gets replaced with the row id from
 *                                   <tr data-row-id="…">.
 * @param {object} opts
 * @param {object} [opts.fieldAttrMap]  Map from patch-field name →
 *     row data-attribute key, used when the list-table column key
 *     doesn't match the patch endpoint's field name. For example,
 *     opportunities have column key `value` but field name
 *     `estimated_value_usd`; pass `{ estimated_value_usd: 'value',
 *     expected_close_date: 'close', ... }`. The client falls back to
 *     `data-<field>_display` → `data-<field>` when no map entry exists.
 */
export function listInlineEditScript(patchUrlTemplate, opts = {}) {
  const fieldAttrMap = opts.fieldAttrMap ?? {};
  return `
(function() {
  try {
    var PATCH_URL_TEMPLATE = ${JSON.stringify(patchUrlTemplate)};
    var FIELD_ATTR_MAP = ${JSON.stringify(fieldAttrMap)};

    var host = document.querySelector('.opp-list');
    if (!host) return;
    var tbody = host.querySelector('[data-role="rows"]');
    if (!tbody) return;

    // Row interaction model:
    //   single-click anywhere on a row  → navigate to detail page
    //   double-click on an .ie cell     → activate inline-edit
    //   double-click on a plain cell    → no-op (single already navigated)
    //
    // Click target bail-list: anything that's already actionable
    // (anchors, buttons, form controls, the columns-menu gear, sort
    // headers, filter popovers) keeps its native behavior. A row's
    // detail URL is read from its `<a class="row-open-link">` cell —
    // every list page emits one, so no extra wiring on individual
    // pages is required.
    var DOUBLE_CLICK_MS = 260;
    var pendingNavTimer = null;
    var lastClickWasIe = false;

    function shouldBailFromRowNav(target) {
      if (!target || !target.closest) return true;
      // Native interactive elements: anchors, buttons, form controls.
      if (target.closest('a, button, form, input, select, textarea, label')) return true;
      // List-table machinery (sort header buttons, columns menu, filter popover).
      if (target.closest('[data-role="columns-menu"], .col-sort, [data-role="header-row"]')) return true;
      if (target.closest('[data-filter-popover], .opp-list-filter-popover')) return true;
      // Cells the page explicitly marks as not-clickable.
      if (target.closest('[data-row-no-nav]')) return true;
      return false;
    }

    function rowNavHref(tr) {
      var openLink = tr.querySelector('a.row-open-link');
      if (openLink && openLink.getAttribute('href')) {
        return openLink.getAttribute('href');
      }
      // Fallback: opt-in attribute on the row itself for pages that
      // don't render a row-open-link cell.
      return tr.getAttribute('data-row-href') || null;
    }

    tbody.addEventListener('click', function(e) {
      if (shouldBailFromRowNav(e.target)) return;

      var tr = e.target.closest('tr[data-row-id]');
      if (!tr || !tbody.contains(tr)) return;

      var href = rowNavHref(tr);
      if (!href) {
        // Page didn't expose a nav URL — fall through to legacy behavior
        // (activate inline-edit on click) so existing pages without
        // row-open-link cells still work.
        var ieLegacy = e.target.closest('.ie');
        if (ieLegacy && tbody.contains(ieLegacy) && !ieLegacy.querySelector('.ie-input')) {
          activate(ieLegacy);
        }
        return;
      }

      var ie = e.target.closest('.ie');
      var clickIsOnEditableCell = !!(ie && tbody.contains(ie) && !ie.querySelector('.ie-input'));
      lastClickWasIe = clickIsOnEditableCell;

      if (pendingNavTimer) {
        clearTimeout(pendingNavTimer);
        pendingNavTimer = null;
      }

      if (clickIsOnEditableCell) {
        // Defer navigation so a follow-up dblclick can take over and
        // open the editor instead.
        pendingNavTimer = setTimeout(function() {
          pendingNavTimer = null;
          window.location.href = href;
        }, DOUBLE_CLICK_MS);
      } else {
        // Plain cell — navigate immediately. New-tab / cmd-click
        // already works via the row-open-link anchor (which is in
        // the bail-list above).
        window.location.href = href;
      }
    });

    tbody.addEventListener('dblclick', function(e) {
      if (shouldBailFromRowNav(e.target)) return;

      // Cancel any pending single-click navigation.
      if (pendingNavTimer) {
        clearTimeout(pendingNavTimer);
        pendingNavTimer = null;
      }

      var ie = e.target.closest('.ie');
      if (!ie || !tbody.contains(ie)) return;
      if (ie.querySelector('.ie-input')) return;
      activate(ie);
    });

    function activate(el) {
      var type = el.dataset.type || 'text';
      var display = el.querySelector('.ie-display');
      var rawEl = el.querySelector('.ie-raw');
      // Prefer the raw value (which is blank for empty-fallback cells)
      // over the display text (which might show a fallback like the
      // account name in the alias column).
      var currentValue = rawEl
        ? rawEl.textContent
        : (display && !display.classList.contains('muted') ? display.textContent.trim() : '');

      var input;
      if (type === 'select') {
        input = document.createElement('select');
        input.className = 'ie-input';
        var options = [];
        try { options = JSON.parse(el.dataset.options || '[]'); } catch (e) {}
        options.forEach(function(o) {
          var opt = document.createElement('option');
          opt.value = o.value;
          opt.textContent = o.label;
          if (o.value === (currentValue || '')) opt.selected = true;
          input.appendChild(opt);
        });
        input.addEventListener('change', function() {
          if (el.dataset.allowNew === 'true' && input.value === '__new__') {
            // Swap the select out for a free-text input.
            el.removeChild(input);
            var txt = document.createElement('input');
            txt.type = 'text';
            txt.className = 'ie-input';
            txt.placeholder = 'Type a new label\\u2026';
            txt.addEventListener('blur', function() { save(el, txt); });
            txt.addEventListener('keydown', function(e) {
              if (e.key === 'Enter') { e.preventDefault(); save(el, txt); }
              if (e.key === 'Escape') { deactivate(el, txt); }
            });
            el.appendChild(txt);
            txt.focus();
          } else {
            save(el, input);
          }
        });
        input.addEventListener('blur', function() {
          setTimeout(function() { deactivate(el, input); }, 150);
        });
      } else if (type === 'textarea') {
        input = document.createElement('textarea');
        input.className = 'ie-input';
        input.rows = 3;
        input.value = currentValue;
        input.addEventListener('blur', function() { save(el, input); });
        input.addEventListener('keydown', function(e) {
          if (e.key === 'Escape') { deactivate(el, input); }
        });
      } else {
        input = document.createElement('input');
        input.type = el.dataset.inputType || 'text';
        input.className = 'ie-input';
        input.value = currentValue;
        input.addEventListener('blur', function() { save(el, input); });
        input.addEventListener('keydown', function(e) {
          if (e.key === 'Enter') { e.preventDefault(); save(el, input); }
          if (e.key === 'Escape') { deactivate(el, input); }
        });
      }

      if (display) display.style.display = 'none';
      el.appendChild(input);
      try { input.focus(); } catch (e) {}
      if (input.select) { try { input.select(); } catch (e) {} }
    }

    async function save(el, input) {
      var tr = el.closest('tr[data-row-id]');
      if (!tr) { deactivate(el, input); return; }
      var rowId = tr.dataset.rowId;
      // URL template may reference multiple ids via :name placeholders.
      // :id resolves from data-row-id; any other :name resolves from
      // the matching data-<name> attribute on the row. Example:
      // '/opportunities/:opp_id/quotes/:id/patch' for nested quotes.
      var url = PATCH_URL_TEMPLATE.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, function(_, key) {
        if (key === 'id') return encodeURIComponent(rowId);
        return encodeURIComponent(tr.getAttribute('data-' + key) || '');
      });
      var field = el.dataset.field;
      var value = input.value;

      deactivate(el, input);
      el.classList.add('ie-saving');
      try {
        var res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ field: field, value: value }),
        });
        var data = await res.json();
        if (!data.ok) {
          // 409 with blockers payload → show the shared blocker modal
          // and let the user resolve inline (task complete / navigate
          // to open records). Retry reruns this same save.
          if (res.status === 409 && Array.isArray(data.blockers)
              && window.Pipeline && typeof window.Pipeline.showBlockerModal === 'function') {
            window.Pipeline.showBlockerModal({
              actionLabel: 'This change',
              error: data.error,
              blockers: data.blockers,
              retry: function () {
                return fetch(url, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ field: field, value: value }),
                }).then(function (r) {
                  return r.json().then(function (d) {
                    if (r.status === 409 && Array.isArray(d.blockers)) {
                      return { ok: false, blockers: d.blockers, error: d.error || '' };
                    }
                    if (!r.ok || !d.ok) {
                      throw new Error(d && d.error ? d.error : ('HTTP ' + r.status));
                    }
                    applySavedValue(el, tr, field, d.value !== undefined ? d.value : value);
                    return { ok: true };
                  });
                });
              }
            });
            el.classList.remove('ie-saving');
            return;
          }
          el.classList.add('ie-error');
          el.title = data.error || 'Save failed';
          setTimeout(function() {
            el.classList.remove('ie-error');
            el.removeAttribute('title');
          }, 2500);
          return;
        }

        // Some endpoints echo the coerced value back ({ok, field, value}),
        // others only return {ok:true}. Fall back to what the user typed
        // so the cell display still updates in the no-echo case.
        var savedValue = data.value !== undefined ? data.value : value;
        applySavedValue(el, tr, field, savedValue);

        el.classList.add('ie-saved');
        setTimeout(function() { el.classList.remove('ie-saved'); }, 1200);
      } catch (err) {
        console.error('list inline-edit save failed:', err);
        el.classList.add('ie-error');
        setTimeout(function() { el.classList.remove('ie-error'); }, 2500);
      } finally {
        el.classList.remove('ie-saving');
      }
    }

    function applySavedValue(el, tr, field, newValue) {
      var display = el.querySelector('.ie-display');
      var rawEl = el.querySelector('.ie-raw');
      var type = el.dataset.type || 'text';

      if (type === 'select') {
        var options = [];
        try { options = JSON.parse(el.dataset.options || '[]'); } catch (e) {}
        var opt = options.find(function(o) { return o.value === (newValue || ''); });
        if (display) {
          display.textContent = opt ? opt.label : (newValue || '\\u2014');
          display.classList.toggle('muted', !newValue);
        }
        // allow-new: remember the newly-typed label in the options list
        // so the next activation shows it.
        if (el.dataset.allowNew === 'true' && newValue && !opt) {
          var newOpt = { value: newValue, label: newValue };
          var newIdx = options.findIndex(function(o) { return o.value === '__new__'; });
          if (newIdx >= 0) options.splice(newIdx, 0, newOpt);
          else options.push(newOpt);
          el.dataset.options = JSON.stringify(options);
        }
      } else if (display) {
        var fallback = el.dataset.fallbackText;
        if (!newValue && fallback) {
          // Fallback display: show the fallback text (muted) and keep
          // the real value (empty) in the hidden raw span so clicking
          // again opens an empty editor.
          display.textContent = fallback;
          display.classList.add('muted');
        } else {
          display.textContent = newValue || '\\u2014';
          display.classList.toggle('muted', !newValue);
        }
      }
      if (rawEl) rawEl.textContent = newValue || '';

      // Keep the row's data-<attr> in sync so sort / filter / quicksearch
      // continue to match the new value. Resolution order:
      //
      //   1. Explicit mapping from listInlineEditScript({ fieldAttrMap })
      //      — covers cases where the column key differs from the patch
      //      field name (opportunities: estimated_value_usd → value).
      //   2. data-<field>_display — when the column key overlaps with a
      //      quicksearch blob and the raw value lives in a _display
      //      sibling (accounts: data-name is combined, data-name_display
      //      is the raw name). The combined-rebuild loop below picks up
      //      the new _display value and repopulates data-<field>.
      //   3. data-<field> — the default.
      var targetKey = FIELD_ATTR_MAP[field];
      if (!targetKey) {
        if (tr.hasAttribute('data-' + field + '_display')) {
          targetKey = field + '_display';
        } else {
          targetKey = field;
        }
      }
      if (tr.hasAttribute('data-' + targetKey)) {
        tr.setAttribute('data-' + targetKey, newValue || '');
      }

      // Combined quicksearch attribute: some list pages stuff several
      // raw fields (name + alias + parent_group on accounts) into a
      // single data attribute so a quicksearch match on any of them
      // finds the row. When the page opts in via data-combined-<key>,
      // we rebuild the combined attr after a save.
      //
      // data-combined-name="name_display alias parent_group" on the
      // row says "rebuild data-name from these three individual attrs".
      for (var i = 0; i < tr.attributes.length; i++) {
        var attr = tr.attributes[i];
        if (attr.name.indexOf('data-combined-') !== 0) continue;
        var combinedKey = attr.name.slice('data-combined-'.length);
        var partNames = attr.value.split(/\\s+/).filter(Boolean);
        var parts = partNames.map(function(pn) {
          return tr.getAttribute('data-' + pn) || '';
        }).filter(Boolean);
        tr.setAttribute('data-' + combinedKey, parts.join(' '));
      }
    }

    function deactivate(el, input) {
      if (input && input.parentNode === el) el.removeChild(input);
      var display = el.querySelector('.ie-display');
      if (display) display.style.display = '';
    }
  } catch (err) {
    console.error('list inline-edit init failed:', err);
  }
})();
`;
}
