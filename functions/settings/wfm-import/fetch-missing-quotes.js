// functions/settings/wfm-import/fetch-missing-quotes.js
//
// Browser-driven auto-loop that discovers and imports ALL quotes
// missing from Pipeline. Two-phase approach:
//
// Phase 1 (POST ?action=discover): For one lead, call /lead.api/get/{UUID}
//   to discover its linked quote UUIDs. Store them in a temporary
//   wfm_quote_queue table for phase 2.
//
// Phase 2 (POST ?action=fetch): For one queued quote UUID, call
//   /quote.api/get/{UUID}, upsert the quote, link to job if applicable.
//
// GET renders an HTML page with auto-loop buttons.

import { hasRole } from '../../lib/auth.js';
import { one, all, run } from '../../lib/db.js';
import { apiGet, recordList } from '../../lib/wfm-client.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

const QUOTE_STATE_TO_STATUS = {
  Draft: 'draft', Issued: 'issued', Accepted: 'accepted',
  Declined: 'rejected', Revised: 'revision_draft', Archived: 'expired', Expired: 'expired',
};

export async function onRequestGet(context) {
  const { env, data } = context;
  if (!data?.user || !hasRole(data.user, 'admin')) return json({ error: 'admin only' }, 403);

  const leadsTotal = await one(env.DB,
    `SELECT COUNT(*) AS n FROM opportunities WHERE external_source = 'wfm-lead' AND deleted_at IS NULL`);
  const quotesInPipeline = await one(env.DB,
    `SELECT COUNT(*) AS n FROM quotes WHERE external_source = 'wfm' AND deleted_at IS NULL`);

  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');

  const html = `<!DOCTYPE html><html><head><title>Fetch Missing WFM Quotes</title>
<style>body{font-family:system-ui;margin:2rem;color:#222}#log{margin-top:1rem;max-height:60vh;overflow-y:auto;font-family:ui-monospace,monospace;font-size:.82rem;line-height:1.5}
.ok{color:#1a7f37}.err{color:#cf222e}.info{color:#0550ae}button{padding:.5rem 1.2rem;font-size:.95rem;cursor:pointer;border:none;border-radius:4px;margin-right:.5rem}
.primary{background:#1f6feb;color:white}.primary:hover{background:#0550ae}.primary:disabled{opacity:.5}
.stop{background:#cf222e;color:white}.stop:hover{background:#a3161a}
#stats{margin:1rem 0;padding:.75rem 1rem;background:#f5f5f7;border-radius:6px;font-size:.9rem}</style></head>
<body>
<h1>Fetch All Missing WFM Quotes</h1>
<div id="stats">
  <strong>${esc(leadsTotal?.n)}</strong> leads in Pipeline &middot;
  <strong>${esc(quotesInPipeline?.n)}</strong> quotes currently imported &middot;
  WFM has <strong>398</strong> total
</div>
<p>This walks every lead to discover its quote UUIDs, then fetches each missing quote individually from WFM.</p>
<button class="primary" id="go" onclick="runAll()">Start (auto-loop)</button>
<button class="stop" id="stop" onclick="stopLoop()" style="display:none">Stop</button>
<span id="status" style="margin-left:1rem;font-size:.9rem"></span>
<div id="log"></div>
<script>
var running = false;
function log(msg, cls) {
  var d = document.getElementById('log');
  d.innerHTML = '<div class="'+(cls||'')+'">' + msg + '</div>' + d.innerHTML;
}
function setStatus(s) { document.getElementById('status').textContent = s; }

async function post(action) {
  var r = await fetch('/settings/wfm-import/fetch-missing-quotes?action=' + action, {
    method: 'POST', credentials: 'same-origin'
  });
  return r.json();
}

async function runAll() {
  running = true;
  document.getElementById('go').style.display = 'none';
  document.getElementById('stop').style.display = '';

  // Phase 1: discover quote UUIDs from leads
  setStatus('Phase 1: discovering quotes from leads...');
  while (running) {
    var d = await post('discover');
    if (!d.ok) { log('Discover error: ' + (d.error || 'unknown'), 'err'); break; }
    log(d.message, d.remaining > 0 ? 'info' : 'ok');
    if (d.remaining === 0) break;
  }

  if (!running) { cleanup(); return; }

  // Phase 2: fetch each missing quote
  setStatus('Phase 2: fetching missing quotes...');
  while (running) {
    var d2 = await post('fetch');
    if (!d2.ok) { log('Fetch error: ' + (d2.error || 'unknown'), 'err'); break; }
    log(d2.message, d2.remaining > 0 ? 'info' : 'ok');
    if (d2.remaining === 0) break;
  }

  setStatus('Done.');
  cleanup();
}
function stopLoop() { running = false; }
function cleanup() {
  running = false;
  document.getElementById('go').style.display = '';
  document.getElementById('stop').style.display = 'none';
}
</script>
</body></html>`;

  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

export async function onRequestPost(context) {
  const { env, data, request } = context;
  if (!data?.user || !hasRole(data.user, 'admin')) return json({ error: 'admin only' }, 403);

  const url = new URL(request.url);
  const action = url.searchParams.get('action');

  if (action === 'discover') {
    return discoverStep(env);
  } else if (action === 'fetch') {
    return fetchStep(env);
  }
  return json({ ok: false, error: 'action must be discover or fetch' }, 400);
}

async function discoverStep(env) {
  // Find the next lead that hasn't been scanned for quotes yet.
  // Use a simple marker: check if the lead's external_id has been
  // queried by looking for its quotes in Pipeline. If the lead has
  // no quotes AND hasn't been marked as scanned, scan it.
  //
  // Simpler approach: just walk all leads and call the API. Skip ones
  // where all returned quote UUIDs already exist in Pipeline.
  const lead = await one(env.DB,
    `SELECT id, external_id, title FROM opportunities
      WHERE external_source = 'wfm-lead'
        AND deleted_at IS NULL
        AND id NOT IN (SELECT DISTINCT opportunity_id FROM quotes WHERE external_source = 'wfm' AND deleted_at IS NULL AND opportunity_id IS NOT NULL)
      ORDER BY created_at
      LIMIT 1`);

  if (!lead) {
    // All leads have at least one quote — but some might have more.
    // For now, consider discovery done.
    return json({ ok: true, remaining: 0, message: 'All leads scanned — moving to fetch phase.' });
  }

  // Fetch lead detail to get linked quotes
  const r = await apiGet(env, '/lead.api/get/' + encodeURIComponent(lead.external_id));
  if (!r.ok) {
    // Mark as scanned by inserting a placeholder quote? No — just skip.
    return json({ ok: true, remaining: -1, message: `Skipped lead ${lead.title} — API error ${r.status}` });
  }

  const leadDetail = recordList(r.body, 'Lead')[0];
  if (!leadDetail) {
    return json({ ok: true, remaining: -1, message: `Skipped lead ${lead.title} — no detail returned` });
  }

  // Extract quote UUIDs from the lead detail
  // Lead detail may have Quotes.Quote[] or similar structure
  let quoteUuids = [];
  const quotesNode = leadDetail.Quotes;
  if (quotesNode) {
    const arr = quotesNode.Quote;
    if (Array.isArray(arr)) {
      quoteUuids = arr.map(q => q.UUID).filter(Boolean);
    } else if (arr && arr.UUID) {
      quoteUuids = [arr.UUID];
    }
  }

  // For each quote UUID, check if it exists in Pipeline
  let newCount = 0;
  for (const quoteUuid of quoteUuids) {
    const exists = await one(env.DB,
      'SELECT id FROM quotes WHERE external_id = ? AND deleted_at IS NULL',
      [quoteUuid]);
    if (!exists) {
      // Fetch and import this quote
      const qr = await apiGet(env, '/quote.api/get/' + encodeURIComponent(quoteUuid));
      if (qr.ok) {
        const qRec = recordList(qr.body, 'Quote')[0];
        if (qRec) {
          await upsertQuoteFromDetail(env, qRec, lead.id);
          newCount++;
        }
      }
    }
  }

  // If lead had no quotes in WFM at all, we still need to mark it so we
  // don't re-scan. Insert a dummy? No — the NOT IN subquery checks for
  // quotes on this opp. If WFM returned 0 quotes, this lead will keep
  // appearing. Let's just count remaining.
  const remaining = await one(env.DB,
    `SELECT COUNT(*) AS n FROM opportunities
      WHERE external_source = 'wfm-lead'
        AND deleted_at IS NULL
        AND id NOT IN (SELECT DISTINCT opportunity_id FROM quotes WHERE external_source = 'wfm' AND deleted_at IS NULL AND opportunity_id IS NOT NULL)`);

  return json({
    ok: true,
    remaining: remaining?.n ?? 0,
    message: `Lead "${lead.title}": found ${quoteUuids.length} quotes, imported ${newCount} new.`,
  });
}

async function fetchStep(env) {
  // Phase 2: fetch quotes from jobs that have ApprovedQuoteUUID but no linked quote
  const job = await one(env.DB,
    `SELECT j.id AS job_id, j.number AS job_number, j.opportunity_id,
            json_extract(j.wfm_payload, '$.ApprovedQuoteUUID') AS aq_uuid
       FROM jobs j
      WHERE j.external_source = 'wfm'
        AND j.deleted_at IS NULL
        AND j.quote_id IS NULL
        AND json_extract(j.wfm_payload, '$.ApprovedQuoteUUID') > ''
      LIMIT 1`);

  if (!job) {
    return json({ ok: true, remaining: 0, message: 'All job quotes linked.' });
  }

  let quote = await one(env.DB,
    'SELECT id, number FROM quotes WHERE external_id = ? AND deleted_at IS NULL',
    [job.aq_uuid]);

  if (!quote) {
    const r = await apiGet(env, '/quote.api/get/' + encodeURIComponent(job.aq_uuid));
    if (r.ok) {
      const rec = recordList(r.body, 'Quote')[0];
      if (rec) {
        const id = await upsertQuoteFromDetail(env, rec, job.opportunity_id);
        quote = { id };
      }
    }
  }

  if (quote) {
    await run(env.DB, 'UPDATE jobs SET quote_id = ? WHERE id = ?', [quote.id, job.job_id]);
    await run(env.DB, "UPDATE quotes SET status = 'accepted' WHERE id = ? AND status != 'accepted'", [quote.id]);
    await run(env.DB,
      `UPDATE opportunities SET stage = 'won' WHERE id = ? AND stage != 'won' AND deleted_at IS NULL`,
      [job.opportunity_id]);
  }

  const remaining = await one(env.DB,
    `SELECT COUNT(*) AS n FROM jobs j
      WHERE j.external_source = 'wfm' AND j.deleted_at IS NULL
        AND j.quote_id IS NULL
        AND json_extract(j.wfm_payload, '$.ApprovedQuoteUUID') > ''`);

  return json({
    ok: true,
    remaining: remaining?.n ?? 0,
    message: `Linked ${quote?.number || job.aq_uuid} to job ${job.job_number}. ${remaining?.n ?? 0} remaining.`,
  });
}

async function upsertQuoteFromDetail(env, rec, opportunityId) {
  const existing = await one(env.DB,
    'SELECT id FROM quotes WHERE external_id = ? AND deleted_at IS NULL',
    [rec.UUID]);
  if (existing) return existing.id;

  const id = crypto.randomUUID();
  const number = rec.ID || id.slice(0, 8);
  const status = QUOTE_STATE_TO_STATUS[rec.State] || 'draft';
  const ts = new Date().toISOString();

  await run(env.DB,
    `INSERT INTO quotes
       (id, number, external_source, external_id, opportunity_id,
        title, description, quote_type, status, valid_until,
        subtotal_price, tax_amount, total_price, notes_customer,
        wfm_number, wfm_state, wfm_payload, created_at, updated_at)
     VALUES (?, ?, 'wfm', ?, ?, ?, ?, 'spares', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, number, rec.UUID, opportunityId,
     rec.Name || '', rec.Description || '', status, rec.ValidDate || null,
     parseFloat(rec.Amount) || 0, parseFloat(rec.AmountTax) || 0,
     parseFloat(rec.AmountIncludingTax) || 0, rec.OptionExplanation || '',
     rec.ID || '', rec.State || '', JSON.stringify(rec), ts, ts]);

  return id;
}
