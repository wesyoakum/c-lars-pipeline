// js/wizards/account.js
//
// Account wizard — registers the 'account' wizard with the shared engine
// in /js/wizard-modal.js.
//
// Steps:
//   1. alias    — "Short name for lists?"      (text, optional — defaults to derived alias on submit)
//   2. name     — "Full legal name?"           (text, required)
//   3. owner    — "Who owns this account?"     (user-select, defaults to current user)
//   4. notes    — "Any notes?"                 (textarea, optional)
//
// Segment / phone / website were dropped from the wizard — they're rarely
// known at create time and the inline-edit columns on the accounts list
// make adding them later trivial. Keep this wizard short.
//
// Prefill (from openWizard('account', ...)):
//   { name, reload_on_success }
//
// On success the engine navigates the browser to /accounts/<new id>.
// When opened as a child of another wizard (e.g. the quote wizard's
// "+ New account" suggestion), the engine restores the parent instead
// of redirecting.

(function () {
  'use strict';

  if (!window.Pipeline || typeof window.Pipeline.registerWizard !== 'function') {
    /* eslint-disable-next-line no-console */
    if (typeof console !== 'undefined') console.error('wizards/account.js: wizard-modal.js must load first');
    return;
  }

  window.Pipeline.registerWizard('account', {
    title: 'New account',
    submitLabel: 'Create account',

    // Smart-start (Phase 4): Quick-start panel that takes a freeform
    // description, a website URL on a card, or a logo/letterhead photo
    // and pulls out the legal name + website + address. The AI Inbox
    // entry is back-linked to the new account on submit.
    smartStart: {
      hint: 'Paste a website, an email address from someone at the company, or upload a logo / letterhead. AI will pull out the company name (and address / website / phone if present) and walk you through to confirm.',
      placeholder: 'e.g. Mississippi Development Authority, P.O. Box 849, Jackson, MS 39205. www.mississippi.org. 601-359-3449',
    },

    steps: [
      {
        key: 'alias',
        type: 'text',
        prompt: 'Short name for lists?',
        hint: 'Optional. Tab to skip — we\'ll derive one from the legal name.',
        placeholder: 'e.g. Helix Robotics',
        // Skip this step entirely when the legal name is already known
        // — either from a pre-filled openPrefill (AI Inbox business-
        // card flow) or after Smart-start extraction populated it.
        // The alias gets derived from the legal name on submit, and
        // the user can edit it later from the accounts list.
        skipWhen: function (answers, ctx) {
          if (ctx && ctx.openPrefill && ctx.openPrefill.name) return true;
          if (answers && answers.name) return true;
          return false;
        }
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
        owner: null,      // { id, label, email } or null
        notes: ''
      };
    },

    // Optional: pre-fill the name step (e.g. "New account" button on an
    // unrecognized account-picker search, or the quote wizard's "+ New
    // account" option).
    applyPrefill: function (answers, prefill /*, ctx */) {
      if (!prefill) return null;
      if (prefill.name) answers.name = String(prefill.name);
      if (prefill.alias) answers.alias = String(prefill.alias);
      return null;
    },

    // Smart-start mapper: pull the first organization from the AI
    // Inbox extraction into the legal-name step. When details are
    // present (website / phone / address), they don't have wizard
    // steps to populate — but the AI Inbox entry that gets back-
    // linked carries them as captured context, and the user can fill
    // them in via inline-edit on the new account's detail page.
    applyExtraction: function (answers, extracted /*, ctx */) {
      if (!extracted) return null;
      var orgDetail = (extracted.organizations_detail && extracted.organizations_detail[0]) || null;
      var orgName = (orgDetail && orgDetail.name)
        || (extracted.organizations && extracted.organizations[0])
        || '';
      if (orgName && !answers.name) {
        answers.name = String(orgName).trim();
      }
      return null;
    },

    submit: function (answers /*, ctx */) {
      var fd = new FormData();
      fd.append('name', (answers.name || '').trim());
      if (answers.alias) fd.append('alias', String(answers.alias).trim());
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
            name: result.data.name || (answers.name || '').trim(),
            redirectUrl: result.data.redirectUrl || ('/accounts/' + encodeURIComponent(result.data.id))
          };
        })
        .catch(function () {
          return { ok: false, error: 'Could not create account.' };
        });
    }
  });
})();
