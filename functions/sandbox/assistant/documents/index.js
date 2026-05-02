// functions/sandbox/assistant/documents/index.js
//
// POST /sandbox/assistant/documents
//   multipart/form-data with one or more `file` parts. Each file is
//   streamed to R2, text-extracted, and inserted into claudia_documents.
//   Returns the updated documents-panel HTML fragment for HTMX swap.
//
// GET /sandbox/assistant/documents
//   Returns the documents-panel HTML fragment (used after a retention
//   change so HTMX can re-render the list cleanly).
//
// Wes-only — same email gate as the rest of /sandbox/assistant.

import { all, run } from '../../../lib/db.js';
import { now, uuid } from '../../../lib/ids.js';
import {
  extractText,
  classifyContentType,
  isZip,
  expandZip,
  isMbox,
  expandMbox,
} from '../../../lib/claudia-extract.js';
import { renderDocumentsPanel } from '../../../lib/claudia-documents-render.js';
import { categorizeDocument } from '../../../lib/claudia-categorize.js';

const SANDBOX_OWNER = 'wes.yoakum@c-lars.com';
const MAX_BYTES = 25 * 1024 * 1024; // 25 MB per file

export async function onRequestPost(context) {
  const { env, data, request } = context;
  const user = data?.user;
  if (!user || user.email !== SANDBOX_OWNER) {
    return new Response('Not found', { status: 404 });
  }

  let formData;
  try {
    formData = await request.formData();
  } catch (err) {
    return htmlFragment(`<div class="claudia-doc-flash error">Bad upload: ${escapeHtml(err.message || 'invalid form')}</div>`);
  }

  const rawFiles = formData.getAll('file').filter((f) => f && typeof f === 'object' && 'arrayBuffer' in f);
  if (rawFiles.length === 0) {
    return htmlFragment(`<div class="claudia-doc-flash error">No files attached.</div>`);
  }

  const errors = [];

  // Expand any zip / mbox archives into their constituent files BEFORE
  // the per-file ingest loop. Each inner file becomes its own
  // claudia_documents row — better for granular search / dismiss / keep
  // than dumping a single archive blob.
  const files = [];
  for (const f of rawFiles) {
    if (isZip(f.type, f.name)) {
      try {
        const buf = await f.arrayBuffer();
        const inner = expandZip(buf);
        if (inner.length === 0) {
          errors.push(`${f.name}: zip is empty.`);
        } else {
          files.push(...inner);
        }
      } catch (err) {
        errors.push(`${f.name}: failed to unzip — ${err?.message || String(err)}`);
      }
      continue;
    }
    if (isMbox(f.type, f.name)) {
      try {
        const buf = await f.arrayBuffer();
        const inner = expandMbox(buf);
        if (inner.length === 0) {
          errors.push(`${f.name}: mbox contained no parseable messages.`);
        } else {
          files.push(...inner);
        }
      } catch (err) {
        errors.push(`${f.name}: failed to parse mbox — ${err?.message || String(err)}`);
      }
      continue;
    }
    files.push(f);
  }

  for (const file of files) {
    try {
      if (!classifyContentType(file.type, file.name)) {
        errors.push(`${file.name}: unsupported file type (${file.type || 'unknown'})`);
        continue;
      }
      if (file.size > MAX_BYTES) {
        errors.push(`${file.name}: too large (${formatBytes(file.size)} > 25 MB cap)`);
        continue;
      }

      const buffer = await file.arrayBuffer();
      const docId = uuid();
      const ts = now();
      const safeName = file.name.replace(/[^A-Za-z0-9._-]+/g, '_');
      const r2Key = `claudia-docs/${user.id}/${docId}/${safeName}`;

      // Stream original to R2.
      await env.DOCS.put(r2Key, buffer, {
        httpMetadata: { contentType: file.type || 'application/octet-stream' },
        customMetadata: {
          uploaded_by: user.id,
          original_filename: file.name,
        },
      });

      // Extract text. Failures are non-fatal — we still create the row
      // so the user sees the upload landed; the row's extraction_status
      // tells Claudia (and the UI) that the body is incomplete.
      let extracted = { text: '', status: 'error', error: 'not run' };
      try {
        extracted = await extractText(env, buffer, file.type, file.name);
      } catch (err) {
        extracted = { text: '', status: 'error', error: err?.message || String(err) };
      }

      // Auto-categorize. Cheap (Haiku, < 60 output tokens) — runs after
      // extraction so the model has the text to look at. Tries a regex
      // heuristic first to skip the LLM call when the answer is obvious
      // (filename keyword, .eml extension, etc.). Failures are silent;
      // category stays NULL and Wes / Claudia can fill it later via
      // set_document_category. Auto-categorize is NOT gated by the
      // set_document_category permission — that toggle controls
      // whether Claudia can OVERWRITE categories from chat.
      let category = null;
      try {
        category = await categorizeDocument(env, {
          filename: file.name,
          contentType: file.type,
          text: extracted.text,
        });
      } catch (err) {
        console.error('[upload] categorize failed:', err?.message || err);
      }

      await run(
        env.DB,
        `INSERT INTO claudia_documents
           (id, user_id, filename, content_type, size_bytes, r2_key,
            full_text, retention, extraction_status, extraction_error,
            category, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'auto', ?, ?, ?, ?, ?)`,
        [
          docId,
          user.id,
          file.name,
          file.type || null,
          file.size,
          r2Key,
          extracted.text || null,
          extracted.status,
          extracted.error || null,
          category,
          ts,
          ts,
        ]
      );
    } catch (err) {
      errors.push(`${file?.name || 'file'}: ${err?.message || String(err)}`);
    }
  }

  const docs = await loadDocs(env, user);
  return htmlFragment(renderDocumentsPanel(docs, { errors }));
}

export async function onRequestGet(context) {
  const { env, data } = context;
  const user = data?.user;
  if (!user || user.email !== SANDBOX_OWNER) {
    return new Response('Not found', { status: 404 });
  }
  const docs = await loadDocs(env, user);
  return htmlFragment(renderDocumentsPanel(docs));
}

async function loadDocs(env, user) {
  return all(
    env.DB,
    `SELECT id, filename, content_type, size_bytes, retention,
            extraction_status, extraction_error, created_at,
            substr(coalesce(full_text, ''), 1, 200) AS preview
       FROM claudia_documents
      WHERE user_id = ? AND retention != 'trashed'
      ORDER BY created_at DESC
      LIMIT 30`,
    [user.id]
  );
}

function htmlFragment(body) {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
