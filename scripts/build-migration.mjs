// scripts/build-migration.mjs
//
// One-shot build for the Migration Flows layer on /sandbox/us-map.
// Pulls IRS county-to-county outflow data (tax-return based, ~150K
// raw flows) and writes a compact JSON with one entry per real
// county pair plus a centroid lookup for the renderer.
//
// Source: https://www.irs.gov/statistics/soi-tax-stats-migration-data-2022-2023
//   countyoutflow2223.csv columns:
//     y1_statefips,y1_countyfips     origin
//     y2_statefips,y2_countyfips     destination
//     y2_state,y2_countyname
//     n1                              returns (≈ households)
//     n2                              exemptions (≈ people)
//     agi                             aggregate AGI
//
// IRS uses synthetic destination codes for totals (y2_statefips ≥ 57)
// — we keep only real US county pairs (y2_statefips 01–56). Drops
// flows with n2 < 10 to keep the file under 2 MB after centroid join.
//
// Run with:  node scripts/build-migration.mjs

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const OUT_DIR = resolve(REPO_ROOT, 'functions/sandbox/data');

const TMP = tmpdir();
const IRS_URL = 'https://www.irs.gov/pub/irs-soi/countyoutflow2223.csv';
const IRS_CACHE = join(TMP, 'countyoutflow2223.csv');
const GAZ_URL = 'https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2024_Gazetteer/2024_Gaz_counties_national.zip';
const GAZ_ZIP = join(TMP, '2024_Gaz_counties_national.zip');
const GAZ_TXT = join(TMP, '2024_Gaz_counties_national.txt');

const MIN_FLOW = 10;       // drop tiny flows
const VALID_STATE_RE = /^([0-9]{2})$/;  // 01..56 + 11 (DC)

async function fetchIRS() {
  if (existsSync(IRS_CACHE)) return readFile(IRS_CACHE, 'utf8');
  console.log('Downloading IRS outflow CSV...');
  const res = await fetch(IRS_URL);
  if (!res.ok) throw new Error('IRS fetch ' + res.status);
  const txt = await res.text();
  await writeFile(IRS_CACHE, txt);
  return txt;
}

async function fetchGaz() {
  if (!existsSync(GAZ_TXT)) {
    if (!existsSync(GAZ_ZIP)) {
      console.log('Downloading Gazetteer...');
      const res = await fetch(GAZ_URL);
      if (!res.ok) throw new Error('Gaz fetch ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      await writeFile(GAZ_ZIP, buf);
    }
    console.log('Unzipping...');
    execSync(`unzip -o "${GAZ_ZIP}" -d "${TMP}"`, { stdio: 'inherit' });
  }
  return readFile(GAZ_TXT, 'utf8');
}

function parseGazCentroids(txt) {
  const lines = txt.split(/\r?\n/);
  const header = lines[0].split('\t').map(s => s.trim());
  const ix = {};
  header.forEach((h, i) => ix[h] = i);
  const out = {};
  for (let i = 1; i < lines.length; i++) {
    const r = lines[i].split('\t');
    if (r.length < 5) continue;
    const fips = (r[ix.GEOID] || '').trim().padStart(5, '0');
    const lat = parseFloat(r[ix.INTPTLAT]);
    const lon = parseFloat(r[ix.INTPTLONG]);
    if (!/^\d{5}$/.test(fips) || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    out[fips] = [Math.round(lon * 1000) / 1000, Math.round(lat * 1000) / 1000];
  }
  return out;
}

const VALID_STATES = new Set([
  '01','02','04','05','06','08','09','10','11','12','13','15','16','17','18','19','20',
  '21','22','23','24','25','26','27','28','29','30','31','32','33','34','35','36','37',
  '38','39','40','41','42','44','45','46','47','48','49','50','51','53','54','55','56',
]);

function splitCsvLine(line) {
  // IRS data is straightforward — destination county names may have commas
  // but they're quoted. Lightweight quote-aware split.
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

async function main() {
  const csv = await fetchIRS();
  const lines = csv.split(/\r?\n/).filter(Boolean);
  const header = splitCsvLine(lines[0]);
  const ix = {};
  header.forEach((h, i) => ix[h.trim()] = i);

  console.log('Parsing CSV...');
  const flows = [];
  let totalRows = 0, dropped = 0;
  for (let i = 1; i < lines.length; i++) {
    const r = splitCsvLine(lines[i]);
    if (r.length < 9) continue;
    totalRows++;
    const o_st = (r[ix.y1_statefips] || '').padStart(2, '0');
    const o_co = (r[ix.y1_countyfips] || '').padStart(3, '0');
    const d_st = (r[ix.y2_statefips] || '').padStart(2, '0');
    const d_co = (r[ix.y2_countyfips] || '').padStart(3, '0');
    if (!VALID_STATES.has(o_st) || !VALID_STATES.has(d_st)) { dropped++; continue; }
    if (d_co === '000') { dropped++; continue; }  // state-level total
    const origin = o_st + o_co;
    const dest = d_st + d_co;
    if (origin === dest) { dropped++; continue; }
    const n2 = parseInt(r[ix.n2], 10);
    if (!Number.isFinite(n2) || n2 < MIN_FLOW) { dropped++; continue; }
    flows.push([origin, dest, n2]);
  }
  console.log(`  total rows: ${totalRows}, dropped: ${dropped}, kept flows: ${flows.length}`);

  const gazTxt = await fetchGaz();
  const centroids = parseGazCentroids(gazTxt);
  console.log(`Centroids: ${Object.keys(centroids).length}`);

  // Drop flows whose origin or destination has no centroid (PR/VI etc).
  const used = new Set();
  const filtered = flows.filter(f => centroids[f[0]] && centroids[f[1]]);
  filtered.forEach(f => { used.add(f[0]); used.add(f[1]); });
  console.log(`Flows with valid centroids: ${filtered.length}`);

  // Trim centroids to only what's referenced.
  const usedCentroids = {};
  for (const fips of used) usedCentroids[fips] = centroids[fips];

  // Sort flows descending by size so when we draw, big ones paint last.
  filtered.sort((a, b) => a[2] - b[2]);

  const meta = {
    source: IRS_URL,
    period: 'tax years 2022→2023',
    units: 'n2 = # of people (exemptions claimed)',
    min_kept: MIN_FLOW,
    flows: filtered.length,
    generated: new Date().toISOString().slice(0, 10),
  };

  const json = JSON.stringify({ __meta: meta, centroids: usedCentroids, flows: filtered });
  console.log(`payload: ${(json.length / 1024).toFixed(0)} KB`);

  await mkdir(OUT_DIR, { recursive: true });
  const jsPath = resolve(OUT_DIR, 'migration_flows.js');
  await writeFile(jsPath, `// Auto-generated by scripts/build-migration.mjs.
// DO NOT EDIT — re-run the script to refresh.
// IRS county-to-county migration flows for tax years 2022→2023.
//   centroids[fips] = [lon, lat]
//   flows = [[origin_fips, dest_fips, n_people], ...]
// Source: ${IRS_URL}

export const MIGRATION_FLOWS = ${json};
`);
  console.log(`wrote ${jsPath}`);
}

main().catch(err => { console.error(err); process.exit(1); });
