// functions/settings/wfm-import/fetch-accepted.js
//
// POST /settings/wfm-import/fetch-accepted
//
// Fetches ONE accepted quote from WFM that's missing in Pipeline.
// Finds the next job with ApprovedQuoteUUID that has no quote_id,
// calls /quote.api/get/{UUID}, upserts the quote, links it to the
// job, marks it accepted, advances the opp to won.
//
// Call repeatedly (browser loop or manual clicks) until it returns
// { ok: true, remaining: 0 }.
//
// GET returns a count of remaining quotes to fetch.

import { hasRole } from '../../lib/auth.js';
import { one, all, run } from '../../lib/db.js';
import { apiGet, recordList } from '../../lib/wfm-client.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

async function countRemaining(db) {
  const row = await one(db,
    `SELECT COUNT(*) AS n FROM jobs j
      WHERE j.external_source = 'wfm'
        AND j.deleted_at IS NULL
        AND j.quote_id IS NULL
        AND json_extract(j.wfm_payload, '$.ApprovedQuoteUUID') > ''`);
  return row?.n ?? 0;
}

export async function onRequestGet(context) {
  const { env, data } = context;
  if (!data?.user || !hasRole(data.user, 'admin')) return json({ error: 'admin only' }, 403);
  const remaining = await countRemaining(env.DB);

  const html = `<!DOCTYPE html><html><head><title>Fetch Accepted Quotes</title>
<style>body{font-family:system-ui;margin:2rem;color:#222}#log{margin-top:1rem;max-height:60vh;overflow-y:auto;font-family:ui-monospace,monospace;font-size:.85rem;line-height:1.6}
.ok{color:#1a7f37}.err{color:#cf222e}button{padding:.5rem 1.5rem;font-size:1rem;cursor:pointer;border:none;border-radius:4px;margin-right:.5rem}
.primary{background:#1f6feb;color:white}.primary:hover{background:#0550ae}.primary:disabled{opacity:.5;cursor:not-allowed}
.stop{background:#cf222e;color:white}.stop:hover{background:#a3161a}</style></head>
<body>
<h1>Fetch Accepted Quotes from WFM</h1>
<p><strong>${remaining}</strong> jobs have an ApprovedQuoteUUID but no linked quote in Pipeline.</p>
<p>Each click fetches one quote from WFM, imports it, links it to the job, marks it accepted, and advances the opp to won.</p>
<button class="primary" id="one" onclick="fetchOne()">Fetch next</button>
<button class="primary" id="all" onclick="fetchAll()">Fetch all (auto-loop)</button>
<button class="stop" id="stop" onclick="stopLoop()" style="display:none">Stop</button>
<div id="log"></div>
<script>
var running = false;
function log(msg, cls) {
  var d = document.getElementById('log');
  d.innerHTML = '<div class="'+(cls||'')+'">' + msg + '</div>' + d.innerHTML;
}
async function fetchOne() {
  document.getElementById('one').disabled = true;
  try {
    var r = await fetch('/settings/wfm-import/fetch-accepted', { method: 'POST', credentials: 'same-origin' });
    var d = await r.json();
    if (d.remaining === 0) { log('All done.', 'ok'); return; }
    if (d.ok) { log('Fetched ' + d.fetched + ' for job ' + d.job + ' — ' + d.remaining + ' remaining', 'ok'); }
    else { log('Error: ' + (d.error || 'unknown'), 'err'); }
  } catch(e) { log('Fetch error: ' + e.message, 'err'); }
  finally { document.getElementById('one').disabled = false; }
}
async function fetchAll() {
  running = true;
  document.getElementById('all').style.display = 'none';
  document.getElementById('stop').style.display = '';
  while (running) {
    try {
      var r = await fetch('/settings/wfm-import/fetch-accepted', { method: 'POST', credentials: 'same-origin' });
      var d = await r.json();
      if (d.remaining === 0) { log('All done!', 'ok'); break; }
      if (d.ok) { log('Fetched ' + d.fetched + ' for job ' + d.job + ' — ' + d.remaining + ' remaining', 'ok'); }
      else { log('Error: ' + (d.error || 'unknown'), 'err'); break; }
    } catch(e) { log('Fetch error: ' + e.message, 'err'); break; }
  }
  running = false;
  document.getElementById('all').style.display = '';
  document.getElementById('stop').style.display = 'none';
}
function stopLoop() { running = false; }
</script>
</body></html>`;

  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

export async function onRequestPost(context) {
  const { env, data } = context;
  if (!data?.user || !hasRole(data.user, 'admin')) return json({ error: 'admin only' }, 403);

  // Find the next job needing its quote fetched
  const job = await one(env.DB,
    `SELECT j.id AS job_id, j.number AS job_number, j.opportunity_id,
            json_extract(j.wfm_payload, '$.ApprovedQuoteUUID') AS aq_uuid,
            json_extract(j.wfm_payload, '$.ApprovedQuoteID') AS aq_id
       FROM jobs j
      WHERE j.external_source = 'wfm'
        AND j.deleted_at IS NULL
        AND j.quote_id IS NULL
        AND json_extract(j.wfm_payload, '$.ApprovedQuoteUUID') > ''
      LIMIT 1`);

  if (!job) {
    return json({ ok: true, remaining: 0, message: 'All done — no more quotes to fetch.' });
  }

  // Check if the quote already exists (imported via another path)
  let quote = await one(env.DB,
    'SELECT id, number, status FROM quotes WHERE external_id = ? AND deleted_at IS NULL',
    [job.aq_uuid]);

  if (!quote) {
    // Fetch from WFM
    const r = await apiGet(env, '/quote.api/get/' + encodeURIComponent(job.aq_uuid));
    if (!r.ok) {
      return json({ ok: false, error: `WFM API error for ${job.aq_uuid}: ${r.status}`, job: job.job_number });
    }
    const rec = recordList(r.body, 'Quote')[0];
    if (!rec) {
      return json({ ok: false, error: `No quote record in WFM response for ${job.aq_uuid}`, job: job.job_number });
    }

    // Insert the quote
    const id = crypto.randomUUID();
    const number = rec.ID || job.aq_id || id.slice(0, 8);
    const status = rec.State === 'Accepted' ? 'accepted'
                 : rec.State === 'Declined' ? 'rejected'
                 : rec.State === 'Issued' ? 'issued'
                 : 'draft';
    const ts = new Date().toISOString();

    await run(env.DB,
      `INSERT INTO quotes
         (id, number, external_source, external_id, opportunity_id,
          title, description, quote_type, status, valid_until,
          subtotal_price, tax_amount, total_price, notes_customer,
          wfm_number, wfm_state, wfm_payload, created_at, updated_at)
       VALUES (?, ?, 'wfm', ?, ?, ?, ?, 'spares', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, number, job.aq_uuid, job.opportunity_id,
       rec.Name || '', rec.Description || '', status, rec.ValidDate || null,
       parseFloat(rec.Amount) || 0, parseFloat(rec.AmountTax) || 0,
       parseFloat(rec.AmountIncludingTax) || 0, rec.OptionExplanation || '',
       rec.ID || '', rec.State || '', JSON.stringify(rec), ts, ts]);

    quote = { id, number, status };
  }

  // Link job to quote
  await run(env.DB, 'UPDATE jobs SET quote_id = ? WHERE id = ?', [quote.id, job.job_id]);

  // If quote is accepted, make sure it's marked that way and advance opp
  if (quote.status !== 'accepted') {
    await run(env.DB, "UPDATE quotes SET status = 'accepted' WHERE id = ?", [quote.id]);
  }
  await run(env.DB,
    `UPDATE opportunities SET stage = 'won'
      WHERE id = ? AND stage != 'won' AND deleted_at IS NULL`,
    [job.opportunity_id]);

  const remaining = await countRemaining(env.DB);

  return json({
    ok: true,
    fetched: quote.number,
    job: job.job_number,
    status: 'accepted',
    remaining,
  });
}
