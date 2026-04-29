// functions/ai-inbox/[id]/index.js
//
// GET /ai-inbox/:id
//
// Detail page: audio player, status, transcript, and extracted fields.
// Extracted fields are inline-editable via Alpine.js — click a field
// to edit, blur or Enter to save (POST /ai-inbox/:id/edit).

import { one, all } from '../../lib/db.js';
import { layout, html, escape, htmlResponse, raw } from '../../lib/layout.js';
import { readFlash } from '../../lib/http.js';
import { ICON_MIC, ICON_CAMERA, ICON_KEYBOARD, ICON_PAPERCLIP } from '../../lib/icons.js';

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
    // Links + parent_opportunity_id for quote links (so the client
    // can build the nested /opportunities/<opp>/quotes/<quote> URL).
    all(env.DB,
      `SELECT l.id, l.action_type, l.ref_type, l.ref_id, l.ref_label, l.created_at,
              q.opportunity_id AS parent_opportunity_id
         FROM ai_inbox_links l
         LEFT JOIN quotes q ON q.id = l.ref_id AND l.ref_type = 'quote'
        WHERE l.item_id = ?
        ORDER BY l.created_at DESC`,
      [params.id]),
    // v3 push-aware enrichment: pull each match together with the
    // current values of the fields a user might push onto it
    // (target_email / target_phone / target_mobile / target_title).
    // The Alpine UI uses these to hide the "↑ push" button when the
    // captured value already matches what's on the target row, so we
    // don't tempt the user to make a redundant write.
    all(env.DB,
      `SELECT m.id, m.mention_kind, m.mention_text, m.mention_idx,
              m.ref_type, m.ref_id, m.ref_label, m.score, m.rank,
              m.auto_resolved, m.user_overridden,
              CASE m.ref_type
                WHEN 'contact'     THEN c.email
                WHEN 'account'     THEN a.email
              END AS target_email,
              CASE m.ref_type
                WHEN 'contact'     THEN c.phone
                WHEN 'account'     THEN a.phone
              END AS target_phone,
              CASE m.ref_type
                WHEN 'contact'     THEN c.mobile
              END AS target_mobile,
              CASE m.ref_type
                WHEN 'contact'     THEN c.title
              END AS target_title,
              CASE m.ref_type
                WHEN 'contact'     THEN c.linkedin_url
              END AS target_linkedin,
              CASE m.ref_type
                WHEN 'contact'     THEN c.linkedin_url_source
              END AS target_linkedin_source
         FROM ai_inbox_entity_matches m
         LEFT JOIN contacts c ON c.id = m.ref_id AND m.ref_type = 'contact'
         LEFT JOIN accounts a ON a.id = m.ref_id AND m.ref_type = 'account'
        WHERE m.item_id = ?
        ORDER BY m.mention_kind, m.mention_idx, m.rank`,
      [params.id]),
    all(env.DB,
      `SELECT id, kind, sort_order, is_primary, include_in_context,
              r2_key, mime_type, size_bytes, filename,
              captured_text, captured_text_model, status, error_message,
              answers_question, created_at
         FROM ai_inbox_attachments WHERE entry_id = ?
        ORDER BY sort_order, created_at`,
      [params.id]),
  ]);

  const body = renderDetail({ item, extracted, links, matches, user, attachments });
  return htmlResponse(layout('AI Inbox · Item', body, { user, flash }));
}

function renderDetail({ item, extracted, links, matches, user, attachments }) {
  const statusLabel = STATUS_LABELS[item.status] || item.status;
  const statusColor = STATUS_COLORS[item.status] || '#888';
  const ctxLabel = item.context_type ? (CONTEXT_TYPE_LABELS[item.context_type] || item.context_type) : null;
  const created = formatDate(item.created_at);

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
      .aii-attachments-head { display: flex; justify-content: space-between; align-items: center; gap: .75rem; margin-bottom: .35rem; }
      .aii-attachments-head h2 { margin: 0; }

      /* Persistent drop panel (compact variant for the entry detail
         page; matches the larger one on /ai-inbox). */
      .ai-inbox-droppanel.ai-inbox-droppanel-compact {
        margin: .5rem 0; border: 2px dashed #b8c1d6; border-radius: 6px;
        background: #fafbff; cursor: pointer; transition: border-color .15s, background .15s;
        position: relative;
      }
      .ai-inbox-droppanel.ai-inbox-droppanel-compact.dz-active { border-color: #1f6feb; background: #e6efff; border-style: solid; }
      .ai-inbox-droppanel.ai-inbox-droppanel-compact.dz-busy { opacity: .7; cursor: wait; }
      .ai-inbox-droppanel.ai-inbox-droppanel-compact input[type="file"] {
        position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer;
      }
      .ai-inbox-droppanel.ai-inbox-droppanel-compact.dz-busy input[type="file"] { pointer-events: none; }
      .ai-inbox-droppanel.ai-inbox-droppanel-compact .dz-big-content { padding: .85rem 1rem; text-align: center; pointer-events: none; }
      .ai-inbox-droppanel.ai-inbox-droppanel-compact .dz-big-icon { font-size: 1.2rem; color: #5a6e96; margin-bottom: .15rem; }
      .ai-inbox-droppanel.ai-inbox-droppanel-compact .dz-big-title { font-size: .9rem; font-weight: 600; color: #2c3a55; }
      .ai-inbox-droppanel.ai-inbox-droppanel-compact .dz-big-hint { font-size: .75rem; color: #666; margin-top: .2rem; }
      .ai-inbox-droppanel.ai-inbox-droppanel-compact .dz-big-status { font-size: .8rem; color: #1f6feb; margin-top: .35rem; min-height: 1em; }
      .aii-att-add { margin-top: .75rem; padding: .85rem; border: 1px solid #e1e4e8; border-radius: 4px; background: #fafbfc; }
      .aii-att-add-row { display: flex; gap: .75rem; align-items: center; flex-wrap: wrap; margin-bottom: .5rem; }
      .aii-att-add-row label { display: flex; align-items: center; gap: .35rem; font-size: .85rem; }
      .aii-att-add-row select { padding: .25rem .4rem; border: 1px solid #ccd; border-radius: 3px; font-size: .85rem; }
      .aii-att-textarea { width: 100%; padding: .5rem .65rem; border: 1px solid #ccd; border-radius: 4px; font-family: inherit; font-size: .9rem; box-sizing: border-box; min-height: 6rem; }
      .aii-att-row .aii-rm-btn { margin-left: auto; }
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
      .aii-action { display: grid; grid-template-columns: 1fr auto auto auto auto; gap: .4rem; align-items: center; padding: .35rem .5rem; border: 1px solid #eee; border-radius: 4px; background: #fafafa; }
      .aii-apply-btn { padding: .25rem .65rem; border: 1px solid #c8d4ff; background: #f0f4ff; color: #2451b8; border-radius: 3px; font-size: .75rem; cursor: pointer; }
      .aii-apply-btn:hover:not(:disabled) { background: #dbe5ff; }
      .aii-apply-btn:disabled { opacity: .45; cursor: not-allowed; }
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
      .aii-action-btn-suggested { box-shadow: 0 0 0 1px #f0c000 inset; }
      .aii-action-btn-suggested:hover { background: #fff5cc; }
      .aii-action-btn-soon { opacity: .55; cursor: not-allowed; }
      .aii-action-btn-soon:hover { background: #f0f4ff; }
      .aii-action-suggested-mark { color: #d4a017; margin-left: .25rem; }

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

      .aii-mention { display: flex; flex-direction: column; gap: .15rem; padding: .35rem .5rem; }
      .aii-mention + .aii-mention { border-top: 1px dashed #eef; }
      .aii-mention-head { display: flex; align-items: center; gap: .35rem; flex-wrap: wrap; }
      .aii-mention-link { color: #1f6feb; text-decoration: none; font-weight: 500; }
      .aii-mention-link:hover { text-decoration: underline; }
      .aii-mention-orig { color: #999; font-size: .75rem; }
      .aii-mention-detail { display: flex; flex-wrap: wrap; gap: .15rem .85rem; padding-left: .15rem; font-size: .8rem; color: #444; }
      .aii-detail-row { white-space: nowrap; }
      .aii-detail-row strong { color: #888; font-weight: 500; margin-right: .25rem; font-size: .7rem; text-transform: uppercase; letter-spacing: .04em; }
      .aii-detail-row a { color: #1f6feb; text-decoration: none; }
      .aii-detail-row a:hover { text-decoration: underline; }
      .aii-push-btn { padding: .05rem .35rem; border: 1px solid #c8d4ff; background: #f0f4ff; color: #2451b8; border-radius: 3px; font-size: .65rem; cursor: pointer; margin-left: .35rem; vertical-align: middle; }
      .aii-push-btn:hover { background: #dbe5ff; }
      .aii-push-done { color: #1a7f37; font-weight: 600; margin-left: .35rem; }
      .aii-suggest-btn { padding: .15rem .55rem; border: 1px solid #c8d4ff; background: #f0f4ff; color: #2451b8; border-radius: 3px; font-size: .75rem; cursor: pointer; }
      .aii-suggest-btn:hover { background: #dbe5ff; }
      .aii-create-btn { padding: .15rem .55rem; border: 1px dashed #c8d4ff; background: white; color: #555; border-radius: 3px; font-size: .75rem; cursor: pointer; }
      .aii-create-btn:hover { background: #f6f8ff; color: #1f6feb; }

      [x-cloak] { display: none !important; }


      .flash { padding: .65rem .9rem; border-radius: 4px; margin-bottom: 1rem; }
      .flash-success { background: #d4ecdb; color: #1a3d24; }
      .flash-error { background: #fadddd; color: #6a1a20; }

      /* Capture bar status / inline label */
      .aii-capture-status { font-size: .8rem; color: #1f6feb; flex: 1 1 100%; text-align: center; min-height: 1em; }

      /* Open questions: each item has a row (text + Answer button)
         then an expandable answer panel with three input modes. */
      .aii-q-list .aii-q-item { padding: .35rem .5rem; }
      .aii-q-list .aii-q-item + .aii-q-item { border-top: 1px dashed #eef; }
      .aii-q-row { display: flex; gap: .5rem; align-items: flex-start; flex-wrap: wrap; }
      .aii-q-row .aii-editable { flex: 1 1 auto; min-width: 10rem; }
      .aii-q-answer-btn { padding: .15rem .55rem; border: 1px solid #c8d4ff; background: #f0f4ff; color: #2451b8; border-radius: 3px; font-size: .75rem; cursor: pointer; align-self: center; }
      .aii-q-answer-btn:hover { background: #dbe5ff; }
      .aii-q-answer-panel { margin-top: .5rem; padding: .65rem .75rem; background: #fafbfc; border: 1px solid #e1e4e8; border-radius: 4px; }
      .aii-q-answer-actions { display: flex; flex-wrap: wrap; gap: .35rem; align-items: center; }
      .aii-q-answer-status { font-size: .8rem; color: #1f6feb; margin-top: .35rem; }

      /* Attachment "answers" badge */
      .aii-att-answers { font-size: .75rem; color: #1a7f37; background: #eef5e6; padding: .15rem .5rem; border-radius: 3px; margin-top: .25rem; display: inline-block; }

      /* ---------- Mobile (≤ 640px) ---------- */
      @media (max-width: 640px) {
        .aii-wrap { padding: 1rem .75rem; }

        /* Action items: stack inputs full-width instead of squeezing
           into a 5-column grid. The remove + apply buttons share a
           row at the bottom of each item. */
        .aii-action {
          grid-template-columns: 1fr;
          gap: .35rem;
        }
        .aii-action .task-in,
        .aii-action .owner-in,
        .aii-action .due-in {
          width: 100%;
        }
        .aii-action .aii-apply-btn,
        .aii-action .aii-rm-btn {
          justify-self: end;
        }
        .aii-action .aii-apply-btn { width: auto; }

        /* Form rows in inline create-task / link-account / wizard
           launchers: stack the label above the input so the input has
           full width to type into. */
        .aii-form-row {
          grid-template-columns: 1fr;
          gap: .15rem;
        }
        .aii-form-row > span {
          font-size: .7rem;
          color: #888;
          text-transform: uppercase;
          letter-spacing: .04em;
        }

        /* Bigger touch targets on the inline-edit fields and the
           little actions next to mentions. iOS HIG min is 44px. */
        .aii-editable { padding: .5rem .55rem; min-height: 1.5rem; }
        .aii-rm-btn,
        .aii-add-btn,
        .aii-suggest-btn,
        .aii-create-btn,
        .aii-action-btn,
        .aii-push-btn { min-height: 36px; padding: .35rem .65rem; }

        /* Mentions: drop side-by-side detail pairs to one per line so
           a long email/phone doesn't run off the screen. */
        .aii-mention-detail { flex-direction: column; gap: .15rem; }
        .aii-detail-row { white-space: normal; }

        /* Apply / Cancel button rows wrap nicely. */
        .aii-form-actions { flex-wrap: wrap; }
        .aii-form-actions .aii-btn { flex: 1 1 calc(50% - .25rem); min-width: 0; }
      }
    </style>

    <div class="aii-wrap">
      <a class="aii-back" href="/ai-inbox">← Back to AI Inbox</a>

      <div class="aii-head" style="display:flex;align-items:center;gap:.6rem;flex-wrap:wrap">
        <span class="status-pill" style="background:${escape(statusColor)};">${escape(statusLabel)}</span>
        ${ctxLabel ? html`<span class="ctx-pill">${escape(ctxLabel)}</span>` : ''}
        <span>${escape(created)}</span>
        <form method="post" action="/ai-inbox/${escape(item.id)}/delete"
              style="margin-left:auto;display:inline"
              onsubmit="return confirm('Delete this AI Inbox entry? This removes the captured files and any extracted info. This cannot be undone.');">
          <button type="submit" class="btn btn-sm danger">Delete entry</button>
        </form>
      </div>

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
            people_detail: [], organizations_detail: [],
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
          // Action types we have a form for; others render as
          // greyed-out coming-soon buttons.
          handledActions: ['create_task', 'link_to_account', 'link_to_opportunity', 'link_to_quote'],
          // Always-visible action buttons (regardless of which ones the
          // LLM listed in suggested_destinations). The LLM's suggestions
          // get a small "suggested" indicator but every handled action
          // is reachable from the entry, always.
          allActions: ['create_task', 'link_to_account', 'link_to_opportunity', 'link_to_quote'],
          destLabels: {
            keep_as_note: 'Keep as note',
            create_task: 'Create task',
            create_reminder: 'Create reminder',
            link_to_account: 'Link to account',
            link_to_opportunity: 'Link to opportunity',
            link_to_quote: 'Link to quote',
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

          // ----- v2/v3: actions -----
          isHandled(kind) { return this.handledActions.indexOf(kind) >= 0; },
          isSuggested(kind) {
            return (this.fields.suggested_destinations || []).indexOf(kind) >= 0;
          },

          // ----- v3 answer-an-open-question -----
          // Click the "↳ Answer" button next to an open question and
          // pick how to answer it: record audio, type text, or attach
          // a file. Each path turns into an attachment on this entry
          // (so the question + answer become part of the next
          // re-extraction round). The page reloads after upload to
          // pick up the new attachment + the resulting extraction.
          answerPanel: null,

          openAnswer(idx) {
            this.answerPanel = {
              idx,
              mode: null,         // null | 'text'
              text: '',
              busy: false,
              error: '',
              status: '',
            };
          },
          closeAnswer() { this.answerPanel = null; },

          // The shared upload helper used by all three modes. The
          // server route already accepts kind='auto', so files (audio,
          // pdf, image, etc.) auto-route to the right processor.
          // Passes reextract=1 so the new question/answer pair feeds
          // the next extraction. The captured_text on the new
          // attachment carries the question header so the LLM has the
          // explicit Q/A pairing in compiled context.
          async _uploadAnswer(idx, formExtras, statusText) {
            if (!this.answerPanel) return;
            const q = (this.fields.open_questions || [])[idx] || '';
            this.answerPanel.busy = true;
            this.answerPanel.error = '';
            this.answerPanel.status = statusText || 'Uploading…';
            try {
              const fd = new FormData();
              for (const [k, v] of Object.entries(formExtras || {})) fd.append(k, v);
              fd.append('reextract', '1');
              fd.append('answers_question', q);
              const res = await fetch('/ai-inbox/' + encodeURIComponent(this.itemId) + '/attachments/add', {
                method: 'POST', credentials: 'same-origin', body: fd,
              });
              const j = await res.json();
              if (!j.ok) throw new Error(j.error || 'failed');
              this.answerPanel.status = 'Saved. Reloading…';
              window.location.reload();
            } catch (e) {
              this.answerPanel.busy = false;
              this.answerPanel.error = String(e.message || e);
              this.answerPanel.status = '';
            }
          },

          async submitAnswerText(idx) {
            if (!this.answerPanel || !this.answerPanel.text.trim()) return;
            await this._uploadAnswer(idx, {
              kind: 'text',
              text: this.answerPanel.text,
            }, 'Saving answer…');
          },

          answerByRecording(idx) {
            if (!window.PipelineAudioRecorder || typeof window.PipelineAudioRecorder.open !== 'function') {
              alert('Audio recorder is not available on this page.');
              return;
            }
            window.PipelineAudioRecorder.open((file) => {
              this._uploadAnswer(idx, {
                kind: 'auto',
                file: file,
              }, 'Uploading recording…');
            });
          },

          answerByFile(idx, btnEl) {
            const input = btnEl.parentElement.querySelector('[data-aii-q-file]');
            if (!input) return;
            // Reset the input so picking the same file twice still fires.
            input.value = '';
            const handler = () => {
              input.removeEventListener('change', handler);
              if (input.files && input.files[0]) {
                this._uploadAnswer(idx, {
                  kind: 'auto',
                  file: input.files[0],
                }, 'Uploading file…');
              }
            };
            input.addEventListener('change', handler);
            input.click();
          },

          // ----- v3 push: send captured contact details onto the
          // matched CRM entity (one click per field). -----
          //
          // pushedFields tracks "field X on this mention has been
          // pushed already" so the UI can show a checkmark and disable
          // the button after the click. Keyed by '<kind>:<idx>:<field>'.
          pushedFields: {},
          pushKey(kind, idx, field) { return kind + ':' + idx + ':' + field; },
          isPushed(kind, idx, field) { return !!this.pushedFields[this.pushKey(kind, idx, field)]; },

          // Should we show the "↑ push" button at all? Three reasons
          // we'd hide it:
          //   1. No matched CRM target.
          //   2. We already pushed this field this session (button
          //      flipped to ✓).
          //   3. The target already holds the same value we'd push,
          //      so the click would be a no-op.
          shouldShowPush(kind, idx, field) {
            const detail = this.detailFor(kind, idx);
            const match = this.bestMatch(kind, idx);
            if (!detail || !match) return false;
            if (this.isPushed(kind, idx, field)) return false;
            const captured = (detail[field] || '').trim();
            if (!captured) return false;
            const existing = (match['target_' + field] || '').trim();
            if (!existing) return true;  // empty target — definitely worth pushing
            return !this.valuesMatch(field, captured, existing);
          },

          // Equality with field-specific normalization.
          //   - Phones: strip non-digits, then compare. If either side
          //     has a US-shape "1" prefix making it 11 digits, drop
          //     the "1" so "+1.555.987.6543" matches "555-987-6543".
          //   - Emails: case-insensitive.
          //   - Everything else: straight equality after trim.
          valuesMatch(field, a, b) {
            if (field === 'phone' || field === 'mobile') {
              const norm = (s) => {
                let d = s.replace(/\\D+/g, '');
                if (d.length === 11 && d[0] === '1') d = d.slice(1);
                return d;
              };
              return norm(a) === norm(b);
            }
            if (field === 'email') {
              return a.toLowerCase() === b.toLowerCase();
            }
            if (field === 'linkedin') {
              // Mirror the server-side normalizer: lowercase, strip
              // protocol + www./m. + trailing slash + query/fragment.
              const norm = (s) => {
                let v = s.toLowerCase().trim();
                v = v.replace(/^https?:\\/\\//, '');
                v = v.replace(/^(www\\.|m\\.)/, '');
                v = v.split('?')[0].split('#')[0];
                v = v.replace(/\\/+$/, '');
                return v;
              };
              return norm(a) === norm(b);
            }
            return a === b;
          },

          async pushDetail(kind, idx, field) {
            const detail = this.detailFor(kind, idx);
            const match = this.bestMatch(kind, idx);
            if (!detail || !match) return;
            const value = detail[field];
            if (!value) return;

            const refType = match.ref_type;
            const refId = match.ref_id;
            const url = '/ai-inbox/' + encodeURIComponent(this.itemId) + '/push/' + field;
            const body = { ref_type: refType, ref_id: refId };
            body[field] = value;

            const doPost = async (force) => {
              if (force) body.force = true;
              const res = await fetch(url, {
                method: 'POST', credentials: 'same-origin',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
              });
              return { status: res.status, json: await res.json() };
            };

            try {
              const r1 = await doPost(false);
              if (r1.json.ok) {
                this.recordPushSuccess(kind, idx, field, r1.json);
                return;
              }
              if (r1.status === 409 && r1.json.error && r1.json.error.endsWith('_already_set')) {
                const existing = r1.json.existing || '(empty)';
                const ok = confirm(
                  'The ' + field + ' on this contact is already set to:\\n\\n  ' + existing +
                  '\\n\\nReplace with:\\n\\n  ' + value + '\\n\\nProceed?'
                );
                if (!ok) return;
                const r2 = await doPost(true);
                if (r2.json.ok) {
                  this.recordPushSuccess(kind, idx, field, r2.json);
                  return;
                }
                alert('Could not push: ' + (r2.json.error || 'unknown'));
                return;
              }
              alert('Could not push ' + field + ': ' + (r1.json.error || 'unknown'));
            } catch (e) {
              alert('Push failed: ' + (e.message || e));
            }
          },

          recordPushSuccess(kind, idx, field, response) {
            this.pushedFields[this.pushKey(kind, idx, field)] = {
              at: new Date().toISOString(),
              value: response.value || '',
            };
            // Update the in-memory match row's target_<field> so
            // shouldShowPush starts returning false for this row even
            // before a page reload. Without this, the button would
            // stay hidden via isPushed but a re-render or matches
            // refresh might bring it back briefly.
            const match = this.bestMatch(kind, idx);
            if (match && response.value) {
              match['target_' + field] = response.value;
            }
            if (response.links?.associate) {
              this.links = [response.links.associate, ...this.links];
            }
            if (response.links?.push) {
              this.links = [response.links.push, ...this.links];
            }
          },

          // Look up the rich-shape detail row for a person or org
          // mention, if the LLM captured one. Used to surface a
          // person's title/phone/email or an org's phone/website
          // directly under the mention name.
          detailFor(kind, idx) {
            if (kind === 'person') {
              const name = (this.fields.people || [])[idx];
              if (!name) return null;
              return (this.fields.people_detail || []).find((d) => d.name === name) || null;
            }
            if (kind === 'organization') {
              const name = (this.fields.organizations || [])[idx];
              if (!name) return null;
              return (this.fields.organizations_detail || []).find((d) => d.name === name) || null;
            }
            return null;
          },
          hasAnyDetail(kind, idx) {
            const d = this.detailFor(kind, idx);
            if (!d) return false;
            return !!(d.title || d.email || d.phone || d.linkedin || d.website || d.address || d.organization);
          },

          // v3: init() runs once when Alpine instantiates the component.
          // Registers the wizard-success listener that records matches /
          // links after an in-context-create wizard completes.
          init() {
            window.addEventListener('pipeline:wizard-success', this.onWizardSuccess.bind(this));
          },

          openAction(kind) {
            if (!this.isHandled(kind)) return;
            const accountId = this.preferredAccountId();
            const accountLabel = this.preferredAccountLabel();
            if (kind === 'create_task') {
              // v3: open the existing task wizard rather than an inline
              // form. After the wizard creates the activity, our
              // pipeline:wizard-success listener records the link.
              const firstAction = (this.fields.action_items || [])[0];
              const summaryFirst = ((this.fields.summary || '').split(/\\r?\\n/)[0] || '').slice(0, 80);
              const body = (firstAction && firstAction.task)
                || summaryFirst
                || this.fields.summary
                || this.fields.title
                || '';
              this.openTaskWizard({
                body,
                due_at: (firstAction && firstAction.due) || '',
                account_id: accountId,
                account_label: accountLabel,
                source_action_idx: -1,  // -1 means "from suggested_destinations, not from a specific action item row"
              });
              return;
            } else if (kind === 'link_to_account') {
              this.actionForm = {
                kind, busy: false, error: '',
                account_id: accountId,
                account_label: accountLabel,
              };
            } else if (kind === 'link_to_opportunity') {
              this.actionForm = {
                kind, busy: false, error: '',
                opportunity_id: '',
                opportunity_label: '',
              };
              // Pre-fetch a few opportunities — scoped to the resolved
              // org if any, otherwise the most-recent active opps. Gives
              // the user something to click without having to type.
              this.searchEntities('opportunity', '', accountId);
            } else if (kind === 'link_to_quote') {
              this.actionForm = {
                kind, busy: false, error: '',
                quote_id: '',
                quote_label: '',
              };
              // Scope the initial picker to the entry's resolved opp
              // first (most relevant), falling back to the resolved
              // org. Empty query returns the N most-recently-updated
              // active quotes that match the scope.
              const oppId = this.preferredOpportunityId();
              this.searchEntities('quote', '', oppId || accountId);
            }
          },
          closeAction() { this.actionForm = null; this.typeahead = null; },

          // Map an action kind to its route path. Route filenames use
          // a shorter form (link-account.js) than the action_type
          // strings stored in ai_inbox_links (link_to_account), so a
          // naive _ → - replace would point at the wrong URL.
          actionRoutePath(kind) {
            const map = {
              create_task: 'create-task',
              link_to_account: 'link-account',
              link_to_opportunity: 'link-opportunity',
              link_to_quote: 'link-quote',
            };
            return map[kind] || kind.replace(/_/g, '-');
          },

          async submitAction() {
            if (!this.actionForm) return;
            const f = this.actionForm;
            f.busy = true; f.error = '';
            const path = this.actionRoutePath(f.kind);
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
              } else if (f.kind === 'link_to_opportunity') {
                payload.opportunity_id = f.opportunity_id || '';
                if (!payload.opportunity_id) { f.busy = false; f.error = 'Pick an opportunity first.'; return; }
              } else if (f.kind === 'link_to_quote') {
                payload.quote_id = f.quote_id || '';
                if (!payload.quote_id) { f.busy = false; f.error = 'Pick a quote first.'; return; }
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

          // ----- v2/v3: typeahead -----
          async searchEntities(kind, q, accountId) {
            this.typeahead = { kind, q, results: [], loading: true };
            const params = new URLSearchParams();
            if (q) params.set('q', q);
            if (accountId) params.set('account_id', accountId);
            const path = kind === 'account' ? '/ai-inbox/_search/accounts'
                       : kind === 'contact' ? '/ai-inbox/_search/contacts'
                       : kind === 'opportunity' ? '/ai-inbox/_search/opportunities'
                       : kind === 'quote' ? '/ai-inbox/_search/quotes'
                       : null;
            if (!path) {
              this.typeahead.loading = false;
              return;
            }
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
          pickOpportunity(r) {
            if (!this.actionForm) return;
            this.actionForm.opportunity_id = r.ref_id;
            this.actionForm.opportunity_label = (r.sub ? (r.label + ' — ' + r.sub) : r.label);
            this.typeahead = null;
          },
          pickQuote(r) {
            if (!this.actionForm) return;
            this.actionForm.quote_id = r.ref_id;
            this.actionForm.quote_label = (r.sub ? (r.label + ' — ' + r.sub) : r.label);
            this.typeahead = null;
          },
          clearTypeahead() { this.typeahead = null; },

          // ----- v3: open wizards from inline link forms -----
          // "New account" / "New opportunity" buttons inside the
          // inline link forms launch the existing wizards. After a
          // successful submit, the pipeline:wizard-success listener
          // (registered in init()) records the link.
          openAccountWizardForLink() {
            if (!window.Pipeline || typeof window.Pipeline.openWizard !== 'function') {
              alert('Wizard system is not available on this page.');
              return;
            }
            const seed = (this.actionForm && this.actionForm.account_label) || '';
            // Close the inline form so the wizard isn't fighting it visually.
            this.closeAction();
            window.Pipeline.openWizard('account', {
              name: seed,
              __on_success: 'pipeline:wizard-success',
              __ai_inbox: {
                source: 'link_to_account_via_create',
                entry_id: this.itemId,
              },
            });
          },
          openOpportunityWizardForLink() {
            if (!window.Pipeline || typeof window.Pipeline.openWizard !== 'function') {
              alert('Wizard system is not available on this page.');
              return;
            }
            this.closeAction();
            const accountId = this.preferredAccountId();
            const accountLabel = this.preferredAccountLabel();
            // Title hint from the entry summary or title — gives the
            // user something to confirm or edit instead of starting blank.
            const titleSeed = this.fields.title || ((this.fields.summary || '').split(/\\r?\\n/)[0] || '').slice(0, 80);
            window.Pipeline.openWizard('opportunity', {
              title: titleSeed,
              account_id: accountId,
              account_label: accountLabel,
              __on_success: 'pipeline:wizard-success',
              __ai_inbox: {
                source: 'link_to_opportunity_via_create',
                entry_id: this.itemId,
              },
            });
          },

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
            if (l.ref_type === 'quote') {
              if (l.parent_opportunity_id) {
                return '/opportunities/' + encodeURIComponent(l.parent_opportunity_id)
                  + '/quotes/' + encodeURIComponent(l.ref_id);
              }
              // Quote was deleted or its parent opp is missing —
              // there's no per-quote URL, so fall back to /opportunities.
              return '/opportunities';
            }
            if (l.ref_type === 'job') return '/jobs/' + encodeURIComponent(l.ref_id);
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

          // ----- v3: in-context create via existing wizards -----
          // openCreateAccount / openCreateContact / openTaskWizard each
          // launch the registered Pipeline wizard with prefill that
          // tells our pipeline:wizard-success listener what to do
          // after the wizard's POST returns. The wizard suppresses its
          // default redirect because of __on_success.
          openCreateAccount(idx) {
            if (!window.Pipeline || typeof window.Pipeline.openWizard !== 'function') {
              alert('Wizard system is not available on this page.');
              return;
            }
            const mention = (this.fields.organizations || [])[idx] || '';
            window.Pipeline.openWizard('account', {
              name: mention,
              __on_success: 'pipeline:wizard-success',
              __ai_inbox: {
                source: 'create_account',
                entry_id: this.itemId,
                mention_kind: 'organization',
                mention_idx: idx,
                mention_text: mention,
              },
            });
          },
          openCreateContact(idx) {
            if (!window.Pipeline || typeof window.Pipeline.openWizard !== 'function') {
              alert('Wizard system is not available on this page.');
              return;
            }
            const mention = (this.fields.people || [])[idx] || '';
            const tokens = (mention || '').trim().split(/\\s+/);
            const first = tokens[0] || '';
            const last = tokens.length > 1 ? tokens[tokens.length - 1] : '';

            // Pull the rich-shape detail row (captured title/email/
            // phone/organization from the LLM) so we can prefill the
            // wizard with the card data instead of making the user
            // re-type it.
            const detail = this.detailFor('person', idx) || {};
            const carriedFields = {
              first_name: first,
              last_name: last,
              title: detail.title || '',
              email: detail.email || '',
              // contacts.phone not exposed on the contact wizard but
              // we'll push it onto the contact after creation if the
              // card had one.
            };

            const resolvedAccountId = this.preferredAccountId();
            const resolvedAccountLabel = this.preferredAccountLabel();

            // Case 1: the org is already matched to an existing
            // account. Open the contact wizard with the account
            // step locked.
            if (resolvedAccountId) {
              window.Pipeline.openWizard('contact', {
                ...carriedFields,
                account_id: resolvedAccountId,
                account_label: resolvedAccountLabel,
                __on_success: 'pipeline:wizard-success',
                __ai_inbox: {
                  source: 'create_contact',
                  entry_id: this.itemId,
                  mention_kind: 'person',
                  mention_idx: idx,
                  mention_text: mention,
                  pending_phone: detail.phone || '',
                },
              });
              return;
            }

            // Case 2: the card carries an org name but no match
            // exists yet. Chain: open the account wizard first
            // pre-filled with the org name, then on success open
            // the contact wizard with the new account_id locked.
            const orgName = (detail.organization || '').trim();
            const orgMentionIdx = orgName
              ? (this.fields.organizations || []).findIndex((o) => o === orgName)
              : -1;

            if (orgName) {
              window.Pipeline.openWizard('account', {
                name: orgName,
                __on_success: 'pipeline:wizard-success',
                __ai_inbox: {
                  source: 'create_account_for_contact',
                  entry_id: this.itemId,
                  mention_kind: 'organization',
                  mention_idx: orgMentionIdx,
                  mention_text: orgName,
                  // Carry the contact data through so the wizard-success
                  // listener can open the contact wizard next, with the
                  // new account_id locked.
                  pending_contact: {
                    ...carriedFields,
                    person_mention_idx: idx,
                    person_mention_text: mention,
                    pending_phone: detail.phone || '',
                  },
                },
              });
              return;
            }

            // Case 3: no org info on the card. Fall back to the
            // original "open contact wizard, user picks the account"
            // flow.
            window.Pipeline.openWizard('contact', {
              ...carriedFields,
              __on_success: 'pipeline:wizard-success',
              __ai_inbox: {
                source: 'create_contact',
                entry_id: this.itemId,
                mention_kind: 'person',
                mention_idx: idx,
                mention_text: mention,
                pending_phone: detail.phone || '',
              },
            });
          },

          openTaskWizard(opts) {
            if (!window.Pipeline || typeof window.Pipeline.openWizard !== 'function') {
              alert('Wizard system is not available on this page.');
              return;
            }
            const prefill = {
              body: opts.body || '',
              due_at: opts.due_at || '',
              account_id: opts.account_id || '',
              link_label: opts.account_label || '',
              __on_success: 'pipeline:wizard-success',
              __ai_inbox: {
                source: 'create_task',
                entry_id: this.itemId,
                action_idx: typeof opts.source_action_idx === 'number' ? opts.source_action_idx : -1,
              },
            };
            window.Pipeline.openWizard('task', prefill);
          },

          // Listener for the 'pipeline:wizard-success' event. Routes to
          // the right /entities/match or /links/record call based on
          // the __ai_inbox prefill metadata. Ignores events whose
          // prefill doesn't have an entry_id matching this component.
          async onWizardSuccess(e) {
            const detail = e?.detail || {};
            const meta = detail.prefill?.__ai_inbox;
            if (!meta || meta.entry_id !== this.itemId) return;

            const resp = detail.response || {};
            const newId = resp.id;
            if (!newId) return;

            try {
              if (meta.source === 'create_account') {
                await this.recordMatchAndLink({
                  mention_kind: 'organization',
                  mention_idx: meta.mention_idx,
                  mention_text: meta.mention_text,
                  ref_type: 'account',
                  ref_id: newId,
                  action_type: 'create_account',
                });
              } else if (meta.source === 'create_contact') {
                await this.recordMatchAndLink({
                  mention_kind: 'person',
                  mention_idx: meta.mention_idx,
                  mention_text: meta.mention_text,
                  ref_type: 'contact',
                  ref_id: newId,
                  action_type: 'create_contact',
                });
                // If the card carried a phone number, push it onto
                // the brand-new contact automatically. We just
                // created the contact, so phone is empty — no
                // overwrite-conflict risk; no need for force.
                if (meta.pending_phone) {
                  try {
                    await fetch('/ai-inbox/' + encodeURIComponent(this.itemId) + '/push/phone', {
                      method: 'POST', credentials: 'same-origin',
                      headers: { 'content-type': 'application/json' },
                      body: JSON.stringify({
                        ref_type: 'contact',
                        ref_id: newId,
                        phone: meta.pending_phone,
                      }),
                    });
                  } catch (_) { /* best-effort; visible button stays */ }
                }
              } else if (meta.source === 'create_task') {
                await this.recordLinkOnly({
                  ref_type: 'activity',
                  ref_id: newId,
                  ref_label: resp.subject || '(task)',
                  action_type: 'create_task',
                });
              } else if (meta.source === 'link_to_account_via_create') {
                await this.recordLinkOnly({
                  ref_type: 'account',
                  ref_id: newId,
                  ref_label: resp.name || '(account)',
                  action_type: 'link_to_account',
                });
              } else if (meta.source === 'create_account_for_contact') {
                // Chained: the user clicked "Create contact?" on a
                // mention whose org wasn't matched. We just created
                // the account; record the org match + link, then
                // open the contact wizard with the new account_id
                // locked.
                if (meta.mention_idx >= 0) {
                  await this.recordMatchAndLink({
                    mention_kind: 'organization',
                    mention_idx: meta.mention_idx,
                    mention_text: meta.mention_text,
                    ref_type: 'account',
                    ref_id: newId,
                    action_type: 'create_account',
                  });
                } else {
                  // org wasn't a top-level mention (rare); just
                  // record the create as a link.
                  await this.recordLinkOnly({
                    ref_type: 'account',
                    ref_id: newId,
                    ref_label: resp.name || meta.mention_text || '(account)',
                    action_type: 'create_account',
                  });
                }
                const pc = meta.pending_contact || {};
                window.Pipeline.openWizard('contact', {
                  first_name: pc.first_name || '',
                  last_name: pc.last_name || '',
                  title: pc.title || '',
                  email: pc.email || '',
                  account_id: newId,
                  account_label: resp.name || meta.mention_text || '',
                  __on_success: 'pipeline:wizard-success',
                  __ai_inbox: {
                    source: 'create_contact',
                    entry_id: this.itemId,
                    mention_kind: 'person',
                    mention_idx: pc.person_mention_idx,
                    mention_text: pc.person_mention_text || '',
                    pending_phone: pc.pending_phone || '',
                  },
                });
              } else if (meta.source === 'link_to_opportunity_via_create') {
                await this.recordLinkOnly({
                  ref_type: 'opportunity',
                  ref_id: newId,
                  ref_label: resp.label || resp.title || ('OPP-' + (resp.number || newId)),
                  action_type: 'link_to_opportunity',
                });
              }
            } catch (err) {
              console.warn('[ai-inbox] post-wizard recording failed:', err);
            }
          },

          async recordMatchAndLink({ mention_kind, mention_idx, mention_text, ref_type, ref_id, action_type }) {
            // 1. Tell the resolver this is now the user-confirmed match.
            const matchRes = await fetch('/ai-inbox/' + encodeURIComponent(this.itemId) + '/entities/match', {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ mention_kind, mention_idx, mention_text, ref_type, ref_id }),
            });
            const matchJson = await matchRes.json();
            if (matchJson.ok && matchJson.match) {
              this.matches = this.matches.filter(
                m => !(m.mention_kind === mention_kind && m.mention_idx === mention_idx)
              );
              this.matches.push(matchJson.match);
            }

            // 2. Record an action history row for the create.
            const linkRes = await fetch('/ai-inbox/' + encodeURIComponent(this.itemId) + '/links/record', {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                action_type, ref_type, ref_id,
                ref_label: matchJson.match?.ref_label || '(unnamed)',
              }),
            });
            const linkJson = await linkRes.json();
            if (linkJson.ok && linkJson.link) {
              this.links = [linkJson.link, ...this.links];
            }
          },

          async recordLinkOnly({ ref_type, ref_id, ref_label, action_type }) {
            const res = await fetch('/ai-inbox/' + encodeURIComponent(this.itemId) + '/links/record', {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ action_type, ref_type, ref_id, ref_label }),
            });
            const dataJson = await res.json();
            if (dataJson.ok && dataJson.link) {
              this.links = [dataJson.link, ...this.links];
            }
          },

          // ----- v2: legacy inline forms (kept for the link_to_account
          // typeahead — Save All batch path also still uses /entities/
          // create-account and /entities/create-contact server-side) -----
          _legacyOpenCreateAccount(idx) {
            const mention = (this.fields.organizations || [])[idx] || '';
            this.actionForm = {
              kind: 'create_account', busy: false, error: '',
              mention_idx: idx, mention_text: mention,
              name: mention, alias: '', segment: '',
            };
          },
          _legacyOpenCreateContact(idx) {
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
          // The "preferred" parent for the quote picker: any
          // opportunity already linked to this entry takes priority,
          // falling back to whichever opportunity the resolver matched
          // an organization to (rare).
          preferredOpportunityId() {
            const link = (this.links || []).find(
              (l) => l.ref_type === 'opportunity' && l.action_type === 'link_to_opportunity'
            );
            if (link) return link.ref_id;
            return '';
          },
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
                <div class="aii-mention-head">
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
                </div>
                <div class="aii-mention-detail" x-show="hasAnyDetail('person', idx)" x-cloak>
                  <template x-if="detailFor('person', idx)?.title">
                    <span class="aii-detail-row"><strong>Title</strong> <span x-text="detailFor('person', idx).title"></span></span>
                  </template>
                  <template x-if="detailFor('person', idx)?.email">
                    <span class="aii-detail-row">
                      <strong>Email</strong>
                      <a :href="'mailto:' + detailFor('person', idx).email" x-text="detailFor('person', idx).email"></a>
                      <button type="button" class="aii-push-btn"
                              x-show="shouldShowPush('person', idx, 'email')"
                              :title="'Push email onto ' + bestMatch('person', idx)?.ref_label"
                              @click="pushDetail('person', idx, 'email')">↑ push</button>
                      <span class="aii-push-done" x-show="isPushed('person', idx, 'email')" title="Pushed">✓</span>
                    </span>
                  </template>
                  <template x-if="detailFor('person', idx)?.phone">
                    <span class="aii-detail-row">
                      <strong>Phone</strong>
                      <a :href="'tel:' + detailFor('person', idx).phone" x-text="detailFor('person', idx).phone"></a>
                      <button type="button" class="aii-push-btn"
                              x-show="shouldShowPush('person', idx, 'phone')"
                              :title="'Push phone onto ' + bestMatch('person', idx)?.ref_label"
                              @click="pushDetail('person', idx, 'phone')">↑ push</button>
                      <span class="aii-push-done" x-show="isPushed('person', idx, 'phone')" title="Pushed">✓</span>
                    </span>
                  </template>
                  <template x-if="detailFor('person', idx)?.linkedin">
                    <span class="aii-detail-row">
                      <strong>LinkedIn</strong>
                      <a :href="detailFor('person', idx).linkedin" target="_blank" rel="noopener noreferrer"
                         x-text="detailFor('person', idx).linkedin.replace(/^https?:\\/\\/(www\\.)?/, '')"></a>
                      <button type="button" class="aii-push-btn"
                              x-show="shouldShowPush('person', idx, 'linkedin') && bestMatch('person', idx)?.ref_type === 'contact'"
                              :title="'Push LinkedIn URL onto ' + bestMatch('person', idx)?.ref_label"
                              @click="pushDetail('person', idx, 'linkedin')">↑ push</button>
                      <span class="aii-push-done" x-show="isPushed('person', idx, 'linkedin')" title="Pushed">✓</span>
                    </span>
                  </template>
                  <template x-if="detailFor('person', idx)?.organization && !bestMatch('person', idx)">
                    <span class="aii-detail-row"><strong>At</strong> <span x-text="detailFor('person', idx).organization"></span></span>
                  </template>
                </div>
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
                <div class="aii-mention-head">
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
                </div>
                <div class="aii-mention-detail" x-show="hasAnyDetail('organization', idx)" x-cloak>
                  <template x-if="detailFor('organization', idx)?.phone">
                    <span class="aii-detail-row">
                      <strong>Phone</strong>
                      <a :href="'tel:' + detailFor('organization', idx).phone" x-text="detailFor('organization', idx).phone"></a>
                      <button type="button" class="aii-push-btn"
                              x-show="shouldShowPush('organization', idx, 'phone')"
                              :title="'Push phone onto ' + bestMatch('organization', idx)?.ref_label"
                              @click="pushDetail('organization', idx, 'phone')">↑ push</button>
                      <span class="aii-push-done" x-show="isPushed('organization', idx, 'phone')" title="Pushed">✓</span>
                    </span>
                  </template>
                  <template x-if="detailFor('organization', idx)?.email">
                    <span class="aii-detail-row">
                      <strong>Email</strong>
                      <a :href="'mailto:' + detailFor('organization', idx).email" x-text="detailFor('organization', idx).email"></a>
                      <button type="button" class="aii-push-btn"
                              x-show="shouldShowPush('organization', idx, 'email')"
                              :title="'Push email onto ' + bestMatch('organization', idx)?.ref_label"
                              @click="pushDetail('organization', idx, 'email')">↑ push</button>
                      <span class="aii-push-done" x-show="isPushed('organization', idx, 'email')" title="Pushed">✓</span>
                    </span>
                  </template>
                  <template x-if="detailFor('organization', idx)?.website">
                    <span class="aii-detail-row"><strong>Web</strong> <a :href="detailFor('organization', idx).website" target="_blank" rel="noopener" x-text="detailFor('organization', idx).website"></a></span>
                  </template>
                  <template x-if="detailFor('organization', idx)?.address">
                    <span class="aii-detail-row"><strong>Addr</strong> <span x-text="detailFor('organization', idx).address"></span></span>
                  </template>
                </div>
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
            <button type="button" class="aii-apply-btn"
                    :disabled="!a.task"
                    title="Open the task wizard pre-filled with this action item"
                    @click="openTaskWizard({ body: a.task, due_at: a.due, account_id: preferredAccountId(), account_label: preferredAccountLabel(), source_action_idx: idx })">Apply as task</button>
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
          <ul class="aii-list aii-q-list">
            <template x-for="(q, idx) in fields.open_questions" :key="idx">
              <li class="aii-q-item">
                <div class="aii-q-row">
                  <span class="aii-editable" contenteditable="true"
                        x-text="q"
                        @blur="fields.open_questions[idx] = $event.target.innerText.trim(); saveField('open_questions')"></span>
                  <button type="button"
                          class="aii-q-answer-btn"
                          x-show="!answerPanel || answerPanel.idx !== idx"
                          title="Answer this question with audio, text, or a file"
                          @click="openAnswer(idx)">↳ Answer</button>
                </div>

                <div class="aii-q-answer-panel" x-show="answerPanel && answerPanel.idx === idx" x-cloak>
                  <div class="aii-q-answer-actions" x-show="answerPanel && !answerPanel.mode">
                    <button type="button" class="aii-capture-btn aii-capture-btn-with-label" @click="answerByRecording(idx)">
                      <span class="aii-capture-btn-icon">${raw(ICON_MIC)}</span> Record an answer
                    </button>
                    <button type="button" class="aii-capture-btn aii-capture-btn-with-label" @click="answerPanel.mode = 'text'">
                      <span class="aii-capture-btn-icon">${raw(ICON_KEYBOARD)}</span> Type an answer
                    </button>
                    <button type="button" class="aii-capture-btn aii-capture-btn-with-label" @click="answerByFile(idx, $el)">
                      <span class="aii-capture-btn-icon">${raw(ICON_PAPERCLIP)}</span> Attach a file
                    </button>
                    <input type="file" data-aii-q-file hidden>
                    <button type="button" class="aii-btn" @click="closeAnswer()">Cancel</button>
                  </div>

                  <div x-show="answerPanel && answerPanel.mode === 'text'" x-cloak>
                    <textarea class="aii-att-textarea" rows="4"
                              x-model="answerPanel && answerPanel.text"
                              placeholder="Your answer…"></textarea>
                    <div class="aii-form-actions" style="margin-top:.5rem;">
                      <button type="button" class="aii-btn aii-btn-primary"
                              @click="submitAnswerText(idx)"
                              :disabled="answerPanel && (answerPanel.busy || !(answerPanel.text || '').trim())">
                        <span x-show="!answerPanel || !answerPanel.busy">Save answer</span>
                        <span x-show="answerPanel && answerPanel.busy">Saving…</span>
                      </button>
                      <button type="button" class="aii-btn" @click="closeAnswer()" :disabled="answerPanel && answerPanel.busy">Cancel</button>
                    </div>
                  </div>

                  <div class="aii-q-answer-status" x-show="answerPanel && answerPanel.status" x-text="answerPanel && answerPanel.status" x-cloak></div>
                  <div class="aii-err-inline" x-show="answerPanel && answerPanel.error" x-text="answerPanel && answerPanel.error" x-cloak></div>
                </div>
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

        <!-- v3: All available action buttons are always rendered.
             The LLM's suggested_destinations are highlighted with a
             "★ Suggested" hint but every action is reachable from
             every entry, regardless of what the LLM picked. -->
        <div class="aii-suggested-actions">
          <template x-for="d in allActions" :key="d">
            <button type="button"
                    class="aii-action-btn"
                    :class="isSuggested(d) ? 'aii-action-btn-suggested' : ''"
                    :title="isSuggested(d) ? 'Suggested by extraction' : ''"
                    @click="openAction(d)">
              <span x-text="destLabels[d] || d"></span>
              <span class="aii-action-suggested-mark" x-show="isSuggested(d)" title="Suggested by extraction">★</span>
            </button>
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
                     placeholder="Type to search existing accounts…"
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
            <button type="button" class="aii-btn" @click="openAccountWizardForLink()" title="Open the account wizard with the typed name pre-filled">+ New account</button>
            <button type="button" class="aii-btn" @click="closeAction()">Cancel</button>
            <span x-show="actionForm && actionForm.error" class="aii-err-inline" x-text="actionForm && actionForm.error"></span>
          </div>
        </div>

        <!-- Inline form: link_to_opportunity -->
        <div x-show="actionForm && actionForm.kind === 'link_to_opportunity'" class="aii-action-form" x-cloak>
          <h3>Link to opportunity</h3>
          <label class="aii-form-row">
            <span>Opportunity</span>
            <span class="aii-typeahead-wrap">
              <input type="text" x-model="actionForm && actionForm.opportunity_label"
                     placeholder="Type to search opportunities (number or title)…"
                     @input.debounce.250ms="searchEntities('opportunity', $event.target.value, preferredAccountId()); if (actionForm) actionForm.opportunity_id = ''"
                     @focus="searchEntities('opportunity', actionForm && actionForm.opportunity_label, preferredAccountId())">
              <ul class="aii-typeahead" x-show="typeahead && typeahead.kind === 'opportunity' && typeahead.results.length > 0" x-cloak>
                <template x-for="r in (typeahead ? typeahead.results : [])" :key="r.ref_id">
                  <li @click="pickOpportunity(r)">
                    <span x-text="r.label"></span>
                    <small x-text="r.sub" x-show="r.sub"></small>
                  </li>
                </template>
              </ul>
            </span>
          </label>
          <div class="aii-form-actions">
            <button type="button" class="aii-btn aii-btn-primary" @click="submitAction()" :disabled="!(actionForm && actionForm.opportunity_id) || (actionForm && actionForm.busy)">Link</button>
            <button type="button" class="aii-btn" @click="openOpportunityWizardForLink()" title="Open the opportunity wizard pre-filled from this entry">+ New opportunity</button>
            <button type="button" class="aii-btn" @click="closeAction()">Cancel</button>
            <span x-show="actionForm && actionForm.error" class="aii-err-inline" x-text="actionForm && actionForm.error"></span>
          </div>
        </div>

        <!-- Inline form: link_to_quote -->
        <div x-show="actionForm && actionForm.kind === 'link_to_quote'" class="aii-action-form" x-cloak>
          <h3>Link to quote</h3>
          <label class="aii-form-row">
            <span>Quote</span>
            <span class="aii-typeahead-wrap">
              <input type="text" x-model="actionForm && actionForm.quote_label"
                     placeholder="Type to search quotes (number or title)…"
                     @input.debounce.250ms="searchEntities('quote', $event.target.value, preferredOpportunityId() || preferredAccountId()); if (actionForm) actionForm.quote_id = ''"
                     @focus="searchEntities('quote', actionForm && actionForm.quote_label, preferredOpportunityId() || preferredAccountId())">
              <ul class="aii-typeahead" x-show="typeahead && typeahead.kind === 'quote' && typeahead.results.length > 0" x-cloak>
                <template x-for="r in (typeahead ? typeahead.results : [])" :key="r.ref_id">
                  <li @click="pickQuote(r)">
                    <span x-text="r.label"></span>
                    <small x-text="r.sub" x-show="r.sub"></small>
                  </li>
                </template>
              </ul>
            </span>
          </label>
          <div class="aii-form-actions">
            <button type="button" class="aii-btn aii-btn-primary" @click="submitAction()" :disabled="!(actionForm && actionForm.quote_id) || (actionForm && actionForm.busy)">Link</button>
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

    const answersBadge = a.answers_question
      ? html`<div class="aii-att-answers" title="Answer to: ${escape(a.answers_question)}">↳ Answers: ${escape(a.answers_question)}</div>`
      : '';
    return html`<div class="aii-att-row">
      <div class="aii-att-head">
        <span class="aii-att-kind">${escape(kindLabel)}</span>
        ${primaryBadge}
        <span class="aii-att-meta">${metaParts.join(' · ')}</span>
        ${includeBadge}
        <span class="status-pill" style="background:${escape(statusColor)};">${escape(statusLabel)}</span>
        <button type="button" class="aii-rm-btn"
                @click="deleteAttachment('${escape(a.id)}')"
                title="Remove this attachment">×</button>
      </div>
      ${answersBadge}
      ${player}
      ${errorBlock}
      ${capturedBlock}
    </div>`;
  });

  return html`<section class="aii-section"
    x-data="aiInboxAttachInit('${escape(item.id)}')">
    <div class="aii-attachments-head">
      <h2>Attachments</h2>
      <button type="button" class="aii-add-btn" @click="open = !open" x-text="open ? 'Cancel typing note' : '+ Type / paste note'"></button>
    </div>

    <!-- Persistent drop zone — drag any file in to add it as an
         attachment. Click anywhere on it opens a file picker. -->
    <div class="ai-inbox-droppanel ai-inbox-droppanel-compact" data-dropzone-big>
      <form method="post" action="/ai-inbox/${escape(item.id)}/attachments/add" enctype="multipart/form-data" data-dz-form>
        <input type="file" name="file" data-dz-input multiple>
        <div class="dz-big-content">
          <div class="dz-big-icon">⬆</div>
          <div class="dz-big-title">Drop a file to add to this entry</div>
          <div class="dz-big-hint">Audio, PDF, DOCX, image, email, or anything else. Multiple files OK.</div>
          <div class="dz-big-status" data-dz-status></div>
        </div>
      </form>
    </div>

    <div class="aii-capture-bar">
      <button type="button" class="aii-capture-btn" data-aii-record
              title="Record audio" aria-label="Record audio">
        <span class="aii-capture-btn-icon">${raw(ICON_MIC)}</span>
      </button>
      <button type="button" class="aii-capture-btn" data-aii-photo
              title="Add a photo (camera or library)" aria-label="Add a photo">
        <span class="aii-capture-btn-icon">${raw(ICON_CAMERA)}</span>
      </button>
      <input type="file" data-aii-photo-input accept="image/*" hidden>
      <span class="aii-capture-status" data-aii-capture-status></span>
    </div>

    <div class="aii-att-list">${rows}</div>

    <div x-show="open" x-cloak class="aii-att-add">
      <textarea class="aii-att-textarea" rows="6"
                x-model="text"
                placeholder="Paste an email body, type a follow-up note, etc. Will be merged into the entry's context and the LLM re-runs extraction."></textarea>
      <div class="aii-form-actions" style="margin-top:.6rem;">
        <button type="button" class="aii-btn aii-btn-primary"
                @click="submit()"
                :disabled="busy || !text.trim()">
          <span x-show="!busy">Add &amp; re-extract</span>
          <span x-show="busy">Working…</span>
        </button>
        <button type="button" class="aii-btn" @click="open = false; reset()">Cancel</button>
        <span x-show="error" class="aii-err-inline" x-text="error"></span>
      </div>
    </div>

    <script src="/js/dropzone.js"></script>
    <script src="/js/inbox-droppanel.js"></script>
    <script src="/js/audio-recorder.js"></script>
    <script>
      // Wire the Record / Take photo buttons in the capture bar above
      // the attachments list. Both submit to /ai-inbox/:id/attachments/add
      // with kind='auto' so the server infers from the file type. Page
      // reloads on success so the new attachment + re-extracted state
      // appears together.
      (function () {
        const entryId = '${escape(item.id)}';

        async function uploadToEntry(file, statusEl) {
          if (statusEl) statusEl.textContent = 'Uploading ' + file.name + '…';
          try {
            const fd = new FormData();
            fd.append('kind', 'auto');
            fd.append('file', file);
            fd.append('reextract', '1');
            const res = await fetch('/ai-inbox/' + encodeURIComponent(entryId) + '/attachments/add', {
              method: 'POST', credentials: 'same-origin', body: fd,
            });
            const j = await res.json();
            if (!j.ok) {
              if (statusEl) statusEl.textContent = 'Upload failed: ' + (j.error || 'unknown');
              return;
            }
            if (statusEl) statusEl.textContent = 'Reloading…';
            window.location.reload();
          } catch (e) {
            if (statusEl) statusEl.textContent = 'Upload failed: ' + (e.message || e);
          }
        }

        document.querySelectorAll('[data-aii-record]').forEach((btn) => {
          btn.addEventListener('click', () => {
            const status = btn.parentElement.querySelector('[data-aii-capture-status]');
            window.PipelineAudioRecorder.open((file) => uploadToEntry(file, status));
          });
        });

        document.querySelectorAll('[data-aii-photo]').forEach((btn) => {
          const input = btn.parentElement.querySelector('[data-aii-photo-input]');
          if (!input) return;
          btn.addEventListener('click', () => input.click());
          input.addEventListener('change', () => {
            if (input.files && input.files[0]) {
              const status = btn.parentElement.querySelector('[data-aii-capture-status]');
              uploadToEntry(input.files[0], status);
            }
          });
        });
      })();

      window.aiInboxAttachInit = function (entryId) {
        return {
          entryId, open: false, busy: false, error: '',
          text: '',
          reset() { this.text = ''; this.error = ''; },
          async deleteAttachment(attachmentId) {
            if (!confirm('Remove this attachment? This will not re-run extraction.')) return;
            try {
              const res = await fetch('/ai-inbox/' + encodeURIComponent(this.entryId)
                + '/attachments/' + encodeURIComponent(attachmentId) + '/delete', {
                method: 'POST', credentials: 'same-origin',
              });
              const j = await res.json();
              if (!j.ok) {
                alert('Could not delete: ' + (j.error || 'unknown'));
                return;
              }
              window.location.reload();
            } catch (e) {
              alert('Could not delete: ' + (e.message || e));
            }
          },
          async submit() {
            this.busy = true; this.error = '';
            try {
              const fd = new FormData();
              fd.append('kind', 'text');
              fd.append('text', this.text);
              const res = await fetch('/ai-inbox/' + encodeURIComponent(this.entryId)
                + '/attachments/add', {
                method: 'POST', credentials: 'same-origin', body: fd,
              });
              const j = await res.json();
              if (!j.ok) throw new Error(j.error || 'failed');
              // Re-extraction may have run server-side; reload to reflect
              // the new attachment + updated extraction in a single pass.
              window.location.reload();
            } catch (e) {
              this.busy = false;
              this.error = String(e.message || e);
            }
          },
        };
      };
    </script>
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
