// functions/lib/claudia-brief.js
//
// Maintains the "catch me up" brief Claudia keeps fresh in the
// background. The brief is a single-row-per-user markdown snapshot
// of "what matters right now" — open tasks due today, overdue
// items, opps closing soon, opps gone stale, recent completions,
// tasks people have assigned to Claudia herself.
//
// Wes asked for this to be CONSTANTLY MAINTAINED, not computed on
// demand. So:
//   - The hourly cron tick calls regenerateBrief() at the same time
//     it generates observations. Cheap (Haiku, one-shot).
//   - The read_brief tool returns the cached row + a freshness
//     stamp ("generated 12 minutes ago") so Claudia knows whether
//     to trust it as-is or note that it might be stale.
//   - When the brief is missing entirely (first run, after migration),
//     read_brief auto-triggers a fresh regeneration so Wes never
//     sees an empty brief.
//
// Difference from claudia_observations: observations are point-in-time
// notes that accumulate; the brief is a single rolling snapshot.

import { all, one, run } from './db.js';
import { now } from './ids.js';
import { messagesJson, messages } from './anthropic.js';
import { CLAUDIA_USER_ID } from './auth.js';

const BRIEF_MODEL_DEFAULT = 'claude-haiku-4-5-20251001';

/**
 * Pull the same state slices the cron tick uses, then ask Claude to
 * compose a single short brief. Writes the result to claudia_brief
 * (upsert by user_id). Returns the freshly-generated row.
 *
 * The state_hash field is set so subsequent ticks can short-circuit
 * regeneration when nothing material has changed (skipped today —
 * MVP just regenerates each tick).
 */
export async function regenerateBrief(env, user, opts = {}) {
  const sourceEvent = opts.sourceEvent || 'manual_refresh';
  const today = new Date().toISOString().slice(0, 10);
  const display = user.display_name || user.email;

  // Pull the state slices the brief should reflect. Same shape as
  // claudia-tick uses, plus a slightly tighter task window because the
  // brief is "what matters NOW" not "what's happened recently."
  const [openOpps, openTasks, recentCompletions, tasksToClaudia] = await Promise.all([
    all(env.DB,
      `SELECT id, number, title, stage, expected_close_date,
              estimated_value_usd, updated_at, stage_entered_at
         FROM opportunities
        WHERE (owner_user_id = ? OR salesperson_user_id = ?)
          AND stage NOT IN ('won', 'lost', 'closed', 'closed_won', 'closed_lost', 'closed_died')
        ORDER BY updated_at DESC
        LIMIT 30`,
      [user.id, user.id]),
    all(env.DB,
      `SELECT id, subject, status, due_at, opportunity_id, account_id, updated_at
         FROM activities
        WHERE assigned_user_id = ?
          AND completed_at IS NULL
          AND (type = 'task' OR type IS NULL)
        ORDER BY due_at IS NULL, due_at ASC
        LIMIT 50`,
      [user.id]),
    all(env.DB,
      `SELECT id, subject, completed_at, opportunity_id
         FROM activities
        WHERE assigned_user_id = ?
          AND completed_at IS NOT NULL
          AND completed_at > datetime('now', '-24 hours')
        ORDER BY completed_at DESC
        LIMIT 10`,
      [user.id]),
    all(env.DB,
      `SELECT a.id, a.subject, a.due_at, a.created_at,
              assignor.display_name AS assigned_by_name,
              acct.name AS account_name,
              opp.number AS opp_number
         FROM activities a
         LEFT JOIN users assignor ON assignor.id = a.created_by_user_id
         LEFT JOIN accounts acct ON acct.id = a.account_id
         LEFT JOIN opportunities opp ON opp.id = a.opportunity_id
        WHERE a.assigned_user_id = ?
          AND a.completed_at IS NULL
          AND (a.type = 'task' OR a.type IS NULL)
        ORDER BY a.created_at DESC
        LIMIT 20`,
      [CLAUDIA_USER_ID]),
  ]);

  const system = [
    `You are Claudia preparing a "catch me up" brief for ${display}. Today is ${today}.`,
    'This brief is what he sees when he asks "catch me up" — it should be FAST to read and tell him exactly what matters right now. Aim for 5-10 short bullets across 2-4 sections.',
    '',
    'STRUCTURE (skip a section entirely if it has no signal):',
    '- ## Today\'s tasks — anything due today or overdue',
    '- ## Opportunities at risk — opps that haven\'t moved in 14+ days, or are closing within 7 days but stuck',
    '- ## Closing this week — opps with expected_close_date in the next 7 days',
    '- ## Recently completed — only if there\'s something noteworthy in the last 24h',
    '- ## Assigned to you (Claudia) — tasks others have assigned to claudia-ai that need action',
    '',
    'RULES:',
    '- Specific. Cite opp numbers, task subjects, dates, dollar amounts. Vague filler ("looks busy", "consider reviewing the funnel") is forbidden.',
    '- Brief. Each bullet is one line. No multi-paragraph entries.',
    '- Actionable. If a bullet doesn\'t imply a next move, it doesn\'t belong.',
    '- If there is genuinely nothing to flag, output a one-line "Quiet right now — nothing on fire." and STOP. Do not invent items.',
    '',
    'OUTPUT: pure markdown, no surrounding prose, no code fences.',
  ].join('\n');

  const stateBlob = JSON.stringify({
    open_opportunities: openOpps,
    open_tasks: openTasks,
    recently_completed: recentCompletions,
    tasks_assigned_to_claudia: tasksToClaudia,
  }, null, 2);

  let body = '';
  try {
    const result = await messages(env, {
      system,
      messages: [{ role: 'user', content: stateBlob }],
      model: env.CLAUDIA_BRIEF_MODEL || BRIEF_MODEL_DEFAULT,
      maxTokens: 700,
      temperature: 0.2,
    });
    body = String(result?.text || '').trim();
  } catch (err) {
    console.error('[claudia-brief] model call failed:', err?.message || err);
    // Fall back to a deterministic plain-text snapshot so the brief
    // is never empty. Cheaper than failing silently.
    body = renderFallbackBrief({ openOpps, openTasks, tasksToClaudia });
  }

  if (!body) {
    body = 'Quiet right now — nothing on fire.';
  }

  const ts = now();
  await run(
    env.DB,
    `INSERT INTO claudia_brief (user_id, body, generated_at, source_event)
       VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       body = excluded.body,
       generated_at = excluded.generated_at,
       source_event = excluded.source_event`,
    [user.id, body, ts, sourceEvent]
  );

  return { user_id: user.id, body, generated_at: ts, source_event: sourceEvent };
}

/**
 * Read the cached brief. If missing, auto-generate one. Returns the
 * row plus a `freshness_minutes` field so callers can decide whether
 * to use as-is, mention staleness, or trigger a regen.
 */
export async function readBrief(env, user) {
  let row = await one(
    env.DB,
    'SELECT user_id, body, generated_at, source_event FROM claudia_brief WHERE user_id = ?',
    [user.id]
  );
  if (!row) {
    row = await regenerateBrief(env, user, { sourceEvent: 'first_load' });
  }
  const ageMin = row.generated_at
    ? Math.round((Date.now() - Date.parse(row.generated_at)) / 60_000)
    : null;
  return { ...row, freshness_minutes: ageMin };
}

function renderFallbackBrief({ openOpps, openTasks, tasksToClaudia }) {
  const lines = [];
  if (openTasks.length > 0) {
    lines.push('## Today\'s tasks');
    for (const t of openTasks.slice(0, 5)) {
      const due = t.due_at ? ` (due ${t.due_at.slice(0, 10)})` : '';
      lines.push(`- ${t.subject || '(no subject)'}${due}`);
    }
  }
  if (openOpps.length > 0) {
    lines.push('## Open opportunities');
    for (const o of openOpps.slice(0, 5)) {
      const value = o.estimated_value_usd != null ? ` ($${Math.round(o.estimated_value_usd).toLocaleString()})` : '';
      lines.push(`- ${o.number} — ${o.title || ''}${value}, stage ${o.stage}`);
    }
  }
  if (tasksToClaudia.length > 0) {
    lines.push('## Assigned to Claudia');
    for (const t of tasksToClaudia.slice(0, 5)) {
      lines.push(`- ${t.subject || '(no subject)'} — from ${t.assigned_by_name || 'someone'}`);
    }
  }
  if (lines.length === 0) return 'Quiet right now — nothing on fire.';
  return lines.join('\n');
}
