// functions/lib/anthropic.js
//
// Thin Anthropic Messages API client used by every text → structure call
// (classification, extraction, narrative generation, NBA, etc.). Audio
// transcription stays on OpenAI Whisper / gpt-4o-transcribe — see
// functions/lib/openai.js.
//
// Design choices:
//   * No SDK. Plain fetch() so the bundle stays zero-deps (matches doc-generate.js
//     and the existing ai-inbox prompts.js).
//   * Routes through Cloudflare AI Gateway when AI_GATEWAY_* is set (see
//     ai-gateway.js). Wire format is identical either way.
//   * Prompt caching is opt-in per system message. Long, stable system
//     prompts (governance rules, schema descriptions) should pass
//     `cacheSystem: true` so subsequent calls within the 5-min cache TTL
//     pay ~10% of the input cost. See:
//     https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
//   * `messagesJson()` returns parsed JSON; the caller is responsible for
//     post-validation. We use Claude's `tool_use` / `response_format`-style
//     pattern by asking for strict JSON in the system prompt and parsing
//     the first text block.

import { aiBaseUrl } from './ai-gateway.js';

// Default models. Overridable via env so we can swap per-step without code
// changes. Anthropic SDK doesn't ship a "version" header per route — the
// 2023-06-01 API version is what every Messages call needs.
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_FAST_MODEL = 'claude-haiku-4-5-20251001';
const ANTHROPIC_VERSION = '2023-06-01';

function requireKey(env) {
  const key = env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not configured.');
  return key;
}

/**
 * Send a Messages request and return Claude's parsed response.
 *
 * @param {object} env
 * @param {object} opts
 * @param {string} opts.system          System prompt
 * @param {string} opts.user            User message (single text turn)
 * @param {string} [opts.model]         Override the default model
 * @param {number} [opts.maxTokens]     Default 2048
 * @param {number} [opts.temperature]   Default 0.2
 * @param {boolean} [opts.cacheSystem]  Mark system prompt with cache_control
 * @returns {Promise<{text: string, model: string, usage: object}>}
 */
export async function messages(env, opts) {
  const key = requireKey(env);
  const model = opts.model || env.ANTHROPIC_MODEL || DEFAULT_MODEL;

  const systemBlock = opts.cacheSystem
    ? [{ type: 'text', text: opts.system, cache_control: { type: 'ephemeral' } }]
    : opts.system;

  const body = {
    model,
    max_tokens: opts.maxTokens ?? 2048,
    temperature: opts.temperature ?? 0.2,
    system: systemBlock,
    messages: [{ role: 'user', content: opts.user }],
  };

  const url = `${aiBaseUrl(env, 'anthropic')}/messages`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`Anthropic messages failed (${resp.status}): ${detail.slice(0, 500)}`);
  }

  const data = await resp.json();
  const text = (data?.content || [])
    .filter((b) => b?.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();

  if (!text) throw new Error('Anthropic messages returned no text content.');

  return { text, model, usage: data?.usage || {} };
}

/**
 * Send a Messages request and parse the response as JSON. The system prompt
 * MUST instruct the model to return strict JSON (no prose, no markdown).
 * The first { ... } block in the response is parsed; if extraction fails
 * we throw so the caller can fall through to the existing error path.
 */
export async function messagesJson(env, opts) {
  const result = await messages(env, opts);
  const json = parseFirstJsonBlock(result.text);
  if (!json) {
    throw new Error(`Anthropic messages returned invalid JSON: ${result.text.slice(0, 300)}`);
  }
  return { ...result, json };
}

/**
 * Pull the first JSON object out of a string. Tolerant of leading prose or
 * a fenced ```json block, both of which Claude occasionally adds despite a
 * "return strict JSON" system prompt.
 */
function parseFirstJsonBlock(text) {
  const direct = tryParse(text);
  if (direct) return direct;

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    const fromFence = tryParse(fenced[1]);
    if (fromFence) return fromFence;
  }

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const slice = text.slice(start, end + 1);
    const fromSlice = tryParse(slice);
    if (fromSlice) return fromSlice;
  }
  return null;
}

function tryParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export const ANTHROPIC_MODELS = {
  default: DEFAULT_MODEL,
  fast: DEFAULT_FAST_MODEL,
};
