// js/board-sidebar.js
//
// Right-edge whiteboard / fridge-door sidebar. Three zones:
//   1. Tasks    — pending tasks assigned to me (read-only, from activities)
//   2. Notes    — private + shared sticky notes (stack of blank notes
//                 is the compose affordance; click a color to write)
//   3. Messages — direct-message chat bubbles (scope='direct' where I'm
//                 author or target)
//
// Design notes:
//   * No module reorder, no module collapse, no header chrome. The
//     user's mockup was "glance at the fridge" — minimal UI, maximal
//     content.
//   * Polls /board/state every 30s.
//   * @[<type>:<id>|<label>] markers in card bodies render as inline
//     styled text (not pill chips) via renderCardBody().
//   * Sidebar hide uses server-side hidden_until so the collapsed
//     state persists across devices.

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

  document.addEventListener('alpine:init', function () {
    Alpine.store('board', {
      // ---- State ----
      loaded: false,
      pollHandle: null,
      tickHandle: null,
      pollMs: 30000,

      modules: { my_tasks: [], my_notes: [], shared: [], mentions: [] },
      prefs: {
        module_order: ['my_tasks', 'my_notes', 'shared', 'mentions'],
        module_collapsed: {},
        hidden_until: null,
      },
      serverTime: null,
      nowMs: Date.now(),
      userId: (window.PMS && window.PMS.userId) || null,

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
        open: false,
        body: '',
        target: null,
        submitting: false,
        error: null,
      },

      messageTargetResults: [],

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

      // Combined list of "notes" — private + shared + public-mentions.
      // Ordered by pinned first, then newest first. Dedupe by id because
      // a public card that @-mentions me shows up in both shared and
      // mentions.
      get allNotes() {
        var seen = Object.create(null);
        var out = [];
        var lists = [this.modules.my_notes || [], this.modules.shared || [], this.modules.mentions || []];
        for (var i = 0; i < lists.length; i++) {
          for (var j = 0; j < lists[i].length; j++) {
            var c = lists[i][j];
            if (!c || !c.id || seen[c.id]) continue;
            seen[c.id] = true;
            // Only surface 'direct' messages in the Messages zone,
            // not here.
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

      // Direct messages involving me (sent or received). Ordered oldest
      // first so the thread reads top-to-bottom like a chat.
      get messages() {
        var list = (this.modules.mentions || [])
          .filter(function (c) { return c && c.scope === 'direct'; })
          .slice();
        // The /board/state mentions module includes direct-TO-me. We
        // also want direct-FROM-me (server will be extended to include
        // these — see below). For now flag each with from_me.
        var me = this.userId;
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
        var p = derivePriority(t);
        return p === 'overdue' ? '!!' : '';
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
        // Each card gets one of three subtle rotations for that
        // "tacked on the fridge" look. Deterministic per card id.
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
            self.modules = data.modules || { my_tasks: [], my_notes: [], shared: [], mentions: [] };
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
          if (k === 'my_tasks') return;
          self.modules[k] = self.modules[k].filter(function (c) { return c.id !== card.id; });
        });
        self.editing.cardId = null;
        fetch('/board/cards/' + encodeURIComponent(card.id), {
          method: 'DELETE',
          credentials: 'same-origin',
          headers: { 'accept': 'application/json' },
        }).catch(function () { self.poll(); });
      },

      // ---- Message composer (direct-scope chat) ----
      openMessageComposer: function () {
        this.messageComposer.open = true;
        this.messageComposer.body = '';
        this.messageComposer.target = null;
        this.messageComposer.submitting = false;
        this.messageComposer.error = null;
        this.messageTargetResults = [];
        this.closeMention();
      },

      cancelMessageComposer: function () {
        this.messageComposer.open = false;
        this.messageComposer.error = null;
        this.closeMention();
      },

      submitMessageComposer: function () {
        var self = this;
        if (self.messageComposer.submitting) return;
        var body = (self.messageComposer.body || '').trim();
        if (!body) { self.messageComposer.error = 'Write something first.'; return; }
        if (!self.messageComposer.target || !self.messageComposer.target.id) {
          self.messageComposer.error = 'Pick a recipient.'; return;
        }
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
            target_user_id: self.messageComposer.target.id,
          }),
        })
          .then(function (res) { return res.json().then(function (d) { return { ok: res.ok, d: d }; }); })
          .then(function (r) {
            self.messageComposer.submitting = false;
            if (!r.ok || !r.d || !r.d.ok) {
              self.messageComposer.error = (r.d && r.d.error) || 'Could not send.';
              return;
            }
            self.messageComposer.open = false;
            self.poll();
          })
          .catch(function () {
            self.messageComposer.submitting = false;
            self.messageComposer.error = 'Network error.';
          });
      },

      searchMessageTargets: function (q) {
        var self = this;
        fetch('/board/mention-search?q=' + encodeURIComponent(q || '') + '&limit=10', {
          credentials: 'same-origin',
          headers: { 'accept': 'application/json' },
        })
          .then(function (res) { return res.ok ? res.json() : null; })
          .then(function (data) {
            var all = (data && data.results) || [];
            self.messageTargetResults = all.filter(function (r) { return r.ref_type === 'user'; });
          })
          .catch(function () { /* ignore */ });
      },

      pickMessageTarget: function (result) {
        if (!result) return;
        this.messageComposer.target = { id: result.ref_id, label: result.label };
        this.messageTargetResults = [];
      },

      clearMessageTarget: function () {
        this.messageComposer.target = null;
      },

      // ---- @-autocomplete (shared across composer / editing / messageComposer) ----
      onBodyInput: function (scope, textarea) {
        var val = textarea.value;
        this[scope].body = val;
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
        if (!this.mention.active) return;
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          if (this.mention.results.length) {
            this.mention.selectedIndex = (this.mention.selectedIndex + 1) % this.mention.results.length;
          }
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          if (this.mention.results.length) {
            this.mention.selectedIndex = (this.mention.selectedIndex + this.mention.results.length - 1) % this.mention.results.length;
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
