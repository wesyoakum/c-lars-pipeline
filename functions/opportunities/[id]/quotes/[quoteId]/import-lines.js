// functions/opportunities/[id]/quotes/[quoteId]/import-lines.js
//
// POST /opportunities/:id/quotes/:quoteId/import-lines
//
// Accepts a file upload, routes it through the AI Inbox pipeline
// for text extraction (same proven path as the inbox), then sends
// the extracted text to Claude for line-item extraction. The AI
// Inbox entry is persisted and linked to the quote for audit.

import { run, stmt, batch, all, one } from '../../../../lib/db.js';
import { uuid, now } from '../../../../lib/ids.js';
import { uploadToR2 } from '../../../../lib/r2.js';
import { processItem } from '../../../../ai-inbox/process-helpers.js';
import { messagesJson } from '../../../../lib/anthropic.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

const AUDIO_EXTS = new Set(['m4a', 'mp3', 'wav', 'webm', 'mp4', 'mpeg', 'mpga', 'ogg', 'flac']);
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'heic', 'heif', 'webp', 'bmp', 'tiff']);
const EMAIL_EXTS = new Set(['eml', 'msg']);
const DOCUMENT_EXTS = new Set([
  'pdf', 'docx', 'doc', 'rtf', 'odt', 'txt', 'md', 'csv', 'tsv', 'log',
  'json', 'xml', 'html', 'ppt', 'pptx', 'xls', 'xlsx',
]);

function inferKind(file) {
  const mime = (file.type || '').toLowerCase();
  const ext = ((file.name || '').split('.').pop() || '').toLowerCase();
  if (mime.startsWith('audio/') || mime === 'video/mp4' || AUDIO_EXTS.has(ext)) return 'audio';
  if (mime.startsWith('image/') || IMAGE_EXTS.has(ext)) return 'image';
  if (mime === 'message/rfc822' || EMAIL_EXTS.has(ext)) return 'email';
  return 'document';
}

// ---------- Line items extraction prompt ----------

const SYSTEM_PROMPT = `You are extracting line items from a document for a sales quote in a marine/subsea equipment company.

Return ONLY a JSON object with this exact shape:
{"lines": [<array of line item objects>]}

Each line item object:
{
  "title": "short item name or part number",
  "part_number": "part/SKU if identifiable, or empty string",
  "description": "detailed description",
  "quantity": <number, default 1>,
  "unit": "ea" | "hr" | "ft" | "lot" | "set" | etc.,
  "unit_price": <number or null if not found>,
  "notes": "any additional info (lead time, specs, conditions, or empty string)"
}

Rules:
- Extract EVERY line item — do not skip any
- If the document is a table or spreadsheet, each data row is a line item (skip header rows)
- If it's a narrative, email, or RFQ, identify each distinct item being requested
- Preserve part numbers, model numbers, and SKUs EXACTLY as written
- If quantity is not specified, default to 1
- If unit is not clear, default to "ea"
- If price is not in the document, set unit_price to null
- Notes should capture lead times, conditions, specs, or anything useful that does not fit other fields
- Do NOT include shipping, tax, or total rows as line items
- Do NOT include header/title rows as line items`;

// ---------- Handler ----------

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const oppId = params.id;
  const quoteId = params.quoteId;

  let formData;
  try {
    formData = await request.formData();
  } catch {
    return json({ ok: false, error: 'Expected multipart form with a file field.' }, 400);
  }

  const file = formData.get('file');
  if (!file || typeof file === 'string' || file.size === 0) {
    return json({ ok: false, error: 'No file uploaded.' }, 400);
  }
  if (file.size > 50 * 1024 * 1024) {
    return json({ ok: false, error: 'File too large (max 50 MB).' }, 400);
  }

  const filename = file.name || 'upload';
  const ext = (filename.split('.').pop() || '').toLowerCase();
  const kind = inferKind(file);
  const mime = file.type || '';

  try {
    // Step 1: Create an AI Inbox entry + attachment (same as /ai-inbox/new).
    const entryId = uuid();
    const attachmentId = uuid();
    const ts = now();
    const r2Key = `ai-inbox/${entryId}/${uuid()}.${ext || 'bin'}`;

    await uploadToR2(env.DOCS, r2Key, file, {
      entryId,
      kind,
      uploadedBy: user?.email || '',
    });

    await batch(env.DB, [
      stmt(env.DB,
        `INSERT INTO ai_inbox_items
           (id, user_id, created_at, updated_at, status, source, user_context)
         VALUES (?, ?, ?, ?, 'pending', 'quote_line_import', ?)`,
        [entryId, user?.id, ts, ts, `Import lines for quote ${quoteId}`]),
      stmt(env.DB,
        `INSERT INTO ai_inbox_attachments
           (id, entry_id, kind, sort_order, is_primary, include_in_context,
            r2_key, mime_type, size_bytes, filename,
            status, created_at, updated_at)
         VALUES (?, ?, ?, 0, 1, 1, ?, ?, ?, ?, 'pending', ?, ?)`,
        [attachmentId, entryId, kind, r2Key, mime || null, file.size, filename, ts, ts]),
      // Link the entry to the quote for audit trail.
      stmt(env.DB,
        `INSERT INTO ai_inbox_links
           (id, item_id, action_type, ref_type, ref_id, ref_label, created_at, created_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [uuid(), entryId, 'link_to_quote', 'quote', quoteId, `Quote line import: ${filename}`, ts, user?.id]),
    ]);

    // Step 2: Run the AI Inbox pipeline (processes attachment → captured_text).
    await processItem(env, entryId);

    // Step 3: Read the captured text.
    const attachment = await one(env.DB,
      `SELECT captured_text FROM ai_inbox_attachments
        WHERE entry_id = ? AND is_primary = 1 AND status = 'ready'`,
      [entryId]);

    const text = attachment?.captured_text || '';
    if (!text || text.trim().length < 10) {
      return json({ ok: false, error: 'Could not extract usable text from the file.', entry_id: entryId }, 400);
    }

    // Step 4: Send to Claude for line item extraction.
    const result = await messagesJson(env, {
      model: env.AI_INBOX_EXTRACT_MODEL || undefined,
      system: SYSTEM_PROMPT,
      cacheSystem: true,
      user: `Extract line items from this document:\n\n${text.slice(0, 30000)}`,
      maxTokens: 4096,
      temperature: 0.1,
    });

    const lines = Array.isArray(result.json?.lines) ? result.json.lines : [];

    return json({
      ok: true,
      lines: lines.map(l => ({
        title: String(l.title || '').trim(),
        part_number: String(l.part_number || '').trim(),
        description: String(l.description || '').trim(),
        quantity: typeof l.quantity === 'number' && l.quantity > 0 ? l.quantity : 1,
        unit: String(l.unit || 'ea').trim(),
        unit_price: typeof l.unit_price === 'number' ? l.unit_price : null,
        notes: String(l.notes || '').trim(),
      })),
      entry_id: entryId,
      source_text: text.slice(0, 500),
      model: result.model,
    });
  } catch (err) {
    return json({
      ok: false,
      error: 'Extraction failed: ' + (err?.message || String(err)),
    }, 500);
  }
}
