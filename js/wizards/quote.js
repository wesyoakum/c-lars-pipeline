// js/wizards/quote.js
//
// Quote wizard — registers the 'quote' wizard with the shared engine
// in /js/wizard-modal.js.
//
// Steps:
//   1. account       — "Which account is this for?"          (entity-select, kind=account)
//   2. opportunity   — "Which opportunity on <account>?"     (entity-select, kind=opportunity, filtered by chosen account)
//   3. quote_type    — "What kind of quote?"                 (select, fixed list)
//
// On submit we POST form-encoded to the existing
// /opportunities/:oppId/quotes endpoint — that's already the canonical
// create path (validation, numbering, term defaults, audit trail all
// live there). The wizard is just a nicer UI on top of it.
//
// "No match?" bail-out: if the user types an account that doesn't
// exist, a small "+ Create new account" button under the hint opens
// the account wizard with the typed name pre-filled. The account
// wizard redirects to /accounts/:id on success (its default); the
// user then navigates back to Quotes and starts the quote wizard
// again. Nested-wizard chaining (return-to-parent) is deferred.

(function () {
  'use strict';

  if (!window.PMS || typeof window.PMS.registerWizard !== 'function') {
    if (typeof console !== 'undefined') console.error('wizards/quote.js: wizard-modal.js must load first');
    return;
  }

  // Quote-type options. Server revalidates against the opportunity's
  // transaction_type and rejects mismatches via a flash redirect, so
  // we can show all of them here without needing per-opp data.
  // The leading empty-value option forces an explicit pick; select
  // steps in the engine seed typedInput from the select's current value,
  // and if the user just hit Tab on first render without changing it
  // we'd miss their intent. The "— Choose —" option guarantees a
  // deliberate selection.
  var QUOTE_TYPE_OPTIONS = [
    { value: '',                     label: '\u2014 Choose \u2014' },
    { value: 'spares',               label: 'Spares' },
    { value: 'eps',                  label: 'EPS' },
    { value: 'service',              label: 'Service' },
    { value: 'refurb_baseline',      label: 'Refurb \u2014 Baseline' },
    { value: 'refurb_modified',      label: 'Refurb \u2014 Modified' },
    { value: 'refurb_supplemental',  label: 'Refurb \u2014 Supplemental' },
  ];

  window.PMS.registerWizard('quote', {
    title: 'New quote',
    submitLabel: 'Create quote',

    steps: [
      {
        key: 'account',
        type: 'entity-select',
        prompt: 'Which account is this for?',
        hint: 'Start typing an account name. Tab to continue. Pick "+ New account" if it doesn\'t exist yet.',
        entityKinds: ['account'],
        required: true,
        requiredError: 'Pick an account before continuing.',
        // Synthetic suggestion at the bottom of the list — picking it
        // opens the account wizard inline. After the new account is
        // created, the engine restores this wizard with that account
        // pre-selected.
        createAction: {
          label: '+ New account',
          typeLabel: 'New',
          subFromTyped: true,           // show typed text as the new name
          wizardKey: 'account',
          prefillFromTyped: 'name',
          setAnswer: function (result, childAnswers) {
            var name = (childAnswers && childAnswers.name ? String(childAnswers.name) : (result && result.name) || '').trim();
            var alias = childAnswers && childAnswers.alias ? String(childAnswers.alias).trim() : '';
            var label = alias ? name + ' (' + alias + ')' : name;
            return { kind: 'account', id: result.id, label: label };
          }
        },
      },
      {
        key: 'opportunity',
        type: 'entity-select',
        // Prompt updates dynamically via a getter below. The engine
        // calls currentPrompt() which reads step.prompt — plain string.
        // To keep the dynamic version, we just use a generic prompt.
        prompt: 'Which opportunity?',
        hint: 'Open opportunities on the selected account only.',
        entityKinds: ['opportunity'],
        required: true,
        requiredError: 'Pick an opportunity, or create one first from the account page.',
        // Restrict the opportunity list to the selected account.
        filterFn: function (linkable, answers) {
          var accId = answers && answers.account && answers.account.id;
          if (!accId) return false;
          return linkable.account_id === accId;
        },
      },
      {
        key: 'quote_type',
        type: 'select',
        prompt: 'What kind of quote?',
        hint: 'Tab or Enter to create. Shift+Tab to go back.',
        options: QUOTE_TYPE_OPTIONS,
        required: true,
        requiredError: 'Please pick a quote type.',
      },
    ],

    blankAnswers: function () {
      return {
        account: null,      // { kind:'account', id, label }
        opportunity: null,  // { kind:'opportunity', id, label }
        quote_type: null,   // { value, label }
      };
    },

    submit: function (answers /*, ctx */) {
      var oppId = answers.opportunity && answers.opportunity.id;
      var qt = answers.quote_type && answers.quote_type.value;
      if (!oppId) return Promise.resolve({ ok: false, error: 'Missing opportunity.' });
      if (!qt)    return Promise.resolve({ ok: false, error: 'Missing quote type.' });

      var fd = new FormData();
      fd.append('quote_type', qt);
      // Optional: leave valid_until/title blank — server seeds defaults
      // and we land the user on the draft detail page to fill in.

      var url = '/opportunities/' + encodeURIComponent(oppId) + '/quotes';
      return fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        body: fd,
        headers: { 'x-requested-with': 'XMLHttpRequest', 'accept': 'text/html' }
      })
        .then(function (res) {
          // The server 302s to either the new quote detail (success)
          // or back to the opportunity's Quotes tab (error flash).
          // fetch follows redirects by default and res.url is the
          // final landing URL — we navigate the browser there.
          if (!res.ok) return { ok: false, error: 'Could not create quote (HTTP ' + res.status + ').' };
          return { ok: true, redirectUrl: res.url };
        })
        .catch(function () {
          return { ok: false, error: 'Could not create quote.' };
        });
    },
  });
})();
