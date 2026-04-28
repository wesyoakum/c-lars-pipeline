// functions/ai-inbox/[id]/index.js
//
// GET /ai-inbox/:id
//
// Detail page: audio player, status, transcript, and extracted fields.
// Extracted fields are inline-editable via Alpine.js — click a field
// to edit, blur or Enter to save (POST /ai-inbox/:id/edit).

import { one, all } from '../../lib/db.js';
import { layout, html, escape, htmlResponse } from '../../lib/layout.js';
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

  // v2: Load action history (links) and entity matches in parallel.
  // v3: also load attachments for the new attachments-list panel.
  const [links, matches, attachments] = await Promise.all([
    all(env.DB,
      `SELECT id, action_type, ref_type, ref_id, ref_label, created_at
         FROM ai_inbox_links WHERE item_id = ? ORDER BY created_at DESC`,
      [params.id]),
    all(env.DB,
      `SELECT id, mention_kind, mention_text, mention_idx, ref_type, ref_id,
              ref_label, score, rank, auto_resolved, user_overridden
         FROM ai_inbox_entity_matches WHERE item_id = ?
        ORDER BY mention_kind, mention_idx, rank`,
      [params.id]),
    all(env.DB,
      `SELECT id, kind, sort_order, is_primary, include_in_context,
              r2_key, mime_type, size_bytes, filename,
              captured_text, captured_text_model, status, error_message,
              created_at
         FROM ai_inbox_attachments WHERE entry_id = ?
        ORDER BY sort_order, created_at`,
      [params.id]),
  ]);

  const body = renderDetail({ item, extracted, flash, links, matches, user, attachments });
  return htmlResponse(layout('AI Inbox · Item', body, { user }));
}

function renderDetail({ item, extracted, flash, links, matches, user, attachments }) {
  const statusLabel = STATUS_LABELS[item.status] || item.status;
  const statusColor = STATUS_COLORS[item.status] || '#888';
  const ctxLabel = item.context_type ? (CONTEXT_TYPE_LABELS[item.context_type] || item.context_type) : null;
  const created = formatDate(item.created_at);

  const flashHtml = flash
    ? html`<div class="flash flash-${flash.kind}">${flash.message}</div>`
    : '';

  // Pre-encode JSON for Alpine x-data. The replace() neutralizes any
  // </script> attempt; escape() (applied at the call site below)
  // handles HTML attribute boundaries.
  const safeJson = (v) => (v == null ? 'null'
    : JSON.stringify(v).replace(/</g, '\\u003c'));
  const extractedRaw = safeJson(extracted);
  const linksRaw = safeJson(links || []);
  const matchesRaw = safeJson(matches || []);

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
      .aii-transcript { white-space: pre-wrap; font-family: ui-monospace, monospace; font-size: .85rem; line-height: 1.45; max-height: 26rem; overflow-y: auto; padding: .75rem; background: #f8f8fa; border-radius: 4px; margin-top: .5rem; }
      .aii-transcript-details > summary { cursor: pointer; list-style: none; user-select: none; }
      .aii-transcript-details > summary::-webkit-details-marker { display: none; }
      .aii-transcript-details > summary::before { content: '▸ '; display: inline-block; transition: transform .15s; }
      .aii-transcript-details[open] > summary::before { content: '▾ '; }

      /* v3 attachments panel */
      .aii-att-list { display: flex; flex-direction: column; gap: .5rem; }
      .aii-att-row { padding: .55rem .7rem; border: 1px solid #e1e4e8; border-radius: 4px; background: #fafbfc; }
      .aii-att-head { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; font-size: .85rem; }
      .aii-att-kind { display: inline-block; padding: .1rem .5rem; background: #eef; color: #335; border-radius: 3px; font-size: .7rem; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
      .aii-att-primary { color: #d4a017; font-size: 1rem; line-height: 1; }
      .aii-att-meta { color: #555; font-size: .8rem; flex: 1 1 auto; min-width: 8rem; }
      .aii-att-excluded { display: inline-block; padding: .05rem .35rem; background: #f4ddc3; color: #6b4a18; font-size: .7rem; border-radius: 2px; }
      .aii-att-captured > summary { cursor: pointer; font-size: .8rem; color: #555; margin-top: .35rem; user-select: none; }
      .aii-att-captured > summary::-webkit-details-marker { display: none; }
      .aii-att-captured > summary::before { content: '▸ '; display: inline-block; }
      .aii-att-captured[open] > summary::before { content: '▾ '; }
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
      .aii-btn-primary { background: #1f6feb; color: white; border-color: #1f6feb; }
      .aii-btn-primary:hover { background: #1858c4; }
      .aii-btn-primary:disabled { opacity: .55; cursor: not-allowed; }
      .aii-btn-danger { color: #cf222e; border-color: #fadddd; }
      .aii-btn-danger:hover { background: #fff5f5; }

      /* v2: action buttons + inline forms + typeahead + entity links */
      .aii-suggested-actions { display: flex; flex-wrap: wrap; gap: .35rem; margin: .25rem 0 .5rem; }
      .aii-action-btn { padding: .25rem .7rem; border: 1px solid #c8d4ff; background: #f0f4ff; color: #2451b8; border-radius: 4px; font-size: .85rem; cursor: pointer; }
      .aii-action-btn:hover { background: #dbe5ff; }
      .aii-action-btn-soon { opacity: .55; cursor: not-allowed; }
      .aii-action-btn-soon:hover { background: #f0f4ff; }

      .aii-action-form { margin-top: .75rem; padding: .85rem; border: 1px solid #e1e4e8; border-radius: 4px; background: #fafbfc; }
      .aii-action-form h3 { margin: 0 0 .5rem; font-size: .9rem; color: #333; }
      .aii-form-row { display: grid; grid-template-columns: 6rem 1fr; gap: .5rem; align-items: center; margin-bottom: .45rem; }
      .aii-form-row > span { font-size: .8rem; color: #555; }
      .aii-form-row input, .aii-form-row textarea { width: 100%; padding: .3rem .45rem; border: 1px solid #ccd; border-radius: 3px; font-size: .85rem; box-sizing: border-box; font-family: inherit; }
      .aii-form-actions { display: flex; gap: .5rem; align-items: center; margin-top: .5rem; }
      .aii-err-inline { color: #cf222e; font-size: .8rem; }

      .aii-typeahead-wrap { position: relative; display: block; }
      .aii-typeahead { position: absolute; top: 100%; left: 0; right: 0; max-height: 14rem; overflow-y: auto; margin: 2px 0 0; padding: 0; list-style: none; background: white; border: 1px solid #ccd; border-radius: 3px; z-index: 30; box-shadow: 0 2px 8px rgba(0,0,0,.08); }
      .aii-typeahead li { padding: .35rem .55rem; cursor: pointer; display: flex; gap: .35rem; align-items: baseline; }
      .aii-typeahead li:hover { background: #f0f4ff; }
      .aii-typeahead li small { color: #777; font-size: .75rem; }

      .aii-links { display: flex; flex-direction: column; gap: .25rem; margin-bottom: .5rem; }
      .aii-link-row { display: flex; align-items: center; gap: .5rem; padding: .25rem .4rem; background: #eef5e6; border-radius: 3px; font-size: .85rem; }
      .aii-link-kind { display: inline-block; padding: .1rem .45rem; background: #1a7f37; color: white; border-radius: 3px; font-size: .7rem; text-transform: uppercase; letter-spacing: .04em; }
      .aii-link-target { color: #1f6feb; text-decoration: none; flex: 1; }
      .aii-link-target:hover { text-decoration: underline; }

      .aii-mention { display: flex; align-items: center; gap: .35rem; flex-wrap: wrap; padding: .35rem .5rem; }
      .aii-mention + .aii-mention { border-top: 1px dashed #eef; }
      .aii-mention-link { color: #1f6feb; text-decoration: none; font-weight: 500; }
      .aii-mention-link:hover { text-decoration: underline; }
      .aii-mention-orig { color: #999; font-size: .75rem; }
      .aii-suggest-btn { padding: .15rem .55rem; border: 1px solid #c8d4ff; background: #f0f4ff; color: #2451b8; border-radius: 3px; font-size: .75rem; cursor: pointer; }
      .aii-suggest-btn:hover { background: #dbe5ff; }
      .aii-create-btn { padding: .15rem .55rem; border: 1px dashed #c8d4ff; background: white; color: #555; border-radius: 3px; font-size: .75rem; cursor: pointer; }
      .aii-create-btn:hover { background: #f6f8ff; color: #1f6feb; }

      [x-cloak] { display: none !important; }

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

      ${renderAttachments({ item, attachments })}

      ${item.user_context
        ? html`<section class="aii-section">
            <div style="font-size:.85rem;"><strong>Your note:</strong> ${escape(item.user_context)}</div>
          </section>`
        : ''}

      ${item.raw_transcript
        ? html`<section class="aii-section">
            <details class="aii-transcript-details">
              <summary><h2 style="display:inline;margin:0;">Transcript</h2></summary>
              <div class="aii-transcript">${escape(item.raw_transcript)}</div>
            </details>
          </section>`
        : ''}

      ${extracted
        ? renderExtracted(item, extractedRaw, linksRaw, matchesRaw, user)
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
      // v2 extends the v1 component with: links (action history),
      // matches (entity resolver output), actionForm (currently-open
      // inline form), typeahead (entity picker state).
      window.aiInboxInit = function (initial, itemId, links, matches) {
        return {
          fields: initial || {
            title: '', summary: '',
            people: [], organizations: [], tags: [],
            action_items: [], open_questions: [], suggested_destinations: [],
            confidence: 'medium',
          },
          links: links || [],
          matches: matches || [],
          // null when closed; otherwise { kind, ...form fields, busy?, error? }
          actionForm: null,
          // null when no field is searching; otherwise { kind:'account'|'contact', q, results, loading }
          typeahead: null,
          tagInput: '',
          saving: '',
          itemId: itemId,
          // Action types we have a form for; others render as-is from
          // the suggestions but don't open anything when clicked.
          handledActions: ['create_task', 'link_to_account'],
          destLabels: {
            keep_as_note: 'Keep as note',
            create_task: 'Create task',
            create_reminder: 'Create reminder',
            link_to_account: 'Link to account',
            link_to_opportunity: 'Link to opportunity',
            archive: 'Archive',
            create_account: 'Create account',
            create_contact: 'Create contact',
          },

          // ----- existing edit/save behavior (v1) -----
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
          removeTag(idx) { this.fields.tags.splice(idx, 1); this.saveField('tags'); },
          addAction() { this.fields.action_items.push({ task: '', owner: '', due: '' }); },
          removeAction(idx) { this.fields.action_items.splice(idx, 1); this.saveField('action_items'); },

          // ----- v2: actions -----
          isHandled(kind) { return this.handledActions.indexOf(kind) >= 0; },

          openAction(kind) {
            if (!this.isHandled(kind)) return;
            const accountId = this.preferredAccountId();
            const accountLabel = this.preferredAccountLabel();
            if (kind === 'create_task') {
              const firstAction = (this.fields.action_items || [])[0];
              const summaryFirst = ((this.fields.summary || '').split(/\\r?\\n/)[0] || '').slice(0, 80);
              this.actionForm = {
                kind, busy: false, error: '',
                subject: (firstAction && firstAction.task) || summaryFirst || '',
                body: this.fields.summary || '',
                due_at: (firstAction && firstAction.due) || '',
                account_id: accountId,
                account_label: accountLabel,
              };
            } else if (kind === 'link_to_account') {
              this.actionForm = {
                kind, busy: false, error: '',
                account_id: accountId,
                account_label: accountLabel,
              };
            }
          },
          closeAction() { this.actionForm = null; this.typeahead = null; },

          async submitAction() {
            if (!this.actionForm) return;
            const f = this.actionForm;
            f.busy = true; f.error = '';
            const path = f.kind.replace(/_/g, '-');
            try {
              const payload = {};
              if (f.kind === 'create_task') {
                payload.subject = f.subject || '';
                payload.body = f.body || '';
                payload.account_id = f.account_id || '';
                payload.due_at = f.due_at || '';
              } else if (f.kind === 'link_to_account') {
                payload.account_id = f.account_id || '';
                if (!payload.account_id) { f.busy = false; f.error = 'Pick an account first.'; return; }
              }
              const res = await fetch('/ai-inbox/' + encodeURIComponent(this.itemId)
                          + '/actions/' + path, {
                method: 'POST', credentials: 'same-origin',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(payload),
              });
              const dataJson = await res.json();
              if (!dataJson.ok) throw new Error(dataJson.error || 'failed');
              this.links = [dataJson.link, ...this.links];
              this.closeAction();
            } catch (e) {
              f.busy = false; f.error = String(e.message || e);
            }
          },

          async unlink(linkId) {
            if (!confirm('Remove this link?')) return;
            const res = await fetch('/ai-inbox/' + encodeURIComponent(this.itemId)
                        + '/actions/' + encodeURIComponent(linkId) + '/unlink',
              { method: 'POST', credentials: 'same-origin' });
            const dataJson = await res.json();
            if (dataJson.ok) {
              this.links = this.links.filter(l => l.id !== linkId);
            }
          },

          // ----- v2: typeahead -----
          async searchEntities(kind, q, accountId) {
            this.typeahead = { kind, q, results: [], loading: true };
            const params = new URLSearchParams();
            if (q) params.set('q', q);
            if (accountId) params.set('account_id', accountId);
            const path = kind === 'account' ? '/ai-inbox/_search/accounts'
                                            : '/ai-inbox/_search/contacts';
            try {
              const res = await fetch(path + '?' + params.toString(),
                { credentials: 'same-origin' });
              const dataJson = await res.json();
              this.typeahead.results = dataJson.results || [];
            } catch (e) {
              this.typeahead.results = [];
            }
            this.typeahead.loading = false;
          },
          pickAccount(r) {
            if (!this.actionForm) return;
            this.actionForm.account_id = r.ref_id;
            this.actionForm.account_label = r.label;
            this.typeahead = null;
          },
          clearTypeahead() { this.typeahead = null; },

          // ----- v2: entity matches -----
          matchesFor(kind, idx) {
            return this.matches.filter(m => m.mention_kind === kind && m.mention_idx === idx);
          },
          bestMatch(kind, idx) {
            const m = this.matchesFor(kind, idx);
            return m.find(x => x.user_overridden) || m.find(x => x.auto_resolved) || null;
          },
          candidatesFor(kind, idx) {
            const m = this.matchesFor(kind, idx);
            if (m.some(x => x.user_overridden)) return [];
            return m.filter(x => !x.user_overridden).slice(0, 3);
          },
          entityHref(m) {
            if (!m) return '#';
            if (m.ref_type === 'account') return '/accounts/' + encodeURIComponent(m.ref_id);
            if (m.ref_type === 'contact') return '/accounts/' + encodeURIComponent(m.ref_id);
            return '#';
          },
          linkHref(l) {
            if (!l) return '#';
            if (l.ref_type === 'activity') return '/activities/' + encodeURIComponent(l.ref_id);
            if (l.ref_type === 'account') return '/accounts/' + encodeURIComponent(l.ref_id);
            if (l.ref_type === 'contact') return '/accounts/' + encodeURIComponent(l.ref_id);
            if (l.ref_type === 'opportunity') return '/opportunities/' + encodeURIComponent(l.ref_id);
            return '#';
          },
          async confirmMatch(kind, idx, mentionText, refType, refId) {
            const res = await fetch('/ai-inbox/' + encodeURIComponent(this.itemId)
                        + '/entities/match', {
              method: 'POST', credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                mention_kind: kind, mention_idx: idx,
                mention_text: mentionText, ref_type: refType, ref_id: refId,
              }),
            });
            const dataJson = await res.json();
            if (dataJson.ok) {
              this.matches = this.matches.filter(
                m => !(m.mention_kind === kind && m.mention_idx === idx)
              );
              this.matches.push(dataJson.match);
            }
          },
          async unmatch(kind, idx) {
            await fetch('/ai-inbox/' + encodeURIComponent(this.itemId)
                        + '/entities/unmatch', {
              method: 'POST', credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ mention_kind: kind, mention_idx: idx }),
            });
            this.matches = this.matches.filter(
              m => !(m.mention_kind === kind && m.mention_idx === idx)
            );
          },
          async resolveAll() {
            const res = await fetch('/ai-inbox/' + encodeURIComponent(this.itemId)
                        + '/entities/resolve',
              { method: 'POST', credentials: 'same-origin' });
            const dataJson = await res.json();
            if (dataJson.ok) this.matches = dataJson.matches || [];
          },

          // ----- v2: create-account / create-contact mini-forms -----
          openCreateAccount(idx) {
            const mention = (this.fields.organizations || [])[idx] || '';
            this.actionForm = {
              kind: 'create_account', busy: false, error: '',
              mention_idx: idx, mention_text: mention,
              name: mention, alias: '', segment: '',
            };
          },
          openCreateContact(idx) {
            const mention = (this.fields.people || [])[idx] || '';
            const tokens = (mention || '').trim().split(/\\s+/);
            const first = tokens[0] || '';
            const last = tokens.length > 1 ? tokens[tokens.length - 1] : '';
            this.actionForm = {
              kind: 'create_contact', busy: false, error: '',
              mention_idx: idx, mention_text: mention,
              first_name: first, last_name: last,
              email: '', title: '', phone: '',
              account_id: this.preferredAccountId(),
              account_label: this.preferredAccountLabel(),
            };
          },

          async submitCreateAccount() {
            const f = this.actionForm;
            if (!f || f.kind !== 'create_account') return;
            if (!(f.name || '').trim()) { f.error = 'Account name required.'; return; }
            f.busy = true; f.error = '';
            try {
              const res = await fetch('/ai-inbox/' + encodeURIComponent(this.itemId)
                          + '/entities/create-account', {
                method: 'POST', credentials: 'same-origin',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  mention_idx: f.mention_idx, mention_text: f.mention_text,
                  name: f.name, alias: f.alias || '', segment: f.segment || '',
                }),
              });
              const dataJson = await res.json();
              if (!dataJson.ok) throw new Error(dataJson.error || 'failed');
              this.matches = this.matches.filter(
                m => !(m.mention_kind === 'organization' && m.mention_idx === f.mention_idx)
              );
              this.matches.push(dataJson.match);
              this.links = [dataJson.link, ...this.links];
              this.closeAction();
            } catch (e) {
              f.busy = false; f.error = String(e.message || e);
            }
          },

          async submitCreateContact() {
            const f = this.actionForm;
            if (!f || f.kind !== 'create_contact') return;
            if (!(f.first_name || '').trim() && !(f.last_name || '').trim()) {
              f.error = 'First or last name required.'; return;
            }
            if (!(f.account_id || '').trim()) {
              f.error = 'Pick an account for this contact.'; return;
            }
            f.busy = true; f.error = '';
            try {
              const res = await fetch('/ai-inbox/' + encodeURIComponent(this.itemId)
                          + '/entities/create-contact', {
                method: 'POST', credentials: 'same-origin',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  mention_idx: f.mention_idx, mention_text: f.mention_text,
                  account_id: f.account_id,
                  first_name: f.first_name || '', last_name: f.last_name || '',
                  email: f.email || '', title: f.title || '', phone: f.phone || '',
                }),
              });
              const dataJson = await res.json();
              if (!dataJson.ok) throw new Error(dataJson.error || 'failed');
              this.matches = this.matches.filter(
                m => !(m.mention_kind === 'person' && m.mention_idx === f.mention_idx)
              );
              this.matches.push(dataJson.match);
              this.links = [dataJson.link, ...this.links];
              this.closeAction();
            } catch (e) {
              f.busy = false; f.error = String(e.message || e);
            }
          },

          // ----- helpers -----
          preferredAccountId() {
            const m = this.matches.find(
              x => x.mention_kind === 'organization' &&
                   (x.user_overridden || x.auto_resolved)
            );
            return m ? m.ref_id : '';
          },
          preferredAccountLabel() {
            const m = this.matches.find(
              x => x.mention_kind === 'organization' &&
                   (x.user_overridden || x.auto_resolved)
            );
            return m ? m.ref_label : '';
          },
        };
      };
    </script>
  `.toString();
}

function renderExtracted(item, extractedRaw, linksRaw, matchesRaw, user) {
  const userName = user?.display_name || user?.first_name || 'You';
  // Display name only used as the placeholder for the action-item Owner
  // field — when the LLM left owner blank, it means "the recorder", and
  // showing the recorder's own name makes that explicit.
  // JSON-into-attribute pattern. Each value was already JSON.stringify'd
  // and had < neutralized; escape() handles the attribute boundary. The
  // browser decodes the attribute and Alpine evaluates it as JS.
  return html`
    <section class="aii-section"
             x-data="aiInboxInit(${escape(extractedRaw)}, '${escape(item.id)}', ${escape(linksRaw)}, ${escape(matchesRaw)})">
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
          <h2>People <button type="button" class="aii-add-btn" @click="resolveAll()" title="Re-run entity resolver">⟳</button></h2>
          <ul class="aii-list">
            <template x-for="(p, idx) in fields.people" :key="idx">
              <li class="aii-mention">
                <template x-if="bestMatch('person', idx)">
                  <span>
                    <a class="aii-mention-link" :href="entityHref(bestMatch('person', idx))" x-text="bestMatch('person', idx).ref_label"></a>
                    <small class="aii-mention-orig" x-show="bestMatch('person', idx).ref_label !== p" x-text="'(' + p + ')'"></small>
                    <button type="button" class="aii-rm-btn" @click="unmatch('person', idx)" title="Unmatch">×</button>
                  </span>
                </template>
                <template x-if="!bestMatch('person', idx)">
                  <span>
                    <span class="aii-editable" contenteditable="true"
                          x-text="p"
                          @blur="fields.people[idx] = $event.target.innerText.trim(); saveField('people')"></span>
                    <template x-for="c in candidatesFor('person', idx)" :key="c.id">
                      <button type="button" class="aii-suggest-btn"
                              @click="confirmMatch('person', idx, p, c.ref_type, c.ref_id)"
                              x-text="'→ ' + c.ref_label"></button>
                    </template>
                    <button type="button" class="aii-create-btn" @click="openCreateContact(idx)">Create contact?</button>
                  </span>
                </template>
              </li>
            </template>
            <template x-if="fields.people.length === 0"><li class="aii-editable empty">(none)</li></template>
          </ul>
        </section>

        <section class="aii-section" style="margin:0;">
          <h2>Organizations</h2>
          <ul class="aii-list">
            <template x-for="(o, idx) in fields.organizations" :key="idx">
              <li class="aii-mention">
                <template x-if="bestMatch('organization', idx)">
                  <span>
                    <a class="aii-mention-link" :href="entityHref(bestMatch('organization', idx))" x-text="bestMatch('organization', idx).ref_label"></a>
                    <small class="aii-mention-orig" x-show="bestMatch('organization', idx).ref_label !== o" x-text="'(' + o + ')'"></small>
                    <button type="button" class="aii-rm-btn" @click="unmatch('organization', idx)" title="Unmatch">×</button>
                  </span>
                </template>
                <template x-if="!bestMatch('organization', idx)">
                  <span>
                    <span class="aii-editable" contenteditable="true"
                          x-text="o"
                          @blur="fields.organizations[idx] = $event.target.innerText.trim(); saveField('organizations')"></span>
                    <template x-for="c in candidatesFor('organization', idx)" :key="c.id">
                      <button type="button" class="aii-suggest-btn"
                              @click="confirmMatch('organization', idx, o, c.ref_type, c.ref_id)"
                              x-text="'→ ' + c.ref_label"></button>
                    </template>
                    <button type="button" class="aii-create-btn" @click="openCreateAccount(idx)">Create account?</button>
                  </span>
                </template>
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
            <input class="owner-in" type="text" placeholder="${escape(userName)} (you)" x-model="a.owner" @blur="saveField('action_items')">
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
        <h2>Actions</h2>

        <!-- Already-taken actions -->
        <template x-if="links.length > 0">
          <div class="aii-links">
            <template x-for="link in links" :key="link.id">
              <div class="aii-link-row">
                <span class="aii-link-kind" x-text="destLabels[link.action_type] || link.action_type"></span>
                <a class="aii-link-target" :href="linkHref(link)" x-text="link.ref_label || '(unlabeled)'"></a>
                <button type="button" class="aii-rm-btn" @click="unlink(link.id)" title="Remove link">×</button>
              </div>
            </template>
          </div>
        </template>

        <!-- Suggested action buttons (only those with handlers) -->
        <div class="aii-suggested-actions">
          <template x-for="d in fields.suggested_destinations" :key="d">
            <button type="button"
                    class="aii-action-btn"
                    :class="!isHandled(d) ? 'aii-action-btn-soon' : ''"
                    :disabled="!isHandled(d)"
                    :title="isHandled(d) ? '' : 'Coming soon'"
                    @click="openAction(d)"
                    x-text="destLabels[d] || d"></button>
          </template>
          <template x-if="fields.suggested_destinations.length === 0 && links.length === 0">
            <span class="aii-editable empty">(no suggestions)</span>
          </template>
        </div>

        <!-- Inline form: create_task -->
        <div x-show="actionForm && actionForm.kind === 'create_task'" class="aii-action-form" x-cloak>
          <h3>Create task</h3>
          <label class="aii-form-row">
            <span>Subject</span>
            <input type="text" x-model="actionForm && actionForm.subject" placeholder="Task subject">
          </label>
          <label class="aii-form-row">
            <span>Body</span>
            <textarea rows="3" x-model="actionForm && actionForm.body" placeholder="Notes (optional)"></textarea>
          </label>
          <label class="aii-form-row">
            <span>Due</span>
            <input type="date" x-model="actionForm && actionForm.due_at">
          </label>
          <label class="aii-form-row">
            <span>Account</span>
            <span class="aii-typeahead-wrap">
              <input type="text" x-model="actionForm && actionForm.account_label"
                     placeholder="Type to search… (optional)"
                     @input.debounce.250ms="searchEntities('account', $event.target.value); if (actionForm) actionForm.account_id = ''"
                     @focus="searchEntities('account', actionForm && actionForm.account_label)">
              <ul class="aii-typeahead" x-show="typeahead && typeahead.kind === 'account' && typeahead.results.length > 0" x-cloak>
                <template x-for="r in (typeahead ? typeahead.results : [])" :key="r.ref_id">
                  <li @click="pickAccount(r)">
                    <span x-text="r.label"></span>
                    <small x-text="r.sub" x-show="r.sub"></small>
                  </li>
                </template>
              </ul>
            </span>
          </label>
          <div class="aii-form-actions">
            <button type="button" class="aii-btn aii-btn-primary" @click="submitAction()" :disabled="actionForm && actionForm.busy">Create task</button>
            <button type="button" class="aii-btn" @click="closeAction()">Cancel</button>
            <span x-show="actionForm && actionForm.error" class="aii-err-inline" x-text="actionForm && actionForm.error"></span>
          </div>
        </div>

        <!-- Inline form: link_to_account -->
        <div x-show="actionForm && actionForm.kind === 'link_to_account'" class="aii-action-form" x-cloak>
          <h3>Link to account</h3>
          <label class="aii-form-row">
            <span>Account</span>
            <span class="aii-typeahead-wrap">
              <input type="text" x-model="actionForm && actionForm.account_label"
                     placeholder="Type to search…"
                     @input.debounce.250ms="searchEntities('account', $event.target.value); if (actionForm) actionForm.account_id = ''"
                     @focus="searchEntities('account', actionForm && actionForm.account_label)">
              <ul class="aii-typeahead" x-show="typeahead && typeahead.kind === 'account' && typeahead.results.length > 0" x-cloak>
                <template x-for="r in (typeahead ? typeahead.results : [])" :key="r.ref_id">
                  <li @click="pickAccount(r)">
                    <span x-text="r.label"></span>
                    <small x-text="r.sub" x-show="r.sub"></small>
                  </li>
                </template>
              </ul>
            </span>
          </label>
          <div class="aii-form-actions">
            <button type="button" class="aii-btn aii-btn-primary" @click="submitAction()" :disabled="!(actionForm && actionForm.account_id) || (actionForm && actionForm.busy)">Link</button>
            <button type="button" class="aii-btn" @click="closeAction()">Cancel</button>
            <span x-show="actionForm && actionForm.error" class="aii-err-inline" x-text="actionForm && actionForm.error"></span>
          </div>
        </div>

        <!-- Inline form: create_account -->
        <div x-show="actionForm && actionForm.kind === 'create_account'" class="aii-action-form" x-cloak>
          <h3>Create account</h3>
          <label class="aii-form-row">
            <span>Name</span>
            <input type="text" x-model="actionForm && actionForm.name" placeholder="Account name">
          </label>
          <label class="aii-form-row">
            <span>Alias</span>
            <input type="text" x-model="actionForm && actionForm.alias" placeholder="Short name (optional)">
          </label>
          <label class="aii-form-row">
            <span>Segment</span>
            <input type="text" x-model="actionForm && actionForm.segment" placeholder="(optional)">
          </label>
          <div class="aii-form-actions">
            <button type="button" class="aii-btn aii-btn-primary" @click="submitCreateAccount()" :disabled="actionForm && actionForm.busy">Create account</button>
            <button type="button" class="aii-btn" @click="closeAction()">Cancel</button>
            <span x-show="actionForm && actionForm.error" class="aii-err-inline" x-text="actionForm && actionForm.error"></span>
          </div>
        </div>

        <!-- Inline form: create_contact -->
        <div x-show="actionForm && actionForm.kind === 'create_contact'" class="aii-action-form" x-cloak>
          <h3>Create contact</h3>
          <label class="aii-form-row">
            <span>First name</span>
            <input type="text" x-model="actionForm && actionForm.first_name">
          </label>
          <label class="aii-form-row">
            <span>Last name</span>
            <input type="text" x-model="actionForm && actionForm.last_name">
          </label>
          <label class="aii-form-row">
            <span>Email</span>
            <input type="email" x-model="actionForm && actionForm.email">
          </label>
          <label class="aii-form-row">
            <span>Title</span>
            <input type="text" x-model="actionForm && actionForm.title">
          </label>
          <label class="aii-form-row">
            <span>Phone</span>
            <input type="text" x-model="actionForm && actionForm.phone">
          </label>
          <label class="aii-form-row">
            <span>Account</span>
            <span class="aii-typeahead-wrap">
              <input type="text" x-model="actionForm && actionForm.account_label"
                     placeholder="Type to search…"
                     @input.debounce.250ms="searchEntities('account', $event.target.value); if (actionForm) actionForm.account_id = ''"
                     @focus="searchEntities('account', actionForm && actionForm.account_label)">
              <ul class="aii-typeahead" x-show="typeahead && typeahead.kind === 'account' && typeahead.results.length > 0" x-cloak>
                <template x-for="r in (typeahead ? typeahead.results : [])" :key="r.ref_id">
                  <li @click="pickAccount(r)">
                    <span x-text="r.label"></span>
                    <small x-text="r.sub" x-show="r.sub"></small>
                  </li>
                </template>
              </ul>
            </span>
          </label>
          <div class="aii-form-actions">
            <button type="button" class="aii-btn aii-btn-primary" @click="submitCreateContact()" :disabled="actionForm && actionForm.busy">Create contact</button>
            <button type="button" class="aii-btn" @click="closeAction()">Cancel</button>
            <span x-show="actionForm && actionForm.error" class="aii-err-inline" x-text="actionForm && actionForm.error"></span>
          </div>
        </div>
      </section>

      <div class="aii-meta" style="margin-top:.5rem;">
        Confidence: <span x-text="fields.confidence"></span>
      </div>
    </section>
  `;
}

// v3: Render the attachments panel. Each attachment is a row with:
//   - Kind icon + filename + size + status pill
//   - Audio player (only for kind='audio' with an r2_key)
//   - "Primary" star indicator
//   - Expandable captured_text view
// Phase B: read-only. Add/reorder/toggle controls land in Phase C/D.
function renderAttachments({ item, attachments }) {
  if (!attachments || attachments.length === 0) {
    return html`<section class="aii-section">
      <h2>Attachments</h2>
      <p class="aii-meta">No attachments. (This shouldn't happen — every entry should have at least one.)</p>
    </section>`;
  }

  const rows = attachments.map((a) => {
    const kindLabel = ATTACHMENT_KIND_LABELS[a.kind] || a.kind;
    const statusColor = ATTACHMENT_STATUS_COLORS[a.status] || '#888';
    const statusLabel = ATTACHMENT_STATUS_LABELS[a.status] || a.status;
    const primaryBadge = a.is_primary
      ? html`<span class="aii-att-primary" title="Primary attachment">★</span>`
      : '';
    const includeBadge = a.include_in_context === 0
      ? html`<span class="aii-att-excluded" title="Not included in compiled context">excluded</span>`
      : '';
    const metaParts = [
      a.filename || '(no filename)',
      a.size_bytes ? formatSize(a.size_bytes) : null,
      a.captured_text_model ? `via ${a.captured_text_model}` : null,
    ].filter(Boolean);

    const player = (a.kind === 'audio' && a.r2_key)
      ? html`<audio class="aii-audio" controls preload="metadata"
              src="/ai-inbox/${escape(item.id)}/audio"></audio>`
      : '';

    const errorBlock = (a.status === 'error' && a.error_message)
      ? html`<div class="aii-err" style="margin-top:.4rem;font-size:.8rem;">${escape(a.error_message)}</div>`
      : '';

    const capturedBlock = a.captured_text
      ? html`<details class="aii-att-captured">
          <summary>Captured text</summary>
          <div class="aii-transcript" style="margin-top:.4rem;">${escape(a.captured_text)}</div>
        </details>`
      : '';

    return html`<div class="aii-att-row">
      <div class="aii-att-head">
        <span class="aii-att-kind">${escape(kindLabel)}</span>
        ${primaryBadge}
        <span class="aii-att-meta">${metaParts.join(' · ')}</span>
        ${includeBadge}
        <span class="status-pill" style="background:${escape(statusColor)};">${escape(statusLabel)}</span>
      </div>
      ${player}
      ${errorBlock}
      ${capturedBlock}
    </div>`;
  });

  return html`<section class="aii-section">
    <h2>Attachments</h2>
    <div class="aii-att-list">${rows}</div>
  </section>`;
}

const ATTACHMENT_KIND_LABELS = {
  audio: 'Audio',
  text: 'Text',
  document: 'Document',
  email: 'Email',
  image: 'Image',
};

const ATTACHMENT_STATUS_LABELS = {
  pending: 'pending',
  processing: 'processing',
  ready: 'ready',
  error: 'error',
};

const ATTACHMENT_STATUS_COLORS = {
  pending: '#888',
  processing: '#1f6feb',
  ready: '#1a7f37',
  error: '#cf222e',
};

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
