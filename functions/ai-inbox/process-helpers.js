// functions/ai-inbox/process-helpers.js
//
// v3 orchestration: an entry has N attachments, each gets processed
// independently into captured_text, all the captured_texts get
// compiled into a single "context" string, the LLM extracts structure
// from that, and the resolver matches extracted entities against
// existing CRM rows.
//
//   For each non-ready attachment:
//     attachment-processor → captured_text + status='ready'
//   Compile context from ready+included attachments
//   Extract structure from context → extracted_json on entry
//   Resolve people/orgs → ai_inbox_entity_matches
//
// Per-attachment failures are isolated: one failed PDF doesn't block the
// rest of the entry's extraction. The entry only flips to status='error'
// if extraction itself fails. Resolver failure is best-effort and stays
// silent so a bad mention doesn't fail the whole pipeline.

import { one, all, run, stmt, batch } from '../lib/db.js';
import { uuid, now } from '../lib/ids.js';
import { extract } from './prompts.js';
import { resolveEntities } from '../lib/entity-resolver.js';
import { processAttachment, compileContext } from './attachment-processors.js';

/**
 * Process an AI Inbox entry end-to-end.
 *
 * @param {object} env
 * @param {string} entryId
 * @param {'attachments'|'extract'} [fromStep='attachments']
 *   - 'attachments' (default): process every attachment that isn't
 *     already ready, then extract + resolve
 *   - 'extract': skip attachment processing, just re-run extract +
 *     resolve over whatever captured_text is already cached. Useful
 *     when only the prompt has changed.
 *
 * Legacy values 'transcribe' / 'classify' are aliased to 'attachments'
 * so any old caller (or stored job that resumes mid-flight) still works.
 */
export async function processItem(env, entryId, fromStep = 'attachments') {
  const entry = await one(
    env.DB,
    'SELECT * FROM ai_inbox_items WHERE id = ?',
    [entryId]
  );
  if (!entry) throw new Error(`Entry not found: ${entryId}`);

  // Normalize legacy step names.
  if (fromStep === 'transcribe' || fromStep === 'classify') fromStep = 'attachments';

  // ------------ Step 1: Process attachments ------------
  if (fromStep === 'attachments') {
    await setStatus(env.DB, entryId, 'transcribing'); // generic "processing attachments" status

    const attachments = await loadAttachments(env.DB, entryId);
    if (attachments.length === 0) {
      // No attachments to process. Could be a brand-new entry that hasn't
      // had any attachment uploaded yet, or a legacy entry that for some
      // reason has no attachment row. Either way we can't extract from
      // nothing — fail visibly.
      await failItem(env.DB, entryId, 'Entry has no attachments to process.');
      throw new Error('Entry has no attachments to process.');
    }

    const toProcess = attachments.filter((a) => a.status !== 'ready');
    for (const att of toProcess) {
      try {
        await processAttachment(env, att);
      } catch (e) {
        // Per-attachment failure logged on the attachment row itself by
        // its processor. Keep going so other attachments still process.
        console.warn(`[ai-inbox] attachment ${att.id} failed:`, e?.message || e);
      }
    }

    // Mirror the primary audio attachment's captured_text into the
    // entry's legacy raw_transcript / transcription_model columns for
    // backward compatibility. v1/v2 readers (and the current detail
    // page) still look at these. A later migration will drop them.
    const refreshed = await loadAttachments(env.DB, entryId);
    const primaryAudio = refreshed.find(
      (a) => a.kind === 'audio' && a.is_primary === 1 && a.status === 'ready'
    );
    if (primaryAudio && primaryAudio.captured_text) {
      await run(
        env.DB,
        `UPDATE ai_inbox_items
            SET raw_transcript = ?, transcription_model = ?, updated_at = ?
          WHERE id = ?`,
        [primaryAudio.captured_text, primaryAudio.captured_text_model || null, now(), entryId]
      );
    }

    fromStep = 'extract';
  }

  // ------------ Step 2: Extract ------------
  let extracted = null;
  if (fromStep === 'extract') {
    const attachments = await loadAttachments(env.DB, entryId);
    const context = compileContext(attachments);
    if (!context) {
      await failItem(env.DB, entryId, 'No attachment text available to extract from.');
      throw new Error('No attachment text available to extract from.');
    }

    await setStatus(env.DB, entryId, 'extracting');
    try {
      // contextType is now always 'other' — the v1 classify step is
      // gone. extract() still accepts the param for backward compat
      // with prompts.js.
      extracted = await extract(env, context, 'other', entry.user_context);
      await run(
        env.DB,
        `UPDATE ai_inbox_items
            SET extracted_json = ?, status = 'ready', error_message = NULL, updated_at = ?
          WHERE id = ?`,
        [JSON.stringify(extracted), now(), entryId]
      );
    } catch (e) {
      await failItem(env.DB, entryId, `Extraction failed: ${e.message || e}`);
      throw e;
    }
  }

  // ------------ Step 3: Entity resolution (best-effort) ------------
  if (extracted) {
    try {
      const candidates = await resolveEntities(env.DB, {
        people: extracted.people || [],
        organizations: extracted.organizations || [],
      });
      if (candidates.length > 0) {
        const ts = now();
        const stmts = [
          // Re-runs replace non-overridden rows; user-confirmed picks survive.
          stmt(env.DB,
            'DELETE FROM ai_inbox_entity_matches WHERE item_id = ? AND user_overridden = 0',
            [entryId]),
          ...candidates.map((c) => stmt(env.DB,
            `INSERT INTO ai_inbox_entity_matches
               (id, item_id, mention_kind, mention_text, mention_idx,
                ref_type, ref_id, ref_label, score, rank,
                auto_resolved, user_overridden, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
            [uuid(), entryId, c.mention_kind, c.mention_text, c.mention_idx,
             c.ref_type, c.ref_id, c.ref_label, c.score, c.rank,
             c.auto_resolved, ts, ts])),
        ];
        await batch(env.DB, stmts);
      }
    } catch (e) {
      console.warn(`[ai-inbox] entity resolver failed for ${entryId}:`, e?.message || e);
    }
  }

  // Return the extraction so callers (e.g. the wizard's Smart-start
  // panel) can map it to their own form fields without re-reading
  // from the DB. Existing callers ignore the return — additive.
  return extracted;
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

async function loadAttachments(db, entryId) {
  return all(
    db,
    `SELECT id, entry_id, kind, sort_order, is_primary, include_in_context,
            r2_key, mime_type, size_bytes, filename,
            captured_text, captured_text_model, status, error_message,
            answers_question, created_at, updated_at
       FROM ai_inbox_attachments
      WHERE entry_id = ?
      ORDER BY sort_order, created_at`,
    [entryId]
  );
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
