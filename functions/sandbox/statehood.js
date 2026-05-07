// functions/sandbox/statehood.js
//
// GET /sandbox/statehood — interactive map showing US statehood by year.
// Drag the slider or press Play to watch states join the union from
// 1787 to 1959. Pure client-side: D3 + topojson loaded from CDN, statehood
// dates baked into the page. No backend.
//
// Wes-only — same email gate as the rest of /sandbox/*.

import { layout, html, htmlResponse, raw, subnavTabs } from '../lib/layout.js';

const SANDBOX_OWNER = 'wes.yoakum@c-lars.com';

export async function onRequestGet(context) {
  const user = context.data?.user;
  if (!user || user.email !== SANDBOX_OWNER) {
    return new Response('Not found', { status: 404 });
  }

  const tabs = subnavTabs(
    [
      { href: '/sandbox/assistant',  label: 'Claudia' },
      { href: '/sandbox/statehood',  label: 'Statehood' },
      { href: '/sandbox/flow-chart', label: 'Flow Chart' },
    ],
    '/sandbox/statehood'
  );

  const body = html`
    <style>
      .statehood-page { max-width: 1100px; margin: 0 auto; padding: 16px; }
      .statehood-page h1 { font-size: 24px; font-weight: 600; margin-bottom: 4px; }
      .statehood-page .subtitle { color: #666; margin-bottom: 20px; font-size: 13px; }

      .statehood-map-card {
        background: #fff;
        padding: 16px;
        border-radius: 8px;
        border: 1px solid #e0e0d8;
      }
      .statehood-map-card svg { width: 100%; height: auto; display: block; }

      .statehood-state {
        stroke: #fff;
        stroke-width: 0.75;
        transition: fill 0.4s ease;
        cursor: pointer;
      }
      .statehood-state.not-yet { fill: #e8e8e0; }
      .statehood-state:hover { stroke: #222; stroke-width: 1.5; }

      .statehood-legend {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-top: 12px;
        font-size: 12px;
        color: #555;
      }
      .statehood-legend-bar {
        flex: 1;
        height: 12px;
        background: linear-gradient(to right, #d4e4f0, #5a8db0, #1a3a5c);
        border-radius: 2px;
      }
      .statehood-legend-key {
        margin-left: 16px;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .statehood-legend-key span {
        width: 14px; height: 12px;
        background: #e8e8e0;
        display: inline-block;
        border-radius: 2px;
      }

      .statehood-controls {
        background: #fff;
        padding: 18px 22px;
        border-radius: 8px;
        border: 1px solid #e0e0d8;
        margin-top: 16px;
      }
      .statehood-year-display {
        font-size: 38px;
        font-weight: 700;
        color: #1a3a5c;
        margin-bottom: 4px;
        font-variant-numeric: tabular-nums;
        line-height: 1.1;
      }
      .statehood-count-display {
        font-size: 13px;
        color: #666;
        margin-bottom: 14px;
      }
      .statehood-count-display strong { color: #1a3a5c; }

      .statehood-slider-row { display: flex; align-items: center; gap: 12px; }
      .statehood-slider-row input[type=range] { flex: 1; height: 6px; }
      .statehood-slider-bounds { font-size: 12px; color: #888; min-width: 40px; }

      .statehood-button-row { margin-top: 12px; display: flex; gap: 8px; flex-wrap: wrap; }
      .statehood-button-row button {
        padding: 6px 14px;
        border: 1px solid #ccc;
        background: #fafaf6;
        border-radius: 4px;
        font-size: 13px;
        cursor: pointer;
        transition: all 0.15s;
      }
      .statehood-button-row button:hover { background: #ebebe2; border-color: #999; }
      .statehood-button-row button.playing {
        background: #1a3a5c; color: #fff; border-color: #1a3a5c;
      }

      .statehood-tooltip {
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
      .statehood-tooltip strong { display: block; font-size: 14px; }
      .statehood-tooltip .y { color: #9ec5e8; }
    </style>
    ${tabs}
    <div class="statehood-page">
      <h1>U.S. Statehood by Year</h1>
      <p class="subtitle">Drag the slider or press play to watch states join the union from 1787 to 1959.</p>

      <div class="statehood-map-card">
        <svg id="statehood-map" viewBox="0 0 960 600"></svg>
        <div class="statehood-legend">
          <span>1787</span>
          <div class="statehood-legend-bar"></div>
          <span>1959</span>
          <span class="statehood-legend-key">
            <span></span>
            Not yet a state
          </span>
        </div>
      </div>

      <div class="statehood-controls">
        <div class="statehood-year-display" id="statehood-year">1787</div>
        <div class="statehood-count-display"><strong id="statehood-count">0</strong> of 50 states have joined the union</div>
        <div class="statehood-slider-row">
          <span class="statehood-slider-bounds">1787</span>
          <input type="range" id="statehood-slider" min="1787" max="1959" value="1787" step="1">
          <span class="statehood-slider-bounds">1959</span>
        </div>
        <div class="statehood-button-row">
          <button id="statehood-play">▶ Play</button>
          <button id="statehood-reset">Reset</button>
          <button data-year="1787">1787</button>
          <button data-year="1820">1820</button>
          <button data-year="1865">1865</button>
          <button data-year="1900">1900</button>
          <button data-year="1959">1959</button>
        </div>
      </div>
    </div>

    <div class="statehood-tooltip" id="statehood-tooltip"></div>

    <script src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.8.5/d3.min.js"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/topojson/3.0.2/topojson.min.js"></script>
    <script>${raw(statehoodScript())}</script>
  `;

  return htmlResponse(layout('Statehood', body, { user, activeNav: '/sandbox' }));
}

// Inline page script — D3 + topojson are loaded via CDN <script> tags
// just above this block. Returned as a plain string (injected via raw())
// so the JS can use ${...} in template literals without colliding with
// the outer html`...` template literal.
function statehoodScript() {
  return `
(function() {
  // Statehood years for each state (matches the "name" property in
  // the us-atlas TopoJSON).
  var statehoodByName = {
    "Delaware": 1787, "Pennsylvania": 1787, "New Jersey": 1787,
    "Georgia": 1788, "Connecticut": 1788, "Massachusetts": 1788,
    "Maryland": 1788, "South Carolina": 1788, "New Hampshire": 1788,
    "Virginia": 1788, "New York": 1788,
    "North Carolina": 1789, "Rhode Island": 1790,
    "Vermont": 1791, "Kentucky": 1792, "Tennessee": 1796,
    "Ohio": 1803, "Louisiana": 1812, "Indiana": 1816, "Mississippi": 1817,
    "Illinois": 1818, "Alabama": 1819, "Maine": 1820, "Missouri": 1821,
    "Arkansas": 1836, "Michigan": 1837, "Florida": 1845, "Texas": 1845,
    "Iowa": 1846, "Wisconsin": 1848, "California": 1850, "Minnesota": 1858,
    "Oregon": 1859, "Kansas": 1861, "West Virginia": 1863, "Nevada": 1864,
    "Nebraska": 1867, "Colorado": 1876,
    "North Dakota": 1889, "South Dakota": 1889, "Montana": 1889, "Washington": 1889,
    "Idaho": 1890, "Wyoming": 1890, "Utah": 1896, "Oklahoma": 1907,
    "New Mexico": 1912, "Arizona": 1912, "Alaska": 1959, "Hawaii": 1959
  };

  var MIN_YEAR = 1787, MAX_YEAR = 1959;

  // Color scale: older = lighter blue, newer = darker blue.
  var colorScale = d3.scaleSequential()
    .domain([MIN_YEAR, MAX_YEAR])
    .interpolator(d3.interpolateRgb('#d4e4f0', '#1a3a5c'));

  var svg = d3.select('#statehood-map');
  var tooltip = d3.select('#statehood-tooltip');
  var projection = d3.geoAlbersUsa().scale(1200).translate([480, 300]);
  var path = d3.geoPath().projection(projection);

  d3.json('https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json').then(function(us) {
    var states = topojson.feature(us, us.objects.states).features;

    svg.selectAll('path.statehood-state')
      .data(states)
      .enter()
      .append('path')
      .attr('class', 'statehood-state not-yet')
      .attr('d', path)
      .on('mousemove', function(event, d) {
        var name = d.properties.name;
        var year = statehoodByName[name];
        tooltip
          .style('opacity', 1)
          .style('left', (event.pageX + 12) + 'px')
          .style('top', (event.pageY - 28) + 'px')
          .html('<strong>' + name + '</strong><span class="y">' + (year ? 'Joined ' + year : '—') + '</span>');
      })
      .on('mouseleave', function() { tooltip.style('opacity', 0); });

    update(MIN_YEAR);
  });

  function update(year) {
    document.getElementById('statehood-year').textContent = year;
    var count = 0;
    svg.selectAll('path.statehood-state')
      .each(function(d) {
        var name = d.properties.name;
        var stateYear = statehoodByName[name];
        var sel = d3.select(this);
        if (stateYear && stateYear <= year) {
          sel.classed('not-yet', false).attr('fill', colorScale(stateYear));
          count++;
        } else {
          sel.classed('not-yet', true).attr('fill', null);
        }
      });
    document.getElementById('statehood-count').textContent = count;
  }

  var slider = document.getElementById('statehood-slider');
  slider.addEventListener('input', function(e) { update(+e.target.value); });

  // Play / pause.
  var playing = false;
  var playTimer = null;
  var playBtn = document.getElementById('statehood-play');

  playBtn.addEventListener('click', function() {
    if (playing) { stopPlay(); return; }
    if (+slider.value >= MAX_YEAR) slider.value = MIN_YEAR;
    playing = true;
    playBtn.textContent = '❚❚ Pause';
    playBtn.classList.add('playing');
    playTimer = setInterval(function() {
      var v = +slider.value + 1;
      if (v > MAX_YEAR) { stopPlay(); return; }
      slider.value = v;
      update(v);
    }, 120);
  });

  function stopPlay() {
    playing = false;
    clearInterval(playTimer);
    playBtn.textContent = '▶ Play';
    playBtn.classList.remove('playing');
  }

  document.getElementById('statehood-reset').addEventListener('click', function() {
    stopPlay();
    slider.value = MIN_YEAR;
    update(MIN_YEAR);
  });

  document.querySelectorAll('button[data-year]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      stopPlay();
      var y = +btn.dataset.year;
      slider.value = y;
      update(y);
    });
  });
})();`;
}
