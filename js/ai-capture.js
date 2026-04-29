// js/ai-capture.js
//
// In-context AI Inbox capture: open a modal that lets the user drop
// a file, record audio, or take a photo, and uploads the result as a
// new AI Inbox entry that is automatically associated with the
// "current" CRM record (opportunity / account / quote / job /
// contact). Reuses /js/audio-recorder.js for the recording flow.
//
// API:
//   window.PipelineAICapture.open({
//     refType: 'opportunity' | 'account' | 'quote' | 'job' | 'contact',
//     refId: '<uuid>',
//     refLabel: 'OPP-1234 — Mark IV upgrade',
//     onCreated: function(response) { ... }   // optional
//   });
//
// On success the modal shows a green "Created — extracting…" line
// with a link to the new entry's detail page so the user can jump
// over if they want; otherwise they stay on the original page.

(function () {
  'use strict';

  let modalEl = null;
  let target = null;          // { refType, refId, refLabel, onCreated }

  function ensureModal() {
    if (modalEl) return modalEl;
    modalEl = document.createElement('div');
    modalEl.className = 'aii-cap-overlay';
    modalEl.style.display = 'none';
    modalEl.innerHTML = [
      '<div class="aii-cap-card">',
      '  <h3 class="aii-cap-title">Add to <span data-role="label">this record</span></h3>',
      '  <p class="aii-cap-msg">Drop a file, record audio, or attach a photo. We turn it into a new AI Inbox entry pre-linked to this page.</p>',
      '',
      '  <div class="ai-inbox-droppanel ai-inbox-droppanel-compact" data-role="dropzone">',
      '    <div class="dz-big-content">',
      '      <div class="dz-big-icon">⬆</div>',
      '      <div class="dz-big-title">Drop a file here</div>',
      '      <div class="dz-big-hint">Audio, PDF, DOCX, image, or anything else.</div>',
      '    </div>',
      '    <input type="file" data-role="file-input">',
      '  </div>',
      '',
      '  <div class="aii-capture-bar" style="margin:.6rem 0 .25rem;">',
      '    <button type="button" class="aii-capture-btn" data-act="record"><span class="aii-capture-btn-icon">🎤</span> Record audio</button>',
      '    <button type="button" class="aii-capture-btn" data-act="photo"><span class="aii-capture-btn-icon">📷</span> Take photo</button>',
      '    <input type="file" accept="image/*" capture="environment" hidden data-role="photo-input">',
      '  </div>',
      '',
      '  <div class="aii-cap-status" data-role="status"></div>',
      '',
      '  <div class="aii-cap-actions">',
      '    <a class="aii-rec-btn aii-rec-btn-primary" data-role="open-link" hidden>Open new entry</a>',
      '    <button type="button" class="aii-rec-btn aii-rec-btn-cancel" data-act="close">Close</button>',
      '  </div>',
      '</div>',
    ].join('');
    document.body.appendChild(modalEl);

    const $ = (sel) => modalEl.querySelector(sel);

    // Close on backdrop tap.
    modalEl.addEventListener('click', (e) => {
      if (e.target === modalEl) close();
    });

    $('[data-act="close"]').addEventListener('click', close);

    // Dropzone — drag-drop + click anywhere on it.
    const zone = $('[data-role="dropzone"]');
    const input = $('[data-role="file-input"]');
    zone.addEventListener('click', (e) => {
      if (e.target === input) return;
      input.click();
    });
    ['dragenter', 'dragover'].forEach((evt) => {
      zone.addEventListener(evt, (e) => {
        e.preventDefault(); e.stopPropagation();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        zone.classList.add('dz-active');
      });
    });
    ['dragleave', 'dragend'].forEach((evt) => {
      zone.addEventListener(evt, (e) => {
        if (evt === 'dragleave' && zone.contains(e.relatedTarget)) return;
        zone.classList.remove('dz-active');
      });
    });
    zone.addEventListener('drop', (e) => {
      e.preventDefault(); e.stopPropagation();
      zone.classList.remove('dz-active');
      const files = e.dataTransfer ? Array.from(e.dataTransfer.files) : [];
      if (files.length === 0) return;
      uploadFile(files[0]);
    });
    input.addEventListener('change', () => {
      if (input.files && input.files[0]) uploadFile(input.files[0]);
    });

    // Record audio.
    $('[data-act="record"]').addEventListener('click', () => {
      if (!window.PipelineAudioRecorder || typeof window.PipelineAudioRecorder.open !== 'function') {
        setStatus('error', 'Audio recorder is not available on this page.');
        return;
      }
      window.PipelineAudioRecorder.open((file) => uploadFile(file));
    });

    // Take photo.
    const photoInput = $('[data-role="photo-input"]');
    $('[data-act="photo"]').addEventListener('click', () => photoInput.click());
    photoInput.addEventListener('change', () => {
      if (photoInput.files && photoInput.files[0]) uploadFile(photoInput.files[0]);
    });

    return modalEl;
  }

  function show() {
    ensureModal();
    modalEl.style.display = 'flex';
    setStatus('', '');
    const link = modalEl.querySelector('[data-role="open-link"]');
    link.hidden = true;
    link.removeAttribute('href');
    const labelEl = modalEl.querySelector('[data-role="label"]');
    labelEl.textContent = (target && target.refLabel) || 'this record';
    // Clear any prior file selection so the same file can be picked again.
    const input = modalEl.querySelector('[data-role="file-input"]');
    if (input) input.value = '';
    const photo = modalEl.querySelector('[data-role="photo-input"]');
    if (photo) photo.value = '';
  }

  function setStatus(kind, text) {
    const el = modalEl.querySelector('[data-role="status"]');
    el.textContent = text || '';
    el.classList.remove('aii-cap-status-ok', 'aii-cap-status-err', 'aii-cap-status-busy');
    if (kind === 'ok') el.classList.add('aii-cap-status-ok');
    else if (kind === 'error') el.classList.add('aii-cap-status-err');
    else if (kind === 'busy') el.classList.add('aii-cap-status-busy');
  }

  async function uploadFile(file) {
    if (!file || !target) return;
    setStatus('busy', 'Uploading ' + (file.name || 'file') + '…');
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('associate_ref_type', target.refType);
      fd.append('associate_ref_id', target.refId);
      if (target.refLabel) fd.append('associate_ref_label', target.refLabel);
      const res = await fetch('/ai-inbox/new', {
        method: 'POST',
        credentials: 'same-origin',
        body: fd,
        headers: { accept: 'application/json' },
      });
      const j = await res.json();
      if (!j.ok) {
        setStatus('error', 'Upload failed: ' + (j.detail || j.error || 'unknown'));
        return;
      }
      setStatus('ok', 'Created — AI Inbox is processing the entry now.');
      const link = modalEl.querySelector('[data-role="open-link"]');
      link.href = j.detailUrl;
      link.hidden = false;
      if (target.onCreated) {
        try { target.onCreated(j); } catch (_) {}
      }
    } catch (e) {
      setStatus('error', 'Upload failed: ' + (e.message || e));
    }
  }

  function close() {
    if (modalEl) modalEl.style.display = 'none';
    target = null;
  }

  function open(opts) {
    if (!opts || !opts.refType || !opts.refId) {
      console.error('PipelineAICapture.open requires { refType, refId } at minimum');
      return;
    }
    target = {
      refType: opts.refType,
      refId: opts.refId,
      refLabel: opts.refLabel || '',
      onCreated: typeof opts.onCreated === 'function' ? opts.onCreated : null,
    };
    show();
  }

  window.PipelineAICapture = { open, close };
})();
