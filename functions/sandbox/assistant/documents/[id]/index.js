// functions/sandbox/assistant/documents/[id]/index.js
//
// GET /sandbox/assistant/documents/:id
//
// Per-file drill-down page. Pulls together everything Claudia knows
// about ONE source file:
//
//   1. File metadata (subject, sender, category, retention, dates).
//   2. Cross-reference snapshot (related opps/accounts/contacts/sibling
//      docs) — same enrichment the worker uses, displayed read-only.
//   3. Actions raised from this file (claudia_actions where
//      source_ref_table='claudia_documents' AND source_ref_id=:id).
//   4. Questions linked to those actions (claudia_questions where
//      source_action_id IN (the action ids)).
//   5. Extracted text (collapsible).
//
// Phase A: read-only. Approve/Answer affordances activate in Phase B
// (the same buttons on the action queue page will work here too).
//
// Wes-only. Source chips on the action queue link here.

import { all, one } from '../../../../lib/db.js';
import {
  layout,
  html,
  escape,
  htmlResponse,
  raw,
} from '../../../../lib/layout.js';
import { enrichEvent } from '../../../../lib/claudia-enrich.js';
import { ACTIONS_PANEL_CSS } from '../../../../lib/claudia-actions-render.js';

const SANDBOX_OWNER = 'wes.yoakum@c-lars.com';

export async function onRequestGet(context) {
  const { env, data, params } = context;
  const user = data?.user;
  if (!user || user.email !== SANDBOX_OWNER) {
    return new Response('Not found', { status: 404 });
  }

  const docId = params.id;
  const doc = await one(
    env.DB,
    `SELECT id, user_id, filename, content_type, size_bytes,
            full_text, summary, retention, extraction_status,
            extraction_error, category, seq,
            sender_email, sender_name, subject, email_date, message_id,
            structured_data, parent_id,
            created_at, updated_at, last_accessed_at, trashed_at
       FROM claudia_documents WHERE id = ? AND user_id = ?`,
    [docId, user.id]
  );
  if (!doc) {
    return new Response('Not found', { status: 404 });
  }

  // Use the worker's enrichment pipeline so this page shows the same
  // cross-reference Claudia saw when she classified anything from this
  // file. Phase A: it's a snapshot at view time — Phase B will persist
  // the actual context_json that produced each action and let you
  // toggle between "what Claudia saw then" and "what's true now".
  const enrichment = await enrichEvent(env, {
    type: 'document.context',
    refId: docId,
    userId: user.id,
  });

  const actions = await all(
    env.DB,
    `SELECT id, title, detail, rationale,
            quadrant, importance, urgency, due_at,
            proposed_action_json, status, evaluation_count,
            created_at, updated_at, completed_at, completed_reason
       FROM claudia_actions
      WHERE user_id = ?
        AND source_ref_table = 'claudia_documents'
        AND source_ref_id = ?
      ORDER BY
        CASE quadrant
          WHEN 'hot' THEN 0 WHEN 'plan' THEN 1
          WHEN 'quick' THEN 2 WHEN 'skip' THEN 3 ELSE 4
        END,
        created_at DESC`,
    [user.id, docId]
  );

  const actionIds = actions.map((a) => a.id);
  let questions = [];
  if (actionIds.length > 0) {
    const placeholders = actionIds.map(() => '?').join(',');
    questions = await all(
      env.DB,
      `SELECT id, question, context, answer, status, source_action_id, created_at, answered_at
         FROM claudia_questions
        WHERE user_id = ? AND source_action_id IN (${placeholders})
        ORDER BY created_at DESC`,
      [user.id, ...actionIds]
    );
  }

  const title = doc.subject || doc.filename || `Document ${doc.seq ?? docId.slice(0, 8)}`;
  const body = renderDrillDown({ doc, enrichment, actions, questions });

  return htmlResponse(layout(`Claudia · ${title}`, body, { user, activeNav: '/sandbox' }));
}

// ────────────────────────────────────────────────────────────────────

function fmtDate(iso) {
  if (!iso) return '';
  const ms = Date.parse(String(iso));
  if (!Number.isFinite(ms)) return escape(iso);
  return new Date(ms).toLocaleString();
}

function fmtBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 102.4) / 10} KB`;
  return `${Math.round(n / 104857.6) / 10} MB`;
}

function renderHeader(doc) {
  const title = doc.subject || doc.filename || 'Document';
  const meta = [
    doc.sender_name && doc.sender_email
      ? `${doc.sender_name} <${doc.sender_email}>`
      : doc.sender_email || null,
    doc.email_date ? `email date ${escape(doc.email_date)}` : null,
    `uploaded ${fmtDate(doc.created_at)}`,
    doc.category ? `category ${escape(doc.category)}` : null,
    `retention ${escape(doc.retention || 'auto')}`,
    fmtBytes(doc.size_bytes),
    `seq #${doc.seq ?? '—'}`,
  ].filter(Boolean);

  return html`
    <header class="drill-header">
      <div class="drill-back"><a href="/sandbox/assistant">← back to Claudia</a></div>
      <h1>${escape(title)}</h1>
      <div class="drill-meta">${meta.map((m, i) => html`${i > 0 ? ' · ' : ''}${typeof m === 'string' ? raw(m) : m}`)}</div>
      ${doc.filename && doc.filename !== title ? html`<div class="drill-filename">${escape(doc.filename)}</div>` : ''}
    </header>
  `;
}

function renderRelatedSection(label, rows, mapper) {
  if (!rows || rows.length === 0) return '';
  return html`
    <div class="drill-related-block">
      <div class="drill-related-label">${escape(label)} (${rows.length})</div>
      <ul>${rows.map(mapper)}</ul>
    </div>
  `;
}

function renderEnrichment(enrichment) {
  if (!enrichment) return '';
  const r = enrichment.related || {};
  return html`
    <section class="drill-related">
      <h2>Cross-reference</h2>
      <div class="drill-related-grid">
        ${renderRelatedSection('Opportunities', r.opportunities, (o) => html`
          <li>
            <a href="/opportunities/${escape(o.id)}">${escape(o.number || o.id)}</a>
            ${o.title ? html` — ${escape(o.title)}` : ''}
            ${o.stage ? html` <span class="drill-pill">${escape(o.stage)}</span>` : ''}
          </li>
        `)}
        ${renderRelatedSection('Accounts', r.accounts, (a) => html`
          <li><a href="/accounts/${escape(a.id)}">${escape(a.name)}</a>${a.segment ? html` <span class="drill-pill">${escape(a.segment)}</span>` : ''}</li>
        `)}
        ${renderRelatedSection('Contacts', r.contacts, (c) => html`
          <li>${escape(c.name || '(unnamed contact)')}${c.title ? html` — ${escape(c.title)}` : ''}</li>
        `)}
        ${renderRelatedSection('Recent activities', r.activities, (t) => html`
          <li>${escape(t.subject || t.id)} ${t.due_at ? html`<span class="drill-pill">due ${escape(t.due_at)}</span>` : ''}</li>
        `)}
        ${renderRelatedSection('Sibling docs (same sender)', r.docs, (d) => html`
          <li>
            <a href="/sandbox/assistant/documents/${escape(d.id)}">${escape(d.subject || d.filename || d.id)}</a>
            <span class="drill-pill">${escape(d.category || 'uncategorized')}</span>
          </li>
        `)}
      </div>
      ${enrichment.notes && enrichment.notes.length > 0 ? html`
        <div class="drill-related-notes">${enrichment.notes.map((n) => html`<div>· ${escape(n)}</div>`)}</div>
      ` : ''}
    </section>
  `;
}

function renderActions(actions) {
  if (!actions || actions.length === 0) {
    return html`
      <section class="drill-actions">
        <h2>Actions</h2>
        <div class="drill-empty">No actions raised from this file yet. (If this file just landed, the worker may still be processing it.)</div>
      </section>
    `;
  }
  return html`
    <section class="drill-actions">
      <h2>Actions raised from this file (${actions.length})</h2>
      <ul>
        ${actions.map((a) => html`
          <li class="drill-action" data-q="${escape(a.quadrant)}" id="claudia-action-${escape(a.id)}">
            <div class="drill-action-head">
              <span class="drill-action-q">${escape((a.quadrant || '').toUpperCase())}</span>
              <span class="drill-action-title">${escape(a.title || '')}</span>
              ${a.due_at ? html`<span class="drill-pill">due ${escape(a.due_at)}</span>` : ''}
              ${a.status !== 'open' ? html`<span class="drill-pill">${escape(a.status)}</span>` : ''}
            </div>
            ${a.detail ? html`<div class="drill-action-detail">${escape(a.detail)}</div>` : ''}
            ${a.rationale ? html`<div class="drill-action-rat">${escape(a.rationale)}</div>` : ''}
          </li>
        `)}
      </ul>
    </section>
  `;
}

function renderQuestions(questions) {
  if (!questions || questions.length === 0) return '';
  return html`
    <section class="drill-questions">
      <h2>Questions (${questions.length})</h2>
      <ul>
        ${questions.map((q) => html`
          <li class="drill-question">
            <div class="drill-question-q">${escape(q.question)}</div>
            ${q.context ? html`<div class="drill-question-ctx">${escape(q.context)}</div>` : ''}
            ${q.answer ? html`<div class="drill-question-ans"><strong>Answer:</strong> ${escape(q.answer)}</div>` : ''}
            <div class="drill-question-meta">${escape(q.status)} · ${escape(fmtDate(q.created_at))}</div>
          </li>
        `)}
      </ul>
    </section>
  `;
}

function renderExtractedText(doc) {
  const text = doc.full_text || '';
  if (!text.trim()) return '';
  return html`
    <section class="drill-extract">
      <details>
        <summary>Extracted text (${text.length.toLocaleString()} chars)</summary>
        <pre class="drill-extract-pre">${escape(text)}</pre>
      </details>
    </section>
  `;
}

function renderDrillDown({ doc, enrichment, actions, questions }) {
  return html`
    <style>
      ${raw(ACTIONS_PANEL_CSS)}
      .drill-page {
        max-width: 880px; margin: 1.5rem auto; padding: 0 1rem;
        display: flex; flex-direction: column; gap: 1rem;
        font-size: 14px; color: #1f2937;
      }
      .drill-back { font-size: 13px; margin-bottom: 0.4rem; }
      .drill-back a { color: #4b5563; text-decoration: none; }
      .drill-back a:hover { text-decoration: underline; }
      .drill-header h1 { font-size: 20px; font-weight: 600; margin: 0 0 0.4rem; line-height: 1.3; }
      .drill-meta { font-size: 12px; color: #6b7280; }
      .drill-filename { font-size: 12px; color: #9ca3af; margin-top: 0.2rem; font-family: ui-monospace, Menlo, monospace; }

      .drill-related h2,
      .drill-actions h2,
      .drill-questions h2,
      .drill-extract h2 {
        font-size: 14px; font-weight: 600; margin: 0 0 0.4rem;
        color: #374151;
      }

      .drill-related-grid { display: flex; flex-direction: column; gap: 0.6rem; }
      .drill-related-label { font-size: 12px; font-weight: 600; color: #4b5563; margin-bottom: 0.2rem; }
      .drill-related-block ul { list-style: none; padding-left: 0; margin: 0; display: flex; flex-direction: column; gap: 0.25rem; }
      .drill-related-block li { font-size: 13px; }
      .drill-related-notes { margin-top: 0.6rem; font-size: 12px; color: #6b7280; font-style: italic; }
      .drill-pill {
        display: inline-block; font-size: 11px; padding: 1px 6px;
        border-radius: 999px; background: rgba(0,0,0,0.06); color: #374151;
        margin-left: 0.3rem;
      }

      .drill-actions ul,
      .drill-questions ul { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.5rem; }
      .drill-action {
        background: #fff; border: 1px solid #e5e7eb; border-radius: 8px;
        padding: 0.6rem 0.8rem;
      }
      .drill-action[data-q="hot"]   { border-color: #fca5a5; background: #fef2f2; }
      .drill-action[data-q="plan"]  { border-color: #93c5fd; background: #eff6ff; }
      .drill-action[data-q="quick"] { border-color: #86efac; background: #f0fdf4; }
      .drill-action[data-q="skip"]  { border-color: #d1d5db; background: #f9fafb; color: #6b7280; }
      .drill-action-head {
        display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.5rem;
        font-weight: 600;
      }
      .drill-action-q {
        font-size: 11px; padding: 1px 6px; border-radius: 4px;
        background: rgba(0,0,0,0.08); color: #1f2937;
      }
      .drill-action-title { flex: 1; }
      .drill-action-detail { margin-top: 0.3rem; font-weight: 400; line-height: 1.45; }
      .drill-action-rat { margin-top: 0.2rem; font-size: 12px; color: #6b7280; font-style: italic; }
      .drill-empty { font-size: 13px; color: #6b7280; padding: 0.5rem 0; }

      .drill-question {
        background: #fff7e6; border: 1px solid #facc8a; border-radius: 8px;
        padding: 0.5rem 0.75rem;
      }
      .drill-question-q { font-weight: 600; color: #4a3a1a; }
      .drill-question-ctx { color: #6b5520; font-size: 12px; margin-top: 0.15rem; }
      .drill-question-ans { margin-top: 0.3rem; font-size: 13px; color: #1f2937; }
      .drill-question-meta { margin-top: 0.3rem; font-size: 11px; color: #8a6f3a; }

      .drill-extract details summary { cursor: pointer; user-select: none; font-weight: 600; color: #374151; }
      .drill-extract-pre {
        background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px;
        padding: 0.75rem; margin-top: 0.5rem;
        white-space: pre-wrap; word-wrap: break-word;
        font-family: ui-monospace, Menlo, monospace; font-size: 12px;
        max-height: 480px; overflow-y: auto;
      }

      @media (max-width: 640px) {
        .drill-page { padding: 0 0.6rem; }
        .drill-header h1 { font-size: 17px; }
      }
    </style>
    <div class="drill-page">
      ${renderHeader(doc)}
      ${renderEnrichment(enrichment)}
      ${renderActions(actions)}
      ${renderQuestions(questions)}
      ${renderExtractedText(doc)}
    </div>
  `;
}
