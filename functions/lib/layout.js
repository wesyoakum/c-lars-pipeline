// functions/lib/layout.js
//
// Small server-side HTML layout helper. PMS is rendered as plain HTML
// with HTMX for interactivity and Alpine.js for small local state —
// no build step, no framework, no hydration. Every page is a function
// that returns a string, wrapped in `layout(title, body, { user })`.
//
// Usage:
//   import { layout, html, escape } from '../lib/layout.js';
//   return new Response(
//     layout('Dashboard', `<h1>Welcome ${escape(user.display_name)}</h1>`, { user }),
//     { headers: { 'content-type': 'text/html; charset=utf-8' } }
//   );

/**
 * Escape a string for safe interpolation into HTML content or
 * attribute values. Handles null/undefined.
 *
 * Returns a raw-marked object (not a plain string) so the html tagged
 * template's renderValue() recognizes it as already-escaped and does
 * NOT escape it a second time. The toString() shim keeps it usable
 * inside plain template literals (`${escape(x)}` in a regular backtick
 * string) and any other place that coerces to string.
 *
 * Without this, JSON serialized into a data-* attribute via
 *   data-foo="${escape(JSON.stringify(obj))}"
 * gets the `&` in `&quot;` re-escaped to `&amp;quot;`, and the browser
 * decodes that back to literal text `&quot;` — which is not valid JSON.
 */
export function escape(value) {
  if (value === null || value === undefined) {
    return { __raw: '', toString() { return ''; } };
  }
  const escaped = String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  return { __raw: escaped, toString() { return escaped; } };
}

/**
 * Tagged template literal for HTML. Auto-escapes interpolated values
 * unless they are wrapped in raw() or are arrays (which are joined
 * with no separator and interpolated recursively).
 *
 *   html`<p>Hello ${user.name}</p>`                   // escapes user.name
 *   html`<div>${raw(someHtmlString)}</div>`           // injects literally
 *   html`<ul>${items.map((i) => html`<li>${i}</li>`)}</ul>`
 */
export function html(strings, ...values) {
  let out = '';
  for (let i = 0; i < strings.length; i++) {
    out += strings[i];
    if (i < values.length) {
      out += renderValue(values[i]);
    }
  }
  // Return a raw-marked object (not a plain string) so that nested
  // interpolations like  html`<ul>${html`<li>x</li>`}</ul>`  don't get
  // their inner HTML escaped by the outer template's renderValue(). The
  // toString() shim keeps plain template-literal usage working — e.g.
  // layout() interpolates `${body}` into a regular backtick string.
  return { __raw: out, toString() { return out; } };
}

/**
 * Mark a string as raw HTML — it will not be escaped when interpolated
 * via the `html` tagged template.
 */
export function raw(value) {
  const s = String(value ?? '');
  return { __raw: s, toString() { return s; } };
}

function renderValue(value) {
  if (value === null || value === undefined || value === false) return '';
  if (value && typeof value === 'object' && '__raw' in value) return value.__raw;
  if (Array.isArray(value)) return value.map(renderValue).join('');
  return escape(value);
}

import { VERSION } from './version.js';

// T4.2 Phase 1 — in-app notifications.
//
// Injected into every authenticated page. Registers an Alpine store
// named "notifications" that polls /notifications/unread every 30 seconds,
// updates the bell-icon badge count, and pushes new (unseen) notifications
// into a toast stack. The first poll after page load is silent — we
// populate the badge count but don't toast existing unreads, because
// spamming old unreads every page load would be annoying. Only truly
// NEW notifications (arriving while the page is open) become toasts.
//
// Deliberately no backticks or `${}` in this script so it can be dropped
// into a plain template literal in layout() without interpolation conflicts.
//
// Store method is named `start()` (not `init()`) to avoid Alpine v3's
// auto-invocation of store.init() — we want explicit control so the
// polling loop starts exactly once.
const NOTIFICATION_STORE_SCRIPT = (
  "document.addEventListener('alpine:init', function () {\n" +
  "  Alpine.store('notifications', {\n" +
  "    count: 0,\n" +
  "    toasts: [],\n" +
  "    seenIds: Object.create(null),\n" +
  "    primed: false,\n" +
  "    pollHandle: null,\n" +
  "    pollMs: 30000,\n" +
  "    start: function () {\n" +
  "      if (this.pollHandle) return;\n" +
  "      var self = this;\n" +
  "      self.poll();\n" +
  "      self.pollHandle = setInterval(function () { self.poll(); }, self.pollMs);\n" +
  "    },\n" +
  "    poll: function () {\n" +
  "      var self = this;\n" +
  "      fetch('/notifications/unread', { credentials: 'same-origin', headers: { 'accept': 'application/json' } })\n" +
  "        .then(function (res) { return res.ok ? res.json() : null; })\n" +
  "        .then(function (data) {\n" +
  "          if (!data || !Array.isArray(data.unread)) return;\n" +
  "          self.count = data.unread.length;\n" +
  "          if (!self.primed) {\n" +
  "            for (var i = 0; i < data.unread.length; i++) self.seenIds[data.unread[i].id] = true;\n" +
  "            self.primed = true;\n" +
  "            return;\n" +
  "          }\n" +
  "          for (var j = 0; j < data.unread.length; j++) {\n" +
  "            var n = data.unread[j];\n" +
  "            if (!self.seenIds[n.id]) {\n" +
  "              self.seenIds[n.id] = true;\n" +
  "              self.toasts.push(n);\n" +
  "              (function (notification) {\n" +
  "                setTimeout(function () { self.dismissToast(notification); }, 8000);\n" +
  "              })(n);\n" +
  "            }\n" +
  "          }\n" +
  "        })\n" +
  "        .catch(function () { /* network error, ignore */ });\n" +
  "    },\n" +
  "    dismissToast: function (n) {\n" +
  "      if (!n) return;\n" +
  "      for (var i = 0; i < this.toasts.length; i++) {\n" +
  "        if (this.toasts[i].id === n.id) { this.toasts.splice(i, 1); return; }\n" +
  "      }\n" +
  "    },\n" +
  "    clickToast: function (n) {\n" +
  "      if (!n) return;\n" +
  "      var self = this;\n" +
  "      var target = n.link_url;\n" +
  "      fetch('/notifications/' + encodeURIComponent(n.id) + '/read', {\n" +
  "        method: 'POST',\n" +
  "        credentials: 'same-origin',\n" +
  "        headers: { 'accept': 'application/json' }\n" +
  "      }).catch(function () { /* ignore */ });\n" +
  "      self.dismissToast(n);\n" +
  "      self.count = Math.max(0, self.count - 1);\n" +
  "      if (target) window.location.href = target;\n" +
  "    }\n" +
  "  });\n" +
  "  Alpine.store('notifications').start();\n" +
  "});\n"
);

// Global wizard modal — Alpine store + injected markup.
//
// One modal, many wizards. Each wizard (task, account, contact,
// opportunity, quote, job) is a small config file under /js/wizards/
// that registers itself with the engine in /js/wizard-modal.js.
//
// Opened via:
//   <button onclick="window.PMS.openWizard('task', { opportunity_id: '...' })">+ Task</button>
//   <button onclick="window.PMS.openWizard('account', {})">+ New account</button>
//
// or via a custom event:
//   window.dispatchEvent(new CustomEvent('pms:open-wizard',
//     { detail: { key: 'account', prefill: {} } }))
//
// Back-compat: window.PMS.openTaskModal(prefill) maps to openWizard('task', prefill).
//
// Picker data (users, open opps, recent quotes, accounts) is fetched
// lazily from /activities/picker-data the first time a wizard with a
// user-select or entity-select step opens on a page.
//
// All wizard logic (date parsing, fuzzy match, step state, submit)
// lives in /js/wizard-modal.js. This markup is just the static DOM.
// Uses string concatenation (no template literals) so it drops into
// layout()'s shell without escaping issues.
const WIZARD_MODAL_MARKUP = (
  '<div class="task-modal-overlay" x-data x-show="$store.wizard.open" x-cloak ' +
  '@keydown.escape.window="$store.wizard.closeModal()" ' +
  '@click.self="$store.wizard.closeModal()" style="display:none">' +
  '<div class="task-modal task-modal-wizard" @click.stop>' +
  '<div class="task-modal-header">' +
  '<h3 x-text="$store.wizard.title()"></h3>' +
  '<button type="button" class="task-modal-close" @click="$store.wizard.closeModal()" aria-label="Close">&times;</button>' +
  '</div>' +
  '<div class="task-modal-body">' +

  // Pinned row (e.g. "Linked to: <record>") — only shown if the wizard
  // config's applyPrefill returned { locked: true, label: ... }.
  '<div class="task-wizard-pinned" x-show="$store.wizard.pinnedValue">' +
  '<span class="task-wizard-pinned-label" x-text="$store.wizard.pinnedPrefix"></span>' +
  '<strong x-text="$store.wizard.pinnedValue"></strong>' +
  '</div>' +

  // Big prompt (the current step's question)
  '<div class="task-wizard-prompt" x-text="$store.wizard.currentPrompt()"></div>' +

  // Input area: textarea / text input / select depending on step.type.
  '<div class="task-wizard-input-wrap">' +

  // Textarea (multi-line text)
  '<template x-if="$store.wizard.isMultilineStep()">' +
  '<textarea id="wizard-input" class="task-wizard-input task-wizard-input-textarea" ' +
  'x-model="$store.wizard.typedInput" ' +
  '@input="$store.wizard.onInputChange()" ' +
  '@keydown.tab.prevent="$store.wizard.advance()" ' +
  '@keydown.shift.tab.prevent="$store.wizard.goBack()" ' +
  'rows="3" ' +
  ':placeholder="$store.wizard.currentPlaceholder()" autocomplete="off"></textarea>' +
  '</template>' +

  // Select (dropdown)
  '<template x-if="$store.wizard.isSelectStep()">' +
  '<select id="wizard-input" class="task-wizard-input" ' +
  'x-model="$store.wizard.typedInput" ' +
  '@keydown.tab.prevent="$store.wizard.advance()" ' +
  '@keydown.shift.tab.prevent="$store.wizard.goBack()" ' +
  '@keydown.enter.prevent="$store.wizard.advance()">' +
  '<template x-for="opt in $store.wizard.selectOptions()" :key="opt.value">' +
  '<option :value="opt.value" x-text="opt.label"></option>' +
  '</template>' +
  '</select>' +
  '</template>' +

  // Single-line input (text / date / user-select / entity-select)
  '<template x-if="!$store.wizard.isMultilineStep() && !$store.wizard.isSelectStep()">' +
  '<input id="wizard-input" class="task-wizard-input" type="text" ' +
  'x-model="$store.wizard.typedInput" ' +
  '@input="$store.wizard.onInputChange()" ' +
  '@keydown.tab.prevent="$store.wizard.advance()" ' +
  '@keydown.shift.tab.prevent="$store.wizard.goBack()" ' +
  '@keydown.enter.prevent="$store.wizard.advance()" ' +
  '@keydown.arrow-down.prevent="$store.wizard.moveSuggestion(1)" ' +
  '@keydown.arrow-up.prevent="$store.wizard.moveSuggestion(-1)" ' +
  ':placeholder="$store.wizard.currentPlaceholder()" autocomplete="off">' +
  '</template>' +

  // Suggestions dropdown (user-select + entity-select steps).
  '<div class="task-wizard-suggestions" x-show="$store.wizard.visibleSuggestions().length > 0">' +
  '<template x-for="(sug, idx) in $store.wizard.visibleSuggestions()" :key="sug.id">' +
  '<button type="button" class="task-wizard-suggestion" ' +
  ':class="idx === $store.wizard.suggestionIndex ? \'active\' : \'\'" ' +
  '@mouseenter="$store.wizard.suggestionIndex = idx" ' +
  '@click="$store.wizard.pickSuggestion(idx)">' +
  '<span class="task-wizard-suggestion-type" x-text="sug.typeLabel" x-show="sug.typeLabel"></span>' +
  '<span class="task-wizard-suggestion-main" x-text="sug.label"></span>' +
  '<span class="task-wizard-suggestion-sub" x-text="sug.sub" x-show="sug.sub"></span>' +
  '</button>' +
  '</template>' +
  '</div>' +

  '</div>' + // /.task-wizard-input-wrap

  // Action bar: hint on the left, Back + submit on the right.
  '<div class="task-wizard-actionbar">' +
  '<span class="task-wizard-help" x-text="$store.wizard.currentHint()"></span>' +
  '<div class="task-wizard-actions">' +
  '<button type="button" class="btn btn-sm" @click="$store.wizard.goBack()" ' +
  ':disabled="$store.wizard.stepIndex === 0 || $store.wizard.submitting" ' +
  'x-show="$store.wizard.stepIndex > 0">Back</button>' +
  '<button type="button" class="btn btn-sm primary" ' +
  '@click="$store.wizard.submit()" ' +
  ':disabled="!$store.wizard.canSubmit() || $store.wizard.submitting">' +
  '<span x-show="!$store.wizard.submitting" x-text="$store.wizard.submitLabel()"></span>' +
  '<span x-show="$store.wizard.submitting">Saving\u2026</span>' +
  '</button>' +
  '</div>' +
  '</div>' +

  // Error message
  '<div class="task-modal-error" x-show="$store.wizard.error" x-text="$store.wizard.error"></div>' +

  '</div>' + // /.task-modal-body
  '</div>' + // /.task-modal
  '</div>'   // /.task-modal-overlay
);

// Board sidebars — split into two fixed-positioned panels that sit in
// the free space to the left and right of the centered .site-main
// content (max-width 1100px). Both share the same Alpine $store.board.
//
// Right panel:  Tasks (with click-to-toggle dots, hover "show complete")
//                + Notes (sticky-pad stack with inline composer/edit)
// Left  panel:  Messages (chat bubbles with always-open composer at bottom)
//
// Both panels are hidden via @media when the viewport doesn't have
// enough free margin to host them — the centered content always wins.
const BOARD_RIGHT_MARKUP = (
  '<div class="board-root board-root-right" x-data x-cloak>' +

  // (Restore button when collapsed lives in the header next to the
  // notification bell \u2014 see BOARD_RESTORE_HEADER_BTN.)

  '<aside class="board-sidebar board-sidebar-right" ' +
    'x-show="$store.board && !$store.board.isCollapsed" ' +
    'aria-label="Whiteboard sidebar">' +

    // ---------- Zone 1a: To-Do (overdue + today + tomorrow) ----------
    '<section class="board-zone board-zone-tasks" ' +
      ':class="$store.board.showCompleted ? \'board-tasks-show-done\' : \'\'">' +
      // Hide button \u2014 small chevron pointing right (toward the edge
      // the board collapses into). Lives on the topmost task card and
      // hides both sidebars for 5 min on click.
      '<button type="button" class="board-hide-peek" ' +
        '@click="$store.board.hideFor(5)" ' +
        'title="Hide board for 5 min" aria-label="Hide board">' +
        '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">' +
          '<polygon points="5,3 12,8 5,13"/>' +
        '</svg>' +
      '</button>' +
      '<h3 class="board-zone-heading">To-Do</h3>' +
      '<button type="button" class="board-tasks-toggle" ' +
        ':class="$store.board.showCompleted ? \'active\' : \'\'" ' +
        '@click="$store.board.toggleShowCompleted()" ' +
        'x-text="$store.board.showCompleted ? \'hide complete\' : \'show complete\'"></button>' +
      '<template x-if="$store.board.todoTasks.length === 0">' +
        '<p class="board-zone-empty">Nothing due today or tomorrow.</p>' +
      '</template>' +
      '<ul class="board-task-list">' +
        '<template x-for="t in $store.board.todoTasks" :key="t.id">' +
          '<li :class="$store.board.taskItemClass(t)">' +
            '<button type="button" class="board-task-dot" ' +
              ':title="t.status === \'completed\' ? \'Mark incomplete\' : \'Mark complete\'" ' +
              '@click.stop="$store.board.toggleTask(t)"></button>' +
            '<span class="board-task-prefix" ' +
              'x-text="$store.board.taskPrefix(t)" ' +
              'x-show="$store.board.taskPrefix(t)"></span>' +
            '<a :href="\'/activities\'" class="board-task-link">' +
              '<span class="board-task-text" ' +
                'x-html="$store.board.renderBody((t.subject || t.body || \'\'))"></span>' +
            '</a>' +
            '<button type="button" class="board-task-delete" ' +
              '@click.stop="$store.board.deleteTask(t)" ' +
              'title="Delete task" aria-label="Delete task">\u00D7</button>' +
          '</li>' +
        '</template>' +
      '</ul>' +
    '</section>' +

    // ---------- Zone 1b: Coming Soon (2\u20137 days out) ----------
    '<section class="board-zone board-zone-tasks">' +
      '<h3 class="board-zone-heading">Coming Soon</h3>' +
      '<template x-if="$store.board.comingSoonTasks.length === 0">' +
        '<p class="board-zone-empty">Nothing in the next week.</p>' +
      '</template>' +
      '<ul class="board-task-list">' +
        '<template x-for="t in $store.board.comingSoonTasks" :key="t.id">' +
          '<li :class="$store.board.taskItemClass(t)">' +
            '<button type="button" class="board-task-dot" ' +
              ':title="t.status === \'completed\' ? \'Mark incomplete\' : \'Mark complete\'" ' +
              '@click.stop="$store.board.toggleTask(t)"></button>' +
            '<span class="board-task-prefix" ' +
              'x-text="$store.board.taskPrefix(t)" ' +
              'x-show="$store.board.taskPrefix(t)"></span>' +
            '<a :href="\'/activities\'" class="board-task-link">' +
              '<span class="board-task-text" ' +
                'x-html="$store.board.renderBody((t.subject || t.body || \'\'))"></span>' +
            '</a>' +
            '<button type="button" class="board-task-delete" ' +
              '@click.stop="$store.board.deleteTask(t)" ' +
              'title="Delete task" aria-label="Delete task">\u00D7</button>' +
          '</li>' +
        '</template>' +
      '</ul>' +
    '</section>' +

    // ---------- Zone 2: Notes (sticky note pad) ----------
    '<section class="board-zone board-zone-notes">' +

      // Compose stack — five blank colored cards, or the active composer
      '<div class="board-notes-stack" x-show="!$store.board.composer.open">' +
        '<button type="button" class="board-stack-note board-stack-note-yellow" ' +
          'title="New yellow post-it" aria-label="New yellow post-it" ' +
          '@click="$store.board.openComposer({ color: \'yellow\' })"></button>' +
        '<button type="button" class="board-stack-note board-stack-note-pink" ' +
          'title="New pink post-it" aria-label="New pink post-it" ' +
          '@click="$store.board.openComposer({ color: \'pink\' })"></button>' +
        '<button type="button" class="board-stack-note board-stack-note-blue" ' +
          'title="New blue post-it" aria-label="New blue post-it" ' +
          '@click="$store.board.openComposer({ color: \'blue\' })"></button>' +
        '<button type="button" class="board-stack-note board-stack-note-green" ' +
          'title="New green post-it" aria-label="New green post-it" ' +
          '@click="$store.board.openComposer({ color: \'green\' })"></button>' +
        '<button type="button" class="board-stack-note board-stack-note-orange" ' +
          'title="New orange post-it" aria-label="New orange post-it" ' +
          '@click="$store.board.openComposer({ color: \'orange\' })"></button>' +
      '</div>' +

      // Active composer (slides over stack when open). Enter saves,
      // Escape cancels. No save/cancel buttons. Delete = X (top-right
      // on hover) which only appears when editing an existing card,
      // so the composer here doesn't show one.
      '<div :class="\'board-composer board-card board-card-color-\' + $store.board.composer.color" ' +
        'x-show="$store.board.composer.open" x-cloak>' +
        '<textarea id="board-composer-textarea" class="board-composer-textarea" ' +
          'rows="2" placeholder="Jot a post-it\u2026 (@ to link, Enter to save, Esc to cancel)" ' +
          ':value="$store.board.composer.body" ' +
          '@input="$store.board.onBodyInput(\'composer\', $event.target)" ' +
          '@keydown="$store.board.onBodyKeydown(\'composer\', $event.target, $event)"></textarea>' +
        '<div class="board-mention-popup" ' +
          'x-show="$store.board.mention.active && $store.board.mention.for === \'composer\' && $store.board.mention.results.length" x-cloak>' +
          '<template x-for="(r, i) in $store.board.mention.results" :key="r.ref_type + r.ref_id">' +
            '<button type="button" class="board-mention-opt" ' +
              ':class="{ active: i === $store.board.mention.selectedIndex }" ' +
              '@click="$store.board.pickMention(r, document.getElementById(\'board-composer-textarea\'))">' +
              '<span class="board-mention-type" x-text="r.ref_type"></span>' +
              '<span class="board-mention-label" x-text="r.label"></span>' +
              '<small x-text="r.sub"></small>' +
            '</button>' +
          '</template>' +
        '</div>' +
        '<div class="board-composer-toolbar">' +
          '<div class="board-color-picker">' +
            '<button type="button" ' +
              ':class="\'board-color-current color-\' + $store.board.composer.color" ' +
              'title="Color" aria-label="Color"></button>' +
            '<div class="board-color-options">' +
              '<template x-for="c in $store.board.colors" :key="c">' +
                '<button type="button" class="board-color-swatch" ' +
                  ':class="\'board-color-swatch-\' + c + ($store.board.composer.color === c ? \' selected\' : \'\')" ' +
                  ':title="c" ' +
                  '@click="$store.board.composer.color = c"></button>' +
              '</template>' +
            '</div>' +
          '</div>' +
          '<span class="board-composer-error" x-show="$store.board.composer.error" x-text="$store.board.composer.error"></span>' +
          // Sharing is purely @-mention driven: a plain note stays private,
          // but @Someone adds that user to board_card_refs and the note
          // shows up in their Mentions module. Hint at this in the corner.
          '<span class="board-composer-share-hint" ' +
            ':title="$store.board.composer.body.indexOf(\'@\') >= 0 ? \'This post-it will be shared with mentioned users.\' : \'Only you will see this. Type @ to share with someone.\'" ' +
            'x-text="$store.board.composer.body.indexOf(\'@\') >= 0 ? \'Shared\' : \'Private\'"></span>' +
        '</div>' +
      '</div>' +

      // Saved notes (private + shared + public-mentions) — below the
      // stack. The .is-pulled modifier applies a negative margin-top
      // so the list snugs up under the color-swatch stack; when the
      // composer is open instead of the stack, we drop the pull so
      // the composer card doesn\u2019t collide with the first saved note.
      '<div :class="\'board-notes-list\' + ($store.board.composer.open ? \'\' : \' is-pulled\')">' +
        '<template x-for="card in $store.board.allNotes" :key="card.id">' +
          // Wrapper holds the primary card + any "extra pages" when
          // a long body has been split. Classes drive the collapsed
          // stacked-paper look (single peeking edge) vs. expanded
          // stack of full cards. draggable=true is gated to private
          // notes only (your own notepad) so cross-user reorders
          // can\u2019t happen \u2014 see isDraggable() in board-sidebar.js.
          '<div :class="\'board-card-stack \' + ' +
            '($store.board.hasMorePages(card) ? \'board-card-stack-multi \' : \'\') + ' +
            '($store.board.isDraggable(card) ? \'is-draggable \' : \'\') + ' +
            '($store.board.drag.id === card.id ? \'is-dragging \' : \'\') + ' +
            '($store.board.drag.targetId === card.id ? (\'drag-over-\' + ($store.board.drag.mode || \'above\') + \' \') : \'\') + ' +
            '(card.__expanded ? \'is-expanded\' : \'is-collapsed\')" ' +
            // draggable is hardcoded to "true" (string literal) rather
            // than bound via :draggable \u2014 Alpine\u2019s reactive binding for
            // this attribute is unreliable across browsers. onDragStart
            // calls preventDefault() for cards the user shouldn\u2019t be
            // allowed to move (non-private, editing, etc.).
            'draggable="true" ' +
            '@dragstart="$store.board.onDragStart(card, $event)" ' +
            '@dragover="$store.board.onDragOver(card, $event)" ' +
            '@dragleave="$store.board.onDragLeave(card)" ' +
            '@drop="$store.board.onDrop(card, $event)" ' +
            '@dragend="$store.board.onDragEnd()">' +
          '<article :class="$store.board.cardClass(card)">' +

            // Pin + Copy + X delete on hover (opacity controlled by CSS).
            // Pin stays visible when active even on un-hover. All three
            // skipped while in edit mode to avoid competing affordances.
            '<button type="button" class="board-card-pin" ' +
              ':class="card.pinned ? \'is-pinned\' : \'\'" ' +
              'x-show="$store.board.editing.cardId !== card.id" ' +
              '@click.stop="$store.board.togglePin(card)" ' +
              ':title="card.pinned ? \'Unpin\' : \'Pin to top\'" ' +
              ':aria-label="card.pinned ? \'Unpin\' : \'Pin to top\'">\u{1F4CC}</button>' +
            '<button type="button" class="board-card-copy" ' +
              'x-show="$store.board.editing.cardId !== card.id" ' +
              '@click.stop="$store.board.copyCard(card)" ' +
              ':title="card.__copied ? \'Copied!\' : \'Copy text\'" ' +
              'aria-label="Copy text">' +
              '<span x-show="!card.__copied">\u29C9</span>' +
              '<span x-show="card.__copied" x-cloak>\u2713</span>' +
            '</button>' +
            '<button type="button" class="board-card-delete" ' +
              'x-show="$store.board.editing.cardId !== card.id" ' +
              '@click.stop="$store.board.archiveCard(card)" ' +
              'title="Delete" aria-label="Delete">\u00D7</button>' +

            '<template x-if="$store.board.editing.cardId === card.id">' +
              '<div class="board-card-editing">' +
                '<textarea :id="\'board-edit-textarea-\' + card.id" ' +
                  'class="board-card-edit-textarea" rows="2" ' +
                  ':value="$store.board.editing.body" ' +
                  '@input="$store.board.onBodyInput(\'editing\', $event.target)" ' +
                  '@keydown="$store.board.onBodyKeydown(\'editing\', $event.target, $event)"></textarea>' +
                '<div class="board-mention-popup" ' +
                  'x-show="$store.board.mention.active && $store.board.mention.for === \'editing\' && $store.board.mention.results.length" x-cloak>' +
                  '<template x-for="(r, i) in $store.board.mention.results" :key="r.ref_type + r.ref_id">' +
                    '<button type="button" class="board-mention-opt" ' +
                      ':class="{ active: i === $store.board.mention.selectedIndex }" ' +
                      '@click="$store.board.pickMention(r, document.getElementById(\'board-edit-textarea-\' + card.id))">' +
                      '<span class="board-mention-type" x-text="r.ref_type"></span>' +
                      '<span class="board-mention-label" x-text="r.label"></span>' +
                      '<small x-text="r.sub"></small>' +
                    '</button>' +
                  '</template>' +
                '</div>' +
                '<div class="board-composer-toolbar">' +
                  '<div class="board-color-picker">' +
                    '<button type="button" ' +
                      ':class="\'board-color-current color-\' + $store.board.editing.color" ' +
                      'title="Color" aria-label="Color"></button>' +
                    '<div class="board-color-options">' +
                      '<template x-for="c in $store.board.colors" :key="c">' +
                        '<button type="button" class="board-color-swatch" ' +
                          ':class="\'board-color-swatch-\' + c + ($store.board.editing.color === c ? \' selected\' : \'\')" ' +
                          '@click="$store.board.editing.color = c"></button>' +
                      '</template>' +
                    '</div>' +
                  '</div>' +
                  '<span class="board-composer-error" x-show="$store.board.editing.error" x-text="$store.board.editing.error"></span>' +
                  '<span class="board-composer-share-hint" ' +
                    ':title="$store.board.editing.body.indexOf(\'@\') >= 0 ? \'This post-it is shared with mentioned users.\' : \'Only you will see this. Type @ to share with someone.\'" ' +
                    'x-text="$store.board.editing.body.indexOf(\'@\') >= 0 ? \'Shared\' : \'Private\'"></span>' +
                '</div>' +
              '</div>' +
            '</template>' +

            '<template x-if="$store.board.editing.cardId !== card.id">' +
              '<div class="board-card-body" ' +
                'x-html="$store.board.renderBody($store.board.firstPage(card))" ' +
                '@click="$store.board.startEdit(card)"></div>' +
            '</template>' +

            // "+N more" / "Hide pages" toggle \u2014 only appears when the
            // body has been split into 2+ pages and we\u2019re not in edit
            // mode. Sits in the bottom-right corner of the first card.
            '<button type="button" class="board-card-pages-toggle" ' +
              'x-show="$store.board.hasMorePages(card) && $store.board.editing.cardId !== card.id" ' +
              '@click.stop="$store.board.toggleExpand(card)" ' +
              'x-text="card.__expanded ? \'Hide pages\' : (\'+\' + ($store.board.cardPages(card).length - 1) + \' more\')"></button>' +

          '</article>' +

          // Extra pages \u2014 only rendered when expanded. Each is a full
          // card sharing the same color/tilt-from-id seed so the
          // stack reads as one note. Click any extra page to enter
          // edit mode on the parent card.
          '<template x-if="$store.board.hasMorePages(card) && card.__expanded && $store.board.editing.cardId !== card.id">' +
            '<template x-for="(p, i) in $store.board.extraPages(card)" :key="i">' +
              '<article :class="$store.board.cardClass(card) + \' board-card-page-extra\'">' +
                '<div class="board-card-body" ' +
                  'x-html="$store.board.renderBody(p)" ' +
                  '@click="$store.board.startEdit(card)"></div>' +
              '</article>' +
            '</template>' +
          '</template>' +

          '</div>' + // /.board-card-stack
        '</template>' +
      '</div>' +

    '</section>' +

  '</aside>' +
  '</div>' // /.board-root-right
);

const BOARD_LEFT_MARKUP = (
  '<div class="board-root board-root-left" x-data x-cloak>' +
    '<aside class="board-sidebar board-sidebar-left" ' +
      'x-show="$store.board && !$store.board.isCollapsed" ' +
      'aria-label="Messages sidebar">' +

      '<h3 class="board-zone-heading">Message Everyone</h3>' +

      // Always-open composer at the top \u2014 sits exactly where the
      // next new message will land. Type, hit Enter to send,
      // Shift+Enter for newline, Escape to clear. @user mention directs
      // the message; no mentions \u2192 broadcast to everyone.
      '<div class="board-message-composer">' +
        '<textarea id="board-message-textarea" class="board-message-textarea" ' +
          'rows="1" placeholder="Type a message\u2026 (@ to address someone)" ' +
          ':value="$store.board.messageComposer.body" ' +
          '@input="$store.board.onBodyInput(\'messageComposer\', $event.target)" ' +
          '@keydown="$store.board.onBodyKeydown(\'messageComposer\', $event.target, $event)"></textarea>' +
        '<div class="board-mention-popup" ' +
          'x-show="$store.board.mention.active && $store.board.mention.for === \'messageComposer\' && $store.board.mention.results.length" x-cloak>' +
          '<template x-for="(r, i) in $store.board.mention.results" :key="r.ref_type + r.ref_id">' +
            '<button type="button" class="board-mention-opt" ' +
              ':class="{ active: i === $store.board.mention.selectedIndex }" ' +
              '@click="$store.board.pickMention(r, document.getElementById(\'board-message-textarea\'))">' +
              '<span class="board-mention-type" x-text="r.ref_type"></span>' +
              '<span class="board-mention-label" x-text="r.label"></span>' +
            '</button>' +
          '</template>' +
        '</div>' +
        '<div class="board-message-error" x-show="$store.board.messageComposer.error" ' +
          'x-text="$store.board.messageComposer.error"></div>' +
      '</div>' +

      // Scrollable message list (chat thread, newest \u2192 oldest).
      // Sits below the composer so each new send lands right against it.
      '<div class="board-message-list" x-ref="msgList">' +
        '<template x-if="$store.board.messages.length === 0">' +
          '<p class="board-zone-empty">No messages yet \u2014 say hi.</p>' +
        '</template>' +
        '<template x-for="msg in $store.board.messages" :key="msg.id">' +
          '<div :class="\'board-message board-message-\' + (msg.from_me ? \'out\' : \'in\') + (msg.flag === \'red\' ? \' is-emphasized\' : \'\')">' +
            // Emphasize \u2605 + delete \u00D7 \u2014 author-only, on hover.
            // Emphasize stays visible at rest when active so the
            // recipient can see at a glance which messages were
            // marked important by their author.
            '<button type="button" class="board-message-emphasize" ' +
              ':class="msg.flag === \'red\' ? \'is-on\' : \'\'" ' +
              'x-show="msg.from_me" ' +
              '@click.stop="$store.board.toggleEmphasize(msg)" ' +
              ':title="msg.flag === \'red\' ? \'Remove emphasis\' : \'Emphasize\'" ' +
              ':aria-label="msg.flag === \'red\' ? \'Remove emphasis\' : \'Emphasize\'">\u2605</button>' +
            '<button type="button" class="board-message-delete" ' +
              'x-show="msg.from_me" ' +
              '@click.stop="$store.board.deleteMessage(msg)" ' +
              'title="Delete message" aria-label="Delete message">\u00D7</button>' +
            '<span class="board-message-prefix" x-text="$store.board.messagePrefix(msg) + \'-\'"></span>' +
            '<span class="board-message-body" x-html="$store.board.renderBody(msg.body)"></span>' +
          '</div>' +
        '</template>' +
      '</div>' +

    '</aside>' +
  '</div>'
);

// Display-prefs gear button + popup — sits in .header-right, just
// left of the notification bell. Two per-user toggles (migration
// 0034): "Show aliases" and "Group accounts". Each toggle PATCHes
// /user/prefs and reloads the page so server-rendered lists pick up
// the new values immediately.
//
// We reuse the .quote-settings CSS classes (originally built for the
// quote-page gear icon) since the visual is identical.
const DISPLAY_PREFS_HEADER_BTN = (
  '<div class="quote-settings" x-data="displayPrefs()" @click.outside="open = false">' +
    '<button type="button" class="quote-settings-btn" @click="open = !open" ' +
      'aria-label="Display settings" title="Display settings">' +
      '<svg class="quote-settings-icon" viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">' +
        '<path d="M19.14 12.94c.04-.31.06-.62.06-.94 0-.32-.02-.63-.06-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.5.5 0 0 0-.58-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84a.48.48 0 0 0-.48.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.48.48 0 0 0-.58.22L2.74 8.87a.49.49 0 0 0 .12.61l2.03 1.58c-.04.31-.06.62-.06.94 0 .32.02.63.06.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.39.31.6.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.25.41.49.41h3.84c.24 0 .45-.17.48-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.23.09.5 0 .6-.22l1.92-3.32c.12-.22.07-.49-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 0 1 8.4 12 3.6 3.6 0 0 1 12 8.4a3.6 3.6 0 0 1 3.6 3.6 3.6 3.6 0 0 1-3.6 3.6z"/>' +
      '</svg>' +
    '</button>' +
    '<div class="quote-settings-panel" x-show="open" x-cloak @click.stop>' +
      '<div class="quote-settings-row">' +
        '<div class="quote-settings-label">' +
          '<strong>Show aliases</strong>' +
          '<span>Display the conversational alias instead of the legal account name everywhere — lists, columns, dropdowns, mentions.</span>' +
        '</div>' +
        '<label class="toggle-switch" :class="{ \'toggle-switch--on\': showAlias }">' +
          '<input type="checkbox" :checked="showAlias" @change="save(\'show_alias\', $event.target.checked)">' +
          '<span class="toggle-slider"></span>' +
        '</label>' +
      '</div>' +
      '<div class="quote-settings-row" style="margin-top:0.6rem;padding-top:0.6rem;border-top:1px solid var(--border)">' +
        '<div class="quote-settings-label">' +
          '<strong>Group accounts</strong>' +
          '<span>Roll grouped accounts into one row on the Accounts list, and show the group label on opportunity / quote / task lists. Creating a new entity prompts you to pick which member account it\'s for.</span>' +
        '</div>' +
        '<label class="toggle-switch" :class="{ \'toggle-switch--on\': groupRollup }">' +
          '<input type="checkbox" :checked="groupRollup" @change="save(\'group_rollup\', $event.target.checked)">' +
          '<span class="toggle-slider"></span>' +
        '</label>' +
      '</div>' +
    '</div>' +
  '</div>'
);

// Header restore button \u2014 sits in .header-right, just left of the
// notification bell. Only visible when the board has been hidden via
// the X (or any other reason `isCollapsed` is true). Clicking it
// expands both sidebars in one shot.
const BOARD_RESTORE_HEADER_BTN = (
  '<button type="button" class="board-restore-btn" x-data x-cloak ' +
    'x-show="$store.board && $store.board.isCollapsed" ' +
    '@click="$store.board.expandNow()" ' +
    'aria-label="Open board" title="Open board">' +
    '<svg class="board-restore-icon" viewBox="0 0 24 24" width="20" height="20" ' +
      'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true">' +
      // Sticky-note silhouette with a corner fold.
      '<path d="M4 4h12l4 4v12H4z"/>' +
      '<path d="M16 4v4h4"/>' +
    '</svg>' +
    '<span class="board-restore-badge" ' +
      'x-show="$store.board && $store.board.collapsedBadge > 0" ' +
      'x-text="$store.board && $store.board.collapsedBadge"></span>' +
  '</button>'
);

// (Previously the sidebar overlaid the page and required body-class
// gymnastics to push main-content padding. Sidebars now sit in the
// natural left/right margin of the centered .site-main, so no body
// class is needed — they just appear or disappear via @media.)

/**
 * Full-page HTML shell: includes nav, user badge, and slot for body.
 * Vendored HTMX + Alpine from /js so Access + CSP don't fight CDN cross-origin.
 *
 * opts.breadcrumbs — optional array of { label, href? } for the breadcrumb trail.
 */
export function layout(title, body, opts = {}) {
  const { user, flash, activeNav, breadcrumbs } = opts;
  const pageTitle = title ? `${escape(title)} — C-LARS PMS` : 'C-LARS PMS';
  const versionTag = VERSION ? `v${escape(VERSION)}` : '';

  const breadcrumbHtml = breadcrumbs && breadcrumbs.length
    ? `<nav class="breadcrumbs" aria-label="breadcrumb">${breadcrumbs.map((b, i) => {
        const sep = i > 0 ? '<span class="bc-sep">/</span>' : '';
        return b.href
          ? `${sep}<a href="${escape(b.href)}">${escape(b.label)}</a>`
          : `${sep}<span class="bc-current">${escape(b.label)}</span>`;
      }).join('')}</nav>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${pageTitle}</title>
  <link rel="icon" type="image/svg+xml" href="/img/logo.svg">
  <link rel="icon" type="image/png" sizes="120x120" href="/img/logo-120.png">
  <link rel="stylesheet" href="/css/pms.css">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Caveat:wght@400;600;700&family=Kalam:wght@300;400;700&display=swap" rel="stylesheet">
  <script defer src="/js/htmx.min.js"></script>
  <!-- wizard-modal.js (engine) + per-wizard configs MUST load before
       alpine.min.js. Alpine 3's bundle auto-calls Alpine.start() as
       soon as it parses, which fires 'alpine:init' synchronously. Any
       listener added after that is too late and the store never
       registers. Defer preserves source-order execution. -->
  <script defer src="/js/wizard-modal.js"></script>
  <script defer src="/js/wizards/task.js"></script>
  <script defer src="/js/wizards/account.js"></script>
  <script defer src="/js/wizards/quote.js"></script>
  ${user ? '<script defer src="/js/board-sidebar.js"></script>' : ''}
  <script defer src="/js/alpine.min.js"></script>
  <script defer src="/js/live-calc.js"></script>
  <script defer src="/js/account-picker.js"></script>
  <script defer src="/js/table-resize.js"></script>
  ${opts.charts ? '<script defer src="/js/chart.min.js"></script>' : ''}
</head>
<body>
  <header class="site-header">
    <div class="brand">
      <a href="/"><img src="/img/logo-120.png" alt="C-LARS" class="brand-logo"><strong>PMS</strong></a>
    </div>
    <nav class="site-nav">
      ${navLink('/accounts', 'Accounts', activeNav)}
      ${navLink('/opportunities', 'Opportunities', activeNav)}
      ${navLink('/quotes', 'Quotes', activeNav)}
      ${navLink('/activities', 'Tasks', activeNav)}
      ${navLink('/documents/library', 'Documents', activeNav)}
      ${navLink('/library', 'Library', activeNav)}
      ${navLink('/reports', 'Reports', activeNav)}
      ${navLink('/jobs', 'Jobs', activeNav)}
    </nav>
    <div class="header-right">
      ${user ? BOARD_RESTORE_HEADER_BTN : ''}
      ${user ? DISPLAY_PREFS_HEADER_BTN : ''}
      ${user ? `<a href="/notifications" class="notification-bell" aria-label="Notifications" x-data>
        <svg class="notification-bell-icon" viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
          <path d="M12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2zm6-6V11a6 6 0 0 0-4.5-5.81V5a1.5 1.5 0 0 0-3 0v.19A6 6 0 0 0 6 11v5l-2 2v1h16v-1l-2-2z"/>
        </svg>
        <span class="notification-badge" x-show="$store.notifications && $store.notifications.count > 0" x-text="$store.notifications && $store.notifications.count" x-cloak></span>
      </a>` : ''}
      <div class="user-badge">
        ${user ? `<span class="user-name">${escape(user.display_name ?? user.email)}</span>
                   <span class="user-role">${escape(user.email ?? '')} · ${escape(user.role)}</span>` : '<span>Not signed in</span>'}
      </div>
    </div>
    <img src="/img/beta_banner.png" alt="BETA VERSION" class="beta-banner">
  </header>
  ${user ? `<div class="notification-toast-stack" x-data x-cloak>
    <template x-for="toast in ($store.notifications && $store.notifications.toasts) || []" :key="toast.id">
      <div class="notification-toast" @click="$store.notifications.clickToast(toast)">
        <button type="button" class="notification-toast-close" @click.stop="$store.notifications.dismissToast(toast)" aria-label="Dismiss">&times;</button>
        <div class="notification-toast-title" x-text="toast.title"></div>
        <div class="notification-toast-body" x-show="toast.body" x-text="toast.body"></div>
      </div>
    </template>
  </div>
  ${WIZARD_MODAL_MARKUP}
  ${BOARD_LEFT_MARKUP}
  ${BOARD_RIGHT_MARKUP}` : ''}
  ${flash ? `<div class="flash flash-${escape(flash.kind ?? 'info')}">${escape(flash.message)}</div>` : ''}
  <main class="site-main">
${breadcrumbHtml}
${body}
  </main>
  <footer class="site-footer">
    <small>C-LARS Pipeline Management System</small>
  </footer>
  ${versionTag ? `<div class="version-badge">${versionTag}</div>` : ''}
  ${user ? `<script>${NOTIFICATION_STORE_SCRIPT}</script>` : ''}
  ${user ? `<script>${displayPrefsBootScript(user)}</script>` : ''}
</body>
</html>`;
}

// Inline boot script for the display-prefs gear popup. Registers the
// Alpine.data factory and exposes the current user's prefs to client
// code (account-picker.js, wizards) via window.PMS.userPrefs so they
// can branch on show_alias / group_rollup without a server round-trip.
function displayPrefsBootScript(user) {
  const showAlias = user && user.show_alias ? 1 : 0;
  const groupRollup = user && user.group_rollup ? 1 : 0;
  return (
    "window.PMS = window.PMS || {};\n" +
    "window.PMS.userPrefs = { show_alias: " + showAlias + ", group_rollup: " + groupRollup + " };\n" +
    "document.addEventListener('alpine:init', function () {\n" +
    "  Alpine.data('displayPrefs', function () {\n" +
    "    return {\n" +
    "      open: false,\n" +
    "      showAlias: !!" + showAlias + ",\n" +
    "      groupRollup: !!" + groupRollup + ",\n" +
    "      saving: false,\n" +
    "      save: function (key, next) {\n" +
    "        var self = this;\n" +
    "        var prev = key === 'show_alias' ? self.showAlias : self.groupRollup;\n" +
    "        if (key === 'show_alias') self.showAlias = !!next;\n" +
    "        else self.groupRollup = !!next;\n" +
    "        self.saving = true;\n" +
    "        var body = {};\n" +
    "        body[key] = next ? 1 : 0;\n" +
    "        fetch('/user/prefs', {\n" +
    "          method: 'PATCH',\n" +
    "          credentials: 'same-origin',\n" +
    "          headers: { 'content-type': 'application/json' },\n" +
    "          body: JSON.stringify(body)\n" +
    "        }).then(function (r) {\n" +
    "          if (!r.ok) throw new Error('HTTP ' + r.status);\n" +
    "          window.location.reload();\n" +
    "        }).catch(function (err) {\n" +
    "          if (key === 'show_alias') self.showAlias = prev;\n" +
    "          else self.groupRollup = prev;\n" +
    "          self.saving = false;\n" +
    "          alert('Could not save preference: ' + (err && err.message ? err.message : 'unknown error'));\n" +
    "        });\n" +
    "      }\n" +
    "    };\n" +
    "  });\n" +
    "});\n"
  );
}

function navLink(href, label, active) {
  const isActive = active && href.startsWith(active);
  return `<a href="${href}" class="${isActive ? 'nav-link active' : 'nav-link'}">${escape(label)}</a>`;
}

/**
 * Sub-navigation tab strip. Renders a horizontal row of tab-styled links,
 * one of which is marked active by comparing its href to `activePath`.
 *
 * Use this for intra-section navigation like /accounts ↔ /accounts/contacts,
 * where both pages live under the same top-level nav (Accounts) but show
 * different tables. Each tab is a plain server-side navigation — no Alpine,
 * no client tab component.
 *
 * tabs: [{ href, label }, …]
 */
export function subnavTabs(tabs, activePath) {
  return html`<nav class="subnav-tabs" aria-label="Section tabs">
    ${tabs.map(t => {
      const isActive = t.href === activePath;
      return html`<a href="${escape(t.href)}" class="${isActive ? 'subnav-tab active' : 'subnav-tab'}">${escape(t.label)}</a>`;
    })}
  </nav>`;
}

/**
 * Convenience: build a standard HTML response with the layout shell.
 */
export function htmlResponse(body, init = {}) {
  return new Response(body, {
    status: init.status ?? 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      ...(init.headers ?? {}),
    },
  });
}

/**
 * Convenience: build a 401 response shell (used by middleware when
 * Access headers are missing in production).
 */
export function unauthorizedResponse() {
  const body = layout('Unauthorized', `
    <section class="card">
      <h1>Unauthorized</h1>
      <p>
        This application is protected by Cloudflare Access. Please sign in
        via <a href="/">SSO</a> with your <code>@c-lars.com</code> account.
      </p>
    </section>
  `);
  return new Response(body, {
    status: 401,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}
