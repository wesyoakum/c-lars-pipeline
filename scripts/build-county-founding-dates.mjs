// scripts/build-county-founding-dates.mjs
//
// One-shot data build for /sandbox/counties. Pulls every US county's
// FIPS + inception year from Wikidata via SPARQL, joins against the
// FIPS list embedded in us-atlas counties-10m.json (the same TopoJSON
// the page renders from), logs missing counties, and writes
//   functions/sandbox/data/county_founding_dates.json
// keyed by 5-digit FIPS GEOID.
//
// Run with:  node scripts/build-county-founding-dates.mjs
//
// Re-run any time you want to refresh from Wikidata; the JSON file
// is the source of truth at runtime.

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const OUT_JSON = resolve(REPO_ROOT, 'functions/sandbox/data/county_founding_dates.json');
const OUT_JS   = resolve(REPO_ROOT, 'functions/sandbox/data/county_founding_dates.js');

const SPARQL_ENDPOINT = 'https://query.wikidata.org/sparql';
// Two queries — we union the results client-side. The first is the
// strict "US county + subclasses" pull; the second catches Louisiana
// parishes, Virginia independent cities, Alaska boroughs/census areas,
// and Puerto Rico municipalities that don't sit under Q47168 cleanly.
// Filter by FIPS regex (5 digits) since P882 is also used for state
// FIPS (2 digits) and a few other geo IDs.
const SPARQL_QUERIES = [
  `
SELECT ?fips ?countyLabel ?stateLabel ?inception WHERE {
  ?county wdt:P31/wdt:P279* wd:Q47168 .
  ?county wdt:P882 ?fips .
  ?county wdt:P571 ?inception .
  OPTIONAL { ?county wdt:P131 ?state . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
`,
  `
SELECT ?fips ?countyLabel ?stateLabel ?inception WHERE {
  ?county wdt:P882 ?fips .
  ?county wdt:P571 ?inception .
  FILTER(REGEX(?fips, "^[0-9]{5}$"))
  OPTIONAL { ?county wdt:P131 ?state . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
`,
];

const TOPOJSON_URL = 'https://cdn.jsdelivr.net/npm/us-atlas@3/counties-10m.json';

// Hand-filled gaps for FIPS that Wikidata returns nothing usable for.
// Sourced from Wikipedia infoboxes — verified individually before adding.
// Territories (USVI 78xxx, NMI 69xxx, PR 72xxx) aren't projected by
// d3.geoAlbersUsa and stay off-map, so they don't need entries.
const MANUAL_OVERRIDES = {
  '06059': 1889, // Orange County, California
  '08031': 1861, // Denver County / consolidated City and County of Denver, Colorado
  '02261': 1980, // Valdez-Cordova Census Area, Alaska (since dissolved 2019)
  '51570': 1948, // Colonial Heights, Virginia (independent city)
  '51580': 1952, // Covington, Virginia (independent city)
  '51690': 1928, // Martinsville, Virginia (independent city)
};

async function fetchSparql() {
  const all = [];
  for (const q of SPARQL_QUERIES) {
    const url = `${SPARQL_ENDPOINT}?query=${encodeURIComponent(q)}&format=json`;
    console.log('SPARQL query length:', q.length, 'chars');
    const res = await fetch(url, {
      headers: {
        'Accept': 'application/sparql-results+json',
        'User-Agent': 'C-LARS-PMS-CountyMapBuilder/1.0 (wes.yoakum@c-lars.com)',
      },
    });
    if (!res.ok) throw new Error(`SPARQL ${res.status}: ${await res.text()}`);
    const json = await res.json();
    console.log(`  -> ${json.results.bindings.length} rows`);
    all.push(...json.results.bindings);
  }
  return all;
}

async function fetchTopoFipsList() {
  console.log('TopoJSON:', TOPOJSON_URL);
  const res = await fetch(TOPOJSON_URL);
  if (!res.ok) throw new Error(`TopoJSON ${res.status}`);
  const us = await res.json();
  const counties = us.objects.counties.geometries || [];
  const list = counties.map(g => ({
    fips: String(g.id).padStart(5, '0'),
    name: g.properties?.name ?? '',
  }));
  return list;
}

function pickEarliestPerFips(rows) {
  const byFips = new Map();
  for (const r of rows) {
    const fips = (r.fips?.value ?? '').padStart(5, '0');
    const iso = r.inception?.value;
    if (!fips || !iso) continue;
    const m = iso.match(/^-?(\d{1,4})/);
    if (!m) continue;
    const sign = iso.startsWith('-') ? -1 : 1;
    const year = sign * parseInt(m[1], 10);
    if (year < 1500 || year > 2030) continue;
    const prev = byFips.get(fips);
    if (prev == null || year < prev.year) {
      byFips.set(fips, {
        year,
        county: r.countyLabel?.value ?? '',
        state: r.stateLabel?.value ?? '',
      });
    }
  }
  return byFips;
}

async function main() {
  const [sparqlRows, topoList] = await Promise.all([fetchSparql(), fetchTopoFipsList()]);
  console.log(`SPARQL rows:   ${sparqlRows.length}`);
  console.log(`TopoJSON FIPS: ${topoList.length}`);

  const byFips = pickEarliestPerFips(sparqlRows);
  console.log(`Unique FIPS in SPARQL: ${byFips.size}`);

  const out = {};
  const missing = [];
  for (const c of topoList) {
    const override = MANUAL_OVERRIDES[c.fips];
    if (override != null) {
      out[c.fips] = override;
      continue;
    }
    const hit = byFips.get(c.fips);
    if (hit) {
      out[c.fips] = hit.year;
    } else {
      missing.push(c);
    }
  }
  out.__meta = {
    source: 'Wikidata SPARQL (P882 FIPS + P571 inception, scoped to US states by P131/P31/P279*)',
    generated: new Date().toISOString().slice(0, 10),
    coverage: `${Object.keys(out).length - 0} of ${topoList.length}`,
  };

  console.log(`\nCovered: ${Object.keys(out).length - 1} / ${topoList.length}`);
  console.log(`Missing: ${missing.length}`);
  if (missing.length) {
    console.log('First 30 missing:');
    for (const m of missing.slice(0, 30)) {
      console.log(`  ${m.fips}  ${m.name}`);
    }
  }

  await mkdir(dirname(OUT_JSON), { recursive: true });
  await writeFile(OUT_JSON, JSON.stringify(out, null, 0) + '\n');
  console.log(`\nWrote ${OUT_JSON}`);

  // Cloudflare Pages Functions consume an ES module rather than a raw
  // .json import, so we also emit a .js wrapper. Strip __meta from the
  // runtime export — it's only for the JSON file's documentation.
  const runtime = { ...out };
  delete runtime.__meta;
  const js = `// Auto-generated by scripts/build-county-founding-dates.mjs.
// DO NOT EDIT by hand — re-run the script to refresh from Wikidata.
// Source of truth: county_founding_dates.json next to this file.
//
// Map of 5-digit FIPS GEOID → year the county/parish/independent city
// was founded. Coverage: ${Object.keys(runtime).length} of ${topoList.length} entries
// in us-atlas counties-10m.json.

export const COUNTY_FOUNDING_BY_FIPS = ${JSON.stringify(runtime)};
`;
  await writeFile(OUT_JS, js);
  console.log(`Wrote ${OUT_JS}`);
}

main().catch(err => { console.error(err); process.exit(1); });
