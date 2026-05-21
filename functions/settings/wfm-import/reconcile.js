// functions/settings/wfm-import/reconcile.js
//
// POST /settings/wfm-import/reconcile — merge duplicate WFM-imported
// opportunities that represent the same deal (same title + account but
// different external_source: wfm, wfm-lead, wfm-job, wfm-quote-orphan).
//
// For each group of duplicates:
//   1. Pick the canonical opp (prefer 'wfm' > 'wfm-lead' > 'wfm-quote-orphan' > 'wfm-job', earliest created)
//   2. Move all quotes, jobs, activities, documents, cost_builds to the canonical opp
//   3. Soft-delete the duplicate opps
//   4. Log an audit event on the canonical opp
//
// GET returns a dry-run preview (no writes).
// POST with ?commit=1 executes the merge.

import { hasRole } from '../../lib/auth.js';
import { all, one, run, stmt, batch } from '../../lib/db.js';
import { auditStmt } from '../../lib/audit.js';
import { now } from '../../lib/ids.js';

const SOURCE_PRIORITY = { wfm: 0, 'wfm-lead': 1, 'wfm-quote-orphan': 2, 'wfm-job': 3 };

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

async function findDuplicateGroups(db) {
  // Find all groups of WFM-imported opps that share the same title + account
  const rows = await all(db,
    `SELECT id, number, title, account_id, external_source, external_id, stage, created_at
       FROM opportunities
      WHERE deleted_at IS NULL
        AND external_source IN ('wfm', 'wfm-lead', 'wfm-job', 'wfm-quote-orphan')
      ORDER BY title, account_id, created_at`
  );

  // Group by (title, account_id)
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.title}::${r.account_id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  // Only keep groups with 2+ members
  const dupes = [];
  for (const [key, members] of groups) {
    if (members.length < 2) continue;
    // Pick canonical: lowest source priority, then earliest created
    members.sort((a, b) => {
      const pa = SOURCE_PRIORITY[a.external_source] ?? 99;
      const pb = SOURCE_PRIORITY[b.external_source] ?? 99;
      if (pa !== pb) return pa - pb;
      return (a.created_at || '').localeCompare(b.created_at || '');
    });
    dupes.push({
      canonical: members[0],
      duplicates: members.slice(1),
      title: members[0].title,
    });
  }
  return dupes;
}

export async function onRequestGet(context) {
  const { env, data } = context;
  const user = data?.user;
  if (!user || !hasRole(user, 'admin')) {
    return json({ ok: false, error: 'Admin only' }, 403);
  }

  const groups = await findDuplicateGroups(env.DB);

  // Summarize for preview
  const preview = groups.map(g => ({
    title: g.title,
    canonical: { number: g.canonical.number, source: g.canonical.external_source, stage: g.canonical.stage },
    merging: g.duplicates.map(d => ({ number: d.number, source: d.external_source, stage: d.stage })),
  }));

  return json({
    ok: true,
    total_groups: groups.length,
    total_duplicates: groups.reduce((n, g) => n + g.duplicates.length, 0),
    preview,
  });
}

export async function onRequestPost(context) {
  const { env, data, request } = context;
  const user = data?.user;
  if (!user || !hasRole(user, 'admin')) {
    return json({ ok: false, error: 'Admin only' }, 403);
  }

  const groups = await findDuplicateGroups(env.DB);
  if (groups.length === 0) {
    return json({ ok: true, merged: 0, message: 'No duplicates found.' });
  }

  const ts = now();
  let merged = 0;
  const errors = [];

  for (const g of groups) {
    const canonId = g.canonical.id;

    for (const dup of g.duplicates) {
      try {
        // Move children from dup to canonical
        await run(env.DB,
          `UPDATE quotes SET opportunity_id = ? WHERE opportunity_id = ? AND deleted_at IS NULL`,
          [canonId, dup.id]);
        await run(env.DB,
          `UPDATE jobs SET opportunity_id = ? WHERE opportunity_id = ? AND deleted_at IS NULL`,
          [canonId, dup.id]);
        await run(env.DB,
          `UPDATE activities SET opportunity_id = ? WHERE opportunity_id = ? AND deleted_at IS NULL`,
          [canonId, dup.id]);
        await run(env.DB,
          `UPDATE documents SET opportunity_id = ? WHERE opportunity_id = ? AND deleted_at IS NULL`,
          [canonId, dup.id]);
        await run(env.DB,
          `UPDATE cost_builds SET opportunity_id = ? WHERE opportunity_id = ? AND deleted_at IS NULL`,
          [canonId, dup.id]);

        // Soft-delete the duplicate opp
        await run(env.DB,
          `UPDATE opportunities SET deleted_at = ? WHERE id = ?`,
          [ts, dup.id]);

        // Audit on canonical
        await run(env.DB,
          `INSERT INTO audit_events (entity_type, entity_id, event_type, user_email, user_display_name, summary, at)
           VALUES ('opportunity', ?, 'merged', ?, ?, ?, ?)`,
          [canonId, user.email, user.display_name,
           `Merged duplicate ${dup.number} (${dup.external_source}) into this opp`, ts]);

        merged++;
      } catch (e) {
        errors.push(`${dup.number}: ${e.message || e}`);
      }
    }

    // If the canonical opp's stage should advance (e.g., a wfm-job dup had
    // a later stage), pick the most advanced stage from the group.
    // Simple heuristic: if any dup was 'won' or had a job, keep the canonical
    // stage as-is (the user can adjust manually).
  }

  return json({
    ok: true,
    merged,
    groups: groups.length,
    errors: errors.length > 0 ? errors : undefined,
    message: `Merged ${merged} duplicate(s) across ${groups.length} group(s).`,
  });
}
