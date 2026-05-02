// functions/documents/index.js
//
// POST /documents — Upload a document (multipart form).
//
// The file is stored in R2 under opp/<opportunity_id>/<uuid>-<filename>,
// and metadata is written to the D1 documents table.

import { one, stmt, batch } from '../lib/db.js';
import { auditStmt } from '../lib/audit.js';
import { uuid, now } from '../lib/ids.js';
import { buildR2Key, uploadToR2 } from '../lib/r2.js';
import { redirectWithFlash } from '../lib/http.js';

const MAX_SIZE = 50 * 1024 * 1024; // 50 MB

export async function onRequestPost(context) {
  const { env, data, request } = context;
  const user = data?.user;

  let formData;
  try {
    formData = await request.formData();
  } catch {
    return redirectWithFlash('/activities', 'Invalid form data.', 'error');
  }

  const file = formData.get('file');
  const kind = formData.get('kind') || 'other';
  const title = (formData.get('title') || '').trim();
  const notes = (formData.get('notes') || '').trim() || null;
  const opportunityId = formData.get('opportunity_id') || null;
  const quoteId = formData.get('quote_id') || null;
  const accountId = formData.get('account_id') || null;
  const costBuildId = formData.get('cost_build_id') || null;
  const returnTo = formData.get('return_to') || '/';

  if (!file || typeof file === 'string' || file.size === 0) {
    return redirectWithFlash(returnTo, 'No file selected.', 'error');
  }

  if (file.size > MAX_SIZE) {
    return redirectWithFlash(returnTo, 'File exceeds 50 MB limit.', 'error');
  }

  const docId = uuid();
  const ts = now();
  const originalFilename = file.name || 'file';
  // Title defaults to filename without extension, capitalized
  const derivedTitle = originalFilename.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
  const displayTitle = title || derivedTitle;
  const r2Key = buildR2Key(opportunityId || 'general', originalFilename);

  // Upload to R2
  await uploadToR2(env.DOCS, r2Key, file, {
    documentId: docId,
    uploadedBy: user?.email ?? 'unknown',
    kind,
  });

  // Write metadata to D1
  await batch(env.DB, [
    stmt(env.DB,
      `INSERT INTO documents
         (id, opportunity_id, quote_id, job_id, account_id, cost_build_id, kind, title,
          original_filename, r2_key, mime_type, size_bytes, notes,
          uploaded_at, uploaded_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [docId, opportunityId, quoteId, accountId, costBuildId, kind, displayTitle,
       originalFilename, r2Key, file.type || 'application/octet-stream',
       file.size, notes, ts, user?.id, ts, ts]),
    auditStmt(env.DB, {
      entityType: 'document',
      entityId: docId,
      eventType: 'uploaded',
      user,
      summary: `Uploaded ${kind}: ${displayTitle} (${formatSize(file.size)})`,
    }),
  ]);

  return redirectWithFlash(returnTo, `Uploaded: ${displayTitle}`);
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
