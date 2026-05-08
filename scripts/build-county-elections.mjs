// scripts/build-county-elections.mjs
//
// One-shot build for the "Presidential Elections" layer on
// /sandbox/us-map. Pulls county-level presidential vote totals from
// the tonmcg GitHub repo (which compiles from official sources) and
// reduces each county to its R-D margin (positive = Republican lean,
// negative = Democratic lean) for each election year 2008-2024.
//
// Source: https://github.com/tonmcg/US_County_Level_Election_Results_08-24
//
// Run with:  node scripts/build-county-elections.mjs

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const OUT_JSON = resolve(REPO_ROOT, 'functions/sandbox/data/county_elections.json');
const OUT_JS   = resolve(REPO_ROOT, 'functions/sandbox/data/county_elections.js');

const REPO = 'https://raw.githubusercontent.com/tonmcg/US_County_Level_Election_Results_08-24/master';
const TMP = tmpdir();

// 2008-2016 ship together; 2020 and 2024 are separate per-year files.
const SOURCES = [
  { kind: 'multi', path: 'US_County_Level_Presidential_Results_08-16.csv', years: [2008, 2012, 2016] },
  { kind: 'year',  path: '2020_US_County_Level_Presidential_Results.csv',  year: 2020 },
  { kind: 'year',  path: '2024_US_County_Level_Presidential_Results.csv',  year: 2024 },
];

async function fetchCsv(name) {
  const cache = join(TMP, name);
  if (existsSync(cache)) return readFile(cache, 'utf8');
  const url = REPO + '/' + name;
  console.log('Downloading', url);
  const res = await fetch(url);
  if (!res.ok) throw new Error('fetch failed: ' + res.status);
  const txt = await res.text();
  await writeFile(cache, txt);
  return txt;
}

function splitCsvLine(line) {
  const out = []; let cur = ''; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQ = !inQ; continue; }
    if (c === ',' && !inQ) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

function parseRows(txt) {
  const lines = txt.split(/\r?\n/).filter(l => l.length > 0);
  const header = splitCsvLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    const row = {};
    for (let j = 0; j < header.length; j++) row[header[j]] = cols[j];
    rows.push(row);
  }
  return rows;
}

function pad5(s) {
  return String(s || '').replace(/^"|"$/g, '').trim().padStart(5, '0');
}

async function main() {
  // byFips[fips] = { 2008: marginPct, 2012: ..., ... }
  const byFips = new Map();
  const yearsSeen = new Set();

  for (const src of SOURCES) {
    const txt = await fetchCsv(src.path);
    const rows = parseRows(txt);
    if (src.kind === 'multi') {
      for (const r of rows) {
        const fips = pad5(r.fips_code);
        if (!/^\d{5}$/.test(fips)) continue;
        let entry = byFips.get(fips);
        if (!entry) { entry = {}; byFips.set(fips, entry); }
        for (const y of src.years) {
          const total = parseInt(r['total_' + y], 10);
          const dem = parseInt(r['dem_' + y], 10);
          const gop = parseInt(r['gop_' + y], 10);
          if (!Number.isFinite(total) || total <= 0) continue;
          const margin = ((gop - dem) / total) * 100;
          entry[y] = Math.round(margin * 10) / 10;
          yearsSeen.add(y);
        }
      }
    } else {
      const y = src.year;
      for (const r of rows) {
        const fips = pad5(r.county_fips);
        if (!/^\d{5}$/.test(fips)) continue;
        const total = parseInt(r.total_votes, 10);
        const dem = parseInt(r.votes_dem, 10);
        const gop = parseInt(r.votes_gop, 10);
        if (!Number.isFinite(total) || total <= 0) continue;
        let entry = byFips.get(fips);
        if (!entry) { entry = {}; byFips.set(fips, entry); }
        entry[y] = Math.round(((gop - dem) / total) * 1000) / 10;
        yearsSeen.add(y);
      }
    }
  }

  const years = [...yearsSeen].sort((a, b) => a - b);
  console.log('Years:', years.join(', '));

  // Final shape: { years, data: { fips: [m_2008, m_2012, m_2016, m_2020, m_2024] } }
  // Use null for any missing year in a county.
  const data = {};
  let kept = 0, dropped = 0;
  for (const [fips, entry] of byFips) {
    const arr = years.map(y => (y in entry) ? entry[y] : null);
    const validCount = arr.filter(v => v != null).length;
    if (validCount === 0) { dropped++; continue; }
    data[fips] = arr;
    kept++;
  }
  console.log(`Kept ${kept} counties (dropped ${dropped} with no data)`);

  const meta = {
    source: 'https://github.com/tonmcg/US_County_Level_Election_Results_08-24',
    years,
    units: 'GOP - DEM margin, percentage points',
    generated: new Date().toISOString().slice(0, 10),
  };

  await mkdir(dirname(OUT_JSON), { recursive: true });
  await writeFile(OUT_JSON, JSON.stringify({ __meta: meta, years, data }, null, 0) + '\n');
  console.log(`Wrote ${OUT_JSON}`);

  const js = `// Auto-generated by scripts/build-county-elections.mjs.
// DO NOT EDIT by hand — re-run the script to refresh.
// Presidential election margins per US county FIPS, 2008-2024.
// COUNTY_ELECTION_YEARS[i] aligns with each county's
// COUNTY_ELECTIONS[fips][i]. Value is GOP minus DEM share, in
// percentage points (positive = R lean, negative = D lean).
//
// Source: ${meta.source}

export const COUNTY_ELECTION_YEARS = ${JSON.stringify(years)};
export const COUNTY_ELECTIONS = ${JSON.stringify(data)};
`;
  await writeFile(OUT_JS, js);
  console.log(`Wrote ${OUT_JS}`);
}

main().catch(err => { console.error(err); process.exit(1); });
