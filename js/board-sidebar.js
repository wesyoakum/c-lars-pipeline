// js/board-sidebar.js
//
// Right-edge whiteboard / fridge-door sidebar. Renders four modules:
//   * My Tasks      — read-only, from activities table
//   * My Notes      — private sticky notes
//   * Shared Board  — public sticky notes
//   * Mentions      — direct-to-me + public-mentioning-me sticky notes
//
// Design notes:
//   * Polls /board/state every 30s. Same pattern as the notification
//     store in layout.js, but a separate poll so the sidebar can tune
//     its cadence independently later if needed.
//   * Sticky note bodies can embed @[<type>:<id>|<label>] markers to
//     cross-reference users, opportunities, quotes, accounts, or
//     documents. The server parses these into board_card_refs rows on
//     save; this file renders them as inline pills via the
//     renderCardBody() helper.
//   * All card create / edit happens inline in the sidebar (not in a
//     wizard modal) — sticky notes feel more at home as inline
//     editing than as a multi-step wizard.
//   * Sidebar hide uses server-side hidden_until as the source of
//     truth so it persists cross-device. A 30s client tick
//     re-evaluates and auto-expands when the timer passes.
//   * Module order is per-user; up/down arrows reorder, persisted via
//     PATCH /board/prefs.

(function () {
  'use strict';

  // ------------------------------------------------------------------
  // Constants
  // ------------------------------------------------------------------

  // Must match server REF_MARKER_RE in functions/lib/board.js.
  var REF_MARKER_RE = /@\[(user|opportunity|quote|account|document):([^|\]]+)\|([^\]]*)\]/g;

  var COLORS = ['yellow', 'pink', 'blue', 'green', 'orange', 'white'];
  var FLAGS = [null, 'red', 'yellow', 'green'];
  var MODULE_KEYS = ['my_tasks', 'my_notes', 'shared', 'mentions'];

  var MODULE_LABELS = {
    my_tasks: 'My Tasks',
    my_notes: 'My Notes',
    shared: 'Shared Board',
    mentions: 'Mentions',
  };

  // Route each ref type to a URL so mention pills can be clickable.
  function refHref(type, id) {
    if (type === 'user') return null; // user mentions aren't linked anywhere
    if (type === 'opportunity') return '/opportunities/' + encodeURIComponent(id);
    if (type === 'quote') return '/quotes/' + encodeURIComponent(id);
    if (type === 'account') return '/accounts/' + encodeURIComponent(id);
    if (type === 'document') return '/documents/' + encodeURIComponent(id);
    return null;
  }

  // ------------------------------------------------------------------
  // Render helpers
  // ------------------------------------------------------------------

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Body text with @[type:id|label] markers → safe HTML with pills.
  function renderCardBody(body) {
    if (!body) return '';
    var out = '';
    var last = 0;
    REF_MARKER_RE.lastIndex = 0;
    var m;
    while ((m = REF_MARKER_RE.exec(body)) !== null) {
      if (m.index > last) {
        out += escapeHtml(body.slice(last, m.index)).replace(/\n/g, '<br>');
      }
      var type = m[1];
      var id = m[2];
      var label = m[3];
      var href = refHref(type, id);
      var pillClass = 'board-mention-pill board-mention-pill-' + type;
      if (href) {
        out += '<a class="' + pillClass + '" href="' + escapeHtml(href) + '">@' + escapeHtml(label) + '</a>';
      } else {
        out += '<span class="' + pillClass + '">@' + escapeHtml(label) + '</span>';
      }
      last = m.index + m[0].length;
    }
    if (last < body.length) {
      out += escapeHtml(body.slice(last)).replace(/\n/g, '<br>');
    }
    return out;
  }

  function formatRelative(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    if (diff < 86400 * 7) return Math.floor(diff / 86400) + 'd ago';
    return d.toLocaleDateString();
  }

  function formatDueDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    var target = new Date(d);
    target.setHours(0, 0, 0, 0);
    var diffDays = Math.round((target.getTime() - today.getTime()) / 86400000);
    if (diffDays === 0) return 'today';
    if (diffDays === 1) return 'tomorrow';
    if (diffDays === -1) return 'yesterday';
    if (diffDays < 0) return Math.abs(diffDays) + 'd overdue';
    if (diffDays < 7) return 'in ' + diffDays + 'd';
    return d.toLocaleDateString();
  }

  // ------------------------------------------------------------------
  // Alpine store
  // ------------------------------------------------------------------

  document.addEventListener('alpine:init', function () {
    Alpine.store('board', {
      // ---- State ----
      loaded: false,
      error: null,
      pollHandle: null,
      tickHandle: null,
      pollMs: 30000,

      modules: { my_tasks: [], my_notes: [], shared: [], mentions: [] },
      prefs: {
        module_order: MODULE_KEYS.slice(),
        module_collapsed: { my_tasks: false, my_notes: false, shared: false, mentions: false },
        hidden_until: null,
      },
      serverTime: null,
      nowMs: Date.now(),

      composer: {
        open: false,
        body: '',
        color: 'yellow',
        flag: null,
        scope: 'private',
        target: null,       // { id, label, email } when scope='direct'
        submitting: false,
        error: null,
      },

      editing: {
        cardId: null,
        body: '',
        color: 'yellow',
        flag: null,
        submitting: false,
        error: null,
      },

      mention: {
        active: false,
        for: null,          // 'composer' | 'editing'
        query: '',
        triggerStart: -1,   // index in body where '@' sits
        results: [],
        selectedIndex: 0,
        loading: false,
      },

      // ---- Derived / getters ----
      get hiddenMs() {
        if (!this.prefs.hidden_until) return 0;
        var t = new Date(this.prefs.hidden_until).getTime();
        if (isNaN(t)) return 0;
        return Math.max(0, t - this.nowMs);
      },
      get isCollapsed() {
        return this.hiddenMs > 0;
      },
      get collapsedRemainingLabel() {
        var ms = this.hiddenMs;
        if (ms <= 0) return '';
        var mins = Math.ceil(ms / 60000);
        if (mins < 60) return mins + 'm';
        var hrs = Math.ceil(mins / 60);
        if (hrs < 24) return hrs + 'h';
        return Math.ceil(hrs / 24) + 'd';
      },
      get collapsedBadge() {
        // Shows unread-ish count: mentions + red-flagged shared cards.
        var m = this.modules.mentions ? this.modules.mentions.length : 0;
        var sharedRedCount = 0;
        var shared = this.modules.shared || [];
        for (var i = 0; i < shared.length; i++) {
          if (shared[i].flag === 'red') sharedRedCount++;
        }
        return m + sharedRedCount;
      },
      get orderedModules() {
        var order = (this.prefs.module_order || []).slice();
        for (var i = 0; i < MODULE_KEYS.length; i++) {
          if (order.indexOf(MODULE_KEYS[i]) < 0) order.push(MODULE_KEYS[i]);
        }
        return order;
      },
      moduleLabel: function (key) {
        return MODULE_LABELS[key] || key;
      },
      moduleItems: function (key) {
        return this.modules[key] || [];
      },
      moduleCount: function (key) {
        return (this.modules[key] || []).length;
      },
      isModuleCollapsed: function (key) {
        return !!this.prefs.module_collapsed[key];
      },

      // ---- Lifecycle ----
      start: function () {
        if (this.pollHandle) return;
        var self = this;
        self.poll();
        self.pollHandle = setInterval(function () { self.poll(); }, self.pollMs);
        self.tickHandle = setInterval(function () { self.tick(); }, 30000);
      },

      tick: function () {
        // Advance the client clock so `isCollapsed` flips when the
        // hidden_until timestamp passes. 30s resolution is fine for a
        // 5-min minimum snooze.
        this.nowMs = Date.now();
      },

      poll: function () {
        var self = this;
        fetch('/board/state', {
          credentials: 'same-origin',
          headers: { 'accept': 'application/json' },
        })
          .then(function (res) { return res.ok ? res.json() : null; })
          .then(function (data) {
            if (!data) return;
            self.modules = data.modules || { my_tasks: [], my_notes: [], shared: [], mentions: [] };
            if (data.prefs) self.prefs = data.prefs;
            self.serverTime = data.server_time || null;
            self.nowMs = Date.now();
            self.loaded = true;
            self.error = null;
          })
          .catch(function () { /* transient, ignored */ });
      },

      // ---- Sidebar hide / show ----
      hideFor: function (minutesOrTomorrow) {
        var until;
        if (minutesOrTomorrow === 'tomorrow') {
          var d = new Date();
          d.setDate(d.getDate() + 1);
          d.setHours(8, 0, 0, 0);
          until = d.toISOString();
        } else {
          var n = Number(minutesOrTomorrow);
          if (!Number.isFinite(n) || n <= 0) return;
          var d2 = new Date();
          d2.setMinutes(d2.getMinutes() + n);
          until = d2.toISOString();
        }
        var self = this;
        self.prefs.hidden_until = until;
        self.nowMs = Date.now();
        self._patchPrefs({ hidden_until: until }).catch(function () {
          /* revert on failure so user knows hide didn't stick */
          self.prefs.hidden_until = null;
        });
      },

      expandNow: function () {
        var self = this;
        self.prefs.hidden_until = null;
        self._patchPrefs({ hidden_until: null }).catch(function () { /* ignore */ });
      },

      toggleModuleCollapse: function (key) {
        var next = !this.prefs.module_collapsed[key];
        this.prefs.module_collapsed = Object.assign({}, this.prefs.module_collapsed);
        this.prefs.module_collapsed[key] = next;
        var patch = {};
        patch[key] = next;
        this._patchPrefs({ module_collapsed: patch });
      },

      moveModule: function (key, delta) {
        var order = (this.prefs.module_order || []).slice();
        var i = order.indexOf(key);
        if (i < 0) return;
        var j = i + delta;
        if (j < 0 || j >= order.length) return;
        var tmp = order[i];
        order[i] = order[j];
        order[j] = tmp;
        this.prefs.module_order = order;
        this._patchPrefs({ module_order: order });
      },

      _patchPrefs: function (patch) {
        return fetch('/board/prefs', {
          method: 'PATCH',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', 'accept': 'application/json' },
          body: JSON.stringify(patch),
        }).then(function (res) {
          if (!res.ok) throw new Error('prefs save failed');
          return res.json();
        });
      },

      // ---- Composer ----
      openComposer: function (defaults) {
        defaults = defaults || {};
        this.composer.open = true;
        this.composer.body = '';
        this.composer.color = defaults.color || 'yellow';
        this.composer.flag = defaults.flag || null;
        this.composer.scope = defaults.scope || 'private';
        this.composer.target = defaults.target || null;
        this.composer.submitting = false;
        this.composer.error = null;
        this.closeMention();
        var self = this;
        setTimeout(function () {
          var el = document.getElementById('board-composer-textarea');
          if (el) el.focus();
        }, 30);
      },

      cancelComposer: function () {
        this.composer.open = false;
        this.composer.error = null;
        this.closeMention();
      },

      submitComposer: function () {
        var self = this;
        if (self.composer.submitting) return;
        var body = (self.composer.body || '').trim();
        if (!body) { self.composer.error = 'Write something first.'; return; }
        if (self.composer.scope === 'direct' && (!self.composer.target || !self.composer.target.id)) {
          self.composer.error = 'Pick a recipient.';
          return;
        }
        self.composer.submitting = true;
        self.composer.error = null;
        var payload = {
          body: self.composer.body,
          color: self.composer.color,
          flag: self.composer.flag,
          scope: self.composer.scope,
        };
        if (self.composer.scope === 'direct') {
          payload.target_user_id = self.composer.target.id;
        }
        fetch('/board/cards', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', 'accept': 'application/json' },
          body: JSON.stringify(payload),
        })
          .then(function (res) { return res.json().then(function (d) { return { ok: res.ok, d: d }; }); })
          .then(function (r) {
            self.composer.submitting = false;
            if (!r.ok || !r.d || !r.d.ok) {
              self.composer.error = (r.d && r.d.error) || 'Could not save.';
              return;
            }
            self.composer.open = false;
            self.poll();
          })
          .catch(function () {
            self.composer.submitting = false;
            self.composer.error = 'Network error.';
          });
      },

      // ---- Inline edit ----
      startEdit: function (card) {
        this.editing.cardId = card.id;
        this.editing.body = card.body || '';
        this.editing.color = card.color || 'yellow';
        this.editing.flag = card.flag || null;
        this.editing.submitting = false;
        this.editing.error = null;
        this.closeMention();
        var self = this;
        setTimeout(function () {
          var el = document.getElementById('board-edit-textarea-' + card.id);
          if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
        }, 30);
      },

      cancelEdit: function () {
        this.editing.cardId = null;
        this.editing.error = null;
        this.closeMention();
      },

      saveEdit: function () {
        var self = this;
        if (self.editing.submitting || !self.editing.cardId) return;
        var body = (self.editing.body || '').trim();
        if (!body) { self.editing.error = 'Body required.'; return; }
        self.editing.submitting = true;
        self.editing.error = null;
        fetch('/board/cards/' + encodeURIComponent(self.editing.cardId), {
          method: 'PATCH',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', 'accept': 'application/json' },
          body: JSON.stringify({
            body: self.editing.body,
            color: self.editing.color,
            flag: self.editing.flag,
          }),
        })
          .then(function (res) { return res.json().then(function (d) { return { ok: res.ok, d: d }; }); })
          .then(function (r) {
            self.editing.submitting = false;
            if (!r.ok || !r.d || !r.d.ok) {
              self.editing.error = (r.d && r.d.error) || 'Could not save.';
              return;
            }
            self.editing.cardId = null;
            self.poll();
          })
          .catch(function () {
            self.editing.submitting = false;
            self.editing.error = 'Network error.';
          });
      },

      // ---- Card actions ----
      archiveCard: function (card) {
        if (!card || !card.id) return;
        var self = this;
        // Optimistic removal
        Object.keys(self.modules).forEach(function (k) {
          if (k === 'my_tasks') return;
          self.modules[k] = self.modules[k].filter(function (c) { return c.id !== card.id; });
        });
        fetch('/board/cards/' + encodeURIComponent(card.id), {
          method: 'DELETE',
          credentials: 'same-origin',
          headers: { 'accept': 'application/json' },
        }).catch(function () { self.poll(); });
      },

      togglePin: function (card) {
        if (!card || !card.id) return;
        var self = this;
        var next = card.pinned ? 0 : 1;
        card.pinned = next;
        fetch('/board/cards/' + encodeURIComponent(card.id) + '/pin', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', 'accept': 'application/json' },
          body: JSON.stringify({ pinned: !!next }),
        })
          .then(function () { self.poll(); })
          .catch(function () { card.pinned = next ? 0 : 1; });
      },

      snoozeCard: function (card, minutesOrTomorrow) {
        if (!card || !card.id) return;
        var self = this;
        var payload = {};
        if (minutesOrTomorrow === 'tomorrow') payload.duration_minutes = 'tomorrow';
        else payload.duration_minutes = Number(minutesOrTomorrow);
        // Optimistic removal
        Object.keys(self.modules).forEach(function (k) {
          if (k === 'my_tasks') return;
          self.modules[k] = self.modules[k].filter(function (c) { return c.id !== card.id; });
        });
        fetch('/board/cards/' + encodeURIComponent(card.id) + '/snooze', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', 'accept': 'application/json' },
          body: JSON.stringify(payload),
        }).catch(function () { self.poll(); });
      },

      openTaskModal: function (task) {
        if (!task) return;
        var prefill = { reload_on_success: false };
        if (task.opportunity_id) { prefill.opportunity_id = task.opportunity_id; }
        // Just open the existing activities page for this task — click
        // semantics match the main app's task list.
        window.location.href = '/activities';
      },

      // ---- @-autocomplete ----
      onBodyInput: function (scope, textarea) {
        // scope: 'composer' | 'editing'
        var val = textarea.value;
        this[scope].body = val;
        var caret = textarea.selectionStart || 0;
        // Look backward from caret for '@' that starts a mention query.
        // We allow letters, numbers, dashes, underscores, and spaces (up
        // to, say, 40 chars) between '@' and caret — spaces because
        // entity labels have them ("OPP-12345 Helix Aerospace").
        var trigger = -1;
        var i = caret - 1;
        var maxScan = 40;
        while (i >= 0 && maxScan-- > 0) {
          var ch = val.charAt(i);
          if (ch === '@') { trigger = i; break; }
          // Stop at newline or another `@[...]` marker's `]`.
          if (ch === '\n' || ch === ']') break;
          i--;
        }
        if (trigger < 0) { this.closeMention(); return; }

        // Must be start-of-line or preceded by whitespace.
        if (trigger > 0) {
          var prev = val.charAt(trigger - 1);
          if (!/\s/.test(prev)) { this.closeMention(); return; }
        }

        // Anything between @ and caret that looks like a completed marker? Skip.
        var between = val.slice(trigger, caret);
        if (/^@\[/.test(between)) { this.closeMention(); return; }

        var query = val.slice(trigger + 1, caret);
        this.mention.active = true;
        this.mention.for = scope;
        this.mention.query = query;
        this.mention.triggerStart = trigger;
        this.mention.selectedIndex = 0;
        this.searchMentions(query);
      },

      onBodyKeydown: function (scope, textarea, event) {
        // scope same as above. Arrow keys navigate the mention dropdown.
        if (!this.mention.active) {
          if (event.key === 'Escape') {
            // Nothing to do; let the textarea keep focus.
          }
          return;
        }
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          if (this.mention.results.length) {
            this.mention.selectedIndex =
              (this.mention.selectedIndex + 1) % this.mention.results.length;
          }
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          if (this.mention.results.length) {
            this.mention.selectedIndex =
              (this.mention.selectedIndex + this.mention.results.length - 1) %
              this.mention.results.length;
          }
        } else if (event.key === 'Enter' || event.key === 'Tab') {
          if (this.mention.results.length) {
            event.preventDefault();
            this.pickMention(this.mention.results[this.mention.selectedIndex], textarea);
          }
        } else if (event.key === 'Escape') {
          event.preventDefault();
          this.closeMention();
        }
      },

      searchMentions: function (q) {
        var self = this;
        self.mention.loading = true;
        fetch('/board/mention-search?q=' + encodeURIComponent(q || '') + '&limit=8', {
          credentials: 'same-origin',
          headers: { 'accept': 'application/json' },
        })
          .then(function (res) { return res.ok ? res.json() : null; })
          .then(function (data) {
            self.mention.loading = false;
            if (!self.mention.active) return; // user closed in the meantime
            self.mention.results = (data && data.results) || [];
            if (self.mention.selectedIndex >= self.mention.results.length) {
              self.mention.selectedIndex = 0;
            }
          })
          .catch(function () {
            self.mention.loading = false;
          });
      },

      pickMention: function (result, textarea) {
        if (!result) return;
        var scope = this.mention.for;
        if (!scope) return;
        var val = this[scope].body;
        var caret = textarea ? (textarea.selectionStart || 0) : val.length;
        var start = this.mention.triggerStart;
        if (start < 0) { this.closeMention(); return; }

        var marker = '@[' + result.ref_type + ':' + result.ref_id + '|' + result.label + '] ';
        var before = val.slice(0, start);
        var after = val.slice(caret);
        var next = before + marker + after;
        this[scope].body = next;
        this.closeMention();

        var newCaret = (before + marker).length;
        if (textarea) {
          // Wait for Alpine to flush the updated value into the DOM,
          // then restore caret position.
          setTimeout(function () {
            if (typeof textarea.setSelectionRange === 'function') {
              textarea.setSelectionRange(newCaret, newCaret);
              textarea.focus();
            }
          }, 0);
        }
      },

      closeMention: function () {
        this.mention.active = false;
        this.mention.for = null;
        this.mention.query = '';
        this.mention.triggerStart = -1;
        this.mention.results = [];
        this.mention.selectedIndex = 0;
      },

      // ---- Target (recipient) picker for direct-scope composer ----
      targetQuery: '',
      targetResults: [],
      targetSelectedIndex: 0,

      searchTargets: function (q) {
        var self = this;
        self.targetQuery = q || '';
        fetch('/board/mention-search?q=' + encodeURIComponent(q || '') + '&limit=10', {
          credentials: 'same-origin',
          headers: { 'accept': 'application/json' },
        })
          .then(function (res) { return res.ok ? res.json() : null; })
          .then(function (data) {
            var all = (data && data.results) || [];
            self.targetResults = all.filter(function (r) { return r.ref_type === 'user'; });
            self.targetSelectedIndex = 0;
          })
          .catch(function () { /* ignore */ });
      },

      pickTarget: function (result) {
        if (!result) return;
        this.composer.target = { id: result.ref_id, label: result.label, email: result.sub };
        this.targetQuery = '';
        this.targetResults = [];
      },

      clearTarget: function () {
        this.composer.target = null;
      },

      // ---- Render helpers exposed to Alpine templates ----
      renderBody: renderCardBody,
      relativeTime: formatRelative,
      dueLabel: formatDueDate,

      authorInitials: function (card) {
        var name = (card && (card.author_display_name || card.author_email)) || '';
        var parts = name.split(/[\s@.]+/).filter(Boolean);
        if (parts.length === 0) return '?';
        if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
        return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
      },

      authorLabel: function (card) {
        return (card && (card.author_display_name || card.author_email)) || '';
      },

      cardClass: function (card) {
        var cls = 'board-card board-card-color-' + (card.color || 'yellow');
        if (card.flag) cls += ' board-card-flag-' + card.flag;
        if (card.pinned) cls += ' board-card-pinned';
        return cls;
      },

      colors: COLORS,
      flags: FLAGS,
    });

    Alpine.store('board').start();
  });
})();
