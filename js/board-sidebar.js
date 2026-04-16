// js/board-sidebar.js
//
// Whiteboard / fridge-door sidebars. Two panels, one Alpine store:
//   * RIGHT: Tasks + Notes
//       - Tasks: bulleted list, click dot to toggle complete/incomplete,
//         hover the zone to reveal "show complete" toggle
//       - Notes: sticky-pad stack as compose affordance, click a card
//         to edit in place. Enter saves, Escape cancels, Shift+Enter
//         inserts a newline. Hover shows X delete in the corner. Color
//         picker collapses to one swatch and expands on hover.
//   * LEFT:  Messages
//       - Always-open composer at the bottom. Type, Enter sends,
//         Shift+Enter newline, Escape clears. @user mention sets the
//         direct target (one mention) or just notifies (multiple).
//         No mention = broadcast (visible to everyone).
//
// Polls /board/state every 30s. @[type:id|label] markers in card bodies
// render as inline coloured text via renderCardBody().

(function () {
  'use strict';

  var REF_MARKER_RE = /@\[(user|opportunity|quote|account|document):([^|\]]+)\|([^\]]*)\]/g;

  var COLORS = ['yellow', 'pink', 'blue', 'green', 'orange', 'white'];

  function refHref(type, id) {
    if (type === 'user') return null;
    if (type === 'opportunity') return '/opportunities/' + encodeURIComponent(id);
    if (type === 'quote') return '/quotes/' + encodeURIComponent(id);
    if (type === 'account') return '/accounts/' + encodeURIComponent(id);
    if (type === 'document') return '/documents/' + encodeURIComponent(id);
    return null;
  }

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Body text with @[type:id|label] markers → safe HTML with inline
  // styled mention spans. No pill chrome — just bold coloured text.
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
      var cls = 'board-mention board-mention-' + type;
      if (href) {
        out += '<a class="' + cls + '" href="' + escapeHtml(href) + '">@' + escapeHtml(label) + '</a>';
      } else {
        out += '<span class="' + cls + '">@' + escapeHtml(label) + '</span>';
      }
      last = m.index + m[0].length;
    }
    if (last < body.length) {
      out += escapeHtml(body.slice(last)).replace(/\n/g, '<br>');
    }
    return out;
  }

  // Map a task's due_at to a priority bucket that drives the dot
  // colour and the "!!" prefix. No due date → neutral.
  function derivePriority(task) {
    if (!task || !task.due_at) return 'none';
    var d = new Date(task.due_at);
    if (isNaN(d.getTime())) return 'none';
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    var target = new Date(d);
    target.setHours(0, 0, 0, 0);
    var diffDays = Math.round((target.getTime() - today.getTime()) / 86400000);
    if (diffDays < 0) return 'overdue';   // red !!
    if (diffDays === 0) return 'urgent';  // red
    if (diffDays === 1) return 'soon';    // blue
    if (diffDays <= 3) return 'week';     // yellow
    return 'normal';                      // green
  }

  // Resize a textarea to fit its content. Cap at a reasonable max so
  // it doesn't take over the whole sidebar on a long message.
  function autoResize(el, maxPx) {
    if (!el) return;
    el.style.height = 'auto';
    var max = maxPx || 240;
    var h = Math.min(el.scrollHeight, max);
    el.style.height = h + 'px';
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
  }

  document.addEventListener('alpine:init', function () {
    Alpine.store('board', {
      // ---- State ----
      loaded: false,
      pollHandle: null,
      tickHandle: null,
      pollMs: 30000,

      modules: { my_tasks: [], my_tasks_done: [], my_notes: [], shared: [], mentions: [] },
      prefs: {
        module_order: ['my_tasks', 'my_notes', 'shared', 'mentions'],
        module_collapsed: {},
        hidden_until: null,
      },
      serverTime: null,
      nowMs: Date.now(),
      userId: (window.PMS && window.PMS.userId) || null,

      // Tasks zone
      showCompleted: false,

      composer: {
        open: false,
        body: '',
        color: 'yellow',
        scope: 'private',
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

      messageComposer: {
        body: '',
        submitting: false,
        error: null,
      },

      mention: {
        active: false,
        for: null,
        query: '',
        triggerStart: -1,
        results: [],
        selectedIndex: 0,
      },

      // ---- Derived ----
      get hiddenMs() {
        if (!this.prefs.hidden_until) return 0;
        var t = new Date(this.prefs.hidden_until).getTime();
        if (isNaN(t)) return 0;
        return Math.max(0, t - this.nowMs);
      },
      get isCollapsed() { return this.hiddenMs > 0; },
      get collapsedBadge() {
        var m = this.modules.mentions ? this.modules.mentions.length : 0;
        var shared = this.modules.shared || [];
        var red = 0;
        for (var i = 0; i < shared.length; i++) if (shared[i].flag === 'red') red++;
        return m + red;
      },

      // Tasks visible in the right zone. Pending always; completed only
      // when "show complete" is toggled on.
      get visibleTasks() {
        var pending = this.modules.my_tasks || [];
        if (!this.showCompleted) return pending;
        var done = this.modules.my_tasks_done || [];
        // Pending first (by existing due-order), then completed (newest first).
        return pending.concat(done);
      },

      // Combined list of "notes" — private + shared + public-mentions.
      // Ordered by pinned first, then newest first. Dedupe by id because
      // a public card that @-mentions me shows up in both shared and
      // mentions. Direct (chat) cards are excluded — they live in the
      // messages zone.
      get allNotes() {
        var seen = Object.create(null);
        var out = [];
        var lists = [this.modules.my_notes || [], this.modules.shared || [], this.modules.mentions || []];
        for (var i = 0; i < lists.length; i++) {
          for (var j = 0; j < lists[i].length; j++) {
            var c = lists[i][j];
            if (!c || !c.id || seen[c.id]) continue;
            seen[c.id] = true;
            if (c.scope === 'direct') continue;
            out.push(c);
          }
        }
        out.sort(function (a, b) {
          if (a.pinned !== b.pinned) return (b.pinned || 0) - (a.pinned || 0);
          return (b.created_at || '').localeCompare(a.created_at || '');
        });
        return out;
      },

      // Direct messages — broadcasts (target_user_id IS NULL) plus
      // anything to/from me. Oldest first so the thread reads
      // top-to-bottom like a chat.
      get messages() {
        var me = this.userId;
        var list = (this.modules.mentions || [])
          .filter(function (c) { return c && c.scope === 'direct'; })
          .slice();
        list.forEach(function (c) {
          c.from_me = me && c.author_user_id === me;
        });
        list.sort(function (a, b) {
          return (a.created_at || '').localeCompare(b.created_at || '');
        });
        return list;
      },

      moduleItems: function (key) { return this.modules[key] || []; },

      taskPriority: function (t) { return derivePriority(t); },
      taskPrefix: function (t) {
        if (t && t.status === 'completed') return '';
        var p = derivePriority(t);
        return p === 'overdue' ? '!!' : '';
      },
      taskItemClass: function (t) {
        var cls = 'board-task-item board-task-priority-' + this.taskPriority(t);
        if (t && t.status === 'completed') cls += ' board-task-completed';
        return cls;
      },

      messagePrefix: function (msg) {
        if (!msg) return '';
        var name = msg.from_me
          ? (window.PMS && window.PMS.userDisplayName) || ''
          : (msg.author_display_name || msg.author_email || '');
        var parts = (name || '').split(/[\s@.]+/).filter(Boolean);
        if (parts.length === 0) return '';
        if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
        return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
      },

      cardClass: function (card) {
        var cls = 'board-card board-card-color-' + (card.color || 'yellow');
        if (card.flag) cls += ' board-card-flag-' + card.flag;
        if (card.pinned) cls += ' board-card-pinned';
        var h = 0;
        for (var i = 0; i < (card.id || '').length; i++) h = (h * 31 + card.id.charCodeAt(i)) & 0xffff;
        cls += ' board-card-tilt-' + (h % 3);
        return cls;
      },

      // ---- Lifecycle ----
      start: function () {
        if (this.pollHandle) return;
        var self = this;
        self.poll();
        self.pollHandle = setInterval(function () { self.poll(); }, self.pollMs);
        self.tickHandle = setInterval(function () { self.nowMs = Date.now(); }, 30000);
      },

      poll: function () {
        var self = this;
        fetch('/board/state', { credentials: 'same-origin', headers: { 'accept': 'application/json' } })
          .then(function (res) { return res.ok ? res.json() : null; })
          .then(function (data) {
            if (!data) return;
            self.modules = data.modules || { my_tasks: [], my_tasks_done: [], my_notes: [], shared: [], mentions: [] };
            if (data.prefs) self.prefs = data.prefs;
            if (data.user && data.user.id) {
              self.userId = data.user.id;
              if (!window.PMS) window.PMS = {};
              window.PMS.userId = data.user.id;
              window.PMS.userDisplayName = data.user.display_name || data.user.email || '';
            }
            self.serverTime = data.server_time || null;
            self.nowMs = Date.now();
            self.loaded = true;
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
          self.prefs.hidden_until = null;
        });
      },

      expandNow: function () {
        this.prefs.hidden_until = null;
        this._patchPrefs({ hidden_until: null }).catch(function () { /* ignore */ });
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

      // ---- Tasks ----
      toggleShowCompleted: function () {
        this.showCompleted = !this.showCompleted;
      },

      toggleTask: function (task) {
        if (!task || !task.id) return;
        var self = this;
        var nowComplete = task.status !== 'completed';
        // Optimistic local move between the two arrays so the UI
        // updates immediately.
        if (nowComplete) {
          self.modules.my_tasks = (self.modules.my_tasks || []).filter(function (t) { return t.id !== task.id; });
          task.status = 'completed';
          task.completed_at = new Date().toISOString();
          self.modules.my_tasks_done = [task].concat(self.modules.my_tasks_done || []);
        } else {
          self.modules.my_tasks_done = (self.modules.my_tasks_done || []).filter(function (t) { return t.id !== task.id; });
          task.status = 'pending';
          task.completed_at = null;
          self.modules.my_tasks = [task].concat(self.modules.my_tasks || []);
        }
        fetch('/activities/' + encodeURIComponent(task.id) + '/patch', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', 'accept': 'application/json' },
          body: JSON.stringify({ field: 'status', value: nowComplete ? 'completed' : 'pending' }),
        }).then(function (res) {
          if (!res.ok) self.poll(); // re-sync on error
        }).catch(function () { self.poll(); });
      },

      // ---- Note composer (sticky-pad stack) ----
      openComposer: function (defaults) {
        defaults = defaults || {};
        this.composer.open = true;
        this.composer.body = '';
        this.composer.color = defaults.color || 'yellow';
        this.composer.scope = defaults.scope || 'private';
        this.composer.submitting = false;
        this.composer.error = null;
        this.closeMention();
        setTimeout(function () {
          var el = document.getElementById('board-composer-textarea');
          if (el) { el.focus(); autoResize(el); }
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
        if (!body) { self.cancelComposer(); return; }
        self.composer.submitting = true;
        self.composer.error = null;
        fetch('/board/cards', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', 'accept': 'application/json' },
          body: JSON.stringify({
            body: self.composer.body,
            color: self.composer.color,
            scope: self.composer.scope,
          }),
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
        var cardId = card.id;
        setTimeout(function () {
          var el = document.getElementById('board-edit-textarea-' + cardId);
          if (el) {
            el.focus();
            el.setSelectionRange(el.value.length, el.value.length);
            autoResize(el);
          }
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
          body: JSON.stringify({ body: self.editing.body, color: self.editing.color, flag: self.editing.flag }),
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

      archiveCard: function (card) {
        if (!card || !card.id) return;
        var self = this;
        Object.keys(self.modules).forEach(function (k) {
          if (k === 'my_tasks' || k === 'my_tasks_done') return;
          self.modules[k] = self.modules[k].filter(function (c) { return c.id !== card.id; });
        });
        if (self.editing.cardId === card.id) self.editing.cardId = null;
        fetch('/board/cards/' + encodeURIComponent(card.id), {
          method: 'DELETE',
          credentials: 'same-origin',
          headers: { 'accept': 'application/json' },
        }).catch(function () { self.poll(); });
      },

      // ---- Message composer ----
      submitMessageComposer: function () {
        var self = this;
        if (self.messageComposer.submitting) return;
        var body = (self.messageComposer.body || '').trim();
        if (!body) return;
        self.messageComposer.submitting = true;
        self.messageComposer.error = null;
        fetch('/board/cards', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', 'accept': 'application/json' },
          body: JSON.stringify({
            body: self.messageComposer.body,
            color: 'white',
            scope: 'direct',
            // No target_user_id; server picks one if exactly one @user
            // mention is found, else broadcasts (NULL).
          }),
        })
          .then(function (res) { return res.json().then(function (d) { return { ok: res.ok, d: d }; }); })
          .then(function (r) {
            self.messageComposer.submitting = false;
            if (!r.ok || !r.d || !r.d.ok) {
              self.messageComposer.error = (r.d && r.d.error) || 'Could not send.';
              return;
            }
            self.messageComposer.body = '';
            var ta = document.getElementById('board-message-textarea');
            if (ta) autoResize(ta);
            self.poll();
          })
          .catch(function () {
            self.messageComposer.submitting = false;
            self.messageComposer.error = 'Network error.';
          });
      },

      cancelMessageComposer: function () {
        this.messageComposer.body = '';
        this.messageComposer.error = null;
        this.closeMention();
        var ta = document.getElementById('board-message-textarea');
        if (ta) autoResize(ta);
      },

      // ---- Body input + Enter/Esc/Shift-Enter handling ----
      onBodyInput: function (scope, textarea) {
        var val = textarea.value;
        this[scope].body = val;
        autoResize(textarea, scope === 'messageComposer' ? 180 : 240);
        var caret = textarea.selectionStart || 0;
        var trigger = -1;
        var i = caret - 1;
        var maxScan = 40;
        while (i >= 0 && maxScan-- > 0) {
          var ch = val.charAt(i);
          if (ch === '@') { trigger = i; break; }
          if (ch === '\n' || ch === ']') break;
          i--;
        }
        if (trigger < 0) { this.closeMention(); return; }
        if (trigger > 0) {
          var prev = val.charAt(trigger - 1);
          if (!/\s/.test(prev)) { this.closeMention(); return; }
        }
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
        // Mention popup nav takes precedence
        if (this.mention.active && this.mention.for === scope) {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            if (this.mention.results.length) {
              this.mention.selectedIndex = (this.mention.selectedIndex + 1) % this.mention.results.length;
            }
            return;
          }
          if (event.key === 'ArrowUp') {
            event.preventDefault();
            if (this.mention.results.length) {
              this.mention.selectedIndex = (this.mention.selectedIndex + this.mention.results.length - 1) % this.mention.results.length;
            }
            return;
          }
          if (event.key === 'Enter' || event.key === 'Tab') {
            if (this.mention.results.length) {
              event.preventDefault();
              this.pickMention(this.mention.results[this.mention.selectedIndex], textarea);
              return;
            }
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            this.closeMention();
            return;
          }
        }

        // Composer / edit / message keyboard contracts:
        //   Enter (no shift)  → submit
        //   Shift+Enter       → newline (default browser behavior)
        //   Escape            → cancel / clear
        if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
          event.preventDefault();
          if (scope === 'composer') this.submitComposer();
          else if (scope === 'editing') this.saveEdit();
          else if (scope === 'messageComposer') this.submitMessageComposer();
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          if (scope === 'composer') this.cancelComposer();
          else if (scope === 'editing') this.cancelEdit();
          else if (scope === 'messageComposer') this.cancelMessageComposer();
          return;
        }
      },

      searchMentions: function (q) {
        var self = this;
        fetch('/board/mention-search?q=' + encodeURIComponent(q || '') + '&limit=8', {
          credentials: 'same-origin',
          headers: { 'accept': 'application/json' },
        })
          .then(function (res) { return res.ok ? res.json() : null; })
          .then(function (data) {
            if (!self.mention.active) return;
            self.mention.results = (data && data.results) || [];
            if (self.mention.selectedIndex >= self.mention.results.length) {
              self.mention.selectedIndex = 0;
            }
          })
          .catch(function () { /* ignore */ });
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
        this[scope].body = before + marker + after;
        this.closeMention();
        var newCaret = (before + marker).length;
        if (textarea) {
          setTimeout(function () {
            if (typeof textarea.setSelectionRange === 'function') {
              textarea.setSelectionRange(newCaret, newCaret);
              textarea.focus();
              autoResize(textarea, scope === 'messageComposer' ? 180 : 240);
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

      renderBody: renderCardBody,

      colors: COLORS,
    });

    Alpine.store('board').start();
  });
})();
