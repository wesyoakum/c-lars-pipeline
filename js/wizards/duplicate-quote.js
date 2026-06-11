// js/wizards/duplicate-quote.js
//
// Duplicate-quote wizard — lets the user pick a target account and
// opportunity (same or different from the source) and copies an
// existing quote's header + all line items into a fresh draft on
// the chosen opportunity.
//
// Steps:
//   1. account       — "Which account should the copy go to?"
//   2. opportunity   — "Which opportunity?"
//
// On submit we POST to
// /opportunities/:sourceOppId/quotes/:sourceQuoteId/duplicate
// with target_opportunity_id in the body.

(function () {
  'use strict';

  if (!window.Pipeline || typeof window.Pipeline.registerWizard !== 'function') {
    if (typeof console !== 'undefined') console.error('wizards/duplicate-quote.js: wizard-modal.js must load first');
    return;
  }

  window.Pipeline.registerWizard('duplicate-quote', {
    title: 'Duplicate quote',
    submitLabel: 'Duplicate',

    steps: [
      {
        key: 'account',
        type: 'entity-select',
        prompt: 'Which account should the copy go to?',
        hint: 'Start typing an account name. The source account is pre-selected — change it to copy to a different customer.',
        entityKinds: ['account'],
        required: true,
        requiredError: 'Pick an account before continuing.',
        createAction: {
          label: '+ New account',
          typeLabel: 'New',
          subFromTyped: true,
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
        prompt: 'Which opportunity?',
        hint: 'Open opportunities on the selected account. Pick "+ New opportunity" to create one inline.',
        entityKinds: ['opportunity'],
        required: true,
        requiredError: 'Pick an opportunity, or create one first.',
        filterFn: function (linkable, answers) {
          var accId = answers && answers.account && answers.account.id;
          if (!accId) return false;
          return linkable.account_id === accId;
        },
        createAction: {
          label: '+ New opportunity',
          typeLabel: 'New',
          subFromTyped: true,
          wizardKey: 'opportunity',
          prefillFromTyped: 'title',
          mergePrefill: function (answers) {
            var acc = answers && answers.account;
            if (!acc || !acc.id) return null;
            return {
              account_id: acc.id,
              account_label: acc.label || '',
              skipSmartStart: true
            };
          },
          setAnswer: function (result, childAnswers) {
            var title = (childAnswers && childAnswers.title) || (result && result.title) || '';
            return {
              kind: 'opportunity',
              id: result && result.id,
              label: title
            };
          }
        },
      },
    ],

    blankAnswers: function () {
      return {
        account: null,
        opportunity: null,
        // Stashed by applyPrefill — not a wizard step.
        _source_quote_id: null,
        _source_opp_id: null,
        _source_quote_label: null,
      };
    },

    applyPrefill: function (answers, prefill) {
      if (!prefill) return null;
      if (prefill.account_id) {
        answers.account = {
          kind: 'account',
          id: prefill.account_id,
          label: prefill.account_label || ''
        };
      }
      // Stash the source quote info for submit.
      answers._source_quote_id = prefill.source_quote_id || null;
      answers._source_opp_id = prefill.source_opp_id || null;
      answers._source_quote_label = prefill.source_quote_label || null;

      if (prefill.source_quote_label) {
        return { locked: false, prefix: 'Duplicating', label: prefill.source_quote_label };
      }
      return null;
    },

    submit: function (answers) {
      var oppId = answers._source_opp_id;
      var quoteId = answers._source_quote_id;
      var targetOppId = answers.opportunity && answers.opportunity.id;
      if (!oppId || !quoteId) return Promise.resolve({ ok: false, error: 'Missing source quote.' });
      if (!targetOppId) return Promise.resolve({ ok: false, error: 'Pick a target opportunity.' });

      var url = '/opportunities/' + encodeURIComponent(oppId) +
                '/quotes/' + encodeURIComponent(quoteId) + '/duplicate';

      var fd = new FormData();
      fd.append('target_opportunity_id', targetOppId);

      return fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        body: fd,
        headers: { 'x-requested-with': 'XMLHttpRequest', 'accept': 'text/html' }
      })
        .then(function (res) {
          if (!res.ok) {
            return res.text().then(function (t) {
              return { ok: false, error: t || 'Could not duplicate quote (HTTP ' + res.status + ').' };
            });
          }
          return { ok: true, redirectUrl: res.url };
        })
        .catch(function () {
          return { ok: false, error: 'Could not duplicate quote.' };
        });
    },
  });
})();
