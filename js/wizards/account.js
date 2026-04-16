// js/wizards/account.js
//
// Account wizard — registers the 'account' wizard with the shared engine
// in /js/wizard-modal.js.
//
// Steps:
//   1. alias    — "Short name for lists?"      (text, optional — defaults to derived alias on submit)
//   2. name     — "Full legal name?"           (text, required)
//   3. segment  — "What segment?"              (select, optional)
//   4. phone    — "Main phone number?"         (text, optional)
//   5. website  — "Website URL?"               (text, optional)
//   6. owner    — "Who owns this account?"     (user-select, defaults to current user)
//   7. notes    — "Any notes?"                 (textarea, optional)
//
// After the required "name" step, everything else is optional — Tab
// skips them. If the user leaves alias blank, the server derives one
// by stripping the corporate suffix from name (", LLC" / ", Inc." /
// etc.). Name-only is a valid account; the user can enrich later
// via the account detail page (inline edit everywhere).
//
// Prefill (from openWizard('account', ...)):
//   { name, reload_on_success }
//
// On success the engine navigates the browser to /accounts/<new id>.

(function () {
  'use strict';

  if (!window.PMS || typeof window.PMS.registerWizard !== 'function') {
    /* eslint-disable-next-line no-console */
    if (typeof console !== 'undefined') console.error('wizards/account.js: wizard-modal.js must load first');
    return;
  }

  window.PMS.registerWizard('account', {
    title: 'New account',
    submitLabel: 'Create account',

    steps: [
      {
        key: 'alias',
        type: 'text',
        prompt: 'Short name for lists?',
        hint: 'Optional. Tab to skip — we\'ll derive one from the legal name.',
        placeholder: 'e.g. Helix Robotics'
      },
      {
        key: 'name',
        type: 'text',
        prompt: 'Full legal name?',
        hint: 'Press Tab to continue. Shift+Tab goes back.',
        placeholder: 'e.g. Helix Robotics, Inc.',
        required: true,
        requiredError: 'Account name is required.'
      },
      {
        key: 'segment',
        type: 'select',
        prompt: 'What segment?',
        hint: 'Pick a segment or leave blank. Tab to continue.',
        options: [
          { value: '',           label: '\u2014 None \u2014' },
          { value: 'WROV',       label: 'WROV' },
          { value: 'Research',   label: 'Research' },
          { value: 'Defense',    label: 'Defense' },
          { value: 'Commercial', label: 'Commercial' },
          { value: 'Other',      label: 'Other' }
        ]
      },
      {
        key: 'phone',
        type: 'text',
        prompt: 'Main phone number?',
        hint: 'Optional. Tab to skip.',
        placeholder: '(555) 555-1234'
      },
      {
        key: 'website',
        type: 'text',
        prompt: 'Website URL?',
        hint: 'Optional. Tab to skip.',
        placeholder: 'https://example.com'
      },
      {
        key: 'owner',
        type: 'user-select',
        prompt: 'Who owns this account?',
        hint: 'Start typing a name. Tab to keep yourself as the owner.',
        defaultToCurrentUser: true
      },
      {
        key: 'notes',
        type: 'textarea',
        prompt: 'Any notes?',
        hint: 'Optional. Press Tab to create the account.',
        placeholder: 'Anything worth remembering\u2026'
      }
    ],

    blankAnswers: function () {
      return {
        alias: '',
        name: '',
        segment: null,    // { value, label } or null
        phone: '',
        website: '',
        owner: null,      // { id, label, email } or null
        notes: ''
      };
    },

    // Optional: pre-fill the name step (e.g. "New account" button on an
    // unrecognized account-picker search).
    applyPrefill: function (answers, prefill /*, ctx */) {
      if (!prefill) return null;
      if (prefill.name) answers.name = String(prefill.name);
      return null;
    },

    submit: function (answers /*, ctx */) {
      var fd = new FormData();
      fd.append('name', (answers.name || '').trim());
      if (answers.alias) fd.append('alias', String(answers.alias).trim());
      if (answers.segment && answers.segment.value) fd.append('segment', answers.segment.value);
      if (answers.phone) fd.append('phone', String(answers.phone).trim());
      if (answers.website) fd.append('website', String(answers.website).trim());
      if (answers.owner && answers.owner.id) fd.append('owner_user_id', answers.owner.id);
      if (answers.notes) fd.append('notes', String(answers.notes));
      fd.append('source', 'wizard');

      return fetch('/accounts', {
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
            var err = (result.data && result.data.error) || 'Could not create account.';
            // Field-specific errors come back as { errors: { field: 'msg' } }.
            if (result.data && result.data.errors && typeof result.data.errors === 'object') {
              var keys = Object.keys(result.data.errors);
              if (keys.length) err = result.data.errors[keys[0]];
            }
            return { ok: false, error: err };
          }
          return {
            ok: true,
            id: result.data.id,
            redirectUrl: result.data.redirectUrl || ('/accounts/' + encodeURIComponent(result.data.id))
          };
        })
        .catch(function () {
          return { ok: false, error: 'Could not create account.' };
        });
    }
  });
})();
