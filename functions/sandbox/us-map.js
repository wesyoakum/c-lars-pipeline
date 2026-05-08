// functions/sandbox/us-map.js
//
// GET /sandbox/us-map — interactive US map platform with selectable
// data layers. Today's layers: "statehood" (50 states by admission
// year) and "counties" (~3,142 counties by founding year). Each layer
// has its own year domain, slider, color scale, and tooltip.
//
// To add another layer (population by year, presidential votes, etc.):
// add an entry to the LAYERS object at the top of mapScript() with the
// matching TopoJSON URL, key extractor, and data lookup.
//
// Pure client-side: D3 + topojson loaded from CDN. The two data sets
// are baked into the HTML response — no extra round trips.
//
// Wes-only — same email gate as the rest of /sandbox/*.

import { layout, html, htmlResponse, raw, subnavTabs } from '../lib/layout.js';
import { STATEHOOD_BY_NAME } from './data/statehood_dates.js';
import { COUNTY_FOUNDING_BY_FIPS } from './data/county_founding_dates.js';
import { COUNTY_MONTHLY_TEMPS_F }   from './data/county_monthly_temps.js';
import { COUNTY_MONTHLY_HIGHS_F }   from './data/county_monthly_highs.js';
import { COUNTY_MONTHLY_LOWS_F }    from './data/county_monthly_lows.js';
import { COUNTY_MONTHLY_PRECIP_IN } from './data/county_monthly_precip.js';
import { COUNTY_ELEVATIONS_FT }     from './data/county_elevations.js';
import { COUNTY_MEDIAN_INCOME }     from './data/county_median_income.js';
import { COUNTY_ANNUAL_PDSI, COUNTY_ANNUAL_PDSI_YEARS } from './data/county_annual_pdsi.js';
import { COUNTY_POPULATION, COUNTY_POPULATION_YEARS }   from './data/county_population.js';
import { COUNTY_ELECTIONS, COUNTY_ELECTION_YEARS }      from './data/county_elections.js';
import { CITIES }                   from './data/cities.js';
import { CBSA_GEOJSON }             from './data/cbsa_geometry.js';
import { CBSA_INCOME }              from './data/cbsa_income.js';
import { CBSA_HOME_VALUE }          from './data/cbsa_home_value.js';

const SANDBOX_OWNER = 'wes.yoakum@c-lars.com';

// 2-digit FIPS state prefix → state name. Used by the counties layer
// to label tooltips since the counties TopoJSON only carries the bare
// county name on each feature.
const STATE_NAME_BY_FIPS = {
  '01': 'Alabama',        '02': 'Alaska',         '04': 'Arizona',
  '05': 'Arkansas',       '06': 'California',     '08': 'Colorado',
  '09': 'Connecticut',    '10': 'Delaware',       '11': 'District of Columbia',
  '12': 'Florida',        '13': 'Georgia',        '15': 'Hawaii',
  '16': 'Idaho',          '17': 'Illinois',       '18': 'Indiana',
  '19': 'Iowa',           '20': 'Kansas',         '21': 'Kentucky',
  '22': 'Louisiana',      '23': 'Maine',          '24': 'Maryland',
  '25': 'Massachusetts',  '26': 'Michigan',       '27': 'Minnesota',
  '28': 'Mississippi',    '29': 'Missouri',       '30': 'Montana',
  '31': 'Nebraska',       '32': 'Nevada',         '33': 'New Hampshire',
  '34': 'New Jersey',     '35': 'New Mexico',     '36': 'New York',
  '37': 'North Carolina', '38': 'North Dakota',   '39': 'Ohio',
  '40': 'Oklahoma',       '41': 'Oregon',         '42': 'Pennsylvania',
  '44': 'Rhode Island',   '45': 'South Carolina', '46': 'South Dakota',
  '47': 'Tennessee',      '48': 'Texas',          '49': 'Utah',
  '50': 'Vermont',        '51': 'Virginia',       '53': 'Washington',
  '54': 'West Virginia',  '55': 'Wisconsin',      '56': 'Wyoming',
};

export async function onRequestGet(context) {
  const user = context.data?.user;
  if (!user || user.email !== SANDBOX_OWNER) {
    return new Response('Not found', { status: 404 });
  }

  const tabs = subnavTabs(
    [
      { href: '/sandbox/assistant',  label: 'Claudia' },
      { href: '/sandbox/us-map',     label: 'US Map' },
      { href: '/sandbox/flow-chart', label: 'Flow Chart' },
    ],
    '/sandbox/us-map'
  );

  // Read ?layer= so a query param can pre-select the layer (used by
  // the redirects from the old /sandbox/statehood and /sandbox/counties
  // routes). Defaults to statehood.
  const url = new URL(context.request.url);
  const layerParam = url.searchParams.get('layer');
  const VALID_LAYERS = [
    'counties', 'temperature', 'high', 'low', 'precipitation',
    'elevation', 'income', 'drought', 'population', 'elections', 'cities',
    'msaIncome', 'msaHomeValue',
  ];
  const initialLayer = VALID_LAYERS.includes(layerParam) ? layerParam : 'statehood';

  const body = html`
    <style>
      /* Break out of the global .site-main width cap so the map can
         use the full viewport width — the platform is supposed to
         feel like a full canvas, not a sidebar widget. */
      main.site-main {
        max-width: none !important;
        padding-left: 0 !important;
        padding-right: 0 !important;
      }
      nav.subnav-tabs {
        padding-left: 16px;
        padding-right: 16px;
      }

      .usmap-page {
        /* .site-main is a flex column. Explicit width:100% so the page
           stretches to the full content area instead of collapsing. */
        width: 100%;
        max-width: 1500px;
        margin: 0 auto;
        padding: 16px;
        box-sizing: border-box;
      }
      .usmap-page h1 { font-size: 26px; font-weight: 600; margin-bottom: 4px; }
      .usmap-page .subtitle { color: #666; margin-bottom: 16px; font-size: 13px; }

      /* Layer picker — radio-styled buttons. Add another button
         when wiring a new layer in mapScript(). */
      .usmap-layer-row {
        display: flex; gap: 6px; margin-bottom: 16px;
        align-items: center; flex-wrap: wrap;
      }
      .usmap-layer-row .label {
        font-size: 12px; color: #666; text-transform: uppercase;
        letter-spacing: 0.04em; margin-right: 6px;
      }
      .usmap-layer-btn {
        padding: 7px 16px;
        border: 1px solid #ccc;
        background: #fafaf6;
        border-radius: 4px;
        font-size: 13px;
        cursor: pointer;
        transition: all 0.15s;
      }
      .usmap-layer-btn:hover { background: #ebebe2; border-color: #999; }
      .usmap-layer-btn.active {
        background: #1a3a5c; color: #fff; border-color: #1a3a5c;
      }

      .usmap-card {
        background: #fff;
        padding: 16px;
        border-radius: 8px;
        border: 1px solid #e0e0d8;
      }
      .usmap-card svg { width: 100%; height: auto; display: block; }

      .usmap-feature {
        stroke: #fff;
        transition: fill 0.4s ease;
        cursor: pointer;
      }
      .usmap-feature.statehood { stroke-width: 0.75; }
      .usmap-feature.counties  { stroke-width: 0.25; }
      .usmap-feature.msa       { stroke-width: 0.4; }
      .usmap-feature.not-yet { fill: #e8e8e0; }
      .usmap-feature:hover { stroke: #222; stroke-width: 1.5; }

      /* State outlines drawn over the county fill so individual states
         stay readable inside the mosaic. Only added for the counties
         layer. */
      .usmap-state-overlay {
        fill: none;
        stroke: #333;
        stroke-width: 0.6;
        stroke-linejoin: round;
        pointer-events: none;
      }

      .usmap-legend {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-top: 12px;
        font-size: 12px;
        color: #555;
      }
      .usmap-legend-bar {
        flex: 1;
        height: 12px;
        background: linear-gradient(to right, #d4e4f0, #5a8db0, #1a3a5c);
        border-radius: 2px;
      }
      /* When the active layer paints features by an absolute value
         (e.g. temperature), the legend bar swaps to the matching
         spectrum. Stop positions mirror the JS color-scale domain
         spread across 0–120°F so the bar reads the same as the map. */
      .usmap-legend-bar.diverging-temp {
        background: linear-gradient(to right,
          #2e0854   0%,    /* 0°F and below — dark purple */
          #663399   8.33%, /* 10°F — purple */
          #c8a2c8  16.67%, /* 20°F — light purple */
          #ffffff  25%,    /* 30°F — white */
          #b8dff0  33.33%, /* 40°F — pastel light blue */
          #7eb5d8  41.67%, /* 50°F — pastel blue */
          #91c98f  50%,    /* 60°F — pastel green */
          #ffff00  58.33%, /* 70°F — yellow */
          #ffa500  66.67%, /* 80°F — orange */
          #ff0000  75%,    /* 90°F — red */
          #8b0000  83.33%, /* 100°F — dark red */
          #000000 100%);   /* 120°F+ — black */
      }
      .usmap-legend-bar.precipitation {
        background: linear-gradient(to right,
          #fafaf6   0%,   /* 0"     — off-white, dry */
          #ffeeb8   5%,   /* 1"     — pale yellow */
          #c5e08f  10%,   /* 2"     — pale green */
          #66c060  20%,   /* 4"     — green */
          #2eb3b3  30%,   /* 6"     — teal */
          #2d80c4  45%,   /* 9"     — medium blue */
          #2050a0  60%,   /* 12"    — dark blue */
          #2c1f6d  80%,   /* 16"    — deep blue */
          #4b1d80 100%);  /* 20"+   — purple */
      }
      .usmap-legend-bar.elevation {
        background: linear-gradient(to right,
          #1b5e20   0%,   /* sea level — deep forest green */
          #66bb6a  10%,   /* 500 ft */
          #c5e1a5  25%,   /* 1500 ft */
          #fff8a1  40%,   /* 3000 ft — pale yellow / plains */
          #d4a373  55%,   /* 4500 ft — tan */
          #8b5a2b  70%,   /* 6500 ft — brown */
          #b8b8b8  85%,   /* 9000 ft — gray (above treeline) */
          #ffffff 100%);  /* 12000+ ft — snow white */
      }
      .usmap-legend-bar.income {
        background: linear-gradient(to right,
          #f7fcf5   0%,   /* very low */
          #c7e9c0  20%,
          #74c476  45%,
          #2e7d32  70%,
          #1b3a14 100%);  /* highest */
      }
      .usmap-legend-bar.home-value {
        /* sequential warm: cream → orange → deep red for housing prices */
        background: linear-gradient(to right,
          #fff5e1   0%,
          #ffd28a  20%,
          #f49a4c  45%,
          #c2491c  70%,
          #7a1a0e 100%);
      }
      .usmap-legend-bar.pdsi {
        /* drought (brown) → normal (white) → wet (green/blue) */
        background: linear-gradient(to right,
          #5e2c00   0%,   /* extreme drought */
          #b85e1e  20%,
          #f4d3a1  40%,
          #ffffff  50%,   /* normal */
          #b3e0a1  60%,
          #4caf50  80%,
          #1b5e20 100%);  /* extreme wet */
      }
      .usmap-legend-bar.elections {
        /* GOP (red) → tied (white) → Dem (blue) */
        background: linear-gradient(to right,
          #1b3c8a   0%,   /* D +30 */
          #5b8ce8  25%,
          #ffffff  50%,
          #e85b6b  75%,
          #8a1b2e 100%);  /* R +30 */
      }
      .usmap-legend-bar.population {
        /* log-scale: small county (light) → large city county (dark) */
        background: linear-gradient(to right,
          #f7fcf5   0%,
          #d2efd0  20%,
          #91c98f  40%,
          #3a8f54  60%,
          #1c3d6f  80%,
          #1a1a4a 100%);
      }
      .usmap-legend-key {
        margin-left: 16px;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .usmap-legend-key span {
        width: 14px; height: 12px;
        background: #e8e8e0;
        display: inline-block;
        border-radius: 2px;
      }

      .usmap-controls {
        background: #fff;
        padding: 18px 22px;
        border-radius: 8px;
        border: 1px solid #e0e0d8;
        margin-top: 16px;
      }
      .usmap-year-display {
        font-size: 38px;
        font-weight: 700;
        color: #1a3a5c;
        margin-bottom: 4px;
        font-variant-numeric: tabular-nums;
        line-height: 1.1;
      }
      .usmap-count-display {
        font-size: 13px;
        color: #666;
        margin-bottom: 14px;
      }
      .usmap-count-display strong { color: #1a3a5c; }

      .usmap-slider-row { display: flex; align-items: center; gap: 12px; }
      .usmap-slider-row.hidden { display: none; }
      .usmap-slider-row + .usmap-slider-row-2 { margin-top: 8px; }
      .usmap-slider-row input[type=range] { flex: 1; height: 6px; }
      .usmap-slider-bounds { font-size: 12px; color: #888; min-width: 44px; }
      .usmap-slider-bounds.right { text-align: right; }
      .usmap-slider-label {
        font-size: 12px; color: #555; font-weight: 600;
        min-width: 44px;
      }

      .usmap-button-row { margin-top: 12px; display: flex; gap: 8px; flex-wrap: wrap; }
      .usmap-button-row button {
        padding: 6px 14px;
        border: 1px solid #ccc;
        background: #fafaf6;
        border-radius: 4px;
        font-size: 13px;
        cursor: pointer;
        transition: all 0.15s;
      }
      .usmap-button-row button:hover { background: #ebebe2; border-color: #999; }
      .usmap-button-row button.playing {
        background: #1a3a5c; color: #fff; border-color: #1a3a5c;
      }

      .usmap-tooltip {
        position: absolute;
        background: #222;
        color: #fff;
        padding: 6px 10px;
        border-radius: 4px;
        font-size: 13px;
        pointer-events: none;
        opacity: 0;
        transition: opacity 0.15s;
        white-space: nowrap;
        z-index: 100;
      }
      .usmap-tooltip strong { display: block; font-size: 14px; }
      .usmap-tooltip .y { color: #9ec5e8; }

      /* Hide the slider/play row when the active layer has no time
         dimension (e.g. elevation, income). The year-display still
         shows a stat (e.g. average), and the count text shows context. */
      .usmap-controls.no-slider .usmap-slider-row,
      .usmap-controls.no-slider .usmap-button-row { display: none; }

      /* Cities layer — point symbols on top of a quiet country backdrop. */
      .usmap-country-fill {
        fill: #f5f5f0;
        stroke: #999;
        stroke-width: 0.5;
        pointer-events: none;
      }
      .usmap-state-mesh-faint {
        fill: none;
        stroke: #c8c8c0;
        stroke-width: 0.5;
        pointer-events: none;
      }
      .usmap-city {
        fill: #1a3a5c;
        fill-opacity: 0.7;
        stroke: #fff;
        stroke-width: 0.4;
        cursor: pointer;
        transition: fill-opacity 0.15s;
      }
      .usmap-city:hover { fill-opacity: 1; stroke: #222; stroke-width: 1; }
    </style>
    ${tabs}
    <div class="usmap-page">
      <h1 id="usmap-title">U.S. Map</h1>
      <p class="subtitle" id="usmap-subtitle">Pick a layer below.</p>

      <div class="usmap-layer-row" role="tablist" aria-label="Map layer">
        <span class="label">Layer</span>
        <button class="usmap-layer-btn" data-layer="statehood"     type="button">Statehood</button>
        <button class="usmap-layer-btn" data-layer="counties"      type="button">Counties</button>
        <button class="usmap-layer-btn" data-layer="temperature"   type="button">Avg Temp</button>
        <button class="usmap-layer-btn" data-layer="high"          type="button">Daily High</button>
        <button class="usmap-layer-btn" data-layer="low"           type="button">Daily Low</button>
        <button class="usmap-layer-btn" data-layer="precipitation" type="button">Rainfall</button>
        <button class="usmap-layer-btn" data-layer="elevation"     type="button">Elevation</button>
        <button class="usmap-layer-btn" data-layer="income"        type="button">Income</button>
        <button class="usmap-layer-btn" data-layer="drought"       type="button">Drought</button>
        <button class="usmap-layer-btn" data-layer="population"    type="button">Population</button>
        <button class="usmap-layer-btn" data-layer="elections"     type="button">Elections</button>
        <button class="usmap-layer-btn" data-layer="cities"        type="button">Cities</button>
        <button class="usmap-layer-btn" data-layer="msaIncome"     type="button">MSA Income</button>
        <button class="usmap-layer-btn" data-layer="msaHomeValue"  type="button">MSA Home Value</button>
      </div>

      <div class="usmap-card">
        <svg id="usmap-svg" viewBox="0 0 960 600"></svg>
        <div class="usmap-legend">
          <span id="usmap-legend-min">—</span>
          <div class="usmap-legend-bar"></div>
          <span id="usmap-legend-max">—</span>
          <span class="usmap-legend-key">
            <span></span>
            <span id="usmap-legend-not-yet">Not yet</span>
          </span>
        </div>
      </div>

      <div class="usmap-controls">
        <div class="usmap-year-display" id="usmap-year">—</div>
        <div class="usmap-count-display"><strong id="usmap-count">0</strong> <span id="usmap-count-label">—</span></div>
        <div class="usmap-slider-row" id="usmap-slider-row">
          <span class="usmap-slider-label" id="usmap-slider-prefix"></span>
          <span class="usmap-slider-bounds" id="usmap-slider-min">—</span>
          <input type="range" id="usmap-slider" min="0" max="1" value="0" step="1">
          <span class="usmap-slider-bounds right" id="usmap-slider-max">—</span>
        </div>
        <!-- Second slider only shown for the cities layer (population
             window's upper bound). -->
        <div class="usmap-slider-row usmap-slider-row-2 hidden" id="usmap-slider2-row">
          <span class="usmap-slider-label">Max ≤</span>
          <span class="usmap-slider-bounds" id="usmap-slider2-min">—</span>
          <input type="range" id="usmap-slider2" min="0" max="1" value="1" step="1">
          <span class="usmap-slider-bounds right" id="usmap-slider2-max">—</span>
        </div>
        <div class="usmap-button-row">
          <button id="usmap-play">▶ Play</button>
          <button id="usmap-reset">Reset</button>
          <span id="usmap-year-buttons"></span>
        </div>
      </div>
    </div>

    <div class="usmap-tooltip" id="usmap-tooltip"></div>

    <script src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.8.5/d3.min.js"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/topojson/3.0.2/topojson.min.js"></script>
    <script>${raw(mapScript({
      statehood: STATEHOOD_BY_NAME,
      counties: COUNTY_FOUNDING_BY_FIPS,
      temperature: COUNTY_MONTHLY_TEMPS_F,
      highs: COUNTY_MONTHLY_HIGHS_F,
      lows: COUNTY_MONTHLY_LOWS_F,
      precip: COUNTY_MONTHLY_PRECIP_IN,
      elevation: COUNTY_ELEVATIONS_FT,
      income: COUNTY_MEDIAN_INCOME,
      pdsi: COUNTY_ANNUAL_PDSI,
      pdsiYears: COUNTY_ANNUAL_PDSI_YEARS,
      population: COUNTY_POPULATION,
      populationYears: COUNTY_POPULATION_YEARS,
      elections: COUNTY_ELECTIONS,
      electionYears: COUNTY_ELECTION_YEARS,
      cities: CITIES,
      cbsaGeojson: CBSA_GEOJSON,
      cbsaIncome: CBSA_INCOME,
      cbsaHomeValue: CBSA_HOME_VALUE,
      stateNames: STATE_NAME_BY_FIPS,
      initialLayer,
    }))}</script>
  `;

  return htmlResponse(layout('US Map', body, { user, activeNav: '/sandbox' }));
}

// Inline page script. D3 + topojson are loaded from CDN immediately
// above. Returned as a plain string (injected via raw()) so the JS
// can use ${...} in template literals without colliding with the
// outer html`...` template literal.
function mapScript({
  statehood, counties, temperature, highs, lows, precip,
  elevation, income, pdsi, pdsiYears, population, populationYears,
  elections, electionYears, cities,
  cbsaGeojson, cbsaIncome, cbsaHomeValue,
  stateNames, initialLayer,
}) {
  return `
(function() {
  var STATEHOOD = ${JSON.stringify(statehood)};
  var COUNTIES  = ${JSON.stringify(counties)};
  var TEMPS     = ${JSON.stringify(temperature)};
  var HIGHS     = ${JSON.stringify(highs)};
  var LOWS      = ${JSON.stringify(lows)};
  var PRECIP    = ${JSON.stringify(precip)};
  var ELEVATION = ${JSON.stringify(elevation)};
  var INCOME    = ${JSON.stringify(income)};
  var PDSI = ${JSON.stringify(pdsi)};
  var PDSI_YEARS = ${JSON.stringify(pdsiYears)};
  var POPULATION = ${JSON.stringify(population)};
  var POPULATION_YEARS = ${JSON.stringify(populationYears)};
  var ELECTIONS = ${JSON.stringify(elections)};
  var ELECTION_YEARS = ${JSON.stringify(electionYears)};
  var CITIES = ${JSON.stringify(cities)};
  var CBSA_GEOJSON = ${JSON.stringify(cbsaGeojson)};
  var CBSA_INCOME = ${JSON.stringify(cbsaIncome)};
  var CBSA_HOME_VALUE = ${JSON.stringify(cbsaHomeValue)};
  var STATE_NAMES = ${JSON.stringify(stateNames)};
  var INITIAL_LAYER = ${JSON.stringify(initialLayer)};

  // Helper: county name + state for tooltip on county-keyed layers.
  function countyTitle(d) {
    var fips = String(d.id).padStart(5, '0');
    var name = (d.properties && d.properties.name) || 'County';
    var state = STATE_NAMES[fips.slice(0, 2)] || '';
    return state ? (name + ', ' + state) : name;
  }

  // Day-of-year quick-jump positions for instant-day layers (mid-month
  // anchors so each button lands on the central day of its month).
  var MONTH_QUICK_JUMPS = [
    { value: 15,  label: 'Jan' },
    { value: 46,  label: 'Feb' },
    { value: 75,  label: 'Mar' },
    { value: 105, label: 'Apr' },
    { value: 135, label: 'May' },
    { value: 166, label: 'Jun' },
    { value: 196, label: 'Jul' },
    { value: 227, label: 'Aug' },
    { value: 258, label: 'Sep' },
    { value: 288, label: 'Oct' },
    { value: 319, label: 'Nov' },
    { value: 349, label: 'Dec' },
  ];

  // Layer config — the platform's plug-in surface. Each entry has a
  // 'type' that picks which render strategy to use:
  //   'monotonic'   — feature gets a value Y; filled if Y <= slider.
  //   'instant-day' — slider is day-of-year (1..366); each feature has
  //                   12 monthly values that get interpolated to a
  //                   daily value, then colored on a diverging scale.
  var LAYERS = {
    statehood: {
      type: 'monotonic',
      title: 'U.S. Statehood by Year',
      subtitle: 'Drag the slider or press play to watch states join the union from 1787 to 1959.',
      topojsonUrl: 'https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json',
      objectName: 'states',
      featureClass: 'statehood',
      keyOf: function(d) { return d.properties.name; },
      data: STATEHOOD,
      tooltipTitle: function(d) { return d.properties.name; },
      tooltipVerb: 'Joined',
      countLabel: 'states have joined the union',
      countTotalOverride: 50,
      sliderMin: 1787, sliderMax: 1959, sliderStep: 1,
      sliderInitial: 1787,
      quickJumps: [1787, 1820, 1865, 1900, 1959].map(function(y) {
        return { value: y, label: String(y) };
      }),
      legendMinLabel: '1787',
      legendMaxLabel: '1959',
      legendNotYet: 'Not yet a state',
      legendBarClass: '',
      playMs: 120,
      drawStateOverlay: false,
      colorInterpolatorRgb: ['#d4e4f0', '#1a3a5c'],
    },
    counties: {
      type: 'monotonic',
      title: 'U.S. Counties by Founding Year',
      subtitle: 'Drag the slider or press play to watch counties get carved out from 1607 to 2013.',
      topojsonUrl: 'https://cdn.jsdelivr.net/npm/us-atlas@3/counties-10m.json',
      objectName: 'counties',
      featureClass: 'counties',
      keyOf: function(d) { return String(d.id).padStart(5, '0'); },
      data: COUNTIES,
      tooltipTitle: countyTitle,
      tooltipVerb: 'Founded',
      countLabel: 'counties have been founded',
      countTotalOverride: null,  // set at runtime to # of rendered features
      sliderMin: 1607, sliderMax: 2013, sliderStep: 1,
      sliderInitial: 1607,
      quickJumps: [1607, 1700, 1800, 1850, 1900, 2013].map(function(y) {
        return { value: y, label: String(y) };
      }),
      legendMinLabel: '1607',
      legendMaxLabel: '2013',
      legendNotYet: 'Not yet founded',
      legendBarClass: '',
      playMs: 80,
      drawStateOverlay: true,
      colorInterpolatorRgb: ['#d4e4f0', '#1a3a5c'],
    },
    temperature: {
      type: 'instant-day',
      title: 'U.S. Average Temperature by Day',
      subtitle: '1991-2020 climate normals (NOAA climdiv-tmpccy). Daily values are interpolated from monthly means.',
      topojsonUrl: 'https://cdn.jsdelivr.net/npm/us-atlas@3/counties-10m.json',
      objectName: 'counties',
      featureClass: 'counties',
      keyOf: function(d) { return String(d.id).padStart(5, '0'); },
      data: TEMPS,
      tooltipTitle: countyTitle,
      tooltipFormat: function(v, dateLabel) { return v.toFixed(1) + '°F on ' + dateLabel; },
      countFormat: function(avg, n) {
        return { value: avg.toFixed(1) + '°F', label: 'national average across ' + n.toLocaleString() + ' counties' };
      },
      drawStateOverlay: true,
      sliderMin: 1, sliderMax: 366, sliderStep: 1,
      sliderInitial: 196,
      quickJumps: MONTH_QUICK_JUMPS,
      legendMinLabel: '0°F',
      legendMaxLabel: '120°F',
      legendNotYet: 'No data',
      legendBarClass: 'diverging-temp',
      playMs: 30,
      colorScale: {
        domain: [0,        10,       20,       30,       40,       50,       60,       70,       80,       90,       100,      120     ],
        range:  ['#2e0854','#663399','#c8a2c8','#ffffff','#b8dff0','#7eb5d8','#91c98f','#ffff00','#ffa500','#ff0000','#8b0000','#000000'],
      },
    },
    high: {
      type: 'instant-day',
      title: 'U.S. Daily High Temperature',
      subtitle: '1991-2020 climate normals (NOAA climdiv-tmaxcy) — average daily maximum.',
      topojsonUrl: 'https://cdn.jsdelivr.net/npm/us-atlas@3/counties-10m.json',
      objectName: 'counties',
      featureClass: 'counties',
      keyOf: function(d) { return String(d.id).padStart(5, '0'); },
      data: HIGHS,
      tooltipTitle: countyTitle,
      tooltipFormat: function(v, dateLabel) { return 'high ' + v.toFixed(1) + '°F on ' + dateLabel; },
      countFormat: function(avg, n) {
        return { value: avg.toFixed(1) + '°F', label: 'national avg daily high across ' + n.toLocaleString() + ' counties' };
      },
      drawStateOverlay: true,
      sliderMin: 1, sliderMax: 366, sliderStep: 1,
      sliderInitial: 196,
      quickJumps: MONTH_QUICK_JUMPS,
      legendMinLabel: '0°F',
      legendMaxLabel: '120°F',
      legendNotYet: 'No data',
      legendBarClass: 'diverging-temp',
      playMs: 30,
      colorScale: {
        domain: [0,        10,       20,       30,       40,       50,       60,       70,       80,       90,       100,      120     ],
        range:  ['#2e0854','#663399','#c8a2c8','#ffffff','#b8dff0','#7eb5d8','#91c98f','#ffff00','#ffa500','#ff0000','#8b0000','#000000'],
      },
    },
    low: {
      type: 'instant-day',
      title: 'U.S. Daily Low Temperature',
      subtitle: '1991-2020 climate normals (NOAA climdiv-tmincy) — average daily minimum.',
      topojsonUrl: 'https://cdn.jsdelivr.net/npm/us-atlas@3/counties-10m.json',
      objectName: 'counties',
      featureClass: 'counties',
      keyOf: function(d) { return String(d.id).padStart(5, '0'); },
      data: LOWS,
      tooltipTitle: countyTitle,
      tooltipFormat: function(v, dateLabel) { return 'low ' + v.toFixed(1) + '°F on ' + dateLabel; },
      countFormat: function(avg, n) {
        return { value: avg.toFixed(1) + '°F', label: 'national avg daily low across ' + n.toLocaleString() + ' counties' };
      },
      drawStateOverlay: true,
      sliderMin: 1, sliderMax: 366, sliderStep: 1,
      sliderInitial: 15,  // Jan 15 on initial load — coldest band shows the layer's character
      quickJumps: MONTH_QUICK_JUMPS,
      legendMinLabel: '0°F',
      legendMaxLabel: '120°F',
      legendNotYet: 'No data',
      legendBarClass: 'diverging-temp',
      playMs: 30,
      colorScale: {
        domain: [0,        10,       20,       30,       40,       50,       60,       70,       80,       90,       100,      120     ],
        range:  ['#2e0854','#663399','#c8a2c8','#ffffff','#b8dff0','#7eb5d8','#91c98f','#ffff00','#ffa500','#ff0000','#8b0000','#000000'],
      },
    },
    precipitation: {
      type: 'instant-day',
      title: 'U.S. Average Rainfall',
      subtitle: '1991-2020 climate normals (NOAA climdiv-pcpncy). Smoothly interpolated monthly totals (inches).',
      topojsonUrl: 'https://cdn.jsdelivr.net/npm/us-atlas@3/counties-10m.json',
      objectName: 'counties',
      featureClass: 'counties',
      keyOf: function(d) { return String(d.id).padStart(5, '0'); },
      data: PRECIP,
      tooltipTitle: countyTitle,
      tooltipFormat: function(v, dateLabel) { return v.toFixed(2) + '" near ' + dateLabel; },
      countFormat: function(avg, n) {
        return { value: avg.toFixed(2) + '"', label: 'national avg inches/month across ' + n.toLocaleString() + ' counties' };
      },
      drawStateOverlay: true,
      sliderMin: 1, sliderMax: 366, sliderStep: 1,
      sliderInitial: 105,  // Apr 15 — typical wet spring
      quickJumps: MONTH_QUICK_JUMPS,
      legendMinLabel: '0"',
      legendMaxLabel: '20"+',
      legendNotYet: 'No data',
      legendBarClass: 'precipitation',
      playMs: 30,
      // White-to-purple precipitation gradient anchored at typical
      // monthly rainfall thresholds. Anything ≥ 20" of monthly rain
      // clamps to deep purple — already saturating in places like the
      // PNW and parts of Hawaii.
      colorScale: {
        domain: [0,        1,        2,        4,        6,        9,        12,       16,       20      ],
        range:  ['#fafaf6','#ffeeb8','#c5e08f','#66c060','#2eb3b3','#2d80c4','#2050a0','#2c1f6d','#4b1d80'],
      },
    },
    elevation: {
      type: 'static',
      title: 'U.S. County Elevation',
      subtitle: 'Approximate elevation at each county centroid. Source: USGS via Open-Meteo, county centroids from the 2024 Census Gazetteer.',
      topojsonUrl: 'https://cdn.jsdelivr.net/npm/us-atlas@3/counties-10m.json',
      objectName: 'counties',
      featureClass: 'counties',
      keyOf: function(d) { return String(d.id).padStart(5, '0'); },
      data: ELEVATION,
      tooltipTitle: countyTitle,
      tooltipFormat: function(v) { return v.toLocaleString() + ' ft'; },
      countFormat: function(v) { return { value: v, label: '' }; },
      summaryFormat: function(stats) {
        return { value: Math.round(stats.mean).toLocaleString() + ' ft', label: 'national mean — range ' + stats.min.toLocaleString() + ' to ' + stats.max.toLocaleString() + ' ft' };
      },
      drawStateOverlay: true,
      legendMinLabel: '0 ft',
      legendMaxLabel: '12,000+ ft',
      legendNotYet: 'No data',
      legendBarClass: 'elevation',
      colorScale: {
        domain: [0,        500,      1500,     3000,     4500,     6500,     9000,     12000   ],
        range:  ['#1b5e20','#66bb6a','#c5e1a5','#fff8a1','#d4a373','#8b5a2b','#b8b8b8','#ffffff'],
      },
    },
    income: {
      type: 'static',
      title: 'U.S. Median Household Income',
      subtitle: 'ACS 2018-2022 5-year estimate (table B19013). Inflation-adjusted dollars.',
      topojsonUrl: 'https://cdn.jsdelivr.net/npm/us-atlas@3/counties-10m.json',
      objectName: 'counties',
      featureClass: 'counties',
      keyOf: function(d) { return String(d.id).padStart(5, '0'); },
      data: INCOME,
      tooltipTitle: countyTitle,
      tooltipFormat: function(v) { return '$' + v.toLocaleString(); },
      summaryFormat: function(stats) {
        return { value: '$' + Math.round(stats.mean).toLocaleString(), label: 'national mean — range $' + stats.min.toLocaleString() + ' to $' + stats.max.toLocaleString() };
      },
      drawStateOverlay: true,
      legendMinLabel: '$25k',
      legendMaxLabel: '$160k+',
      legendNotYet: 'No data',
      legendBarClass: 'income',
      colorScale: {
        domain: [25000,    50000,    75000,    100000,   160000  ],
        range:  ['#f7fcf5','#c7e9c0','#74c476','#2e7d32','#1b3a14'],
      },
    },
    drought: {
      type: 'time-series',
      title: 'U.S. Annual Mean Drought Index (PDSI)',
      subtitle: 'Annual-mean Palmer Drought Severity Index per county, 1900-' + (PDSI_YEARS[PDSI_YEARS.length-1]) + '. Source: NOAA climdiv-pdsicy.',
      topojsonUrl: 'https://cdn.jsdelivr.net/npm/us-atlas@3/counties-10m.json',
      objectName: 'counties',
      featureClass: 'counties',
      keyOf: function(d) { return String(d.id).padStart(5, '0'); },
      data: PDSI,
      years: PDSI_YEARS,
      tooltipTitle: countyTitle,
      tooltipFormat: function(v, label) { return (v >= 0 ? '+' : '') + v.toFixed(1) + ' PDSI in ' + label; },
      countFormat: function(avg, n) {
        return { value: (avg >= 0 ? '+' : '') + avg.toFixed(2), label: 'national mean PDSI across ' + n.toLocaleString() + ' counties' };
      },
      drawStateOverlay: true,
      sliderMin: PDSI_YEARS[0], sliderMax: PDSI_YEARS[PDSI_YEARS.length-1], sliderStep: 1,
      sliderInitial: 1934,  // Dust Bowl peak
      quickJumps: [1934, 1956, 1988, 2002, 2012, 2022].map(function(y) {
        return { value: y, label: String(y) };
      }),
      legendMinLabel: '−6 (dry)',
      legendMaxLabel: '+6 (wet)',
      legendNotYet: 'No data',
      legendBarClass: 'pdsi',
      playMs: 200,
      // Diverging brown→white→green
      colorScale: {
        domain: [-6,       -3,       -1,        1,        3,         6      ],
        range:  ['#5e2c00','#b85e1e','#f4d3a1','#b3e0a1','#4caf50','#1b5e20'],
      },
    },
    population: {
      type: 'time-series',
      title: 'U.S. County Population by Decade',
      subtitle: 'Decennial Census, 1900-2020. Source: Andrew Van Leuven, Harvard Dataverse (doi:10.7910/DVN/WLS5GF).',
      topojsonUrl: 'https://cdn.jsdelivr.net/npm/us-atlas@3/counties-10m.json',
      objectName: 'counties',
      featureClass: 'counties',
      keyOf: function(d) { return String(d.id).padStart(5, '0'); },
      data: POPULATION,
      years: POPULATION_YEARS,
      tooltipTitle: countyTitle,
      tooltipFormat: function(v, label) { return v.toLocaleString() + ' in ' + label; },
      countFormat: function(avg, n, sum) {
        return { value: (sum/1e6).toFixed(1) + ' M', label: 'total population across ' + n.toLocaleString() + ' counties (≥ 1 person)' };
      },
      drawStateOverlay: true,
      sliderMin: POPULATION_YEARS[0], sliderMax: POPULATION_YEARS[POPULATION_YEARS.length-1], sliderStep: 10,
      sliderInitial: 2020,
      quickJumps: POPULATION_YEARS.map(function(y) { return { value: y, label: String(y) }; }),
      legendMinLabel: '< 1k',
      legendMaxLabel: '5M+',
      legendNotYet: 'No data',
      legendBarClass: 'population',
      playMs: 800,
      // log10-scaled domain: 1 → 5,000,000 mapped to 0..6.7
      // Use a custom value transform in update() (log scale).
      colorScale: {
        // domain in log10 space; transform applied in update()
        domain: [0,        2,        3,        4,        5,        6,        6.7     ],
        range:  ['#f7fcf5','#d2efd0','#91c98f','#3a8f54','#1c3d6f','#1a1a4a','#0a0a2a'],
      },
      logScale: true,  // signal to update() to log10 the value before color
    },
    elections: {
      type: 'time-series',
      title: 'U.S. Presidential Elections by County',
      subtitle: 'Margin (R% − D%) per county, 2008-2024. Positive = Republican lean. Source: tonmcg/US_County_Level_Election_Results.',
      topojsonUrl: 'https://cdn.jsdelivr.net/npm/us-atlas@3/counties-10m.json',
      objectName: 'counties',
      featureClass: 'counties',
      keyOf: function(d) { return String(d.id).padStart(5, '0'); },
      data: ELECTIONS,
      years: ELECTION_YEARS,
      tooltipTitle: countyTitle,
      tooltipFormat: function(v, label) {
        var lean = v > 0 ? 'R+' : 'D+';
        return lean + Math.abs(v).toFixed(1) + ' in ' + label;
      },
      countFormat: function(avg, n) {
        var lean = avg > 0 ? 'R+' : 'D+';
        return { value: lean + Math.abs(avg).toFixed(1), label: 'avg margin across ' + n.toLocaleString() + ' counties (unweighted)' };
      },
      drawStateOverlay: true,
      sliderMin: ELECTION_YEARS[0], sliderMax: ELECTION_YEARS[ELECTION_YEARS.length-1], sliderStep: 4,
      sliderInitial: 2024,
      quickJumps: ELECTION_YEARS.map(function(y) { return { value: y, label: String(y) }; }),
      legendMinLabel: 'D+30',
      legendMaxLabel: 'R+30',
      legendNotYet: 'No data',
      legendBarClass: 'elections',
      playMs: 1500,
      colorScale: {
        domain: [-30,      -15,      -5,        5,       15,       30      ],
        range:  ['#1b3c8a','#5b8ce8','#cbd6f0','#f0c9d0','#e85b6b','#8a1b2e'],
      },
    },
    msaIncome: {
      type: 'static',
      title: 'Median Household Income by Metro Area',
      subtitle: 'CBSA-level (Metropolitan + Micropolitan Statistical Areas). ACS 2018-2022 5-year (B19013). Inflation-adjusted dollars.',
      geojson: CBSA_GEOJSON,  // inline GeoJSON instead of TopoJSON
      featureClass: 'msa',
      keyOf: function(d) { return d.properties.geoid; },
      data: CBSA_INCOME,
      tooltipTitle: function(d) { return d.properties.name; },
      tooltipFormat: function(v) { return '$' + v.toLocaleString(); },
      summaryFormat: function(stats) {
        return { value: '$' + Math.round(stats.mean).toLocaleString(), label: 'mean across ' + stats.n + ' metros — range $' + stats.min.toLocaleString() + ' to $' + stats.max.toLocaleString() };
      },
      drawStateOverlay: true,
      legendMinLabel: '$25k',
      legendMaxLabel: '$160k+',
      legendNotYet: 'No data',
      legendBarClass: 'income',
      colorScale: {
        domain: [25000,    50000,    75000,    100000,   160000  ],
        range:  ['#f7fcf5','#c7e9c0','#74c476','#2e7d32','#1b3a14'],
      },
    },
    msaHomeValue: {
      type: 'static',
      title: 'Median Home Value by Metro Area',
      subtitle: 'CBSA-level. ACS 2018-2022 5-year (B25077). Median value of owner-occupied homes.',
      geojson: CBSA_GEOJSON,
      featureClass: 'msa',
      keyOf: function(d) { return d.properties.geoid; },
      data: CBSA_HOME_VALUE,
      tooltipTitle: function(d) { return d.properties.name; },
      tooltipFormat: function(v) { return '$' + v.toLocaleString(); },
      summaryFormat: function(stats) {
        return { value: '$' + Math.round(stats.mean).toLocaleString(), label: 'mean across ' + stats.n + ' metros — range $' + stats.min.toLocaleString() + ' to $' + stats.max.toLocaleString() };
      },
      drawStateOverlay: true,
      legendMinLabel: '$50k',
      legendMaxLabel: '$1M+',
      legendNotYet: 'No data',
      legendBarClass: 'home-value',
      colorScale: {
        domain: [50000,    150000,   300000,   500000,   1000000 ],
        range:  ['#fff5e1','#ffd28a','#f49a4c','#c2491c','#7a1a0e'],
      },
    },
    cities: {
      type: 'point-symbols',
      title: 'U.S. Cities by Population',
      subtitle: 'Drag the slider to filter by minimum population. Sources: Census 2024 Gazetteer (centroids) + ACS 2022 5-year (population).',
      // No topojson features for the colored layer — just a quiet
      // country backdrop drawn from the states TopoJSON.
      topojsonUrl: 'https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json',
      objectName: 'states',
      data: CITIES,
      // Slider runs in log10(population) space so each unit is a
      // "factor of 10" jump. UI shows the linear threshold value.
      sliderMin: 2.0, sliderMax: 7.0, sliderStep: 0.05,
      sliderInitial: 4.0,  // ≥ 10,000 people on initial load
      quickJumps: [
        { value: 2.0, label: '100' },
        { value: 3.0, label: '1k' },
        { value: 4.0, label: '10k' },
        { value: 5.0, label: '100k' },
        { value: 6.0, label: '1M' },
        { value: 7.0, label: '10M' },
      ],
      legendMinLabel: '',
      legendMaxLabel: '',
      legendNotYet: 'Filtered out',
      legendBarClass: '',  // no gradient — just dots
      playMs: 80,
    },
  };

  // Day-of-year helpers ------------------------------------------------

  // Cumulative day-of-year for the 1st of each month (non-leap year).
  // Index 0 = Jan 1 (DOY 1), index 12 = Jan 1 of next year (DOY 366).
  var MONTH_FIRST_DOY = [1, 32, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335, 366];

  // Day-of-year of the midpoint of each month (used as anchors for
  // monthly→daily linear interpolation). Computed as (firstOfMonth +
  // firstOfNextMonth) / 2 in DOY space.
  var MONTH_MID_DOY = (function() {
    var out = [];
    for (var i = 0; i < 12; i++) {
      out.push((MONTH_FIRST_DOY[i] + MONTH_FIRST_DOY[i + 1]) / 2);
    }
    return out; // [16.0, 45.5, 75.0, ...]
  })();

  // Linear interpolation between adjacent monthly midpoints, with
  // wraparound (Dec mid → Jan mid spans the year boundary).
  function interpDaily(monthly, doy) {
    if (!monthly || monthly.length !== 12) return null;
    // Extend midpoints with a wrap on each end so DOY values before the
    // Jan midpoint and after the Dec midpoint resolve to a segment.
    // -16 ≈ Dec midpoint - 365; 381 ≈ Jan midpoint + 365.
    var mids = [MONTH_MID_DOY[11] - 365].concat(MONTH_MID_DOY).concat([MONTH_MID_DOY[0] + 365]);
    var vals = [monthly[11]].concat(monthly).concat([monthly[0]]);
    for (var i = 0; i < mids.length - 1; i++) {
      if (doy >= mids[i] && doy <= mids[i + 1]) {
        var t = (doy - mids[i]) / (mids[i + 1] - mids[i]);
        return vals[i] + (vals[i + 1] - vals[i]) * t;
      }
    }
    return monthly[0];
  }

  function doyToDateLabel(doy) {
    // Use a non-leap year so DOY 60 = Mar 1 (not Feb 29). Day 366 still
    // resolves to Dec 31 because Date wraps.
    var d = new Date(2025, 0, doy);
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric' });
  }

  var svg = d3.select('#usmap-svg');
  var tooltip = d3.select('#usmap-tooltip');
  var projection = d3.geoAlbersUsa().scale(1200).translate([480, 300]);
  var path = d3.geoPath().projection(projection);

  // Cache loaded TopoJSON between layer switches.
  var topoCache = {};
  function loadTopo(url) {
    if (topoCache[url]) return Promise.resolve(topoCache[url]);
    return d3.json(url).then(function(us) { topoCache[url] = us; return us; });
  }

  var currentLayer = null;
  var currentFeatures = [];
  var currentColorScale = null;
  var currentYear = null;
  var playing = false;
  var playTimer = null;

  function activate(layerKey) {
    if (currentLayer && currentLayer.key === layerKey) return;
    stopPlay();

    var cfg = LAYERS[layerKey];
    currentLayer = Object.assign({ key: layerKey }, cfg);

    document.getElementById('usmap-title').textContent = cfg.title;
    document.getElementById('usmap-subtitle').textContent = cfg.subtitle;
    document.getElementById('usmap-legend-min').textContent = cfg.legendMinLabel || '';
    document.getElementById('usmap-legend-max').textContent = cfg.legendMaxLabel || '';
    document.getElementById('usmap-legend-not-yet').textContent = cfg.legendNotYet || '';
    var legendBar = document.querySelector('.usmap-legend-bar');
    legendBar.className = 'usmap-legend-bar' + (cfg.legendBarClass ? ' ' + cfg.legendBarClass : '');

    // Slider/play row only makes sense for layers with a time or
    // threshold dimension. Hide it for static layers.
    var controlsEl = document.querySelector('.usmap-controls');
    var hasSlider = cfg.type !== 'static';
    controlsEl.classList.toggle('no-slider', !hasSlider);

    // The second slider is only used by point-symbols layers (cities)
    // to put an upper bound on the population window.
    var slider2Row = document.getElementById('usmap-slider2-row');
    var slider2 = document.getElementById('usmap-slider2');
    var sliderPrefix = document.getElementById('usmap-slider-prefix');
    var hasMaxSlider = cfg.type === 'point-symbols';
    slider2Row.classList.toggle('hidden', !hasMaxSlider);
    sliderPrefix.textContent = hasMaxSlider ? 'Min ≥' : '';

    var slider = document.getElementById('usmap-slider');
    if (hasSlider) {
      slider.min = cfg.sliderMin;
      slider.max = cfg.sliderMax;
      slider.step = cfg.sliderStep || 1;
      slider.value = cfg.sliderInitial != null ? cfg.sliderInitial : cfg.sliderMin;

      document.getElementById('usmap-slider-min').textContent =
        cfg.type === 'instant-day' ? doyToDateLabel(cfg.sliderMin)
        : cfg.type === 'point-symbols' ? '100'
        : String(cfg.sliderMin);
      document.getElementById('usmap-slider-max').textContent =
        cfg.type === 'instant-day' ? doyToDateLabel(cfg.sliderMax)
        : cfg.type === 'point-symbols' ? '10M'
        : String(cfg.sliderMax);

      if (hasMaxSlider) {
        slider2.min = cfg.sliderMin;
        slider2.max = cfg.sliderMax;
        slider2.step = cfg.sliderStep || 1;
        // Default upper bound = slider's max (no cap until user moves it).
        slider2.value = cfg.sliderMax;
        document.getElementById('usmap-slider2-min').textContent = '100';
        document.getElementById('usmap-slider2-max').textContent = '10M';
      }

      // Quick-jump buttons.
      var btnHost = document.getElementById('usmap-year-buttons');
      btnHost.innerHTML = '';
      (cfg.quickJumps || []).forEach(function(j) {
        var b = document.createElement('button');
        b.textContent = j.label;
        b.dataset.value = String(j.value);
        b.addEventListener('click', function() {
          stopPlay();
          slider.value = j.value;
          update(j.value);
        });
        btnHost.appendChild(b);
      });
    }

    // Layer button active state.
    document.querySelectorAll('.usmap-layer-btn').forEach(function(b) {
      b.classList.toggle('active', b.dataset.layer === layerKey);
    });

    if (cfg.type === 'monotonic') {
      currentColorScale = d3.scaleSequential()
        .domain([cfg.sliderMin, cfg.sliderMax])
        .interpolator(d3.interpolateRgb(cfg.colorInterpolatorRgb[0], cfg.colorInterpolatorRgb[1]));
    } else if (cfg.colorScale) {
      // instant-day, static, time-series — all use d3.scaleLinear
      // over a multi-stop diverging or sequential gradient.
      currentColorScale = d3.scaleLinear()
        .domain(cfg.colorScale.domain)
        .range(cfg.colorScale.range)
        .clamp(true);
    }

    // Wipe previous layer's SVG content before redrawing.
    svg.selectAll('*').remove();

    if (cfg.type === 'point-symbols') {
      renderPointSymbols(cfg, +slider.value);
      return;
    }

    // Two geometry sources are supported:
    //   - cfg.topojsonUrl + cfg.objectName  → fetch from CDN
    //   - cfg.geojson                       → inline GeoJSON FeatureCollection
    // For inline-GeoJSON layers we load states-10m separately when the
    // state-overlay context line is requested.
    if (cfg.geojson) {
      renderFeatures(cfg, cfg.geojson.features);
      if (cfg.drawStateOverlay) {
        loadTopo('https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json').then(function(us) {
          var stateMesh = topojson.mesh(us, us.objects.states, function(a, b) { return a !== b; });
          svg.append('path')
            .attr('class', 'usmap-state-overlay')
            .attr('d', path(stateMesh));
        });
      }
      update(hasSlider ? +slider.value : 0);
      return;
    }

    loadTopo(cfg.topojsonUrl).then(function(us) {
      var features = topojson.feature(us, us.objects[cfg.objectName]).features;
      renderFeatures(cfg, features);
      // Optional state outlines drawn last so they paint on top.
      if (cfg.drawStateOverlay) {
        var stateMesh = topojson.mesh(us, us.objects.states, function(a, b) { return a !== b; });
        svg.append('path')
          .attr('class', 'usmap-state-overlay')
          .attr('d', path(stateMesh));
      }
      update(hasSlider ? +slider.value : 0);
    });
  }

  // Shared feature-rendering helper used by both TopoJSON-loaded and
  // inline-GeoJSON layers. Keeps the AlbersUSA null-path filter and
  // the mousemove/leave handlers in one place.
  function renderFeatures(cfg, features) {
    var rendered = features.filter(function(d) {
      var p = path(d);
      return p != null && p !== '';
    });
    currentFeatures = rendered;
    svg.selectAll('path.usmap-feature')
      .data(rendered)
      .enter()
      .append('path')
      .attr('class', 'usmap-feature ' + cfg.featureClass + ' not-yet')
      .attr('d', path)
      .on('mousemove', function(event, d) {
        tooltip
          .style('opacity', 1)
          .style('left', (event.pageX + 12) + 'px')
          .style('top', (event.pageY - 28) + 'px')
          .html(buildTooltipHtml(d));
      })
      .on('mouseleave', function() { tooltip.style('opacity', 0); });
  }

  // Render the cities point-symbols layer. Country backdrop + faint
  // state mesh for context, then a circle per city sized by population.
  function renderPointSymbols(cfg, sliderVal) {
    loadTopo(cfg.topojsonUrl).then(function(us) {
      // Backdrop: state polygons unioned into a single country fill.
      var states = topojson.feature(us, us.objects.states).features;
      svg.selectAll('path.usmap-country-fill')
        .data(states)
        .enter()
        .append('path')
        .attr('class', 'usmap-country-fill')
        .attr('d', path);
      // Faint internal state borders so the eye still parses the map.
      var stateMesh = topojson.mesh(us, us.objects.states, function(a, b) { return a !== b; });
      svg.append('path')
        .attr('class', 'usmap-state-mesh-faint')
        .attr('d', path(stateMesh));

      // Project each city; drop those outside the AlbersUSA frame.
      var projected = [];
      cfg.data.forEach(function(c) {
        var p = projection([c.lon, c.lat]);
        if (p) projected.push({ city: c, x: p[0], y: p[1] });
      });
      currentFeatures = projected;

      svg.selectAll('circle.usmap-city')
        .data(projected, function(d) { return d.city.name + d.city.st; })
        .enter()
        .append('circle')
        .attr('class', 'usmap-city')
        .attr('cx', function(d) { return d.x; })
        .attr('cy', function(d) { return d.y; })
        .on('mousemove', function(event, d) {
          tooltip
            .style('opacity', 1)
            .style('left', (event.pageX + 12) + 'px')
            .style('top', (event.pageY - 28) + 'px')
            .html('<strong>' + d.city.name + ', ' + d.city.st + '</strong><span class="y">' + d.city.pop.toLocaleString() + ' people</span>');
        })
        .on('mouseleave', function() { tooltip.style('opacity', 0); });

      update(sliderVal);
    });
  }

  // Tooltip body — branches on layer type. Uses currentLayer so the
  // closure captured in mousemove always reads the active config.
  function buildTooltipHtml(d) {
    var cfg = currentLayer;
    var title = cfg.tooltipTitle(d);
    var key = cfg.keyOf(d);
    if (cfg.type === 'monotonic') {
      var year = cfg.data[key];
      var line = year ? (cfg.tooltipVerb + ' ' + year) : '—';
      return '<strong>' + title + '</strong><span class="y">' + line + '</span>';
    }
    if (cfg.type === 'instant-day') {
      var monthly = cfg.data[key];
      var doy = +document.getElementById('usmap-slider').value;
      var t = monthly ? interpDaily(monthly, doy) : null;
      var line = (t == null) ? '—' : cfg.tooltipFormat(t, doyToDateLabel(doy));
      return '<strong>' + title + '</strong><span class="y">' + line + '</span>';
    }
    if (cfg.type === 'static') {
      var v = cfg.data[key];
      var line = (v == null) ? '—' : cfg.tooltipFormat(v);
      return '<strong>' + title + '</strong><span class="y">' + line + '</span>';
    }
    if (cfg.type === 'time-series') {
      var arr = cfg.data[key];
      var year = +document.getElementById('usmap-slider').value;
      // Snap to the closest available year in cfg.years (handles
      // slider steps that overshoot, e.g. 4-yr election grid).
      var idx = closestYearIndex(cfg.years, year);
      var snapYear = cfg.years[idx];
      var v = arr ? arr[idx] : null;
      var line = (v == null) ? '—' : cfg.tooltipFormat(v, String(snapYear));
      return '<strong>' + title + '</strong><span class="y">' + line + '</span>';
    }
    return '<strong>' + title + '</strong>';
  }

  function closestYearIndex(years, year) {
    var bestI = 0, bestD = Infinity;
    for (var i = 0; i < years.length; i++) {
      var d = Math.abs(years[i] - year);
      if (d < bestD) { bestD = d; bestI = i; }
    }
    return bestI;
  }

  function update(sliderVal) {
    if (!currentLayer) return;
    var cfg = currentLayer;

    if (cfg.type === 'monotonic') {
      document.getElementById('usmap-year').textContent = sliderVal;
      var count = 0;
      svg.selectAll('path.usmap-feature')
        .each(function(d) {
          var key = cfg.keyOf(d);
          var dataYear = cfg.data[key];
          var sel = d3.select(this);
          if (dataYear && dataYear <= sliderVal) {
            sel.classed('not-yet', false).attr('fill', currentColorScale(dataYear));
            count++;
          } else {
            sel.classed('not-yet', true).attr('fill', null);
          }
        });
      var total = cfg.countTotalOverride != null ? cfg.countTotalOverride : currentFeatures.length;
      document.getElementById('usmap-count').textContent = count.toLocaleString();
      document.getElementById('usmap-count-label').textContent =
        'of ' + total.toLocaleString() + ' ' + cfg.countLabel;
      return;
    }

    if (cfg.type === 'instant-day') {
      document.getElementById('usmap-year').textContent = doyToDateLabel(sliderVal);
      var sumT = 0, nT = 0;
      svg.selectAll('path.usmap-feature')
        .each(function(d) {
          var key = cfg.keyOf(d);
          var monthly = cfg.data[key];
          var sel = d3.select(this);
          if (!monthly) {
            sel.classed('not-yet', true).attr('fill', null);
            return;
          }
          var t = interpDaily(monthly, sliderVal);
          sel.classed('not-yet', false).attr('fill', currentColorScale(t));
          sumT += t;
          nT += 1;
        });
      if (nT > 0) {
        var avg = sumT / nT;
        var fmt = cfg.countFormat(avg, nT);
        document.getElementById('usmap-count').textContent = fmt.value;
        document.getElementById('usmap-count-label').textContent = fmt.label;
      } else {
        document.getElementById('usmap-count').textContent = '—';
        document.getElementById('usmap-count-label').textContent = '';
      }
      return;
    }

    if (cfg.type === 'static') {
      // No slider — paint each feature once, then summarize.
      document.getElementById('usmap-year').textContent = '';
      var sumS = 0, nS = 0, lo = Infinity, hi = -Infinity;
      svg.selectAll('path.usmap-feature')
        .each(function(d) {
          var key = cfg.keyOf(d);
          var v = cfg.data[key];
          var sel = d3.select(this);
          if (v == null) {
            sel.classed('not-yet', true).attr('fill', null);
            return;
          }
          sel.classed('not-yet', false).attr('fill', currentColorScale(v));
          sumS += v; nS += 1;
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        });
      if (nS > 0 && cfg.summaryFormat) {
        var fmt = cfg.summaryFormat({ mean: sumS / nS, min: lo, max: hi, n: nS });
        document.getElementById('usmap-count').textContent = fmt.value;
        document.getElementById('usmap-count-label').textContent = fmt.label;
      } else {
        document.getElementById('usmap-count').textContent = '—';
        document.getElementById('usmap-count-label').textContent = '';
      }
      return;
    }

    if (cfg.type === 'time-series') {
      var idx = closestYearIndex(cfg.years, sliderVal);
      var snapYear = cfg.years[idx];
      document.getElementById('usmap-year').textContent = String(snapYear);
      var sumV = 0, nV = 0;
      svg.selectAll('path.usmap-feature')
        .each(function(d) {
          var key = cfg.keyOf(d);
          var arr = cfg.data[key];
          var sel = d3.select(this);
          if (!arr || arr[idx] == null) {
            sel.classed('not-yet', true).attr('fill', null);
            return;
          }
          var v = arr[idx];
          var colorIn = cfg.logScale ? Math.log10(Math.max(1, v)) : v;
          sel.classed('not-yet', false).attr('fill', currentColorScale(colorIn));
          sumV += v; nV += 1;
        });
      if (nV > 0) {
        var avg = sumV / nV;
        var fmt = cfg.countFormat(avg, nV, sumV);
        document.getElementById('usmap-count').textContent = fmt.value;
        document.getElementById('usmap-count-label').textContent = fmt.label;
      } else {
        document.getElementById('usmap-count').textContent = '—';
        document.getElementById('usmap-count-label').textContent = '';
      }
      return;
    }

    if (cfg.type === 'point-symbols') {
      // Slider value is log10(threshold). Filter circles by population
      // window — between minPop (slider 1) and maxPop (slider 2).
      var minPop = Math.pow(10, sliderVal);
      var s2 = document.getElementById('usmap-slider2');
      var maxPop = Math.pow(10, +s2.value);
      // Guard against the user dragging max below min — interpret as
      // "no upper bound" so the map doesn't go blank surprisingly.
      if (maxPop < minPop) maxPop = Infinity;
      document.getElementById('usmap-year').textContent =
        formatPop(minPop) + ' - ' + (Number.isFinite(maxPop) ? formatPop(maxPop) : '∞');
      var visible = 0;
      svg.selectAll('circle.usmap-city')
        .each(function(d) {
          var sel = d3.select(this);
          if (d.city.pop >= minPop && d.city.pop <= maxPop) {
            sel.style('display', null);
            var r = Math.max(1, Math.sqrt(d.city.pop) * 0.012);
            sel.attr('r', r);
            visible++;
          } else {
            sel.style('display', 'none');
          }
        });
      document.getElementById('usmap-count').textContent = visible.toLocaleString();
      document.getElementById('usmap-count-label').textContent = 'cities in this population window';
      return;
    }
  }

  function formatPop(p) {
    if (p >= 1e6) return (p/1e6).toFixed(1) + 'M';
    if (p >= 1000) return Math.round(p/1000) + 'k';
    return Math.round(p).toString();
  }

  // Slider listens once globally; current min/max get updated on
  // layer change.
  var slider = document.getElementById('usmap-slider');
  slider.addEventListener('input', function(e) { update(+e.target.value); });

  // Second slider (max population for cities). Re-runs update() with
  // the primary slider's current value; update() reads slider2's
  // value internally for point-symbols layers.
  var slider2 = document.getElementById('usmap-slider2');
  slider2.addEventListener('input', function() { update(+slider.value); });

  // Play / pause. For instant-day layers the play loop wraps at the
  // year boundary instead of stopping, so the temperature animation
  // cycles continuously until the user pauses.
  var playBtn = document.getElementById('usmap-play');
  playBtn.addEventListener('click', function() {
    if (!currentLayer) return;
    if (currentLayer.type === 'static') return;
    if (playing) { stopPlay(); return; }
    if (+slider.value >= currentLayer.sliderMax) slider.value = currentLayer.sliderMin;
    playing = true;
    playBtn.textContent = '❚❚ Pause';
    playBtn.classList.add('playing');
    var wraps = currentLayer.type === 'instant-day';
    var step = currentLayer.sliderStep || 1;
    playTimer = setInterval(function() {
      var v = +slider.value + step;
      if (v > currentLayer.sliderMax) {
        if (wraps) v = currentLayer.sliderMin;
        else { stopPlay(); return; }
      }
      slider.value = v;
      update(v);
    }, currentLayer.playMs);
  });

  function stopPlay() {
    playing = false;
    clearInterval(playTimer);
    playBtn.textContent = '▶ Play';
    playBtn.classList.remove('playing');
  }

  document.getElementById('usmap-reset').addEventListener('click', function() {
    if (!currentLayer) return;
    stopPlay();
    var v = currentLayer.sliderInitial != null ? currentLayer.sliderInitial : currentLayer.sliderMin;
    slider.value = v;
    update(v);
  });

  // Layer buttons.
  document.querySelectorAll('.usmap-layer-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      activate(btn.dataset.layer);
      var u = new URL(window.location.href);
      u.searchParams.set('layer', btn.dataset.layer);
      window.history.replaceState(null, '', u.toString());
    });
  });

  // Boot.
  activate(INITIAL_LAYER);
})();`;
}
