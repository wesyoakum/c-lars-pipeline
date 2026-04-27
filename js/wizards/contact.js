// js/wizards/contact.js
//
// Contact wizard — registers the 'contact' wizard with the shared
// engine in /js/wizard-modal.js.
//
// Steps:
//   1. first_name  — "First name?"              (text, optional at step level)
//   2. last_name   — "Last name?"               (text, optional at step level)
//   3. account     — "Which account?"           (entity-select accounts-only, required;
//                                                offers "+ New account" via createAction)
//   4. title       — "Title / role?"            (text, optional)
//   5. email       — "Email?"                   (text, optional)
//
// Cross-step requirement: at least one of first_name / last_name must be
// non-empty (matches the server validator). Enforced in submit() — if
// both are empty we set the wizard error and jump the user back to
// first_name.
//
// Phone, mobile, primary, and notes are skipped here — they're fast
// inline edits on the contact detail page (and on the contacts list).
//
// Prefill (from openWizard('contact', ...)):
//   { account_id, account_label, reload_on_success }
//
// If account_id is prefilled (e.g. "+ New contact" on an account detail
// page), the account step is skipped and a pinned "Account: <name>"
// row is shown.
//
// On success the engine navigates to /contacts/<new id>.

(function () {
  'use strict';

  if (!window.Pipeline || typeof window.Pipeline.registerWizard !== 'function') {
    /* eslint-disable-next-line no-console */
    if (typeof console !== 'undefined') console.error('wizards/contact.js: wizard-modal.js must load first');
    return;
  }

  window.Pipeline.registerWizard('contact', {
    title: 'New contact',
    submitLabel: 'Create contact',

    steps: [
      {
        key: 'first_name',
        type: 'text',
        prompt: 'First name?',
        hint: 'Tab to continue. Shift+Tab goes back.',
        placeholder: 'e.g. Jane'
      },
      {
        key: 'last_name',
        type: 'text',
        prompt: 'Last name?',
        hint: 'Tab to continue. At least one of first or last name is required.',
        placeholder: 'e.g. Smith'
      },
      {
        key: 'account',
        type: 'entity-select',
        prompt: 'Which account?',
        hint: 'Start typing an account name or alias. "+ New account" creates one inline.',
        entityKinds: ['account'],
        required: true,
        requiredError: 'Please pick an account.',
        // Skip entirely when the caller pre-locked an account.
        skipWhen: function (answers, ctx) {
          return !!(ctx && ctx.pinnedValue && ctx.pinnedPrefix === 'Account'
                   && answers.account && answers.account.id);
        },
        // Picking "+ New account" opens the account wizard as a child;
        // on success the parent pops back with the new account filled in.
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
        key: 'title',
        type: 'text',
        prompt: 'Title / role?',
        hint: 'Optional. Tab to skip.',
        placeholder: 'e.g. Director of Operations'
      },
      {
        key: 'email',
        type: 'text',
        prompt: 'Email?',
        hint: 'Optional. Press Tab to create the contact.',
        placeholder: 'e.g. jane@example.com'
      }
    ],

    blankAnswers: function () {
      return {
        first_name: '',
        last_name: '',
        account: null,    // { kind: 'account', id, label }
        title: '',
        email: ''
      };
    },

    applyPrefill: function (answers, prefill /*, ctx */) {
      if (!prefill) return null;
      if (prefill.first_name) answers.first_name = String(prefill.first_name);
      if (prefill.last_name) answers.last_name = String(prefill.last_name);
      if (prefill.title) answers.title = String(prefill.title);
      if (prefill.email) answers.email = String(prefill.email);
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

    submit: function (answers, ctx) {
      var fn = (answers.first_name || '').trim();
      var ln = (answers.last_name || '').trim();

      // Cross-step: at least one of first/last is required. Jump back
      // to first_name so the user can type one in.
      if (!fn && !ln) {
        if (ctx) {
          ctx.stepIndex = 0;
          ctx.typedInput = '';
          ctx.focusInput();
        }
        return Promise.resolve({ ok: false, error: 'Please enter a first or last name.' });
      }

      if (!answers.account || !answers.account.id) {
        return Promise.resolve({ ok: false, error: 'Please pick an account.' });
      }

      var fd = new FormData();
      if (fn) fd.append('first_name', fn);
      if (ln) fd.append('last_name', ln);
      if (answers.title) fd.append('title', String(answers.title).trim());
      if (answers.email) fd.append('email', String(answers.email).trim());
      fd.append('source', 'wizard');

      return fetch('/accounts/' + encodeURIComponent(answers.account.id) + '/contacts', {
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
            var err = (result.data && result.data.error) || 'Could not create contact.';
            if (result.data && result.data.errors && typeof result.data.errors === 'object') {
              var keys = Object.keys(result.data.errors);
              if (keys.length) err = result.data.errors[keys[0]];
            }
            return { ok: false, error: err };
          }
          return {
            ok: true,
            id: result.data.id,
            redirectUrl: result.data.redirectUrl || ('/contacts/' + encodeURIComponent(result.data.id))
          };
        })
        .catch(function () {
          return { ok: false, error: 'Could not create contact.' };
        });
    }
  });
})();
