// functions/lib/claudia-triage.js
//
// Action extractor for the event-driven worker. Given an event +
// cross-reference enrichment, asks Claude to produce one of:
//   - 0..N claudia_actions rows (with quadrant assignments + optional
//     linked questions)
//   - one claudia_observation (ambient narration when nothing
//     actionable came out)
//   - noop (event was noise)
//
// Phase A: the gate at the bottom of this module forces every action
// to ship with proposed_action_json = null. The model can still
// suggest a tool call, but we strip it before persistence so nothing
// auto-executes. Phase B flips the gate; Phase C narrows it to the
// AUTO_ALLOWED set.
//
// Model: Sonnet (event volume is too high for Opus). Override via
// env.CLAUDIA_TRIAGE_MODEL.

import { messagesJson } from './anthropic.js';

const TRIAGE_MODEL_DEFAULT = 'claude-sonnet-4-6';

// Phase: 'A' (no proposed_action), 'B' (await approval), 'C' (auto-act
// when in AUTO_ALLOWED). Override via env.CLAUDIA_TRIAGE_PHASE so we
// can flip without code changes.
const TRIAGE_PHASE_DEFAULT = 'B';

function buildSystemPrompt(displayName, today) {
  return [
    `You are Claudia, an AI assistant that triages incoming events for ${displayName}. Today is ${today}. You are NOT in a chat — you are running on a server-side worker that fires within seconds of each event. Your job is to read ONE event + its cross-reference snapshot and produce structured output: actionable items (0..N), questions (0..N), or a single observation, or nothing at all.`,
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
    'INDUSTRY LINGO — PRESERVE VERBATIM:',
    '- "VOO" or "vessel of opportunity" — keep as written. Do NOT pick a specific vessel name.',
    '- Capitalized acronyms (EPS, ROV, OC, RFQ, NTP, BANT, IWOCS, EPS) — preserve exact case.',
    '- Pipeline opp numbers like WFM02-25314 / PMS25-25314 — keep with the dash and zero-padding the user wrote.',
    '',
    'CROSS-REFERENCE — DO NOT INVENT:',
    '- The enrichment payload includes related Pipeline rows (accounts, opportunities, contacts, activities). Cite the EXACT names/numbers/dates from there. Do not make up an opp number, an account name, or a contact email.',
    '- If the source mentions a name that does NOT match any related entity, that is a signal — raise a QUESTION (e.g. "Is \'Acme\' the same as \'Acme Industries\' (acct id …)?"). Do not silently guess.',
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

function buildUserPayload(event, enrichment) {
  return JSON.stringify(
    {
      event,
      enrichment,
    },
    null,
    2
  );
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
  return {
    idx,
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
 * @returns {Promise<{ decision, actions, questions, observation, raw, modelError? }>}
 */
export async function extractActions(env, { event, enrichment, displayName, today }) {
  const phase = (env.CLAUDIA_TRIAGE_PHASE || TRIAGE_PHASE_DEFAULT).toUpperCase();
  const system = buildSystemPrompt(displayName, today);
  const userPayload = buildUserPayload(event, enrichment);

  let result;
  try {
    result = await messagesJson(env, {
      system,
      user: userPayload,
      model: env.CLAUDIA_TRIAGE_MODEL || TRIAGE_MODEL_DEFAULT,
      cacheSystem: true,
      maxTokens: 2048,
      temperature: 0.2,
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

  const raw = result.json || {};
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
  };
}
