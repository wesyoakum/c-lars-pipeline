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

// All layer data is served lazily by /sandbox/us-map/data/[layer]
// instead of being inlined into the page response. Initial HTML
// stays around 50 KB; the browser fetches each layer's payload only
// when the user activates that layer (with a small in-memory cache
// to avoid repeated round-trips on layer-switch).

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
    'msaIncome', 'msaHomeValue', 'watersheds', 'migration',
    'zipIncome', 'zipIncomePerCapita', 'zipPopulation',
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

      .usmap-layer-row-spacer { flex: 1; min-width: 12px; }
      .usmap-toggle-btn {
        padding: 7px 14px;
        border: 1px solid #ccc;
        background: #fafaf6;
        border-radius: 4px;
        font-size: 13px;
        cursor: pointer;
        transition: all 0.15s;
      }
      .usmap-toggle-btn:hover { background: #ebebe2; border-color: #999; }
      .usmap-toggle-btn[aria-pressed="true"] {
        background: #6d4c41; color: #fff; border-color: #6d4c41;
      }

      /* Faint terrain backdrop drawn underneath the active layer when
         the underlay toggle is on. Built from the county elevation
         chloropleth at low opacity so the active layer reads on top. */
      .usmap-underlay-county {
        stroke: none;
        pointer-events: none;
        opacity: 0.35;
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
      .usmap-feature.huc8      { stroke-width: 0.3; stroke: #f6f6f3; }
      .usmap-feature.zcta      { stroke-width: 0.05; stroke: rgba(255,255,255,0.4); }
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
      .usmap-legend-bar.watersheds {
        /* Categorical 18-stripe palette mirroring HUC2_COLORS so the
           reader sees roughly which color → which region. Hard stops
           (no interpolation) via 0% width steps. */
        background: linear-gradient(to right,
          #1f77b4 0%,        #1f77b4 5.55%,  #aec7e8 5.55%,  #aec7e8 11.11%,
          #ff7f0e 11.11%,    #ff7f0e 16.66%, #ffbb78 16.66%, #ffbb78 22.22%,
          #2ca02c 22.22%,    #2ca02c 27.77%, #98df8a 27.77%, #98df8a 33.33%,
          #d62728 33.33%,    #d62728 38.88%, #ff9896 38.88%, #ff9896 44.44%,
          #9467bd 44.44%,    #9467bd 50%,    #c5b0d5 50%,    #c5b0d5 55.55%,
          #8c564b 55.55%,    #8c564b 61.11%, #c49c94 61.11%, #c49c94 66.66%,
          #e377c2 66.66%,    #e377c2 72.22%, #f7b6d3 72.22%, #f7b6d3 77.77%,
          #7f7f7f 77.77%,    #7f7f7f 83.33%, #bcbd22 83.33%, #bcbd22 88.88%,
          #dbdb8d 88.88%,    #dbdb8d 94.44%, #17becf 94.44%, #17becf 100%);
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

      /* Migration flow lines — quadratic Bezier arcs between county
         centroids. fill: none + transparent stroke for the layered
         starburst effect. */
      .usmap-flow {
        fill: none;
        stroke: #1a3a5c;
        stroke-opacity: 0.18;
        stroke-linecap: round;
        pointer-events: none;
      }
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
        <button class="usmap-layer-btn" data-layer="watersheds"    type="button">Watersheds</button>
        <button class="usmap-layer-btn" data-layer="migration"     type="button">Migration</button>
        <button class="usmap-layer-btn" data-layer="zipIncome"          type="button">ZIP Income</button>
        <button class="usmap-layer-btn" data-layer="zipIncomePerCapita" type="button">ZIP Per-Cap Income</button>
        <button class="usmap-layer-btn" data-layer="zipPopulation"      type="button">ZIP Population</button>
        <span class="usmap-layer-row-spacer"></span>
        <button class="usmap-toggle-btn" id="usmap-underlay-btn" type="button" aria-pressed="false" title="Show / hide a faint terrain underlay (county elevations)">Terrain underlay</button>
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
function mapScript({ stateNames, initialLayer }) {
  return `
(function() {
  var STATE_NAMES = ${JSON.stringify(stateNames)};
  var INITIAL_LAYER = ${JSON.stringify(initialLayer)};

  // ----- Lazy data fetcher -----------------------------------------
  // Each layer declares a 'fetch' object describing which endpoint
  // slugs it needs and where they should land on the layer config
  // (e.g. { data: 'pdsi', geojson: 'cbsa-geometry' }). loadLayerData()
  // resolves all of those in parallel, caches the JSON in fetchCache,
  // and unwraps composite payloads (the slugs that return both data
  // and years).
  var DATA_BASE = '/sandbox/us-map/data/';
  var fetchCache = new Map();
  function fetchSlug(slug) {
    if (fetchCache.has(slug)) return fetchCache.get(slug);
    var p = fetch(DATA_BASE + slug, { credentials: 'same-origin' })
      .then(function(r) {
        if (!r.ok) throw new Error('Layer fetch failed: ' + slug + ' ' + r.status);
        return r.json();
      });
    fetchCache.set(slug, p);
    return p;
  }
  function loadLayerData(cfg) {
    var fetches = cfg.fetch || {};
    var fields = Object.keys(fetches);
    return Promise.all(fields.map(function(f) { return fetchSlug(fetches[f]); }))
      .then(function(payloads) {
        for (var i = 0; i < fields.length; i++) {
          var field = fields[i];
          var payload = payloads[i];
          // Composite payloads like { data, years } get unwrapped onto
          // cfg directly so render code can read cfg.data / cfg.years.
          if (field === 'data' && payload && typeof payload === 'object' && 'data' in payload && 'years' in payload) {
            cfg.data = payload.data;
            cfg.years = payload.years;
          } else {
            cfg[field] = payload;
          }
        }
      });
  }

  // Helper: county name + state for tooltip on county-keyed layers.
  function countyTitle(d) {
    var fips = String(d.id).padStart(5, '0');
    var name = (d.properties && d.properties.name) || 'County';
    var state = STATE_NAMES[fips.slice(0, 2)] || '';
    return state ? (name + ', ' + state) : name;
  }

  // HUC2 (parent watershed region) → color + name. Used by the
  // Watersheds layer to paint each HUC8 subbasin by its parent
  // region. Hand-picked from the d3 schemeCategory20 palette so
  // adjacent regions get visually distinct hues.
  var HUC2_COLORS = {
    '01':'#1f77b4', '02':'#aec7e8', '03':'#ff7f0e', '04':'#ffbb78',
    '05':'#2ca02c', '06':'#98df8a', '07':'#d62728', '08':'#ff9896',
    '09':'#9467bd', '10':'#c5b0d5', '11':'#8c564b', '12':'#c49c94',
    '13':'#e377c2', '14':'#f7b6d3', '15':'#7f7f7f', '16':'#bcbd22',
    '17':'#dbdb8d', '18':'#17becf',
  };
  var HUC2_NAMES = {
    '01':'New England',          '02':'Mid-Atlantic',
    '03':'South Atlantic-Gulf',  '04':'Great Lakes',
    '05':'Ohio',                 '06':'Tennessee',
    '07':'Upper Mississippi',    '08':'Lower Mississippi',
    '09':'Souris-Red-Rainy',     '10':'Missouri',
    '11':'Arkansas-White-Red',   '12':'Texas-Gulf',
    '13':'Rio Grande',           '14':'Upper Colorado',
    '15':'Lower Colorado',       '16':'Great Basin',
    '17':'Pacific Northwest',    '18':'California',
  };

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
      fetch: { data: 'statehood' },
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
      fetch: { data: 'counties' },
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
      fetch: { data: 'temperature' },
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
      fetch: { data: 'highs' },
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
      fetch: { data: 'lows' },
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
      fetch: { data: 'precip' },
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
      fetch: { data: 'elevation' },
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
      fetch: { data: 'income' },
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
      subtitle: 'Annual-mean Palmer Drought Severity Index per county, 1900-present. Source: NOAA climdiv-pdsicy.',
      topojsonUrl: 'https://cdn.jsdelivr.net/npm/us-atlas@3/counties-10m.json',
      objectName: 'counties',
      featureClass: 'counties',
      keyOf: function(d) { return String(d.id).padStart(5, '0'); },
      fetch: { data: 'pdsi' },
      tooltipTitle: countyTitle,
      tooltipFormat: function(v, label) { return (v >= 0 ? '+' : '') + v.toFixed(1) + ' PDSI in ' + label; },
      countFormat: function(avg, n) {
        return { value: (avg >= 0 ? '+' : '') + avg.toFixed(2), label: 'national mean PDSI across ' + n.toLocaleString() + ' counties' };
      },
      drawStateOverlay: true,
      sliderMin: 1900, sliderMax: 2026, sliderStep: 1,
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
      fetch: { data: 'population' },
      tooltipTitle: countyTitle,
      tooltipFormat: function(v, label) { return v.toLocaleString() + ' in ' + label; },
      countFormat: function(avg, n, sum) {
        return { value: (sum/1e6).toFixed(1) + ' M', label: 'total population across ' + n.toLocaleString() + ' counties (≥ 1 person)' };
      },
      drawStateOverlay: true,
      sliderMin: 1900, sliderMax: 2020, sliderStep: 10,
      sliderInitial: 2020,
      quickJumps: [1900,1910,1920,1930,1940,1950,1960,1970,1980,1990,2000,2010,2020].map(function(y) { return { value: y, label: String(y) }; }),
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
      fetch: { data: 'elections' },
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
      sliderMin: 2008, sliderMax: 2024, sliderStep: 4,
      sliderInitial: 2024,
      quickJumps: [2008,2012,2016,2020,2024].map(function(y) { return { value: y, label: String(y) }; }),
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
      fetch: { geojson: 'cbsa-geometry', data: 'cbsa-income' },
      featureClass: 'msa',
      keyOf: function(d) { return d.properties.geoid; },
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
      fetch: { geojson: 'cbsa-geometry', data: 'cbsa-home-value' },
      featureClass: 'msa',
      keyOf: function(d) { return d.properties.geoid; },
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
    zipIncome: {
      type: 'static',
      title: 'Median Household Income by ZIP Code',
      subtitle: '~33,000 ZCTAs (Census 2020 boundaries) at simplified geometry. ACS 2018-2022 5-year (B19013). Heavy initial fetch (~6 MB) — first activation takes a few seconds.',
      fetch: { geojson: 'zcta-geometry', data: 'zcta-income' },
      featureClass: 'zcta',
      keyOf: function(d) { return d.properties.z; },
      data: null,  // populated by fetch
      tooltipTitle: function(d) { return 'ZIP ' + d.properties.z; },
      tooltipFormat: function(v) { return '$' + v.toLocaleString(); },
      summaryFormat: function(stats) {
        return { value: '$' + Math.round(stats.mean).toLocaleString(), label: 'mean across ' + stats.n.toLocaleString() + ' ZCTAs — range $' + stats.min.toLocaleString() + ' to $' + stats.max.toLocaleString() };
      },
      drawStateOverlay: true,
      legendMinLabel: '$25k',
      legendMaxLabel: '$200k+',
      legendNotYet: 'No data',
      legendBarClass: 'income',
      colorScale: {
        domain: [25000,    50000,    75000,    100000,   150000,    200000  ],
        range:  ['#f7fcf5','#c7e9c0','#74c476','#2e7d32','#1b3a14',  '#0a1f08'],
      },
    },
    zipIncomePerCapita: {
      type: 'static',
      title: 'Per-Capita Income by ZIP Code',
      subtitle: '~33,000 ZCTAs (Census 2020 boundaries) at simplified geometry. ACS 2018-2022 5-year (B19301) — total income in past 12 months ÷ total population. Heavy initial fetch (~6 MB) — first activation takes a few seconds.',
      fetch: { geojson: 'zcta-geometry', data: 'zcta-income-per-capita' },
      featureClass: 'zcta',
      keyOf: function(d) { return d.properties.z; },
      tooltipTitle: function(d) { return 'ZIP ' + d.properties.z; },
      tooltipFormat: function(v) { return '$' + v.toLocaleString(); },
      summaryFormat: function(stats) {
        return { value: '$' + Math.round(stats.mean).toLocaleString(), label: 'mean across ' + stats.n.toLocaleString() + ' ZCTAs — range $' + stats.min.toLocaleString() + ' to $' + stats.max.toLocaleString() };
      },
      drawStateOverlay: true,
      legendMinLabel: '$10k',
      legendMaxLabel: '$100k+',
      legendNotYet: 'No data',
      legendBarClass: 'income',
      // Tighter range than zipIncome — per-capita figures sit roughly
      // half the household-income values, so the gradient anchors at
      // $10k / $25k / $40k / $60k / $80k / $100k+.
      colorScale: {
        domain: [10000,    25000,    40000,    60000,    80000,    100000  ],
        range:  ['#f7fcf5','#c7e9c0','#74c476','#2e7d32','#1b3a14','#0a1f08'],
      },
    },
    zipPopulation: {
      type: 'static',
      title: 'Population by ZIP Code',
      subtitle: '~33,000 ZCTAs colored by raw population on a log scale. ACS 2018-2022 5-year (B01003). Big-city density emerges as bright spots.',
      fetch: { geojson: 'zcta-geometry', data: 'zcta-population' },
      featureClass: 'zcta',
      keyOf: function(d) { return d.properties.z; },
      tooltipTitle: function(d) { return 'ZIP ' + d.properties.z; },
      tooltipFormat: function(v) { return v.toLocaleString() + ' people'; },
      summaryFormat: function(stats) {
        return { value: stats.n.toLocaleString() + ' ZCTAs', label: 'population range ' + stats.min.toLocaleString() + '–' + stats.max.toLocaleString() };
      },
      drawStateOverlay: true,
      legendMinLabel: '< 100',
      legendMaxLabel: '100k+',
      legendNotYet: 'No data',
      legendBarClass: 'population',
      // Log10 of population. Most ZCTAs hold 1k–30k people; the tails
      // (rural < 100, dense urban > 50k) hit the gradient ends.
      colorScale: {
        domain: [0,        2,        3,        3.7,      4.3,      5      ],
        range:  ['#f7fcf5','#d2efd0','#91c98f','#3a8f54','#1c3d6f','#0a0a2a'],
      },
      logScale: true,
    },
    watersheds: {
      type: 'static',
      title: 'U.S. Watersheds (HUC8 subbasins)',
      subtitle: '~2,400 hydrologic subbasins (USGS WBD), colored by parent HUC2 region. Mississippi/Missouri basins dominate the Plains; Pacific NW, Rio Grande, Great Basin each carve their own slice of the West.',
      fetch: { geojson: 'huc8' },
      featureClass: 'huc8',
      keyOf: function(d) { return d.properties.huc8; },
      // Categorical: each HUC8's first 2 digits is its parent HUC2
      // region. fillFn() short-circuits the linear color scale so we
      // can paint by region rather than by a numeric value.
      fillFn: function(d) {
        var prefix = (d.properties.huc8 || '').slice(0, 2);
        return HUC2_COLORS[prefix] || '#cccccc';
      },
      tooltipTitle: function(d) {
        var p = d.properties || {};
        var prefix = (p.huc8 || '').slice(0, 2);
        var region = HUC2_NAMES[prefix] || '';
        return (p.name || 'Watershed') + (p.states ? ' — ' + p.states : '') + ' · ' + region;
      },
      tooltipFormat: function() { return ''; },
      summaryFormat: function(stats) {
        return { value: stats.n + ' watersheds', label: 'shown across the contiguous US' };
      },
      drawStateOverlay: true,
      legendMinLabel: '',
      legendMaxLabel: '',
      legendNotYet: '',
      legendBarClass: 'watersheds',
    },
    migration: {
      type: 'flows',
      title: 'U.S. County-to-County Migration (2022→2023)',
      subtitle: 'IRS tax-return flows. Each curve goes from origin county to destination; thickness ∝ # of people moved. Drag the slider to set a minimum flow size.',
      // Backdrop is just the country/state context; the flows ride on top.
      topojsonUrl: 'https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json',
      objectName: 'states',
      fetch: { data: 'migration' },
      // Slider runs in log10(min #people) space — same idea as cities.
      sliderMin: 1.0, sliderMax: 5.0, sliderStep: 0.05,
      sliderInitial: 3.0,  // ≥ 1,000 people
      quickJumps: [
        { value: 1.0, label: '10' },
        { value: 2.0, label: '100' },
        { value: 3.0, label: '1k' },
        { value: 4.0, label: '10k' },
        { value: 5.0, label: '100k' },
      ],
      legendMinLabel: '',
      legendMaxLabel: '',
      legendNotYet: '',
      legendBarClass: '',
      playMs: 80,
    },
    cities: {
      type: 'point-symbols',
      title: 'U.S. Cities by Population',
      subtitle: 'Drag the slider to filter by minimum population. Sources: Census 2024 Gazetteer (centroids) + ACS 2022 5-year (population).',
      // No topojson features for the colored layer — just a quiet
      // country backdrop drawn from the states TopoJSON.
      topojsonUrl: 'https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json',
      objectName: 'states',
      fetch: { data: 'cities' },
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

  // Terrain underlay state (toggled by the button at the right of the
  // layer row). When on, the active layer's features render on top of
  // a low-opacity county-elevation chloropleth so you can read both
  // the data and the rough topography at the same time.
  var underlayOn = false;
  var TERRAIN_DOMAIN = [0, 500, 1500, 3000, 4500, 6500, 9000, 12000];
  var TERRAIN_RANGE  = ['#1b5e20','#66bb6a','#c5e1a5','#fff8a1','#d4a373','#8b5a2b','#b8b8b8','#ffffff'];
  var terrainScale = d3.scaleLinear().domain(TERRAIN_DOMAIN).range(TERRAIN_RANGE).clamp(true);

  function renderUnderlay() {
    if (!underlayOn) return;
    // Lazy-fetch the elevation lookup only when the underlay first
    // renders. fetchSlug() caches so repeated toggles are free.
    Promise.all([
      loadTopo('https://cdn.jsdelivr.net/npm/us-atlas@3/counties-10m.json'),
      fetchSlug('elevation'),
    ]).then(function(arr) {
      var us = arr[0], elevation = arr[1];
      var counties = topojson.feature(us, us.objects.counties).features.filter(function(d) {
        var p = path(d);
        return p != null && p !== '';
      });
      var g = svg.insert('g', ':first-child').attr('class', 'usmap-underlay');
      g.selectAll('path.usmap-underlay-county')
        .data(counties)
        .enter()
        .append('path')
        .attr('class', 'usmap-underlay-county')
        .attr('d', path)
        .attr('fill', function(d) {
          var fips = String(d.id).padStart(5, '0');
          var elev = elevation[fips];
          return elev != null ? terrainScale(elev) : '#e8e8e0';
        });
    });
  }

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
        : cfg.type === 'flows' ? '10'
        : String(cfg.sliderMin);
      document.getElementById('usmap-slider-max').textContent =
        cfg.type === 'instant-day' ? doyToDateLabel(cfg.sliderMax)
        : cfg.type === 'point-symbols' ? '10M'
        : cfg.type === 'flows' ? '100k'
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
    // Optional terrain underlay drawn first so the active layer paints
    // on top. Cheap to skip when the toggle is off.
    renderUnderlay();

    // Fetch this layer's data (cached on subsequent activations), then
    // render. Layer data lives behind /sandbox/us-map/data/<slug> so
    // the initial HTML stays small.
    loadLayerData(cfg).then(function() {
      // Re-snap the currentLayer reference so render code reads the
      // freshly-populated cfg.data / cfg.geojson / cfg.years.
      currentLayer = Object.assign({ key: layerKey }, cfg);

      if (cfg.type === 'point-symbols') {
        renderPointSymbols(cfg, +slider.value);
        return;
      }
      if (cfg.type === 'flows') {
        renderFlows(cfg, +slider.value);
        return;
      }

      // Two geometry sources are supported:
      //   - cfg.topojsonUrl + cfg.objectName  → fetch from CDN
      //   - cfg.geojson                       → fetched via fetch slug
      // For inline-GeoJSON layers we load states-10m separately when
      // the state-overlay context line is requested.
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
        if (cfg.drawStateOverlay) {
          var stateMesh = topojson.mesh(us, us.objects.states, function(a, b) { return a !== b; });
          svg.append('path')
            .attr('class', 'usmap-state-overlay')
            .attr('d', path(stateMesh));
        }
        update(hasSlider ? +slider.value : 0);
      });
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

  // Render the migration-flows layer. Country/state backdrop, then
  // pre-projects every county centroid once and stores the projected
  // (x, y) on each flow record so update() can filter quickly without
  // re-projecting on every slider tick.
  function renderFlows(cfg, sliderVal) {
    loadTopo(cfg.topojsonUrl).then(function(us) {
      var states = topojson.feature(us, us.objects.states).features;
      svg.selectAll('path.usmap-country-fill')
        .data(states)
        .enter()
        .append('path')
        .attr('class', 'usmap-country-fill')
        .attr('d', path);
      var stateMesh = topojson.mesh(us, us.objects.states, function(a, b) { return a !== b; });
      svg.append('path')
        .attr('class', 'usmap-state-mesh-faint')
        .attr('d', path(stateMesh));

      // Project each centroid through AlbersUSA. cfg.data has shape
      // { centroids: { fips: [lon, lat] }, flows: [[origin, dest, n]] }.
      var pts = {};
      var centroids = cfg.data.centroids || {};
      Object.keys(centroids).forEach(function(fips) {
        var ll = centroids[fips];
        var p = projection([ll[0], ll[1]]);
        if (p) pts[fips] = p;
      });

      // Pre-build path strings for every flow we'll ever consider.
      // The slider only filters which ones display, so building paths
      // up front avoids re-stringifying on every tick. ~50 K paths is
      // fine for the DOM as long as most are display:none most of the
      // time.
      var flows = cfg.data.flows || [];
      var rendered = [];
      for (var i = 0; i < flows.length; i++) {
        var f = flows[i];
        var a = pts[f[0]], b = pts[f[1]];
        if (!a || !b) continue;
        rendered.push({
          origin: f[0], dest: f[1], n: f[2],
          d: bezierBetween(a[0], a[1], b[0], b[1]),
        });
      }
      currentFeatures = rendered;

      svg.selectAll('path.usmap-flow')
        .data(rendered)
        .enter()
        .append('path')
        .attr('class', 'usmap-flow')
        .attr('d', function(d) { return d.d; });

      update(sliderVal);
    });
  }

  // Quadratic Bezier between two projected points with a perpendicular
  // arch so the flow lines aren't a straight starburst.
  function bezierBetween(x1, y1, x2, y2) {
    var dx = x2 - x1, dy = y2 - y1;
    var midX = (x1 + x2) / 2, midY = (y1 + y2) / 2;
    // Control point offset perpendicular to the direct line. 18% of
    // the segment length feels gentle enough for the cluttered map.
    var nx = -dy * 0.18, ny = dx * 0.18;
    return 'M' + x1 + ',' + y1 + 'Q' + (midX + nx) + ',' + (midY + ny) + ' ' + x2 + ',' + y2;
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
      // Categorical static layers (e.g. watersheds) skip the data
      // lookup and just show the title. The keyOf/tooltipTitle pair
      // already encodes the category in the title text.
      if (typeof cfg.fillFn === 'function') {
        return '<strong>' + title + '</strong>';
      }
      var v = cfg.data ? cfg.data[key] : null;
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
      // Two paint modes: numeric (cfg.data + cfg.colorScale) or
      // categorical (cfg.fillFn directly returns the fill color).
      document.getElementById('usmap-year').textContent = '';
      var sumS = 0, nS = 0, lo = Infinity, hi = -Infinity;
      var hasFn = typeof cfg.fillFn === 'function';
      svg.selectAll('path.usmap-feature')
        .each(function(d) {
          var sel = d3.select(this);
          if (hasFn) {
            var c = cfg.fillFn(d);
            sel.classed('not-yet', false).attr('fill', c);
            nS += 1;
            return;
          }
          var key = cfg.keyOf(d);
          var v = cfg.data[key];
          if (v == null) {
            sel.classed('not-yet', true).attr('fill', null);
            return;
          }
          var colorIn = cfg.logScale ? Math.log10(Math.max(1, v)) : v;
          sel.classed('not-yet', false).attr('fill', currentColorScale(colorIn));
          sumS += v; nS += 1;
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        });
      if (nS > 0 && cfg.summaryFormat) {
        var fmt = cfg.summaryFormat({ mean: hasFn ? null : sumS / nS, min: lo, max: hi, n: nS });
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

    if (cfg.type === 'flows') {
      // Slider value is log10(min #people). Show flows ≥ that threshold
      // and scale stroke width by sqrt(n) so a 100-person flow isn't 10×
      // thicker than a 10-person flow.
      var minPeople = Math.pow(10, sliderVal);
      document.getElementById('usmap-year').textContent = '≥ ' + formatPop(minPeople);
      var visible = 0, totalPeople = 0;
      svg.selectAll('path.usmap-flow')
        .each(function(d) {
          var sel = d3.select(this);
          if (d.n >= minPeople) {
            sel.style('display', null)
              .attr('stroke-width', Math.max(0.4, Math.sqrt(d.n) * 0.06))
              .attr('stroke-opacity', d.n > 5000 ? 0.5 : (d.n > 500 ? 0.3 : 0.18));
            visible++;
            totalPeople += d.n;
          } else {
            sel.style('display', 'none');
          }
        });
      document.getElementById('usmap-count').textContent = visible.toLocaleString();
      document.getElementById('usmap-count-label').textContent =
        'flows shown — ' + totalPeople.toLocaleString() + ' people moved (IRS exemptions)';
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

  // Terrain underlay toggle. Re-runs activate() so the underlay either
  // appears or vanishes from underneath the current layer.
  var underlayBtn = document.getElementById('usmap-underlay-btn');
  if (underlayBtn) {
    underlayBtn.addEventListener('click', function() {
      underlayOn = !underlayOn;
      underlayBtn.setAttribute('aria-pressed', underlayOn ? 'true' : 'false');
      // Re-run activate() to redraw with/without underlay. Force the
      // currentLayer guard to miss by clearing it first.
      var key = currentLayer && currentLayer.key;
      currentLayer = null;
      if (key) activate(key);
    });
  }

  // Boot.
  activate(INITIAL_LAYER);
})();`;
}
