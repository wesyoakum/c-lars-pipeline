// functions/settings/mrpeasy-import/export.js
//
// POST /settings/mrpeasy-import/export
// Body: { paths: ['/customers', '/vendors', ...], run_id?: '<uuid>' }
//
// Phase 1 raw export: for each requested entity path, page through
// every record (strictly serial — MRPeasy 429s on concurrency) and
// write the full JSON array to R2 under:
//
//   mrpeasy-export/<run-id>/<safe-entity>.json
//   mrpeasy-export/<run-id>/manifest.json
//
// No Pipeline mapping — this is the verbatim defensive archive. The
// run is logged in mrpeasy_export_runs.
//
// `paths` should come from /settings/mrpeasy-import/probe (the
// accessible[] list) or a user-chosen subset. Omitting it is an error
// — we don't guess the surface here, the probe does.
//
// Time-budget note: Pages Functions have a wall-clock ceiling. A huge
// account may not finish all entities in one call. Mitigations:
//   * caller can split `paths` across multiple invocations
//   * pass the same run_id to keep writing into one R2 prefix
//   * each entity is flushed to R2 as soon as it's done, so a timeout
//     loses only the in-flight entity, not the completed ones
//
// Admin-only.

import { hasRole } from '../../lib/auth.js';
import { run, one } from '../../lib/db.js';
import { fetchAll, getCredentials } from '../../lib/mrpeasy-client.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function nowIso() { return new Date().toISOString(); }
function genId() {
  return (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : 'run-' + Math.random().toString(16).slice(2) + Date.now().toString(16);
}

// '/customer-orders' → 'customer-orders'; '/users/actions/list' →
// 'users_actions_list'. Safe, collision-free R2 object names.
function safeName(path) {
  return String(path).replace(/^\/+/, '').replace(/[^A-Za-z0-9._-]+/g, '_') || 'root';
}

async function putJson(env, key, obj) {
  await env.DOCS.put(key, JSON.stringify(obj), {
    httpMetadata: { contentType: 'application/json' },
  });
}

export async function onRequestPost(context) {
  const { env, request, data } = context;
  const user = data?.user;
  if (!user) return json({ ok: false, error: 'sign_in_required' }, 401);
  if (!hasRole(user, 'admin')) return json({ ok: false, error: 'admin_only' }, 403);

  if (!env.DOCS) {
    return json({ ok: false, error: 'R2 binding (DOCS) not available in this environment' }, 500);
  }

  let body = {};
  try { body = await request.json(); }
  catch { return json({ ok: false, error: 'invalid_json' }, 400); }

  const paths = Array.isArray(body.paths)
    ? body.paths.map((p) => String(p)).filter(Boolean)
    : [];
  if (paths.length === 0) {
    return json({ ok: false, error: 'paths[] required — run /settings/mrpeasy-import/probe first and pass the accessible paths' }, 400);
  }

  // Fail fast if creds missing.
  try { await getCredentials(env); }
  catch (err) { return json({ ok: false, error: String(err.message || err), code: err.code }, 400); }

  const runId     = String(body.run_id || '').trim() || genId();
  const startedAt = nowIso();
  const r2Prefix  = 'mrpeasy-export/' + runId + '/';
  const triggeredBy = user?.email || '';

  const manifest = {
    run_id: runId,
    started_at: startedAt,
    finished_at: null,
    api_base: null,
    entities: [],   // [{ path, file, records, total, pages, ms, error }]
  };
  const errors = [];

  try {
    const creds = await getCredentials(env);
    manifest.api_base = creds.apiBase;

    // Strictly serial across entities AND pages (fetchAll is serial).
    for (const path of paths) {
      const entry = { path, file: null, records: 0, total: null, pages: 0, ms: 0, error: null };
      const t0 = Date.now();
      try {
        const { records, total, pages } = await fetchAll(env, path, { maxPages: 2000 });
        const file = safeName(path) + '.json';
        await putJson(env, r2Prefix + file, {
          entity: path,
          exported_at: nowIso(),
          total,
          count: records.length,
          records,
        });
        entry.file = file;
        entry.records = records.length;
        entry.total = total;
        entry.pages = pages;
      } catch (err) {
        entry.error = String(err.message || err);
        errors.push(path + ': ' + entry.error);
      }
      entry.ms = Date.now() - t0;
      manifest.entities.push(entry);
    }

    manifest.finished_at = nowIso();
    await putJson(env, r2Prefix + 'manifest.json', manifest);

    const okEntities  = manifest.entities.filter((e) => !e.error);
    const totalRecords = okEntities.reduce((s, e) => s + e.records, 0);
    const summary =
      okEntities.length + '/' + paths.length + ' entities · ' +
      totalRecords + ' records → ' + r2Prefix +
      (errors.length ? ' · ' + errors.length + ' errored' : '');

    await run(env.DB,
      `INSERT INTO mrpeasy_export_runs
         (id, started_at, finished_at, triggered_by, ok,
          r2_prefix, summary, manifest_json, errors_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [runId, startedAt, manifest.finished_at, triggeredBy,
       errors.length === 0 ? 1 : 0,
       r2Prefix, summary,
       JSON.stringify(manifest), JSON.stringify(errors.slice(0, 100))]);

    await run(env.DB,
      `UPDATE mrpeasy_credentials
          SET last_export_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              updated_at      = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = 1`);

    return json({
      ok: errors.length === 0,
      run_id: runId,
      r2_prefix: r2Prefix,
      summary,
      manifest,
      errors,
    });
  } catch (err) {
    const fatal = String(err.message || err);
    manifest.finished_at = nowIso();
    manifest.fatal = fatal;
    try { await putJson(env, r2Prefix + 'manifest.json', manifest); } catch { /* best effort */ }
    try {
      await run(env.DB,
        `INSERT INTO mrpeasy_export_runs
           (id, started_at, finished_at, triggered_by, ok,
            r2_prefix, summary, manifest_json, errors_json)
         VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)`,
        [runId, startedAt, manifest.finished_at, triggeredBy,
         r2Prefix, 'fatal: ' + fatal,
         JSON.stringify(manifest),
         JSON.stringify(errors.concat(['fatal: ' + fatal]).slice(0, 100))]);
    } catch { /* best effort */ }
    return json({ ok: false, run_id: runId, error: fatal, manifest }, 500);
  }
}
