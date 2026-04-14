// functions/lib/doc-storage.js
//
// Store a generated document (PDF or Word) in R2 and link it to a
// quote via the documents table. Mirrors the upload flow in
// functions/documents/index.js but for programmatically generated files.

import { stmt, batch } from './db.js';
import { auditStmt } from './audit.js';
import { uuid, now } from './ids.js';
import { buildR2Key } from './r2.js';

/**
 * Store a generated document in R2 + D1.
 *
 * @param {object} env  - Worker env bindings (DB, DOCS)
 * @param {object} opts
 * @param {string} opts.opportunityId
 * @param {string} opts.quoteId
 * @param {ArrayBuffer} opts.buffer   - The file content
 * @param {string} opts.filename      - e.g. "Q25004-1.pdf" or "Q25004-1-v2.pdf"
 * @param {string} opts.mimeType      - e.g. "application/pdf"
 * @param {string} opts.kind          - e.g. "quote_pdf" or "quote_docx"
 * @param {object} opts.user          - Current user ({ id, email })
 * @returns {string} The new document ID
 */
export async function storeGeneratedDoc(env, {
  opportunityId,
  quoteId,
  buffer,
  filename,
  mimeType,
  kind,
  user,
}) {
  const docId = uuid();
  const ts = now();
  const r2Key = buildR2Key(opportunityId, filename);

  // Upload to R2
  await env.DOCS.put(r2Key, buffer, {
    httpMetadata: { contentType: mimeType },
    customMetadata: {
      documentId: docId,
      uploadedBy: user?.email ?? 'system',
      kind,
    },
  });

  // Write metadata to D1
  const displayTitle = filename.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');

  await batch(env.DB, [
    stmt(env.DB,
      `INSERT INTO documents
         (id, opportunity_id, quote_id, job_id, account_id, cost_build_id,
          kind, title, original_filename, r2_key, mime_type, size_bytes,
          notes, uploaded_at, uploaded_by_user_id)
       VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      [docId, opportunityId, quoteId,
       kind, displayTitle, filename, r2Key, mimeType,
       buffer.byteLength, ts, user?.id ?? null]),
    auditStmt(env.DB, {
      entityType: 'document',
      entityId: docId,
      eventType: 'generated',
      user,
      summary: `Generated ${kind}: ${filename} (${formatSize(buffer.byteLength)})`,
    }),
  ]);

  return docId;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
