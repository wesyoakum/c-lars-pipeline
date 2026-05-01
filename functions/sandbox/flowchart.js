// functions/sandbox/flowchart.js
//
// GET /sandbox/flowchart
//
// Returns the standalone HTML shell for the diagrams editor (Flow Chart +
// Org Chart). Loaded inside an iframe on /sandbox so the editor's CSS
// reset (html, body { overflow: hidden; height: 100% }) doesn't bleed
// into the PMS layout. Gated to wes.yoakum@c-lars.com — same email
// allowlist used for the AI Inbox nav link in functions/lib/layout.js.

const SANDBOX_OWNER = 'wes.yoakum@c-lars.com';

const SHELL = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Diagrams</title>
<link rel="stylesheet" href="/css/sandbox/flowchart.css">
</head>
<body>
<div id="tabs">
  <button data-tab="flowchart" class="active">Flow Chart</button>
  <button data-tab="orgchart">Org Chart</button>
</div>
<div id="toolbar">
  <button data-tool="rect" data-show-on="flowchart" title="Process step (rectangle)">
    <svg width="22" height="14" viewBox="0 0 24 16"><rect x="2" y="2" width="20" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>
    Process
  </button>
  <button data-tool="diamond" data-show-on="flowchart" title="Decision (diamond)">
    <svg width="22" height="14" viewBox="0 0 24 16"><polygon points="12,1 23,8 12,15 1,8" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>
    Decision
  </button>
  <button data-tool="ellipse" data-show-on="flowchart" title="Start / End (ellipse)">
    <svg width="22" height="14" viewBox="0 0 24 16"><ellipse cx="12" cy="8" rx="10" ry="6" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>
    Start / End
  </button>
  <button data-tool="parallelogram" data-show-on="flowchart" title="Input / Output (parallelogram)">
    <svg width="22" height="14" viewBox="0 0 24 16"><polygon points="6,2 22,2 18,14 2,14" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>
    Input / Output
  </button>
  <button data-tool="person" data-show-on="orgchart" title="Add person card (name + title)">
    <svg width="22" height="14" viewBox="0 0 24 16"><rect x="2" y="2" width="20" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="6" y1="7" x2="18" y2="7" stroke="currentColor" stroke-width="1.5"/><line x1="6" y1="11" x2="14" y2="11" stroke="currentColor" stroke-width="1.2" opacity="0.5"/></svg>
    Person
  </button>
  <button id="btn-auto-arrange" data-show-on="orgchart" title="Auto-arrange tree top-down">
    <svg width="16" height="14" viewBox="0 0 24 20"><rect x="9" y="1" width="6" height="4" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="1" y="14" width="6" height="4" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="9" y="14" width="6" height="4" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="17" y="14" width="6" height="4" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M12 5v4M4 14V9h16v5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>
    Auto-arrange
  </button>
  <span class="divider"></span>
  <button id="btn-undo" title="Undo (Ctrl+Z)">
    <svg width="16" height="16" viewBox="0 0 24 24"><path d="M9 14 4 9l5-5M4 9h11a5 5 0 1 1 0 10h-1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
    Undo
  </button>
  <button id="btn-redo" title="Redo (Ctrl+Y)">
    <svg width="16" height="16" viewBox="0 0 24 24"><path d="m15 14 5-5-5-5M20 9H9a5 5 0 1 0 0 10h1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
    Redo
  </button>
  <span class="divider"></span>
  <button id="btn-export-png" title="Export as PNG">
    <svg width="16" height="16" viewBox="0 0 24 24"><path d="M12 3v12m-5-5 5 5 5-5M3 19h18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
    PNG
  </button>
  <button id="btn-export-svg" title="Export as SVG">
    <svg width="16" height="16" viewBox="0 0 24 24"><path d="M12 3v12m-5-5 5 5 5-5M3 19h18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
    SVG
  </button>
  <span class="divider"></span>
  <button id="btn-clear" title="Clear all">
    <svg width="16" height="16" viewBox="0 0 24 24"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M5 6l1 14a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
    Clear
  </button>
  <span class="spacer"></span>
  <span id="zoom-indicator" title="Click to reset view">100%</span>
  <span class="divider"></span>
  <button id="btn-toggle-help" title="Show / hide shortcuts">
    <svg width="16" height="16" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M9 9.5a3 3 0 1 1 4.5 2.6c-.9.5-1.5 1-1.5 1.9v.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="12" cy="17.2" r="0.9" fill="currentColor"/></svg>
    Shortcuts
  </button>
  <button id="btn-toggle-inspector" title="Show / hide formatting panel">
    <svg width="16" height="16" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/><line x1="14" y1="4" x2="14" y2="20" stroke="currentColor" stroke-width="1.7"/><line x1="16.5" y1="9" x2="19" y2="9" stroke="currentColor" stroke-width="1.5"/><line x1="16.5" y1="12" x2="19" y2="12" stroke="currentColor" stroke-width="1.5"/><line x1="16.5" y1="15" x2="19" y2="15" stroke="currentColor" stroke-width="1.5"/></svg>
    Format
  </button>
</div>
<div id="main">
  <div id="canvas-wrap">
    <svg id="canvas" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke"/>
        </marker>
        <marker id="arrow-rubber" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#2566ff"/>
        </marker>
      </defs>
      <g id="viewport">
        <g id="edges"></g>
        <g id="nodes"></g>
        <g id="overlay"></g>
      </g>
    </svg>
    <div id="help">
      <h4>Shortcuts</h4>
      <table>
        <tr><td>Add shape</td><td>Click toolbar, then canvas (then type)</td></tr>
        <tr><td>Connect</td><td>Drag dot to another shape</td></tr>
        <tr><td>Edit label</td><td>Double-click, or select + type</td></tr>
        <tr><td>New line</td><td><kbd>Shift+Enter</kbd></td></tr>
        <tr><td>Resize shape</td><td>Drag corner handle</td></tr>
        <tr><td>Bend a line</td><td>Set routing in Format, then drag handle</td></tr>
        <tr><td>Style / color</td><td>Format panel on right</td></tr>
        <tr><td>Delete</td><td><kbd>Del</kbd> / <kbd>Backspace</kbd></td></tr>
        <tr><td>Undo / Redo</td><td><kbd>Ctrl+Z</kbd> / <kbd>Ctrl+Y</kbd></td></tr>
        <tr><td>Pan</td><td><kbd>Space</kbd> + drag, or middle-click</td></tr>
        <tr><td>Zoom</td><td>Mouse wheel</td></tr>
        <tr><td>Cancel / deselect</td><td><kbd>Esc</kbd></td></tr>
      </table>
    </div>
  </div>
  <aside id="inspector">
    <div id="inspector-empty">Click a shape or line to style it</div>
    <div id="inspector-node" class="hidden">
      <h4>Shape</h4>
      <div class="prop">
        <label>Fill</label>
        <div class="palette" data-prop="fill"></div>
      </div>
      <div class="prop">
        <label>Border</label>
        <div class="palette" data-prop="stroke"></div>
      </div>
      <div class="prop">
        <label>Size</label>
        <div class="size-row">
          <input id="prop-w" type="number" min="40" step="5"> ×
          <input id="prop-h" type="number" min="20" step="5">
        </div>
      </div>
    </div>
    <div id="inspector-edge" class="hidden">
      <h4>Line</h4>
      <div class="prop">
        <label>Color</label>
        <div class="palette" data-prop="stroke"></div>
      </div>
      <div class="prop">
        <label>Style</label>
        <div class="seg-buttons" id="line-style-buttons">
          <button data-style="solid" title="Solid"><svg width="44" height="10" viewBox="0 0 44 10"><line x1="2" y1="5" x2="42" y2="5" stroke="currentColor" stroke-width="1.5"/></svg></button>
          <button data-style="dashed" title="Dashed"><svg width="44" height="10" viewBox="0 0 44 10"><line x1="2" y1="5" x2="42" y2="5" stroke="currentColor" stroke-width="1.5" stroke-dasharray="6 3"/></svg></button>
          <button data-style="dotted" title="Dotted"><svg width="44" height="10" viewBox="0 0 44 10"><line x1="2" y1="5" x2="42" y2="5" stroke="currentColor" stroke-width="1.8" stroke-dasharray="1.5 3.5" stroke-linecap="round"/></svg></button>
        </div>
      </div>
      <div class="prop">
        <label>Routing</label>
        <div class="seg-buttons" id="line-routing-buttons">
          <button data-routing="straight" title="Straight"><svg width="44" height="20" viewBox="0 0 44 20"><line x1="3" y1="16" x2="41" y2="4" stroke="currentColor" stroke-width="1.5"/></svg></button>
          <button data-routing="curve" title="Curved"><svg width="44" height="20" viewBox="0 0 44 20"><path d="M3 16 Q 22 -4 41 4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg></button>
          <button data-routing="orthogonal" title="Right-angle"><svg width="44" height="20" viewBox="0 0 44 20"><path d="M3 16 L 22 16 L 22 4 L 41 4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg></button>
        </div>
      </div>
    </div>
  </aside>
</div>
<script src="/js/sandbox/flowchart.js" defer></script>
</body>
</html>`;

export async function onRequestGet(context) {
  const user = context.data?.user;
  if (!user || user.email !== SANDBOX_OWNER) {
    return new Response('Not found', { status: 404 });
  }
  return new Response(SHELL, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}
