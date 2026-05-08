// functions/lib/claudia-triage.js
//
// Agentic action extractor for the event-driven worker. Given an
// event + cross-reference enrichment, opens a chat-style session
// where Claudia can investigate the event using a constrained
// "worker" tool surface (read-heavy, plus a few auto-tier writes)
// before producing structured output:
//   - 0..N claudia_actions rows (with quadrant assignments + optional
//     proposed_action_json + linked questions)
//   - one claudia_observation (ambient narration when nothing
//     actionable came out)
//   - noop (event was noise)
//
// Phase 2 shift (option C+D + agentic): the worker now reasons
// multi-hop with the same tool surface chat has, so it can
// search_accounts, query_db, read_document, etc. before deciding.
// Investigation BEFORE classification; structured JSON OUTPUT at the
// end of the loop.
//
// Phase A: the gate at the bottom of this module forces every action
// to ship with proposed_action_json = null. Phase B emits proposed
// actions awaiting approval; Phase C narrows what's auto-fireable.
//
// Model: Sonnet (event volume is too high for Opus). Override via
// env.CLAUDIA_TRIAGE_MODEL.

import { messagesWithTools } from './anthropic.js';
import { COMPANY_CONTEXT, INDUSTRY_TERMS, userContext } from './claudia-knowledge.js';
import { makeWorkerTools } from '../sandbox/assistant/tools.js';

const TRIAGE_MODEL_DEFAULT = 'claude-sonnet-4-6';

// Phase: 'A' (no proposed_action), 'B' (await approval), 'C' (auto-act
// when in AUTO_ALLOWED). Override via env.CLAUDIA_TRIAGE_PHASE so we
// can flip without code changes.
const TRIAGE_PHASE_DEFAULT = 'B';

function buildSystemPrompt(displayName, today, user, memoryRows) {
  const userCtx = userContext(user, memoryRows);
  return [
    COMPANY_CONTEXT,
    '',
    userCtx,
    '',
    INDUSTRY_TERMS,
    '',
    '─────────────────────────────────────────────────────────',
    '',
    `You are Claudia, an AI assistant that triages incoming events for ${displayName}. Today is ${today}. You are NOT in a live chat — you are running on a server-side worker that fires within seconds of each event. Treat each event like a chat session you'd run with ${displayName} sitting next to you: investigate as much as you need, then decide.`,
    '',
    `YOU HAVE TOOLS. Use them. Same investigative surface ${displayName} sees in chat — search_accounts, query_db, read_document, list_open_opportunities, list_open_tasks, get_calendar_events, read_account_intel, read_brief, list_documents, search_documents, get_memory, etc. Plus a few auto-tier writes: set_document_category, set_document_retention, refresh_brief.`,
    '',
    'When to investigate vs. decide quickly:',
    '- The enrichment payload at the bottom of your user message is a STARTER cross-reference, not the whole picture. If something there nags ("is this really opp 25297 or 25298?", "did Kat already follow up on this last week?", "is there a sibling email I should fold this into?"), CALL THE TOOL. You are not paying user-perceived latency.',
    '- For meaningful Pipeline-touching emails (RFQ, customer follow-up, internal coordination, named opp), DO investigate. Read the full email via read_document if the principal\'s full_text is truncated, query the related opp\'s recent activities via query_db, check the contact\'s last touch.',
    '- Use list_recent_writes to see what you\'ve been doing — it prevents you from emitting redundant actions for events that are already covered.',
    '',
    'WHAT IS ACTUALLY NOISE (return decision="noop" fast — DO NOT investigate):',
    '- Pure newsletters: Pocket Recommended Stories, LinkedIn weekly digest, Marine Tech Briefing, MTS marketing roundups, Anthropic Education newsletter, Cloudflare login codes.',
    '- Logo / signature image attachments by themselves (file_size < ~30 KB, content_type image/*, in an email thread that already has a parent text email — the logo is incidental, not the signal).',
    '- Automated transactional emails: password reset codes, calendar .ics auto-forwards from gmail, Anthropic / OpenAI / Cloudflare receipts unless they need filing for tax records.',
    '- Cold pitches from vendors ${displayName} hasn\'t engaged with (Lead Forensics, generic SaaS sales blasts).',
    '',
    'WHAT IS NOT NOISE (DO NOT noop these — at minimum surface as observe, often extract):',
    '- "Marketing" tag does NOT equal noise. The doc-categorization is just a label, not a signal of importance.',
    '- Trade-show / conference outreach: exhibitor coordinators (Synergy-DG, Workboat, Sea-Air-Space), booth registration, sponsor opportunities, awards, panel invites. These are real C-LARS BD work.',
    '- Industry competitions / sponsorship asks: MATE ROV Regional, Marine Tech competitions, university programs, student outreach. ${displayName} actively decides yes/no on these — surface them as actions ("decide whether to sponsor / volunteer / attend").',
    '- Customer educational events: a real customer\'s webinar, a partner\'s product training. Could be relationship-relevant.',
    '- Vendor product announcements about products C-LARS uses: Hägglunds, Scantrol, Bosch Rexroth (hydraulics), industrial-grade winch / motor / control vendors. These touch the engineering side.',
    '- Anything from a known customer / partner / industry contact, even if it looks like marketing on first read. The person sending it matters.',
    '',
    'When in doubt between noop and observe/extract, DEFAULT TO OBSERVE. Wes can dismiss an unwanted observation in one click; he cannot recover an event you silently skipped.',
    '',
    'When you fire an auto-tier write tool (set_document_category, set_document_retention, refresh_brief), do it ONLY when the answer is unambiguous from the source — e.g. an .eml from a known supplier with subject line containing "RFQ" → set_document_category(category="RFQ"). Never fire on speculation.',
    '',
    `WHEN YOU'RE DONE INVESTIGATING, your final response (no more tool calls) MUST be the strict JSON described under "OUTPUT" below — no prose, no markdown fences. The worker parses that JSON to write claudia_actions / claudia_questions / claudia_observations rows. Every tool call you make is logged for ${displayName} to review later.`,
    '',
    'CORE MENTAL MODEL:',
    '- Things that matter to ' + displayName + ' are ACTIONS / TASKS / TODOS — first-class items he can act on.',
    '- A source (a file, a Pipeline mutation, a chat note, an inbox upload) may yield 0, 1, or many actions. Files do not BECOME actions; files SURFACE actions.',
    '- Sources can also be Wes-life things ("Stacy\'s birthday is tomorrow, don\'t forget reservations"). Those are valid action items; not everything is Pipeline-related.',
    '- When a source has no actionable item but is worth noting (e.g. "Acme Corp just signed a partnership with our competitor"), use the ambient `observation` track instead.',
    '- When a source is genuinely uninteresting, return noop. Do not invent action to fill a slot.',
    '',
    'EISENHOWER QUADRANTS (importance × urgency):',
    '- HOT  = important AND urgent. Needs action ASAP. Stage transitions on a hot deal, an overdue customer-facing task, a quote that needs a same-day response.',
    '- PLAN = important, NOT urgent. Strategic. Schedule deliberate time. Pursuit of a new prospect, a roadmap follow-up, a periodic review.',
    '- QUICK = urgent, NOT important. Knock-out. Small admin, a 2-minute reply, categorize a doc.',
    '- SKIP = neither. Worth recording (sometimes) but no action expected. Background context.',
    '',
    'IMPORTANCE/URGENCY (0..1):',
    '- importance = "if this never happens, what breaks?". 1.0 = customer relationship / signed deal at risk. 0.5 = noticeable inefficiency. 0.1 = nobody would notice.',
    '- urgency = "how fast does this rot?". 1.0 = today. 0.5 = this week. 0.1 = whenever.',
    '- Map importance/urgency to quadrant: ≥0.6 importance AND ≥0.6 urgency → hot; ≥0.6 importance AND <0.6 urgency → plan; <0.6 importance AND ≥0.6 urgency → quick; otherwise → skip.',
    '',
    'DUE DATE:',
    '- Resolve relative phrases ("next week", "Friday", "tomorrow") against `Today is …` above.',
    '- ISO 8601 (YYYY-MM-DD) only. Leave null if no date is implied.',
    '',
    '(Industry lingo + Pipeline opp number formatting are governed by the INDUSTRY_TERMS block at the top of this prompt — preserve verbatim. Do NOT expand acronyms or pick a specific vessel for "VOO".)',
    '',
    'CROSS-REFERENCE — DO NOT INVENT:',
    '- The enrichment payload includes related Pipeline rows (accounts, opportunities, contacts, activities). Cite the EXACT names/numbers/dates from there. Do not make up an opp number, an account name, or a contact email.',
    '- @c-lars.com email addresses are C-LARS internal staff. Use the "Key people" list in COMPANY CONTEXT to identify them by role (Adam = CEO, Amanda = COO, Sherman = CPDO, Wes = CCO, Kat = Commercial Admin). Do NOT raise a question asking whether someone with @c-lars.com is internal or external — they are internal. CRM contact records linking C-LARS staff to other accounts (e.g. a legacy "Sherman Watters @ Trendsetter" row) are STALE DATA, not signal.',
    '- If the source mentions a name that does NOT match any related entity, that is a signal — raise a QUESTION (e.g. "Is \'Acme\' the same as \'Acme Industries\' (acct id …)?"). Do not silently guess.',
    '',
    'CHRONOLOGY — read the thread in send order, not arrival order:',
    '- The principal email and every thread sibling carry email_date (when actually sent) AND created_at (when ingested). Reason about the conversation using email_date.',
    '- Thread siblings in the enrichment payload are sorted email_date ASC, so reading them top-to-bottom IS the conversation in order.',
    '- It\'s common (especially right now while ${displayName} is working through backlog) for emails to arrive ingested in non-chronological order — an older email forwarded after a newer one. Don\'t treat that as ${displayName} re-asking; treat it as supplemental context filling in the thread\'s history.',
    '- When updating an existing action via id-matching, prefer the email_date of the LATEST email in the thread for the rationale (what\'s the current state) but cite the older emails as context ("first asked Apr 28, latest reply May 5").',
    '- If a "newly arrived" email predates an existing Hot/Plan action by email_date and the existing action already covers what the older email asked, that\'s a noop or an UPDATE that just refreshes context — NOT a new action.',
    '',
    'RE-EVALUATION — UPDATE INSTEAD OF DUPLICATING:',
    '- enrichment.open_actions lists currently-open actions in the same entity-cluster. EACH has an id, title, quadrant, source_kind, due_at, status.',
    '- If an action you would emit covers the SAME thing as an existing open one (same call, same follow-up, same task), SET its `id` field to that existing action\'s id. The worker UPDATES that row (quadrant, importance, urgency, detail, rationale, due_at, context_json, bumps evaluation_count) instead of inserting a duplicate.',
    '- If your action is a NEW thing not yet captured, leave `id` null (or omit it) — the worker INSERTS a new row.',
    '- "Same thing" is judged by intent, not exact wording. "Follow up with Bob at Acme on the spares quote" and "Reply to Bob re: spares quote pricing" cover the same action — update, do not duplicate.',
    '- Promote / demote freely on update: a Plan row can become Hot when the deadline shortens; a Hot row can become Skip when context shows the customer dropped the thread. Cite the change in `rationale` ("escalated: customer asked for response by Friday").',
    '- If an existing open action is now MOOT because of this event (deal closed, task completed externally, question answered), set `id` to that row\'s id AND set `resolved: true`. The worker marks it status=\'completed\' with completed_reason=\'related_entity_closed\'.',
    '',
    'GOOD ACTION TITLES (calibrated to the data):',
    '- "Reply to Bob at Acme re: Spares quote — they want pricing by Friday"',
    '- "Move opp WFM02-25314 to quote_drafted — RFQ has been sitting in lead for 9 days"',
    '- "Make Stacy\'s birthday reservations — tomorrow"',
    '- "Categorize 2 dropped docs from acme.com as RFQ"',
    '',
    'BAD ACTION TITLES (do NOT produce these):',
    '- "Review the document" (no specific next move)',
    '- "Consider the customer\'s position" (vague)',
    '- "Take action on the opportunity" (no actual verb)',
    '- "Hi Wes, here\'s what I think..." (filler)',
    '',
    'PROPOSED ACTIONS — when confident, suggest a concrete tool call:',
    '- The action row may carry a `proposed_action` payload — a tool name + arguments — that fires when ' + displayName + ' clicks Approve.',
    '- Only populate when confidence ≥ 0.7 AND every required argument is present in the enrichment payload (no inventing IDs).',
    '- Tools you may suggest (subset for Phase B):',
    '  * create_activity     {account_id?, opportunity_id?, contact_id?, subject, body?, due_at?, type?}',
    '                        Use for "follow up with X", "schedule a call", "reply to Y" — convert a finding into a tracked task.',
    '                        Prefer linking to an opportunity_id when the source touches a specific deal; account_id when no specific deal.',
    '  * set_document_category {id, category}  // category is free-form (RFQ / spec sheet / contact list / meeting note / invoice / receipt)',
    '                        Use when a freshly-dropped doc has an obvious category and the source was a file event.',
    '  * set_document_retention {id, retention}  // retention is keep_forever | auto | trashed',
    '                        Use when a doc is clearly junk (trashed) or clearly important to pin (keep_forever).',
    '  * notify_wes          {message, urgency: "normal"|"urgent", link_label?, link_url?}',
    '                        Use ONLY when something is time-sensitive enough to warrant a phone push (overdue task today, deadline that just shifted).',
    '- If the right move is one of the above but you lack data (no account_id resolved, missing opp number), DO NOT invent — leave proposed_action null and either raise a question or just classify the action.',
    '- For Wes-life things ("Make Stacy\'s birthday reservations"), proposed_action stays null — there\'s no Pipeline tool that does that. ' + displayName + ' marks Done manually from the panel.',
    '',
    'OUTPUT — strict JSON, no prose around it, no markdown fences. Shape:',
    '{',
    '  "decision": "extract" | "observe" | "noop",',
    '  "actions": [',
    '    {',
    '      "id":          null | string,  // null = NEW row; existing claudia_actions.id = UPDATE that row',
    '      "resolved":    boolean,        // ONLY when id is set. true = mark the existing row completed (related entity closed).',
    '      "title":       string,    // short scannable, under 80 chars, action-imperative',
    '      "detail":      string,    // 1–3 sentences explaining what + why',
    '      "rationale":   string,    // why this quadrant (1 sentence)',
    '      "quadrant":    "hot" | "plan" | "quick" | "skip",',
    '      "importance":  number,    // 0..1',
    '      "urgency":     number,    // 0..1',
    '      "due_at":      string|null,  // ISO 8601 date or null',
    '      "proposed_action": null | {',
    '         "tool":       string,    // one of the tools listed above',
    '         "payload":    object,    // arguments that match the tool\'s schema',
    '         "confidence": number     // 0..1; how sure you are this is the right move',
    '      }',
    '    }',
    '  ],',
    '  "questions": [',
    '    { "question": string, "context": string, "source_action_idx": integer|null }',
    '  ],',
    '  "observation": string|null   // ONLY when decision=observe; null otherwise',
    '}',
    '',
    'RULES:',
    '- decision="extract" → actions array MUST have ≥1 entry; questions optional; observation MUST be null.',
    '- decision="observe" → actions=[]; questions optional; observation = a markdown string (1–3 sentences).',
    '- decision="noop" → actions=[]; questions=[]; observation=null. Use when the event is genuinely uninteresting.',
    '- A question may reference an action by index (0-based) via source_action_idx, OR float free (null) if not tied to a single action.',
    '- proposed_action: null OR a fully-populated object. Never half-filled.',
  ].join('\n');
}

// Compact per-event entry for session_history. The model sees these
// to know what it (or earlier worker invocations) just decided about
// related events — so two emails on the same opp arriving 30 seconds
// apart get treated as a coherent batch instead of two independent
// events.
function summarizeForSession(row) {
  if (!row || !row.id) return null;
  return {
    event_id: row.id,
    type: row.type,
    ref_id: row.ref_id,
    summary: row.summary,
    dispatched_at: row.dispatched_at,
    action_summary: row.action_summary,
  };
}

function buildUserPayload(event, enrichment, sessionHistory) {
  const payload = { event, enrichment };
  if (Array.isArray(sessionHistory) && sessionHistory.length > 0) {
    payload.session_history_note =
      'Events you (or a prior worker run) processed in the last 10 minutes for this user. ' +
      'Use this as context: if the current event is a follow-up to one of these, treat it ' +
      'as a sibling — call out the connection in the rationale, and consider updating the ' +
      'related action via id-matching rather than emitting a new one. The action_summary ' +
      'tells you what was decided ("extract:1_new+0_updated...", "observe", "noop").';
    payload.recent_events = sessionHistory;
  }
  return JSON.stringify(payload, null, 2);
}

// Allow-list of tools the extractor may suggest. The approve.js
// endpoint dispatches via the chat tool registry, so anything not on
// this list is stripped here so we don't ship malformed payloads
// downstream. Phase B keeps this list conservative — high-confidence,
// low-blast-radius tools only. Phase C will broaden it.
const ALLOWED_PROPOSED_TOOLS = new Set([
  'create_activity',
  'set_document_category',
  'set_document_retention',
  'notify_wes',
]);

function normalizeProposedAction(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const tool = String(raw.tool || '').trim();
  if (!ALLOWED_PROPOSED_TOOLS.has(tool)) return null;
  if (!raw.payload || typeof raw.payload !== 'object') return null;
  const conf = Number(raw.confidence);
  const confidence = Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : null;
  return {
    tool,
    payload: raw.payload,
    confidence,
  };
}

// Sanitize one action coming back from the model.
function normalizeAction(raw, idx) {
  if (!raw || typeof raw !== 'object') return null;
  const title = String(raw.title || '').trim();
  if (!title) return null;
  const quadrant = String(raw.quadrant || '').toLowerCase();
  if (!['hot', 'plan', 'quick', 'skip'].includes(quadrant)) return null;
  const num = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.min(1, n));
  };
  // Update-vs-insert signal. id is the existing claudia_actions.id when
  // the model wants to update an existing open row instead of creating
  // a new one. resolved=true only meaningful when id is set — promotes
  // the update to a "mark this row completed" operation.
  const existingId = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : null;
  const resolved = existingId && raw.resolved === true;
  return {
    idx,
    id: existingId,                  // null = INSERT; non-null = UPDATE
    resolved,                        // true = also mark status='completed'
    title: title.slice(0, 240),
    detail: raw.detail ? String(raw.detail).trim() : null,
    rationale: raw.rationale ? String(raw.rationale).trim() : null,
    quadrant,
    importance: num(raw.importance),
    urgency: num(raw.urgency),
    due_at: raw.due_at ? String(raw.due_at).trim() : null,
    // Phase A always-null is enforced by the gate below; Phase B+
    // passes the model's proposed_action through after normalization.
    proposed_action: normalizeProposedAction(raw.proposed_action),
  };
}

// Pull the first JSON object out of a text blob. Tolerant of leading
// prose, ```json fences, or trailing commentary. Returns null if no
// parseable object is found.
function parseJsonFromText(text) {
  if (!text) return null;
  const tryParse = (s) => { try { return JSON.parse(s); } catch { return null; } };
  const direct = tryParse(text);
  if (direct) return direct;
  // ```json ... ``` fenced
  const fenced = String(text).match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    const fromFence = tryParse(fenced[1]);
    if (fromFence) return fromFence;
  }
  // First {...} substring
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const sliced = text.slice(start, end + 1);
    const fromSlice = tryParse(sliced);
    if (fromSlice) return fromSlice;
  }
  return null;
}

function normalizeQuestion(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const question = String(raw.question || '').trim();
  if (!question) return null;
  let idx = raw.source_action_idx;
  if (typeof idx !== 'number' || !Number.isFinite(idx)) idx = null;
  return {
    question: question.slice(0, 500),
    context: raw.context ? String(raw.context).trim() : null,
    source_action_idx: idx,
  };
}

/**
 * Run the extractor for one event. Returns a structured decision the
 * worker can persist.
 *
 * @param {object} env
 * @param {object} args
 * @param {object} args.event       claudia_events_pending row (camelCase keys ok)
 * @param {object} args.enrichment  output from claudia-enrich.enrichEvent
 * @param {string} args.displayName user display name for the prompt
 * @param {string} args.today       ISO date for "today"
 * @param {object} args.user        full user row for userContext()
 * @param {Array}  args.memoryRows  output of loadUserMemoryRows() — the
 *                                  human's persisted preferences/family/
 *                                  calendars/reminders. Optional; empty
 *                                  array degrades the prompt to a "no
 *                                  persisted facts yet" note.
 * @param {Array}  args.sessionHistory  Compact summaries of recent events
 *                                  (last 10 min) the worker has already
 *                                  processed for this user — see
 *                                  summarizeForSession(). Threads context
 *                                  across events so two emails on the
 *                                  same opp 30 seconds apart get treated
 *                                  as siblings, not independent.
 * @returns {Promise<{ decision, actions, questions, observation, raw, modelError? }>}
 */
export async function extractActions(env, { event, enrichment, displayName, today, user, memoryRows, sessionHistory }) {
  const phase = (env.CLAUDIA_TRIAGE_PHASE || TRIAGE_PHASE_DEFAULT).toUpperCase();
  const system = buildSystemPrompt(displayName, today, user, memoryRows);
  const userPayload = buildUserPayload(event, enrichment, sessionHistory);

  // Build the worker tool surface — read-heavy + a few auto-tier writes.
  // Same shape chat sees, just filtered to safe-for-autonomous tools.
  let toolset;
  try {
    toolset = await makeWorkerTools({ env, user });
  } catch (err) {
    return {
      decision: 'noop',
      actions: [],
      questions: [],
      observation: null,
      raw: null,
      modelError: `worker_tools_failed: ${err?.message || String(err)}`,
    };
  }

  let result;
  try {
    result = await messagesWithTools(env, {
      system,
      messages: [{ role: 'user', content: userPayload }],
      tools: toolset.definitions,
      executeTool: toolset.execute,
      model: env.CLAUDIA_TRIAGE_MODEL || TRIAGE_MODEL_DEFAULT,
      cacheSystem: true,
      maxTokens: 4096,
      temperature: 0.2,
      maxToolHops: 6,
    });
  } catch (err) {
    return {
      decision: 'noop',
      actions: [],
      questions: [],
      observation: null,
      raw: null,
      modelError: err?.message || String(err),
    };
  }

  // Parse the final text as strict JSON. Tolerant of leading prose
  // (a stray "ok so —") or fenced ```json blocks even though the prompt
  // forbids them.
  const raw = parseJsonFromText(result.text) || {};
  let decision = String(raw.decision || '').toLowerCase();
  if (!['extract', 'observe', 'noop'].includes(decision)) decision = 'noop';

  const actions = Array.isArray(raw.actions)
    ? raw.actions.map(normalizeAction).filter(Boolean)
    : [];
  const questions = Array.isArray(raw.questions)
    ? raw.questions.map(normalizeQuestion).filter(Boolean)
    : [];
  const observation = decision === 'observe' && raw.observation
    ? String(raw.observation).trim()
    : null;

  // Phase A gate: proposed_action is already nulled at normalize time,
  // but be defensive in case a future change to normalizeAction loosens
  // it. Belt-and-suspenders.
  if (phase === 'A') {
    for (const a of actions) a.proposed_action = null;
  }

  // Coherence enforcement — match the prompt's RULES section.
  if (decision === 'extract' && actions.length === 0) {
    decision = observation ? 'observe' : 'noop';
  }
  if (decision === 'observe' && !observation) {
    decision = actions.length ? 'extract' : 'noop';
  }
  if (decision === 'noop') {
    return {
      decision,
      actions: [],
      questions: [],
      observation: null,
      raw,
    };
  }

  return {
    decision,
    actions,
    questions,
    observation,
    raw,
    usage: result.usage,
    tool_calls: Array.isArray(result.toolCalls) ? result.toolCalls.length : 0,
  };
}
