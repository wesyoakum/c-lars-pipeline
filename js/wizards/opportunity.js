// js/wizards/opportunity.js
//
// Opportunity wizard — registers the 'opportunity' wizard with the
// shared engine in /js/wizard-modal.js.
//
// Steps:
//   1. title     — "What's the opportunity title?"  (text, required)
//   2. type      — "What type of work?"             (select: spares / eps / refurb / service, required)
//   3. account   — "Which account?"                 (entity-select accounts only, required; offers "+ New account")
//   4. value     — "Estimated value in USD?"        (text, optional)
//   5. owner     — "Who owns this?"                 (user-select, defaults to current user)
//   6. notes     — "Any notes?"                     (textarea, optional)
//
// Transaction type is a single value at creation. Hybrid (comma-
// separated) types can be added later from the opportunity detail
// page — keeping the wizard short here matters more than capturing
// every permutation up front.
//
// Prefill (from openWizard('opportunity', ...)):
//   { account_id, account_label, title, reload_on_success }
//
// If account_id is prefilled (e.g. from the "+ New opportunity"
// button on an account detail page) the account step is skipped
// and a pinned "Account: <name>" row is shown.
//
// On success the engine navigates to /opportunities/<new id>.

(function () {
  'use strict';

  if (!window.PMS || typeof window.PMS.registerWizard !== 'function') {
    /* eslint-disable-next-line no-console */
    if (typeof console !== 'undefined') console.error('wizards/opportunity.js: wizard-modal.js must load first');
    return;
  }

  var TYPE_OPTIONS = [
    { value: '',        label: '\u2014 Pick a type \u2014' },
    { value: 'spares',  label: 'Spares' },
    { value: 'eps',     label: 'Engineered Product (EPS)' },
    { value: 'refurb',  label: 'Refurbishment' },
    { value: 'service', label: 'Service' }
  ];

  window.PMS.registerWizard('opportunity', {
    title: 'New opportunity',
    submitLabel: 'Create opportunity',

    steps: [
      {
        key: 'title',
        type: 'text',
        prompt: 'What\u2019s the opportunity title?',
        hint: 'A short description of what the customer wants. Tab to continue.',
        placeholder: 'e.g. Spare control valves for pump station',
        required: true,
        requiredError: 'Title is required.'
      },
      {
        key: 'type',
        type: 'select',
        prompt: 'What type of work?',
        hint: 'Pick one. You can add more types later on the detail page.',
        options: TYPE_OPTIONS,
        required: true,
        requiredError: 'Please pick a type.'
      },
      {
        key: 'account',
        type: 'entity-select',
        prompt: 'Which account?',
        hint: 'Start typing an account name or alias. Shift+Tab goes back.',
        entityKinds: ['account'],
        required: true,
        requiredError: 'Please pick an account.',
        // Skip entirely if the caller prefilled an account (e.g. the
        // opportunity was launched from an account detail page).
        skipWhen: function (answers, ctx) {
          return !!(ctx && ctx.pinnedValue && ctx.pinnedPrefix === 'Account'
                   && answers.account && answers.account.id);
        },
        // Offer a "+ New account" row at the bottom of the suggestions.
        // Picking it opens the account wizard as a child — on success
        // we pop back here with the new account already filled in.
        createAction: {
          wizardKey: 'account',
          label: '+ New account',
          typeLabel: 'New',
          subFromTyped: true,
          prefillFromTyped: 'name',
          setAnswer: function (result, childAnswers) {
            var label = (childAnswers && childAnswers.name) || (result && result.name) || '';
            return {
              kind: 'account',
              id: result && result.id,
              label: label
            };
          }
        }
      },
      {
        key: 'value',
        type: 'text',
        prompt: 'Estimated value in USD?',
        hint: 'Optional. Digits only. Tab to skip.',
        placeholder: 'e.g. 25000'
      },
      {
        key: 'owner',
        type: 'user-select',
        prompt: 'Who owns this opportunity?',
        hint: 'Start typing a name. Tab to keep yourself as the owner.',
        defaultToCurrentUser: true
      },
      {
        key: 'description',
        type: 'textarea',
        prompt: 'Any notes?',
        hint: 'Optional. Press Tab to create the opportunity.',
        placeholder: 'Context, constraints, customer quirks\u2026'
      }
    ],

    blankAnswers: function () {
      return {
        title: '',
        type: null,        // { value, label } or null
        account: null,     // { kind: 'account', id, label } or null
        value: '',
        owner: null,       // { id, label, email } or null
        description: ''
      };
    },

    // Pre-fill the account step when the caller already knows it. Also
    // allows pre-filling title (e.g. a quick-create on an account's page
    // could drop the account name into the title — but we stay out of
    // that; that's a caller concern).
    applyPrefill: function (answers, prefill /*, ctx */) {
      if (!prefill) return null;
      if (prefill.title) answers.title = String(prefill.title);
      if (prefill.account_id) {
        answers.account = {
          kind: 'account',
          id: prefill.account_id,
          label: prefill.account_label || ''
        };
        if (prefill.account_label) {
          return { locked: true, prefix: 'Account', label: prefill.account_label };
        }
      }
      return null;
    },

    submit: function (answers /*, ctx */) {
      var fd = new FormData();
      fd.append('title', (answers.title || '').trim());
      if (answers.type && answers.type.value) fd.append('transaction_type', answers.type.value);
      if (answers.account && answers.account.id) fd.append('account_id', answers.account.id);
      var v = (answers.value || '').toString().replace(/[$,\s]/g, '').trim();
      if (v) fd.append('estimated_value_usd', v);
      if (answers.owner && answers.owner.id) fd.append('owner_user_id', answers.owner.id);
      if (answers.description) fd.append('description', String(answers.description));
      fd.append('source', 'wizard');

      return fetch('/opportunities', {
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
            var err = (result.data && result.data.error) || 'Could not create opportunity.';
            if (result.data && result.data.errors && typeof result.data.errors === 'object') {
              var keys = Object.keys(result.data.errors);
              if (keys.length) err = result.data.errors[keys[0]];
            }
            return { ok: false, error: err };
          }
          return {
            ok: true,
            id: result.data.id,
            number: result.data.number || '',
            redirectUrl: result.data.redirectUrl || ('/opportunities/' + encodeURIComponent(result.data.id))
          };
        })
        .catch(function () {
          return { ok: false, error: 'Could not create opportunity.' };
        });
    }
  });
})();
