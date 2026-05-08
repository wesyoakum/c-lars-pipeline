// scripts/build-county-elevations.mjs
//
// One-shot build for the "Elevation" layer on /sandbox/us-map.
// Pulls per-county centroids from the U.S. Census 2024 Gazetteer file,
// then queries the Open-Meteo elevation API (batched, ~100 points per
// request) to get the elevation at each centroid. Writes one value
// per FIPS code in feet.
//
// "Mean elevation across the whole county" would require aggregating a
// DEM, which is heavy. Centroid elevation is a good proxy for the
// county's typical ground level for a sandbox visualization, and far
// cheaper to acquire (~32 HTTP calls vs. 800+ MB of raster data).
//
// Run with:  node scripts/build-county-elevations.mjs

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const OUT_JSON = resolve(REPO_ROOT, 'functions/sandbox/data/county_elevations.json');
const OUT_JS   = resolve(REPO_ROOT, 'functions/sandbox/data/county_elevations.js');

const GAZ_URL  = 'https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2024_Gazetteer/2024_Gaz_counties_national.zip';
// Store cache files in OS-appropriate tmp dir, not literal /tmp
// (which Node on Windows resolves to C:\tmp, not the unix-style /tmp).
const TMP = tmpdir();
const GAZ_ZIP  = join(TMP, '2024_Gaz_counties_national.zip');
const GAZ_TXT  = join(TMP, '2024_Gaz_counties_national.txt');
const ELEV_API = 'https://api.open-meteo.com/v1/elevation';
const BATCH    = 90;  // open-meteo accepts up to 100; leave headroom

async function fetchGazetteer() {
  if (!existsSync(GAZ_TXT)) {
    if (!existsSync(GAZ_ZIP)) {
      console.log('Downloading Gazetteer ZIP to', GAZ_ZIP);
      const res = await fetch(GAZ_URL);
      if (!res.ok) throw new Error(`Gazetteer fetch failed: ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      await writeFile(GAZ_ZIP, buf);
      console.log('  size:', buf.length, 'bytes');
    }
    console.log('Unzipping...');
    // Use tar (bsdtar) which handles zip on both Windows and Unix.
    execSync(`tar -xf "${GAZ_ZIP}" -C "${TMP}"`, { stdio: 'inherit' });
  }
  return readFile(GAZ_TXT, 'utf8');
}

function parseGazetteer(text) {
  const lines = text.split(/\r?\n/);
  const header = lines[0].split('\t').map(s => s.trim());
  const cols = {};
  header.forEach((h, i) => cols[h] = i);
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const row = lines[i].split('\t');
    if (row.length < 5) continue;
    const fips = (row[cols.GEOID] || '').trim().padStart(5, '0');
    const lat = parseFloat(row[cols.INTPTLAT]);
    const lon = parseFloat(row[cols.INTPTLONG]);
    const name = (row[cols.NAME] || '').trim();
    if (!fips || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    out.push({ fips, name, lat, lon });
  }
  return out;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function batchElevation(points, attempt = 1) {
  // Open-Meteo accepts comma-separated lats and lons in a single GET.
  const lats = points.map(p => p.lat).join(',');
  const lons = points.map(p => p.lon).join(',');
  const url = `${ELEV_API}?latitude=${lats}&longitude=${lons}`;
  const res = await fetch(url);
  if (res.status === 429 || res.status === 503) {
    if (attempt > 6) throw new Error(`Elevation API ${res.status} after ${attempt} retries`);
    const wait = Math.min(60000, 2000 * Math.pow(2, attempt - 1));
    console.log(`    ${res.status}, backing off ${wait/1000}s (attempt ${attempt})`);
    await sleep(wait);
    return batchElevation(points, attempt + 1);
  }
  if (!res.ok) throw new Error(`Elevation API ${res.status} for batch of ${points.length}`);
  const json = await res.json();
  if (!Array.isArray(json.elevation) || json.elevation.length !== points.length) {
    throw new Error(`Unexpected response shape: got ${JSON.stringify(json).slice(0, 200)}`);
  }
  return json.elevation; // meters
}

async function main() {
  const txt = await fetchGazetteer();
  const counties = parseGazetteer(txt);
  console.log(`Counties from Gazetteer: ${counties.length}`);

  // Drop territories whose FIPS state-prefix is outside 50 states + DC
  // (PR=72, USVI=78, NMI=69, AS=60, GU=66) — they don't render on the
  // AlbersUSA projection anyway.
  const STATE_OK = new Set([
    '01','02','04','05','06','08','09','10','11','12','13','15','16','17','18','19','20',
    '21','22','23','24','25','26','27','28','29','30','31','32','33','34','35','36','37',
    '38','39','40','41','42','44','45','46','47','48','49','50','51','53','54','55','56',
  ]);
  const filtered = counties.filter(c => STATE_OK.has(c.fips.slice(0, 2)));
  console.log(`After state filter: ${filtered.length}`);

  const out = {};
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < filtered.length; i += BATCH) {
    const slice = filtered.slice(i, i + BATCH);
    const elevs_m = await batchElevation(slice);
    for (let j = 0; j < slice.length; j++) {
      const m = elevs_m[j];
      if (m == null || !Number.isFinite(m)) continue;
      const ft = Math.round(m * 3.28084);
      out[slice[j].fips] = ft;
      if (ft < lo) lo = ft;
      if (ft > hi) hi = ft;
    }
    const done = Math.min(i + BATCH, filtered.length);
    console.log(`  ${done} / ${filtered.length}  (range so far: ${lo} - ${hi} ft)`);
    // Be polite — open-meteo's free tier rate-limits ~10K req/hour.
    // 700 ms between batches keeps us comfortably under that.
    await sleep(700);
  }
  console.log(`Final range: ${lo} - ${hi} ft over ${Object.keys(out).length} counties`);

  const meta = {
    source_centroids: GAZ_URL,
    source_elevation: ELEV_API,
    method: 'centroid lookup (county Gazetteer interior point → elevation API)',
    units: 'ft',
    range_ft: [lo, hi],
    generated: new Date().toISOString().slice(0, 10),
  };

  await mkdir(dirname(OUT_JSON), { recursive: true });
  await writeFile(OUT_JSON, JSON.stringify({ __meta: meta, ...out }, null, 0) + '\n');
  console.log(`Wrote ${OUT_JSON}`);

  const js = `// Auto-generated by scripts/build-county-elevations.mjs.
// DO NOT EDIT by hand — re-run the script to refresh.
// Approximate elevation (feet) at each US county's interior centroid.
// Source: U.S. Census 2024 Gazetteer (centroids) + Open-Meteo
// elevation API (DEM lookup). Values are county-centroid samples,
// not whole-county means; treat as a rough orientation, not survey.
//
//   COUNTY_ELEVATIONS_FT["08031"] = 5280  // Denver
//
// Coverage: 50 states + DC.

export const COUNTY_ELEVATIONS_FT = ${JSON.stringify(out)};
`;
  await writeFile(OUT_JS, js);
  console.log(`Wrote ${OUT_JS}`);
}

main().catch(err => { console.error(err); process.exit(1); });
