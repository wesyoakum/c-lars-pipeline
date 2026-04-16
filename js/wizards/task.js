// js/wizards/task.js
//
// Task wizard — registers the 'task' wizard with the shared engine
// in /js/wizard-modal.js.
//
// Steps:
//   1. body      — "What needs to be done?"      (textarea, required)
//   2. assignee  — "Who needs to do it?"         (user-select, defaults to current user)
//   3. due       — "When is it due?"             (date, optional)
//   4. remind    — "Remind you when?"            (date, optional)
//   5. link      — "Link to an opportunity/quote/account?"  (entity-select, optional; skipped when caller pre-locked a link)
//
// Prefill (from openTaskModal / openWizard('task', ...)):
//   { opportunity_id | quote_id | account_id, link_label, reload_on_success }
//
// If link_label is provided, the link step is skipped and the pinned
// "Linked to: <label>" row is shown above the prompt.

(function () {
  'use strict';

  if (!window.PMS || typeof window.PMS.registerWizard !== 'function') {
    // wizard-modal.js hasn't loaded yet — this file was loaded out of order.
    /* eslint-disable-next-line no-console */
    if (typeof console !== 'undefined') console.error('wizards/task.js: wizard-modal.js must load first');
    return;
  }

  function toLocalIso(d) {
    function pad2(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
         + 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  window.PMS.registerWizard('task', {
    title: 'New task',
    submitLabel: 'Create task',

    steps: [
      {
        key: 'body',
        type: 'textarea',
        prompt: 'What needs to be done?',
        hint: 'Press Tab when you are done. Shift+Tab goes back.',
        placeholder: 'Type your task\u2026',
        required: true,
        requiredError: 'Please enter task details.'
      },
      {
        key: 'assignee',
        type: 'user-select',
        prompt: 'Who needs to do it?',
        hint: 'Start typing a name. Tab to skip and keep yourself assigned.',
        defaultToCurrentUser: true
      },
      {
        key: 'due',
        type: 'date',
        prompt: 'When is it due?',
        hint: 'Try "tomorrow", "friday 5pm", "in 3 days", or a date. Tab to skip.'
      },
      {
        key: 'remind',
        type: 'date',
        prompt: 'Remind you when?',
        hint: 'Same formats as "Due". Tab to skip.'
      },
      {
        key: 'link',
        type: 'entity-select',
        prompt: 'Link to an opportunity, quote, or account?',
        hint: 'Start typing a name or number. Tab to skip.',
        entityKinds: ['opportunity', 'quote', 'account'],
        // Skip entirely if the caller passed a pre-resolved link (e.g.
        // the "+ Task" button on an opportunity's page).
        skipWhen: function (answers, ctx) {
          return !!(ctx && ctx.pinnedValue && answers.link && answers.link.id);
        }
      }
    ],

    blankAnswers: function () {
      return {
        body: '',
        assignee: null,      // { id, label, email }
        due: null,           // { raw, parsed }
        remind: null,        // { raw, parsed }
        link: null           // { kind, id, label }
      };
    },

    // Pre-fill the link step from { opportunity_id | quote_id | account_id } +
    // link_label, and tell the engine to show the pinned row + skip the step.
    applyPrefill: function (answers, prefill /*, ctx */) {
      if (!prefill) return null;
      var kind = null, id = null;
      if (prefill.opportunity_id) { kind = 'opportunity'; id = prefill.opportunity_id; }
      else if (prefill.quote_id) { kind = 'quote'; id = prefill.quote_id; }
      else if (prefill.account_id) { kind = 'account'; id = prefill.account_id; }
      if (!kind) return null;
      answers.link = {
        kind: kind,
        id: id,
        label: prefill.link_label || ''
      };
      if (prefill.link_label) {
        return { locked: true, prefix: 'Linked to', label: prefill.link_label };
      }
      return null;
    },

    submit: function (answers /*, ctx */) {
      var fd = new FormData();
      fd.append('body', answers.body || '');
      if (answers.assignee && answers.assignee.id) fd.append('assigned_user_id', answers.assignee.id);
      if (answers.due && answers.due.parsed) fd.append('due_at', toLocalIso(answers.due.parsed));
      if (answers.remind && answers.remind.parsed) fd.append('remind_at', toLocalIso(answers.remind.parsed));
      if (answers.link && answers.link.id) {
        if (answers.link.kind === 'opportunity') fd.append('opportunity_id', answers.link.id);
        else if (answers.link.kind === 'quote') fd.append('quote_id', answers.link.id);
        else if (answers.link.kind === 'account') fd.append('account_id', answers.link.id);
      }
      fd.append('source', 'modal');

      return fetch('/activities', {
        method: 'POST',
        credentials: 'same-origin',
        body: fd,
        headers: { 'x-requested-with': 'XMLHttpRequest', 'accept': 'application/json' }
      })
        .then(function (res) {
          return res.json().then(function (data) { return { ok: res.ok, data: data }; });
        })
        .then(function (result) {
          if (!result.ok || !result.data || !result.data.ok) {
            return { ok: false, error: (result.data && result.data.error) || 'Could not create task.' };
          }
          return { ok: true };
        })
        .catch(function () {
          return { ok: false, error: 'Could not create task.' };
        });
    }
  });
})();
