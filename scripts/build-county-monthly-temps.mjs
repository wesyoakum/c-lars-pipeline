// scripts/build-county-monthly-temps.mjs
//
// One-shot data build for the "Monthly Temperature" layer on
// /sandbox/us-map. Computes 1991–2020 monthly mean temperature
// climatologies per US county from NOAA's climdiv-tmpccy archive
// (county-level monthly mean temperature, 1895–present).
//
// Source:
//   https://www.ncei.noaa.gov/pub/data/cirs/climdiv/
//   File pattern: climdiv-tmpccy-vX.Y.Z-YYYYMMDD
//   Format: fixed-width ASCII, °F, columns documented in
//   county-readme.txt next to the data file.
//
// State codes in the file are NOAA legacy (alphabetical 01–48 for the
// contiguous US, 49=HI, 50=AK), NOT FIPS. We map them back to FIPS
// state codes so the keys match us-atlas counties-10m.json.
//
// Run with:  node scripts/build-county-monthly-temps.mjs
//
// Re-run anytime to refresh; the .json/.js are the source of truth at
// runtime and replace the old files in place.

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const OUT_JSON = resolve(REPO_ROOT, 'functions/sandbox/data/county_monthly_temps.json');
const OUT_JS   = resolve(REPO_ROOT, 'functions/sandbox/data/county_monthly_temps.js');

// Cache the 40MB climdiv file in /tmp so reruns don't redownload.
const CACHE_FILE = '/tmp/climdiv-tmpccy-cache.txt';
const SOURCE_LISTING = 'https://www.ncei.noaa.gov/pub/data/cirs/climdiv/';
const SOURCE_PREFIX = 'climdiv-tmpccy-';

// NOAA legacy state code → FIPS state code. Verified by cross-checking
// county counts against expected per-state county counts (e.g. NOAA 06
// has 8 counties → CT; NOAA 43 has 14 → VT; NOAA 50 has ~30 boroughs
// with AK-shaped FIPS county codes → AK).
const NOAA_TO_FIPS_STATE = {
  '01': '01', '02': '04', '03': '05', '04': '06', '05': '08',
  '06': '09', '07': '10', '08': '12', '09': '13', '10': '16',
  '11': '17', '12': '18', '13': '19', '14': '20', '15': '21',
  '16': '22', '17': '23', '18': '24', '19': '25', '20': '26',
  '21': '27', '22': '28', '23': '29', '24': '30', '25': '31',
  '26': '32', '27': '33', '28': '34', '29': '35', '30': '36',
  '31': '37', '32': '38', '33': '39', '34': '40', '35': '41',
  '36': '42', '37': '44', '38': '45', '39': '46', '40': '47',
  '41': '48', '42': '49', '43': '50', '44': '51', '45': '53',
  '46': '54', '47': '55', '48': '56', '49': '15', '50': '02',
};

const NORMAL_FROM = 1991;
const NORMAL_TO = 2020;
const MISSING = -99.99;

async function findLatestSourceFile() {
  const res = await fetch(SOURCE_LISTING);
  if (!res.ok) throw new Error(`Listing fetch failed: ${res.status}`);
  const html = await res.text();
  const matches = [...html.matchAll(/(climdiv-tmpccy-v[0-9.]+-(\d{8}))/g)];
  if (!matches.length) throw new Error('No climdiv-tmpccy file found in listing');
  matches.sort((a, b) => b[2].localeCompare(a[2]));
  return matches[0][1];
}

async function downloadIfNeeded() {
  if (existsSync(CACHE_FILE)) {
    const txt = await readFile(CACHE_FILE, 'utf8');
    if (txt.length > 1_000_000) {
      console.log(`Using cached file (${(txt.length / 1024 / 1024).toFixed(1)} MB)`);
      return txt;
    }
  }
  const filename = await findLatestSourceFile();
  const url = SOURCE_LISTING + filename;
  console.log('Downloading', url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const txt = await res.text();
  await writeFile(CACHE_FILE, txt);
  console.log(`Cached ${(txt.length / 1024 / 1024).toFixed(1)} MB to ${CACHE_FILE}`);
  return txt;
}

function parseLine(line) {
  if (line.length < 95) return null;
  const noaaState = line.slice(0, 2);
  const county = line.slice(2, 5);
  const element = line.slice(5, 7);
  const year = parseInt(line.slice(7, 11), 10);
  if (element !== '02') return null;
  const fipsState = NOAA_TO_FIPS_STATE[noaaState];
  if (!fipsState) return null;
  const fips = fipsState + county;
  const months = [];
  for (let i = 0; i < 12; i++) {
    const v = parseFloat(line.slice(11 + i * 7, 18 + i * 7));
    months.push(Number.isFinite(v) ? v : MISSING);
  }
  return { fips, year, months };
}

async function main() {
  const txt = await downloadIfNeeded();
  const lines = txt.split(/\r?\n/);
  console.log(`Parsing ${lines.length.toLocaleString()} lines`);

  // For each FIPS, accumulate (sum, count) per month over the
  // NORMAL_FROM..NORMAL_TO window.
  const acc = new Map();
  let hits = 0, skipped = 0;
  for (const line of lines) {
    const r = parseLine(line);
    if (!r) { skipped++; continue; }
    if (r.year < NORMAL_FROM || r.year > NORMAL_TO) continue;
    let entry = acc.get(r.fips);
    if (!entry) {
      entry = { sum: new Array(12).fill(0), count: new Array(12).fill(0) };
      acc.set(r.fips, entry);
    }
    for (let m = 0; m < 12; m++) {
      const v = r.months[m];
      if (v === MISSING || v < -80 || v > 150) continue;
      entry.sum[m] += v;
      entry.count[m] += 1;
    }
    hits++;
  }
  console.log(`Hits in ${NORMAL_FROM}-${NORMAL_TO}: ${hits.toLocaleString()} | rejected lines: ${skipped.toLocaleString()}`);
  console.log(`Unique FIPS: ${acc.size.toLocaleString()}`);

  // Compute per-FIPS monthly means; round to 1 decimal to keep JSON small.
  const out = {};
  let dropped = 0;
  for (const [fips, e] of acc) {
    const months = [];
    let ok = true;
    for (let m = 0; m < 12; m++) {
      if (e.count[m] === 0) { ok = false; break; }
      months.push(Math.round((e.sum[m] / e.count[m]) * 10) / 10);
    }
    if (ok) out[fips] = months;
    else dropped++;
  }
  console.log(`Dropped (incomplete coverage): ${dropped} | kept: ${Object.keys(out).length}`);

  const meta = {
    source: SOURCE_LISTING,
    file: 'climdiv-tmpccy (latest)',
    window: `${NORMAL_FROM}-${NORMAL_TO}`,
    units: 'F',
    generated: new Date().toISOString().slice(0, 10),
  };
  const jsonOut = { __meta: meta, ...out };

  await mkdir(dirname(OUT_JSON), { recursive: true });
  await writeFile(OUT_JSON, JSON.stringify(jsonOut, null, 0) + '\n');
  console.log(`Wrote ${OUT_JSON}`);

  const js = `// Auto-generated by scripts/build-county-monthly-temps.mjs.
// DO NOT EDIT by hand — re-run the script to refresh.
// 1991-2020 mean temperature (°F) per US county FIPS, by month.
//   COUNTY_MONTHLY_TEMPS_F["17031"] = [Jan, Feb, ..., Dec]
// Source: NOAA climdiv-tmpccy (county monthly mean temperature).

export const COUNTY_MONTHLY_TEMPS_F = ${JSON.stringify(out)};
`;
  await writeFile(OUT_JS, js);
  console.log(`Wrote ${OUT_JS}`);
}

main().catch(err => { console.error(err); process.exit(1); });
