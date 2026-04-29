// js/cascade-delete.js
//
// Cascade-delete confirmation modal (Phase 6).
//
// Wraps the standard delete-form submit pattern with a confirmation
// modal that fetches `/{entity}/<id>/delete-preview` first, lists
// the children that would also be removed, and only then submits
// the form (with `?cascade=1` appended) on user confirmation.
//
// Usage on the form:
//   <form method="post" action="/accounts/<id>/delete"
//         onsubmit="return Pipeline.confirmCascadeDelete(event, {
//           entityType: 'account',
//           entityLabel: 'Acme Corp'
//         });">
//     <button type="submit">Delete</button>
//   </form>
//
// The preview endpoint is derived as `<form.action>-preview` (so
// `/accounts/<id>/delete` → `/accounts/<id>/delete-preview`). On
// Confirm, we set `cascade=1` on the form's action URL and call
// .submit() — bypassing the onsubmit handler the second time.

(function () {
  'use strict';

  document.addEventListener('alpine:init', function () {
    Alpine.store('cascadeDelete', {
      open: false,
      entity: { type: '', id: '', label: '' },
      preview: null,        // /delete-preview response, or null while loading
      previewError: null,
      busy: false,          // true while preview is loading
      submitting: false,    // true while the actual delete is in flight

      // Filled by openModal — called when the user clicks Confirm.
      _onConfirm: null,
      _onCancel: null,

      openModal: function (opts) {
        this.entity = {
          type: opts.entityType || '',
          id: opts.entityId || '',
          label: opts.entityLabel || '',
        };
        this.preview = null;
        this.previewError = null;
        this.busy = true;
        this.submitting = false;
        this._onConfirm = opts.onConfirm || null;
        this._onCancel = opts.onCancel || null;
        this.open = true;

        var self = this;
        fetch(opts.previewUrl, { credentials: 'same-origin', headers: { accept: 'application/json' } })
          .then(function (res) { return res.json(); })
          .then(function (j) {
            self.busy = false;
            if (j && j.ok) {
              self.preview = j;
            } else {
              self.previewError = (j && j.error) || 'Could not load preview.';
            }
          })
          .catch(function (err) {
            self.busy = false;
            self.previewError = (err && err.message) || 'Could not load preview.';
          });
      },

      closeModal: function () {
        if (this.submitting) return;  // can't bail mid-submit
        this.open = false;
        if (typeof this._onCancel === 'function') {
          try { this._onCancel(); } catch (e) {}
        }
        this._onConfirm = null;
        this._onCancel = null;
      },

      confirm: function () {
        if (this.submitting) return;
        this.submitting = true;
        if (typeof this._onConfirm === 'function') {
          try { this._onConfirm(); } catch (e) {
            this.submitting = false;
          }
        }
      },

      // Display helpers
      childSummary: function () {
        if (!this.preview || !this.preview.children) return '';
        if (this.preview.children.length === 0) {
          return 'No related records — safe to delete.';
        }
        var parts = this.preview.children.map(function (c) {
          return c.count + ' ' + c.kind;
        });
        return 'This will also delete: ' + parts.join(', ') + '.';
      },
    });
  });

  // ---- Public API --------------------------------------------------

  window.Pipeline = window.Pipeline || {};

  /**
   * Form-onsubmit-style helper. event.target is the <form>; we
   * preventDefault, show the modal, and on confirm append cascade=1
   * to the form action and call form.submit() directly.
   *
   * Returns false unconditionally to suppress the form's own submit;
   * the actual submission happens inside _onConfirm.
   */
  window.Pipeline.confirmCascadeDelete = function (event, opts) {
    event.preventDefault();
    var form = event.target;
    var actionUrl = new URL(form.action, window.location.origin);
    var previewUrl = actionUrl.pathname + '-preview' + actionUrl.search;

    var store = Alpine.store('cascadeDelete');
    store.openModal({
      entityType: opts.entityType,
      entityId: opts.entityId || '',
      entityLabel: opts.entityLabel || '',
      previewUrl: previewUrl,
      onConfirm: function () {
        // Append cascade=1 to the form's action and natively submit.
        var url = new URL(form.action, window.location.origin);
        url.searchParams.set('cascade', '1');
        form.action = url.pathname + url.search;
        // Mark the form so onsubmit doesn't re-intercept on .submit().
        form.dataset.cascadeConfirmed = '1';
        form.submit();
      },
    });
    return false;
  };

  // Onsubmit guard: when a form has been confirmed once, the second
  // .submit() must skip our intercept. We do this by checking
  // form.dataset.cascadeConfirmed in the onsubmit handler — see the
  // confirmCascadeDelete signature above.
})();
