// functions/settings/wfm-import/sample.js
//
// POST /settings/wfm-import/sample
//
// Pulls a small random sample (5 records each) from WFM:
//   * 5 random clients (with their full detail = contacts populated)
//   * 5 random leads
//   * 5 random quotes
//   * 5 random jobs
//   * 5 random staff
//
// Strategy for "random N from a paginated list":
//   1. Probe with page=1&pageSize=1 to read TotalRecords from the
//      pagination envelope.
//   2. Pick N distinct random page positions in [1, TotalRecords].
//   3. Fetch each as page=K&pageSize=1, take the first record.
//
// For non-paginated catalogs (Staff at ~30 rows), shuffle the full
// list and take N.
//
// Returns the raw WFM records (already parsed from XML) — the page
// renders summary cards and remembers the full payload for the
// commit step.

import { hasRole } from '../../lib/auth.js';
import { apiGet, recordList } from '../../lib/wfm-client.js';

const DEFAULT_SAMPLE_SIZE = 5;
const MAX_SAMPLE_SIZE     = 50;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickDistinct(n, lo, hi) {
  const range = hi - lo + 1;
  const target = Math.min(n, range);
  const set = new Set();
  while (set.size < target) {
    set.add(lo + Math.floor(Math.random() * range));
  }
  return [...set];
}

async function readTotalRecords(env, basePath) {
  const sep = basePath.includes('?') ? '&' : '?';
  const r = await apiGet(env, `${basePath}${sep}page=1&pageSize=1`);
  if (!r.ok) return null;
  const totalStr = r.body?.Response?.TotalRecords;
  if (!totalStr) return null;
  const n = parseInt(totalStr, 10);
  return Number.isNaN(n) ? null : n;
}

async function fetchRandomSample(env, basePath, count, primaryKey) {
  const total = await readTotalRecords(env, basePath);

  if (total === null) {
    // Non-paginated: pull a chunk and shuffle.
    const sep = basePath.includes('?') ? '&' : '?';
    const r = await apiGet(env, `${basePath}${sep}page=1&pageSize=200`);
    if (!r.ok) throw new Error(`${basePath} failed: ${r.status}`);
    const arr = recordList(r.body, primaryKey);
    return shuffle(arr).slice(0, count);
  }

  if (total <= count) {
    const sep = basePath.includes('?') ? '&' : '?';
    const r = await apiGet(env, `${basePath}${sep}page=1&pageSize=${Math.max(total, 1)}`);
    if (!r.ok) throw new Error(`${basePath} failed: ${r.status}`);
    return recordList(r.body, primaryKey);
  }

  const pages = pickDistinct(count, 1, total);
  const records = [];
  for (const page of pages) {
    const sep = basePath.includes('?') ? '&' : '?';
    const r = await apiGet(env, `${basePath}${sep}page=${page}&pageSize=1`);
    if (!r.ok) continue;
    const rec = recordList(r.body, primaryKey)[0];
    if (rec) records.push(rec);
  }
  return records;
}

export async function onRequestPost(context) {
  const { env, request, data } = context;
  const user = data?.user;
  if (!user) return json({ ok: false, error: 'sign_in_required' }, 401);
  if (!hasRole(user, 'admin')) return json({ ok: false, error: 'admin_only' }, 403);

  // Accept optional `count` (default 5, max 50). Per-entity counts can
  // come later if the user wants different sizes per kind.
  let body = {};
  try { body = await request.json(); } catch { /* ignore — empty body OK */ }
  const requested = parseInt(body?.count, 10);
  const SAMPLE_SIZE = (Number.isFinite(requested) && requested > 0)
    ? Math.min(requested, MAX_SAMPLE_SIZE)
    : DEFAULT_SAMPLE_SIZE;

  try {
    // Run the four paginated probes in parallel + staff (small list).
    const [clientStubs, leads, quotes, jobs, staffList] = await Promise.all([
      fetchRandomSample(env, '/client.api/list',   SAMPLE_SIZE, 'Client'),
      fetchRandomSample(env, '/lead.api/current',  SAMPLE_SIZE, 'Lead'),
      fetchRandomSample(env, '/quote.api/current', SAMPLE_SIZE, 'Quote'),
      fetchRandomSample(env, '/job.api/current',   SAMPLE_SIZE, 'Job'),
      apiGet(env, '/staff.api/list').then((r) => {
        if (!r.ok) throw new Error('Staff list failed: ' + r.status);
        const arr = recordList(r.body, 'Staff');
        return shuffle(arr).slice(0, SAMPLE_SIZE);
      }),
    ]);

    // For each randomly-sampled client, fetch its detail (which
    // includes the Contacts array).
    const clients = [];
    for (const c of clientStubs) {
      const detail = await apiGet(env, `/client.api/get/${encodeURIComponent(c.UUID)}`);
      const detailClient = recordList(detail.body, 'Client')[0] || c;
      clients.push(detailClient);
    }

    return json({
      ok: true,
      samples: {
        clients,
        leads,
        quotes,
        jobs,
        staff: staffList,
      },
    });
  } catch (err) {
    return json({ ok: false, error: String(err.message || err) }, 500);
  }
}
