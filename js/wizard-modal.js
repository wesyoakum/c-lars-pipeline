// js/wizard-modal.js
//
// Generic "conversational form" wizard engine. Walks the user through
// a set of steps one prompt at a time. Tab advances, Shift+Tab goes
// back. Each step is typed (text / textarea / date / user-select /
// entity-select / select) and the engine dispatches to the right
// parser/renderer based on type.
//
// Each concrete wizard (task, account, contact, opportunity, quote,
// job) lives in its own tiny file under /js/wizards/*.js and calls
//   window.PMS.registerWizard('<key>', { title, steps, submit, ... })
// to register itself.
//
// Opening a wizard:
//   window.PMS.openWizard('task', { opportunity_id: '...' })
//   window.PMS.openWizard('account', {})
//   window.dispatchEvent(new CustomEvent('pms:open-wizard',
//     { detail: { key: 'account', prefill: {} } }))
//
// Back-compat shim: window.PMS.openTaskModal(prefill) still works and
// maps to openWizard('task', prefill).
//
// The markup lives in functions/lib/layout.js (WIZARD_MODAL_MARKUP)
// and is injected into every authenticated page.

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

  function parseTimeFragment(s) {
    var m = s.match(/\s*(?:@\s*|at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*$/i);
    if (!m) return null;
    var h = parseInt(m[1], 10);
    var min = m[2] ? parseInt(m[2], 10) : 0;
    var ap = m[3] ? m[3].toLowerCase() : null;
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    if (!ap && h < 13 && !m[2]) return null;
    if (h < 0 || h > 23 || min < 0 || min > 59) return null;
    return { hours: h, minutes: min, rest: s.slice(0, m.index).trim() };
  }

  function parseDateInput(raw) {
    if (!raw) return null;
    var input = String(raw).trim();
    if (!input) return null;

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

    var tf = parseTimeFragment(input);
    var hours = tf ? tf.hours : 9;
    var minutes = tf ? tf.minutes : 0;
    var rest = (tf ? tf.rest : input).toLowerCase().trim();

    var now = new Date();
    var base = null;

    if (!rest) {
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
          diff2 += 7;
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
        if (!tf) return target;
        base = new Date(target.getFullYear(), target.getMonth(), target.getDate());
      }
    }

    if (!base) return null;

    base.setHours(hours, minutes, 0, 0);
    return base;
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
        account_id: o.account_id || '',
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
  // Expose common helpers so individual wizard configs can reuse them
  // (e.g. a submit handler that formats a date answer as YYYY-MM-DD).
  // ---------------------------------------------------------------

  window.PMS = window.PMS || {};
  window.PMS.wizardHelpers = {
    toLocalIso: toLocalIso,
    parseDateInput: parseDateInput,
    userLabel: userLabel
  };

  // ---------------------------------------------------------------
  // Wizard registry
  // ---------------------------------------------------------------

  var WIZARDS = Object.create(null);

  window.PMS.registerWizard = function (key, config) {
    if (!key || !config) return;
    WIZARDS[key] = config;
  };

  // ---------------------------------------------------------------
  // Public API (set before Alpine boots; queues calls made too early)
  // ---------------------------------------------------------------

  var __pendingOpen = null;

  window.PMS.openWizard = function (key, prefill) {
    try {
      var store = (typeof Alpine !== 'undefined' && Alpine && typeof Alpine.store === 'function')
        ? Alpine.store('wizard')
        : null;
      if (store && typeof store.openModal === 'function') {
        store.openModal(key, prefill || {});
        return;
      }
    } catch (e) { /* fall through to queue */ }
    __pendingOpen = { key: key, prefill: prefill || {} };
  };

  // Back-compat shim: pre-wizard callers still use openTaskModal.
  window.PMS.openTaskModal = function (prefill) {
    window.PMS.openWizard('task', prefill || {});
  };

  window.addEventListener('pms:open-task-modal', function (e) {
    window.PMS.openTaskModal((e && e.detail) || {});
  });
  window.addEventListener('pms:open-wizard', function (e) {
    if (!e || !e.detail || !e.detail.key) return;
    window.PMS.openWizard(e.detail.key, e.detail.prefill || {});
  });

  // ---------------------------------------------------------------
  // Alpine store
  // ---------------------------------------------------------------

  document.addEventListener('alpine:init', function () {
    Alpine.store('wizard', {
      // Identity
      wizardKey: null,
      config: null,

      // Lifecycle
      open: false,
      submitting: false,
      loading: false,
      pickerLoaded: false,
      pickerNeeded: false,
      reloadOnSuccess: true,
      error: null,

      // Picker data (lazy-loaded only if a step needs it)
      users: [],
      linkables: [],
      opportunities: [],
      quotes: [],
      accounts: [],
      currentUserId: null,
      currentUserObj: null,

      // Wizard state
      stepIndex: 0,
      typedInput: '',
      suggestionIndex: 0,
      answers: {},

      // Pinned "Linked to:" row (or similar) — set by config.applyPrefill
      pinnedPrefix: '',
      pinnedValue: '',

      // ---- Derived helpers ----
      steps: function () {
        return (this.config && this.config.steps) || [];
      },
      currentStep: function () {
        return this.steps()[this.stepIndex] || null;
      },
      currentPrompt: function () {
        var s = this.currentStep();
        return s ? (s.prompt || '') : '';
      },
      currentHint: function () {
        var s = this.currentStep();
        return s ? (s.hint || '') : '';
      },
      currentPlaceholder: function () {
        var s = this.currentStep();
        if (!s) return '';
        if (s.placeholder) return s.placeholder;
        if (s.type === 'user-select' || s.type === 'entity-select') return 'Start typing\u2026';
        if (s.type === 'date') return 'tomorrow 5pm';
        if (s.type === 'textarea') return '';
        return '';
      },
      isMultilineStep: function () {
        var s = this.currentStep();
        return !!(s && s.type === 'textarea');
      },
      isSelectStep: function () {
        var s = this.currentStep();
        return !!(s && s.type === 'select');
      },
      isInputStep: function () {
        var s = this.currentStep();
        if (!s) return false;
        return s.type !== 'select';
      },
      selectOptions: function () {
        var s = this.currentStep();
        return (s && s.options) || [];
      },
      title: function () { return (this.config && this.config.title) || 'New'; },
      submitLabel: function () { return (this.config && this.config.submitLabel) || 'Create'; },

      // Is every required, non-skipped step answered?
      canSubmit: function () {
        var steps = this.steps();
        for (var i = 0; i < steps.length; i++) {
          var step = steps[i];
          if (!step.required) continue;
          if (this.shouldSkipStep(step)) continue;
          if (step.key === this.currentStep_key() && this.typedInput && String(this.typedInput).trim()) {
            continue;  // typed value on the current step will parse in on submit
          }
          var v = this.answers[step.key];
          if (this.isEmptyAnswer(step, v)) return false;
        }
        return true;
      },
      currentStep_key: function () {
        var s = this.currentStep();
        return s ? s.key : '';
      },
      isEmptyAnswer: function (step, v) {
        if (v === null || v === undefined) return true;
        if (step.type === 'text' || step.type === 'textarea') return !String(v).trim();
        if (step.type === 'select') return !v || !v.value;
        if (step.type === 'date') return !v || !v.parsed;
        if (step.type === 'user-select') return !v || !v.id;
        if (step.type === 'entity-select') return !v || !v.id;
        return false;
      },
      shouldSkipStep: function (step) {
        if (!step) return false;
        if (typeof step.skipWhen === 'function') {
          try { return !!step.skipWhen(this.answers, this); }
          catch (e) { return false; }
        }
        return false;
      },

      // ---- Suggestions ----
      visibleSuggestions: function () {
        var step = this.currentStep();
        if (!step) return [];
        if (step.type === 'user-select') {
          return userSuggestions(this.users, this.typedInput).map(function (u) {
            return { id: u.id, label: userLabel(u), sub: u.email || '', typeLabel: '', _user: u };
          });
        }
        if (step.type === 'entity-select') {
          var kinds = step.entityKinds || ['opportunity', 'quote', 'account'];
          var ans = this.answers;
          var filtered = this.linkables.filter(function (l) {
            if (kinds.indexOf(l.kind) < 0) return false;
            if (typeof step.filterFn === 'function' && !step.filterFn(l, ans)) return false;
            return true;
          });
          return linkSuggestions(filtered, this.typedInput).map(function (item) {
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
      openModal: function (key, prefill) {
        prefill = prefill || {};
        var config = WIZARDS[key];
        if (!config) {
          /* eslint-disable-next-line no-console */
          if (typeof console !== 'undefined') console.error('No wizard registered for key:', key);
          return;
        }
        this.wizardKey = key;
        this.config = config;
        this.error = null;
        this.reloadOnSuccess = prefill.reload_on_success !== false;
        this.stepIndex = 0;
        this.typedInput = '';
        this.suggestionIndex = 0;
        this.pinnedPrefix = '';
        this.pinnedValue = '';

        // Seed blank answers
        this.answers = (typeof config.blankAnswers === 'function')
          ? config.blankAnswers()
          : (function (steps) {
              var a = {};
              steps.forEach(function (s) { a[s.key] = null; });
              return a;
            })(this.steps());

        // Apply prefill — config decides what matters and may set pinned.
        if (typeof config.applyPrefill === 'function') {
          var r = config.applyPrefill(this.answers, prefill, this);
          if (r && r.locked) {
            this.pinnedPrefix = r.prefix || 'Linked to';
            this.pinnedValue = r.label || '';
          }
        }

        // Decide whether any step needs picker data (users / entities).
        this.pickerNeeded = this.steps().some(function (s) {
          return s.type === 'user-select' || s.type === 'entity-select';
        });

        this.open = true;

        if (this.pickerNeeded) {
          if (this.pickerLoaded) this.seedDefaults();
          else this.loadPickerData();
        }

        // Skip any steps the config marks as skippable for the current
        // prefill (e.g. locked link step on the task wizard).
        while (this.shouldSkipStep(this.currentStep()) && this.stepIndex < this.steps().length) {
          this.stepIndex++;
        }

        this.typedInput = this.currentTypedForStep();
        this.focusInput();
      },

      closeModal: function () {
        this.open = false;
        this.error = null;
      },

      focusInput: function () {
        setTimeout(function () {
          var el = document.getElementById('wizard-input');
          if (el && typeof el.focus === 'function') {
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
            self.pickerLoaded = true;
            self.seedDefaults();
          })
          .catch(function () {
            self.loading = false;
            self.error = 'Could not load picker data.';
          });
      },

      // Seed step defaults that depend on picker data (e.g. defaulting
      // user-select steps to the current user).
      seedDefaults: function () {
        var self = this;
        this.steps().forEach(function (step) {
          if (step.type === 'user-select' && step.defaultToCurrentUser) {
            var cur = self.answers[step.key];
            if (!cur || !cur.id) {
              if (self.currentUserId && self.currentUserObj) {
                self.answers[step.key] = {
                  id: self.currentUserId,
                  label: userLabel(self.currentUserObj),
                  email: self.currentUserObj.email || ''
                };
              }
            }
          }
        });
        if (this.config && typeof this.config.afterPickerLoad === 'function') {
          try { this.config.afterPickerLoad(this.answers, this); } catch (e) { /* ignore */ }
        }
        // Refresh the current input display if we landed on a user-select
        // step whose default was just populated.
        if (!this.typedInput) this.typedInput = this.currentTypedForStep();
      },

      // ---- Input handling ----
      onInputChange: function () {
        this.suggestionIndex = 0;
        this.error = null;
      },

      // Parse the typed input into the current step's answer.
      // Returns true on success, false + sets error on failure.
      parseStep: function () {
        var step = this.currentStep();
        if (!step) return true;

        if (step.type === 'select') {
          // typedInput holds the selected option value (via x-model).
          var sval = this.typedInput == null ? '' : String(this.typedInput);
          if (!sval) {
            if (step.required) {
              this.error = step.requiredError || 'Please pick an option.';
              return false;
            }
            this.answers[step.key] = null;
            return true;
          }
          var sMatch = (step.options || []).filter(function (o) { return o.value === sval; })[0];
          this.answers[step.key] = sMatch
            ? { value: sMatch.value, label: sMatch.label }
            : { value: sval, label: sval };
          return true;
        }

        var raw = this.typedInput || '';
        var val = raw.trim();

        if (step.type === 'text' || step.type === 'textarea') {
          if (!val) {
            if (step.required) {
              this.error = step.requiredError || 'This field is required.';
              return false;
            }
            this.answers[step.key] = '';
            return true;
          }
          this.answers[step.key] = step.type === 'textarea' ? raw : val;
          return true;
        }

        if (step.type === 'user-select') {
          if (!val) {
            if (step.required && this.isEmptyAnswer(step, this.answers[step.key])) {
              this.error = step.requiredError || 'Please pick a user.';
              return false;
            }
            // Keep whatever is there (may be the default)
            return true;
          }
          var us = userSuggestions(this.users, val);
          if (us.length === 0) {
            this.error = 'No matching user.' + (step.required ? '' : ' Tab to skip.');
            return false;
          }
          var picked = us[Math.max(0, Math.min(this.suggestionIndex, us.length - 1))];
          this.answers[step.key] = { id: picked.id, label: userLabel(picked), email: picked.email || '' };
          return true;
        }

        if (step.type === 'entity-select') {
          if (!val) {
            if (step.required && this.isEmptyAnswer(step, this.answers[step.key])) {
              this.error = step.requiredError || 'Please pick a record.';
              return false;
            }
            if (!this.answers[step.key] || !this.answers[step.key].id) {
              this.answers[step.key] = null;
            }
            return true;
          }
          var kinds = step.entityKinds || ['opportunity', 'quote', 'account'];
          var ans2 = this.answers;
          var filtered = this.linkables.filter(function (l) {
            if (kinds.indexOf(l.kind) < 0) return false;
            if (typeof step.filterFn === 'function' && !step.filterFn(l, ans2)) return false;
            return true;
          });
          var ls = linkSuggestions(filtered, val);
          if (ls.length === 0) {
            this.error = 'No matching record.' + (step.required ? '' : ' Tab to skip.');
            return false;
          }
          var pl = ls[Math.max(0, Math.min(this.suggestionIndex, ls.length - 1))];
          this.answers[step.key] = {
            kind: pl.kind,
            id: pl.id,
            label: linkableDisplayLabel(pl)
          };
          return true;
        }

        if (step.type === 'date') {
          if (!val) {
            if (step.required) {
              this.error = step.requiredError || 'Please enter a date.';
              return false;
            }
            this.answers[step.key] = null;
            return true;
          }
          var d = parseDateInput(val);
          if (!d) {
            this.error = 'Could not understand that date. Try "tomorrow" or "2026-04-20".';
            return false;
          }
          this.answers[step.key] = { raw: val, parsed: d };
          return true;
        }

        return true;
      },

      // What text should show in the input when we (re)enter a step.
      currentTypedForStep: function () {
        var step = this.currentStep();
        if (!step) return '';
        var v = this.answers[step.key];
        if (v === null || v === undefined) return '';
        if (step.type === 'text' || step.type === 'textarea') return String(v || '');
        if (step.type === 'user-select') return (v && v.label) || '';
        if (step.type === 'entity-select') return (v && v.label) || '';
        if (step.type === 'date') return (v && v.raw) || '';
        if (step.type === 'select') return (v && v.value) || '';
        return '';
      },

      advance: function () {
        if (!this.parseStep()) return;
        var idx = this.stepIndex + 1;
        var steps = this.steps();
        while (idx < steps.length && this.shouldSkipStep(steps[idx])) idx++;
        if (idx >= steps.length) { this.submit(); return; }
        this.stepIndex = idx;
        this.typedInput = this.currentTypedForStep();
        this.suggestionIndex = 0;
        this.focusInput();
      },

      goBack: function () {
        var idx = this.stepIndex - 1;
        var steps = this.steps();
        while (idx >= 0 && this.shouldSkipStep(steps[idx])) idx--;
        if (idx < 0) return;
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
        // Validate every required, non-skipped step.
        var steps = this.steps();
        for (var i = 0; i < steps.length; i++) {
          var step = steps[i];
          if (!step.required) continue;
          if (this.shouldSkipStep(step)) continue;
          if (this.isEmptyAnswer(step, this.answers[step.key])) {
            this.error = step.requiredError || 'Missing: ' + (step.prompt || step.key);
            this.stepIndex = i;
            this.typedInput = this.currentTypedForStep();
            this.focusInput();
            return;
          }
        }

        var self = this;
        if (self.submitting) return;
        if (!self.config || typeof self.config.submit !== 'function') {
          self.error = 'No submit handler.';
          return;
        }
        self.submitting = true;
        self.error = null;
        Promise.resolve()
          .then(function () { return self.config.submit(self.answers, self); })
          .then(function (result) {
            self.submitting = false;
            if (!result || !result.ok) {
              self.error = (result && result.error) || 'Could not save.';
              return;
            }
            self.closeModal();
            if (result.redirectUrl) {
              window.location.href = result.redirectUrl;
              return;
            }
            if (self.reloadOnSuccess) window.location.reload();
          })
          .catch(function (err) {
            self.submitting = false;
            self.error = (err && err.message) || 'Could not save.';
          });
      }
    });

    // Drain any queued open from before alpine:init fired.
    if (__pendingOpen) {
      var q = __pendingOpen;
      __pendingOpen = null;
      Alpine.store('wizard').openModal(q.key, q.prefill);
    }
  });
})();
