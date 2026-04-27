// functions/lib/openai.js
//
// Thin OpenAI client. We use OpenAI for one thing only: audio
// transcription (Whisper / gpt-4o-transcribe). All text → structure work
// runs on Anthropic — see functions/lib/anthropic.js.
//
// Like the Anthropic client, this routes through Cloudflare AI Gateway
// when AI_GATEWAY_* is configured. Wire format is identical either way.

import { aiBaseUrl } from './ai-gateway.js';

function requireKey(env) {
  const key = env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is not configured.');
  return key;
}

/**
 * Transcribe an audio Blob/File via OpenAI's audio/transcriptions endpoint.
 *
 * @param {object} env
 * @param {File|Blob} audioBlob
 * @param {object} [opts]
 * @param {string} [opts.model]   Default 'gpt-4o-mini-transcribe'
 * @returns {Promise<{text: string, model: string}>}
 */
export async function transcribeAudio(env, audioBlob, opts = {}) {
  const key = requireKey(env);
  const model = opts.model || env.AI_INBOX_TRANSCRIPTION_MODEL || 'gpt-4o-mini-transcribe';

  const form = new FormData();
  form.append('file', audioBlob, audioBlob.name || 'audio.m4a');
  form.append('model', model);
  form.append('response_format', 'text');

  const url = `${aiBaseUrl(env, 'openai')}/audio/transcriptions`;
  const resp = await fetch(url, {
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
