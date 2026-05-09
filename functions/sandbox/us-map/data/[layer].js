// functions/sandbox/us-map/data/[layer].js
//
// GET /sandbox/us-map/data/<layer>  →  JSON for one layer's data.
//
// The us-map page used to inline ~5 MB of layer data into every page
// response. This endpoint splits the heavy stuff out so the initial
// HTML stays small (~50 KB) and each layer's data only travels when
// the user actually activates that layer. Browser caches the JSON
// for 5 minutes via cache-control.
//
// Wes-only — same email gate as the rest of /sandbox/*.

import { STATEHOOD_BY_NAME } from '../../data/statehood_dates.js';
import { COUNTY_FOUNDING_BY_FIPS } from '../../data/county_founding_dates.js';
import { COUNTY_MONTHLY_TEMPS_F }   from '../../data/county_monthly_temps.js';
import { COUNTY_MONTHLY_HIGHS_F }   from '../../data/county_monthly_highs.js';
import { COUNTY_MONTHLY_LOWS_F }    from '../../data/county_monthly_lows.js';
import { COUNTY_MONTHLY_PRECIP_IN } from '../../data/county_monthly_precip.js';
import { COUNTY_ELEVATIONS_FT }     from '../../data/county_elevations.js';
import { COUNTY_MEDIAN_INCOME }     from '../../data/county_median_income.js';
import { COUNTY_ANNUAL_PDSI, COUNTY_ANNUAL_PDSI_YEARS } from '../../data/county_annual_pdsi.js';
import { COUNTY_POPULATION, COUNTY_POPULATION_YEARS }   from '../../data/county_population.js';
import { COUNTY_ELECTIONS, COUNTY_ELECTION_YEARS }      from '../../data/county_elections.js';
import { CITIES }                   from '../../data/cities.js';
import { CBSA_GEOJSON }             from '../../data/cbsa_geometry.js';
import { CBSA_INCOME }              from '../../data/cbsa_income.js';
import { CBSA_HOME_VALUE }          from '../../data/cbsa_home_value.js';
import { HUC8_GEOJSON }             from '../../data/huc8_geometry.js';
import { MIGRATION_FLOWS }          from '../../data/migration_flows.js';
import { ZCTA_GEOJSON }             from '../../data/zcta_geometry.js';
import { ZCTA_INCOME }              from '../../data/zcta_income.js';
import { ZCTA_INCOME_PER_CAPITA }   from '../../data/zcta_income_per_capita.js';
import { ZCTA_POPULATION }          from '../../data/zcta_population.js';

const SANDBOX_OWNER = 'wes.yoakum@c-lars.com';

// Map slug → payload builder. Returning a function (not the value
// directly) lets the worker assemble the JSON only for the requested
// slug; unused entries don't get serialized.
const REGISTRY = {
  'statehood':       () => STATEHOOD_BY_NAME,
  'counties':        () => COUNTY_FOUNDING_BY_FIPS,
  'temperature':     () => COUNTY_MONTHLY_TEMPS_F,
  'highs':           () => COUNTY_MONTHLY_HIGHS_F,
  'lows':            () => COUNTY_MONTHLY_LOWS_F,
  'precip':          () => COUNTY_MONTHLY_PRECIP_IN,
  'elevation':       () => COUNTY_ELEVATIONS_FT,
  'income':          () => COUNTY_MEDIAN_INCOME,
  'pdsi':            () => ({ data: COUNTY_ANNUAL_PDSI, years: COUNTY_ANNUAL_PDSI_YEARS }),
  'population':      () => ({ data: COUNTY_POPULATION, years: COUNTY_POPULATION_YEARS }),
  'elections':       () => ({ data: COUNTY_ELECTIONS, years: COUNTY_ELECTION_YEARS }),
  'cities':          () => CITIES,
  'cbsa-geometry':   () => CBSA_GEOJSON,
  'cbsa-income':     () => CBSA_INCOME,
  'cbsa-home-value': () => CBSA_HOME_VALUE,
  'huc8':            () => HUC8_GEOJSON,
  'migration':       () => MIGRATION_FLOWS,
  'zcta-geometry':   () => ZCTA_GEOJSON,
  'zcta-income':            () => ZCTA_INCOME,
  'zcta-income-per-capita': () => ZCTA_INCOME_PER_CAPITA,
  'zcta-population':        () => ZCTA_POPULATION,
};

export async function onRequestGet(context) {
  const user = context.data?.user;
  if (!user || user.email !== SANDBOX_OWNER) {
    return new Response('Not found', { status: 404 });
  }
  const slug = context.params?.layer;
  const builder = REGISTRY[slug];
  if (!builder) {
    return new Response(JSON.stringify({ error: 'unknown layer slug', slug }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }
  return new Response(JSON.stringify(builder()), {
    headers: {
      'content-type': 'application/json',
      // 5-minute private browser cache — re-running the build script
      // (counties data changes etc.) propagates within a few minutes.
      'cache-control': 'private, max-age=300',
    },
  });
}
