// js/wizards/quote.js
//
// Quote wizard — registers the 'quote' wizard with the shared engine
// in /js/wizard-modal.js.
//
// Steps:
//   1. account       — "Which account is this for?"          (entity-select, kind=account)
//   2. opportunity   — "Which opportunity on <account>?"     (entity-select, kind=opportunity, filtered by chosen account)
//   3. quote_type    — "What kind of quote?"                 (select, fixed list)
//   4. title         — "What's this quote for?"              (text, required)
//   5. description   — "Any notes for the quote?"            (textarea, optional)
//
// On submit we POST form-encoded to the existing
// /opportunities/:oppId/quotes endpoint — that's already the canonical
// create path (validation, numbering, term defaults, audit trail all
// live there). The wizard is just a nicer UI on top of it.
//
// Inline-create: if the user types an account that doesn't exist a
// "+ New account" row appears at the bottom of the suggestions. Picking
// it opens the account wizard as a child; on success the engine pops
// back here with the new account filled in. Same pattern for the
// opportunity step — "+ New opportunity" opens the opportunity wizard
// child, prefilled with the account we already picked and the title
// the user started typing.

(function () {
  'use strict';

  if (!window.Pipeline || typeof window.Pipeline.registerWizard !== 'function') {
    if (typeof console !== 'undefined') console.error('wizards/quote.js: wizard-modal.js must load first');
    return;
  }

  // Mirror of stripCustomerName() in functions/wizards/plan.js. Used
  // by applyExtraction (the Edit-Manually fallback path); the
  // server-side planner does the same scrub for the review screen.
  function stripCustomerNameFromTitle(title, customerName) {
    if (!title || !customerName) return title;
    var t = String(title).trim();
    var c = String(customerName).trim();
    if (!c) return t;
    var cEsc = c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    var sep = '\\s*[-:—–|·]?\\s*';
    var r = t;
    r = r.replace(new RegExp('^' + cEsc + sep, 'i'), '');
    r = r.replace(new RegExp(sep + cEsc + '\\s*$', 'i'), '');
    r = r.replace(new RegExp('\\s+(for|to|from|at|with)\\s+' + cEsc + '\\b', 'i'), '');
    r = r.replace(new RegExp('\\b' + cEsc + '\\b', 'i'), '');
    r = r.replace(/\s+/g, ' ').replace(/^\s*[-:—–|·]\s*|\s*[-:—–|·]\s*$/g, '').trim();
    return r || t;
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
  ];

  window.Pipeline.registerWizard('quote', {
    title: 'New quote',
    submitLabel: 'Create quote',

    // Smart-start (Phase 4): paste a customer's quote-request email or
    // describe what they want. AI pulls out a title (most useful here)
    // and a description. Account / opportunity / quote_type are still
    // user-picked — those are core decisions the wizard insists on.
    smartStart: {
      hint: 'Paste a quote-request email or describe what the customer needs. AI will draft a title and notes; you pick the account, opportunity, and quote type.',
      placeholder: 'e.g. ACME wants a quote on 4 spare valves identical to last year’s order, valid 30 days.',
    },

    // Phase 5b-3: cascade the account dedup, then drop into the
    // standard step UI so the user picks the opportunity (filtered
    // by the resolved account) and quote_type. Title and description
    // are prefilled from extraction via applyExtraction.
    plan: true,

    steps: [
      {
        key: 'account',
        type: 'entity-select',
        prompt: 'Which account is this for?',
        hint: 'Start typing an account name. Tab to continue. Pick "+ New account" if it doesn\'t exist yet.',
        entityKinds: ['account'],
        required: true,
        requiredError: 'Pick an account before continuing.',
        // Skip when the caller prefilled both account + opportunity
        // (e.g. "+ New quote" on an opportunity detail page).
        skipWhen: function (answers /*, ctx */) {
          return !!(answers.account && answers.account.id
                  && answers.opportunity && answers.opportunity.id);
        },
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
        hint: 'Open opportunities on the selected account only. Pick "+ New opportunity" to create one inline.',
        entityKinds: ['opportunity'],
        required: true,
        requiredError: 'Pick an opportunity, or create one first from the account page.',
        // Restrict the opportunity list to the selected account.
        filterFn: function (linkable, answers) {
          var accId = answers && answers.account && answers.account.id;
          if (!accId) return false;
          return linkable.account_id === accId;
        },
        // Skip when the caller prefilled an opportunity (e.g. "+ New
        // quote" on an opportunity detail page).
        skipWhen: function (answers, ctx) {
          return !!(ctx && ctx.pinnedValue && ctx.pinnedPrefix === 'Opportunity'
                   && answers.opportunity && answers.opportunity.id);
        },
        // Inline-create: open the opportunity wizard with the account
        // already pinned and the user's typed text seeded as the title.
        // On success the engine pops back here with the new opp filled.
        createAction: {
          label: '+ New opportunity',
          typeLabel: 'New',
          subFromTyped: true,
          wizardKey: 'opportunity',
          prefillFromTyped: 'title',
          // Pull the parent's account answer into the child prefill so
          // the account step skips in the opportunity wizard.
          mergePrefill: function (answers) {
            var acc = answers && answers.account;
            if (!acc || !acc.id) return null;
            return {
              account_id: acc.id,
              account_label: acc.label || ''
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
      {
        key: 'quote_type',
        type: 'select',
        prompt: 'What kind of quote?',
        hint: 'Tab or Enter to continue. Shift+Tab to go back.',
        options: QUOTE_TYPE_OPTIONS,
        required: true,
        requiredError: 'Please pick a quote type.',
      },
      {
        key: 'title',
        type: 'text',
        prompt: 'What\u2019s this quote for?',
        hint: 'A short title. Tab to continue.',
        placeholder: 'e.g. Spare seals for pump station',
        placeholderKind: 'quote_title',
        required: true,
        requiredError: 'Title is required.'
      },
      {
        key: 'description',
        type: 'textarea',
        // The quote's description is customer-facing \u2014 it lands on
        // the generated PDF the customer reads. Coaching language
        // here nudges the user to write sales copy, not internal
        // shorthand. (Internal context lives in the yellow "Internal
        // notes" box on the quote detail page after creation.)
        prompt: 'What should the customer see at the top of the quote PDF?',
        hint: 'Customer-facing. Write it like the opening of a quote letter, not internal notes. Optional \u2014 press Tab to skip.',
        placeholder: 'e.g. Provision of replacement seals and consumables for the customer\u2019s pump station, per RFQ #1234. Lead time 8\u201310 weeks ARO.'
      },
    ],

    blankAnswers: function () {
      return {
        account: null,      // { kind:'account', id, label }
        opportunity: null,  // { kind:'opportunity', id, label }
        quote_type: null,   // { value, label }
        title: '',
        description: ''
      };
    },

    // Prefill from openWizard('quote', { opportunity_id, opportunity_label,
    // account_id, account_label, quote_type }). When both opportunity and
    // account are prefilled, both upstream steps skip and a pinned
    // "Opportunity: <label>" row shows above the prompt.
    applyPrefill: function (answers, prefill /*, ctx */) {
      if (!prefill) return null;
      if (prefill.account_id) {
        answers.account = {
          kind: 'account',
          id: prefill.account_id,
          label: prefill.account_label || ''
        };
      }
      if (prefill.opportunity_id) {
        answers.opportunity = {
          kind: 'opportunity',
          id: prefill.opportunity_id,
          label: prefill.opportunity_label || ''
        };
      }
      if (prefill.quote_type) {
        // Best-effort: match the string to an option to get the label.
        var opt = QUOTE_TYPE_OPTIONS.filter(function (o) { return o.value === prefill.quote_type; })[0];
        if (opt) answers.quote_type = { value: opt.value, label: opt.label };
      }
      // Pin on the opportunity when present — that's the most specific
      // context the user cares about.
      if (prefill.opportunity_id && prefill.opportunity_label) {
        return { locked: true, prefix: 'Opportunity', label: prefill.opportunity_label };
      }
      if (prefill.account_id && prefill.account_label) {
        return { locked: true, prefix: 'Account', label: prefill.account_label };
      }
      return null;
    },

    // Smart-start mapper: drop the extraction title into the quote
    // title and the summary into the description. Account / opp /
    // quote_type stay user-picked — the wizard's existing required
    // steps enforce that.
    applyExtraction: function (answers, extracted /*, ctx */) {
      if (!extracted) return null;
      if (extracted.title && !answers.title) {
        answers.title = String(extracted.title).trim();
      }
      if (extracted.summary && !answers.description) {
        answers.description = String(extracted.summary).trim();
      }
      return null;
    },

    submit: function (answers /*, ctx */) {
      var oppId = answers.opportunity && answers.opportunity.id;
      var qt = answers.quote_type && answers.quote_type.value;
      if (!oppId) return Promise.resolve({ ok: false, error: 'Missing opportunity.' });
      if (!qt)    return Promise.resolve({ ok: false, error: 'Missing quote type.' });

      var fd = new FormData();
      fd.append('quote_type', qt);
      var title = (answers.title || '').trim();
      if (title) fd.append('title', title);
      var description = (answers.description || '').trim();
      if (description) fd.append('description', description);
      // valid_until stays blank — server seeds a default from the
      // quote_type. The draft lands on the detail page for edits.

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
