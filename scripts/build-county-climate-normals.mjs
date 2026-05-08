// scripts/build-county-climate-normals.mjs
//
// One-shot data build for the climate-normal layers on /sandbox/us-map.
// Pulls four NOAA climdiv-* county files at once and writes one
// {json, js} pair per variable:
//
//   tmpccy → county_monthly_temps.{json,js}    (mean temperature, °F)
//   tmaxcy → county_monthly_highs.{json,js}    (mean daily max, °F)
//   tmincy → county_monthly_lows.{json,js}     (mean daily min, °F)
//   pcpncy → county_monthly_precip.{json,js}   (precipitation, inches)
//
// Each output is a flat object keyed by 5-digit FIPS GEOID with a
// 12-element array of monthly normals (Jan..Dec) averaged over
// 1991–2020. Coverage matches what AlbersUSA renders (3,142 counties).
//
// Source listing:
//   https://www.ncei.noaa.gov/pub/data/cirs/climdiv/
// File format (from county-readme.txt):
//   cols 1–2  state  (NOAA legacy alphabetical: 01–48 contiguous,
//                     49=HI, 50=AK; mapped back to FIPS state codes)
//   cols 3–5  county FIPS
//   cols 6–7  element code (02 for tmp/tmax/tmin/pcpn — same code
//             across files; the file name picks the variable)
//   cols 8–11 year (1895–present)
//   cols 12–95  12 × f7.2 monthly values
//
// Run with:  node scripts/build-county-climate-normals.mjs
// Re-run anytime to refresh; the .json/.js files are the source of
// truth at runtime and replace the previous outputs in place.

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const OUT_DIR = resolve(REPO_ROOT, 'functions/sandbox/data');

const SOURCE_LISTING = 'https://www.ncei.noaa.gov/pub/data/cirs/climdiv/';

// One entry per variable to build. `prefix` is the climdiv-* file name
// prefix (NOAA's own naming is inconsistent — tmpccy / cddccy / hddccy
// have a double-c, the others have one).
const VARIABLES = [
  {
    prefix: 'climdiv-tmpccy-',
    out: 'county_monthly_temps',
    constant: 'COUNTY_MONTHLY_TEMPS_F',
    units: '°F',
    valid: [-80, 150],
    blurb: '1991-2020 mean temperature (°F) per US county FIPS, by month.',
  },
  {
    prefix: 'climdiv-tmaxcy-',
    out: 'county_monthly_highs',
    constant: 'COUNTY_MONTHLY_HIGHS_F',
    units: '°F',
    valid: [-60, 160],
    blurb: '1991-2020 mean daily maximum temperature (°F) per US county FIPS, by month.',
  },
  {
    prefix: 'climdiv-tmincy-',
    out: 'county_monthly_lows',
    constant: 'COUNTY_MONTHLY_LOWS_F',
    units: '°F',
    valid: [-100, 130],
    blurb: '1991-2020 mean daily minimum temperature (°F) per US county FIPS, by month.',
  },
  {
    prefix: 'climdiv-pcpncy-',
    out: 'county_monthly_precip',
    constant: 'COUNTY_MONTHLY_PRECIP_IN',
    units: 'in',
    valid: [-1, 100],  // inches per month; some PNW counties top 30"
    blurb: '1991-2020 mean monthly precipitation (inches) per US county FIPS, by month.',
  },
];

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

let _listingPromise = null;
function getListing() {
  if (!_listingPromise) {
    _listingPromise = fetch(SOURCE_LISTING).then(r => {
      if (!r.ok) throw new Error('Listing fetch failed: ' + r.status);
      return r.text();
    });
  }
  return _listingPromise;
}

async function findLatestFile(prefix) {
  const html = await getListing();
  const re = new RegExp(`(${prefix}v[0-9.]+-(\\d{8}))`, 'g');
  const matches = [...html.matchAll(re)];
  if (!matches.length) throw new Error(`No file with prefix ${prefix} found`);
  matches.sort((a, b) => b[2].localeCompare(a[2]));
  return matches[0][1];
}

async function downloadIfNeeded(filename) {
  const cache = '/tmp/' + filename;
  if (existsSync(cache)) {
    const txt = await readFile(cache, 'utf8');
    if (txt.length > 1_000_000) {
      console.log(`  cached ${filename} (${(txt.length / 1024 / 1024).toFixed(1)} MB)`);
      return txt;
    }
  }
  const url = SOURCE_LISTING + filename;
  console.log(`  downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error('Download failed: ' + res.status);
  const txt = await res.text();
  await writeFile(cache, txt);
  console.log(`  cached ${(txt.length / 1024 / 1024).toFixed(1)} MB to ${cache}`);
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

async function buildVariable(variable) {
  console.log(`\n[${variable.prefix}]`);
  const filename = await findLatestFile(variable.prefix);
  const txt = await downloadIfNeeded(filename);
  const lines = txt.split(/\r?\n/);

  const acc = new Map();
  let hits = 0;
  for (const line of lines) {
    const r = parseLine(line);
    if (!r) continue;
    if (r.year < NORMAL_FROM || r.year > NORMAL_TO) continue;
    let entry = acc.get(r.fips);
    if (!entry) {
      entry = { sum: new Array(12).fill(0), count: new Array(12).fill(0) };
      acc.set(r.fips, entry);
    }
    for (let m = 0; m < 12; m++) {
      const v = r.months[m];
      if (v === MISSING || v < variable.valid[0] || v > variable.valid[1]) continue;
      entry.sum[m] += v;
      entry.count[m] += 1;
    }
    hits++;
  }

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
  console.log(`  hits ${NORMAL_FROM}-${NORMAL_TO}: ${hits.toLocaleString()}; FIPS kept ${Object.keys(out).length}, dropped ${dropped}`);

  const meta = {
    source: SOURCE_LISTING + filename,
    window: `${NORMAL_FROM}-${NORMAL_TO}`,
    units: variable.units,
    generated: new Date().toISOString().slice(0, 10),
  };

  await mkdir(OUT_DIR, { recursive: true });
  const jsonPath = resolve(OUT_DIR, `${variable.out}.json`);
  const jsPath   = resolve(OUT_DIR, `${variable.out}.js`);
  await writeFile(jsonPath, JSON.stringify({ __meta: meta, ...out }, null, 0) + '\n');
  const js = `// Auto-generated by scripts/build-county-climate-normals.mjs.
// DO NOT EDIT by hand — re-run the script to refresh.
// ${variable.blurb}
//   ${variable.constant}["17031"] = [Jan, Feb, ..., Dec]
// Source: ${meta.source}

export const ${variable.constant} = ${JSON.stringify(out)};
`;
  await writeFile(jsPath, js);
  console.log(`  wrote ${jsonPath}`);
  console.log(`  wrote ${jsPath}`);
}

async function main() {
  for (const v of VARIABLES) {
    await buildVariable(v);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
