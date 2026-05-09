// scripts/fetch-zcta-per-capita.mjs
//
// One-shot ACS fetch for the ZIP per-capita-income layer. Pulls just
// the new B19301_001E variable (per-capita income, past 12 months,
// 2018-2022 ACS 5-year) and writes zcta_income_per_capita.js. Avoids
// re-running the full build-zcta.mjs (which would also re-fetch ~33 K
// polygons from TIGERweb).
//
// build-zcta.mjs was updated to fetch B19301_001E too, so future
// rebuilds stay consistent.
//
// Run with:  node scripts/fetch-zcta-per-capita.mjs

import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '..', 'functions/sandbox/data/zcta_income_per_capita.js');

const ACS_URL = 'https://api.census.gov/data/2022/acs/acs5?get=NAME,B19301_001E&for=zip%20code%20tabulation%20area:*';

console.log('ACS:', ACS_URL);
const res = await fetch(ACS_URL);
if (!res.ok) throw new Error('ACS fetch ' + res.status);
const acs = await res.json();
const header = acs[0];
const iPerCap = header.indexOf('B19301_001E');
const iZcta = header.indexOf('zip code tabulation area');

const perCap = {};
for (let i = 1; i < acs.length; i++) {
  const r = acs[i];
  const z = String(r[iZcta]);
  const pc = parseInt(r[iPerCap], 10);
  if (Number.isFinite(pc) && pc > 0) perCap[z] = pc;
}
const vals = Object.values(perCap);
const sum = vals.reduce((a, b) => a + b, 0);
console.log(`per-capita coverage: ${vals.length} ZCTAs, mean $${Math.round(sum / vals.length).toLocaleString()}, range $${Math.min(...vals).toLocaleString()}-$${Math.max(...vals).toLocaleString()}`);

await writeFile(OUT,
`// Auto-generated. Per-capita income (past 12 months) per ZCTA, ACS 2022 5-year B19301.
export const ZCTA_INCOME_PER_CAPITA = ${JSON.stringify(perCap)};
`);
console.log(`wrote ${OUT}`);
