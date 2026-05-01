'use strict';

const SVG_NS = 'http://www.w3.org/2000/svg';
const STORAGE_KEY = 'flowchart-v1';
const HISTORY_LIMIT = 100;

const SHAPE_DEFAULTS = {
  rect:          { w: 140, h: 60, label: 'Process' },
  diamond:       { w: 140, h: 90, label: 'Decision?' },
  ellipse:       { w: 140, h: 60, label: 'Start' },
  parallelogram: { w: 140, h: 60, label: 'Input' },
  person:        { w: 180, h: 70, label: 'Name\nTitle' },
};

const FILL_COLORS = ['#ffffff', '#dbeafe', '#d1fae5', '#fef9c3', '#ffedd5', '#ffe4e6', '#ede9fe', '#e2e8f0'];
const STROKE_COLORS = ['#4a4a52', '#1a1a22', '#dc2626', '#ea580c', '#16a34a', '#2566ff', '#9333ea', '#9ca3af'];
const DEFAULT_FILL = '#ffffff';
const DEFAULT_STROKE = '#4a4a52';
const PERSON_FILL = '#fbfbfd';

const TAB_NAMES = ['flowchart', 'orgchart'];

function makeFreshTab() {
  return {
    state: {
      nodes: [],
      edges: [],
      view: { tx: 0, ty: 0, scale: 1 },
      selected: null,
      armedTool: null,
      dragging: null,
      editing: null,
      nextId: 1,
    },
    history: { undo: [], redo: [] },
  };
}

const tabs = {
  flowchart: makeFreshTab(),
  orgchart: makeFreshTab(),
};
let activeTab = 'flowchart';
let state = tabs[activeTab].state;
let history = tabs[activeTab].history;
let saveTimer = null;
let spaceDown = false;
let rubberBandLine = null;
let helpHidden = false;
let inspectorHidden = false;

const canvas = document.getElementById('canvas');
const viewport = document.getElementById('viewport');
const edgesG = document.getElementById('edges');
const nodesG = document.getElementById('nodes');
const overlayG = document.getElementById('overlay');
const zoomIndicator = document.getElementById('zoom-indicator');
const btnUndo = document.getElementById('btn-undo');
const btnRedo = document.getElementById('btn-redo');
const btnAutoArrange = document.getElementById('btn-auto-arrange');
const btnToggleHelp = document.getElementById('btn-toggle-help');
const btnToggleInspector = document.getElementById('btn-toggle-inspector');
const helpEl = document.getElementById('help');
const inspectorEl = document.getElementById('inspector');
const inspectorEmpty = document.getElementById('inspector-empty');
const inspectorNode = document.getElementById('inspector-node');
const inspectorEdge = document.getElementById('inspector-edge');
const propW = document.getElementById('prop-w');
const propH = document.getElementById('prop-h');

const uid = (p) => `${p}_${state.nextId++}`;
const findNode = (id) => state.nodes.find(n => n.id === id);
const findEdge = (id) => state.edges.find(e => e.id === id);

function nodeFill(n) { return n.fill || (n.type === 'person' ? PERSON_FILL : DEFAULT_FILL); }
function nodeStroke(n) { return n.stroke || DEFAULT_STROKE; }
function edgeStroke(e) { return e.stroke || DEFAULT_STROKE; }
function edgeStyle(e) { return e.style || 'solid'; }
function edgeRouting(e) { return e.routing || 'straight'; }

function snapshot() {
  return JSON.stringify({ nodes: state.nodes, edges: state.edges, nextId: state.nextId });
}
function restoreSnapshot(s) {
  const d = JSON.parse(s);
  state.nodes = d.nodes;
  state.edges = d.edges;
  if (typeof d.nextId === 'number') state.nextId = d.nextId;
}
function pushUndo(prevSnap) {
  history.undo.push(prevSnap);
  if (history.undo.length > HISTORY_LIMIT) history.undo.shift();
  history.redo = [];
  updateUndoRedoButtons();
}

function clientToSvg(e) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left - state.view.tx) / state.view.scale,
    y: (e.clientY - rect.top - state.view.ty) / state.view.scale,
  };
}

function exitPoint(rect, target) {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const dx = target.x - cx;
  const dy = target.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  const sx = adx === 0 ? Infinity : (rect.w / 2) / adx;
  const sy = ady === 0 ? Infinity : (rect.h / 2) / ady;
  const s = Math.min(sx, sy);
  return { x: cx + dx * s, y: cy + dy * s };
}

// For orthogonal routing: pick which sides of the source/target the line should attach to.
function orthogonalEndpoints(from, to) {
  const fc = { x: from.x + from.w/2, y: from.y + from.h/2 };
  const tc = { x: to.x + to.w/2, y: to.y + to.h/2 };
  const dx = tc.x - fc.x;
  const dy = tc.y - fc.y;
  const horizontal = Math.abs(dx) >= Math.abs(dy);
  let start, end;
  if (horizontal) {
    if (dx >= 0) {
      start = { x: from.x + from.w, y: fc.y };
      end =   { x: to.x,             y: tc.y };
    } else {
      start = { x: from.x,           y: fc.y };
      end =   { x: to.x + to.w,      y: tc.y };
    }
  } else {
    if (dy >= 0) {
      start = { x: fc.x, y: from.y + from.h };
      end =   { x: tc.x, y: to.y };
    } else {
      start = { x: fc.x, y: from.y };
      end =   { x: tc.x, y: to.y + to.h };
    }
  }
  return { start, end, horizontal };
}

function computeEdgeGeometry(e) {
  const from = findNode(e.from);
  const to = findNode(e.to);
  if (!from || !to) return null;
  const routing = edgeRouting(e);
  if (routing === 'straight') {
    const fc = { x: from.x + from.w/2, y: from.y + from.h/2 };
    const tc = { x: to.x + to.w/2, y: to.y + to.h/2 };
    const start = exitPoint(from, tc);
    const end = exitPoint(to, fc);
    return { d: `M ${start.x} ${start.y} L ${end.x} ${end.y}`, handlePos: null };
  }
  if (routing === 'curve') {
    const fc = { x: from.x + from.w/2, y: from.y + from.h/2 };
    const tc = { x: to.x + to.w/2, y: to.y + to.h/2 };
    const start = exitPoint(from, tc);
    const end = exitPoint(to, fc);
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len; // perpendicular unit vector
    const offset = (typeof e.curveOffset === 'number') ? e.curveOffset : 40;
    const mx = (start.x + end.x) / 2 + nx * offset;
    const my = (start.y + end.y) / 2 + ny * offset;
    return {
      d: `M ${start.x} ${start.y} Q ${mx} ${my} ${end.x} ${end.y}`,
      handlePos: { x: mx, y: my },
    };
  }
  if (routing === 'orthogonal') {
    const { start, end, horizontal } = orthogonalEndpoints(from, to);
    let fraction = (typeof e.elbowFraction === 'number') ? e.elbowFraction : 0.5;
    fraction = Math.max(0.05, Math.min(0.95, fraction));
    if (horizontal) {
      const mx = start.x + (end.x - start.x) * fraction;
      return {
        d: `M ${start.x} ${start.y} L ${mx} ${start.y} L ${mx} ${end.y} L ${end.x} ${end.y}`,
        handlePos: { x: mx, y: (start.y + end.y) / 2 },
      };
    } else {
      const my = start.y + (end.y - start.y) * fraction;
      return {
        d: `M ${start.x} ${start.y} L ${start.x} ${my} L ${end.x} ${my} L ${end.x} ${end.y}`,
        handlePos: { x: (start.x + end.x) / 2, y: my },
      };
    }
  }
  return null;
}

function wrapText(text, maxChars) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (cur.length === 0) cur = w;
    else if (cur.length + 1 + w.length <= maxChars) cur += ' ' + w;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines;
}

function buildLabelTspans(n) {
  const isPerson = n.type === 'person';
  const maxChars = isPerson ? 22 : 18;
  const rawLines = String(n.label || '').split('\n');
  const items = [];
  for (let li = 0; li < rawLines.length; li++) {
    const wrapped = wrapText(rawLines[li], maxChars);
    for (const w of wrapped) {
      const kind = isPerson ? (li === 0 ? 'name' : 'title') : 'normal';
      items.push({ text: w, kind });
    }
  }
  const lh = (k) => k === 'title' ? 14 : 16;
  let total = 0;
  for (const it of items) total += lh(it.kind);
  let y = (n.h / 2) - (total / 2) + 12;
  const tspans = [];
  for (const it of items) {
    const tspan = document.createElementNS(SVG_NS, 'tspan');
    tspan.setAttribute('x', n.w / 2);
    tspan.setAttribute('y', y);
    if (it.kind === 'name') tspan.setAttribute('font-weight', '600');
    if (it.kind === 'title') {
      tspan.setAttribute('fill', '#666');
      tspan.setAttribute('font-size', '12');
    }
    tspan.textContent = it.text;
    tspans.push(tspan);
    y += lh(it.kind);
  }
  return tspans;
}

function fitNodeToLabel(n) {
  const tempG = document.createElementNS(SVG_NS, 'g');
  const tempText = document.createElementNS(SVG_NS, 'text');
  tempText.setAttribute('class', 'node-label');
  tempText.setAttribute('text-anchor', 'middle');
  tempText.style.visibility = 'hidden';
  for (const tspan of buildLabelTspans(n)) tempText.appendChild(tspan);
  tempG.appendChild(tempText);
  overlayG.appendChild(tempG);
  let bbox;
  try { bbox = tempText.getBBox(); } catch (err) { bbox = { width: 0, height: 0 }; }
  overlayG.removeChild(tempG);
  const padX = n.type === 'diamond' ? 60 : 28;
  const padY = n.type === 'diamond' ? 40 : 22;
  const reqW = Math.ceil(bbox.width + padX);
  const reqH = Math.ceil(bbox.height + padY);
  if (reqW > n.w) n.w = reqW;
  if (reqH > n.h) n.h = reqH;
}

function render() {
  updateView();
  edgesG.innerHTML = '';
  nodesG.innerHTML = '';
  for (const e of state.edges) {
    const el = buildEdgeElement(e);
    if (el) edgesG.appendChild(el);
  }
  for (const n of state.nodes) {
    nodesG.appendChild(buildNodeElement(n));
  }
  updateUndoRedoButtons();
  updateInspector();
}

function updateView() {
  viewport.setAttribute('transform', `translate(${state.view.tx}, ${state.view.ty}) scale(${state.view.scale})`);
  zoomIndicator.textContent = Math.round(state.view.scale * 100) + '%';
}

function updateUndoRedoButtons() {
  btnUndo.disabled = history.undo.length === 0;
  btnRedo.disabled = history.redo.length === 0;
}

function buildNodeElement(n, opts = {}) {
  const isSelected = !opts.forExport && state.selected && state.selected.kind === 'node' && state.selected.id === n.id;
  const g = document.createElementNS(SVG_NS, 'g');
  g.setAttribute('class', 'node' + (isSelected ? ' selected' : ''));
  g.setAttribute('data-id', n.id);
  g.setAttribute('data-type', n.type);
  g.setAttribute('transform', `translate(${n.x}, ${n.y})`);

  let shape;
  if (n.type === 'rect' || n.type === 'person') {
    shape = document.createElementNS(SVG_NS, 'rect');
    shape.setAttribute('x', 0);
    shape.setAttribute('y', 0);
    shape.setAttribute('width', n.w);
    shape.setAttribute('height', n.h);
    shape.setAttribute('rx', n.type === 'person' ? 6 : 4);
    shape.setAttribute('ry', n.type === 'person' ? 6 : 4);
  } else if (n.type === 'diamond') {
    shape = document.createElementNS(SVG_NS, 'polygon');
    shape.setAttribute('points', `${n.w/2},0 ${n.w},${n.h/2} ${n.w/2},${n.h} 0,${n.h/2}`);
  } else if (n.type === 'ellipse') {
    shape = document.createElementNS(SVG_NS, 'ellipse');
    shape.setAttribute('cx', n.w/2);
    shape.setAttribute('cy', n.h/2);
    shape.setAttribute('rx', n.w/2);
    shape.setAttribute('ry', n.h/2);
  } else if (n.type === 'parallelogram') {
    shape = document.createElementNS(SVG_NS, 'polygon');
    const skew = 16;
    shape.setAttribute('points', `${skew},0 ${n.w},0 ${n.w-skew},${n.h} 0,${n.h}`);
  }
  shape.setAttribute('class', 'node-shape');
  shape.setAttribute('fill', nodeFill(n));
  shape.setAttribute('stroke', nodeStroke(n));
  g.appendChild(shape);

  if (state.editing !== n.id) {
    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('class', 'node-label');
    for (const tspan of buildLabelTspans(n)) text.appendChild(tspan);
    g.appendChild(text);
  }

  if (!opts.forExport) {
    const dotPositions = [
      { x: n.w / 2, y: 0 },
      { x: n.w,     y: n.h / 2 },
      { x: n.w / 2, y: n.h },
      { x: 0,       y: n.h / 2 },
    ];
    for (const p of dotPositions) {
      const dot = document.createElementNS(SVG_NS, 'circle');
      dot.setAttribute('cx', p.x);
      dot.setAttribute('cy', p.y);
      dot.setAttribute('r', 5);
      dot.setAttribute('class', 'connector-dot');
      dot.setAttribute('data-node-id', n.id);
      g.appendChild(dot);
    }
    const handles = [
      { x: 0,    y: 0,    side: 'nw', cursor: 'nwse-resize' },
      { x: n.w,  y: 0,    side: 'ne', cursor: 'nesw-resize' },
      { x: n.w,  y: n.h,  side: 'se', cursor: 'nwse-resize' },
      { x: 0,    y: n.h,  side: 'sw', cursor: 'nesw-resize' },
    ];
    for (const h of handles) {
      const sq = document.createElementNS(SVG_NS, 'rect');
      sq.setAttribute('x', h.x - 4);
      sq.setAttribute('y', h.y - 4);
      sq.setAttribute('width', 8);
      sq.setAttribute('height', 8);
      sq.setAttribute('class', 'resize-handle');
      sq.setAttribute('data-resize-side', h.side);
      sq.setAttribute('data-node-id', n.id);
      sq.style.cursor = h.cursor;
      g.appendChild(sq);
    }
  }

  return g;
}

function buildEdgeElement(e, opts = {}) {
  const geom = computeEdgeGeometry(e);
  if (!geom) return null;
  const isSelected = !opts.forExport && state.selected && state.selected.kind === 'edge' && state.selected.id === e.id;
  const useArrow = activeTab === 'flowchart';
  const stroke = isSelected ? '#2566ff' : edgeStroke(e);
  const style = edgeStyle(e);

  const g = document.createElementNS(SVG_NS, 'g');
  g.setAttribute('data-id', e.id);

  if (!opts.forExport) {
    const hit = document.createElementNS(SVG_NS, 'path');
    hit.setAttribute('d', geom.d);
    hit.setAttribute('class', 'edge-hit');
    hit.setAttribute('data-id', e.id);
    g.appendChild(hit);
  }

  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', geom.d);
  path.setAttribute('class', 'edge-path' + (isSelected ? ' selected' : ''));
  path.setAttribute('stroke', stroke);
  path.setAttribute('fill', 'none');
  if (style === 'dashed') path.setAttribute('stroke-dasharray', '8 4');
  else if (style === 'dotted') {
    path.setAttribute('stroke-dasharray', '1.5 4');
    path.setAttribute('stroke-linecap', 'round');
  }
  if (useArrow) path.setAttribute('marker-end', 'url(#arrow)');
  path.setAttribute('data-id', e.id);
  g.appendChild(path);

  if (isSelected && geom.handlePos && !opts.forExport) {
    const handle = document.createElementNS(SVG_NS, 'circle');
    handle.setAttribute('cx', geom.handlePos.x);
    handle.setAttribute('cy', geom.handlePos.y);
    handle.setAttribute('r', 5);
    handle.setAttribute('class', 'edge-handle');
    handle.setAttribute('data-edge-id', e.id);
    g.appendChild(handle);
  }

  return g;
}

function updateEdgeInPlace(e) {
  const grp = edgesG.querySelector(`g[data-id="${e.id}"]`);
  if (!grp) return;
  const geom = computeEdgeGeometry(e);
  if (!geom) return;
  for (const child of grp.children) {
    if (child.tagName === 'path' || child.tagName === 'PATH') {
      child.setAttribute('d', geom.d);
    } else if ((child.tagName === 'circle' || child.tagName === 'CIRCLE') && geom.handlePos) {
      child.setAttribute('cx', geom.handlePos.x);
      child.setAttribute('cy', geom.handlePos.y);
    }
  }
}

function updateNodeAndIncidentEdges(n) {
  const nodeG = nodesG.querySelector(`g.node[data-id="${n.id}"]`);
  if (nodeG) nodeG.setAttribute('transform', `translate(${n.x}, ${n.y})`);
  for (const e of state.edges) {
    if (e.from !== n.id && e.to !== n.id) continue;
    updateEdgeInPlace(e);
  }
}

function placeShape(type, pt) {
  const def = SHAPE_DEFAULTS[type];
  if (!def) return;
  const prev = snapshot();
  const node = {
    id: uid('n'),
    type,
    x: pt.x - def.w / 2,
    y: pt.y - def.h / 2,
    w: def.w,
    h: def.h,
    label: def.label,
  };
  state.nodes.push(node);
  state.selected = { kind: 'node', id: node.id };
  pushUndo(prev);
  render();
  saveSoon();
  startLabelEdit(node.id);
}

function deleteSelected() {
  if (!state.selected) return;
  const prev = snapshot();
  if (state.selected.kind === 'node') {
    const id = state.selected.id;
    state.nodes = state.nodes.filter(n => n.id !== id);
    state.edges = state.edges.filter(e => e.from !== id && e.to !== id);
  } else if (state.selected.kind === 'edge') {
    const id = state.selected.id;
    state.edges = state.edges.filter(e => e.id !== id);
  }
  state.selected = null;
  pushUndo(prev);
  render();
  saveSoon();
}

function addEdge(fromId, toId) {
  if (fromId === toId) return;
  if (state.edges.some(e => e.from === fromId && e.to === toId)) return;
  const prev = snapshot();
  state.edges.push({ id: uid('e'), from: fromId, to: toId });
  pushUndo(prev);
  render();
  saveSoon();
}

function clearAll() {
  if (state.nodes.length === 0 && state.edges.length === 0) return;
  if (!confirm('Clear this diagram? You can still undo with Ctrl+Z.')) return;
  const prev = snapshot();
  state.nodes = [];
  state.edges = [];
  state.selected = null;
  pushUndo(prev);
  render();
  saveSoon();
}

function setArmedTool(tool) {
  state.armedTool = tool;
  for (const btn of document.querySelectorAll('#toolbar button[data-tool]')) {
    btn.classList.toggle('armed', btn.dataset.tool === tool);
  }
  canvas.classList.toggle('armed', !!tool);
}
function selectNode(id) {
  state.selected = { kind: 'node', id };
  render();
}
function selectEdge(id) {
  state.selected = { kind: 'edge', id };
  render();
}
function deselect() {
  if (state.selected) {
    state.selected = null;
    render();
  }
}

function startDragNode(id, pt) {
  const n = findNode(id);
  if (!n) return;
  state.dragging = {
    kind: 'node',
    id,
    offsetX: pt.x - n.x,
    offsetY: pt.y - n.y,
    prev: snapshot(),
    moved: false,
  };
}

function startResize(side, nodeId, pt) {
  const n = findNode(nodeId);
  if (!n) return;
  state.dragging = {
    kind: 'resize',
    id: nodeId,
    side,
    startW: n.w,
    startH: n.h,
    startX: n.x,
    startY: n.y,
    startPt: pt,
    prev: snapshot(),
    moved: false,
  };
}

function startConnect(fromId, pt) {
  state.dragging = { kind: 'connect', from: fromId };
  drawRubberBand(fromId, pt);
}

function startEdgeHandle(edgeId, pt) {
  const e = findEdge(edgeId);
  if (!e) return;
  state.dragging = {
    kind: 'edgeHandle',
    edgeId,
    routing: edgeRouting(e),
    prev: snapshot(),
    moved: false,
    startPt: pt,
  };
}

function startPan(e) {
  state.dragging = {
    kind: 'pan',
    startX: e.clientX,
    startY: e.clientY,
    startTx: state.view.tx,
    startTy: state.view.ty,
  };
  canvas.classList.add('panning');
}

function drawRubberBand(fromId, pt) {
  const from = findNode(fromId);
  if (!from) return;
  const start = exitPoint(from, pt);
  if (!rubberBandLine) {
    rubberBandLine = document.createElementNS(SVG_NS, 'line');
    rubberBandLine.setAttribute('class', 'rubber-band');
    if (activeTab === 'flowchart') rubberBandLine.setAttribute('marker-end', 'url(#arrow-rubber)');
    overlayG.appendChild(rubberBandLine);
  }
  rubberBandLine.setAttribute('x1', start.x);
  rubberBandLine.setAttribute('y1', start.y);
  rubberBandLine.setAttribute('x2', pt.x);
  rubberBandLine.setAttribute('y2', pt.y);
}
function removeRubberBand() {
  if (rubberBandLine) {
    rubberBandLine.remove();
    rubberBandLine = null;
  }
}

function startLabelEdit(nodeId, initialText) {
  const n = findNode(nodeId);
  if (!n) return;
  state.editing = nodeId;
  const prev = snapshot();
  render();

  const nodeG = nodesG.querySelector(`g.node[data-id="${nodeId}"]`);
  if (!nodeG) { state.editing = null; return; }
  const fo = document.createElementNS(SVG_NS, 'foreignObject');
  fo.setAttribute('x', 4);
  fo.setAttribute('y', 4);
  fo.setAttribute('width', n.w - 8);
  fo.setAttribute('height', n.h - 8);
  fo.setAttribute('class', 'editing');

  const div = document.createElement('div');
  div.className = 'label-editor';
  div.contentEditable = 'true';
  div.spellcheck = false;
  const seedWithText = (typeof initialText === 'string');
  div.textContent = seedWithText ? initialText : n.label;
  fo.appendChild(div);
  nodeG.appendChild(fo);
  div.focus();
  const range = document.createRange();
  range.selectNodeContents(div);
  if (seedWithText) range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  let finished = false;
  const finish = (save) => {
    if (finished) return;
    finished = true;
    const newLabel = (div.innerText || div.textContent || '').replace(/\s+$/g, '').replace(/^\s+/g, '');
    state.editing = null;
    if (save && newLabel && newLabel !== n.label) {
      n.label = newLabel;
      fitNodeToLabel(n);
      pushUndo(prev);
      saveSoon();
    }
    render();
  };
  div.addEventListener('blur', () => finish(true));
  div.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      div.blur();
    } else if (ev.key === 'Enter' && ev.shiftKey) {
      ev.stopPropagation();
      return;
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      finished = true;
      state.editing = null;
      render();
    }
    ev.stopPropagation();
  });
}

function commitEditingIfAny() {
  if (state.editing) {
    if (document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }
  }
}

function undo() {
  if (history.undo.length === 0) return;
  const cur = snapshot();
  const prev = history.undo.pop();
  history.redo.push(cur);
  restoreSnapshot(prev);
  state.selected = null;
  render();
  saveSoon();
}
function redo() {
  if (history.redo.length === 0) return;
  const cur = snapshot();
  const next = history.redo.pop();
  history.undo.push(cur);
  restoreSnapshot(next);
  state.selected = null;
  render();
  saveSoon();
}

function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveLocal, 150);
}
function saveLocal() {
  try {
    const data = { activeTab, helpHidden, inspectorHidden, tabs: {} };
    for (const name of TAB_NAMES) {
      const t = tabs[name].state;
      data.tabs[name] = { nodes: t.nodes, edges: t.edges, view: t.view, nextId: t.nextId };
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (err) {}
}
function loadLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const d = JSON.parse(raw);
    if (d.tabs) {
      for (const name of TAB_NAMES) {
        const tabData = d.tabs[name];
        if (!tabData) continue;
        const t = tabs[name].state;
        t.nodes = Array.isArray(tabData.nodes) ? tabData.nodes : [];
        t.edges = Array.isArray(tabData.edges) ? tabData.edges : [];
        if (tabData.view && typeof tabData.view.scale === 'number') t.view = tabData.view;
        if (typeof tabData.nextId === 'number') t.nextId = tabData.nextId;
      }
      if (d.activeTab && tabs[d.activeTab]) activeTab = d.activeTab;
    } else {
      const t = tabs.flowchart.state;
      t.nodes = Array.isArray(d.nodes) ? d.nodes : [];
      t.edges = Array.isArray(d.edges) ? d.edges : [];
      if (d.view && typeof d.view.scale === 'number') t.view = d.view;
      if (typeof d.nextId === 'number') t.nextId = d.nextId;
    }
    if (typeof d.helpHidden === 'boolean') helpHidden = d.helpHidden;
    if (typeof d.inspectorHidden === 'boolean') inspectorHidden = d.inspectorHidden;
    state = tabs[activeTab].state;
    history = tabs[activeTab].history;
  } catch (err) {}
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 200);
}

function buildExportSvg() {
  const padding = 24;
  let minX = 0, minY = 0, maxX = 100, maxY = 100;
  if (state.nodes.length > 0) {
    minX = Infinity; minY = Infinity; maxX = -Infinity; maxY = -Infinity;
    for (const n of state.nodes) {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + n.w);
      maxY = Math.max(maxY, n.y + n.h);
    }
  }
  minX -= padding; minY -= padding; maxX += padding; maxY += padding;
  const w = Math.max(10, maxX - minX);
  const h = Math.max(10, maxY - minY);

  const svgEl = document.createElementNS(SVG_NS, 'svg');
  svgEl.setAttribute('xmlns', SVG_NS);
  svgEl.setAttribute('width', w);
  svgEl.setAttribute('height', h);
  svgEl.setAttribute('viewBox', `${minX} ${minY} ${w} ${h}`);

  const styleEl = document.createElementNS(SVG_NS, 'style');
  styleEl.textContent =
    ".node-shape { stroke-width: 1.5; } " +
    ".node-label { font: 14px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; fill: #1a1a22; } " +
    ".edge-path { stroke-width: 1.5; fill: none; }";
  svgEl.appendChild(styleEl);

  const bg = document.createElementNS(SVG_NS, 'rect');
  bg.setAttribute('x', minX);
  bg.setAttribute('y', minY);
  bg.setAttribute('width', w);
  bg.setAttribute('height', h);
  bg.setAttribute('fill', '#ffffff');
  svgEl.appendChild(bg);

  if (activeTab === 'flowchart') {
    const defs = document.createElementNS(SVG_NS, 'defs');
    const marker = document.createElementNS(SVG_NS, 'marker');
    marker.setAttribute('id', 'arrow');
    marker.setAttribute('viewBox', '0 0 10 10');
    marker.setAttribute('refX', '9');
    marker.setAttribute('refY', '5');
    marker.setAttribute('markerWidth', '6');
    marker.setAttribute('markerHeight', '6');
    marker.setAttribute('orient', 'auto-start-reverse');
    const mp = document.createElementNS(SVG_NS, 'path');
    mp.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
    mp.setAttribute('fill', 'context-stroke');
    marker.appendChild(mp);
    defs.appendChild(marker);
    svgEl.appendChild(defs);
  }

  for (const e of state.edges) {
    const grp = buildEdgeElement(e, { forExport: true });
    if (grp) svgEl.appendChild(grp);
  }
  for (const n of state.nodes) {
    svgEl.appendChild(buildNodeElement(n, { forExport: true }));
  }

  return { svgEl, w, h };
}

function exportSvg() {
  commitEditingIfAny();
  const { svgEl } = buildExportSvg();
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(svgEl);
  const blob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' });
  downloadBlob(blob, `${activeTab}.svg`);
}

function exportPng() {
  commitEditingIfAny();
  const { svgEl, w, h } = buildExportSvg();
  const xml = new XMLSerializer().serializeToString(svgEl);
  const svg64 = btoa(unescape(encodeURIComponent(xml)));
  const dataUrl = 'data:image/svg+xml;base64,' + svg64;
  const img = new Image();
  img.onload = () => {
    const scale = 2;
    const canvas2 = document.createElement('canvas');
    canvas2.width = Math.max(1, Math.round(w * scale));
    canvas2.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas2.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas2.width, canvas2.height);
    ctx.drawImage(img, 0, 0, canvas2.width, canvas2.height);
    canvas2.toBlob((b) => { if (b) downloadBlob(b, `${activeTab}.png`); }, 'image/png');
  };
  img.onerror = () => alert('PNG export failed: could not render SVG.');
  img.src = dataUrl;
}

function autoArrange() {
  if (state.nodes.length === 0) return;
  const prev = snapshot();
  const childrenOf = new Map();
  const parentOf = new Map();
  for (const n of state.nodes) childrenOf.set(n.id, []);
  for (const e of state.edges) {
    if (childrenOf.has(e.from)) childrenOf.get(e.from).push(e.to);
    parentOf.set(e.to, e.from);
  }
  const roots = state.nodes.filter(n => !parentOf.has(n.id));
  const NODE_GAP = 24;
  const LEVEL_GAP = 50;
  const TOP_Y = 40;
  let cursorX = 40;

  const visited = new Set();
  function layoutSubtree(nodeId, level) {
    if (visited.has(nodeId)) return { left: cursorX, right: cursorX };
    visited.add(nodeId);
    const node = findNode(nodeId);
    if (!node) return { left: cursorX, right: cursorX };
    const kids = (childrenOf.get(nodeId) || []).filter(k => !visited.has(k));
    if (kids.length === 0) {
      node.x = cursorX;
      node.y = TOP_Y + level * (node.h + LEVEL_GAP);
      const left = node.x;
      const right = node.x + node.w;
      cursorX = right + NODE_GAP;
      return { left, right };
    }
    const childRanges = [];
    for (const c of kids) childRanges.push(layoutSubtree(c, level + 1));
    const childLeft = childRanges[0].left;
    const childRight = childRanges[childRanges.length - 1].right;
    const childCenter = (childLeft + childRight) / 2;
    node.x = childCenter - node.w / 2;
    node.y = TOP_Y + level * (node.h + LEVEL_GAP);
    return { left: Math.min(node.x, childLeft), right: Math.max(node.x + node.w, childRight) };
  }
  for (const r of roots) {
    layoutSubtree(r.id, 0);
    cursorX += NODE_GAP * 2;
  }
  const orphans = state.nodes.filter(n => !visited.has(n.id));
  if (orphans.length > 0) {
    let ox = 40;
    const oy = TOP_Y + 4 * 100;
    for (const n of orphans) {
      n.x = ox;
      n.y = oy;
      ox += n.w + NODE_GAP;
    }
  }
  state.view = { tx: 0, ty: 0, scale: 1 };
  pushUndo(prev);
  render();
  saveSoon();
}

// --- Inspector ---

function buildSwatchPalette(container, prop) {
  container.innerHTML = '';
  const colors = (prop === 'fill') ? FILL_COLORS : STROKE_COLORS;
  for (const c of colors) {
    const sw = document.createElement('button');
    sw.className = 'swatch';
    sw.dataset.color = c;
    sw.style.backgroundColor = c;
    sw.title = c;
    sw.addEventListener('click', () => applyStyle(prop, c));
    container.appendChild(sw);
  }
  const custom = document.createElement('input');
  custom.type = 'color';
  custom.title = 'Custom color';
  custom.addEventListener('input', () => applyStyle(prop, custom.value));
  container.appendChild(custom);
}

function applyStyle(prop, value) {
  if (!state.selected) return;
  const prev = snapshot();
  if (state.selected.kind === 'node') {
    const n = findNode(state.selected.id);
    if (!n) return;
    n[prop] = value;
  } else if (state.selected.kind === 'edge') {
    const e = findEdge(state.selected.id);
    if (!e) return;
    e[prop] = value;
  }
  pushUndo(prev);
  render();
  saveSoon();
}

function applyEdgeStyle(style) {
  if (!state.selected || state.selected.kind !== 'edge') return;
  const e = findEdge(state.selected.id);
  if (!e) return;
  const prev = snapshot();
  e.style = style;
  pushUndo(prev);
  render();
  saveSoon();
}

function applyEdgeRouting(routing) {
  if (!state.selected || state.selected.kind !== 'edge') return;
  const e = findEdge(state.selected.id);
  if (!e) return;
  const prev = snapshot();
  e.routing = routing;
  // Reset bend params when changing routing so the new line starts in a sensible place
  if (routing === 'curve') e.curveOffset = 40;
  if (routing === 'orthogonal') e.elbowFraction = 0.5;
  pushUndo(prev);
  render();
  saveSoon();
}

function applyNodeSize(w, h) {
  if (!state.selected || state.selected.kind !== 'node') return;
  const n = findNode(state.selected.id);
  if (!n) return;
  const newW = Math.max(40, Math.round(w));
  const newH = Math.max(20, Math.round(h));
  if (newW === n.w && newH === n.h) return;
  const prev = snapshot();
  n.w = newW;
  n.h = newH;
  pushUndo(prev);
  render();
  saveSoon();
}

function updateInspector() {
  const sel = state.selected;
  if (!sel) {
    inspectorEmpty.classList.remove('hidden');
    inspectorNode.classList.add('hidden');
    inspectorEdge.classList.add('hidden');
    return;
  }
  inspectorEmpty.classList.add('hidden');
  if (sel.kind === 'node') {
    const n = findNode(sel.id);
    if (!n) return;
    inspectorNode.classList.remove('hidden');
    inspectorEdge.classList.add('hidden');
    for (const sw of inspectorNode.querySelectorAll('[data-prop="fill"] .swatch')) {
      sw.classList.toggle('active', sw.dataset.color.toLowerCase() === nodeFill(n).toLowerCase());
    }
    for (const sw of inspectorNode.querySelectorAll('[data-prop="stroke"] .swatch')) {
      sw.classList.toggle('active', sw.dataset.color.toLowerCase() === nodeStroke(n).toLowerCase());
    }
    propW.value = n.w;
    propH.value = n.h;
  } else if (sel.kind === 'edge') {
    const e = findEdge(sel.id);
    if (!e) return;
    inspectorEdge.classList.remove('hidden');
    inspectorNode.classList.add('hidden');
    for (const sw of inspectorEdge.querySelectorAll('[data-prop="stroke"] .swatch')) {
      sw.classList.toggle('active', sw.dataset.color.toLowerCase() === edgeStroke(e).toLowerCase());
    }
    for (const btn of inspectorEdge.querySelectorAll('#line-style-buttons button')) {
      btn.classList.toggle('active', btn.dataset.style === edgeStyle(e));
    }
    for (const btn of inspectorEdge.querySelectorAll('#line-routing-buttons button')) {
      btn.classList.toggle('active', btn.dataset.routing === edgeRouting(e));
    }
  }
}

for (const p of inspectorNode.querySelectorAll('.palette')) buildSwatchPalette(p, p.dataset.prop);
for (const p of inspectorEdge.querySelectorAll('.palette')) buildSwatchPalette(p, p.dataset.prop);

function commitSize() {
  const w = parseFloat(propW.value);
  const h = parseFloat(propH.value);
  if (Number.isFinite(w) && Number.isFinite(h)) applyNodeSize(w, h);
}
propW.addEventListener('change', commitSize);
propH.addEventListener('change', commitSize);
propW.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commitSize(); propW.blur(); } e.stopPropagation(); });
propH.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commitSize(); propH.blur(); } e.stopPropagation(); });

for (const btn of document.querySelectorAll('#line-style-buttons button')) {
  btn.addEventListener('click', () => applyEdgeStyle(btn.dataset.style));
}
for (const btn of document.querySelectorAll('#line-routing-buttons button')) {
  btn.addEventListener('click', () => applyEdgeRouting(btn.dataset.routing));
}

// --- Toggle panels ---

function applyHelpVisibility() {
  helpEl.classList.toggle('hidden-help', helpHidden);
  btnToggleHelp.classList.toggle('toggled', !helpHidden);
}
function applyInspectorVisibility() {
  inspectorEl.classList.toggle('collapsed', inspectorHidden);
  btnToggleInspector.classList.toggle('toggled', !inspectorHidden);
}
btnToggleHelp.addEventListener('click', () => {
  helpHidden = !helpHidden;
  applyHelpVisibility();
  saveSoon();
});
btnToggleInspector.addEventListener('click', () => {
  inspectorHidden = !inspectorHidden;
  applyInspectorVisibility();
  saveSoon();
});

// --- Tabs ---

function updateTabUI() {
  for (const btn of document.querySelectorAll('#tabs button')) {
    btn.classList.toggle('active', btn.dataset.tab === activeTab);
  }
  for (const btn of document.querySelectorAll('#toolbar [data-show-on]')) {
    btn.classList.toggle('hidden', btn.dataset.showOn !== activeTab);
  }
}
function switchTab(name) {
  if (name === activeTab) return;
  if (!tabs[name]) return;
  commitEditingIfAny();
  removeRubberBand();
  setArmedTool(null);
  activeTab = name;
  state = tabs[name].state;
  history = tabs[name].history;
  state.selected = null;
  state.dragging = null;
  state.editing = null;
  updateTabUI();
  render();
  saveSoon();
}

// --- Wiring ---

for (const btn of document.querySelectorAll('#tabs button')) {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
}
for (const btn of document.querySelectorAll('#toolbar button[data-tool]')) {
  btn.addEventListener('click', () => {
    setArmedTool(state.armedTool === btn.dataset.tool ? null : btn.dataset.tool);
  });
}
btnUndo.addEventListener('click', undo);
btnRedo.addEventListener('click', redo);
btnAutoArrange.addEventListener('click', autoArrange);
document.getElementById('btn-export-png').addEventListener('click', exportPng);
document.getElementById('btn-export-svg').addEventListener('click', exportSvg);
document.getElementById('btn-clear').addEventListener('click', clearAll);
zoomIndicator.addEventListener('click', () => {
  state.view = { tx: 0, ty: 0, scale: 1 };
  updateView();
  saveSoon();
});

canvas.addEventListener('mousedown', (e) => {
  if (state.editing) {
    if (e.target.closest && e.target.closest('foreignObject')) return;
    commitEditingIfAny();
    return;
  }
  const pt = clientToSvg(e);
  if (e.button === 1 || (e.button === 0 && spaceDown)) {
    e.preventDefault();
    startPan(e);
    return;
  }
  if (e.button !== 0) return;
  if (e.target.classList && e.target.classList.contains('resize-handle')) {
    e.stopPropagation();
    const side = e.target.getAttribute('data-resize-side');
    const nodeId = e.target.getAttribute('data-node-id');
    startResize(side, nodeId, pt);
    return;
  }
  if (e.target.classList && e.target.classList.contains('edge-handle')) {
    e.stopPropagation();
    const edgeId = e.target.getAttribute('data-edge-id');
    selectEdge(edgeId);
    startEdgeHandle(edgeId, pt);
    return;
  }
  if (e.target.classList && e.target.classList.contains('connector-dot')) {
    e.stopPropagation();
    const fromId = e.target.getAttribute('data-node-id');
    startConnect(fromId, pt);
    return;
  }
  const nodeEl = e.target.closest && e.target.closest('.node');
  if (nodeEl) {
    const id = nodeEl.getAttribute('data-id');
    selectNode(id);
    startDragNode(id, pt);
    return;
  }
  if (e.target.classList && (e.target.classList.contains('edge-path') || e.target.classList.contains('edge-hit'))) {
    const id = e.target.getAttribute('data-id');
    selectEdge(id);
    return;
  }
  if (state.armedTool) {
    placeShape(state.armedTool, pt);
    setArmedTool(null);
  } else {
    deselect();
  }
});

window.addEventListener('mousemove', (e) => {
  if (!state.dragging) return;
  if (state.dragging.kind === 'node') {
    const n = findNode(state.dragging.id);
    if (!n) return;
    const pt = clientToSvg(e);
    n.x = pt.x - state.dragging.offsetX;
    n.y = pt.y - state.dragging.offsetY;
    state.dragging.moved = true;
    updateNodeAndIncidentEdges(n);
  } else if (state.dragging.kind === 'resize') {
    const n = findNode(state.dragging.id);
    if (!n) return;
    const pt = clientToSvg(e);
    const dx = pt.x - state.dragging.startPt.x;
    const dy = pt.y - state.dragging.startPt.y;
    const minW = 60, minH = 30;
    const side = state.dragging.side;
    let { startX, startY, startW, startH } = state.dragging;
    if (side.includes('e')) {
      n.w = Math.max(minW, Math.round(startW + dx));
    }
    if (side.includes('w')) {
      const newW = Math.max(minW, Math.round(startW - dx));
      n.x = startX + (startW - newW);
      n.w = newW;
    }
    if (side.includes('s')) {
      n.h = Math.max(minH, Math.round(startH + dy));
    }
    if (side.includes('n')) {
      const newH = Math.max(minH, Math.round(startH - dy));
      n.y = startY + (startH - newH);
      n.h = newH;
    }
    state.dragging.moved = true;
    render();
  } else if (state.dragging.kind === 'edgeHandle') {
    const ed = findEdge(state.dragging.edgeId);
    if (!ed) return;
    const pt = clientToSvg(e);
    if (state.dragging.routing === 'curve') {
      const from = findNode(ed.from);
      const to = findNode(ed.to);
      if (from && to) {
        const fc = { x: from.x + from.w/2, y: from.y + from.h/2 };
        const tc = { x: to.x + to.w/2, y: to.y + to.h/2 };
        const start = exitPoint(from, tc);
        const end = exitPoint(to, fc);
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len, ny = dx / len;
        const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
        ed.curveOffset = (pt.x - mid.x) * nx + (pt.y - mid.y) * ny;
      }
    } else if (state.dragging.routing === 'orthogonal') {
      const from = findNode(ed.from);
      const to = findNode(ed.to);
      if (from && to) {
        const { start, end, horizontal } = orthogonalEndpoints(from, to);
        let fraction;
        if (horizontal) {
          const span = end.x - start.x;
          fraction = span === 0 ? 0.5 : (pt.x - start.x) / span;
        } else {
          const span = end.y - start.y;
          fraction = span === 0 ? 0.5 : (pt.y - start.y) / span;
        }
        ed.elbowFraction = Math.max(0.05, Math.min(0.95, fraction));
      }
    }
    state.dragging.moved = true;
    updateEdgeInPlace(ed);
  } else if (state.dragging.kind === 'pan') {
    state.view.tx = state.dragging.startTx + (e.clientX - state.dragging.startX);
    state.view.ty = state.dragging.startTy + (e.clientY - state.dragging.startY);
    updateView();
  } else if (state.dragging.kind === 'connect') {
    const pt = clientToSvg(e);
    drawRubberBand(state.dragging.from, pt);
  }
});

window.addEventListener('mouseup', (e) => {
  if (!state.dragging) return;
  const drag = state.dragging;
  state.dragging = null;
  if (drag.kind === 'node') {
    if (drag.moved) {
      pushUndo(drag.prev);
      saveSoon();
    }
  } else if (drag.kind === 'resize') {
    if (drag.moved) {
      pushUndo(drag.prev);
      saveSoon();
      updateInspector();
    }
  } else if (drag.kind === 'edgeHandle') {
    if (drag.moved) {
      pushUndo(drag.prev);
      saveSoon();
    }
  } else if (drag.kind === 'connect') {
    removeRubberBand();
    let targetNodeId = null;
    const targets = (typeof document.elementsFromPoint === 'function')
      ? document.elementsFromPoint(e.clientX, e.clientY)
      : [document.elementFromPoint(e.clientX, e.clientY)].filter(Boolean);
    for (const t of targets) {
      if (!t || !t.classList) continue;
      if (t.classList.contains('connector-dot')) {
        const id = t.getAttribute('data-node-id');
        if (id && id !== drag.from) { targetNodeId = id; break; }
      }
      const ng = t.closest && t.closest('.node');
      if (ng) {
        const id = ng.getAttribute('data-id');
        if (id && id !== drag.from) { targetNodeId = id; break; }
      }
    }
    if (targetNodeId) addEdge(drag.from, targetNodeId);
  } else if (drag.kind === 'pan') {
    canvas.classList.remove('panning');
    saveSoon();
  }
});

canvas.addEventListener('dblclick', (e) => {
  const nodeEl = e.target.closest && e.target.closest('.node');
  if (!nodeEl) return;
  state.dragging = null;
  startLabelEdit(nodeEl.getAttribute('data-id'));
});

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const factor = e.deltaY < 0 ? 1.1 : 1/1.1;
  const oldScale = state.view.scale;
  const newScale = Math.max(0.2, Math.min(5, oldScale * factor));
  state.view.tx = mx - ((mx - state.view.tx) / oldScale) * newScale;
  state.view.ty = my - ((my - state.view.ty) / oldScale) * newScale;
  state.view.scale = newScale;
  updateView();
  saveSoon();
}, { passive: false });

window.addEventListener('keydown', (e) => {
  if (state.editing) return;
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (e.key === ' ' && !spaceDown) {
    spaceDown = true;
    canvas.classList.add('space-down');
    e.preventDefault();
    return;
  }
  if (e.key === 'Escape') {
    setArmedTool(null);
    if (state.dragging && state.dragging.kind === 'connect') {
      removeRubberBand();
      state.dragging = null;
    }
    deselect();
    return;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (state.selected) {
      e.preventDefault();
      deleteSelected();
    }
    return;
  }
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
    e.preventDefault();
    undo();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y' || ((e.key === 'z' || e.key === 'Z') && e.shiftKey))) {
    e.preventDefault();
    redo();
    return;
  }
  if (state.selected && state.selected.kind === 'node' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    if (e.key === 'Enter' || e.key === 'F2') {
      e.preventDefault();
      startLabelEdit(state.selected.id);
      return;
    }
    if (e.key.length === 1) {
      e.preventDefault();
      startLabelEdit(state.selected.id, e.key);
      return;
    }
  }
});
window.addEventListener('keyup', (e) => {
  if (e.key === ' ') {
    spaceDown = false;
    canvas.classList.remove('space-down');
  }
});

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

loadLocal();
applyHelpVisibility();
applyInspectorVisibility();
updateTabUI();
render();
updateUndoRedoButtons();
