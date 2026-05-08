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
import { COUNTY_MONTHLY_TEMPS_F } from './data/county_monthly_temps.js';

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
  const initialLayer = ['counties', 'temperature'].includes(layerParam) ? layerParam : 'statehood';

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
          #add8e6  33.33%, /* 40°F — light blue */
          #1e90ff  41.67%, /* 50°F — blue */
          #228b22  50%,    /* 60°F — green */
          #ffff00  58.33%, /* 70°F — yellow */
          #ffa500  66.67%, /* 80°F — orange */
          #ff0000  75%,    /* 90°F — red */
          #8b0000  83.33%, /* 100°F — dark red */
          #000000 100%);   /* 120°F+ — black */
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
      .usmap-slider-row input[type=range] { flex: 1; height: 6px; }
      .usmap-slider-bounds { font-size: 12px; color: #888; min-width: 44px; }
      .usmap-slider-bounds.right { text-align: right; }

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
    </style>
    ${tabs}
    <div class="usmap-page">
      <h1 id="usmap-title">U.S. Map</h1>
      <p class="subtitle" id="usmap-subtitle">Pick a layer below.</p>

      <div class="usmap-layer-row" role="tablist" aria-label="Map layer">
        <span class="label">Layer</span>
        <button class="usmap-layer-btn" data-layer="statehood"   type="button">Statehood</button>
        <button class="usmap-layer-btn" data-layer="counties"    type="button">Counties</button>
        <button class="usmap-layer-btn" data-layer="temperature" type="button">Temperature</button>
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
        <div class="usmap-slider-row">
          <span class="usmap-slider-bounds" id="usmap-slider-min">—</span>
          <input type="range" id="usmap-slider" min="0" max="1" value="0" step="1">
          <span class="usmap-slider-bounds right" id="usmap-slider-max">—</span>
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
function mapScript({ statehood, counties, temperature, stateNames, initialLayer }) {
  return `
(function() {
  var STATEHOOD = ${JSON.stringify(statehood)};
  var COUNTIES  = ${JSON.stringify(counties)};
  var TEMPS     = ${JSON.stringify(temperature)};
  var STATE_NAMES = ${JSON.stringify(stateNames)};
  var INITIAL_LAYER = ${JSON.stringify(initialLayer)};

  // Helper: county name + state for tooltip on county-keyed layers.
  function countyTitle(d) {
    var fips = String(d.id).padStart(5, '0');
    var name = (d.properties && d.properties.name) || 'County';
    var state = STATE_NAMES[fips.slice(0, 2)] || '';
    return state ? (name + ', ' + state) : name;
  }

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
      data: TEMPS,  // { fips: [Jan..Dec °F] }
      tooltipTitle: countyTitle,
      drawStateOverlay: true,
      sliderMin: 1, sliderMax: 366, sliderStep: 1,
      sliderInitial: 196,  // Jul 15 — peak summer for visual impact on first load
      quickJumps: [
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
      ],
      legendMinLabel: '0°F',
      legendMaxLabel: '120°F',
      legendNotYet: 'No data',
      legendBarClass: 'diverging-temp',
      playMs: 30,
      // 12-stop temperature spectrum. Values below 0°F clamp to dark
      // purple; values above 120°F clamp to black. Stops are anchored
      // at every 10°F so the legend bar gradient matches 1:1.
      colorScale: {
        domain: [0,        10,       20,       30,       40,       50,       60,       70,       80,       90,       100,      120     ],
        range:  ['#2e0854','#663399','#c8a2c8','#ffffff','#add8e6','#1e90ff','#228b22','#ffff00','#ffa500','#ff0000','#8b0000','#000000'],
      },
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
    document.getElementById('usmap-legend-min').textContent = cfg.legendMinLabel;
    document.getElementById('usmap-legend-max').textContent = cfg.legendMaxLabel;
    document.getElementById('usmap-legend-not-yet').textContent = cfg.legendNotYet;
    var legendBar = document.querySelector('.usmap-legend-bar');
    legendBar.className = 'usmap-legend-bar' + (cfg.legendBarClass ? ' ' + cfg.legendBarClass : '');

    var slider = document.getElementById('usmap-slider');
    slider.min = cfg.sliderMin;
    slider.max = cfg.sliderMax;
    slider.step = cfg.sliderStep || 1;
    slider.value = cfg.sliderInitial != null ? cfg.sliderInitial : cfg.sliderMin;

    document.getElementById('usmap-slider-min').textContent =
      cfg.type === 'instant-day' ? doyToDateLabel(cfg.sliderMin) : String(cfg.sliderMin);
    document.getElementById('usmap-slider-max').textContent =
      cfg.type === 'instant-day' ? doyToDateLabel(cfg.sliderMax) : String(cfg.sliderMax);

    // Quick-jump buttons.
    var btnHost = document.getElementById('usmap-year-buttons');
    btnHost.innerHTML = '';
    cfg.quickJumps.forEach(function(j) {
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

    // Layer button active state.
    document.querySelectorAll('.usmap-layer-btn').forEach(function(b) {
      b.classList.toggle('active', b.dataset.layer === layerKey);
    });

    if (cfg.type === 'monotonic') {
      currentColorScale = d3.scaleSequential()
        .domain([cfg.sliderMin, cfg.sliderMax])
        .interpolator(d3.interpolateRgb(cfg.colorInterpolatorRgb[0], cfg.colorInterpolatorRgb[1]));
    } else if (cfg.type === 'instant-day') {
      currentColorScale = d3.scaleLinear()
        .domain(cfg.colorScale.domain)
        .range(cfg.colorScale.range)
        .clamp(true);
    }

    // Wipe previous layer's SVG content before redrawing.
    svg.selectAll('*').remove();

    loadTopo(cfg.topojsonUrl).then(function(us) {
      var features = topojson.feature(us, us.objects[cfg.objectName]).features;

      // d3.geoAlbersUsa returns null for points outside the 50-state
      // frame (PR, USVI, NMI). Drop those so totals reflect what's
      // actually drawn.
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

      // Optional state outlines drawn last so they paint on top.
      if (cfg.drawStateOverlay) {
        var stateMesh = topojson.mesh(us, us.objects.states, function(a, b) { return a !== b; });
        svg.append('path')
          .attr('class', 'usmap-state-overlay')
          .attr('d', path(stateMesh));
      }

      update(+slider.value);
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
      var line = (t == null) ? '—'
        : (Math.round(t * 10) / 10).toFixed(1) + '°F on ' + doyToDateLabel(doy);
      return '<strong>' + title + '</strong><span class="y">' + line + '</span>';
    }
    return '<strong>' + title + '</strong>';
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
      var avg = nT > 0 ? Math.round((sumT / nT) * 10) / 10 : null;
      document.getElementById('usmap-count').textContent =
        avg != null ? (avg.toFixed(1) + '°F') : '—';
      document.getElementById('usmap-count-label').textContent =
        'national average across ' + nT.toLocaleString() + ' counties';
      return;
    }
  }

  // Slider listens once globally; current min/max get updated on
  // layer change.
  var slider = document.getElementById('usmap-slider');
  slider.addEventListener('input', function(e) { update(+e.target.value); });

  // Play / pause. For instant-day layers the play loop wraps at the
  // year boundary instead of stopping, so the temperature animation
  // cycles continuously until the user pauses.
  var playBtn = document.getElementById('usmap-play');
  playBtn.addEventListener('click', function() {
    if (!currentLayer) return;
    if (playing) { stopPlay(); return; }
    if (+slider.value >= currentLayer.sliderMax) slider.value = currentLayer.sliderMin;
    playing = true;
    playBtn.textContent = '❚❚ Pause';
    playBtn.classList.add('playing');
    var wraps = currentLayer.type === 'instant-day';
    playTimer = setInterval(function() {
      var v = +slider.value + 1;
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
