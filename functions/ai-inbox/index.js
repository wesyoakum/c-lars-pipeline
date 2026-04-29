// functions/ai-inbox/index.js
//
// GET /ai-inbox
//
// Landing page for the AI Inbox experiment. Shows an upload form at
// the top (audio file + optional context) and a newest-first list of
// previous items with their status and a one-line summary. The whole
// page is server-rendered HTML matching the rest of Pipeline — HTMX/Alpine
// only where needed.

import { all } from '../lib/db.js';
import { layout, html, escape, htmlResponse, raw } from '../lib/layout.js';
import { readFlash } from '../lib/http.js';

const STATUS_LABELS = {
  pending: 'Uploaded',
  transcribing: 'Transcribing…',
  classifying: 'Classifying…',
  extracting: 'Extracting…',
  ready: 'Ready',
  error: 'Error',
};

const STATUS_COLORS = {
  pending: '#888',
  transcribing: '#1f6feb',
  classifying: '#1f6feb',
  extracting: '#1f6feb',
  ready: '#1a7f37',
  error: '#cf222e',
};

const CONTEXT_TYPE_LABELS = {
  quick_note: 'Quick note',
  meeting: 'Meeting',
  trade_show: 'Trade show',
  personal_note: 'Personal note',
  other: 'Other',
};

export async function onRequestGet(context) {
  const { env, data, request } = context;
  const user = data?.user;
  const url = new URL(request.url);
  const flash = readFlash(url);

  const items = await all(
    env.DB,
    `SELECT id, status, source, user_context, audio_filename,
            audio_size_bytes, context_type, raw_transcript, extracted_json,
            error_message, created_at
       FROM ai_inbox_items
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT 100`,
    [user.id]
  );

  const body = renderPage({ items, flash });
  return htmlResponse(layout('AI Inbox', body, { user }));
}

function renderPage({ items, flash }) {
  const flashHtml = flash
    ? html`<div class="flash flash-${flash.kind}">${flash.message}</div>`
    : '';

  return html`
    <style>
      .ai-inbox-wrap { max-width: 960px; margin: 0 auto; padding: 1.5rem 1rem; }
      .ai-inbox-wrap h1 { margin-top: 0; }
      .ai-inbox-upload {
        border: 1px dashed #ccd; padding: 1rem 1.25rem; border-radius: 8px;
        background: #fafbff; margin-bottom: 1.5rem;
      }
      /* Persistent big drop zone */
      .ai-inbox-droppanel {
        margin-bottom: 1.25rem; border: 2px dashed #b8c1d6; border-radius: 8px;
        background: #fafbff; cursor: pointer; transition: border-color .15s, background .15s;
        position: relative;
      }
      .ai-inbox-droppanel.dz-active { border-color: #1f6feb; background: #e6efff; border-style: solid; }
      .ai-inbox-droppanel.dz-busy { opacity: .7; cursor: wait; }
      .ai-inbox-droppanel input[type="file"] {
        position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer;
      }
      .ai-inbox-droppanel.dz-busy input[type="file"] { pointer-events: none; }
      .dz-big-content { padding: 1.5rem 1.25rem; text-align: center; pointer-events: none; }
      .dz-big-icon { font-size: 1.6rem; color: #5a6e96; margin-bottom: .25rem; }
      .dz-big-title { font-size: 1rem; font-weight: 600; color: #2c3a55; }
      .dz-big-hint { font-size: .85rem; color: #666; margin-top: .35rem; }
      .dz-big-status { font-size: .85rem; color: #1f6feb; margin-top: .5rem; min-height: 1.2em; }

      /* Type-text panel under the capture bar */
      .aii-text-panel { margin: .75rem 0 1rem; padding: .85rem; background: #fafbfc; border: 1px solid #e1e4e8; border-radius: 6px; }
      .aii-text-panel textarea { width: 100%; box-sizing: border-box; padding: .55rem .65rem; border: 1px solid #ccd; border-radius: 4px; font-family: inherit; font-size: .9rem; min-height: 6rem; resize: vertical; }
      .aii-text-actions { display: flex; gap: .5rem; margin-top: .55rem; align-items: center; flex-wrap: wrap; }
      .aii-text-status { font-size: .8rem; color: #1f6feb; }
      .aii-btn { padding: .5rem 1rem; border: 1px solid #ccd; background: white; border-radius: 4px; cursor: pointer; font-size: .85rem; min-height: 36px; }
      .aii-btn:hover { background: #f6f8ff; }
      .aii-btn-primary { background: #1f6feb; color: white; border-color: #1f6feb; }
      .aii-btn-primary:hover { background: #1858c4; }
      .ai-inbox-upload button {
        padding: .45rem 1.1rem; background: #1f6feb; color: white;
        border: 0; border-radius: 4px; cursor: pointer; font-weight: 600;
      }
      .ai-inbox-upload button:hover { background: #1657c8; }
      .ai-inbox-upload .help { font-size: .8rem; color: #666; margin-top: .35rem; }
      .ai-inbox-list { display: flex; flex-direction: column; gap: .5rem; }
      .ai-inbox-card {
        display: block; padding: .85rem 1rem; border: 1px solid #e1e4e8;
        border-radius: 6px; text-decoration: none; color: inherit;
        background: white;
      }
      .ai-inbox-card:hover { border-color: #1f6feb; background: #f6f8ff; }
      .ai-inbox-card .head {
        display: flex; align-items: center; gap: .6rem;
        font-size: .85rem; color: #666; margin-bottom: .15rem;
      }
      .ai-inbox-card .status-pill {
        display: inline-block; padding: .1rem .55rem; border-radius: 999px;
        font-size: .75rem; font-weight: 600; color: white;
      }
      .ai-inbox-card .ctx-pill {
        display: inline-block; padding: .1rem .5rem; border-radius: 4px;
        font-size: .75rem; background: #eef; color: #335;
      }
      .ai-inbox-card .title { font-weight: 600; margin: .15rem 0; font-size: 1rem; }
      .ai-inbox-card .summary { font-size: .9rem; color: #444; line-height: 1.35; }
      .ai-inbox-card .err { color: #cf222e; font-size: .85rem; }
      .ai-inbox-empty {
        text-align: center; padding: 2.5rem 1rem; color: #888;
        border: 1px dashed #ddd; border-radius: 6px;
      }
      .flash { padding: .65rem .9rem; border-radius: 4px; margin-bottom: 1rem; }
      .flash-success { background: #d4ecdb; color: #1a3d24; }
      .flash-error { background: #fadddd; color: #6a1a20; }

      /* Mobile (≤ 640px): tighter padding and the drop panel takes
         less vertical space so the recent-items list is visible
         above the fold. */
      @media (max-width: 640px) {
        .ai-inbox-wrap { padding: 1rem .75rem; }
        .dz-big-content { padding: 1.1rem .75rem; }
        .dz-big-title { font-size: .95rem; }
        .ai-inbox-card { padding: .65rem .75rem; }
      }
    </style>

    <div class="ai-inbox-wrap">
      <h1>AI Inbox</h1>
      <p style="color:#555; margin-top:0;">
        Drop in audio, a PDF, an email, an image, or anything else.
        We extract structure (people, organizations, action items,
        open questions) and resolve mentions against your CRM. Each
        capture lives as an Entry — permanent, with one or more
        attachments.
      </p>

      ${flashHtml}

      <div class="ai-inbox-droppanel" data-dropzone-big id="aii-drop-new">
        <form method="post" action="/ai-inbox/new" enctype="multipart/form-data" data-dz-form>
          <input type="file" name="file" data-dz-input>
          <div class="dz-big-content">
            <div class="dz-big-icon">⬆</div>
            <div class="dz-big-title">Drop a file to start a new entry</div>
            <div class="dz-big-hint">…or click to browse. Audio gets transcribed; PDFs &amp; DOCX get text-extracted; everything is fair game.</div>
            <div class="dz-big-status" data-dz-status></div>
          </div>
        </form>
      </div>

      <div class="aii-capture-bar">
        <button type="button" class="aii-capture-btn" id="aii-record-new"
                title="Record audio" aria-label="Record audio">
          <span class="aii-capture-btn-icon">🎤</span>
        </button>
        <button type="button" class="aii-capture-btn" id="aii-photo-new"
                title="Add a photo (camera or library)" aria-label="Add a photo">
          <span class="aii-capture-btn-icon">📷</span>
        </button>
        <button type="button" class="aii-capture-btn" id="aii-text-new"
                title="Type or paste a note" aria-label="Type or paste a note">
          <span class="aii-capture-btn-icon">⌨</span>
        </button>
        <input type="file" id="aii-photo-input-new" accept="image/*" hidden>
      </div>

      <div class="aii-text-panel" id="aii-text-panel-new" hidden>
        <textarea id="aii-text-input-new" rows="6"
                  placeholder="Type or paste a note. Click Save to create an entry from it. The text becomes the entry's first attachment and runs through extraction."></textarea>
        <div class="aii-text-actions">
          <button type="button" class="aii-btn aii-btn-primary" id="aii-text-save-new">Save as entry</button>
          <button type="button" class="aii-btn" id="aii-text-cancel-new">Cancel</button>
          <span class="aii-text-status" id="aii-text-status-new"></span>
        </div>
      </div>

      <script src="/js/dropzone.js"></script>
      <script src="/js/inbox-droppanel.js"></script>
      <script src="/js/audio-recorder.js"></script>
      <script>
        (function () {
          // After-record / after-photo handler: package the file the
          // same way the dropzone does (multipart POST to /ai-inbox/new)
          // so the browser follows the 303 redirect to the new entry's
          // detail page.
          function uploadAsNewEntry(file) {
            const fd = new FormData();
            fd.append('file', file);
            const form = document.createElement('form');
            form.method = 'POST';
            form.action = '/ai-inbox/new';
            form.enctype = 'multipart/form-data';
            form.style.display = 'none';
            const input = document.createElement('input');
            input.type = 'file';
            input.name = 'file';
            const dt = new DataTransfer();
            dt.items.add(file);
            input.files = dt.files;
            form.appendChild(input);
            document.body.appendChild(form);
            form.submit();
          }

          var rec = document.getElementById('aii-record-new');
          if (rec) rec.addEventListener('click', function () {
            window.PipelineAudioRecorder.open(uploadAsNewEntry);
          });

          var photoBtn = document.getElementById('aii-photo-new');
          var photoInput = document.getElementById('aii-photo-input-new');
          if (photoBtn && photoInput) {
            photoBtn.addEventListener('click', function () { photoInput.click(); });
            photoInput.addEventListener('change', function () {
              if (photoInput.files && photoInput.files[0]) {
                uploadAsNewEntry(photoInput.files[0]);
              }
            });
          }

          // Type-text panel: toggle, save → POSTs to /ai-inbox/new
          // with a text form field instead of a file. The browser
          // follows the 303 redirect to the new entry's detail page.
          var textBtn    = document.getElementById('aii-text-new');
          var textPanel  = document.getElementById('aii-text-panel-new');
          var textInput  = document.getElementById('aii-text-input-new');
          var textSave   = document.getElementById('aii-text-save-new');
          var textCancel = document.getElementById('aii-text-cancel-new');
          var textStatus = document.getElementById('aii-text-status-new');
          if (textBtn && textPanel) {
            textBtn.addEventListener('click', function () {
              textPanel.hidden = false;
              textInput.focus();
            });
            textCancel.addEventListener('click', function () {
              textPanel.hidden = true;
              textInput.value = '';
              textStatus.textContent = '';
            });
            textSave.addEventListener('click', function () {
              var txt = (textInput.value || '').trim();
              if (!txt) return;
              textStatus.textContent = 'Saving…';
              var form = document.createElement('form');
              form.method = 'POST';
              form.action = '/ai-inbox/new';
              form.enctype = 'multipart/form-data';
              form.style.display = 'none';
              var input = document.createElement('input');
              input.type = 'hidden';
              input.name = 'text';
              input.value = txt;
              form.appendChild(input);
              document.body.appendChild(form);
              form.submit();
            });
          }
        })();
      </script>

      ${items.length === 0
        ? html`<div class="ai-inbox-empty">No items yet. Upload your first recording above.</div>`
        : html`<div class="ai-inbox-list">${items.map(renderCard)}</div>`}
    </div>
  `.toString();
}

function renderCard(item) {
  const statusLabel = STATUS_LABELS[item.status] || item.status;
  const statusColor = STATUS_COLORS[item.status] || '#888';
  const ctxLabel = CONTEXT_TYPE_LABELS[item.context_type] || null;

  let title = '(processing…)';
  let summary = '';
  if (item.status === 'ready' && item.extracted_json) {
    try {
      const parsed = JSON.parse(item.extracted_json);
      title = parsed.title || '(untitled)';
      summary = parsed.summary || '';
    } catch { /* fall through */ }
  } else if (item.status === 'error') {
    title = item.user_context || item.audio_filename || '(failed)';
    summary = '';
  } else {
    title = item.user_context || item.audio_filename || '(processing…)';
  }

  const created = formatDate(item.created_at);

  return html`
    <a class="ai-inbox-card" href="/ai-inbox/${escape(item.id)}">
      <div class="head">
        <span class="status-pill" style="background:${escape(statusColor)};">${escape(statusLabel)}</span>
        ${ctxLabel ? html`<span class="ctx-pill">${escape(ctxLabel)}</span>` : ''}
        <span>${escape(created)}</span>
      </div>
      <div class="title">${escape(title)}</div>
      ${item.status === 'error' && item.error_message
        ? html`<div class="err">${escape(item.error_message)}</div>`
        : summary
          ? html`<div class="summary">${escape(truncate(summary, 220))}</div>`
          : ''}
    </a>
  `;
}

function truncate(s, n) {
  if (!s || s.length <= n) return s || '';
  return s.slice(0, n - 1).trimEnd() + '…';
}

function formatDate(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
    });
  } catch {
    return iso;
  }
}
