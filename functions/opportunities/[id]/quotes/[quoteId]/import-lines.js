// functions/opportunities/[id]/quotes/[quoteId]/import-lines.js
//
// POST /opportunities/:id/quotes/:quoteId/import-lines
//
// Accepts a file upload (CSV, Excel, PDF, image, text), extracts
// text from it, sends to Claude to identify line items, and returns
// a JSON array of proposed lines for the user to review before
// adding to the quote.

import { messagesJson } from '../../../../lib/anthropic.js';

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

// ---------- Text extraction from file buffer ----------

const TEXT_EXTENSIONS = new Set(['txt', 'md', 'csv', 'tsv', 'log', 'json', 'xml', 'html']);
const CONVERT_FORMATS = { pdf: 'pdf', docx: 'docx', doc: 'doc', rtf: 'rtf', odt: 'odt', ppt: 'ppt', pptx: 'pptx', xls: 'xls', xlsx: 'xlsx' };
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tiff', 'heic', 'heif']);

async function extractText(env, file, filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();

  // Plain text files — read directly.
  if (TEXT_EXTENSIONS.has(ext)) {
    return await file.text();
  }

  // Images — use Claude vision OCR.
  if (IMAGE_EXTENSIONS.has(ext)) {
    const buffer = await file.arrayBuffer();
    const base64 = toBase64(buffer);
    const mimeMap = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', tiff: 'image/tiff', heic: 'image/heic', heif: 'image/heif' };
    const mediaType = mimeMap[ext] || 'image/png';
    const result = await messagesJson(env, {
      model: env.AI_INBOX_OCR_MODEL || undefined,
      system: 'Extract all text from this image. Return JSON: {"text": "...extracted text..."}. If the image contains a table, preserve the structure with tabs or pipes between columns.',
      user: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
        { type: 'text', text: 'Extract all text from this image as JSON.' },
      ],
      maxTokens: 4096,
    });
    return result.json?.text || result.text || '';
  }

  // Binary documents — send directly to Claude as a document.
  // Claude natively reads PDF and can handle DOCX/XLS as base64.
  const CLAUDE_DOC_TYPES = {
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    doc: 'application/msword',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    rtf: 'application/rtf',
    odt: 'application/vnd.oasis.opendocument.text',
  };
  const docMediaType = CLAUDE_DOC_TYPES[ext];
  if (!docMediaType) {
    throw new Error(`Unsupported file format: .${ext}`);
  }
  const buffer = await file.arrayBuffer();
  const base64 = toBase64(buffer);
  const result = await messagesJson(env, {
    model: env.AI_INBOX_EXTRACT_MODEL || undefined,
    system: 'Extract all text content from this document. Return JSON: {"text": "...all extracted text..."}. Preserve table structure using tabs between columns and newlines between rows.',
    user: [
      { type: 'document', source: { type: 'base64', media_type: docMediaType, data: base64 } },
      { type: 'text', text: 'Extract all text from this document as JSON.' },
    ],
    maxTokens: 8192,
  });
  return result.json?.text || result.text || '';
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
  const { env, request, params } = context;

  let formData;
  try {
    formData = await request.formData();
  } catch {
    return json({ ok: false, error: 'Expected multipart form with a file field.' }, 400);
  }

  const file = formData.get('file');
  if (!file || typeof file === 'string') {
    return json({ ok: false, error: 'No file uploaded.' }, 400);
  }

  const filename = file.name || 'upload';
  if (file.size > 50 * 1024 * 1024) {
    return json({ ok: false, error: 'File too large (max 50 MB).' }, 400);
  }

  try {
    // Step 1: Extract text from the file.
    const text = await extractText(env, file, filename);
    if (!text || text.trim().length < 10) {
      return json({ ok: false, error: 'Could not extract usable text from the file.' }, 400);
    }

    // Step 2: Send to Claude for line item extraction.
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
