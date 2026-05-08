// functions/sandbox/flow-chart.js
//
// GET /sandbox/flow-chart
//
// Wrapper page that embeds the standalone diagrams editor at
// /sandbox/flowchart in an iframe and adds the project shell + subnav
// tabs around it. The iframe boundary keeps the editor's full-viewport
// CSS reset from leaking into the Pipeline UI.
//
// Used to live at /sandbox/index.js until /sandbox became a redirect
// to /sandbox/assistant.
//
// Wes-only — same email gate as the rest of /sandbox/*.

import { layout, html, htmlResponse, subnavTabs } from '../lib/layout.js';

const SANDBOX_OWNER = 'wes.yoakum@c-lars.com';

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
    '/sandbox/flow-chart'
  );

  const body = html`
    <style>
      /* Break out of the global .site-main max-width cap so the
         diagrams editor uses the full viewport width. */
      main.site-main {
        max-width: none !important;
        padding-left: 0 !important;
        padding-right: 0 !important;
      }
      .sandbox-frame-wrap { padding: 0; }
      .sandbox-frame {
        width: 100%;
        height: calc(100vh - 160px);
        min-height: 480px;
        border: 0;
        background: #f5f5f7;
        display: block;
      }
      nav.subnav-tabs {
        padding-left: 16px;
        padding-right: 16px;
      }
    </style>
    ${tabs}
    <div class="sandbox-frame-wrap">
      <iframe
        class="sandbox-frame"
        src="/sandbox/flowchart"
        title="Diagrams editor"
        loading="lazy"
      ></iframe>
    </div>
  `;

  return htmlResponse(layout('Sandbox', body, { user, activeNav: '/sandbox' }));
}
