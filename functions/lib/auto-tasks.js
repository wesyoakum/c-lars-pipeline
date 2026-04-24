// functions/lib/auto-tasks.js
//
// Auto-tasks Phase 1 — rules engine.
//
// This module is the runtime half of the auto-task feature. Migration
// 0036 added the tables (task_rules, task_rule_fires, task_reminders);
// this module reads rules, evaluates them against event payloads, and
// creates tasks (activities) + reminders.
//
// Call site pattern — every event-producing handler (quote.issued,
// opportunity.stage_changed, task.completed, system.error) ends with:
//
//   import { fireEvent } from '../lib/auto-tasks.js';
//   // ...after the main DB batch...
//   context.waitUntil(
//     fireEvent(env, 'quote.issued', payload, user).catch(err =>
//       console.error('auto-tasks fireEvent failed:', err))
//   );
//
// Using waitUntil keeps auto-tasks off the request's critical path —
// a rule-engine failure never rolls back a successful quote issue.
//
// Dedupe:
//   Every fireEvent() invocation supplies a stable `eventKey` string
//   (e.g. `quote.issued:<quote_id>`). The engine inserts task_rule_fires
//   rows with a UNIQUE (rule_id, event_key) constraint, so duplicate
//   events from retries cannot double-create tasks.
//
// Timezone:
//   Phase 1 locks due-at computation to America/Chicago (read from
//   rule.tz, which defaults to Chicago). Phase 2 will add per-user tz.

import { all, one, stmt, batch, run } from './db.js';
import { auditStmt } from './audit.js';
import { uuid, now } from './ids.js';
import { notify } from './notify.js';

// ---------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------

/**
 * Fire an event into the rules engine.
 *
 * @param {object} env           Cloudflare env (for env.DB).
 * @param {string} triggerName   e.g. 'quote.issued', 'opportunity.stage_changed'.
 * @param {object} payload       Contextual data the rules condition on and
 *                               substitute into templates. Expected shape:
 *                                 { trigger: { user, at, ... },
 *                                   quote?, opportunity?, account?, task?, error? }
 *                               Each sub-object is a plain data record
 *                               (typically the DB row as returned by `one(...)`).
 * @param {object} user          Acting user (for audit + default assignee).
 * @returns {Promise<{fired: number, skipped: number}>}
 */
export async function fireEvent(env, triggerName, payload, user) {
  if (!env?.DB || !triggerName) return { fired: 0, skipped: 0 };

  // Load all active rules bound to this trigger. Small table, no
  // pagination — expected to stay under a few dozen rows for a long
  // time. If this ever gets big, add a stricter per-trigger cache.
  const rules = await all(
    env.DB,
    `SELECT id, name, trigger, conditions_json, task_json, tz
       FROM task_rules
      WHERE trigger = ? AND active = 1`,
    [triggerName]
  );
  if (rules.length === 0) return { fired: 0, skipped: 0 };

  let fired = 0;
  let skipped = 0;

  for (const rule of rules) {
    try {
      const conditions = parseJson(rule.conditions_json) || {};
      if (!evalConditions(conditions, payload)) {
        skipped++;
        continue;
      }

      const template = parseJson(rule.task_json);
      if (!template || !template.title) {
        console.error('auto-tasks: rule', rule.id, 'has invalid task_json');
        skipped++;
        continue;
      }

      const eventKey = buildEventKey(triggerName, payload);
      const ok = await createTaskFromRule({
        env,
        rule,
        template,
        payload,
        user,
        eventKey,
      });
      if (ok) fired++; else skipped++;
    } catch (err) {
      console.error('auto-tasks: rule', rule.id, 'failed:', err?.message || err);
      skipped++;
    }
  }

  return { fired, skipped };
}

// ---------------------------------------------------------------------
// Rule evaluation
// ---------------------------------------------------------------------

/**
 * Evaluate a conditions object against a payload.
 *
 * Conditions format:
 *   { "quote.quote_type": "spares" }                              // eq
 *   { "opportunity.stage": { "in": ["qualified", "proposal_sent"] } }
 *   { "quote.is_hybrid": { "neq": 1 } }
 *   { "error.code": { "in": ["pdf_generation_failed","docx_generation_failed"] } }
 *
 * Empty / missing conditions = always true.
 */
export function evalConditions(conditions, payload) {
  if (!conditions || typeof conditions !== 'object') return true;
  for (const [path, expected] of Object.entries(conditions)) {
    const actual = getPath(payload, path);
    if (!matches(actual, expected)) return false;
  }
  return true;
}

function matches(actual, expected) {
  if (expected === null || expected === undefined) {
    return actual === null || actual === undefined;
  }
  if (typeof expected !== 'object' || Array.isArray(expected)) {
    // Primitive or array → equality check. Coerce for num/str ambiguity
    // (D1 returns INTEGER 0/1 and TEXT '0'/'1' sometimes).
    // eslint-disable-next-line eqeqeq
    return actual == expected;
  }
  if ('in' in expected) {
    const list = expected.in;
    if (!Array.isArray(list)) return false;
    // eslint-disable-next-line eqeqeq
    return list.some((v) => v == actual);
  }
  if ('neq' in expected) {
    // eslint-disable-next-line eqeqeq
    return actual != expected.neq;
  }
  if ('eq' in expected) {
    // eslint-disable-next-line eqeqeq
    return actual == expected.eq;
  }
  if ('exists' in expected) {
    const present = actual !== null && actual !== undefined && actual !== '';
    return expected.exists ? present : !present;
  }
  return false;
}

// ---------------------------------------------------------------------
// Template rendering
// ---------------------------------------------------------------------

/**
 * Substitute {payload.path} tokens in a string template. Missing paths
 * render as an empty string. Works on both title and body fields.
 */
export function renderTemplate(tpl, payload) {
  if (!tpl) return '';
  return String(tpl).replace(/\{([a-z0-9_.]+)\}/gi, (_, path) => {
    const v = getPath(payload, path);
    if (v === null || v === undefined) return '';
    return String(v);
  });
}

// ---------------------------------------------------------------------
// Assignee resolution
// ---------------------------------------------------------------------

/**
 * Resolve a task assignee selector to a user_id.
 *
 * Supported selectors:
 *   'trigger.user'          → payload.trigger.user.id (the acting user)
 *   'opportunity.owner'     → payload.opportunity.owner_user_id
 *   'quote.owner'           → payload.quote.submitted_by_user_id, fallback
 *                             to payload.opportunity.owner_user_id
 *   'account.owner'         → payload.account.owner_user_id
 *   'user:<uuid>'           → literal user id
 *   '<payload.path>'        → value at that path (must be a user_id string)
 *
 * Returns null if nothing resolves — caller may fall back to trigger.user.
 */
export function resolveAssignee(selector, payload) {
  if (!selector) return null;
  if (selector === 'trigger.user') {
    return payload?.trigger?.user?.id ?? null;
  }
  if (selector === 'opportunity.owner') {
    return payload?.opportunity?.owner_user_id ?? null;
  }
  if (selector === 'quote.owner') {
    return (
      payload?.quote?.submitted_by_user_id ??
      payload?.opportunity?.owner_user_id ??
      null
    );
  }
  if (selector === 'account.owner') {
    return payload?.account?.owner_user_id ?? null;
  }
  if (selector.startsWith('user:')) {
    return selector.slice(5) || null;
  }
  // Fallback: treat as a payload path.
  const v = getPath(payload, selector);
  return typeof v === 'string' ? v : null;
}

// ---------------------------------------------------------------------
// Due-at DSL
// ---------------------------------------------------------------------

/**
 * Compute an absolute UTC ISO timestamp from a due-at DSL string,
 * interpreted in the given IANA timezone.
 *
 * Grammar:
 *   '+Nd'               → now + N days, same wall-clock time
 *   '+Nh'               → now + N hours
 *   '+Nm'               → now + N minutes
 *   '+Nd@cob'           → N days from today at 17:00 local
 *   '+Nd@HH:MM'         → N days from today at HH:MM local
 *   'tomorrow@HH:MM'    → tomorrow at HH:MM local
 *   'tomorrow@cob'      → tomorrow at 17:00 local
 *   'today@HH:MM'       → today at HH:MM local
 *   'today@cob'         → today at 17:00 local
 *   'next_<dayname>@cob' → next occurrence of that weekday at 17:00
 *                          (monday,tuesday,…,sunday)
 *   'next_<dayname>@HH:MM'
 *
 * Returns a UTC ISO string, or null for invalid input or null dsl
 * (meaning "no due date").
 *
 * Phase 1 note: weekend-skipping for '+Nd' business-day math is NOT
 * implemented here; only the rules that opt in via '@cob' or '@HH:MM'
 * get wall-clock anchoring. The createIssueTask() helper in
 * quote-transitions.js already handles its own weekend skip.
 */
export function computeDueAt(dsl, tz = 'America/Chicago', refDate = new Date()) {
  if (!dsl) return null;
  const s = String(dsl).trim().toLowerCase();

  // Parse @time suffix
  let time = null;
  const atIdx = s.indexOf('@');
  const head = atIdx >= 0 ? s.slice(0, atIdx) : s;
  const tail = atIdx >= 0 ? s.slice(atIdx + 1) : null;
  if (tail) {
    if (tail === 'cob') time = { h: 17, m: 0 };
    else {
      const m = /^(\d{1,2}):(\d{2})$/.exec(tail);
      if (m) time = { h: Number(m[1]), m: Number(m[2]) };
    }
  }

  // Relative offset: +Nd, +Nh, +Nm
  let rel = null;
  const relM = /^\+(\d+)([dhm])$/.exec(head);
  if (relM) rel = { n: Number(relM[1]), unit: relM[2] };

  // Named day: today, tomorrow, next_<dayname>
  const dayNames = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  let namedDay = null;
  if (head === 'today') namedDay = { kind: 'today' };
  else if (head === 'tomorrow') namedDay = { kind: 'tomorrow' };
  else if (head.startsWith('next_')) {
    const name = head.slice(5);
    const idx = dayNames.indexOf(name);
    if (idx >= 0) namedDay = { kind: 'next', weekday: idx };
  }

  if (!rel && !namedDay) return null;

  // Get current wall-clock in the target tz.
  const local = getLocalParts(refDate, tz);
  let yy = local.year, mo = local.month, dd = local.day;
  let hh = time ? time.h : local.hour;
  let mm = time ? time.m : local.minute;

  if (rel) {
    if (rel.unit === 'd') dd += rel.n;
    else if (rel.unit === 'h') {
      // For +Nh we add in UTC to avoid tz-boundary drift, then
      // re-extract local parts so the returned ISO is still computed
      // via the tz-offset helper below.
      const off = localToUtc({ year: yy, month: mo, day: dd, hour: local.hour, minute: local.minute }, tz);
      const next = new Date(off.getTime() + rel.n * 3600 * 1000);
      const p = getLocalParts(next, tz);
      yy = p.year; mo = p.month; dd = p.day; hh = p.hour; mm = p.minute;
    } else if (rel.unit === 'm') {
      const off = localToUtc({ year: yy, month: mo, day: dd, hour: local.hour, minute: local.minute }, tz);
      const next = new Date(off.getTime() + rel.n * 60 * 1000);
      const p = getLocalParts(next, tz);
      yy = p.year; mo = p.month; dd = p.day; hh = p.hour; mm = p.minute;
    }
  } else if (namedDay) {
    if (namedDay.kind === 'tomorrow') dd += 1;
    else if (namedDay.kind === 'next') {
      const current = weekdayOf(yy, mo, dd); // 0=Sun...6=Sat
      let delta = (namedDay.weekday - current + 7) % 7;
      if (delta === 0) delta = 7; // always "next", not "today"
      dd += delta;
    }
    // today/named day always use the @time suffix; if none, default cob
    if (time === null) { hh = 17; mm = 0; }
  }

  const utc = localToUtc({ year: yy, month: mo, day: dd, hour: hh, minute: mm }, tz);
  if (!utc || isNaN(utc.getTime())) return null;
  return utc.toISOString();
}

// ---------------------------------------------------------------------
// Helpers (non-exported)
// ---------------------------------------------------------------------

function parseJson(s) {
  if (s == null) return null;
  try { return JSON.parse(s); } catch { return null; }
}

/**
 * Walk a dotted path against a nested object. Supports numeric array
 * indices: 'lines.0.qty'.
 */
function getPath(obj, path) {
  if (!obj || !path) return undefined;
  const parts = String(path).split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

/**
 * Build a stable dedupe key from trigger + payload. Each trigger type
 * picks its own identifying fields — if an event can legitimately fire
 * a rule multiple times (same quote issued again after a revise) the
 * caller should include the revision/count in the key.
 */
function buildEventKey(triggerName, payload) {
  switch (triggerName) {
    // ---- Quote lifecycle (inline) ------------------------------------
    case 'quote.issued':
      // Include status so 'issued' and 'revision_issued' don't collapse
      // if we ever re-issue the same quote row.
      return `quote.issued:${payload?.quote?.id}:${payload?.quote?.status}:${payload?.quote?.submitted_at ?? ''}`;
    case 'quote.accepted':
    case 'quote.rejected':
    case 'quote.expired':
      // Terminal statuses on a quote only happen once, so (trigger,
      // quote_id) is a stable key — but include updated_at as a tie-
      // breaker in case a quote somehow bounces through the status.
      return `${triggerName}:${payload?.quote?.id}:${payload?.quote?.updated_at ?? ''}`;
    case 'quote.revised':
      // New revision creates a fresh quote row, so quote.id alone is
      // enough — no two revise events collapse.
      return `quote.revised:${payload?.quote?.id}`;

    // ---- Opportunity lifecycle ---------------------------------------
    case 'opportunity.stage_changed':
      return `stage_changed:${payload?.opportunity?.id}:${payload?.stage_from ?? ''}:${payload?.stage_to ?? ''}`;

    // ---- Job lifecycle (inline) --------------------------------------
    case 'oc.issued':
      // Include oc_number so an amended OC (rare) doesn't collapse
      // with the original issuance.
      return `oc.issued:${payload?.job?.id}:${payload?.job?.oc_number ?? ''}`;
    case 'ntp.issued':
      return `ntp.issued:${payload?.job?.id}:${payload?.job?.ntp_number ?? ''}`;

    // Change orders (universal; replaces the refurb supplemental loop).
    case 'change_order.issued':
      // Keyed on quote id + status so each rev fires its own submit task.
      return `change_order.issued:${payload?.quote?.id}:${payload?.quote?.status ?? ''}:${payload?.quote?.submitted_at ?? ''}`;
    case 'change_order.amended_oc_issued':
      // Keyed on change_order id + revision so successive amended-OC
      // re-issues each create their own submit task.
      return `change_order.amended_oc_issued:${payload?.change_order?.id}:${payload?.change_order?.amended_oc_number ?? ''}:${payload?.change_order?.amended_oc_revision ?? ''}`;
    case 'authorization.received':
      return `authorization.received:${payload?.job?.id}:${payload?.job?.authorization_received_at ?? ''}`;
    case 'job.handed_off':
      return `job.handed_off:${payload?.job?.id}:${payload?.job?.handed_off_at ?? ''}`;
    case 'job.completed':
      // Jobs can only flip to 'complete' once per lifetime, so id alone
      // is stable.
      return `job.completed:${payload?.job?.id}`;

    // ---- Tasks -------------------------------------------------------
    case 'task.completed':
      return `task.completed:${payload?.task?.id}:${payload?.task?.completed_at ?? ''}`;

    // ---- Cron sweeps -------------------------------------------------
    // Bucketed by the sweep window (YYYY-MM-DD) carried in payload.bucket
    // so rules can re-fire daily ("remind me every day until I act").
    case 'quote.expiring_soon':
      return `quote.expiring_soon:${payload?.quote?.id}:${payload?.bucket ?? ''}`;
    case 'task.overdue':
      return `task.overdue:${payload?.task?.id}:${payload?.bucket ?? ''}`;
    case 'opportunity.stalled':
      return `opportunity.stalled:${payload?.opportunity?.id}:${payload?.bucket ?? ''}`;
    case 'price_build.stale':
      return `price_build.stale:${payload?.cost_build?.id}:${payload?.bucket ?? ''}`;

    // ---- System ------------------------------------------------------
    case 'system.error':
      return `system.error:${payload?.error?.code ?? ''}:${payload?.error?.dedupe_key ?? uuid()}`;

    default:
      // Fall back to a random key so unmatched events still work but
      // don't dedupe.
      return `${triggerName}:${uuid()}`;
  }
}

/**
 * Create a task (activity row) + reminder rows + fire row, all in one
 * D1 batch. Returns true if the task was created (or an earlier fire
 * already exists and the INSERT-OR-IGNORE correctly skipped), false
 * if something failed.
 */
async function createTaskFromRule({ env, rule, template, payload, user, eventKey }) {
  // Dedupe: if a fire already exists for (rule_id, event_key), bail out.
  const prior = await one(
    env.DB,
    'SELECT id FROM task_rule_fires WHERE rule_id = ? AND event_key = ?',
    [rule.id, eventKey]
  );
  if (prior) return false;

  const tz = rule.tz || 'America/Chicago';
  const subject = renderTemplate(template.title, payload);
  const body = template.body ? renderTemplate(template.body, payload) : null;
  if (!subject) return false;

  const assignee =
    resolveAssignee(template.assignee, payload) ??
    payload?.trigger?.user?.id ??
    user?.id ??
    null;

  const dueIso = computeDueAt(template.due_at, tz);
  const dueDateOnly = dueIso ? dueIso.slice(0, 10) : null; // activities.due_at is date-granular

  // Link back to whichever entity the template named.
  const linkKind = template.link;
  const oppId =
    (linkKind === 'opportunity' && payload?.opportunity?.id) ||
    payload?.opportunity?.id ||
    null;
  const quoteId =
    (linkKind === 'quote' && payload?.quote?.id) ||
    payload?.quote?.id ||
    null;
  const accountId =
    (linkKind === 'account' && payload?.account?.id) ||
    payload?.account?.id ||
    null;

  const taskId = uuid();
  const fireId = uuid();
  const ts = now();

  // Circular FK between activities.source_fire_id and task_rule_fires.task_id
  // means we can't satisfy both in a single INSERT-order. D1 checks FKs
  // immediately per-statement, so we:
  //   1) insert task_rule_fires with task_id = NULL
  //   2) insert activities with source_fire_id = fireId (now valid)
  //   3) update task_rule_fires to set task_id = taskId
  const statements = [
    stmt(
      env.DB,
      `INSERT OR IGNORE INTO task_rule_fires (id, rule_id, event_key, fired_at, task_id)
       VALUES (?, ?, ?, ?, NULL)`,
      [fireId, rule.id, eventKey, ts]
    ),
    stmt(
      env.DB,
      `INSERT INTO activities (
         id, opportunity_id, account_id, quote_id,
         type, subject, body, status, due_at,
         assigned_user_id, created_at, updated_at, created_by_user_id,
         source_rule_id, source_fire_id
       ) VALUES (?, ?, ?, ?, 'task', ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
      [
        taskId, oppId, accountId, quoteId,
        subject, body, dueDateOnly,
        assignee, ts, ts, user?.id ?? null,
        rule.id, fireId,
      ]
    ),
    stmt(
      env.DB,
      `UPDATE task_rule_fires SET task_id = ? WHERE id = ?`,
      [taskId, fireId]
    ),
    auditStmt(env.DB, {
      entityType: 'activity',
      entityId: taskId,
      eventType: 'created',
      user,
      summary: `Auto-created task via rule "${rule.name}": ${subject}`,
      changes: { source_rule_id: rule.id, trigger: rule.trigger },
    }),
  ];

  // Reminders — one row per offset. Absolute fires_at precomputed so
  // the sweep is a simple SELECT without needing to parse DSL again.
  const reminderOffsets = Array.isArray(template.reminders) ? template.reminders : [];
  for (const offset of reminderOffsets) {
    const firesAtIso = computeReminderFireAt(offset, dueIso, tz);
    if (!firesAtIso || !assignee) continue;
    statements.push(
      stmt(
        env.DB,
        `INSERT INTO task_reminders
           (id, activity_id, user_id, fires_at, source_rule_id, source_fire_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [uuid(), taskId, assignee, firesAtIso, rule.id, fireId]
      )
    );
  }

  try {
    await batch(env.DB, statements);
    return true;
  } catch (err) {
    console.error('auto-tasks: batch insert failed:', err?.message || err);
    return false;
  }
}

/**
 * Compute an absolute reminder fires_at from a negative-offset DSL
 * anchored to due_at.
 *
 * Examples:
 *   '-1d@09:00' → due_at's date minus 1 day at 09:00 local
 *   '-2h'       → due_at minus 2 hours
 *   '-30m'      → due_at minus 30 minutes
 *
 * If dueIso is null, falls back to now()+offset interpreted as a
 * positive delta (i.e. a reminder "2 hours from creation").
 */
function computeReminderFireAt(offset, dueIso, tz) {
  if (!offset) return null;
  const s = String(offset).trim().toLowerCase();
  // Match: optional minus, number, unit [dhm], optional @time
  const m = /^(-?)(\d+)([dhm])(?:@(\d{1,2}):(\d{2})|@cob)?$/.exec(s);
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  const n = Number(m[2]);
  const unit = m[3];
  const hh = m[4] !== undefined ? Number(m[4]) : (s.endsWith('@cob') ? 17 : null);
  const mm = m[5] !== undefined ? Number(m[5]) : (s.endsWith('@cob') ? 0 : null);

  const anchor = dueIso ? new Date(dueIso) : new Date();
  if (unit === 'h') return new Date(anchor.getTime() + sign * n * 3600 * 1000).toISOString();
  if (unit === 'm') return new Date(anchor.getTime() + sign * n * 60 * 1000).toISOString();

  // unit === 'd' — day math preserves wall-clock, so extract local,
  // shift day count, optionally override HH:MM.
  const p = getLocalParts(anchor, tz);
  let day = p.day + sign * n;
  let hour = hh !== null ? hh : p.hour;
  let minute = mm !== null ? mm : p.minute;
  const utc = localToUtc({ year: p.year, month: p.month, day, hour, minute }, tz);
  if (!utc || isNaN(utc.getTime())) return null;
  return utc.toISOString();
}

/**
 * Extract year/month/day/hour/minute in the given IANA timezone using
 * Intl.DateTimeFormat. Month is 1-12, day 1-31, hour 0-23.
 */
function getLocalParts(date, tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(date).map((p) => [p.type, p.value])
  );
  // Intl sometimes emits hour '24' for midnight — normalize.
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour,
    minute: Number(parts.minute),
  };
}

/**
 * Convert a local wall-clock (year/month/day/hour/minute in tz) to a
 * UTC Date by computing the tz offset at that instant. Uses a two-pass
 * approach to stay correct across DST transitions:
 *   1) Start with a naive UTC built from the local components.
 *   2) Look up what that UTC instant is displayed as in tz.
 *   3) Compute delta between the target local time and the displayed
 *      local time; that delta is the DST offset correction.
 */
function localToUtc({ year, month, day, hour = 0, minute = 0 }, tz) {
  // Normalize out-of-range day values by trusting Date's arithmetic.
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
  const asLocal = getLocalParts(new Date(naive), tz);
  // Difference between what the naive UTC *displays* in tz and what we
  // actually want; subtract that to arrive at the true UTC instant.
  const targetUTC = Date.UTC(year, month - 1, day, hour, minute, 0);
  const shownUTC  = Date.UTC(
    asLocal.year, asLocal.month - 1, asLocal.day,
    asLocal.hour, asLocal.minute, 0
  );
  const offsetMs = shownUTC - targetUTC;
  return new Date(naive - offsetMs);
}

/**
 * Return JavaScript weekday (0=Sun...6=Sat) for a given calendar date
 * (interpreted in local — since it's just day arithmetic, tz drift on
 * weekday boundaries is negligible for our DSL use case).
 */
function weekdayOf(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

// ---------------------------------------------------------------------
// Reminder sweep — called from /notifications/unread every 30s
// ---------------------------------------------------------------------

/**
 * Fire any due reminders owned by this user. Called inside
 * /notifications/unread so the in-app notification poll double-duties
 * as the reminder cron (Cloudflare Pages has no native cron).
 *
 * Each fired reminder:
 *   1) Creates a notifications row targeting the assignee.
 *   2) Stamps task_reminders.fired_at + notification_id so it doesn't
 *      fire twice.
 *
 * Cheap: indexed on fires_at with WHERE fired_at IS NULL. Typical call
 * touches zero rows.
 */
export async function sweepDueRemindersForUser(env, userId) {
  if (!env?.DB || !userId) return 0;

  const due = await all(
    env.DB,
    `SELECT r.id            AS rem_id,
            r.activity_id   AS activity_id,
            r.fires_at,
            a.subject       AS subject,
            a.due_at        AS task_due_at,
            a.opportunity_id,
            a.quote_id,
            a.account_id,
            o.number        AS opp_number,
            o.title         AS opp_title
       FROM task_reminders r
       JOIN activities a ON a.id = r.activity_id
  LEFT JOIN opportunities o ON o.id = a.opportunity_id
      WHERE r.user_id = ?
        AND r.fired_at IS NULL
        AND r.fires_at <= ?
      ORDER BY r.fires_at ASC
      LIMIT 20`,
    [userId, now()]
  );

  let fired = 0;
  for (const row of due) {
    try {
      const title = row.subject
        ? `Reminder: ${row.subject}`
        : 'Task reminder';
      const body = row.opp_number
        ? `${row.opp_number} ${row.opp_title || ''} — due ${row.task_due_at || 'soon'}`
        : `Due ${row.task_due_at || 'soon'}`;
      const linkUrl = row.opportunity_id
        ? `/opportunities/${row.opportunity_id}`
        : `/activities/${row.activity_id}`;

      const notifId = await notify(env.DB, {
        userId,
        type: 'task_reminder',
        title,
        body,
        linkUrl,
        entityType: 'activity',
        entityId: row.activity_id,
      });

      await run(
        env.DB,
        `UPDATE task_reminders
            SET fired_at = ?, notification_id = ?
          WHERE id = ? AND fired_at IS NULL`,
        [now(), notifId, row.rem_id]
      );
      fired++;
    } catch (err) {
      console.error('reminder sweep: failed for row', row.rem_id, err?.message || err);
    }
  }

  return fired;
}

// ---------------------------------------------------------------------
// Convenience: system.error reporter
// ---------------------------------------------------------------------

/**
 * Report a system-level error so any matching auto-task rules fire.
 * Safe to call from inside a catch block — swallows its own failures.
 *
 * @param {object} env       Cloudflare env.
 * @param {string} code      Short machine code, e.g. 'pdf_generation_failed'.
 * @param {object} detail    { summary, detail, context, user, quote, opportunity, ... }
 *                           'summary' is a short human headline; 'detail' is
 *                           the longer body (often err.message); 'context'
 *                           is a free-text blob with stack / inputs.
 *                           Any quote/opportunity/account entity on the
 *                           detail object gets forwarded in the payload so
 *                           rules can link the resulting task.
 */
export async function reportError(env, code, detail = {}) {
  try {
    const payload = {
      trigger: {
        user: detail.user ?? null,
        at: now(),
      },
      error: {
        code,
        summary: detail.summary ?? code,
        detail: detail.detail ?? '',
        context: typeof detail.context === 'string'
          ? detail.context
          : JSON.stringify(detail.context ?? {}),
        dedupe_key: detail.dedupe_key ?? null,
      },
      quote: detail.quote ?? null,
      opportunity: detail.opportunity ?? null,
      account: detail.account ?? null,
    };
    await fireEvent(env, 'system.error', payload, detail.user);
  } catch (err) {
    console.error('reportError failed:', err?.message || err);
  }
}
