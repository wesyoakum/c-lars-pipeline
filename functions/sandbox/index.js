// functions/sandbox/index.js
//
// GET /sandbox
//
// Personal scratch tab for testing experimental features. Visible and
// accessible only to wes.yoakum@c-lars.com — same email allowlist used
// for the AI Inbox tab in functions/lib/layout.js.
//
// First experiment: a self-contained SVG diagrams editor (Flow Chart +
// Org Chart) embedded in an iframe at /sandbox/flowchart so its full-
// viewport CSS reset doesn't leak into the PMS shell.

import { layout, html, htmlResponse, subnavTabs } from '../lib/layout.js';

const SANDBOX_OWNER = 'wes.yoakum@c-lars.com';

export async function onRequestGet(context) {
  const user = context.data?.user;
  if (!user || user.email !== SANDBOX_OWNER) {
    return new Response('Not found', { status: 404 });
  }

  const tabs = subnavTabs(
    [{ href: '/sandbox', label: 'Flow Chart' }],
    '/sandbox'
  );

  const body = html`
    <style>
      .sandbox-frame-wrap {
        margin: 0 auto;
        max-width: 1600px;
        padding: 0 1rem 1rem;
      }
      .sandbox-frame {
        width: 100%;
        height: calc(100vh - 200px);
        min-height: 480px;
        border: 1px solid #d0d0d5;
        border-radius: 8px;
        background: #f5f5f7;
        display: block;
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
