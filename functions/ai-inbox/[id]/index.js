// functions/ai-inbox/[id]/index.js
//
// GET /ai-inbox/:id
//
// Detail page: audio player, status, transcript, and extracted fields.
// Extracted fields are inline-editable via Alpine.js — click a field
// to edit, blur or Enter to save (POST /ai-inbox/:id/edit).

import { one } from '../../lib/db.js';
import { layout, html, escape, raw, htmlResponse } from '../../lib/layout.js';
import { readFlash } from '../../lib/http.js';

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

const DESTINATION_LABELS = {
  keep_as_note: 'Keep as note',
  create_task: 'Create task',
  create_reminder: 'Create reminder',
  link_to_account: 'Link to account',
  link_to_opportunity: 'Link to opportunity',
  archive: 'Archive',
};

export async function onRequestGet(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const url = new URL(request.url);
  const flash = readFlash(url);

  const item = await one(
    env.DB,
    'SELECT * FROM ai_inbox_items WHERE id = ? AND user_id = ?',
    [params.id, user.id]
  );

  if (!item) {
    return htmlResponse(layout('Not found',
      `<div style="max-width:600px;margin:3rem auto;text-align:center;">
         <h1>Not found</h1>
         <p>That AI Inbox item doesn't exist or isn't yours.</p>
         <p><a href="/ai-inbox">← Back to AI Inbox</a></p>
       </div>`,
      { user }
    ), { status: 404 });
  }

  let extracted = null;
  if (item.extracted_json) {
    try { extracted = JSON.parse(item.extracted_json); } catch { /* ignore */ }
  }

  const body = renderDetail({ item, extracted, flash });
  return htmlResponse(layout('AI Inbox · Item', body, { user }));
}

function renderDetail({ item, extracted, flash }) {
  const statusLabel = STATUS_LABELS[item.status] || item.status;
  const statusColor = STATUS_COLORS[item.status] || '#888';
  const ctxLabel = item.context_type ? (CONTEXT_TYPE_LABELS[item.context_type] || item.context_type) : null;
  const created = formatDate(item.created_at);

  const flashHtml = flash
    ? html`<div class="flash flash-${flash.kind}">${flash.message}</div>`
    : '';

  // Pre-encode extracted JSON for the Alpine x-data initializer.
  // - <script> sequences are neutralized via a unicode escape on '<'
  //   so a `</script>` inside a string can't break out.
  // - The result is then HTML-attribute-escaped (escape() turns " into
  //   &quot; etc.) so it can live inside x-data="…" without breaking
  //   the attribute parser. Alpine reads the decoded attribute value
  //   and evaluates it as JavaScript.
  const extractedRaw = extracted
    ? JSON.stringify(extracted).replace(/</g, '\\u003c')
    : 'null';

  const isProcessing = ['pending', 'transcribing', 'classifying', 'extracting'].includes(item.status);

  return html`
    <style>
      .aii-wrap { max-width: 960px; margin: 0 auto; padding: 1.5rem 1rem; }
      .aii-back { display: inline-block; margin-bottom: 1rem; color: #1f6feb; text-decoration: none; }
      .aii-back:hover { text-decoration: underline; }
      .aii-head { display: flex; flex-wrap: wrap; gap: .6rem; align-items: center; margin-bottom: .5rem; font-size: .9rem; color: #555; }
      .status-pill { display: inline-block; padding: .15rem .65rem; border-radius: 999px; font-size: .8rem; font-weight: 600; color: white; }
      .ctx-pill { display: inline-block; padding: .15rem .55rem; border-radius: 4px; font-size: .8rem; background: #eef; color: #335; }
      .aii-section { background: white; border: 1px solid #e1e4e8; border-radius: 6px; padding: 1rem 1.25rem; margin-bottom: 1rem; }
      .aii-section h2 { margin: 0 0 .65rem; font-size: 1rem; color: #333; }
      .aii-audio { width: 100%; margin: .35rem 0; }
      .aii-meta { font-size: .8rem; color: #777; }
      .aii-transcript { white-space: pre-wrap; font-family: ui-monospace, monospace; font-size: .85rem; line-height: 1.45; max-height: 26rem; overflow-y: auto; padding: .75rem; background: #f8f8fa; border-radius: 4px; }
      .aii-err { color: #cf222e; padding: .65rem .9rem; border: 1px solid #fadddd; border-radius: 4px; background: #fff5f5; }

      /* Inline-edit fields */
      .aii-field { display: block; margin-bottom: .65rem; }
      .aii-field-label { display: block; font-size: .75rem; font-weight: 600; color: #666; text-transform: uppercase; letter-spacing: .04em; margin-bottom: .15rem; }
      .aii-editable { padding: .35rem .5rem; border-radius: 4px; cursor: text; min-height: 1.3rem; }
      .aii-editable:hover { background: #f6f8ff; }
      .aii-editable[contenteditable="true"] { background: #fffbe5; outline: 1px solid #f0c000; cursor: text; }
      .aii-editable.empty { color: #aaa; font-style: italic; }
      .aii-saving { font-size: .7rem; color: #1f6feb; margin-left: .35rem; }

      .aii-list { list-style: none; padding-left: 0; margin: 0; }
      .aii-list li { padding: .35rem .5rem; border-radius: 4px; }
      .aii-list li + li { margin-top: .15rem; }
      .aii-action { display: grid; grid-template-columns: 1fr auto auto auto; gap: .4rem; align-items: center; padding: .35rem .5rem; border: 1px solid #eee; border-radius: 4px; background: #fafafa; }
      .aii-action + .aii-action { margin-top: .35rem; }
      .aii-action input { padding: .25rem .4rem; border: 1px solid #ddd; border-radius: 3px; }
      .aii-action .task-in { width: 100%; }
      .aii-action .owner-in { width: 8rem; }
      .aii-action .due-in { width: 8rem; }
      .aii-add-btn, .aii-rm-btn { padding: .2rem .55rem; border: 1px solid #ccd; background: white; border-radius: 3px; cursor: pointer; font-size: .8rem; }
      .aii-add-btn:hover { background: #eef; }
      .aii-rm-btn { color: #cf222e; }

      .aii-tags-edit { display: flex; flex-wrap: wrap; gap: .35rem; }
      .aii-tag { display: inline-block; padding: .15rem .55rem; border-radius: 999px; background: #eef; color: #335; font-size: .8rem; }
      .aii-tag .x { margin-left: .35rem; cursor: pointer; color: #888; }
      .aii-tag-input { padding: .2rem .4rem; border: 1px dashed #ccd; border-radius: 999px; font-size: .8rem; min-width: 5rem; }

      .aii-dest { display: inline-block; padding: .15rem .55rem; border-radius: 4px; background: #f0f4ff; color: #2451b8; font-size: .8rem; margin: 0 .25rem .25rem 0; }

      .aii-row { display: flex; gap: .5rem; flex-wrap: wrap; }
      .aii-row > .aii-section { flex: 1 1 280px; min-width: 0; }

      .aii-actions-bar { display: flex; gap: .5rem; flex-wrap: wrap; margin-top: 1rem; }
      .aii-btn { padding: .4rem .9rem; border: 1px solid #ccd; background: white; border-radius: 4px; cursor: pointer; font-size: .85rem; text-decoration: none; color: #333; }
      .aii-btn:hover { background: #f6f8ff; }
      .aii-btn-danger { color: #cf222e; border-color: #fadddd; }
      .aii-btn-danger:hover { background: #fff5f5; }

      .flash { padding: .65rem .9rem; border-radius: 4px; margin-bottom: 1rem; }
      .flash-success { background: #d4ecdb; color: #1a3d24; }
      .flash-error { background: #fadddd; color: #6a1a20; }
    </style>

    <div class="aii-wrap">
      <a class="aii-back" href="/ai-inbox">← Back to AI Inbox</a>

      <div class="aii-head">
        <span class="status-pill" style="background:${escape(statusColor)};">${escape(statusLabel)}</span>
        ${ctxLabel ? html`<span class="ctx-pill">${escape(ctxLabel)}</span>` : ''}
        <span>${escape(created)}</span>
      </div>

      ${flashHtml}

      ${item.status === 'error' && item.error_message
        ? html`<div class="aii-err"><strong>Error:</strong> ${escape(item.error_message)}</div>`
        : ''}

      ${isProcessing
        ? html`<div class="aii-section">
            <p>Processing… this page does not auto-refresh yet.
            <a href="">Reload</a> in a few seconds.</p>
          </div>`
        : ''}

      <section class="aii-section">
        <h2>Audio</h2>
        ${item.audio_r2_key
          ? html`<audio class="aii-audio" controls preload="metadata"
                      src="/ai-inbox/${escape(item.id)}/audio"></audio>`
          : html`<p>No audio attached.</p>`}
        <div class="aii-meta">
          ${item.audio_filename ? escape(item.audio_filename) : ''}
          ${item.audio_size_bytes ? ` · ${formatSize(item.audio_size_bytes)}` : ''}
          ${item.transcription_model ? ` · model: ${escape(item.transcription_model)}` : ''}
        </div>
        ${item.user_context
          ? html`<div style="margin-top:.5rem;font-size:.85rem;"><strong>Your note:</strong> ${escape(item.user_context)}</div>`
          : ''}
      </section>

      ${item.raw_transcript
        ? html`<section class="aii-section">
            <h2>Transcript</h2>
            <div class="aii-transcript">${escape(item.raw_transcript)}</div>
          </section>`
        : ''}

      ${extracted
        ? renderExtracted(item, extractedRaw)
        : ''}

      <div class="aii-actions-bar">
        ${item.audio_r2_key && (item.status === 'error' || item.status === 'ready')
          ? html`<form method="post" action="/ai-inbox/${escape(item.id)}/process" style="display:inline;">
              <button type="submit" class="aii-btn">Re-run pipeline</button>
            </form>`
          : ''}
        <form method="post" action="/ai-inbox/${escape(item.id)}/delete" style="display:inline;"
              onsubmit="return confirm('Delete this item and its audio file?');">
          <button type="submit" class="aii-btn aii-btn-danger">Delete</button>
        </form>
      </div>
    </div>

    <script>
      // Alpine x-data registration for the inline-edit panel.
      // We use a function defined on window because the layout already
      // initializes Alpine globally; this avoids inlining a large script
      // tag inside x-data.
      window.aiInboxInit = function (initial, itemId) {
        return {
          fields: initial || {
            title: '', summary: '',
            people: [], organizations: [], tags: [],
            action_items: [], open_questions: [], suggested_destinations: [],
            confidence: 'medium',
          },
          tagInput: '',
          saving: '',
          itemId: itemId,
          async saveField(name) {
            const value = this.fields[name];
            await this.postUpdate({ [name]: value });
          },
          async saveAll() {
            await this.postUpdate(this.fields);
          },
          async postUpdate(payload) {
            this.saving = 'Saving…';
            try {
              const res = await fetch('/ai-inbox/' + encodeURIComponent(this.itemId) + '/edit', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(payload),
              });
              if (!res.ok) throw new Error('save failed');
              this.saving = 'Saved';
              setTimeout(() => { this.saving = ''; }, 1200);
            } catch (e) {
              this.saving = 'Save failed';
            }
          },
          addTag() {
            const t = (this.tagInput || '').trim();
            if (!t) return;
            if (!this.fields.tags.includes(t)) this.fields.tags.push(t);
            this.tagInput = '';
            this.saveField('tags');
          },
          removeTag(idx) {
            this.fields.tags.splice(idx, 1);
            this.saveField('tags');
          },
          addAction() {
            this.fields.action_items.push({ task: '', owner: '', due: '' });
          },
          removeAction(idx) {
            this.fields.action_items.splice(idx, 1);
            this.saveField('action_items');
          },
        };
      };
    </script>
  `.toString();
}

function renderExtracted(item, extractedRaw) {
  // The JSON and the destination labels both ride inside HTML attribute
  // values (x-data, x-text). We escape() each so quotes/ampersands turn
  // into entities — the browser decodes them before Alpine evaluates the
  // attribute as JavaScript, so what Alpine sees is plain JS again.
  const destLabelsRaw = JSON.stringify(DESTINATION_LABELS);
  return html`
    <section class="aii-section"
             x-data="aiInboxInit(${escape(extractedRaw)}, '${escape(item.id)}')">
      <h2>Extracted <span class="aii-saving" x-text="saving"></span></h2>

      <div class="aii-field">
        <label class="aii-field-label">Title</label>
        <div class="aii-editable"
             contenteditable="true"
             x-text="fields.title"
             @blur="fields.title = $event.target.innerText.trim(); saveField('title')"></div>
      </div>

      <div class="aii-field">
        <label class="aii-field-label">Summary</label>
        <div class="aii-editable"
             contenteditable="true"
             x-text="fields.summary"
             @blur="fields.summary = $event.target.innerText.trim(); saveField('summary')"></div>
      </div>

      <div class="aii-row">
        <section class="aii-section" style="margin:0;">
          <h2>People</h2>
          <ul class="aii-list">
            <template x-for="(p, idx) in fields.people" :key="idx">
              <li>
                <span class="aii-editable" contenteditable="true"
                      x-text="p"
                      @blur="fields.people[idx] = $event.target.innerText.trim(); saveField('people')"></span>
              </li>
            </template>
            <template x-if="fields.people.length === 0"><li class="aii-editable empty">(none)</li></template>
          </ul>
        </section>

        <section class="aii-section" style="margin:0;">
          <h2>Organizations</h2>
          <ul class="aii-list">
            <template x-for="(o, idx) in fields.organizations" :key="idx">
              <li>
                <span class="aii-editable" contenteditable="true"
                      x-text="o"
                      @blur="fields.organizations[idx] = $event.target.innerText.trim(); saveField('organizations')"></span>
              </li>
            </template>
            <template x-if="fields.organizations.length === 0"><li class="aii-editable empty">(none)</li></template>
          </ul>
        </section>
      </div>

      <section class="aii-section" style="margin-top:1rem;">
        <h2>Action items <button type="button" class="aii-add-btn" @click="addAction()">+ Add</button></h2>
        <template x-for="(a, idx) in fields.action_items" :key="idx">
          <div class="aii-action">
            <input class="task-in" type="text" placeholder="Task" x-model="a.task" @blur="saveField('action_items')">
            <input class="owner-in" type="text" placeholder="Owner" x-model="a.owner" @blur="saveField('action_items')">
            <input class="due-in" type="text" placeholder="YYYY-MM-DD" x-model="a.due" @blur="saveField('action_items')">
            <button type="button" class="aii-rm-btn" @click="removeAction(idx)">×</button>
          </div>
        </template>
        <template x-if="fields.action_items.length === 0">
          <div class="aii-editable empty">(no action items)</div>
        </template>
      </section>

      <div class="aii-row">
        <section class="aii-section" style="margin-top:1rem;">
          <h2>Open questions</h2>
          <ul class="aii-list">
            <template x-for="(q, idx) in fields.open_questions" :key="idx">
              <li>
                <span class="aii-editable" contenteditable="true"
                      x-text="q"
                      @blur="fields.open_questions[idx] = $event.target.innerText.trim(); saveField('open_questions')"></span>
              </li>
            </template>
            <template x-if="fields.open_questions.length === 0"><li class="aii-editable empty">(none)</li></template>
          </ul>
        </section>

        <section class="aii-section" style="margin-top:1rem;">
          <h2>Tags</h2>
          <div class="aii-tags-edit">
            <template x-for="(t, idx) in fields.tags" :key="idx">
              <span class="aii-tag"><span x-text="t"></span><span class="x" @click="removeTag(idx)">×</span></span>
            </template>
            <input class="aii-tag-input" type="text" placeholder="+ tag"
                   x-model="tagInput"
                   @keydown.enter.prevent="addTag()"
                   @blur="addTag()">
          </div>
        </section>
      </div>

      <section class="aii-section" style="margin-top:1rem;">
        <h2>Suggested destinations</h2>
        <div>
          <template x-for="d in fields.suggested_destinations" :key="d">
            <span class="aii-dest" x-text="(${escape(destLabelsRaw)})[d] || d"></span>
          </template>
          <template x-if="fields.suggested_destinations.length === 0">
            <span class="aii-editable empty">(none)</span>
          </template>
        </div>
        <div class="aii-meta" style="margin-top:.5rem;">
          Phase 1: suggestions only — not wired to CRM/calendar/tasks yet.
        </div>
      </section>

      <div class="aii-meta" style="margin-top:.5rem;">
        Confidence: <span x-text="fields.confidence"></span>
      </div>
    </section>
  `;
}

function formatDate(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch { return iso; }
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
