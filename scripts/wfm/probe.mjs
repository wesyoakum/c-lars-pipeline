#!/usr/bin/env node
//
// scripts/wfm/probe.mjs
//
// Phase 0 of the WFM migration plan: hit the BlueRock v2 API once for
// each entity in §4 of docs/wfm-migration-plan.md and record:
//   - did the endpoint exist (status code, response time)
//   - what fields came back (top-level + nested keys, sampled to depth 2)
//   - one sample record (truncated, secrets-stripped)
//   - rate-limit-ish headers if BlueRock surfaces them
//
// Output: docs/wfm-api-probe-results.md (overwritten each run).
//
// Usage:
//   node scripts/wfm/probe.mjs
//
// Reads credentials from .env.local via api-client.mjs. If anything is
// missing, the api-client throws a clear error.
//
// Notes on endpoint paths:
//   The agent research that led to docs/wfm-api-oauth-setup.md inventoried
//   the endpoint paths from BlueRock's v2 docs. Those paths are encoded
//   below. If the probe gets 404 for an endpoint, we report it as a gap
//   so the migration plan can adjust scope (or fall back to XLSX for
//   that entity).
//
//   Document/attachment paths are flagged "TBD" in the docs — the probe
//   tries the most likely paths and reports what it finds.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiGet, getAccessToken, decodeJwtPayload, findRecordArray } from './api-client.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const REPORT_PATH = path.join(REPO_ROOT, 'docs', 'wfm-api-probe-results.md');

// Each entry corresponds to one entity from §4 of the migration plan.
// `paths` is the list of BlueRock endpoints to try in order; the probe
// records the first one that returns 2xx (or, if all 4xx/5xx, all of
// them with their statuses so we can see what's there).
//
// Endpoint shape confirmed against the live OAS 3.0 spec at
// api.workflowmax2.com — BlueRock kept the legacy v1 path style
// (/{resource}.api/{action}) but rebuilt the server with JSON
// responses. Documents and contacts have no top-level list endpoint —
// they're probed indirectly below in probeDocumentsNested() /
// probeContactsNested() since you can only enumerate them via a
// parent resource.
const ENTITY_PROBES = [
  {
    key:     'clients',
    label:   'Clients',
    pipelineDest: 'accounts',
    paths:   ['/client.api/list'],
  },
  {
    key:     'leads',
    label:   'Leads',
    pipelineDest: 'opportunities (early-stage)',
    paths:   ['/lead.api/list', '/lead.api/current'],
  },
  {
    key:     'quotes',
    label:   'Quotes',
    pipelineDest: 'quotes + quote_lines',
    paths:   ['/quote.api/list', '/quote.api/current'],
  },
  {
    key:     'jobs',
    label:   'Jobs',
    pipelineDest: 'TBD (jobs vs. closed-won opps — discuss in Phase 1)',
    paths:   ['/job.api/list', '/job.api/current'],
  },
  {
    key:     'tasks',
    label:   'Tasks',
    pipelineDest: 'activities',
    paths:   ['/task.api/list'],
  },
  {
    key:     'time',
    label:   'Time entries',
    pipelineDest: 'TBD (no time_entries table yet)',
    // Bare /time.api/list 400s — same as the other /list endpoints
    // that need a date range. WFM v1 historically used compact
    // YYYYMMDD format on `from` / `to`. Try both formats; if either
    // works, that's the convention the importer should use.
    paths:   [
      '/time.api/list?from=20260101&to=20260430',
      '/time.api/list?from=2026-01-01&to=2026-04-30',
      '/time.api/list',
    ],
  },
  {
    key:     'invoices',
    label:   'Invoices',
    pipelineDest: 'TBD (no invoices table yet)',
    paths:   ['/invoice.api/list', '/invoice.api/current'],
  },
  {
    key:     'staff',
    label:   'Staff',
    pipelineDest: 'users',
    paths:   ['/staff.api/list'],
  },
  {
    key:     'custom_fields',
    label:   'Custom field definitions',
    pipelineDest: 'TBD (per-field decision)',
    paths:   ['/customfield.api/definition'],
  },
  {
    key:     'categories',
    label:   'Categories',
    pipelineDest: 'TBD (could map to tags / stages)',
    paths:   ['/category.api/list'],
  },
  {
    key:     'templates',
    label:   'Job templates',
    pipelineDest: 'TBD (probably skip — internal WFM concept)',
    paths:   ['/template.api/list'],
  },
];

// Pagination defaults. The migration plan flagged that BlueRock's
// pagination param names aren't documented; we try `?page=1&pageSize=2`
// first and the probe report will show what came back, including any
// pagination-shaped envelope keys (totalPages, hasMore, etc.).
const PROBE_PAGE_SIZE = 2;

function probeUrl(p) {
  const sep = p.includes('?') ? '&' : '?';
  return `${p}${sep}page=1&pageSize=${PROBE_PAGE_SIZE}`;
}

// Recursively summarize a JSON object: list every key with its type,
// sampled to a max depth so the report doesn't blow up on huge nested
// docs. Arrays show their length + the first element's shape.
function summarizeShape(value, depth = 0, maxDepth = 2) {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (depth >= maxDepth) return `[${value.length} items …]`;
    return `[${value.length}× ${summarizeShape(value[0], depth + 1, maxDepth)}]`;
  }
  if (typeof value === 'object') {
    if (depth >= maxDepth) return '{…}';
    const keys = Object.keys(value);
    if (keys.length === 0) return '{}';
    const inner = keys.map(k => {
      const t = summarizeShape(value[k], depth + 1, maxDepth);
      return `${k}: ${t}`;
    }).join(', ');
    return `{ ${inner} }`;
  }
  return typeof value;
}

// Sanitize a sample record: strip anything that smells like a secret
// (access_token, api_key, password, …) before writing to the report.
const SECRET_KEY_RE = /token|secret|password|api[_-]?key|authorization/i;
function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY_RE.test(k) ? '«redacted»' : sanitize(v);
    }
    return out;
  }
  return value;
}

// Pull the first record out of a paginated body shape. Uses the
// shared findRecordArray helper which handles bare arrays, common
// JSON envelopes, and BlueRock's 3-level XML wrap (Response →
// Clients → Client[]).
function firstRecord(body) {
  const arr = findRecordArray(body);
  if (arr && arr.length > 0) return arr[0];
  // Fallback for single-record XML responses where the parser
  // collapses a 1-element list into an object: walk 3 levels deep
  // and return the first record-shaped object we find.
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  function dfsObject(obj, depth) {
    if (depth > 3 || !obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    for (const v of Object.values(obj)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const inner = dfsObject(v, depth + 1);
        if (inner) return inner;
        return v;
      }
    }
    return null;
  }
  return dfsObject(body, 0);
}

// Look for any envelope keys that suggest pagination shape so we know
// what BlueRock actually returns (and can update apiGetAllPages later).
function detectPaginationHints(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  const hints = [];
  const knownKeys = [
    'page', 'pageSize', 'page_size', 'per_page',
    'totalCount', 'total_count', 'total',
    'totalPages', 'total_pages', 'pageCount', 'page_count',
    'hasMore', 'has_more', 'isLastPage', 'is_last_page',
    'next', 'next_page', 'next_cursor', 'next_token',
    'links', 'meta', 'pagination',
  ];
  for (const k of knownKeys) {
    if (k in body) {
      const v = body[k];
      const summary = (typeof v === 'object' && v !== null)
        ? summarizeShape(v, 0, 1)
        : JSON.stringify(v);
      hints.push(`${k} = ${summary}`);
    }
  }
  return hints;
}

// Pick a useful identifier out of a probed list response so we can
// chain a follow-up nested call. Walks: bare array, top-level array
// inside an object, and the BlueRock XML envelope two levels deep
// (Response.Clients.Client[0].UUID).
function pickFirstIdentifier(body, idKeys) {
  const first = firstRecord(body);
  if (!first || typeof first !== 'object') return null;
  for (const k of idKeys) {
    if (first[k]) return String(first[k]);
  }
  return null;
}

async function probeContactsNested(allProbes) {
  // Find the Clients probe and pick a client UUID from its body.
  const clientsProbe = allProbes.find((p) => p.entity.key === 'clients');
  if (!clientsProbe || !clientsProbe.chosen) {
    return {
      summary: '⏭ skipped (clients probe didn\'t return data)',
      report: '> Skipped — the Clients probe did not return any data, so we couldn\'t pick a client UUID to probe contacts on.',
    };
  }
  const uuid = pickFirstIdentifier(clientsProbe.chosen.body, ['UUID', 'uuid', 'Identifier', 'id']);
  if (!uuid) {
    return {
      summary: '⏭ skipped (no client UUID in body)',
      report: `> Skipped — Clients probe body had no field matching common identifier keys (UUID, uuid, Identifier, id). Body shape: \`${summarizeShape(clientsProbe.chosen.body, 0, 2)}\``,
    };
  }
  // /client.api/get/{UUID} returns the full client including its
  // contacts array — that's the canonical way to enumerate contacts.
  const path = `/client.api/get/${uuid}`;
  let res;
  try { res = await apiGet(path); }
  catch (err) {
    return {
      summary: `❌ threw (${err.message?.slice(0, 60) || 'unknown'})`,
      report: `- **Path attempted:** \`${path}\`\n- **Result:** threw \`${err.message}\``,
    };
  }
  const ok = res.ok;
  const lines = [
    `- **Path attempted:** \`${path}\``,
    `- **Result:** ${ok ? '✅' : '❌'} ${res.status} (${res.durationMs}ms)`,
  ];
  if (ok) {
    lines.push(`- **Top-level shape:**`);
    lines.push('  ```');
    lines.push('  ' + summarizeShape(res.body, 0, 2));
    lines.push('  ```');
    // Try to count nested contacts.
    const root = (res.body && typeof res.body === 'object') ? Object.values(res.body)[0] : res.body;
    const contactsField = root && typeof root === 'object'
      ? (root.Contacts || root.contacts)
      : null;
    if (contactsField) {
      const contactsArr = Array.isArray(contactsField)
        ? contactsField
        : (contactsField.Contact || contactsField.contact || []);
      lines.push(`- **Contacts on this client:** ${Array.isArray(contactsArr) ? contactsArr.length : 'unknown shape'}`);
      if (Array.isArray(contactsArr) && contactsArr.length) {
        lines.push('- **Sample contact (sanitized):**');
        lines.push('  ```json');
        JSON.stringify(sanitize(contactsArr[0]), null, 2).split('\n').forEach(l => lines.push('  ' + l));
        lines.push('  ```');
      }
    } else {
      lines.push('- **Contacts on this client:** _no Contacts field found in body — might be a different key name; check the shape line above_');
    }
  } else {
    lines.push(`- **Body (first 500 chars):** \`${(typeof res.body === 'string' ? res.body : JSON.stringify(res.body)).slice(0, 500)}\``);
  }
  return {
    summary: ok ? `✅ ${res.status} (${path})` : `❌ ${res.status}`,
    report: lines.join('\n'),
  };
}

async function probeDocumentsNested(allProbes) {
  const lines = [];
  let anyOk = false;

  // Probe client documents.
  const clientsProbe = allProbes.find((p) => p.entity.key === 'clients');
  let clientUuid = null;
  if (clientsProbe?.chosen?.body) {
    clientUuid = pickFirstIdentifier(clientsProbe.chosen.body, ['UUID', 'uuid', 'Identifier']);
  }
  if (clientUuid) {
    const cPath = `/client.api/documents/${clientUuid}`;
    try {
      const res = await apiGet(cPath);
      if (res.ok) anyOk = true;
      lines.push(`#### Client documents`);
      lines.push(`- **Path:** \`${cPath}\``);
      lines.push(`- **Status:** ${res.ok ? '✅' : '❌'} ${res.status} (${res.durationMs}ms)`);
      if (res.ok) {
        lines.push(`- **Top-level shape:**`);
        lines.push('  ```');
        lines.push('  ' + summarizeShape(res.body, 0, 2));
        lines.push('  ```');
      } else {
        const bodyStr = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
        lines.push(`- **Body (first 400 chars):** \`${bodyStr.slice(0, 400)}\``);
      }
    } catch (err) {
      lines.push(`#### Client documents`);
      lines.push(`- **Path:** \`${cPath}\` threw \`${err.message}\``);
    }
  } else {
    lines.push(`#### Client documents`);
    lines.push('- _Skipped — no client UUID available from the Clients probe._');
  }

  // Probe job documents.
  const jobsProbe = allProbes.find((p) => p.entity.key === 'jobs');
  let jobNumber = null;
  if (jobsProbe?.chosen?.body) {
    jobNumber = pickFirstIdentifier(jobsProbe.chosen.body, ['Number', 'JobNumber', 'job_number', 'ID']);
  }
  if (jobNumber) {
    const jPath = `/job.api/documents/${jobNumber}`;
    try {
      const res = await apiGet(jPath);
      if (res.ok) anyOk = true;
      lines.push('');
      lines.push(`#### Job documents`);
      lines.push(`- **Path:** \`${jPath}\``);
      lines.push(`- **Status:** ${res.ok ? '✅' : '❌'} ${res.status} (${res.durationMs}ms)`);
      if (res.ok) {
        lines.push(`- **Top-level shape:**`);
        lines.push('  ```');
        lines.push('  ' + summarizeShape(res.body, 0, 2));
        lines.push('  ```');
      } else {
        const bodyStr = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
        lines.push(`- **Body (first 400 chars):** \`${bodyStr.slice(0, 400)}\``);
      }
    } catch (err) {
      lines.push('');
      lines.push(`#### Job documents`);
      lines.push(`- **Path:** \`${jPath}\` threw \`${err.message}\``);
    }
  } else {
    lines.push('');
    lines.push(`#### Job documents`);
    lines.push('- _Skipped — no job number available from the Jobs probe._');
  }

  return {
    summary: anyOk ? '✅ at least one OK' : '❌ both failed or skipped',
    report: lines.join('\n'),
  };
}

async function probeOne(entity) {
  const attempts = [];
  let chosen = null;

  for (const p of entity.paths) {
    const url = probeUrl(p);
    let res;
    try {
      res = await apiGet(url);
    } catch (err) {
      attempts.push({ path: p, status: 'ERROR', error: err?.message || String(err) });
      continue;
    }
    attempts.push({
      path: p,
      status: res.status,
      durationMs: res.durationMs,
      url: res.url,
    });
    if (res.ok && !chosen) {
      chosen = { ...res, triedPath: p };
    }
  }

  return { entity, attempts, chosen };
}

function renderEntitySection(probe) {
  const { entity, attempts, chosen } = probe;
  const lines = [];
  lines.push(`### ${entity.label}`);
  lines.push('');
  lines.push(`- **Plan key:** \`${entity.key}\``);
  lines.push(`- **Pipeline destination:** ${entity.pipelineDest}`);
  lines.push(`- **Paths attempted:**`);
  for (const a of attempts) {
    if (a.status === 'ERROR') {
      lines.push(`  - \`${a.path}\` → **threw** \`${a.error}\``);
    } else {
      const ok = a.status >= 200 && a.status < 300;
      lines.push(`  - \`${a.path}\` → **${a.status}**${ok ? ' ✅' : ' ❌'} (${a.durationMs}ms)`);
    }
  }

  if (!chosen) {
    lines.push('');
    lines.push('> ⚠ No path returned 2xx. Either the endpoint is differently named in BlueRock v2, or the OAuth scope doesn\'t cover it. Flag for migration plan.');
    lines.push('');
    return lines.join('\n');
  }

  // Content-type + parsed format — useful when the body's shape is
  // unexpected (XML vs JSON gotchas, etc.).
  if (chosen.contentType) {
    lines.push(`- **Content-Type:** \`${chosen.contentType}\` (parsed as \`${chosen.bodyFormat || 'text'}\`)`);
  }

  // Rate-limit / debug headers.
  const interestingHeaders = Object.entries(chosen.headers)
    .filter(([k]) => /rate|retry|quota|x-request|x-correlation/i.test(k));
  if (interestingHeaders.length) {
    lines.push('- **Headers (rate-limit / debug):**');
    for (const [k, v] of interestingHeaders) {
      lines.push(`  - \`${k}\`: \`${v}\``);
    }
  }

  // Pagination shape.
  const pagHints = detectPaginationHints(chosen.body);
  if (pagHints.length) {
    lines.push('- **Pagination envelope keys present:**');
    for (const h of pagHints) lines.push(`  - \`${h}\``);
  } else {
    lines.push('- **Pagination envelope keys present:** _none detected — body is likely a bare array, or pagination is link-header / cursor-based._');
  }

  // Top-level shape.
  lines.push('- **Top-level response shape:**');
  lines.push('  ```');
  lines.push('  ' + summarizeShape(chosen.body, 0, 2));
  lines.push('  ```');

  // If the body is still a string, the parser didn't recognize the
  // format. Surface the first 400 chars so we can see what came back.
  if (typeof chosen.body === 'string' && chosen.rawText) {
    lines.push('- **Body (first 400 chars, unparsed):**');
    lines.push('  ```');
    chosen.rawText.slice(0, 400).split('\n').forEach(l => lines.push('  ' + l));
    lines.push('  ```');
  }

  // Sample record.
  const first = firstRecord(chosen.body);
  if (first) {
    const sanitized = sanitize(first);
    const sampleJson = JSON.stringify(sanitized, null, 2);
    const truncated = sampleJson.length > 4000
      ? sampleJson.slice(0, 4000) + `\n… (${sampleJson.length - 4000} more chars)`
      : sampleJson;
    lines.push('- **Sample record (sanitized):**');
    lines.push('  <details><summary>JSON</summary>');
    lines.push('');
    lines.push('  ```json');
    truncated.split('\n').forEach(l => lines.push('  ' + l));
    lines.push('  ```');
    lines.push('');
    lines.push('  </details>');
  } else {
    lines.push('- **Sample record:** _empty (no rows in this org, or pagination needs different params)_');
  }

  lines.push('');
  return lines.join('\n');
}

async function main() {
  console.log('Probing BlueRock WFM API…');

  // Sanity check: refresh the token first so a credentials issue
  // surfaces before we waste request budget on each entity.
  let token, jwt;
  try {
    token = await getAccessToken({ force: true });
    jwt = decodeJwtPayload(token);
    console.log('  OAuth refresh: ✅');
  } catch (err) {
    console.error('  OAuth refresh failed:', err.message);
    process.exitCode = 1;
    // Still write a report so the user can see what failed.
    const report = [
      '# WFM API probe — credentials check failed',
      '',
      `**Run at:** ${new Date().toISOString()}`,
      '',
      '> The probe could not refresh the OAuth token. The rest of the run was skipped.',
      '',
      '```',
      err.message,
      '```',
      '',
      'See `docs/wfm-api-oauth-setup.md` for the credentials flow. Once `node scripts/wfm/api-client.mjs --whoami` works, re-run this probe.',
      '',
    ].join('\n');
    fs.writeFileSync(REPORT_PATH, report);
    return;
  }

  const probes = [];
  for (const entity of ENTITY_PROBES) {
    process.stdout.write(`  ${entity.label.padEnd(40)} `);
    const probe = await probeOne(entity);
    if (probe.chosen) {
      console.log(`✅ ${probe.chosen.status} (${probe.chosen.triedPath})`);
    } else {
      console.log('❌ no 2xx');
    }
    probes.push(probe);
  }

  // Nested probes — contacts and documents have no top-level list
  // endpoint in the BlueRock v1-style API. Probe them by chaining off
  // a sample client/job UUID picked from the earlier probes' results.
  process.stdout.write(`  ${'Contacts (nested under client)'.padEnd(40)} `);
  const contactsProbe = await probeContactsNested(probes);
  console.log(contactsProbe.summary);

  process.stdout.write(`  ${'Documents (nested per client+job)'.padEnd(40)} `);
  const documentsProbe = await probeDocumentsNested(probes);
  console.log(documentsProbe.summary);

  // Build the report.
  const sections = [];
  sections.push('# WFM API probe results');
  sections.push('');
  sections.push(`**Run at:** ${new Date().toISOString()}`);
  sections.push(`**Probe script:** \`scripts/wfm/probe.mjs\``);
  sections.push(`**API client:** \`scripts/wfm/api-client.mjs\``);
  sections.push('');
  sections.push('Each section below records what one paginated GET against the entity\'s primary path returned, plus any fallback paths tried. The intent is to confirm Phase 0 of the migration plan (`docs/wfm-migration-plan.md` §8) — that the BlueRock v2 API actually exposes every entity we need before we commit to the API-based importer.');
  sections.push('');

  if (jwt) {
    sections.push('## Tenant / token info');
    sections.push('');
    sections.push('Decoded JWT payload (unverified, just for sanity):');
    sections.push('');
    sections.push('```json');
    sections.push(JSON.stringify(sanitize(jwt), null, 2));
    sections.push('```');
    sections.push('');
  }

  // Summary table.
  sections.push('## Summary');
  sections.push('');
  sections.push('| Entity | Result | Path |');
  sections.push('|---|---|---|');
  for (const probe of probes) {
    if (probe.chosen) {
      sections.push(`| ${probe.entity.label} | ✅ ${probe.chosen.status} | \`${probe.chosen.triedPath}\` |`);
    } else {
      const last = probe.attempts[probe.attempts.length - 1];
      const lastStr = last ? (last.status === 'ERROR' ? 'threw' : `${last.status}`) : 'no attempt';
      sections.push(`| ${probe.entity.label} | ❌ ${lastStr} | _${probe.attempts.map(a => a.path).join(', ')}_ |`);
    }
  }
  sections.push('');

  // Per-entity detail.
  sections.push('## Per-entity detail');
  sections.push('');
  for (const probe of probes) {
    sections.push(renderEntitySection(probe));
  }

  // Nested probes (contacts + documents).
  sections.push('### Contacts (nested under client)');
  sections.push('');
  sections.push(contactsProbe.report);
  sections.push('');
  sections.push('### Documents (nested per client + per job)');
  sections.push('');
  sections.push(documentsProbe.report);
  sections.push('');

  // Open gaps reminder.
  sections.push('## Notes');
  sections.push('');
  sections.push('- The probe used a `?page=1&pageSize=2` URL for every endpoint. The BlueRock OAS 3.0 spec shows the v1-style path layout (`/{resource}.api/list`) but doesn\'t spell out pagination params; if every list returns the same set of records regardless of `page`, that\'s the signal we need to switch to a different param convention. Search "Pagination envelope keys present" sections to see what came back.');
  sections.push('- Tenant header is `account_id` per the BlueRock auth article (the v1 / Xero-era `xero-tenant-id` is gone). If every endpoint 401s with the new default, double-check `WFM_TENANT_ID` matches the org ID inside the JWT.');
  sections.push('- Contacts have no top-level list endpoint — they\'re nested inside each client. To migrate them, walk the client list and read each client\'s detail (`/client.api/get/{UUID}`).');
  sections.push('- Documents are nested per resource (client + job); the probe tries one of each. There may be document endpoints on leads / suppliers / POs too — add them later if Phase 1 needs them.');
  sections.push('- Rate limits per BlueRock: 5 concurrent calls, 60 calls/min, 5000/day. Phase 1 importers will need to throttle (probably 60 RPM with a small concurrency limit).');
  sections.push('');

  fs.writeFileSync(REPORT_PATH, sections.join('\n'));
  console.log(`\nReport written to ${path.relative(REPO_ROOT, REPORT_PATH)}`);
}

main().catch((err) => {
  console.error('Fatal:', err.stack || err.message);
  process.exitCode = 1;
});
