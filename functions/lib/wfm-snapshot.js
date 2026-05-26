// functions/lib/wfm-snapshot.js
//
// R2 I/O for WFM snapshots. Each snapshot is a point-in-time capture
// of all WFM data fetched during a delta run, stored under:
//
//   wfm-snapshots/{snapshot_id}/manifest.json
//   wfm-snapshots/{snapshot_id}/clients.json
//   wfm-snapshots/{snapshot_id}/leads.json
//   wfm-snapshots/{snapshot_id}/quotes.json
//   wfm-snapshots/{snapshot_id}/jobs.json
//
// D1 table `wfm_snapshots` holds metadata (status, counts, timing).
// The per-entity merge base for 3-way diff remains in `wfm_import_snapshots`.

import { one, run } from './db.js';

const PREFIX = 'wfm-snapshots';

// ---------- R2 helpers ----------

function r2Key(snapshotId, file) {
  return `${PREFIX}/${snapshotId}/${file}`;
}

export async function writeSnapshotKind(docs, snapshotId, kind, data) {
  const key = r2Key(snapshotId, `${kind}.json`);
  await docs.put(key, JSON.stringify(data), {
    httpMetadata: { contentType: 'application/json' },
  });
}

export async function readSnapshotKind(docs, snapshotId, kind) {
  const key = r2Key(snapshotId, `${kind}.json`);
  const obj = await docs.get(key);
  if (!obj) return null;
  return obj.json();
}

export async function writeManifest(docs, snapshotId, manifest) {
  const key = r2Key(snapshotId, 'manifest.json');
  await docs.put(key, JSON.stringify(manifest), {
    httpMetadata: { contentType: 'application/json' },
  });
}

export async function readManifest(docs, snapshotId) {
  const key = r2Key(snapshotId, 'manifest.json');
  const obj = await docs.get(key);
  if (!obj) return null;
  return obj.json();
}

// ---------- D1 metadata ----------

export async function createSnapshotRow(db, { id, createdBy, parentId }) {
  await run(db,
    `INSERT INTO wfm_snapshots (id, created_at, created_by, parent_id, status, counts_json)
     VALUES (?, datetime('now'), ?, ?, 'fetching', '{}')`,
    [id, createdBy || null, parentId || null]);
}

export async function completeSnapshotRow(db, { id, counts, durationMs, diffRunId }) {
  await run(db,
    `UPDATE wfm_snapshots
        SET status = 'complete', counts_json = ?, duration_ms = ?, diff_run_id = ?
      WHERE id = ?`,
    [JSON.stringify(counts), durationMs, diffRunId || null, id]);
}

export async function failSnapshotRow(db, { id, error }) {
  await run(db,
    `UPDATE wfm_snapshots SET status = 'failed', error = ? WHERE id = ?`,
    [String(error).slice(0, 2000), id]);
}

export async function latestCompleteSnapshot(db) {
  return one(db,
    `SELECT id, created_at, counts_json FROM wfm_snapshots
      WHERE status = 'complete'
      ORDER BY created_at DESC LIMIT 1`);
}

export async function getSnapshot(db, id) {
  return one(db, 'SELECT * FROM wfm_snapshots WHERE id = ?', [id]);
}

// ---------- R2 cleanup (for wipe) ----------

export async function deleteSnapshotFiles(docs, snapshotId) {
  const prefix = `${PREFIX}/${snapshotId}/`;
  const listed = await docs.list({ prefix });
  if (listed.objects.length === 0) return 0;
  const keys = listed.objects.map(o => o.key);
  await docs.delete(keys);
  return keys.length;
}

export async function deleteAllSnapshots(docs, db) {
  // List all snapshot prefixes from R2.
  let cursor;
  let deleted = 0;
  do {
    const listed = await docs.list({
      prefix: `${PREFIX}/`,
      delimiter: '/',
      ...(cursor ? { cursor } : {}),
    });
    if (listed.delimitedPrefixes?.length) {
      for (const pfx of listed.delimitedPrefixes) {
        const inner = await docs.list({ prefix: pfx });
        if (inner.objects.length > 0) {
          await docs.delete(inner.objects.map(o => o.key));
          deleted += inner.objects.length;
        }
      }
    }
    // Also delete any top-level objects under the prefix.
    if (listed.objects.length > 0) {
      await docs.delete(listed.objects.map(o => o.key));
      deleted += listed.objects.length;
    }
    cursor = listed.truncated ? listed.cursor : null;
  } while (cursor);

  // Clear D1 table.
  await run(db, 'DELETE FROM wfm_snapshots');
  return deleted;
}
