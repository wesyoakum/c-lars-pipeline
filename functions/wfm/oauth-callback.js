// functions/wfm/oauth-callback.js
//
// GET /wfm/oauth-callback
//
// One-shot landing page for the BlueRock WorkflowMax OAuth bootstrap.
// The developer-portal app is registered with this URL as its
// redirect URI; after the user grants consent, BlueRock sends the
// browser here with a `?code=…&state=…` query string.
//
// Nothing on the server side has to do anything with the code — the
// refresh token is captured offline via curl from the dev workstation
// (see docs/wfm-api-oauth-setup.md §3). This page just makes the code
// easy to copy: it shows it in a big monospace box with a copy
// button, plus the matching curl command pre-filled with the
// redirect URI.
//
// Once Phase 1 of the migration is done and we have a stable refresh
// token in `.env.local`, this route can stay (harmless idle) or be
// removed; the bootstrap is one-time per developer machine.
//
// Cloudflare Access is in front of the Pages deployment, so the user
// will already be signed in when BlueRock redirects here — no extra
// auth step.

import { layout, htmlResponse, html, escape } from '../lib/layout.js';

export async function onRequestGet(context) {
  const { data, request } = context;
  const user = data?.user;
  const url = new URL(request.url);
  const code = url.searchParams.get('code') || '';
  const state = url.searchParams.get('state') || '';
  const error = url.searchParams.get('error') || '';
  const errorDesc = url.searchParams.get('error_description') || '';
  const redirectUri = `${url.origin}/wfm/oauth-callback`;

  if (error) {
    return htmlResponse(layout('WFM OAuth — error',
      html`
        <section class="card" style="margin-top:1rem;max-width:720px">
          <h1>BlueRock returned an error</h1>
          <p><code style="background:#fef0f0;padding:.15rem .4rem;border-radius:3px;color:#cf222e">${escape(error)}</code></p>
          ${errorDesc ? html`<p>${escape(errorDesc)}</p>` : ''}
          <p class="muted">Re-run the authorize URL from
            <code>docs/wfm-api-oauth-setup.md §3</code> and try again.
            Common causes: expired auth code (each is single-use),
            wrong client_id in the URL, or a redirect_uri mismatch with
            what's registered on the app.</p>
        </section>
      `,
      { user }
    ));
  }

  if (!code) {
    return htmlResponse(layout('WFM OAuth — waiting',
      html`
        <section class="card" style="margin-top:1rem;max-width:720px">
          <h1>WFM OAuth callback</h1>
          <p>This page expects a <code>?code=…</code> query string from
            BlueRock's OAuth server. None was provided.</p>
          <p class="muted">Open the authorize URL from
            <code>docs/wfm-api-oauth-setup.md §3</code> in a new tab.
            BlueRock will redirect you back here with the code attached.</p>
          <p class="muted">Redirect URI in use:
            <code>${escape(redirectUri)}</code> — this is what should be
            registered on the BlueRock app.</p>
        </section>
      `,
      { user }
    ));
  }

  // Pre-baked Node command — reads WFM_CLIENT_ID / WFM_CLIENT_SECRET
  // out of .env.local automatically, exchanges the code, and writes
  // the refresh token back to .env.local. Much simpler than curl on
  // Windows where shell-variable expansion in PowerShell vs cmd.exe
  // would otherwise be a footgun.
  const nodeCmd = `node scripts/wfm/api-client.mjs --bootstrap-token ${code}`;

  // curl command kept as a fallback for anyone not on a machine with
  // a checked-out repo (or who'd rather inspect the raw HTTP response).
  const curlCmd = [
    `curl -X POST https://oauth.workflowmax.com/oauth/token \\`,
    `  -H 'content-type: application/x-www-form-urlencoded' \\`,
    `  -d 'grant_type=authorization_code' \\`,
    `  -d "client_id=$WFM_CLIENT_ID" \\`,
    `  -d "client_secret=$WFM_CLIENT_SECRET" \\`,
    `  -d 'redirect_uri=${redirectUri}' \\`,
    `  -d 'code=${code}'`,
  ].join('\n');

  const body = html`
    <section class="card" style="margin-top:1rem;max-width:760px">
      <h1>WFM OAuth — got the code</h1>
      <p>BlueRock returned an authorization code. Use it within the
        next few minutes (each code is short-lived and single-use) to
        exchange for a refresh token.</p>

      ${state ? html`<p class="muted" style="font-size:.85rem">state: <code>${escape(state)}</code></p>` : ''}

      <h2 style="margin-top:1.4rem">1. Code</h2>
      <p class="muted" style="margin-top:0;font-size:.85rem">Copy this
        if you want to inspect it; the recommended command below
        already has it baked in.</p>
      <div style="display:flex;gap:.5rem;align-items:flex-start">
        <input id="code-box" type="text" readonly
               value="${escape(code)}"
               style="flex:1;font-family:ui-monospace,monospace;font-size:.9rem;padding:.4rem .5rem;border:1px solid var(--border);border-radius:4px">
        <button type="button" class="btn" onclick="copyCode()">Copy code</button>
      </div>

      <h2 style="margin-top:1.4rem">2. Run the bootstrap (recommended)</h2>
      <p class="muted" style="margin-top:0;font-size:.85rem">From a
        terminal at the repo root (PowerShell on Windows, bash on
        macOS/Linux). Reads <code>WFM_CLIENT_ID</code> and
        <code>WFM_CLIENT_SECRET</code> from <code>.env.local</code>,
        exchanges the code for tokens, and writes
        <code>WFM_REFRESH_TOKEN</code> back to <code>.env.local</code>
        automatically.</p>
      <pre style="background:#0d1117;color:#c9d1d9;padding:.75rem .9rem;border-radius:4px;overflow-x:auto;font-size:.82rem;line-height:1.5"><code id="node-box">${escape(nodeCmd)}</code></pre>
      <button type="button" class="btn" onclick="copyNode()" style="margin-top:.4rem">Copy Node command</button>

      <h2 style="margin-top:1.4rem">3. Verify</h2>
      <p>Once the bootstrap prints <strong>✅ Refresh token saved</strong>:</p>
      <pre style="background:#0d1117;color:#c9d1d9;padding:.75rem .9rem;border-radius:4px;font-size:.82rem;line-height:1.5"><code>node scripts/wfm/api-client.mjs --whoami
node scripts/wfm/probe.mjs</code></pre>

      <details style="margin-top:1.4rem">
        <summary style="cursor:pointer;font-weight:600">Fallback: raw curl (if you can't run Node here)</summary>
        <p class="muted" style="margin-top:.6rem;font-size:.85rem">Set
          <code>$WFM_CLIENT_ID</code> and <code>$WFM_CLIENT_SECRET</code>
          first (e.g. <code>$env:WFM_CLIENT_ID = "…"</code> in
          PowerShell), then:</p>
        <pre style="background:#0d1117;color:#c9d1d9;padding:.75rem .9rem;border-radius:4px;overflow-x:auto;font-size:.82rem;line-height:1.5"><code id="curl-box">${escape(curlCmd)}</code></pre>
        <button type="button" class="btn" onclick="copyCurl()" style="margin-top:.4rem">Copy curl command</button>
      </details>
    </section>

    <script>
    function copyCode() {
      var el = document.getElementById('code-box');
      el.select();
      el.setSelectionRange(0, el.value.length);
      navigator.clipboard.writeText(el.value);
    }
    function copyNode() {
      navigator.clipboard.writeText(document.getElementById('node-box').innerText);
    }
    function copyCurl() {
      var el = document.getElementById('curl-box');
      if (el) navigator.clipboard.writeText(el.innerText);
    }
    </script>
  `;

  return htmlResponse(layout('WFM OAuth — got the code', body, { user }));
}
