// js/dropzone.js
//
// Tiny progressive-enhancement drag-and-drop wrapper for any <input
// type="file">. Markup pattern:
//
//   <div class="dz" data-dropzone>
//     <input type="file" name="audio" accept="audio/*">
//     <div class="dz-hint">Drag and drop, or click to browse</div>
//   </div>
//
// The script:
//   - finds the <input type="file"> inside the dropzone
//   - adds dragover/dragleave/drop listeners on the wrapper
//   - on drop: assigns the dropped FileList to the input.files,
//     dispatches a 'change' event so any framework listening (Alpine,
//     plain JS, native form submit) sees the new value
//   - toggles a class 'dz-active' on the wrapper while a file is being
//     dragged over it (for CSS feedback)
//   - if the input has the `multiple` attribute, all dropped files are
//     accepted; otherwise only the first
//
// No bundler required. Drop in via <script src="/js/dropzone.js"></script>.
// Self-initializes on DOMContentLoaded; also exposes
// window.PipelineDropzone.bind(el) for dynamically-added zones.

(function () {
  'use strict';

  function findInput(zone) {
    return zone.querySelector('input[type="file"]');
  }

  function bind(zone) {
    if (!zone || zone.__dzBound) return;
    const input = findInput(zone);
    if (!input) return;
    zone.__dzBound = true;

    // Click-anywhere-on-zone to open the file picker, EXCEPT when the
    // click landed on an interactive element (button, label, input).
    zone.addEventListener('click', (e) => {
      if (e.target === zone || e.target.classList.contains('dz-hint')) {
        input.click();
      }
    });

    const stop = (e) => { e.preventDefault(); e.stopPropagation(); };

    ['dragenter', 'dragover'].forEach((evt) => {
      zone.addEventListener(evt, (e) => {
        stop(e);
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        zone.classList.add('dz-active');
      });
    });

    ['dragleave', 'dragend'].forEach((evt) => {
      zone.addEventListener(evt, (e) => {
        // Only deactivate when the cursor leaves the zone entirely —
        // dragleave fires for child elements too, so check the related
        // target.
        if (evt === 'dragleave' && zone.contains(e.relatedTarget)) return;
        zone.classList.remove('dz-active');
      });
    });

    zone.addEventListener('drop', (e) => {
      stop(e);
      zone.classList.remove('dz-active');
      const files = e.dataTransfer ? e.dataTransfer.files : null;
      if (!files || files.length === 0) return;

      // Build a DataTransfer to assign back to the input — the .files
      // property is a FileList, which is read-only, but we can construct
      // one via DataTransfer.items.
      const dt = new DataTransfer();
      const limit = input.multiple ? files.length : 1;
      for (let i = 0; i < limit; i++) dt.items.add(files[i]);
      input.files = dt.files;

      // Notify listeners. Some frameworks (Alpine x-on:change, native
      // form submit) need an explicit change event since assigning
      // .files programmatically doesn't fire one.
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  function bindAll(root) {
    const zones = (root || document).querySelectorAll('[data-dropzone]');
    zones.forEach(bind);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => bindAll(document));
  } else {
    bindAll(document);
  }

  // Expose for callers that add zones dynamically (e.g., Alpine x-show
  // panels that mount a dropzone after page load).
  window.PipelineDropzone = { bind, bindAll };
})();
