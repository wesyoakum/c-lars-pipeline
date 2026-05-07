// functions/lib/claudia-actions-render.js
//
// Server-side renderers for the Claudia action queue + questions panel
// on /sandbox/assistant. Phase A is read-only — these emit lists with
// no approve/reject affordances. Phase B activates the buttons.
//
// Data loader + four-quadrant panel + questions panel + the CSS string
// to drop into the page's <style> block. Following the existing
// index.js pattern where CSS is centralized, not per-component.
//
// Structure of the rendered HTML (read-only):
//
//   <section.claudia-actions-panel>
//     <div.claudia-actions-quadrant data-q="hot">  Hot (3)
//       <ul>... action rows ...</ul>
//     <div.claudia-actions-quadrant data-q="plan"> Plan (5)
//       ...
//     <div.claudia-actions-quadrant data-q="quick">Quick (2)
//       ...
//     <div.claudia-actions-quadrant data-q="skip"> Skip (12, collapsed)
//       ...
//   </section>
//
//   <section.claudia-questions-panel>
//     <div.claudia-questions-header>Questions (4)
//     <ul>... question rows ...</ul>
//   </section>

import { all } from './db.js';
import { html, escape } from './layout.js';

const QUADRANT_LABELS = {
  hot:   'Hot',
  plan:  'Plan',
  quick: 'Quick',
  skip:  'Skip',
};

// Display order top-to-bottom. Skip starts collapsed (rendered but
// hidden until clicked) so the noise doesn't dominate the page.
const QUADRANT_ORDER = ['hot', 'plan', 'quick', 'skip'];

/**
 * Load the open actions + open questions for one user. Capped so the
 * initial render stays fast even on a busy day.
 */
export async function loadActionsAndQuestions(env, userId) {
  const actions = await all(
    env.DB,
    `SELECT id, title, detail, rationale,
            quadrant, importance, urgency, due_at,
            source_kind, source_ref_table, source_ref_id,
            proposed_action_json, status,
            created_at, updated_at, evaluation_count
       FROM claudia_actions
      WHERE user_id = ? AND status = 'open'
      ORDER BY
        CASE quadrant
          WHEN 'hot'   THEN 0
          WHEN 'plan'  THEN 1
          WHEN 'quick' THEN 2
          WHEN 'skip'  THEN 3
          ELSE 4
        END,
        COALESCE(due_at, created_at) ASC,
        created_at DESC
      LIMIT 200`,
    [userId]
  );

  const questions = await all(
    env.DB,
    `SELECT id, question, context, source_action_id, created_at
       FROM claudia_questions
      WHERE user_id = ? AND status = 'open'
      ORDER BY created_at DESC
      LIMIT 50`,
    [userId]
  );

  return { actions, questions };
}

function bucketByQuadrant(actions) {
  const out = { hot: [], plan: [], quick: [], skip: [] };
  for (const a of actions) {
    const q = QUADRANT_ORDER.includes(a.quadrant) ? a.quadrant : 'skip';
    out[q].push(a);
  }
  return out;
}

function formatDue(due_at) {
  if (!due_at) return '';
  const ms = Date.parse(String(due_at));
  if (!Number.isFinite(ms)) return escape(due_at);
  const d = new Date(ms);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const cutoff = today.getTime();
  const days = Math.round((d.getTime() - cutoff) / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  if (days < 0) return `${-days}d overdue`;
  if (days < 7) return `in ${days}d`;
  return d.toISOString().slice(0, 10);
}

// Build a clickable source chip. Files link to the drill-down page;
// Pipeline entities link to their detail page. Phase A: file links
// only — Pipeline link styling matches but the href is the entity's
// existing detail route.
function sourceChip(action) {
  const { source_kind, source_ref_table, source_ref_id } = action;
  if (!source_ref_id) {
    if (source_kind === 'self')   return html`<span class="claudia-action-src self">self</span>`;
    if (source_kind === 'chat')   return html`<span class="claudia-action-src chat">chat</span>`;
    return '';
  }
  if (source_ref_table === 'claudia_documents' || source_ref_table === 'ai_inbox_items') {
    const href = source_ref_table === 'claudia_documents'
      ? `/sandbox/assistant/documents/${encodeURIComponent(source_ref_id)}`
      : `/ai-inbox/${encodeURIComponent(source_ref_id)}`;
    return html`<a class="claudia-action-src file" href="${href}">${source_ref_table === 'ai_inbox_items' ? 'inbox' : 'file'}</a>`;
  }
  if (source_ref_table === 'opportunities') {
    return html`<a class="claudia-action-src opp" href="/opportunities/${encodeURIComponent(source_ref_id)}">opp</a>`;
  }
  if (source_ref_table === 'accounts') {
    return html`<a class="claudia-action-src acct" href="/accounts/${encodeURIComponent(source_ref_id)}">account</a>`;
  }
  if (source_ref_table === 'activities') {
    return html`<a class="claudia-action-src activity" href="/activities/${encodeURIComponent(source_ref_id)}">task</a>`;
  }
  return html`<span class="claudia-action-src">${escape(source_kind || 'event')}</span>`;
}

// Parse the proposed_action JSON for display + button visibility.
// Returns null when the field is empty / unparseable / lacks a tool.
function parseProposed(a) {
  const src = a.edited_action_json || a.proposed_action_json;
  if (!src) return null;
  try {
    const obj = JSON.parse(src);
    if (obj && typeof obj === 'object' && obj.tool) return obj;
    return null;
  } catch {
    return null;
  }
}

// Buttons that fire HTMX POSTs to the per-action route handlers and
// swap the entire actions panel back. Each button sets the same
// hx-target / hx-swap so the panel re-renders coherently after any
// state change.
function renderActionButtons(a) {
  const id = encodeURIComponent(a.id);
  const otherQuadrants = QUADRANT_ORDER.filter((q) => q !== a.quadrant);
  const proposed = parseProposed(a);
  return html`
    <div class="claudia-action-actions">
      ${proposed ? html`
        <button type="button" class="claudia-action-btn approve"
                hx-post="/sandbox/assistant/actions/${id}/approve"
                hx-target="#claudia-actions-panel"
                hx-swap="outerHTML"
                title="Approve — execute ${escape(proposed.tool)} via Claudia, 72h undo">Approve</button>
      ` : ''}
      <button type="button" class="claudia-action-btn done"
              hx-post="/sandbox/assistant/actions/${id}/done"
              hx-target="#claudia-actions-panel"
              hx-swap="outerHTML"
              title="Mark done — I did this">Done</button>
      <button type="button" class="claudia-action-btn dismiss"
              hx-post="/sandbox/assistant/actions/${id}/dismiss"
              hx-target="#claudia-actions-panel"
              hx-swap="outerHTML"
              title="Dismiss — not worth doing">Dismiss</button>
      <span class="claudia-action-move">
        <span class="claudia-action-move-label">Move:</span>
        ${otherQuadrants.map((q) => html`
          <button type="button" class="claudia-action-btn move"
                  hx-post="/sandbox/assistant/actions/${id}/move?to=${escape(q)}"
                  hx-target="#claudia-actions-panel"
                  hx-swap="outerHTML"
                  title="Move to ${escape(QUADRANT_LABELS[q])}">${escape(QUADRANT_LABELS[q])}</button>
        `)}
      </span>
    </div>
  `;
}

function renderActionRow(a) {
  const due = formatDue(a.due_at);
  const overdue = due && /overdue/.test(due);
  return html`
    <li class="claudia-action-row" data-q="${escape(a.quadrant)}" data-id="${escape(a.id)}" id="claudia-action-${escape(a.id)}">
      <div class="claudia-action-head">
        <span class="claudia-action-title">${escape(a.title || '')}</span>
        ${sourceChip(a)}
        ${due ? html`<span class="claudia-action-due ${overdue ? 'overdue' : ''}">${escape(due)}</span>` : ''}
      </div>
      ${a.detail ? html`<div class="claudia-action-detail">${escape(a.detail)}</div>` : ''}
      ${a.rationale ? html`<div class="claudia-action-rationale">${escape(a.rationale)}</div>` : ''}
      ${renderActionButtons(a)}
    </li>
  `;
}

function renderQuadrantBlock(quadrant, rows) {
  const label = QUADRANT_LABELS[quadrant];
  const startCollapsed = quadrant === 'skip';
  return html`
    <details class="claudia-actions-quadrant" data-q="${escape(quadrant)}" ${rows.length === 0 ? '' : (startCollapsed ? '' : 'open')}>
      <summary>
        <span class="claudia-actions-quadrant-label">${escape(label)}</span>
        <span class="claudia-actions-quadrant-count">${rows.length}</span>
      </summary>
      ${rows.length === 0
        ? html`<div class="claudia-actions-quadrant-empty">none</div>`
        : html`<ul class="claudia-actions-list">${rows.map(renderActionRow)}</ul>`}
    </details>
  `;
}

/**
 * Render the four-quadrant action panel. Returns an HTML fragment;
 * caller wraps it in the page layout.
 */
export function renderActionsPanel(actions) {
  if (!actions || actions.length === 0) return '';
  const buckets = bucketByQuadrant(actions);
  return html`
    <section class="claudia-actions-panel" id="claudia-actions-panel" aria-label="Action queue">
      ${QUADRANT_ORDER.map((q) => renderQuadrantBlock(q, buckets[q]))}
    </section>
  `;
}

function renderQuestionRow(q) {
  const linkedActionId = q.source_action_id;
  const id = encodeURIComponent(q.id);
  return html`
    <li class="claudia-question-row" data-id="${escape(q.id)}">
      <div class="claudia-question-q">${escape(q.question)}</div>
      ${q.context ? html`<div class="claudia-question-ctx">${escape(q.context)}</div>` : ''}
      ${linkedActionId ? html`<div class="claudia-question-link"><a href="#claudia-action-${escape(linkedActionId)}">re: action</a></div>` : ''}
      <form class="claudia-question-answer-form"
            hx-post="/sandbox/assistant/questions/${id}/answer"
            hx-target="#claudia-questions-panel"
            hx-swap="outerHTML">
        <input type="text" name="answer" class="claudia-question-input"
               placeholder="Answer (Enter to save)…"
               autocomplete="off" />
        <button type="button" class="claudia-question-btn drop"
                hx-post="/sandbox/assistant/questions/${id}/drop"
                hx-target="#claudia-questions-panel"
                hx-swap="outerHTML"
                title="Drop — no longer relevant">Drop</button>
      </form>
    </li>
  `;
}

/**
 * Render the questions panel. Returns an HTML fragment.
 */
export function renderQuestionsPanel(questions) {
  if (!questions || questions.length === 0) return '';
  return html`
    <section class="claudia-questions-panel" id="claudia-questions-panel" aria-label="Open questions">
      <details ${questions.length > 5 ? '' : 'open'}>
        <summary>
          <span class="claudia-questions-label">Questions</span>
          <span class="claudia-questions-count">${questions.length}</span>
        </summary>
        <ul class="claudia-questions-list">
          ${questions.map(renderQuestionRow)}
        </ul>
      </details>
    </section>
  `;
}

/**
 * CSS string to drop into the page <style> block. Centralized here so
 * the visual is co-located with the markup, but follows the existing
 * pattern (CSS lives in index.js's style block).
 */
export const ACTIONS_PANEL_CSS = `
  .claudia-actions-panel {
    max-width: 880px; margin: 0.75rem auto 0; padding: 0 1rem;
    display: flex; flex-direction: column; gap: 0.4rem;
    font-size: 13px;
  }
  .claudia-actions-quadrant {
    border-radius: 8px; border: 1px solid transparent;
    padding: 0.4rem 0.6rem;
  }
  .claudia-actions-quadrant[data-q="hot"]   { background: #fee2e2; border-color: #fca5a5; }
  .claudia-actions-quadrant[data-q="plan"]  { background: #dbeafe; border-color: #93c5fd; }
  .claudia-actions-quadrant[data-q="quick"] { background: #dcfce7; border-color: #86efac; }
  .claudia-actions-quadrant[data-q="skip"]  { background: #f3f4f6; border-color: #d1d5db; color: #6b7280; }
  .claudia-actions-quadrant > summary {
    cursor: pointer; user-select: none;
    display: flex; align-items: baseline; gap: 0.5rem;
    font-weight: 600;
  }
  .claudia-actions-quadrant-label { letter-spacing: 0.02em; }
  .claudia-actions-quadrant-count { font-weight: 400; opacity: 0.7; font-size: 12px; }
  .claudia-actions-quadrant-empty { padding: 0.4rem 0; color: #6b7280; font-size: 12px; }
  .claudia-actions-list {
    list-style: none; padding: 0; margin: 0.4rem 0 0;
    display: flex; flex-direction: column; gap: 0.4rem;
  }
  .claudia-action-row {
    background: rgba(255,255,255,0.6);
    border-radius: 6px; padding: 0.4rem 0.55rem;
    line-height: 1.4;
  }
  .claudia-action-head {
    display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.4rem;
  }
  .claudia-action-title { font-weight: 600; flex: 1 1 auto; }
  .claudia-action-src {
    font-size: 11px; padding: 1px 6px; border-radius: 999px;
    background: rgba(0,0,0,0.06); color: #374151; text-decoration: none;
    white-space: nowrap;
  }
  .claudia-action-src:hover { background: rgba(0,0,0,0.10); }
  .claudia-action-due {
    font-size: 11px; padding: 1px 6px; border-radius: 999px;
    background: rgba(0,0,0,0.06); color: #374151; white-space: nowrap;
  }
  .claudia-action-due.overdue { background: #fee2e2; color: #991b1b; font-weight: 600; }
  .claudia-action-detail { margin-top: 0.2rem; color: #1f2937; }
  .claudia-action-rationale { margin-top: 0.15rem; color: #6b7280; font-size: 12px; font-style: italic; }

  .claudia-action-actions {
    display: flex; flex-wrap: wrap; align-items: center; gap: 0.3rem;
    margin-top: 0.4rem; font-size: 11px;
  }
  .claudia-action-btn {
    background: rgba(255,255,255,0.85);
    border: 1px solid rgba(0,0,0,0.12);
    border-radius: 4px;
    padding: 2px 8px;
    font: inherit;
    color: #1f2937;
    cursor: pointer;
    line-height: 1.3;
  }
  .claudia-action-btn:hover { background: rgba(255,255,255,1); border-color: rgba(0,0,0,0.25); }
  .claudia-action-btn.approve {
    background: #15803d; border-color: #15803d; color: #fff;
    font-weight: 600;
  }
  .claudia-action-btn.approve:hover { background: #166534; border-color: #166534; }
  .claudia-action-btn.done    { color: #15803d; }
  .claudia-action-btn.dismiss { color: #6b7280; }
  .claudia-action-btn.move    { color: #4b5563; }
  .claudia-action-move {
    display: inline-flex; align-items: center; gap: 0.25rem;
    margin-left: 0.4rem;
    padding-left: 0.4rem;
    border-left: 1px solid rgba(0,0,0,0.12);
  }
  .claudia-action-move-label { color: #6b7280; font-size: 11px; }

  .claudia-questions-panel {
    max-width: 880px; margin: 0.5rem auto 0; padding: 0 1rem;
    font-size: 13px;
  }
  .claudia-questions-panel > details {
    background: #fff7e6; border: 1px solid #facc8a; border-radius: 8px;
    padding: 0.4rem 0.6rem;
  }
  .claudia-questions-panel summary {
    cursor: pointer; user-select: none;
    display: flex; align-items: baseline; gap: 0.5rem;
    font-weight: 600; color: #4a3a1a;
  }
  .claudia-questions-count { font-weight: 400; opacity: 0.7; font-size: 12px; }
  .claudia-questions-list {
    list-style: none; padding: 0; margin: 0.4rem 0 0;
    display: flex; flex-direction: column; gap: 0.4rem;
  }
  .claudia-question-row {
    background: rgba(255,255,255,0.7);
    border-radius: 6px; padding: 0.4rem 0.55rem;
  }
  .claudia-question-q { font-weight: 600; color: #4a3a1a; }
  .claudia-question-ctx { color: #6b5520; font-size: 12px; margin-top: 0.15rem; }
  .claudia-question-link { font-size: 11px; margin-top: 0.2rem; }
  .claudia-question-link a { color: #4a3a1a; text-decoration: underline; }
  .claudia-question-answer-form {
    display: flex; gap: 0.4rem; margin-top: 0.4rem; align-items: center;
  }
  .claudia-question-input {
    flex: 1; padding: 4px 8px; font-size: 12px;
    border: 1px solid #facc8a; border-radius: 4px;
    background: #fffdf6; color: #4a3a1a;
    font-family: inherit;
  }
  .claudia-question-input:focus {
    outline: none; border-color: #d97706; background: #fff;
  }
  .claudia-question-btn {
    background: rgba(255,255,255,0.85);
    border: 1px solid #facc8a; border-radius: 4px;
    padding: 3px 8px; font-size: 11px;
    color: #6b5520; cursor: pointer;
    line-height: 1.3;
  }
  .claudia-question-btn:hover { background: #fff; border-color: #d97706; }

  @media (max-width: 640px) {
    .claudia-actions-panel,
    .claudia-questions-panel { padding: 0 0.4rem; }
  }
`;
