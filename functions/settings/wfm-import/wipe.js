// functions/settings/wfm-import/wipe.js
//
// POST /settings/wfm-import/wipe
//
// Hard-delete all WFM-imported rows (external_source LIKE 'wfm%')
// across every table. Preserves Pipeline-native records. Also clears
// the wfm_import_runs, wfm_import_plans, wfm_import_pending,
// wfm_import_snapshots, and wfm_snapshots tables, plus R2 snapshot
// files, so the next full import starts clean.
//
// GET returns a dry-run preview with counts per table.
// POST executes the wipe.
//
// Admin only.

import { hasRole } from '../../lib/auth.js';
import { all, run } from '../../lib/db.js';
import { deleteAllSnapshots } from '../../lib/wfm-snapshot.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

// Tables with external_source column, ordered so children are deleted
// before parents (FK safety).
const WFM_TABLES = [
  'quote_lines',
  'cost_builds',
  'account_addresses',
  'activities',
  'documents',
  'jobs',
  'quotes',
  'opportunities',
  'contacts',
  'accounts',
];

// Tables that only get a user-enrichment stamp (external_source='wfm')
// — clear the WFM columns but don't delete the row.
const ENRICHMENT_TABLES = ['users'];

// WFM infrastructure tables — truncate entirely.
const INFRA_TABLES = [
  'wfm_import_runs',
  'wfm_import_plans',
  'wfm_import_pending',
  'wfm_import_snapshots',
  'wfm_snapshots',
];

async function countWfm(db, table) {
  const rows = await all(db,
    `SELECT COUNT(*) AS cnt FROM ${table} WHERE external_source LIKE 'wfm%'`);
  return rows[0]?.cnt ?? 0;
}

export async function onRequestGet(context) {
  const { env, data } = context;
  const user = data?.user;
  if (!user || !hasRole(user, 'admin')) return json({ error: 'admin only' }, 403);

  const counts = {};
  let total = 0;
  for (const t of WFM_TABLES) {
    const n = await countWfm(env.DB, t);
    counts[t] = n;
    total += n;
  }
  for (const t of ENRICHMENT_TABLES) {
    const n = await countWfm(env.DB, t);
    counts[t + ' (enrich clear)'] = n;
  }
  for (const t of INFRA_TABLES) {
    try {
      const rows = await all(env.DB, `SELECT COUNT(*) AS cnt FROM ${t}`);
      counts[t] = rows[0]?.cnt ?? 0;
      total += counts[t];
    } catch { counts[t] = '(table missing)'; }
  }

  return json({ ok: true, preview: true, counts, total_wfm_rows: total });
}

export async function onRequestPost(context) {
  const { env, data } = context;
  const user = data?.user;
  if (!user || !hasRole(user, 'admin')) return json({ error: 'admin only' }, 403);

  const counts = {};
  const errors = [];

  // Hard-delete WFM rows from entity tables (children first)
  for (const t of WFM_TABLES) {
    try {
      const before = await countWfm(env.DB, t);
      await run(env.DB,
        `DELETE FROM ${t} WHERE external_source LIKE 'wfm%'`, []);
      counts[t] = before;
    } catch (e) {
      errors.push(`${t}: ${e.message}`);
    }
  }

  // Clear WFM enrichment on users (don't delete the user row)
  for (const t of ENRICHMENT_TABLES) {
    try {
      await run(env.DB,
        `UPDATE ${t} SET external_source = NULL, external_id = NULL,
                wfm_payload = NULL, external_url = NULL
          WHERE external_source LIKE 'wfm%'`, []);
    } catch (e) {
      errors.push(`${t} enrich clear: ${e.message}`);
    }
  }

  // Truncate WFM infrastructure tables
  for (const t of INFRA_TABLES) {
    try {
      await run(env.DB, `DELETE FROM ${t}`, []);
    } catch (e) {
      errors.push(`${t}: ${e.message}`);
    }
  }

  // Delete R2 snapshot files
  let r2Deleted = 0;
  try {
    r2Deleted = await deleteAllSnapshots(env.DOCS, env.DB);
  } catch (e) {
    errors.push(`R2 snapshots: ${e.message}`);
  }

  return json({
    ok: true,
    wiped: counts,
    r2_files_deleted: r2Deleted,
    errors: errors.length > 0 ? errors : undefined,
    message: 'WFM data wiped. Ready for reimport.',
  });
}
