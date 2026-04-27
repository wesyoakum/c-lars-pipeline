// functions/ai-inbox/prompts.js
//
// All OpenAI calls for the AI Inbox feature live here so route handlers
// stay focused on HTTP concerns and the prompts can be tuned in one place.
//
// Three steps:
//   1. transcribe(env, audioBlob, opts) — POST audio bytes to the
//      audio/transcriptions endpoint. Returns plain text.
//   2. classify(env, transcript)        — chat completion that returns
//      one of CONTEXT_TYPES.
//   3. extract(env, transcript, contextType, userContext)
//                                       — type-specific JSON extraction.
//
// Calls are split (rather than one combined) so each can be retried
// independently and we can swap models per step. We use plain fetch()
// against the OpenAI REST API to keep zero npm dependencies (matches
// how ConvertAPI is called from functions/lib/doc-generate.js).

export const CONTEXT_TYPES = [
  'quick_note',
  'meeting',
  'trade_show',
  'personal_note',
  'other',
];

const CONTEXT_TYPE_DESCRIPTIONS = {
  quick_note:
    'A brief voice memo to self. Tasks, reminders, ideas, observations. Usually short.',
  meeting:
    'A 1-on-1 or group meeting (in person, conference room, or Teams/Zoom). Multiple speakers. Decisions, action items, owners.',
  trade_show:
    'A short conversation at a trade show or industry event. Person + company + role + need + follow-up.',
  personal_note:
    'Personal reflection, journal, study notes, ideas not tied to business. Not a task list.',
  other:
    'Anything that does not clearly fit the above categories.',
};

// Default models. Overridable via environment variables.
const DEFAULT_TRANSCRIPTION_MODEL = 'gpt-4o-mini-transcribe';
const DEFAULT_CLASSIFY_MODEL = 'gpt-4o-mini';
const DEFAULT_EXTRACT_MODEL = 'gpt-4o';

const OPENAI_BASE = 'https://api.openai.com/v1';

function requireKey(env) {
  const key = env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is not configured.');
  return key;
}

/**
 * Transcribe an audio file via OpenAI's audio/transcriptions endpoint.
 *
 * @param {object} env  Pages Functions env (must contain OPENAI_API_KEY)
 * @param {File|Blob} audioBlob  Audio bytes (with .name + .type set on File)
 * @param {object} [opts]
 * @param {string} [opts.model]  Transcription model override
 * @returns {Promise<{text: string, model: string}>}
 */
export async function transcribe(env, audioBlob, opts = {}) {
  const key = requireKey(env);
  const model = opts.model || env.AI_INBOX_TRANSCRIPTION_MODEL || DEFAULT_TRANSCRIPTION_MODEL;

  const form = new FormData();
  form.append('file', audioBlob, audioBlob.name || 'audio.m4a');
  form.append('model', model);
  form.append('response_format', 'text');

  const resp = await fetch(`${OPENAI_BASE}/audio/transcriptions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}` },
    body: form,
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`OpenAI transcription failed (${resp.status}): ${detail.slice(0, 500)}`);
  }

  const text = (await resp.text()).trim();
  return { text, model };
}

/**
 * Classify a transcript into one of CONTEXT_TYPES.
 * Returns the type string. Falls back to 'other' if the model
 * returns something unexpected.
 */
export async function classify(env, transcript) {
  const key = requireKey(env);
  const model = env.AI_INBOX_CLASSIFY_MODEL || DEFAULT_CLASSIFY_MODEL;

  const typeList = CONTEXT_TYPES
    .map((t) => `- ${t}: ${CONTEXT_TYPE_DESCRIPTIONS[t]}`)
    .join('\n');

  const system = [
    'You classify a voice transcript into exactly one of these context types:',
    typeList,
    '',
    'Return strict JSON: {"context_type": "<one of the types above>"}.',
    'No explanation. No additional fields.',
  ].join('\n');

  const resp = await chatJson(env, {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: transcript.slice(0, 8000) },
    ],
  });

  const type = String(resp?.context_type || '').trim().toLowerCase();
  return CONTEXT_TYPES.includes(type) ? type : 'other';
}

/**
 * Type-specific structured extraction. Returns the parsed JSON object
 * matching the schema described in the system prompt.
 */
export async function extract(env, transcript, contextType, userContext) {
  const key = requireKey(env);
  const model = env.AI_INBOX_EXTRACT_MODEL || DEFAULT_EXTRACT_MODEL;

  const system = buildExtractionPrompt(contextType);
  const userMsg = buildUserMessage(transcript, userContext);

  const resp = await chatJson(env, {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userMsg },
    ],
  });

  return normalizeExtraction(resp);
}

// ---------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------

async function chatJson(env, body) {
  const key = requireKey(env);
  const resp = await fetch(`${OPENAI_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      ...body,
      response_format: { type: 'json_object' },
      temperature: 0.2,
    }),
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`OpenAI chat failed (${resp.status}): ${detail.slice(0, 500)}`);
  }

  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenAI chat returned no content.');

  try {
    return JSON.parse(content);
  } catch (e) {
    throw new Error(`OpenAI chat returned invalid JSON: ${content.slice(0, 300)}`);
  }
}

function buildUserMessage(transcript, userContext) {
  const parts = [];
  if (userContext && userContext.trim()) {
    parts.push(`User-provided context: ${userContext.trim()}`);
    parts.push('');
  }
  parts.push('Transcript:');
  parts.push(transcript);
  return parts.join('\n');
}

const COMMON_SCHEMA_BLOCK = `Return strict JSON with this exact shape:
{
  "title": "string — short, scannable title (under 80 chars)",
  "summary": "string — 1-3 sentence executive summary",
  "people": ["string"],
  "organizations": ["string"],
  "action_items": [
    { "task": "string", "owner": "string or empty", "due": "string or empty (ISO date if known)" }
  ],
  "open_questions": ["string"],
  "tags": ["string"],
  "suggested_destinations": [
    "keep_as_note" | "create_task" | "create_reminder" |
    "link_to_account" | "link_to_opportunity" | "archive"
  ],
  "confidence": "low" | "medium" | "high"
}

Rules:
- All array fields must be present (use [] when nothing applies).
- Use ISO 8601 dates (YYYY-MM-DD) when a date is mentioned; leave empty otherwise.
- Confidence reflects your confidence in the extraction overall, not in any one field.
- Do not invent people/organizations/dates that the transcript does not contain.
- No additional top-level fields.`;

function buildExtractionPrompt(contextType) {
  const focusGuidance = {
    quick_note:
      'Focus on tasks, reminders, ideas, and decisions the speaker is making to themselves. Action items often have no explicit owner — leave owner empty if it is just "me".',
    meeting:
      'Focus on decisions made, action items with owners, open questions, and follow-up dates. Multiple speakers; do not assume the recording user is the owner unless context makes that clear.',
    trade_show:
      'Focus on capturing each person/company encountered: name, company, role, expressed need or pain point, product interest, and required follow-up action. Tag with the company names. Suggested destinations should usually include create_task (for follow-up) and possibly link_to_account.',
    personal_note:
      'Focus on the main thought, any associated tasks, and tags useful for later search. Suggested destinations should default to keep_as_note unless explicit tasks/reminders are present.',
    other:
      'Extract the most useful structure you can. Default to keep_as_note unless tasks or reminders are clearly present.',
  };

  const focus = focusGuidance[contextType] || focusGuidance.other;

  return [
    `You extract structured data from voice transcripts. Context type: ${contextType}.`,
    '',
    focus,
    '',
    COMMON_SCHEMA_BLOCK,
  ].join('\n');
}

function normalizeExtraction(raw) {
  const arr = (v) => (Array.isArray(v) ? v.filter(Boolean) : []);
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const conf = ['low', 'medium', 'high'].includes(raw?.confidence) ? raw.confidence : 'medium';

  const actions = arr(raw?.action_items).map((a) => ({
    task: str(a?.task),
    owner: str(a?.owner),
    due: str(a?.due),
  })).filter((a) => a.task);

  return {
    title: str(raw?.title) || '(untitled)',
    summary: str(raw?.summary),
    people: arr(raw?.people).map(str).filter(Boolean),
    organizations: arr(raw?.organizations).map(str).filter(Boolean),
    action_items: actions,
    open_questions: arr(raw?.open_questions).map(str).filter(Boolean),
    tags: arr(raw?.tags).map(str).filter(Boolean),
    suggested_destinations: arr(raw?.suggested_destinations).map(str).filter(Boolean),
    confidence: conf,
  };
}
