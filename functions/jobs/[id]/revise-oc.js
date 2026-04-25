// functions/jobs/[id]/revise-oc.js
//
// POST /jobs/:id/revise-oc — Bump oc_revision and unlock the OC for
// re-issuance.
//
// Mirrors the quote /revise endpoint: the previous OC's PDF stays in
// the documents history, and the page returns to its draft (editable)
// state with the new revision number pre-populated. Submitting the
// form re-issues the OC with the bumped revision.
//
// Resets jobs.oc_issued_at = NULL so the OC page detects the draft
// state. Job status is left untouched — only the OC document is being
// revised, not the job lifecycle.

import { one, stmt, batch } from '../../lib/db.js';
import { auditStmt } from '../../lib/audit.js';
import { now } from '../../lib/ids.js';
import { redirectWithFlash } from '../../lib/http.js';

export async function onRequestPost(context) {
  const { env, data, params } = context;
  const user = data?.user;
  const jobId = params.id;

  const job = await one(env.DB, 'SELECT * FROM jobs WHERE id = ?', [jobId]);
  if (!job) return redirectWithFlash('/jobs', 'Job not found.', 'error');

  if (!job.oc_issued_at) {
    return redirectWithFlash(
      `/jobs/${jobId}/oc`,
      'No issued OC to revise.',
      'error'
    );
  }

  const ts = now();
  const newRev = (job.oc_revision || 1) + 1;

  await batch(env.DB, [
    stmt(env.DB,
      `UPDATE jobs
          SET oc_issued_at = NULL,
              oc_issued_by_user_id = NULL,
              oc_revision = ?,
              updated_at = ?
        WHERE id = ?`,
      [newRev, ts, jobId]),
    auditStmt(env.DB, {
      entityType: 'job',
      entityId: jobId,
      eventType: 'oc_revised',
      user,
      summary: `OC ${job.oc_number || ''} revised — bumped to revision ${newRev} for re-issue`,
      changes: {
        oc_revision: { from: job.oc_revision, to: newRev },
        oc_issued_at: { from: job.oc_issued_at, to: null },
      },
    }),
  ]);

  return redirectWithFlash(
    `/jobs/${jobId}/oc`,
    `OC moved to revision ${newRev}. Edit and re-issue to send the updated copy.`
  );
}
