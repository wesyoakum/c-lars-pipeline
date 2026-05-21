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

  // Only keep groups with 2+ members that span different external_source
  // values. Two jobs with the same title but different UUIDs are legit.
  const dupes = [];
  for (const [key, members] of groups) {
    if (members.length < 2) continue;
    const sources = new Set(members.map(m => m.external_source));
    if (sources.size < 2) continue;
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

// Find orphan-sourced opps whose quotes should be re-linked to a
// lead-derived opp on the same account. This catches the case where
// the WFM /quote.api/list response omits LeadUUID, causing quotes to
// land on synthesized orphan opps instead of their parent lead opp.
async function findOrphanRelinks(db) {
  const orphans = await all(db,
    `SELECT o.id, o.number, o.title, o.account_id,
            (SELECT COUNT(*) FROM quotes q WHERE q.opportunity_id = o.id AND q.deleted_at IS NULL) AS quote_count
       FROM opportunities o
      WHERE o.deleted_at IS NULL
        AND o.external_source = 'wfm-quote-orphan'
        AND EXISTS (SELECT 1 FROM quotes q2 WHERE q2.opportunity_id = o.id AND q2.deleted_at IS NULL)`);

  const relinks = [];
  for (const orphan of orphans) {
    // Find lead-derived opps on the same account with 0 quotes
    const candidates = await all(db,
      `SELECT o.id, o.number, o.title FROM opportunities o
        WHERE o.account_id = ? AND o.deleted_at IS NULL
          AND o.external_source = 'wfm-lead'
          AND NOT EXISTS (
            SELECT 1 FROM quotes q
             WHERE q.opportunity_id = o.id AND q.deleted_at IS NULL
          )
        ORDER BY o.created_at`,
      [orphan.account_id]);

    if (candidates.length === 0) continue;

    // Prefer exact title match, then sole candidate on account
    let target = candidates.find(c => c.title === orphan.title);
    if (!target && candidates.length === 1) target = candidates[0];
    if (!target) continue;

    relinks.push({
      orphan,
      target,
      quote_count: orphan.quote_count,
    });
  }
  return relinks;
}

export async function onRequestGet(context) {
  const { env, data } = context;
  const user = data?.user;
  if (!user || !hasRole(user, 'admin')) {
    return json({ ok: false, error: 'Admin only' }, 403);
  }

  const groups = await findDuplicateGroups(env.DB);
  const totalDups = groups.reduce((n, g) => n + g.duplicates.length, 0);
  const relinks = await findOrphanRelinks(env.DB);
  const totalRelinkedQuotes = relinks.reduce((n, r) => n + r.quote_count, 0);

  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const rows = groups.map(g => {
    const dupsHtml = g.duplicates.map(d =>
      `<a href="/opportunities/${esc(d.id)}" target="_blank" style="display:inline-block;margin:.1rem .3rem .1rem 0;padding:.1rem .4rem;background:#fff3cd;border-radius:3px;font-size:.82rem;text-decoration:none;color:inherit">${esc(d.number)} <small style="color:#666">(${esc(d.external_source)}, ${esc(d.stage)})</small></a>`
    ).join('');
    return `<tr>
      <td>${esc(g.title)}</td>
      <td><a href="/opportunities/${esc(g.canonical.id)}" target="_blank"><strong>${esc(g.canonical.number)}</strong></a> <small style="color:#666">(${esc(g.canonical.external_source)}, ${esc(g.canonical.stage)})</small></td>
      <td>${dupsHtml}</td>
    </tr>`;
  }).join('\n');

  const relinkRows = relinks.map(r => {
    return `<tr>
      <td><a href="/opportunities/${esc(r.orphan.id)}" target="_blank">${esc(r.orphan.number)}</a> — ${esc(r.orphan.title)} <small style="color:#666">(${r.quote_count} quote${r.quote_count === 1 ? '' : 's'})</small></td>
      <td><a href="/opportunities/${esc(r.target.id)}" target="_blank"><strong>${esc(r.target.number)}</strong></a> — ${esc(r.target.title)}</td>
    </tr>`;
  }).join('\n');

  const html = `<!DOCTYPE html><html><head><title>WFM Reconciliation Preview</title>
<style>body{font-family:system-ui;margin:2rem;color:#222}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:.5rem .7rem;text-align:left;vertical-align:top}th{background:#f5f5f7;font-size:.85rem;font-weight:600}tr:hover{background:#f9f9fb}.summary{margin-bottom:1.5rem;padding:1rem;background:#e6f4ea;border-radius:6px}button{padding:.5rem 1.5rem;font-size:1rem;cursor:pointer;background:#cf222e;color:white;border:none;border-radius:4px;margin-top:1rem}button:hover{background:#a3161a}h2{margin-top:2rem}</style></head>
<body>
<h1>WFM Reconciliation Preview</h1>
${groups.length > 0 ? `
<div class="summary">
  <strong>${groups.length}</strong> duplicate groups found containing <strong>${totalDups}</strong> duplicate opps to merge.
  <br><small>The <strong>Keep</strong> column is the canonical opp. All quotes, jobs, activities, and documents from the <strong>Merge &amp; Delete</strong> opps will be moved to the canonical, then the duplicates will be soft-deleted.</small>
</div>
<table>
  <thead><tr><th>Title</th><th>Keep (canonical)</th><th>Merge &amp; Delete</th></tr></thead>
  <tbody>${rows}</tbody>
</table>` : '<p>No title-based duplicates found.</p>'}

${relinks.length > 0 ? `
<h2>Orphan Quote Re-links</h2>
<div class="summary">
  <strong>${relinks.length}</strong> orphan opp${relinks.length === 1 ? '' : 's'} with <strong>${totalRelinkedQuotes}</strong> quote${totalRelinkedQuotes === 1 ? '' : 's'} to re-link to lead-derived opps (matched by account).
  <br><small>Quotes will be moved from the orphan opp to the lead opp, then the empty orphan will be soft-deleted.</small>
</div>
<table>
  <thead><tr><th>Orphan opp (quotes move from)</th><th>Lead opp (quotes move to)</th></tr></thead>
  <tbody>${relinkRows}</tbody>
</table>` : '<h2>Orphan Quote Re-links</h2><p>No orphan quotes to re-link.</p>'}

${(groups.length + relinks.length) > 0 ? `
<form method="post" action="/settings/wfm-import/reconcile" onsubmit="return confirm('This will merge ${totalDups} duplicate(s) and re-link ${totalRelinkedQuotes} quote(s) from ${relinks.length} orphan opp(s). This is reversible (soft delete). Proceed?')">
  <button type="submit">Run Reconciliation (${totalDups} merges + ${relinks.length} re-links)</button>
</form>` : ''}
</body></html>`;

  return new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

export async function onRequestPost(context) {
  const { env, data, request } = context;
  const user = data?.user;
  if (!user || !hasRole(user, 'admin')) {
    return json({ ok: false, error: 'Admin only' }, 403);
  }

  const groups = await findDuplicateGroups(env.DB);
  const relinks = await findOrphanRelinks(env.DB);

  if (groups.length === 0 && relinks.length === 0) {
    return json({ ok: true, merged: 0, relinked: 0, message: 'Nothing to reconcile.' });
  }

  const ts = now();
  let merged = 0;
  let relinked = 0;
  let quotesRelinked = 0;
  const errors = [];

  // Pass 1: title-based duplicate merges
  for (const g of groups) {
    const canonId = g.canonical.id;

    for (const dup of g.duplicates) {
      try {
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

        await run(env.DB,
          `UPDATE opportunities SET deleted_at = ? WHERE id = ?`,
          [ts, dup.id]);

        await run(env.DB,
          `INSERT INTO audit_events (entity_type, entity_id, event_type, user_email, user_display_name, summary, at)
           VALUES ('opportunity', ?, 'merged', ?, ?, ?, ?)`,
          [canonId, user.email, user.display_name,
           `Merged duplicate ${dup.number} (${dup.external_source}) into this opp`, ts]);

        merged++;
      } catch (e) {
        errors.push(`merge ${dup.number}: ${e.message || e}`);
      }
    }
  }

  // Pass 2: orphan quote re-links (account-based)
  for (const r of relinks) {
    try {
      await run(env.DB,
        'UPDATE quotes SET opportunity_id = ?, updated_at = ? WHERE opportunity_id = ? AND deleted_at IS NULL',
        [r.target.id, ts, r.orphan.id]);
      await run(env.DB,
        'UPDATE cost_builds SET opportunity_id = ?, updated_at = ? WHERE opportunity_id = ? AND deleted_at IS NULL',
        [r.target.id, ts, r.orphan.id]);
      await run(env.DB,
        'UPDATE activities SET opportunity_id = ? WHERE opportunity_id = ?',
        [r.target.id, r.orphan.id]);
      await run(env.DB,
        'UPDATE documents SET opportunity_id = ? WHERE opportunity_id = ?',
        [r.target.id, r.orphan.id]);

      await run(env.DB,
        'UPDATE opportunities SET deleted_at = ?, updated_at = ? WHERE id = ?',
        [ts, ts, r.orphan.id]);

      await run(env.DB,
        `INSERT INTO audit_events (entity_type, entity_id, event_type, user_email, user_display_name, summary, at)
         VALUES ('opportunity', ?, 'merged', ?, ?, ?, ?)`,
        [r.target.id, user.email, user.display_name,
         `Re-linked ${r.quote_count} quote(s) from orphan opp ${r.orphan.number}`, ts]);

      relinked++;
      quotesRelinked += r.quote_count;
    } catch (e) {
      errors.push(`relink ${r.orphan.number}: ${e.message || e}`);
    }
  }

  return json({
    ok: true,
    merged,
    relinked,
    quotes_relinked: quotesRelinked,
    groups: groups.length,
    errors: errors.length > 0 ? errors : undefined,
    message: `Merged ${merged} duplicate(s), re-linked ${quotesRelinked} quote(s) from ${relinked} orphan opp(s).`,
  });
}
