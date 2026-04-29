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
  // Today's date so the model can resolve relative date phrases like
  // "next week" or "Friday" into ISO 8601. Lives in the user message
  // (not the system prompt) so the system prompt stays cacheable.
  parts.push(`Today is ${todayIso()}.`);
  parts.push('');
  if (userContext && userContext.trim()) {
    parts.push(`User-provided context: ${userContext.trim()}`);
    parts.push('');
  }
  parts.push('Transcript:');
  parts.push(transcript);
  return parts.join('\n');
}

function todayIso() {
  // UTC date — Workers don't have a server timezone, and the user's
  // recordings can come from any timezone. ISO date in UTC is good
  // enough for resolving "next week" / "Friday" within a few hours
  // either way.
  return new Date().toISOString().slice(0, 10);
}

const COMMON_SCHEMA_BLOCK = `Return strict JSON with this exact shape:
{
  "title": "string — short, scannable title (under 80 chars). Do NOT include the company / customer / organization name; the title describes WHAT, not WHO. The org name is captured separately in 'organizations'. Examples — good: 'Spares quote on pump skid replacement', 'Trade-show debrief', 'EPS proposal follow-up'. Bad: 'Acme Corp - Spares quote' or 'Quote for Acme'.",
  "summary": "string — 1-3 sentence executive summary",
  "people": ["string — full name of each person mentioned"],
  "organizations": ["string — name of each company/org mentioned"],
  "people_detail": [
    {
      "name": "string — must match a string in 'people' exactly",
      "title": "string or empty",
      "email": "string or empty",
      "phone": "string or empty",
      "linkedin": "string or empty — full LinkedIn profile URL if mentioned",
      "organization": "string or empty — name of the org they belong to, if mentioned"
    }
  ],
  "organizations_detail": [
    {
      "name": "string — must match a string in 'organizations' exactly",
      "phone": "string or empty",
      "email": "string or empty",
      "website": "string or empty",
      "address": "string or empty"
    }
  ],
  "action_items": [
    { "task": "string", "owner": "string or empty", "due": "string or empty (ISO date if known)" }
  ],
  "open_questions": ["string"],
  "requirements": [
    { "text": "string — concise spec or requirement statement",
      "category": "performance | operational | interface | environmental | regulatory | commercial | other" }
  ],
  "tags": ["string"],
  "suggested_destinations": [
    "keep_as_note" | "create_task" | "create_reminder" |
    "link_to_account" | "link_to_opportunity" | "archive"
  ],
  "confidence": "low" | "medium" | "high"
}

Rules:
- All array fields must be present (use [] when nothing applies).
- people_detail: include ONE entry per name in 'people' that has at
  least one non-empty contact detail (title, email, phone, org). If
  none of those details are mentioned for a person, omit them from
  people_detail entirely (don't include rows full of empty strings).
- organizations_detail: same rule — only include orgs for which at
  least one non-name field is mentioned in the source text.
- Phone/email/title: only fill when the source text explicitly states
  them. Do not invent or guess. A business card or email signature is
  the most common source.
- LinkedIn URL: only include when the source text contains an
  explicit LinkedIn reference (e.g. "linkedin.com/in/jane-doe",
  "/in/jdoe", or a full URL on a business card). Format as a full URL
  starting with "https://www.linkedin.com/in/". Do not guess or
  generate URLs from a person's name alone — high confidence only.
- Use ISO 8601 dates (YYYY-MM-DD) when a date is mentioned. Resolve
  relative phrases ("next week", "Friday", "tomorrow", "in two weeks")
  using the "Today is …" line in the user message as the anchor.
  Leave the date field empty only when no date is implied at all.
- Action item owner: if the recorder uses first-person language
  ("I'll send", "I need to follow up", "we should call"), leave the
  owner field empty — the recorder is the implicit owner. Only fill
  owner when a specific other person is named ("Bob will reply").
- Requirements are technical specifications, performance criteria,
  capacities, ratings, certifications, depth/load/voltage/etc.
  ranges, environmental tolerances, commercial conditions, or any
  measurable customer constraint that would belong in an internal
  engineering spec sheet — NOT generic action items, opinions, or
  open questions. Examples: "10–20 ton load capacity", "Active
  heave compensation", "500 m water depth", "ABS class certified",
  "Lead time ≤ 30 weeks ARO". Include only items the source text
  actually states or implies as a constraint; do not invent or
  pad. Use [] when the entry has no technical specs.
- Requirements category: pick the closest of performance,
  operational, interface, environmental, regulatory, commercial,
  or other. When unsure, use "other".
- Confidence reflects your confidence in the extraction overall, not in any one field.
- Do not invent people/organizations/dates that the transcript does not contain.
- No prose, no markdown fences, no additional top-level fields.

Industry terms — preserve verbatim, do not expand or substitute:
- "VOO" or "vessel of opportunity" — a boat / ship / vessel that
  hasn't been chosen yet (or could vary). Used when a quote is for
  equipment going on a vessel TBD. If the user writes "VOO", keep
  "VOO". If they write "vessel of opportunity", keep that. Don't
  guess a specific vessel name to fill in.
- Other capitalized acronyms (EPS, ROV, OC, RFQ, etc.) — preserve
  case exactly as the user wrote them.`;

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

// Normalize a LinkedIn URL the LLM returned. Accepts:
//   - full URLs (https://www.linkedin.com/in/jane-doe[?...])
//   - shorthand starting with "linkedin.com/in/jane-doe"
//   - partial slugs starting with "/in/jane-doe"
//   - bare slugs ("jane-doe") — REJECTED, too risky to autocomplete
// Strips query strings and trailing slashes for stable comparison.
// Returns '' if the input doesn't look like a LinkedIn profile URL.
function normalizeLinkedinUrl(s) {
  if (!s) return '';
  let v = String(s).trim();
  if (!v) return '';
  // Drop the protocol if present so the matching is uniform.
  v = v.replace(/^https?:\/\//i, '');
  // Strip leading "www." or "m." subdomains.
  v = v.replace(/^(www\.|m\.)/i, '');
  // Normalize the path-only forms (linkedin.com/in/x) and the
  // already-stripped "/in/x" form.
  let slug = '';
  if (/^linkedin\.com\/in\//i.test(v)) {
    slug = v.replace(/^linkedin\.com\/in\//i, '');
  } else if (/^\/in\//i.test(v)) {
    slug = v.replace(/^\/in\//i, '');
  } else {
    return ''; // not a recognizable LinkedIn profile URL
  }
  // Drop query string + fragment + trailing slashes.
  slug = slug.split('?')[0].split('#')[0].replace(/\/+$/, '');
  if (!slug) return '';
  return 'https://www.linkedin.com/in/' + slug;
}

// Reformat a single-line address into mailing-label form. The LLM
// often returns "123 Main St., San Diego, CA" as one line; we want
//   123 Main St.
//   San Diego, CA
// — street on its own line, city + state/region (+ zip + country)
// joined on the next. Heuristic: split on commas, take the first
// part as the street line, join the rest with ", " on a second line.
// If the address is already multi-line (contains \n), leave it alone.
function normalizeAddressLines(s) {
  if (!s) return '';
  const trimmed = String(s).trim();
  if (!trimmed) return '';
  if (trimmed.indexOf('\n') >= 0) return trimmed;
  const parts = trimmed.split(/,\s*/).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return trimmed;
  return parts[0] + '\n' + parts.slice(1).join(', ');
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

  // people_detail / organizations_detail are optional rich-shape
  // companions to the people / organizations string arrays. They
  // carry the fields we want to push to a contact/account (title,
  // phone, email, website, address). Each entry must have at least
  // one non-empty non-name field; bare-name rows get filtered out
  // since the parallel `people` array already covers that.
  const peopleDetail = arr(raw?.people_detail).map((p) => ({
    name: str(p?.name),
    title: str(p?.title),
    email: str(p?.email),
    phone: str(p?.phone),
    linkedin: normalizeLinkedinUrl(str(p?.linkedin)),
    organization: str(p?.organization),
  })).filter((p) => p.name && (p.title || p.email || p.phone || p.linkedin || p.organization));

  const orgsDetail = arr(raw?.organizations_detail).map((o) => ({
    name: str(o?.name),
    phone: str(o?.phone),
    email: str(o?.email),
    website: str(o?.website),
    address: normalizeAddressLines(str(o?.address)),
  })).filter((o) => o.name && (o.phone || o.email || o.website || o.address));

  // Requirements — technical specs / performance criteria the LLM
  // pulled from the source text. Each entry needs non-empty text;
  // category is normalized to one of the known buckets, defaulting
  // to 'other' when missing or unrecognized.
  const REQ_CATS = new Set([
    'performance', 'operational', 'interface',
    'environmental', 'regulatory', 'commercial', 'other',
  ]);
  const requirements = arr(raw?.requirements).map((r) => {
    // Be tolerant — older prompts may emit a string array; coerce to
    // the {text, category} shape rather than dropping the data.
    if (typeof r === 'string') {
      return { text: r.trim(), category: 'other' };
    }
    const cat = str(r?.category).toLowerCase();
    return {
      text: str(r?.text),
      category: REQ_CATS.has(cat) ? cat : 'other',
    };
  }).filter((r) => r.text);

  return {
    title: str(raw?.title) || '(untitled)',
    summary: str(raw?.summary),
    people: arr(raw?.people).map(str).filter(Boolean),
    organizations: arr(raw?.organizations).map(str).filter(Boolean),
    people_detail: peopleDetail,
    organizations_detail: orgsDetail,
    action_items: actions,
    open_questions: arr(raw?.open_questions).map(str).filter(Boolean),
    requirements,
    tags: arr(raw?.tags).map(str).filter(Boolean),
    suggested_destinations: arr(raw?.suggested_destinations).map(str).filter(Boolean),
    confidence: conf,
  };
}
