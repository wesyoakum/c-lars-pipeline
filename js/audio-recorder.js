// js/audio-recorder.js
//
// Self-contained click-to-record audio component for the AI Inbox.
// Callers do:
//   window.PipelineAudioRecorder.open(file => { /* upload it */ });
//
// On first call the component injects its modal into <body> and binds
// its event handlers. Each subsequent open() reuses the same modal.
//
// MediaRecorder picks the best available codec for the platform —
// audio/webm on Chrome/Firefox, audio/mp4 on Safari/iOS. The blob is
// wrapped as a File with a sensible filename + extension and handed
// back to the caller. The caller decides where to POST it.
//
// Mobile-friendly: the modal is full-screen on narrow viewports and
// uses ≥44px touch targets.

(function () {
  'use strict';

  let modalEl = null;
  let stream = null;
  let recorder = null;
  let chunks = [];
  let mimeType = '';
  let timerInterval = null;
  let startTime = 0;
  let currentBlob = null;
  let currentCallback = null;

  function ensureModal() {
    if (modalEl) return modalEl;
    modalEl = document.createElement('div');
    modalEl.className = 'aii-rec-overlay';
    modalEl.style.display = 'none';
    modalEl.innerHTML = [
      '<div class="aii-rec-card">',
      '  <h3 class="aii-rec-title">Record audio</h3>',
      '  <p class="aii-rec-msg" data-msg="idle">Tap <strong>Start</strong>, then speak. Your browser will ask for microphone permission the first time.</p>',
      '  <p class="aii-rec-msg aii-rec-error" data-msg="error" hidden></p>',
      '  <div class="aii-rec-timer">0:00</div>',
      '  <audio class="aii-rec-playback" controls hidden></audio>',
      '  <div class="aii-rec-actions">',
      '    <button type="button" class="aii-rec-btn aii-rec-btn-primary" data-act="start">⏺ Start</button>',
      '    <button type="button" class="aii-rec-btn aii-rec-btn-stop" data-act="stop" hidden>⏹ Stop</button>',
      '    <button type="button" class="aii-rec-btn" data-act="rerec" hidden>↻ Re-record</button>',
      '    <button type="button" class="aii-rec-btn aii-rec-btn-primary" data-act="use" hidden>✓ Use this recording</button>',
      '    <button type="button" class="aii-rec-btn aii-rec-btn-cancel" data-act="cancel">Cancel</button>',
      '  </div>',
      '</div>',
    ].join('');
    document.body.appendChild(modalEl);

    modalEl.addEventListener('click', (e) => {
      if (e.target === modalEl) cancelAndClose();
    });

    const map = {
      start: startRecording,
      stop: stopRecording,
      rerec: resetForRerecord,
      use: useRecording,
      cancel: cancelAndClose,
    };
    modalEl.querySelectorAll('[data-act]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const fn = map[btn.getAttribute('data-act')];
        if (fn) fn();
      });
    });

    return modalEl;
  }

  function show() {
    ensureModal();
    modalEl.style.display = 'flex';
    setError(null);
    setTimer(0);
    setVisible('start', true);
    setVisible('stop', false);
    setVisible('rerec', false);
    setVisible('use', false);
    setMsg('idle', true);
  }

  function hide() {
    if (modalEl) modalEl.style.display = 'none';
  }

  function setError(text) {
    const el = modalEl.querySelector('[data-msg="error"]');
    if (text) {
      el.textContent = text;
      el.hidden = false;
      setMsg('idle', false);
    } else {
      el.hidden = true;
    }
  }

  function setMsg(name, visible) {
    const el = modalEl.querySelector('[data-msg="' + name + '"]');
    if (el) el.hidden = !visible;
  }

  function setTimer(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    modalEl.querySelector('.aii-rec-timer').textContent = m + ':' + (s < 10 ? '0' : '') + s;
  }

  function setVisible(act, visible) {
    const el = modalEl.querySelector('[data-act="' + act + '"]');
    if (el) el.hidden = !visible;
  }

  async function startRecording() {
    setError(null);
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      setError('Your browser does not support audio recording. Try uploading a file instead.');
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      setError('Could not access the microphone: ' + (e.message || e));
      return;
    }

    // Pick the best supported mime type.
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
    mimeType = '';
    for (const c of candidates) {
      try {
        if (MediaRecorder.isTypeSupported(c)) { mimeType = c; break; }
      } catch (_) { /* iOS sometimes throws */ }
    }

    chunks = [];
    try {
      recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    } catch (e) {
      setError('Could not start recorder: ' + (e.message || e));
      stopStream();
      return;
    }

    recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
    recorder.onstop = onRecorderStop;
    recorder.start();

    startTime = Date.now();
    setTimer(0);
    timerInterval = setInterval(() => {
      setTimer((Date.now() - startTime) / 1000);
    }, 250);

    setMsg('idle', false);
    setVisible('start', false);
    setVisible('stop', true);
    setVisible('rerec', false);
    setVisible('use', false);
    const audio = modalEl.querySelector('.aii-rec-playback');
    audio.hidden = true;
  }

  function stopRecording() {
    if (recorder && recorder.state !== 'inactive') {
      try { recorder.stop(); } catch (_) {}
    }
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
  }

  function stopStream() {
    if (stream) {
      try { stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
      stream = null;
    }
  }

  function onRecorderStop() {
    stopStream();
    const realMime = (recorder && recorder.mimeType) || mimeType || 'audio/webm';
    currentBlob = new Blob(chunks, { type: realMime });

    const audio = modalEl.querySelector('.aii-rec-playback');
    audio.src = URL.createObjectURL(currentBlob);
    audio.hidden = false;

    setVisible('stop', false);
    setVisible('rerec', true);
    setVisible('use', true);
  }

  function resetForRerecord() {
    revokePlayback();
    currentBlob = null;
    setMsg('idle', true);
    setError(null);
    setTimer(0);
    setVisible('start', true);
    setVisible('stop', false);
    setVisible('rerec', false);
    setVisible('use', false);
  }

  function revokePlayback() {
    const audio = modalEl?.querySelector('.aii-rec-playback');
    if (!audio) return;
    if (audio.src) {
      try { URL.revokeObjectURL(audio.src); } catch (_) {}
      audio.removeAttribute('src');
    }
    audio.hidden = true;
  }

  function mimeTypeToExt(mt) {
    if (!mt) return 'webm';
    const m = String(mt).toLowerCase();
    if (m.indexOf('mp4') >= 0 || m.indexOf('m4a') >= 0) return 'm4a';
    if (m.indexOf('webm') >= 0) return 'webm';
    if (m.indexOf('ogg') >= 0) return 'ogg';
    if (m.indexOf('mpeg') >= 0 || m.indexOf('mp3') >= 0) return 'mp3';
    if (m.indexOf('wav') >= 0) return 'wav';
    return 'webm';
  }

  function useRecording() {
    if (!currentBlob) return;
    const ext = mimeTypeToExt(currentBlob.type);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = 'recording-' + stamp + '.' + ext;
    const file = new File([currentBlob], filename, { type: currentBlob.type });
    const cb = currentCallback;
    cleanup();
    hide();
    if (cb) {
      try { cb(file); } catch (e) { console.error('audio recorder callback error:', e); }
    }
  }

  function cancelAndClose() {
    cleanup();
    hide();
  }

  function cleanup() {
    if (recorder && recorder.state !== 'inactive') {
      try { recorder.stop(); } catch (_) {}
    }
    stopStream();
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
    chunks = [];
    currentBlob = null;
    revokePlayback();
  }

  function open(onComplete) {
    currentCallback = onComplete || null;
    show();
  }

  window.PipelineAudioRecorder = { open };
})();
