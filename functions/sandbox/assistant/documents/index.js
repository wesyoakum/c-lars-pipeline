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
import { emailMetadata, extractAttachments } from '../../../lib/claudia-mime.js';

const SANDBOX_OWNER = 'wes.yoakum@c-lars.com';
const MAX_BYTES = 25 * 1024 * 1024; // 25 MB per file
// Cap attachments per email so a single multi-MB email with 50 logos
// can't blow up the DB / R2.
const MAX_ATTACHMENTS_PER_EMAIL = 20;

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

      // Email-only structured extraction. Run alongside text extraction
      // (not after it) so we don't depend on the extractor's intermediate
      // representation. Pull headers + attachments straight from the raw
      // bytes via claudia-mime.js.
      const isEmail = isEmailFile(file.type, file.name);
      let emailMeta = null;
      let attachments = [];
      if (isEmail) {
        try {
          const rawText = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
          emailMeta = emailMetadata(rawText);
          attachments = extractAttachments(rawText).slice(0, MAX_ATTACHMENTS_PER_EMAIL);
        } catch (err) {
          // Headers / attachments are best-effort; full_text already landed.
          console.error('[upload] email meta failed:', err?.message || err);
        }
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

      const structuredData = emailMeta
        ? JSON.stringify({ kind: 'email', ...emailMeta, attachments_count: attachments.length })
        : null;

      // seq via correlated subquery — atomic per-user "next number".
      // The UNIQUE INDEX on (user_id, seq) catches the rare race where
      // two concurrent inserts compute the same MAX.
      await run(
        env.DB,
        `INSERT INTO claudia_documents
           (id, user_id, filename, content_type, size_bytes, r2_key,
            full_text, retention, extraction_status, extraction_error,
            category,
            sender_email, sender_name, subject, email_date, message_id,
            structured_data, parent_id,
            created_at, updated_at, seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'auto', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?,
           COALESCE((SELECT MAX(seq) FROM claudia_documents WHERE user_id = ?), 0) + 1)`,
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
          emailMeta?.sender_email || null,
          emailMeta?.sender_name || null,
          emailMeta?.subject || null,
          emailMeta?.email_date || null,
          emailMeta?.message_id || null,
          structuredData,
          ts,
          ts,
          user.id,
        ]
      );

      // Ingest each attachment as its own child row. Same R2 + extract +
      // categorize flow as the parent loop. Failures on a single
      // attachment fall through to the errors list and don't abort the
      // parent.
      for (const att of attachments) {
        try {
          await ingestAttachment(env, user, att, docId, errors);
        } catch (err) {
          errors.push(`${att.filename || 'attachment'}: ${err?.message || String(err)}`);
        }
      }
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
  // Order: parents first by created_at DESC, with each parent's
  // children immediately after it. We achieve that by sorting on
  // (effective_parent_created_at DESC, parent_id NULLS FIRST,
  // created_at ASC) — but SQLite doesn't have NULLS FIRST/LAST, so
  // emulate via `parent_id IS NULL` (1 for parents, 0 for children).
  return all(
    env.DB,
    `SELECT d.id, d.filename, d.content_type, d.size_bytes, d.retention,
            d.extraction_status, d.extraction_error, d.created_at,
            d.category,
            d.sender_email, d.sender_name, d.subject, d.email_date,
            d.parent_id,
            substr(coalesce(d.full_text, ''), 1, 200) AS preview,
            COALESCE(
              (SELECT p.created_at FROM claudia_documents p WHERE p.id = d.parent_id),
              d.created_at
            ) AS sort_anchor
       FROM claudia_documents d
      WHERE d.user_id = ? AND d.retention != 'trashed'
      ORDER BY sort_anchor DESC,
               (d.parent_id IS NULL) DESC,
               d.created_at ASC
      LIMIT 60`,
    [user.id]
  );
}

// Helpers ---------------------------------------------------------------

function isEmailFile(contentType, filename) {
  const ct = String(contentType || '').toLowerCase();
  if (ct === 'message/rfc822' || ct === 'application/mbox') return true;
  return /\.(eml|mbox)$/i.test(String(filename || ''));
}

async function ingestAttachment(env, user, att, parentId, errors) {
  const filename = String(att.filename || 'attachment').slice(0, 255);
  const contentType = att.contentType || 'application/octet-stream';
  const bytes = att.bytes;
  if (!bytes || !bytes.length) return;
  if (bytes.length > MAX_BYTES) {
    errors.push(`${filename}: attachment too large (${formatBytes(bytes.length)} > 25 MB cap)`);
    return;
  }

  // We deliberately accept attachments even when their content_type
  // isn't in claudia-extract's classifier — the user still sees the row
  // in the inbox as "filename · type · size", with extraction_status
  // marking the body as not-run.
  const knownKind = classifyContentType(contentType, filename);

  const docId = uuid();
  const ts = now();
  const safeName = filename.replace(/[^A-Za-z0-9._-]+/g, '_');
  const r2Key = `claudia-docs/${user.id}/${docId}/${safeName}`;

  await env.DOCS.put(r2Key, bytes, {
    httpMetadata: { contentType },
    customMetadata: {
      uploaded_by: user.id,
      original_filename: filename,
      from_email: parentId,
    },
  });

  let extracted = { text: '', status: 'error', error: 'unsupported attachment type' };
  if (knownKind) {
    try {
      // extractText accepts an ArrayBuffer or Uint8Array — pass the
      // underlying buffer so the existing PDF / DOCX paths work.
      extracted = await extractText(env, bytes.buffer || bytes, contentType, filename);
    } catch (err) {
      extracted = { text: '', status: 'error', error: err?.message || String(err) };
    }
  }

  let category = null;
  try {
    category = await categorizeDocument(env, {
      filename,
      contentType,
      text: extracted.text,
    });
  } catch (err) {
    console.error('[upload] attachment categorize failed:', err?.message || err);
  }

  await run(
    env.DB,
    `INSERT INTO claudia_documents
       (id, user_id, filename, content_type, size_bytes, r2_key,
        full_text, retention, extraction_status, extraction_error,
        category,
        sender_email, sender_name, subject, email_date, message_id,
        structured_data, parent_id,
        created_at, updated_at, seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'auto', ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?,
       COALESCE((SELECT MAX(seq) FROM claudia_documents WHERE user_id = ?), 0) + 1)`,
    [
      docId,
      user.id,
      filename,
      contentType,
      bytes.length,
      r2Key,
      extracted.text || null,
      extracted.status,
      extracted.error || null,
      category,
      JSON.stringify({ kind: 'attachment', from_email: parentId }),
      parentId,
      ts,
      ts,
      user.id,
    ]
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
