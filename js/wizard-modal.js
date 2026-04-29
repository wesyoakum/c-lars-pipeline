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
//   window.Pipeline.registerWizard('<key>', { title, steps, submit, ... })
// to register itself.
//
// Opening a wizard:
//   window.Pipeline.openWizard('task', { opportunity_id: '...' })
//   window.Pipeline.openWizard('account', {})
//   window.dispatchEvent(new CustomEvent('pipeline:open-wizard',
//     { detail: { key: 'account', prefill: {} } }))
//
// Back-compat shim: window.Pipeline.openTaskModal(prefill) still works and
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
    // Each entry carries an `active` flag (0|1) copied straight from
    // picker-data. The wizard hides rows where active=0 unless the
    // user ticked "Show inactive" on the current step.
    var list = [];
    (data.opportunities || []).forEach(function (o) {
      list.push({
        kind: 'opportunity',
        id: o.id,
        number: o.number || '',
        title: o.title || '',
        account_id: o.account_id || '',
        active: o.active == null ? 1 : (o.active ? 1 : 0),
        searchText: (o.number || '') + ' ' + (o.title || '')
      });
    });
    (data.quotes || []).forEach(function (q) {
      list.push({
        kind: 'quote',
        id: q.id,
        number: q.number || '',
        title: q.title || '',
        active: q.active == null ? 1 : (q.active ? 1 : 0),
        searchText: (q.number || '') + ' ' + (q.title || '')
      });
    });
    (data.accounts || []).forEach(function (a) {
      list.push({
        kind: 'account',
        id: a.id,
        name: a.name || '',
        alias: a.alias || '',
        active: a.active == null ? 1 : (a.active ? 1 : 0),
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

  window.Pipeline = window.Pipeline || {};
  window.Pipeline.wizardHelpers = {
    toLocalIso: toLocalIso,
    parseDateInput: parseDateInput,
    userLabel: userLabel
  };

  // ---------------------------------------------------------------
  // Wizard registry
  // ---------------------------------------------------------------

  var WIZARDS = Object.create(null);

  window.Pipeline.registerWizard = function (key, config) {
    if (!key || !config) return;
    WIZARDS[key] = config;
  };

  // ---------------------------------------------------------------
  // Public API (set before Alpine boots; queues calls made too early)
  // ---------------------------------------------------------------

  var __pendingOpen = null;

  window.Pipeline.openWizard = function (key, prefill) {
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
  window.Pipeline.openTaskModal = function (prefill) {
    window.Pipeline.openWizard('task', prefill || {});
  };

  window.addEventListener('pipeline:open-task-modal', function (e) {
    window.Pipeline.openTaskModal((e && e.detail) || {});
  });
  window.addEventListener('pipeline:open-wizard', function (e) {
    if (!e || !e.detail || !e.detail.key) return;
    window.Pipeline.openWizard(e.detail.key, e.detail.prefill || {});
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
      groups: [],                      // [{ slug, label, member_ids }]
      prefs: { show_alias: 0, group_rollup: 0 },
      currentUserId: null,
      currentUserObj: null,

      // Wizard state
      stepIndex: 0,
      typedInput: '',
      suggestionIndex: 0,
      answers: {},

      // Two-stage account picker: when group_rollup is on and the user
      // selects a group with multiple members, we don't advance the step
      // — we drill into a member-pick sub-stage on the same step.
      // `null` = top-level (groups + ungrouped); `{ slug, label, member_ids }`
      // = drilled into a specific group's member list.
      groupDrillDown: null,

      // Nested wizard support: when an entity-select step has a
      // `createAction` and the user picks "+ New <thing>", we snapshot
      // the parent state, open the child wizard, and on the child's
      // success restore the parent and feed it the new entity.
      // Each frame: { wizardKey, config, stepIndex, answers, typedInput,
      //               suggestionIndex, pinnedPrefix, pinnedValue,
      //               groupDrillDown, onSuccess }
      parentStack: [],

      // Pinned "Linked to:" row (or similar) — set by config.applyPrefill
      pinnedPrefix: '',
      pinnedValue: '',

      // Per-step "Show inactive" override for entity-select steps.
      // Resets to false on every modal open. Used by:
      //   - visibleSuggestions() — when false, rows with active=0 are
      //     filtered out (provided the global pref is on; otherwise
      //     everything's active by construction)
      //   - toggleShowInactive() — flips it and re-fetches picker-data
      //     with ?include_inactive=1 the first time the user opts in,
      //     so inactive records actually exist in the local store.
      showInactive: false,

      // Smart-start state (Phase 3 of wizard cleanup). When the wizard
      // config opts in via `smartStart: { ... }`, the modal opens in
      // capture mode: user pastes text or drops a photo, we POST it to
      // /ai-inbox/new for extraction, then map the extracted fields
      // into the wizard's answers and switch to the standard step UI.
      // The AI Inbox entry id is held so we can link it to the
      // newly-created record on submit.
      phase: 'steps',                    // 'smart-start' | 'steps'
      smartStartText: '',
      smartStartBusy: false,
      smartStartError: null,
      aiInboxEntryId: null,              // id of the entry created via Smart-start (if any)
      inactiveFetched: false,

      // Whether the "Show inactive" checkbox should render at all on
      // the current step. Computed in the markup, not here.
      activeOnlyPref: function () {
        return !!(this.prefs && this.prefs.active_only);
      },
      shouldOfferInactiveToggle: function () {
        var step = this.currentStep();
        if (!step || step.type !== 'entity-select') return false;
        return this.activeOnlyPref();
      },

      // ---- Derived helpers ----
      steps: function () {
        return (this.config && this.config.steps) || [];
      },
      currentStep: function () {
        return this.steps()[this.stepIndex] || null;
      },
      currentPrompt: function () {
        if (this.groupDrillDown) {
          return 'Which account in ' + this.groupDrillDown.label + '?';
        }
        var s = this.currentStep();
        return s ? (s.prompt || '') : '';
      },
      currentHint: function () {
        if (this.groupDrillDown) {
          return 'Pick the specific account. Shift+Tab to back out to the group list.';
        }
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

      // True when there are no further non-skipped steps after the
      // current one — i.e. the primary action button should say
      // "Create" / "Save" instead of "Next".
      isLastStep: function () {
        var steps = this.steps();
        for (var i = this.stepIndex + 1; i < steps.length; i++) {
          if (!this.shouldSkipStep(steps[i])) return false;
        }
        return true;
      },

      // Label for the primary "advance" button: "Next" on intermediate
      // steps, the wizard's submit label on the last step.
      primaryButtonLabel: function () {
        return this.isLastStep() ? this.submitLabel() : 'Next';
      },

      // {current, total} for the step indicator. Counts only
      // non-skipped steps, and current is 1-based among visible steps.
      // Returns null if there's only one visible step (no point
      // showing "1 of 1").
      stepProgress: function () {
        var steps = this.steps();
        var visible = [];
        for (var i = 0; i < steps.length; i++) {
          if (!this.shouldSkipStep(steps[i])) visible.push(i);
        }
        if (visible.length <= 1) return null;
        var pos = visible.indexOf(this.stepIndex);
        if (pos < 0) return null;
        return { current: pos + 1, total: visible.length };
      },

      stepProgressLabel: function () {
        var p = this.stepProgress();
        return p ? (p.current + ' of ' + p.total) : '';
      },

      // Primary footer button behavior. Mid-wizard the button advances
      // (same as Tab); on the last step it submits. The label flips
      // accordingly (see primaryButtonLabel). Tab/Enter still work for
      // keyboard users — this is the touch-friendly equivalent.
      primaryAction: function () {
        if (this.isLastStep()) this.submit();
        else this.advance();
      },
      primaryDisabled: function () {
        if (this.submitting) return true;
        // On the last step the button is the submit; gate it on the
        // existing canSubmit() check (all required fields filled).
        if (this.isLastStep() && !this.canSubmit()) return true;
        return false;
      },

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
          var showAlias = !!(this.prefs && this.prefs.show_alias);
          var groupRollup = !!(this.prefs && this.prefs.group_rollup);
          var accountKindAllowed = kinds.indexOf('account') >= 0;

          // Active-only filter: when the global pref is on and the user
          // hasn't ticked "Show inactive" on this step, drop rows whose
          // `active` flag is 0. When the pref is off, every row already
          // comes from picker-data as active=1 (the server only tags
          // inactive rows when filtering is bypassed).
          var activeOnly = !!(this.prefs && this.prefs.active_only) && !this.showInactive;

          // Drill-down stage: only this group's members.
          if (this.groupDrillDown && accountKindAllowed) {
            var memberSet = {};
            (this.groupDrillDown.member_ids || []).forEach(function (id) { memberSet[id] = 1; });
            var members = this.linkables.filter(function (l) {
              if (l.kind !== 'account' || !memberSet[l.id]) return false;
              if (activeOnly && l.active === 0) return false;
              return true;
            });
            return linkSuggestions(members, this.typedInput).map(function (item) {
              var mainLabel = showAlias
                ? (item.alias || item.name)
                : (item.alias ? item.name + ' (' + item.alias + ')' : item.name);
              return {
                id: 'account:' + item.id,
                kind: 'account',
                refId: item.id,
                label: mainLabel,
                sub: '',
                typeLabel: 'Account',
                _item: item
              };
            });
          }

          // Build base list: opps/quotes pass through; accounts swap to
          // (groups + ungrouped accounts) when group_rollup is on.
          var pool = [];
          var accountById = {};
          this.accounts.forEach(function (a) { accountById[a.id] = a; });
          for (var i = 0; i < this.linkables.length; i++) {
            var l = this.linkables[i];
            if (kinds.indexOf(l.kind) < 0) continue;
            if (activeOnly && l.active === 0) continue;
            if (l.kind === 'account' && groupRollup) {
              var aRow = accountById[l.id];
              if (aRow && aRow.parent_group) continue; // grouped: skip; group entry below
            }
            if (typeof step.filterFn === 'function' && !step.filterFn(l, ans)) continue;
            pool.push(l);
          }
          if (accountKindAllowed && groupRollup) {
            // Synthesize one entry per group (with member_ids resolved).
            (this.groups || []).forEach(function (g) {
              pool.push({
                kind: 'account-group',
                id: g.slug,
                slug: g.slug,
                label: g.label,
                member_ids: g.member_ids || [],
                searchText: g.label
              });
            });
          }

          var out = linkSuggestions(pool, this.typedInput).map(function (item) {
            var mainLabel, sub = '', typeLabel = item.kind.charAt(0).toUpperCase() + item.kind.slice(1);
            if (item.kind === 'opportunity') { mainLabel = item.number; sub = item.title || ''; }
            else if (item.kind === 'quote') { mainLabel = item.number; sub = item.title || ''; }
            else if (item.kind === 'account-group') {
              mainLabel = item.label;
              var n = (item.member_ids || []).length;
              sub = n === 1 ? '1 account' : n + ' accounts';
              typeLabel = 'Group';
            } else {
              mainLabel = showAlias
                ? (item.alias || item.name)
                : (item.alias ? item.name + ' (' + item.alias + ')' : item.name);
            }
            return {
              id: item.kind + ':' + item.id,
              kind: item.kind,
              refId: item.id,
              label: mainLabel,
              sub: sub,
              typeLabel: typeLabel,
              _item: item
            };
          });
          // Append a synthetic "+ New <thing>" entry when the step
          // wants to offer creation of a fresh record. Always shown
          // last so it doesn't shove existing matches off the bottom.
          if (step.createAction) {
            var ca = step.createAction;
            var createSub = ca.subFromTyped && this.typedInput
              ? '"' + String(this.typedInput).trim() + '"'
              : (ca.sub || '');
            out.push({
              id: '__create__',
              kind: 'create',
              refId: null,
              label: ca.label || '+ New record',
              sub: createSub,
              typeLabel: ca.typeLabel || 'New',
              _create: ca
            });
          }
          return out;
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
        // v3 in-context creation: when prefill.__on_success is a string,
        // we suppress the default redirect/reload after a successful
        // submit and instead dispatch a CustomEvent with that name on
        // window. The detail object includes the wizard key, the server
        // response, and the original prefill so listeners can correlate
        // the new entity back to whatever opened the wizard. See AI
        // Inbox detail page for an example caller.
        this.onSuccessEvent = (typeof prefill.__on_success === 'string' && prefill.__on_success)
          ? prefill.__on_success
          : null;
        this.openPrefill = prefill;
        this.stepIndex = 0;
        this.typedInput = '';
        this.suggestionIndex = 0;
        this.pinnedPrefix = '';
        this.pinnedValue = '';
        this.groupDrillDown = null;
        // Reset per-wizard-session "Show inactive" state. We don't reset
        // `inactiveFetched` — the picker-data includes/excludes inactive
        // on a per-fetch basis. loadPickerData() decides which mode to
        // pull based on showInactive + the active_only pref.
        this.showInactive = false;

        // Smart-start: open in capture mode when the wizard config opts
        // in (and the caller hasn't bypassed it via skipSmartStart in
        // the prefill — used when chaining wizards where the upstream
        // already extracted everything).
        this.phase = (config.smartStart && !prefill.skipSmartStart) ? 'smart-start' : 'steps';
        this.smartStartText = '';
        this.smartStartBusy = false;
        this.smartStartError = null;
        this.aiInboxEntryId = null;

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
        // Closing the current modal cancels any nested-wizard chain.
        // (We don't auto-restore the parent on close — that'd be
        // surprising when the user clicked outside expecting a hard
        // dismissal.)
        this.parentStack = [];
        this.open = false;
        this.error = null;
      },

      // ---- Smart-start (Phase 3) ----
      // Submit the typed text or selected file to /ai-inbox/new for
      // extraction, then map the structured output into the wizard's
      // answers via the per-wizard config.applyExtraction callback,
      // and switch to the standard step UI for confirmation/edit.
      runSmartStart: function () {
        var self = this;
        var text = (self.smartStartText || '').trim();
        if (!text) { self.smartStartError = 'Type or paste something first.'; return; }
        if (self.smartStartBusy) return;
        self.smartStartBusy = true;
        self.smartStartError = null;
        var fd = new FormData();
        fd.append('text', text);
        return self._sendSmartStart(fd);
      },
      runSmartStartFromFile: function (file) {
        var self = this;
        if (!file || self.smartStartBusy) return;
        self.smartStartBusy = true;
        self.smartStartError = null;
        var fd = new FormData();
        fd.append('file', file);
        return self._sendSmartStart(fd);
      },
      _sendSmartStart: function (fd) {
        var self = this;
        return fetch('/ai-inbox/new', {
          method: 'POST',
          credentials: 'same-origin',
          body: fd,
          headers: { accept: 'application/json' },
        })
          .then(function (res) { return res.json().then(function (j) { return { ok: res.ok, j: j }; }); })
          .then(function (r) {
            self.smartStartBusy = false;
            if (!r.ok || !r.j || !r.j.ok) {
              self.smartStartError = (r.j && (r.j.detail || r.j.error)) || 'Extraction failed.';
              return;
            }
            self.aiInboxEntryId = r.j.id || null;
            // Hand the extraction to the wizard's mapper. The mapper
            // returns the same { locked, prefix, label } shape as
            // applyPrefill so we honor the pinned-row affordance for
            // any matched account / linked record the extractor found.
            if (self.config && typeof self.config.applyExtraction === 'function') {
              try {
                var pinned = self.config.applyExtraction(self.answers, r.j.extracted || {}, self);
                if (pinned && pinned.locked) {
                  self.pinnedPrefix = pinned.prefix || 'Linked to';
                  self.pinnedValue = pinned.label || '';
                }
              } catch (e) {
                /* eslint-disable-next-line no-console */
                if (typeof console !== 'undefined') console.warn('applyExtraction failed:', e);
              }
            }
            // Re-evaluate skippable steps now that prefill landed.
            while (self.shouldSkipStep(self.currentStep()) && self.stepIndex < self.steps().length) {
              self.stepIndex++;
            }
            self.typedInput = self.currentTypedForStep();
            self.phase = 'steps';
            self.focusInput();
          })
          .catch(function (err) {
            self.smartStartBusy = false;
            self.smartStartError = (err && err.message) || 'Network error.';
          });
      },
      skipSmartStart: function () {
        this.phase = 'steps';
        this.typedInput = this.currentTypedForStep();
        this.focusInput();
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

      loadPickerData: function (opts) {
        var self = this;
        var includeInactive = !!(opts && opts.includeInactive);
        self.loading = true;
        var url = '/activities/picker-data' + (includeInactive ? '?include_inactive=1' : '');
        fetch(url, {
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
            self.groups = data.groups || [];
            self.prefs = data.prefs || { show_alias: 0, group_rollup: 0, active_only: 0 };
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
            self.inactiveFetched = includeInactive;
            self.seedDefaults();
          })
          .catch(function () {
            self.loading = false;
            self.error = 'Could not load picker data.';
          });
      },

      // User flipped the "Show inactive" checkbox on the current step.
      // When turning ON, if we haven't yet fetched with inactive
      // records included, trigger a re-fetch so the suggestions pool
      // actually contains them. (If the active_only pref is off, the
      // initial fetch already included everything — no re-fetch needed.)
      toggleShowInactive: function (next) {
        this.showInactive = !!next;
        this.suggestionIndex = 0;
        var prefActive = !!(this.prefs && this.prefs.active_only);
        if (this.showInactive && prefActive && !this.inactiveFetched) {
          this.loadPickerData({ includeInactive: true });
        }
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
          // Use the same suggestion list the user is looking at — that
          // way picking a group drills down, picking an account in
          // drill-down stage stores the account answer.
          var sugs = this.visibleSuggestions();
          if (!sugs || sugs.length === 0) {
            this.error = 'No matching record.' + (step.required ? '' : ' Tab to skip.');
            return false;
          }
          var picked = sugs[Math.max(0, Math.min(this.suggestionIndex, sugs.length - 1))];

          // "+ New <thing>" picked: open the configured child wizard
          // with the typed text as a prefill. parseStep returns a
          // special signal so advance() doesn't move forward.
          if (picked.kind === 'create') {
            var ca = picked._create || {};
            var childPrefill = {};
            if (ca.prefillFromTyped) {
              childPrefill[ca.prefillFromTyped] = (this.typedInput || '').trim();
            }
            // Optional: let the parent seed additional prefill entries
            // from its already-answered steps (e.g. quote wizard pins
            // the chosen account into the new-opportunity child so the
            // account step skips).
            if (typeof ca.mergePrefill === 'function') {
              try {
                var extra = ca.mergePrefill(this.answers);
                if (extra && typeof extra === 'object') {
                  for (var mk in extra) {
                    if (Object.prototype.hasOwnProperty.call(extra, mk)) {
                      childPrefill[mk] = extra[mk];
                    }
                  }
                }
              } catch (e) { /* ignore */ }
            }
            var stepKey = step.key;
            this.openAsChild(ca.wizardKey, childPrefill, function (result, childAnswers) {
              // Restore-then-fill the parent step's answer.
              if (typeof ca.setAnswer === 'function') {
                try { this.answers[stepKey] = ca.setAnswer(result, childAnswers); }
                catch (e) { /* ignore */ }
              }
              this.typedInput = this.currentTypedForStep();
              this.error = null;
              // Move to the next step WITHOUT re-running parseStep. The
              // child's setAnswer has already populated the parent
              // answer with the newly-created record's id; running
              // parseStep again would re-parse typedInput against the
              // stale picker list (which doesn't yet include the new
              // record), fall through to the still-present
              // "+ New <thing>" synthetic suggestion, and re-open the
              // child wizard — infinite loop.
              var idx = this.stepIndex + 1;
              var steps = this.steps();
              while (idx < steps.length && this.shouldSkipStep(steps[idx])) idx++;
              if (idx >= steps.length) { this.submit(); return; }
              this.stepIndex = idx;
              this.typedInput = this.currentTypedForStep();
              this.suggestionIndex = 0;
              this.focusInput();
            });
            return '__child__';
          }

          // Account-group picked at the top level: drill down (multi)
          // or auto-pick the sole member (single).
          if (picked.kind === 'account-group') {
            var memberIds = (picked._item && picked._item.member_ids) || [];
            if (memberIds.length === 1) {
              var only = this.accounts.filter(function (a) { return a.id === memberIds[0]; })[0];
              if (only) {
                var sa = !!(this.prefs && this.prefs.show_alias);
                var lbl = sa
                  ? (only.alias || only.name)
                  : (only.alias ? only.name + ' (' + only.alias + ')' : only.name);
                this.answers[step.key] = { kind: 'account', id: only.id, label: lbl };
                this.groupDrillDown = null;
                return true;
              }
            }
            // Multi-member: enter drill-down. parseStep returns a special
            // truthy signal; advance() detects it and stays on this step.
            this.groupDrillDown = {
              slug: picked._item.slug,
              label: picked._item.label,
              member_ids: memberIds
            };
            this.typedInput = '';
            this.suggestionIndex = 0;
            this.error = null;
            this.answers[step.key] = null;
            return '__drill__';
          }

          // Account picked from drill-down stage — clear drill state.
          this.answers[step.key] = {
            kind: picked.kind,
            id: picked.refId,
            label: picked.label
          };
          this.groupDrillDown = null;
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
        var parsed = this.parseStep();
        if (!parsed) return;
        // Special signal from the entity-select step: user picked a
        // multi-member group — stay on the step in drill-down mode.
        if (parsed === '__drill__') { this.focusInput(); return; }
        // The user picked "+ New <thing>" — openAsChild already swapped
        // us into the child wizard and focused its input. Don't touch
        // the parent step here.
        if (parsed === '__child__') { return; }
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
        // If drilled into a group's member list, back out to the group
        // list first instead of leaving the step.
        if (this.groupDrillDown) {
          this.groupDrillDown = null;
          this.typedInput = '';
          this.suggestionIndex = 0;
          this.error = null;
          this.focusInput();
          return;
        }
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

      // ---- Nested wizards ----
      // Snapshot the current wizard, open `childKey` with `childPrefill`,
      // and remember `onSuccess(result, childAnswers)` to be called
      // (with the parent's `this`) once the child completes successfully.
      openAsChild: function (childKey, childPrefill, onSuccess) {
        if (!WIZARDS[childKey]) {
          this.error = 'No wizard registered for ' + childKey + '.';
          return;
        }
        this.parentStack.push({
          wizardKey: this.wizardKey,
          config: this.config,
          stepIndex: this.stepIndex,
          answers: this.answers,
          typedInput: this.typedInput,
          suggestionIndex: this.suggestionIndex,
          pinnedPrefix: this.pinnedPrefix,
          pinnedValue: this.pinnedValue,
          groupDrillDown: this.groupDrillDown,
          onSuccess: onSuccess || null
        });
        // openModal resets per-wizard state but does NOT clear
        // parentStack, so the frame survives across the swap.
        this.openModal(childKey, childPrefill || {});
      },

      // Restore the most recent parent frame (used after child success
      // and on close-of-child).
      restoreParent: function () {
        if (this.parentStack.length === 0) return null;
        var snap = this.parentStack.pop();
        this.wizardKey = snap.wizardKey;
        this.config = snap.config;
        this.stepIndex = snap.stepIndex;
        this.answers = snap.answers;
        this.typedInput = snap.typedInput;
        this.suggestionIndex = snap.suggestionIndex;
        this.pinnedPrefix = snap.pinnedPrefix;
        this.pinnedValue = snap.pinnedValue;
        this.groupDrillDown = snap.groupDrillDown;
        this.error = null;
        this.open = true;
        return snap;
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
            // Smart-start: if the wizard was opened with a Quick-start
            // capture, the AI Inbox entry was created without an
            // association (since the new record didn't exist yet).
            // Now that we have the id, record a link via the generic
            // /links/record endpoint. Fire and forget — a network blip
            // here shouldn't block the wizard's success flow; the
            // entry just stays unlinked in AI Inbox.
            if (self.aiInboxEntryId && result.id && self.wizardKey) {
              try {
                fetch('/ai-inbox/' + encodeURIComponent(self.aiInboxEntryId) + '/links/record', {
                  method: 'POST',
                  credentials: 'same-origin',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({
                    action_type: 'create_' + self.wizardKey,
                    ref_type: self.wizardKey,
                    ref_id: result.id,
                    ref_label: result.name || result.subject || '',
                  }),
                });
              } catch (e) { /* best-effort */ }
              self.aiInboxEntryId = null;
            }
            // Nested case: pop back to the parent wizard and feed it
            // the new entity instead of redirecting/reloading.
            if (self.parentStack.length > 0) {
              var childAnswers = self.answers;
              var snap = self.restoreParent();
              if (snap && typeof snap.onSuccess === 'function') {
                try { snap.onSuccess.call(self, result, childAnswers); }
                catch (e) { /* ignore */ }
              }
              self.focusInput();
              return;
            }
            self.closeModal();
            // v3 in-context-create: when the caller asked for an event
            // instead of a redirect, dispatch and stop. Listeners get
            // the response, the wizard key, and the original prefill so
            // they can record the new entity wherever they need to.
            if (self.onSuccessEvent) {
              try {
                window.dispatchEvent(new CustomEvent(self.onSuccessEvent, {
                  detail: {
                    key: self.wizardKey,
                    response: result,
                    prefill: self.openPrefill,
                  },
                }));
              } catch (e) { /* ignore — listener handles its own errors */ }
              return;
            }
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
