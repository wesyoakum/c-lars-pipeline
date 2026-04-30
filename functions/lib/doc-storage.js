// functions/lib/doc-storage.js
//
// Store a generated document (PDF or Word) in R2 and link it to a
// quote via the documents table. Mirrors the upload flow in
// functions/documents/index.js but for programmatically generated files.
//
// Same-filename supersede (migration 0061): before the INSERT, look
// for any visible sibling with the SAME parent (quote / job / opp
// fallback) AND the same `original_filename`. Mark each match's
// `superseded_at` + `superseded_by_id` so the docs lists hide them.
// The R2 object stays in place — restore is just clearing those
// columns on the row.

import { all, stmt, batch } from './db.js';
import { auditStmt } from './audit.js';
import { uuid, now } from './ids.js';
import { buildR2Key } from './r2.js';

/**
 * Store a generated document in R2 + D1.
 *
 * @param {object} env  - Worker env bindings (DB, DOCS)
 * @param {object} opts
 * @param {string} opts.opportunityId
 * @param {string} [opts.quoteId]
 * @param {string} [opts.jobId]       - Link to a job (e.g. OC PDF)
 * @param {ArrayBuffer} opts.buffer   - The file content
 * @param {string} opts.filename      - e.g. "Q25004-1.pdf" or "Q25004-1-v2.pdf"
 * @param {string} opts.mimeType      - e.g. "application/pdf"
 * @param {string} opts.kind          - e.g. "quote_pdf", "oc_pdf"
 * @param {object} opts.user          - Current user ({ id, email })
 * @returns {string} The new document ID
 */
export async function storeGeneratedDoc(env, {
  opportunityId,
  quoteId,
  jobId,
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

  // Find visible siblings with the same parent + filename — the rows
  // we'll mark superseded by this new one. Scope is the most-specific
  // parent we know about: quoteId > jobId > opportunityId. Two
  // documents can share a filename across different quotes without
  // colliding (each quote has its own scope).
  const supersedeRows = await findSiblingsToSupersede(env.DB, {
    quoteId, jobId, opportunityId, filename,
  });

  // Write metadata to D1
  const displayTitle = filename.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');

  const stmts = [
    stmt(env.DB,
      `INSERT INTO documents
         (id, opportunity_id, quote_id, job_id, account_id, cost_build_id,
          kind, title, original_filename, r2_key, mime_type, size_bytes,
          notes, uploaded_at, uploaded_by_user_id)
       VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      [docId, opportunityId, quoteId ?? null, jobId ?? null,
       kind, displayTitle, filename, r2Key, mimeType,
       buffer.byteLength, ts, user?.id ?? null]),
    auditStmt(env.DB, {
      entityType: 'document',
      entityId: docId,
      eventType: 'generated',
      user,
      summary: `Generated ${kind}: ${filename} (${formatSize(buffer.byteLength)})`,
    }),
  ];

  // Hide each old version. One UPDATE per row + an audit event per
  // row so the history page tells the story end-to-end.
  for (const old of supersedeRows) {
    stmts.push(stmt(env.DB,
      `UPDATE documents
          SET superseded_at = ?, superseded_by_id = ?
        WHERE id = ?`,
      [ts, docId, old.id]));
    stmts.push(auditStmt(env.DB, {
      entityType: 'document',
      entityId: old.id,
      eventType: 'superseded',
      user,
      summary: `Superseded by ${filename} (regenerated)`,
    }));
  }

  await batch(env.DB, stmts);

  return docId;
}

/**
 * Find still-visible documents that share the new doc's parent and
 * filename. Used by storeGeneratedDoc to mark the previous version
 * as superseded so it hides from the docs list when a regen lands
 * with the same name.
 *
 * The parent scope walks specific → general:
 *   quoteId  - tightest (this quote's regen of this filename)
 *   jobId    - OC / NTP / amended-OC regens on the same job
 *   opp      - opportunity-level fallback for un-quote-tagged docs
 */
async function findSiblingsToSupersede(db, { quoteId, jobId, opportunityId, filename }) {
  if (quoteId) {
    return await all(db,
      `SELECT id FROM documents
        WHERE quote_id = ?
          AND original_filename = ?
          AND superseded_at IS NULL`,
      [quoteId, filename]);
  }
  if (jobId) {
    return await all(db,
      `SELECT id FROM documents
        WHERE job_id = ?
          AND original_filename = ?
          AND superseded_at IS NULL`,
      [jobId, filename]);
  }
  if (opportunityId) {
    return await all(db,
      `SELECT id FROM documents
        WHERE opportunity_id = ?
          AND quote_id IS NULL
          AND job_id IS NULL
          AND original_filename = ?
          AND superseded_at IS NULL`,
      [opportunityId, filename]);
  }
  return [];
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
