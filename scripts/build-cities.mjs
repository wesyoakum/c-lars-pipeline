// scripts/build-cities.mjs
//
// One-shot build for the "Cities" point-symbols layer on
// /sandbox/us-map. Joins two Census Bureau datasets:
//   1. 2024 Gazetteer "place" file → lat/lon centroid per place
//   2. ACS 5-year 2022, B01003_001E → population per place
// Output: a flat array of {name, state, lat, lon, pop} for every
// place that resolves on the AlbersUSA projection (50 states + DC).
//
// "Place" in Census parlance = incorporated place (city/town/borough)
// or census-designated place. ~30K total nationwide. We drop tiny
// places (< 200 people) to keep the data manageable; the platform
// renders the rest as circles sized by population, with a slider
// that filters by minimum population.
//
// Run with:  node scripts/build-cities.mjs

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const OUT_JSON = resolve(REPO_ROOT, 'functions/sandbox/data/cities.json');
const OUT_JS   = resolve(REPO_ROOT, 'functions/sandbox/data/cities.js');

const TMP = tmpdir();
const GAZ_URL = 'https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2024_Gazetteer/2024_Gaz_place_national.zip';
const GAZ_ZIP = join(TMP, '2024_Gaz_place_national.zip');
const GAZ_TXT = join(TMP, '2024_Gaz_place_national.txt');
const ACS_URL = 'https://api.census.gov/data/2022/acs/acs5?get=NAME,B01003_001E&for=place:*&in=state:*';

const MIN_POP = 200;  // drop hamlets — the slider needs to start somewhere

// State-prefix filter to keep AlbersUSA-rendered places only
// (50 states + DC). Drops PR/USVI/NMI/AS/GU.
const STATE_OK = new Set([
  '01','02','04','05','06','08','09','10','11','12','13','15','16','17','18','19','20',
  '21','22','23','24','25','26','27','28','29','30','31','32','33','34','35','36','37',
  '38','39','40','41','42','44','45','46','47','48','49','50','51','53','54','55','56',
]);

// USPS abbreviation → state FIPS for the Gazetteer rows (which carry
// USPS, not FIPS, in the first column).
const USPS_TO_FIPS = {
  AL:'01', AK:'02', AZ:'04', AR:'05', CA:'06', CO:'08', CT:'09', DE:'10', DC:'11',
  FL:'12', GA:'13', HI:'15', ID:'16', IL:'17', IN:'18', IA:'19', KS:'20', KY:'21',
  LA:'22', ME:'23', MD:'24', MA:'25', MI:'26', MN:'27', MS:'28', MO:'29', MT:'30',
  NE:'31', NV:'32', NH:'33', NJ:'34', NM:'35', NY:'36', NC:'37', ND:'38', OH:'39',
  OK:'40', OR:'41', PA:'42', RI:'44', SC:'45', SD:'46', TN:'47', TX:'48', UT:'49',
  VT:'50', VA:'51', WA:'53', WV:'54', WI:'55', WY:'56',
};

async function fetchGazetteerPlaces() {
  if (!existsSync(GAZ_TXT)) {
    if (!existsSync(GAZ_ZIP)) {
      console.log('Downloading', GAZ_URL);
      const res = await fetch(GAZ_URL);
      if (!res.ok) throw new Error('Gazetteer fetch failed: ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      await writeFile(GAZ_ZIP, buf);
    }
    console.log('Unzipping...');
    // Prefer unzip; tar on this GNU build doesn't auto-detect zip.
    execSync(`unzip -o "${GAZ_ZIP}" -d "${TMP}"`, { stdio: 'inherit' });
  }
  return readFile(GAZ_TXT, 'utf8');
}

function parseGazPlaces(text) {
  const lines = text.split(/\r?\n/);
  const header = lines[0].split('\t').map(s => s.trim());
  const ix = {};
  header.forEach((h, i) => ix[h] = i);
  const out = new Map();
  // Place GEOID = 7 digits (state-2 + place-5).
  for (let i = 1; i < lines.length; i++) {
    const row = lines[i].split('\t');
    if (row.length < 5) continue;
    const usps = (row[ix.USPS] || '').trim();
    const geoid = (row[ix.GEOID] || '').trim();
    const name = (row[ix.NAME] || '').trim();
    const lat = parseFloat(row[ix.INTPTLAT]);
    const lon = parseFloat(row[ix.INTPTLONG]);
    if (!geoid || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const stateFips = USPS_TO_FIPS[usps];
    if (!stateFips) continue;
    if (!STATE_OK.has(stateFips)) continue;
    const placeFips = geoid.length === 7 ? geoid.slice(2) : geoid.padStart(7, '0').slice(2);
    out.set(stateFips + placeFips, { name, stateFips, usps, lat, lon });
  }
  return out;
}

async function fetchAcs() {
  const cache = join(TMP, 'acs-places-2022.json');
  if (existsSync(cache)) return JSON.parse(await readFile(cache, 'utf8'));
  console.log('Downloading ACS places API...');
  const res = await fetch(ACS_URL);
  if (!res.ok) throw new Error('ACS fetch failed: ' + res.status);
  const txt = await res.text();
  await writeFile(cache, txt);
  return JSON.parse(txt);
}

async function main() {
  const gazText = await fetchGazetteerPlaces();
  const places = parseGazPlaces(gazText);
  console.log(`Gazetteer places (filtered to 50 states + DC): ${places.size}`);

  const acs = await fetchAcs();
  const header = acs[0];
  const iName = header.indexOf('NAME');
  const iPop = header.indexOf('B01003_001E');
  const iSt = header.indexOf('state');
  const iPl = header.indexOf('place');

  const out = [];
  let dropped = 0;
  for (let i = 1; i < acs.length; i++) {
    const r = acs[i];
    const stateFips = String(r[iSt]).padStart(2, '0');
    const placeFips = String(r[iPl]).padStart(5, '0');
    const key = stateFips + placeFips;
    const pop = parseInt(r[iPop], 10);
    if (!Number.isFinite(pop) || pop < MIN_POP) { dropped++; continue; }
    const gaz = places.get(key);
    if (!gaz) { dropped++; continue; }
    out.push({
      name: gaz.name,
      st: gaz.usps,
      lat: Math.round(gaz.lat * 10000) / 10000,
      lon: Math.round(gaz.lon * 10000) / 10000,
      pop,
    });
  }
  // Sort by population descending so larger cities draw last (on top).
  out.sort((a, b) => b.pop - a.pop);
  console.log(`Cities kept (pop ≥ ${MIN_POP}): ${out.length}, dropped ${dropped}`);

  const meta = {
    sources: [GAZ_URL, ACS_URL],
    min_pop: MIN_POP,
    generated: new Date().toISOString().slice(0, 10),
    note: 'name + state + lat + lon + ACS 2022 5-year population',
  };

  await mkdir(dirname(OUT_JSON), { recursive: true });
  await writeFile(OUT_JSON, JSON.stringify({ __meta: meta, cities: out }, null, 0) + '\n');
  console.log(`Wrote ${OUT_JSON}`);

  const js = `// Auto-generated by scripts/build-cities.mjs.
// DO NOT EDIT by hand — re-run the script to refresh.
// US incorporated places + CDPs with population ≥ ${MIN_POP}.
//   { name, st (USPS), lat, lon, pop }
// Sorted by population descending so the renderer paints big cities
// on top of small ones without an explicit z-order.
//
// Sources: Census 2024 Gazetteer (centroids) + ACS 2022 5-year (pop).

export const CITIES = ${JSON.stringify(out)};
`;
  await writeFile(OUT_JS, js);
  console.log(`Wrote ${OUT_JS}`);
}

main().catch(err => { console.error(err); process.exit(1); });
