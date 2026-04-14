// functions/opportunities/[id]/notes.js
//
// POST /opportunities/:id/notes — create a note on an opportunity.
//
// Notes are just rows in the `activities` table with type='note', so
// they slot into the existing tasks tab and the audit trail for free.
// If a file is attached, it gets uploaded to R2 and a row is inserted
// into the `documents` table with kind='note_image' and activity_id
// pointing at the note. The note renders on the opportunity overview
// with any linked images shown inline below the body.

import { one, stmt, batch } from '../../lib/db.js';
import { auditStmt } from '../../lib/audit.js';
import { uuid, now } from '../../lib/ids.js';
import { buildR2Key, uploadToR2 } from '../../lib/r2.js';
import { redirectWithFlash } from '../../lib/http.js';

const MAX_SIZE = 20 * 1024 * 1024; // 20 MB is plenty for a note image

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const oppId = params.id;

  const opp = await one(env.DB, `SELECT id FROM opportunities WHERE id = ?`, [oppId]);
  if (!opp) {
    return new Response('Opportunity not found', { status: 404 });
  }

  const returnTo = `/opportunities/${oppId}`;

  let formData;
  try {
    formData = await request.formData();
  } catch {
    return redirectWithFlash(returnTo, 'Invalid form data.', 'error');
  }

  const body = (formData.get('body') || '').toString().trim();
  const file = formData.get('file');
  const hasFile = file && typeof file !== 'string' && file.size > 0;

  if (!body && !hasFile) {
    return redirectWithFlash(returnTo, 'Write something or attach an image.', 'error');
  }

  if (hasFile && file.size > MAX_SIZE) {
    return redirectWithFlash(returnTo, 'Image exceeds 20 MB limit.', 'error');
  }

  const noteId = uuid();
  const ts = now();

  // Upload the image first — if R2 write fails we don't want an orphaned
  // activity row in D1.
  let docId = null;
  let r2Key = null;
  let originalFilename = null;
  let mimeType = null;
  let sizeBytes = null;
  let displayTitle = null;

  if (hasFile) {
    docId = uuid();
    originalFilename = file.name || 'image';
    mimeType = file.type || 'application/octet-stream';
    sizeBytes = file.size;
    displayTitle = originalFilename.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ') || 'image';
    r2Key = buildR2Key(oppId, originalFilename);
    await uploadToR2(env.DOCS, r2Key, file, {
      documentId: docId,
      uploadedBy: user?.email ?? 'unknown',
      kind: 'note_image',
    });
  }

  const statements = [
    stmt(
      env.DB,
      `INSERT INTO activities
         (id, opportunity_id, type, subject, body, status,
          created_at, updated_at, created_by_user_id)
       VALUES (?, ?, 'note', NULL, ?, 'completed', ?, ?, ?)`,
      [noteId, oppId, body || null, ts, ts, user?.id ?? null]
    ),
  ];

  if (hasFile) {
    statements.push(
      stmt(
        env.DB,
        `INSERT INTO documents
           (id, opportunity_id, activity_id, kind, title, original_filename,
            r2_key, mime_type, size_bytes, uploaded_at, uploaded_by_user_id)
         VALUES (?, ?, ?, 'note_image', ?, ?, ?, ?, ?, ?, ?)`,
        [
          docId,
          oppId,
          noteId,
          displayTitle,
          originalFilename,
          r2Key,
          mimeType,
          sizeBytes,
          ts,
          user?.id ?? null,
        ]
      )
    );
  }

  statements.push(
    auditStmt(env.DB, {
      entityType: 'activity',
      entityId: noteId,
      eventType: 'created',
      user,
      summary: hasFile
        ? `Added note with image: ${displayTitle}`
        : `Added note`,
    })
  );

  await batch(env.DB, statements);

  return redirectWithFlash(returnTo, 'Note added.');
}
