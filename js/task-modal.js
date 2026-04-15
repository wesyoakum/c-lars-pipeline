// js/task-modal.js
//
// Wizard-style "New task" modal. Walks the user through 5 steps,
// one prompt at a time, with Tab advancing and Shift+Tab going back.
//
// Steps:
//   1. body      - "What needs to be done?"  (free text, required)
//   2. assignee  - "Who needs to do it?"     (fuzzy-match user)
//   3. due       - "When is it due?"         (natural-language date)
//   4. remind    - "Remind you when?"        (natural-language date)
//   5. link      - "Link to an opportunity, quote, or account?"
//                  (skipped entirely if the caller pre-locked a link)
//
// Opened via:
//   window.PMS.openTaskModal({ opportunity_id, link_label })
//   window.dispatchEvent(new CustomEvent('pms:open-task-modal', { detail: {...} }))
//
// The modal markup lives in functions/lib/layout.js and is injected
// on every authenticated page. This file owns all wizard logic.

(function () {
  'use strict';

  // ---------------------------------------------------------------
  // Date parsing helpers
  // ---------------------------------------------------------------

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  // Format a Date as "YYYY-MM-DDTHH:MM" for datetime-local form fields.
  function toLocalIso(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
         + 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  var WEEKDAYS_LONG = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  var WEEKDAYS_SHORT = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

  function weekdayIndex(word) {
    var i = WEEKDAYS_LONG.indexOf(word);
    if (i >= 0) return i;
    return WEEKDAYS_SHORT.indexOf(word);
  }

  // Extract a trailing time fragment like "5pm" / "9:30am" / "17:30".
  // Returns { hours, minutes, rest } or null.
  function parseTimeFragment(s) {
    var m = s.match(/\s*(?:@\s*|at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*$/i);
    if (!m) return null;
    var h = parseInt(m[1], 10);
    var min = m[2] ? parseInt(m[2], 10) : 0;
    var ap = m[3] ? m[3].toLowerCase() : null;
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    // Require either an am/pm suffix or a 2-digit hour>12 to consider
    // a bare number a time. Otherwise "5" could mean "the 5th".
    if (!ap && h < 13 && !m[2]) return null;
    if (h < 0 || h > 23 || min < 0 || min > 59) return null;
    return { hours: h, minutes: min, rest: s.slice(0, m.index).trim() };
  }

  // Natural-language date parsing. Returns a Date or null.
  // Defaults time to 09:00 when not specified.
  function parseDateInput(raw) {
    if (!raw) return null;
    var input = String(raw).trim();
    if (!input) return null;

    // Try ISO format first: 2026-04-17, 2026-04-17T14:30, 2026-04-17 14:30
    var iso = input.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s](\d{1,2}):(\d{2}))?$/);
    if (iso) {
      var d = new Date(
        parseInt(iso[1], 10),
        parseInt(iso[2], 10) - 1,
        parseInt(iso[3], 10),
        iso[4] ? parseInt(iso[4], 10) : 9,
        iso[5] ? parseInt(iso[5], 10) : 0,
        0
      );
      if (!isNaN(d.getTime())) return d;
    }

    // Peel off a trailing time fragment if present
    var tf = parseTimeFragment(input);
    var hours = tf ? tf.hours : 9;
    var minutes = tf ? tf.minutes : 0;
    var rest = (tf ? tf.rest : input).toLowerCase().trim();

    var now = new Date();
    var base = null;

    if (!rest) {
      // Pure time => today
      base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    } else if (rest === 'today' || rest === 'now') {
      base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      if (rest === 'now' && !tf) {
        hours = now.getHours();
        minutes = now.getMinutes();
      }
    } else if (rest === 'tomorrow' || rest === 'tmrw' || rest === 'tmr') {
      base = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    } else if (rest === 'yesterday') {
      base = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    }

    if (!base) {
      var wd = weekdayIndex(rest);
      if (wd >= 0) {
        var diff = wd - now.getDay();
        if (diff <= 0) diff += 7;
        base = new Date(now.getFullYear(), now.getMonth(), now.getDate() + diff);
      }
    }

    if (!base && /^next\s+/.test(rest)) {
      var after = rest.slice(5).trim();
      if (after === 'week') {
        base = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7);
      } else {
        var nwd = weekdayIndex(after);
        if (nwd >= 0) {
          var diff2 = nwd - now.getDay();
          if (diff2 <= 0) diff2 += 7;
          diff2 += 7; // "next monday" is the one after the coming one
          base = new Date(now.getFullYear(), now.getMonth(), now.getDate() + diff2);
        }
      }
    }

    if (!base) {
      var inMatch = rest.match(/^in\s+(\d+)\s*(minute|minutes|min|mins|hour|hours|hr|hrs|day|days|week|weeks|month|months)$/);
      if (inMatch) {
        var n = parseInt(inMatch[1], 10);
        var unit = inMatch[2];
        var target = new Date(now);
        if (/^(minute|minutes|min|mins)$/.test(unit)) target.setMinutes(target.getMinutes() + n);
        else if (/^(hour|hours|hr|hrs)$/.test(unit)) target.setHours(target.getHours() + n);
        else if (/^(day|days)$/.test(unit)) target.setDate(target.getDate() + n);
        else if (/^(week|weeks)$/.test(unit)) target.setDate(target.getDate() + n * 7);
        else if (/^(month|months)$/.test(unit)) target.setMonth(target.getMonth() + n);
        if (!tf) return target; // already includes a specific time
        base = new Date(target.getFullYear(), target.getMonth(), target.getDate());
      }
    }

    if (!base) return null;

    base.setHours(hours, minutes, 0, 0);
    return base;
  }

  function formatDateDisplay(d) {
    if (!d) return '';
    var now = new Date();
    var weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var dayStr;
    if (d.toDateString() === now.toDateString()) {
      dayStr = 'Today';
    } else {
      var tom = new Date(now); tom.setDate(tom.getDate() + 1);
      if (d.toDateString() === tom.toDateString()) dayStr = 'Tomorrow';
      else dayStr = weekdays[d.getDay()] + ' ' + months[d.getMonth()] + ' ' + d.getDate();
    }
    var h = d.getHours();
    var ap = h >= 12 ? 'pm' : 'am';
    var h12 = ((h + 11) % 12) + 1;
    var m = d.getMinutes();
    return dayStr + ' ' + h12 + (m ? ':' + pad2(m) : '') + ap;
  }

  // ---------------------------------------------------------------
  // Fuzzy match helpers
  // ---------------------------------------------------------------

  function normalize(s) { return (s || '').toLowerCase().trim(); }

  function fuzzyScore(haystack, needle) {
    if (!needle) return 0;
    var h = normalize(haystack);
    var n = normalize(needle);
    if (!h) return -1;
    if (h === n) return 100;
    if (h.indexOf(n) === 0) return 80;
    if (h.indexOf(n) >= 0) return 60;
    var words = h.split(/\s+/);
    for (var i = 0; i < words.length; i++) {
      if (words[i].indexOf(n) === 0) return 50;
    }
    return -1;
  }

  function userLabel(u) { return (u && (u.display_name || u.email)) || ''; }

  function userSuggestions(users, query) {
    if (!users || users.length === 0) return [];
    var scored = [];
    for (var i = 0; i < users.length; i++) {
      var u = users[i];
      var s = fuzzyScore(userLabel(u), query);
      if (s > 0 || !query) scored.push({ user: u, score: query ? s : 50 });
    }
    scored.sort(function (a, b) { return b.score - a.score; });
    return scored.slice(0, 8).map(function (x) { return x.user; });
  }

  function buildLinkables(data) {
    var list = [];
    (data.opportunities || []).forEach(function (o) {
      list.push({
        kind: 'opportunity',
        id: o.id,
        number: o.number || '',
        title: o.title || '',
        searchText: (o.number || '') + ' ' + (o.title || '')
      });
    });
    (data.quotes || []).forEach(function (q) {
      list.push({
        kind: 'quote',
        id: q.id,
        number: q.number || '',
        title: q.title || '',
        searchText: (q.number || '') + ' ' + (q.title || '')
      });
    });
    (data.accounts || []).forEach(function (a) {
      list.push({
        kind: 'account',
        id: a.id,
        name: a.name || '',
        alias: a.alias || '',
        searchText: (a.name || '') + ' ' + (a.alias || '')
      });
    });
    return list;
  }

  function linkSuggestions(linkables, query) {
    if (!linkables || linkables.length === 0) return [];
    var scored = [];
    for (var i = 0; i < linkables.length; i++) {
      var l = linkables[i];
      var s = fuzzyScore(l.searchText, query);
      if (s > 0 || !query) scored.push({ item: l, score: query ? s : 50 });
    }
    scored.sort(function (a, b) { return b.score - a.score; });
    return scored.slice(0, 8).map(function (x) { return x.item; });
  }

  function linkableDisplayLabel(item) {
    if (item.kind === 'opportunity') {
      return 'Opportunity ' + item.number + (item.title ? ' \u2014 ' + item.title : '');
    }
    if (item.kind === 'quote') {
      return 'Quote ' + item.number + (item.title ? ' \u2014 ' + item.title : '');
    }
    return 'Account ' + (item.alias ? item.name + ' (' + item.alias + ')' : item.name);
  }

  // ---------------------------------------------------------------
  // Steps config
  // ---------------------------------------------------------------

  var STEPS = [
    {
      key: 'body',
      prompt: 'What needs to be done?',
      hint: 'Press Tab when you are done. Shift+Tab goes back.',
      multiline: true
    },
    {
      key: 'assignee',
      prompt: 'Who needs to do it?',
      hint: 'Start typing a name. Tab to skip and keep yourself assigned.',
      multiline: false
    },
    {
      key: 'due',
      prompt: 'When is it due?',
      hint: 'Try "tomorrow", "friday 5pm", "in 3 days", or a date. Tab to skip.',
      multiline: false
    },
    {
      key: 'remind',
      prompt: 'Remind you when?',
      hint: 'Same formats as "Due". Tab to skip.',
      multiline: false
    },
    {
      key: 'link',
      prompt: 'Link to an opportunity, quote, or account?',
      hint: 'Start typing a name or number. Tab to skip.',
      multiline: false
    }
  ];

  function blankAnswers() {
    return {
      body: '',
      assigneeId: '',
      assigneeLabel: '',
      due: null,
      dueRaw: '',
      remind: null,
      remindRaw: '',
      linkKind: '',
      linkId: '',
      linkLabel: ''
    };
  }

  // ---------------------------------------------------------------
  // Alpine store
  // ---------------------------------------------------------------

  document.addEventListener('alpine:init', function () {
    Alpine.store('taskModal', {
      // Lifecycle state
      open: false,
      submitting: false,
      loading: false,
      pickerLoaded: false,
      reloadOnSuccess: true,
      error: null,

      // Picker data
      users: [],
      opportunities: [],
      quotes: [],
      accounts: [],
      linkables: [],
      currentUserId: null,
      currentUserObj: null,

      // Wizard state
      stepIndex: 0,
      typedInput: '',
      suggestionIndex: 0,
      answers: blankAnswers(),

      // Locked prefill (from caller)
      prefillLocked: false,
      prefillLockedLabel: '',

      // ---- Derived helpers ----
      currentStep: function () { return STEPS[this.stepIndex] || null; },
      currentPrompt: function () {
        var s = this.currentStep();
        return s ? s.prompt : '';
      },
      currentHint: function () {
        var s = this.currentStep();
        return s ? s.hint : '';
      },
      isMultilineStep: function () {
        var s = this.currentStep();
        return !!(s && s.multiline);
      },
      canSubmit: function () {
        return !!(this.answers.body || '').trim();
      },
      truncate: function (s, n) {
        s = String(s || '').replace(/\s+/g, ' ').trim();
        return s.length > n ? s.slice(0, n - 1) + '\u2026' : s;
      },

      chipsList: function () {
        var chips = [];
        var a = this.answers;
        if (a.body) chips.push({ stepIndex: 0, label: 'Task', value: this.truncate(a.body, 36) });
        if (a.assigneeLabel) chips.push({ stepIndex: 1, label: 'Assigned', value: a.assigneeLabel });
        if (a.due) chips.push({ stepIndex: 2, label: 'Due', value: formatDateDisplay(a.due) });
        if (a.remind) chips.push({ stepIndex: 3, label: 'Remind', value: formatDateDisplay(a.remind) });
        if (a.linkLabel && !this.prefillLocked) {
          chips.push({ stepIndex: 4, label: 'Linked', value: a.linkLabel });
        }
        return chips;
      },

      visibleSuggestions: function () {
        var step = this.currentStep();
        if (!step) return [];
        if (step.key === 'assignee') {
          var us = userSuggestions(this.users, this.typedInput);
          return us.map(function (u) {
            return { id: u.id, label: userLabel(u), sub: u.email || '', typeLabel: '' };
          });
        }
        if (step.key === 'link') {
          var ls = linkSuggestions(this.linkables, this.typedInput);
          return ls.map(function (item) {
            var mainLabel, sub = '';
            if (item.kind === 'opportunity') { mainLabel = item.number; sub = item.title || ''; }
            else if (item.kind === 'quote') { mainLabel = item.number; sub = item.title || ''; }
            else { mainLabel = item.alias ? item.name + ' (' + item.alias + ')' : item.name; }
            return {
              id: item.kind + ':' + item.id,
              kind: item.kind,
              refId: item.id,
              label: mainLabel,
              sub: sub,
              typeLabel: item.kind.charAt(0).toUpperCase() + item.kind.slice(1),
              _item: item
            };
          });
        }
        return [];
      },

      // ---- Modal lifecycle ----
      openModal: function (prefill) {
        prefill = prefill || {};
        this.error = null;
        this.reloadOnSuccess = prefill.reload_on_success !== false;

        this.answers = blankAnswers();
        if (this.currentUserId) {
          this.answers.assigneeId = this.currentUserId;
          this.answers.assigneeLabel = userLabel(this.currentUserObj);
        }

        this.prefillLocked = false;
        this.prefillLockedLabel = '';
        if (prefill.opportunity_id) {
          this.answers.linkKind = 'opportunity';
          this.answers.linkId = prefill.opportunity_id;
          this.answers.linkLabel = prefill.link_label || '';
          this.prefillLocked = !!prefill.link_label;
          this.prefillLockedLabel = prefill.link_label || '';
        } else if (prefill.quote_id) {
          this.answers.linkKind = 'quote';
          this.answers.linkId = prefill.quote_id;
          this.answers.linkLabel = prefill.link_label || '';
          this.prefillLocked = !!prefill.link_label;
          this.prefillLockedLabel = prefill.link_label || '';
        } else if (prefill.account_id) {
          this.answers.linkKind = 'account';
          this.answers.linkId = prefill.account_id;
          this.answers.linkLabel = prefill.link_label || '';
          this.prefillLocked = !!prefill.link_label;
          this.prefillLockedLabel = prefill.link_label || '';
        }

        this.stepIndex = 0;
        this.typedInput = '';
        this.suggestionIndex = 0;
        this.open = true;

        if (!this.pickerLoaded) this.loadPickerData();
        this.focusInput();
      },

      closeModal: function () {
        this.open = false;
        this.error = null;
      },

      focusInput: function () {
        setTimeout(function () {
          var el = document.getElementById('task-wizard-input');
          if (el) {
            el.focus();
            if (typeof el.select === 'function') el.select();
          }
        }, 60);
      },

      loadPickerData: function () {
        var self = this;
        self.loading = true;
        fetch('/activities/picker-data', {
          credentials: 'same-origin',
          headers: { 'accept': 'application/json' }
        })
          .then(function (res) { return res.ok ? res.json() : null; })
          .then(function (data) {
            self.loading = false;
            if (!data) { self.error = 'Could not load picker data.'; return; }
            self.users = data.users || [];
            self.opportunities = data.opportunities || [];
            self.quotes = data.quotes || [];
            self.accounts = data.accounts || [];
            self.linkables = buildLinkables(data);
            self.currentUserId = data.current_user_id || null;
            if (self.currentUserId) {
              for (var i = 0; i < self.users.length; i++) {
                if (self.users[i].id === self.currentUserId) {
                  self.currentUserObj = self.users[i];
                  break;
                }
              }
            }
            // Seed the default assignee if we don't already have one
            if (!self.answers.assigneeId && self.currentUserId) {
              self.answers.assigneeId = self.currentUserId;
              self.answers.assigneeLabel = userLabel(self.currentUserObj);
            }
            self.pickerLoaded = true;
          })
          .catch(function () {
            self.loading = false;
            self.error = 'Could not load picker data.';
          });
      },

      // ---- Input handling ----
      onInputChange: function () {
        this.suggestionIndex = 0;
        this.error = null;
      },

      // Write the current typed input into the current-step answer.
      // Returns true on success, false + sets error on failure.
      parseStep: function () {
        var step = this.currentStep();
        if (!step) return true;
        var val = (this.typedInput || '').trim();

        if (step.key === 'body') {
          if (!val) {
            this.error = 'Please enter task details.';
            return false;
          }
          this.answers.body = this.typedInput; // preserve newlines
          return true;
        }

        if (step.key === 'assignee') {
          if (!val) {
            if (!this.answers.assigneeId && this.currentUserId) {
              this.answers.assigneeId = this.currentUserId;
              this.answers.assigneeLabel = userLabel(this.currentUserObj);
            }
            return true;
          }
          var us = userSuggestions(this.users, val);
          if (us.length === 0) {
            this.error = 'No matching user. Tab to skip.';
            return false;
          }
          var picked = us[Math.max(0, Math.min(this.suggestionIndex, us.length - 1))];
          this.answers.assigneeId = picked.id;
          this.answers.assigneeLabel = userLabel(picked);
          return true;
        }

        if (step.key === 'due' || step.key === 'remind') {
          var field = step.key;
          if (!val) {
            this.answers[field] = null;
            this.answers[field + 'Raw'] = '';
            return true;
          }
          var d = parseDateInput(val);
          if (!d) {
            this.error = 'Could not understand that date. Try "tomorrow" or "2026-04-20".';
            return false;
          }
          this.answers[field] = d;
          this.answers[field + 'Raw'] = val;
          return true;
        }

        if (step.key === 'link') {
          if (this.prefillLocked) return true;
          if (!val) {
            this.answers.linkKind = '';
            this.answers.linkId = '';
            this.answers.linkLabel = '';
            return true;
          }
          var ls = linkSuggestions(this.linkables, val);
          if (ls.length === 0) {
            this.error = 'No matching record. Tab to skip.';
            return false;
          }
          var pl = ls[Math.max(0, Math.min(this.suggestionIndex, ls.length - 1))];
          this.answers.linkKind = pl.kind;
          this.answers.linkId = pl.id;
          this.answers.linkLabel = linkableDisplayLabel(pl);
          return true;
        }

        return true;
      },

      currentTypedForStep: function () {
        var step = this.currentStep();
        if (!step) return '';
        if (step.key === 'body') return this.answers.body || '';
        if (step.key === 'assignee') return this.answers.assigneeLabel || '';
        if (step.key === 'due') return this.answers.dueRaw || '';
        if (step.key === 'remind') return this.answers.remindRaw || '';
        if (step.key === 'link') return this.answers.linkLabel || '';
        return '';
      },

      advance: function () {
        if (!this.parseStep()) return;
        var nextIdx = this.stepIndex + 1;
        // Skip the link step if the caller pre-locked a linked record
        if (nextIdx === 4 && this.prefillLocked) {
          this.submit();
          return;
        }
        if (nextIdx >= STEPS.length) {
          this.submit();
          return;
        }
        this.stepIndex = nextIdx;
        this.typedInput = '';
        this.suggestionIndex = 0;
        this.focusInput();
      },

      goBack: function () {
        if (this.stepIndex <= 0) return;
        this.stepIndex -= 1;
        this.typedInput = this.currentTypedForStep();
        this.suggestionIndex = 0;
        this.focusInput();
      },

      jumpTo: function (idx) {
        if (idx < 0 || idx >= STEPS.length) return;
        if (idx === 4 && this.prefillLocked) return;
        this.stepIndex = idx;
        this.typedInput = this.currentTypedForStep();
        this.suggestionIndex = 0;
        this.focusInput();
      },

      pickSuggestion: function (idx) {
        this.suggestionIndex = idx;
        this.advance();
      },

      moveSuggestion: function (delta) {
        var sugs = this.visibleSuggestions();
        if (sugs.length === 0) return;
        this.suggestionIndex = (this.suggestionIndex + delta + sugs.length) % sugs.length;
      },

      // ---- Submit ----
      submit: function () {
        if (!this.parseStep()) return;
        if (!(this.answers.body || '').trim()) {
          this.error = 'Please enter task details.';
          this.stepIndex = 0;
          this.typedInput = this.answers.body || '';
          this.focusInput();
          return;
        }
        var self = this;
        if (self.submitting) return;
        self.submitting = true;
        self.error = null;

        var fd = new FormData();
        fd.append('body', self.answers.body);
        if (self.answers.assigneeId) fd.append('assigned_user_id', self.answers.assigneeId);
        if (self.answers.due) fd.append('due_at', toLocalIso(self.answers.due));
        if (self.answers.remind) fd.append('remind_at', toLocalIso(self.answers.remind));
        if (self.answers.linkKind === 'opportunity' && self.answers.linkId) {
          fd.append('opportunity_id', self.answers.linkId);
        } else if (self.answers.linkKind === 'quote' && self.answers.linkId) {
          fd.append('quote_id', self.answers.linkId);
        } else if (self.answers.linkKind === 'account' && self.answers.linkId) {
          fd.append('account_id', self.answers.linkId);
        }
        fd.append('source', 'modal');

        fetch('/activities', {
          method: 'POST',
          credentials: 'same-origin',
          body: fd,
          headers: { 'x-requested-with': 'XMLHttpRequest', 'accept': 'application/json' }
        })
          .then(function (res) {
            return res.json().then(function (data) { return { ok: res.ok, data: data }; });
          })
          .then(function (result) {
            self.submitting = false;
            if (!result.ok || !result.data || !result.data.ok) {
              self.error = (result.data && result.data.error) || 'Could not create task.';
              return;
            }
            self.closeModal();
            if (self.reloadOnSuccess) window.location.reload();
          })
          .catch(function () {
            self.submitting = false;
            self.error = 'Could not create task.';
          });
      }
    });

    // External API
    window.addEventListener('pms:open-task-modal', function (e) {
      Alpine.store('taskModal').openModal((e && e.detail) || {});
    });
    window.PMS = window.PMS || {};
    window.PMS.openTaskModal = function (prefill) {
      Alpine.store('taskModal').openModal(prefill || {});
    };
  });
})();
