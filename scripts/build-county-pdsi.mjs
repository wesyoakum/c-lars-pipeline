// scripts/build-county-pdsi.mjs
//
// One-shot build for the "Drought" layer on /sandbox/us-map. Pulls
// NOAA's climdiv-pdsicy archive (county-level monthly Palmer Drought
// Severity Index, 1895–present) and reduces it to one ANNUAL MEAN
// PDSI value per county per year — keeps the data file tractable
// (~2 MB inline) while still showing the famous historical droughts
// (1934 Dust Bowl, 1988, 2012, etc.).
//
// PDSI scale (typical values):
//    > +4   extremely wet
//   +2..+4  moderately wet
//   -2..+2  near normal
//   -2..-4  moderate drought
//    < -4   extreme drought
//
// Run with:  node scripts/build-county-pdsi.mjs

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const OUT_JSON = resolve(REPO_ROOT, 'functions/sandbox/data/county_annual_pdsi.json');
const OUT_JS   = resolve(REPO_ROOT, 'functions/sandbox/data/county_annual_pdsi.js');

const SOURCE_LISTING = 'https://www.ncei.noaa.gov/pub/data/cirs/climdiv/';
const PREFIX = 'climdiv-pdsicy-';
const TMP = tmpdir();
const MISSING = -99.99;
const YEAR_FROM = 1900;  // pre-1900 PDSI gets sparse and isn't visualized below

// NOAA legacy state codes → FIPS state codes (same mapping as the
// climate-normals build script).
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

async function findLatestFile() {
  const res = await fetch(SOURCE_LISTING);
  if (!res.ok) throw new Error('Listing fetch failed: ' + res.status);
  const html = await res.text();
  const re = new RegExp(`(${PREFIX}v[0-9.]+-(\\d{8}))`, 'g');
  const matches = [...html.matchAll(re)];
  if (!matches.length) throw new Error(`No ${PREFIX} files found`);
  matches.sort((a, b) => b[2].localeCompare(a[2]));
  return matches[0][1];
}

async function downloadIfNeeded(filename) {
  const cache = join(TMP, filename);
  if (existsSync(cache)) {
    const txt = await readFile(cache, 'utf8');
    if (txt.length > 1_000_000) {
      console.log(`Cached ${filename} (${(txt.length / 1024 / 1024).toFixed(1)} MB)`);
      return txt;
    }
  }
  const url = SOURCE_LISTING + filename;
  console.log('Downloading', url);
  const res = await fetch(url);
  if (!res.ok) throw new Error('Download failed: ' + res.status);
  const txt = await res.text();
  await writeFile(cache, txt);
  return txt;
}

function parseLine(line) {
  if (line.length < 95) return null;
  const noaaState = line.slice(0, 2);
  const county = line.slice(2, 5);
  const year = parseInt(line.slice(7, 11), 10);
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
  const filename = await findLatestFile();
  const txt = await downloadIfNeeded(filename);
  const lines = txt.split(/\r?\n/);
  console.log(`Parsing ${lines.length.toLocaleString()} lines`);

  const yearMax = new Date().getFullYear();
  const years = [];
  for (let y = YEAR_FROM; y <= yearMax; y++) years.push(y);

  // byFips: fips → array of annual mean PDSI, indexed parallel to `years`.
  const byFips = new Map();
  let hits = 0;
  for (const line of lines) {
    const r = parseLine(line);
    if (!r) continue;
    if (r.year < YEAR_FROM || r.year > yearMax) continue;
    let arr = byFips.get(r.fips);
    if (!arr) {
      arr = new Array(years.length).fill(null);
      byFips.set(r.fips, arr);
    }
    let sum = 0, count = 0;
    for (const v of r.months) {
      if (v === MISSING) continue;
      sum += v; count++;
    }
    if (count >= 6) {
      // Need at least half the year of valid data. Round to 1dp to
      // shrink the JSON. PDSI values cluster between -10 and +10.
      arr[r.year - YEAR_FROM] = Math.round((sum / count) * 10) / 10;
    }
    hits++;
  }
  console.log(`Hits ${YEAR_FROM}-${yearMax}: ${hits.toLocaleString()} | counties: ${byFips.size}`);

  // Drop counties with too-sparse coverage so the slider doesn't show
  // gappy renders. Keep counties with ≥80% of years covered.
  const out = {};
  let dropped = 0;
  const minCovered = Math.floor(years.length * 0.8);
  for (const [fips, arr] of byFips) {
    const covered = arr.filter(v => v != null).length;
    if (covered < minCovered) { dropped++; continue; }
    out[fips] = arr;
  }
  console.log(`Kept ${Object.keys(out).length} counties, dropped ${dropped} (<${minCovered}/${years.length} years).`);

  const meta = {
    source: SOURCE_LISTING + filename,
    variable: 'PDSI annual mean (averaged across calendar months)',
    year_from: YEAR_FROM,
    year_to: yearMax,
    units: 'PDSI',
    generated: new Date().toISOString().slice(0, 10),
  };

  await mkdir(dirname(OUT_JSON), { recursive: true });
  await writeFile(OUT_JSON, JSON.stringify({ __meta: meta, years, data: out }, null, 0) + '\n');
  console.log(`Wrote ${OUT_JSON} (${(JSON.stringify(out).length / 1024 / 1024).toFixed(1)} MB)`);

  const js = `// Auto-generated by scripts/build-county-pdsi.mjs.
// DO NOT EDIT by hand — re-run the script to refresh.
// Annual mean Palmer Drought Severity Index per US county FIPS.
// Negative = drought, positive = wet. years[i] aligns with each
// county's data[fips][i].
//
// Source: ${meta.source}

export const COUNTY_ANNUAL_PDSI_YEARS = ${JSON.stringify(years)};
export const COUNTY_ANNUAL_PDSI = ${JSON.stringify(out)};
`;
  await writeFile(OUT_JS, js);
  console.log(`Wrote ${OUT_JS}`);
}

main().catch(err => { console.error(err); process.exit(1); });
