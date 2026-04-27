// functions/ai-inbox/index.js
//
// GET /ai-inbox
//
// Landing page for the AI Inbox experiment. Shows an upload form at
// the top (audio file + optional context) and a newest-first list of
// previous items with their status and a one-line summary. The whole
// page is server-rendered HTML matching the rest of PMS — HTMX/Alpine
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
      .ai-inbox-upload h2 { margin: 0 0 .5rem; font-size: 1.05rem; }
      .ai-inbox-upload .row { display: flex; flex-wrap: wrap; gap: .75rem; align-items: center; }
      .ai-inbox-upload input[type="file"] { flex: 1 1 280px; min-width: 0; }
      .ai-inbox-upload input[type="text"] { flex: 1 1 280px; min-width: 0; padding: .4rem .55rem; }
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
    </style>

    <div class="ai-inbox-wrap">
      <h1>AI Inbox</h1>
      <p style="color:#555; margin-top:0;">
        Upload a voice recording. We transcribe it, classify the context,
        extract structured fields (people, action items, etc.), and drop
        it here for you to review. Phase 1: suggestions only — nothing
        is written to your CRM/calendar/tasks yet.
      </p>

      ${flashHtml}

      <form class="ai-inbox-upload" method="post" action="/ai-inbox/new"
            enctype="multipart/form-data">
        <h2>Upload audio</h2>
        <div class="row">
          <input type="file" name="audio" accept="audio/*,.m4a,.mp3,.wav,.webm,.mp4,.mpeg,.mpga,.ogg,.flac" required>
          <input type="text" name="user_context" placeholder="Optional context (e.g., 'trade show, Helix booth')" maxlength="200">
          <button type="submit">Upload &amp; process</button>
        </div>
        <div class="help">
          Max 25 MB. Supported: m4a, mp3, wav, webm, mp4, mpeg, mpga, ogg, flac.
          Capture with iPhone Voice Memos or any other recorder.
        </div>
      </form>

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
