// functions/ai-inbox/prompts.js
//
// All AI calls for the AI Inbox feature live here so route handlers stay
// focused on HTTP concerns and the prompts can be tuned in one place.
//
// Three steps:
//   1. transcribe(env, audioBlob)         — OpenAI audio/transcriptions
//   2. classify(env, transcript)          — Anthropic, returns one of CONTEXT_TYPES
//   3. extract(env, transcript, ...)      — Anthropic, type-specific JSON extraction
//
// Audio transcription stays on OpenAI Whisper / gpt-4o-transcribe (best
// in class for voice). Everything text-shaped runs on Anthropic for better
// JSON discipline + prompt caching. Both clients route through Cloudflare
// AI Gateway when configured — see functions/lib/ai-gateway.js.
//
// Phase 1 AI Inbox notes are "free-floating" (not yet linked to a specific
// account/opp), so we run them at share-mode 'full'. Pricing and PNs are
// still tokenized by the redaction layer regardless.

import { transcribeAudio } from '../lib/openai.js';
import { messagesJson, ANTHROPIC_MODELS } from '../lib/anthropic.js';
import { redactText, unredactJson } from '../lib/ai-redact.js';

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

/**
 * Transcribe an audio file. Thin wrapper over the shared OpenAI client so
 * the AI Inbox pipeline stays self-contained at the call sites.
 */
export async function transcribe(env, audioBlob, opts = {}) {
  return transcribeAudio(env, audioBlob, opts);
}

/**
 * Classify a transcript into one of CONTEXT_TYPES. Falls back to 'other'
 * if the model returns something unexpected.
 */
export async function classify(env, transcript) {
  const model = env.AI_INBOX_CLASSIFY_MODEL || ANTHROPIC_MODELS.fast;

  const typeList = CONTEXT_TYPES
    .map((t) => `- ${t}: ${CONTEXT_TYPE_DESCRIPTIONS[t]}`)
    .join('\n');

  const system = [
    'You classify a voice transcript into exactly one of these context types:',
    typeList,
    '',
    'Return strict JSON: {"context_type": "<one of the types above>"}.',
    'No prose, no markdown fences, no additional fields.',
  ].join('\n');

  // Free-floating note → mode 'full', no name replacements; pricing/PNs
  // tokenized automatically by redactText.
  const { text: redactedTranscript } = redactText(transcript.slice(0, 8000), { mode: 'full' });

  const { json } = await messagesJson(env, {
    model,
    system,
    user: redactedTranscript,
    cacheSystem: true,
    maxTokens: 64,
  });

  const type = String(json?.context_type || '').trim().toLowerCase();
  return CONTEXT_TYPES.includes(type) ? type : 'other';
}

/**
 * Type-specific structured extraction. Returns the parsed JSON object
 * matching the schema described in the system prompt, with redacted
 * tokens swapped back to real values.
 */
export async function extract(env, transcript, contextType, userContext) {
  const model = env.AI_INBOX_EXTRACT_MODEL || ANTHROPIC_MODELS.default;

  const system = buildExtractionPrompt(contextType);
  const userMsg = buildUserMessage(transcript, userContext);
  const { text: redactedUser, restoreMap } = redactText(userMsg, { mode: 'full' });

  const { json } = await messagesJson(env, {
    model,
    system,
    user: redactedUser,
    cacheSystem: true,
    maxTokens: 2048,
  });

  const restored = unredactJson(json, restoreMap);
  return normalizeExtraction(restored);
}

// ---------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------

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
- No prose, no markdown fences, no additional top-level fields.`;

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
