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
//       - Always-open composer at the TOP \u2014 sits where the next new
//         message will appear. List below is newest \u2192 oldest.
//         Type, Enter sends, Shift+Enter newline, Escape clears.
//         @user mention sets the direct target (one mention) or just
//         notifies (multiple). No mention = broadcast (visible to
//         everyone).
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

  // Place a task in one of the sidebar's two task cards.
  //   'todo'         → overdue + today + tomorrow (urgent stuff)
  //   'coming-soon'  → 2 to 7 days out
  //   'later'        → > 7 days
  //   'none'         → no due date
  function taskDueBucket(task) {
    if (!task || !task.due_at) return 'none';
    var d = new Date(task.due_at);
    if (isNaN(d.getTime())) return 'none';
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    var target = new Date(d);
    target.setHours(0, 0, 0, 0);
    var diffDays = Math.round((target.getTime() - today.getTime()) / 86400000);
    if (diffDays < 0) return 'todo';        // overdue
    if (diffDays <= 1) return 'todo';       // today / tomorrow
    if (diffDays <= 7) return 'coming-soon';
    return 'later';
  }

  // Best-effort sync clipboard write for browsers without async API
  // (or insecure-context fallbacks). No-op on failure.
  function fallbackCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    } catch (e) {}
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
        scope: 'private',
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

      // Top card — overdue + today + tomorrow. Recently-completed
      // tasks fold in here when "show complete" is toggled on.
      get todoTasks() {
        var pending = (this.modules.my_tasks || []).filter(function (t) {
          return taskDueBucket(t) === 'todo';
        });
        if (!this.showCompleted) return pending;
        var done = this.modules.my_tasks_done || [];
        return pending.concat(done);
      },

      // Second card — anything due in the next 2 to 7 days.
      get comingSoonTasks() {
        return (this.modules.my_tasks || []).filter(function (t) {
          return taskDueBucket(t) === 'coming-soon';
        });
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
        out.sort(this.noteSort);
        return out;
      },

      // Shared comparator used by allNotes + every place we re-sort
      // modules locally after a togglePin / drop / etc. Keep this in
      // sync with the server's ORDER BY in functions/board/state.js.
      noteSort: function (a, b) {
        if ((a.pinned || 0) !== (b.pinned || 0)) return (b.pinned || 0) - (a.pinned || 0);
        var as = a.sort_order, bs = b.sort_order;
        if (as != null && bs != null && as !== bs) return bs - as;
        if (as != null && bs == null) return -1;
        if (as == null && bs != null) return 1;
        return (b.created_at || '').localeCompare(a.created_at || '');
      },

      // Direct messages — broadcasts (target_user_id IS NULL) plus
      // anything to/from me. Newest first so the latest message sits
      // right under the composer (which lives at the top now).
      get messages() {
        var me = this.userId;
        var list = (this.modules.mentions || [])
          .filter(function (c) { return c && c.scope === 'direct'; })
          .slice();
        list.forEach(function (c) {
          c.from_me = me && c.author_user_id === me;
        });
        list.sort(function (a, b) {
          return (b.created_at || '').localeCompare(a.created_at || '');
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

      // ---- Long-note pagination ----
      // If a note's body exceeds PAGE_LEN it splits into "pages" — extra
      // squares stacked behind the first one. Cached on the card object
      // keyed by the body string so we don't re-split on every Alpine
      // reactivity tick. Cache invalidates automatically when body
      // changes (poll replaces card object, or edit rewrites body).
      PAGE_LEN: 240,
      splitPages: function (body) {
        body = body || '';
        var max = this.PAGE_LEN;
        if (body.length <= max) return [body];
        var pages = [];
        var rest = body;
        while (rest.length > max) {
          var cut = max;
          // Prefer to break on a newline or whitespace within the
          // back half of the page so we don't slice mid-word.
          var slice = rest.slice(0, max + 1);
          var ws = Math.max(slice.lastIndexOf('\n'), slice.lastIndexOf(' '));
          if (ws > max * 0.5) cut = ws;
          pages.push(rest.slice(0, cut).replace(/\s+$/, ''));
          rest = rest.slice(cut).replace(/^\s+/, '');
        }
        if (rest.length > 0) pages.push(rest);
        return pages;
      },
      cardPages: function (card) {
        if (!card) return [''];
        var body = card.body || '';
        if (card.__pages_for !== body) {
          card.__pages = this.splitPages(body);
          card.__pages_for = body;
        }
        return card.__pages;
      },
      hasMorePages: function (card) { return this.cardPages(card).length > 1; },
      firstPage: function (card)    { return this.cardPages(card)[0] || ''; },
      extraPages: function (card)   { return this.cardPages(card).slice(1); },
      toggleExpand: function (card) {
        if (!card) return;
        card.__expanded = !card.__expanded;
      },

      // ---- Drag-to-reorder ----
      // Scoped to private notes only so a user reordering their own
      // notepad never affects what other users see in their Shared
      // Board. Backend's canEdit guard would reject anyway, but we
      // gate the affordance client-side so non-draggable cards don't
      // even show the move cursor.
      drag: { id: null, targetId: null, mode: null },
      isDraggable: function (card) {
        if (!card) return false;
        if (this.editing.cardId === card.id) return false;
        return card.scope === 'private' && card.author_user_id === this.userId;
      },
      onDragStart: function (card, ev) {
        if (!this.isDraggable(card)) {
          if (ev && ev.preventDefault) ev.preventDefault();
          return;
        }
        this.drag.id = card.id;
        this.drag.targetId = null;
        this.drag.mode = null;
        if (ev && ev.dataTransfer) {
          ev.dataTransfer.effectAllowed = 'move';
          // Some browsers require any setData call for drag to fire.
          try { ev.dataTransfer.setData('text/plain', card.id); } catch (e) {}
        }
      },
      onDragOver: function (card, ev) {
        if (!this.drag.id) return;
        if (this.drag.id === card.id) return;
        if (!this.isDraggable(card)) return;
        ev.preventDefault();
        // Above/below split by the midpoint of the drop target's bbox.
        var el = ev.currentTarget;
        var rect = el.getBoundingClientRect();
        var below = ev.clientY > rect.top + rect.height / 2;
        this.drag.targetId = card.id;
        this.drag.mode = below ? 'below' : 'above';
        if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
      },
      onDragLeave: function (card) {
        if (this.drag.targetId === card.id) {
          this.drag.targetId = null;
          this.drag.mode = null;
        }
      },
      onDrop: function (card, ev) {
        ev.preventDefault();
        var draggedId = this.drag.id;
        var mode = this.drag.mode;
        var targetId = card.id;
        this.onDragEnd();
        if (!draggedId || draggedId === targetId) return;

        var notes = this.allNotes;
        var dragged = null;
        for (var i = 0; i < notes.length; i++) {
          if (notes[i].id === draggedId) { dragged = notes[i]; break; }
        }
        if (!dragged) return;

        // Compute the insert slot in the list AFTER removing the dragged
        // card, so the predecessor / successor sort_orders are correct
        // even when dragging into an adjacent slot.
        var pruned = notes.filter(function (c) { return c.id !== draggedId; });
        var ti = -1;
        for (var k = 0; k < pruned.length; k++) {
          if (pruned[k].id === targetId) { ti = k; break; }
        }
        if (ti < 0) return;
        var insertSlot = (mode === 'below') ? ti + 1 : ti;

        var pred = (insertSlot > 0) ? pruned[insertSlot - 1] : null;
        var succ = (insertSlot < pruned.length) ? pruned[insertSlot] : null;
        var predSort = pred && pred.sort_order != null ? pred.sort_order : null;
        var succSort = succ && succ.sort_order != null ? succ.sort_order : null;

        var newSort;
        if (predSort != null && succSort != null) {
          newSort = (predSort + succSort) / 2;
        } else if (predSort != null) {
          newSort = predSort - 1000; // dropped at the bottom
        } else if (succSort != null) {
          newSort = succSort + 1000; // dropped at the top
        } else {
          newSort = Date.now();
        }

        // Optimistic local update + re-sort.
        dragged.sort_order = newSort;
        var self = this;
        Object.keys(self.modules).forEach(function (k) {
          if (k === 'my_tasks' || k === 'my_tasks_done') return;
          self.modules[k] = (self.modules[k] || []).slice().sort(self.noteSort);
        });

        fetch('/board/cards/' + encodeURIComponent(draggedId), {
          method: 'PATCH',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', 'accept': 'application/json' },
          body: JSON.stringify({ sort_order: newSort }),
        }).then(function (res) {
          if (!res.ok) self.poll();
        }).catch(function () { self.poll(); });
      },
      onDragEnd: function () {
        this.drag.id = null;
        this.drag.targetId = null;
        this.drag.mode = null;
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

      // ---- Publish toggle (composer or editing) ----
      // Notes default to private; clicking "Publish" flips scope to
      // 'public' (shared); clicking again ("Published") flips back.
      togglePublish: function (target) {
        if (target !== 'composer' && target !== 'editing') return;
        this[target].scope = this[target].scope === 'public' ? 'private' : 'public';
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

      // Permanently delete a task. Optimistic remove from both arrays;
      // re-syncs from server on failure. Confirms because this is
      // destructive (no undo).
      deleteTask: function (task) {
        if (!task || !task.id) return;
        var label = (task.subject || task.body || 'this task').slice(0, 60);
        if (!confirm('Delete "' + label + '"? This cannot be undone.')) return;
        var self = this;
        self.modules.my_tasks = (self.modules.my_tasks || []).filter(function (t) { return t.id !== task.id; });
        self.modules.my_tasks_done = (self.modules.my_tasks_done || []).filter(function (t) { return t.id !== task.id; });
        fetch('/activities/' + encodeURIComponent(task.id) + '/delete', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'accept': 'application/json' },
        }).then(function (res) {
          if (!res.ok) self.poll();
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
        // Existing notes are either private or public ("shared"). Default
        // to private if scope is missing or anything unexpected (direct
        // notes aren't in the notes list).
        this.editing.scope = card.scope === 'public' ? 'public' : 'private';
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
          body: JSON.stringify({
            body: self.editing.body,
            color: self.editing.color,
            flag: self.editing.flag,
            scope: self.editing.scope,
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

      // Toggle the pinned state of a note or message. Pinned cards sort
      // to the top of their module and don't auto-archive. Optimistic;
      // re-syncs on failure.
      togglePin: function (card) {
        if (!card || !card.id) return;
        var self = this;
        var nextPinned = card.pinned ? 0 : 1;
        card.pinned = nextPinned; // local update
        // Re-sort affected modules immediately so the card jumps to its
        // new position in the list.
        Object.keys(self.modules).forEach(function (k) {
          if (k === 'my_tasks' || k === 'my_tasks_done') return;
          self.modules[k] = (self.modules[k] || []).slice().sort(self.noteSort);
        });
        fetch('/board/cards/' + encodeURIComponent(card.id) + '/pin', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', 'accept': 'application/json' },
          body: JSON.stringify({ pinned: !!nextPinned }),
        }).then(function (res) {
          if (!res.ok) self.poll();
        }).catch(function () { self.poll(); });
      },

      // Copy the card body to the clipboard. We strip the @[type:id|label]
      // ref markers down to plain "@label" so the clipboard text matches
      // what the user sees on screen. Falls back to a hidden textarea +
      // execCommand for browsers without the async clipboard API
      // (or when not in a secure context).
      copyCard: function (card) {
        if (!card) return;
        var raw = card.body || '';
        var plain = raw.replace(
          /@\[(?:user|opportunity|quote|account|document):[^|\]]+\|([^\]]*)\]/g,
          '@$1'
        );
        var done = function () {
          card.__copied = true;
          var c = card;
          setTimeout(function () { c.__copied = false; }, 1200);
        };
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(plain).then(done, function () {
              fallbackCopy(plain); done();
            });
            return;
          }
        } catch (e) {}
        fallbackCopy(plain); done();
      },

      // ---- Message-specific actions (chat bubbles in left sidebar) ----
      // Both restricted by markup to from_me === true (only the author
      // can emphasize or delete). Backend enforces author-or-admin too.

      // Flip the message's flag between null and 'red'. We piggy-back on
      // the existing card flag column so no schema change is needed.
      // 'red' is rendered via the .is-emphasized CSS class on the bubble.
      toggleEmphasize: function (msg) {
        if (!msg || !msg.id) return;
        var self = this;
        var nextFlag = msg.flag === 'red' ? null : 'red';
        msg.flag = nextFlag; // optimistic
        fetch('/board/cards/' + encodeURIComponent(msg.id), {
          method: 'PATCH',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', 'accept': 'application/json' },
          body: JSON.stringify({ flag: nextFlag }),
        }).then(function (res) {
          if (!res.ok) self.poll();
        }).catch(function () { self.poll(); });
      },

      // Confirm-then-archive. Reuses archiveCard which soft-deletes via
      // DELETE /board/cards/:id. Confirm prompt added because deleting
      // chat history is more destructive than archiving a sticky note.
      deleteMessage: function (msg) {
        if (!msg || !msg.id) return;
        if (!window.confirm('Delete this message? This cannot be undone.')) return;
        this.archiveCard(msg);
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
