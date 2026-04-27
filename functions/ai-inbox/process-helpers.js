// functions/ai-inbox/process-helpers.js
//
// Orchestration for the three-step AI Inbox pipeline:
//   transcribe → classify → extract
//
// Each step writes its status and intermediate result back to D1 so a
// partial failure (e.g., transcribe ok, extract fails) is recoverable
// from the last good step. The caller passes an item id; we read the
// row, advance it through the steps, and persist along the way.

import { one, run } from '../lib/db.js';
import { now } from '../lib/ids.js';
import { transcribe, classify, extract } from './prompts.js';

/**
 * Process an AI Inbox item end-to-end. Reads the row, fetches the audio
 * from R2, runs the three OpenAI calls, and writes results back to D1.
 *
 * On any failure:
 *   - status is set to 'error'
 *   - error_message is recorded
 *   - the function still throws so the caller can decide whether to
 *     surface the error in the response or just redirect to the detail
 *     page (the route handler usually wants the latter).
 *
 * On success:
 *   - status='ready'
 *   - raw_transcript, context_type, extracted_json, transcription_model populated.
 *
 * If `fromStep` is provided ('transcribe' | 'classify' | 'extract'),
 * the pipeline starts from that step using whatever's already in the
 * row (used by the manual re-run endpoint).
 */
export async function processItem(env, itemId, fromStep = 'transcribe') {
  const item = await one(
    env.DB,
    'SELECT * FROM ai_inbox_items WHERE id = ?',
    [itemId]
  );
  if (!item) throw new Error(`Item not found: ${itemId}`);

  let transcript = item.raw_transcript || '';
  let model = item.transcription_model || null;
  let contextType = item.context_type || null;

  // ------------ Step 1: Transcribe ------------
  if (fromStep === 'transcribe') {
    await setStatus(env.DB, itemId, 'transcribing');
    try {
      const audioObj = await env.DOCS.get(item.audio_r2_key);
      if (!audioObj) throw new Error('Audio file missing in R2.');
      const audioBuffer = await audioObj.arrayBuffer();
      const blob = new Blob([audioBuffer], { type: item.audio_mime_type || 'audio/m4a' });
      // Tag the blob with a filename so the OpenAI multipart accepts it.
      const named = new File([blob], item.audio_filename || `audio.${guessExt(item.audio_mime_type)}`, {
        type: item.audio_mime_type || 'audio/m4a',
      });
      const result = await transcribe(env, named);
      transcript = result.text;
      model = result.model;
      await run(
        env.DB,
        `UPDATE ai_inbox_items
            SET raw_transcript = ?, transcription_model = ?, updated_at = ?
          WHERE id = ?`,
        [transcript, model, now(), itemId]
      );
    } catch (e) {
      await failItem(env.DB, itemId, `Transcription failed: ${e.message || e}`);
      throw e;
    }
    fromStep = 'classify';
  }

  // ------------ Step 2: Classify ------------
  if (fromStep === 'classify') {
    if (!transcript) {
      await failItem(env.DB, itemId, 'No transcript to classify.');
      throw new Error('No transcript to classify.');
    }
    await setStatus(env.DB, itemId, 'classifying');
    try {
      contextType = await classify(env, transcript);
      await run(
        env.DB,
        `UPDATE ai_inbox_items
            SET context_type = ?, updated_at = ?
          WHERE id = ?`,
        [contextType, now(), itemId]
      );
    } catch (e) {
      await failItem(env.DB, itemId, `Classification failed: ${e.message || e}`);
      throw e;
    }
    fromStep = 'extract';
  }

  // ------------ Step 3: Extract ------------
  if (fromStep === 'extract') {
    if (!transcript) {
      await failItem(env.DB, itemId, 'No transcript to extract from.');
      throw new Error('No transcript to extract from.');
    }
    await setStatus(env.DB, itemId, 'extracting');
    try {
      const extracted = await extract(env, transcript, contextType || 'other', item.user_context);
      await run(
        env.DB,
        `UPDATE ai_inbox_items
            SET extracted_json = ?, status = 'ready', error_message = NULL, updated_at = ?
          WHERE id = ?`,
        [JSON.stringify(extracted), now(), itemId]
      );
    } catch (e) {
      await failItem(env.DB, itemId, `Extraction failed: ${e.message || e}`);
      throw e;
    }
  }
}

async function setStatus(db, id, status) {
  await run(
    db,
    'UPDATE ai_inbox_items SET status = ?, updated_at = ? WHERE id = ?',
    [status, now(), id]
  );
}

async function failItem(db, id, message) {
  await run(
    db,
    'UPDATE ai_inbox_items SET status = ?, error_message = ?, updated_at = ? WHERE id = ?',
    ['error', String(message).slice(0, 1000), now(), id]
  );
}

function guessExt(mime) {
  if (!mime) return 'm4a';
  const m = String(mime).toLowerCase();
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('wav')) return 'wav';
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('flac')) return 'flac';
  if (m.includes('webm')) return 'webm';
  if (m.includes('mp4') || m.includes('m4a')) return 'm4a';
  return 'm4a';
}
