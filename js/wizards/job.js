// js/wizards/job.js
//
// Job wizard — registers the 'job' wizard with the shared engine in
// /js/wizard-modal.js.
//
// Jobs are normally auto-created when an opportunity reaches
// closed_won (see functions/opportunities/[id]/stage.js). This
// wizard exists for the earlier-start case: EPS work typically kicks
// off when the customer issues NTP, long before the opp closes
// financially, and the PM wants a job record to track against.
//
// Steps:
//   1. opportunity  — "Which opportunity?"   (entity-select opps-only, required)
//   2. title        — "Job title?"           (text, optional — server defaults to opp.title)
//   3. customer_po  — "Customer PO number?"  (text, optional — server inherits from opp if blank)
//
// Everything else (job_type, ntp_required) is derived from the
// opportunity on the server — keeps the wizard short and guarantees
// consistency with the auto-create path.
//
// Prefill (from openWizard('job', ...)):
//   { opportunity_id, opportunity_label, reload_on_success }
//
// If opportunity_id is prefilled (e.g. "+ New job" on an opportunity
// detail page), the opportunity step is skipped and a pinned
// "Opportunity: <number> — <title>" row is shown.
//
// On success the engine navigates to /jobs/<new id>.

(function () {
  'use strict';

  if (!window.Pipeline || typeof window.Pipeline.registerWizard !== 'function') {
    /* eslint-disable-next-line no-console */
    if (typeof console !== 'undefined') console.error('wizards/job.js: wizard-modal.js must load first');
    return;
  }

  window.Pipeline.registerWizard('job', {
    title: 'New job',
    submitLabel: 'Create job',

    steps: [
      {
        key: 'opportunity',
        type: 'entity-select',
        prompt: 'Which opportunity?',
        hint: 'Start typing an opportunity number or title. Shift+Tab goes back.',
        entityKinds: ['opportunity'],
        required: true,
        requiredError: 'Please pick an opportunity.',
        // Skip entirely when the caller pre-locked an opportunity (e.g.
        // "+ New job" launched from an opportunity detail page).
        skipWhen: function (answers, ctx) {
          return !!(ctx && ctx.pinnedValue && ctx.pinnedPrefix === 'Opportunity'
                   && answers.opportunity && answers.opportunity.id);
        }
      },
      {
        key: 'title',
        type: 'text',
        prompt: 'Job title?',
        hint: 'Optional. Tab to reuse the opportunity\u2019s title.',
        placeholder: 'Defaults to the opportunity title'
      },
      {
        key: 'customer_po',
        type: 'text',
        prompt: 'Customer PO number?',
        hint: 'Optional. Tab to skip — you can add it later on the job detail page.',
        placeholder: 'e.g. PO-2026-00142'
      }
    ],

    blankAnswers: function () {
      return {
        opportunity: null,    // { kind: 'opportunity', id, label }
        title: '',
        customer_po: ''
      };
    },

    applyPrefill: function (answers, prefill /*, ctx */) {
      if (!prefill) return null;
      if (prefill.title) answers.title = String(prefill.title);
      if (prefill.customer_po_number) answers.customer_po = String(prefill.customer_po_number);
      if (prefill.opportunity_id) {
        answers.opportunity = {
          kind: 'opportunity',
          id: prefill.opportunity_id,
          label: prefill.opportunity_label || ''
        };
        if (prefill.opportunity_label) {
          return { locked: true, prefix: 'Opportunity', label: prefill.opportunity_label };
        }
      }
      return null;
    },

    submit: function (answers /*, ctx */) {
      if (!answers.opportunity || !answers.opportunity.id) {
        return Promise.resolve({ ok: false, error: 'Please pick an opportunity.' });
      }
      var fd = new FormData();
      fd.append('opportunity_id', answers.opportunity.id);
      if (answers.title) fd.append('title', String(answers.title).trim());
      if (answers.customer_po) fd.append('customer_po_number', String(answers.customer_po).trim());
      fd.append('source', 'wizard');

      return fetch('/jobs', {
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
            var err = (result.data && result.data.error) || 'Could not create job.';
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
            redirectUrl: result.data.redirectUrl || ('/jobs/' + encodeURIComponent(result.data.id))
          };
        })
        .catch(function () {
          return { ok: false, error: 'Could not create job.' };
        });
    }
  });
})();
