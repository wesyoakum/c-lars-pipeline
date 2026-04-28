// js/inbox-droppanel.js
//
// Wires the always-visible "Drop a file to start a new entry" panel on
// /ai-inbox into a working drag-drop + click-to-browse experience.
//
// Markup pattern (rendered in functions/ai-inbox/index.js):
//
//   <div class="ai-inbox-droppanel" data-dropzone-big>
//     <form method="post" action="/ai-inbox/new" enctype="multipart/form-data" data-dz-form>
//       <input type="file" name="file" data-dz-input multiple>
//       ... visual content ...
//       <div data-dz-status></div>
//     </form>
//   </div>
//
// Behavior:
//   - Click anywhere on the panel → opens the file picker
//   - Drag-and-drop → assigns dropped files to the input
//   - Single file: native form submit (browser handles the redirect to
//     the new entry's detail page)
//   - Multiple files (rare on the inbox panel since each creates its
//     own entry): submit sequentially via fetch, then navigate to the
//     last-created entry's detail page

(function () {
  'use strict';

  function findPanels() {
    return document.querySelectorAll('[data-dropzone-big]');
  }

  function findInput(panel) {
    return panel.querySelector('[data-dz-input]') || panel.querySelector('input[type="file"]');
  }

  function findForm(panel) {
    return panel.querySelector('[data-dz-form]') || panel.querySelector('form');
  }

  function setStatus(panel, text) {
    const el = panel.querySelector('[data-dz-status]');
    if (el) el.textContent = text || '';
  }

  function setBusy(panel, busy) {
    if (busy) panel.classList.add('dz-busy');
    else panel.classList.remove('dz-busy');
  }

  async function uploadOne(form, file) {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch(form.action, {
      method: 'POST',
      credentials: 'same-origin',
      body: fd,
      redirect: 'manual',
    });
    // The /ai-inbox/new handler returns a 303 redirect to the detail
    // page on success. With redirect='manual', that response lands
    // here as type='opaqueredirect' and we have to read .url from it
    // — except modern browsers don't expose Location headers on
    // opaqueredirect either. Easier: trust the path pattern and
    // navigate manually after the request lands.
    return res;
  }

  function bind(panel) {
    if (panel.__dzbBound) return;
    const input = findInput(panel);
    const form = findForm(panel);
    if (!input || !form) return;
    panel.__dzbBound = true;

    // Click anywhere on the panel → open picker (input is invisibly
    // overlaid via CSS). The native input click handles itself; we
    // don't need to call input.click() explicitly.

    const stop = (e) => { e.preventDefault(); e.stopPropagation(); };

    ['dragenter', 'dragover'].forEach((evt) => {
      panel.addEventListener(evt, (e) => {
        stop(e);
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        panel.classList.add('dz-active');
      });
    });
    ['dragleave', 'dragend'].forEach((evt) => {
      panel.addEventListener(evt, (e) => {
        if (evt === 'dragleave' && panel.contains(e.relatedTarget)) return;
        panel.classList.remove('dz-active');
      });
    });

    panel.addEventListener('drop', async (e) => {
      stop(e);
      panel.classList.remove('dz-active');
      const files = e.dataTransfer ? Array.from(e.dataTransfer.files) : [];
      if (files.length === 0) return;
      await handleFiles(panel, form, files);
    });

    input.addEventListener('change', async (e) => {
      const files = Array.from(input.files || []);
      if (files.length === 0) return;
      await handleFiles(panel, form, files);
    });
  }

  // Detect whether this panel uploads to /ai-inbox/new (creates an
  // entry per file) or /ai-inbox/<id>/attachments/add (appends to one
  // existing entry).
  function isAttachmentAddTarget(form) {
    return /\/attachments\/add\b/.test(form.action || '');
  }

  async function handleFiles(panel, form, files) {
    setBusy(panel, true);

    if (isAttachmentAddTarget(form)) {
      // Entry-detail mode: drop one or more files into the existing
      // entry. Each becomes its own attachment. Reload after the last
      // one so the page reflects all the new attachments + the latest
      // re-extraction (we suppress reextract on the first N-1 to avoid
      // re-running extraction multiple times).
      let done = 0;
      for (const f of files) {
        done += 1;
        const isLast = done === files.length;
        setStatus(panel, 'Uploading ' + done + ' of ' + files.length + ': ' + f.name + '…');
        try {
          const fd = new FormData();
          fd.append('kind', 'auto');
          fd.append('file', f);
          // Only re-run extraction after the last file uploads.
          fd.append('reextract', isLast ? '1' : '0');
          const res = await fetch(form.action, {
            method: 'POST', credentials: 'same-origin', body: fd,
          });
          const j = await res.json();
          if (!j.ok) throw new Error(j.error || 'upload failed');
        } catch (e) {
          setStatus(panel, 'Upload failed: ' + (e.message || e));
          setBusy(panel, false);
          return;
        }
      }
      setStatus(panel, 'Reloading…');
      window.location.reload();
      return;
    }

    // Inbox-list mode: each file creates its own entry.
    if (files.length === 1) {
      // Single file: native form submit. Browser follows the 303
      // redirect to the new entry's detail page.
      setStatus(panel, 'Uploading ' + files[0].name + '…');
      try {
        const dt = new DataTransfer();
        dt.items.add(files[0]);
        const input = findInput(panel);
        input.files = dt.files;
      } catch (e) { /* older browsers */ }
      form.submit();
      return;
    }

    // Multi-file: upload sequentially via fetch. Each becomes its
    // own entry. Navigate to the last one when done.
    let lastEntryId = null;
    let done = 0;
    for (const f of files) {
      done += 1;
      setStatus(panel, 'Uploading ' + done + ' of ' + files.length + ': ' + f.name + '…');
      try {
        const fd = new FormData();
        fd.append('file', f);
        const res = await fetch(form.action, {
          method: 'POST', credentials: 'same-origin', body: fd, redirect: 'manual',
        });
        if (res.url && res.url.indexOf('/ai-inbox/') >= 0) {
          const m = res.url.match(/\/ai-inbox\/([^/?]+)/);
          if (m) lastEntryId = m[1];
        }
      } catch (e) {
        setStatus(panel, 'Upload failed: ' + (e.message || e));
        setBusy(panel, false);
        return;
      }
    }
    setStatus(panel, 'Uploaded ' + files.length + ' files. Loading…');
    if (lastEntryId) {
      window.location.href = '/ai-inbox/' + encodeURIComponent(lastEntryId);
    } else {
      window.location.reload();
    }
  }

  function bindAll() {
    findPanels().forEach(bind);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindAll);
  } else {
    bindAll();
  }

  window.PipelineInboxDroppanel = { bind, bindAll };
})();
