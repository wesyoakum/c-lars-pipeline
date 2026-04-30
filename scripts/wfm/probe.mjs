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
import { apiGet, getAccessToken, decodeJwtPayload } from './api-client.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const REPORT_PATH = path.join(REPO_ROOT, 'docs', 'wfm-api-probe-results.md');

// Each entry corresponds to one entity from §4 of the migration plan.
// `path` is the BlueRock v2 endpoint to probe; `pathAlternates` is a
// list of fallbacks tried in order if the primary 404s. The probe
// records the first one that returns 2xx (or, if all 4xx/5xx, all of
// them with their statuses so we can see what's there).
const ENTITY_PROBES = [
  {
    key:     'clients',
    label:   'Clients',
    pipelineDest: 'accounts',
    paths:   ['/v2/clients'],
  },
  {
    key:     'contacts',
    label:   'Contacts',
    pipelineDest: 'contacts',
    paths:   [
      '/v2/clients/contacts',     // per the v2 nav
      '/v2/contacts',             // fallback if v2 promoted contacts to top-level
    ],
  },
  {
    key:     'leads',
    label:   'Leads',
    pipelineDest: 'opportunities',
    paths:   ['/v2/leads'],
  },
  {
    key:     'quotes',
    label:   'Quotes',
    pipelineDest: 'quotes + quote_lines',
    paths:   ['/v2/quotes'],
  },
  {
    key:     'jobs',
    label:   'Jobs',
    pipelineDest: 'TBD (jobs vs. closed-won opps)',
    paths:   ['/v2/jobs'],
  },
  {
    key:     'tasks',
    label:   'Tasks',
    pipelineDest: 'activities',
    paths:   ['/v2/tasks'],
  },
  {
    key:     'time',
    label:   'Time entries',
    pipelineDest: 'TBD (no time_entries table yet)',
    paths:   ['/v2/timesheets', '/v2/time-entries', '/v2/time'],
  },
  {
    key:     'invoices',
    label:   'Invoices',
    pipelineDest: 'TBD (no invoices table yet)',
    paths:   ['/v2/invoices'],
  },
  {
    key:     'staff',
    label:   'Staff',
    pipelineDest: 'users',
    paths:   ['/v2/staff'],
  },
  {
    key:     'custom_fields',
    label:   'Custom field definitions',
    pipelineDest: 'TBD (per-field decision)',
    paths:   ['/v2/custom-fields', '/v2/customfields'],
  },
  {
    key:     'documents',
    label:   'Documents (top-level — likely to 404, kept for completeness)',
    pipelineDest: 'documents + R2',
    paths:   ['/v2/documents', '/v2/attachments'],
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

// Pull the first record out of a paginated body shape. Mirrors the
// logic in api-client.mjs's apiGetAllPages but kept here so the probe
// report doesn't depend on which envelope key was used.
function firstRecord(body) {
  if (Array.isArray(body)) return body[0] ?? null;
  if (!body || typeof body !== 'object') return null;
  for (const k of ['data', 'items', 'results', 'records', 'value']) {
    if (Array.isArray(body[k])) return body[k][0] ?? null;
  }
  for (const v of Object.values(body)) {
    if (Array.isArray(v)) return v[0] ?? null;
  }
  return null;
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

  // Rate-limit headers (whatever BlueRock sends).
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

  // Open gaps reminder.
  sections.push('## Notes');
  sections.push('');
  sections.push('- The probe used a `?page=1&pageSize=2` URL for every endpoint. If BlueRock\'s pagination params are different, the response should still surface its envelope keys above — search "Pagination envelope keys present" sections to see what came back.');
  sections.push('- Tenant header name is whatever `WFM_TENANT_HEADER_NAME` is set to in `.env.local` (default `xero-tenant-id`). If every endpoint 401s, that header is the most likely culprit — try `tenant-id` or `account-id` and re-run.');
  sections.push('- Document / attachment endpoints are flagged "likely to 404" in the table — BlueRock\'s v2 docs say those are nested under jobs / clients / leads / suppliers / POs. Once we confirm a primary entity (likely jobs), we can probe `/v2/jobs/{id}/documents` separately.');
  sections.push('');

  fs.writeFileSync(REPORT_PATH, sections.join('\n'));
  console.log(`\nReport written to ${path.relative(REPO_ROOT, REPORT_PATH)}`);
}

main().catch((err) => {
  console.error('Fatal:', err.stack || err.message);
  process.exitCode = 1;
});
