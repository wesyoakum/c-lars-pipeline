# WorkflowMax (BlueRock / WFM2) — OAuth setup walkthrough

**Status:** Phase 0 of the migration plan. Read this once, register the
app, paste the credentials into `.env`, then run the probe script.

**Last updated:** 2026-04-30
**Researched against:** the BlueRock support article on API authentication,
the v2 docs at `api-docs.workflowmax.com`, the SwaggerHub spec, and the
Airbyte connector's source notes. Items I couldn't pin down via public
docs are flagged ❓ — confirm them once you're inside the portal.

---

## 1. Prerequisites

You need:
- **WFM admin access** to your C-LARS WorkflowMax tenant (so you can
  register a developer app and consent to its scopes on behalf of the
  organization). If only one person at C-LARS has admin, that person
  has to do steps 2–4 below; the rest is mine.
- The **"Authorise 3rd Party Full Access"** permission on whichever
  staff account performs the OAuth consent. (Settings → Staff → your
  user → Permissions, per BlueRock's support docs.)

---

## 2. Register the OAuth app

1. **Sign in to WFM** at `https://app.workflowmax2.com`.
2. **Find the developer portal.** BlueRock's support article (linked
   below) refers to a "developer portal" but doesn't quote the URL.
   The two likely paths:
   - **In-app**: Settings → Integrations → Developer / API (or
     similar). Look for a "Create app" or "API credentials" button.
   - **External portal**: try `https://developer.workflowmax2.com`
     (not confirmed in public docs ❓ — log in and check).
3. **Click "Create app" / "Register application"** (the exact wording
   may differ).
4. Fill in the app details:
   - **App name:** `C-LARS Pipeline Migration` (or similar — only you
     see this)
   - **Description:** `Server-to-server integration for migrating WFM
     data into our internal CRM (Pipeline). Read-only access.`
   - **Redirect URI** (required for the auth-code flow):
     `http://localhost:8787/wfm/oauth-callback`
     This is where BlueRock will send the authorization code after
     consent. We'll spin up a tiny local listener once during initial
     setup; after that, refresh-token-only flows use no redirect.
   - **Scopes:** request **`workflowmax`** + **`offline_access`**.
     `workflowmax` is the API access scope; `offline_access` is what
     gives you a refresh token (without it, you'd have to redo the
     consent every 30 minutes).
   - **PKCE:** ❓ enable if offered. If the form has no PKCE option,
     proceed without it — server-side OAuth flows tolerate either.
5. **Save.** WFM should show you:
   - **Client ID** (public, paste into `.env`)
   - **Client Secret** (private — paste into `.env`, never commit)
6. **Note your tenant / org UUID.** It's embedded in the access
   token (decodable JWT) but if WFM displays a "Tenant ID" or
   "Organization ID" in the developer portal, copy that too — saves
   us a step. ❓ The exact label varies between Xero-era pages and
   BlueRock's rebuild.

---

## 3. Capture the refresh token (one-time consent)

Refresh tokens last 60 days and roll forward on every use, so this
step happens once per developer machine.

I'll write a one-shot helper later in Phase 0 once you confirm the
exact authorize / token URLs from your portal. Until then, the
manual fallback works:

1. Open this URL in your browser, replacing `<CLIENT_ID>` with yours:
   ```
   https://oauth.workflowmax2.com/oauth/authorize
     ?response_type=code
     &client_id=<CLIENT_ID>
     &redirect_uri=http://localhost:8787/wfm/oauth-callback
     &scope=workflowmax%20offline_access
     &state=phase0-bootstrap
   ```
2. Sign in to WFM if prompted; click **Allow** when asked to grant
   the app access. Pick the C-LARS tenant if you're in multiple orgs.
3. The browser will be redirected to
   `http://localhost:8787/wfm/oauth-callback?code=<AUTH_CODE>&state=phase0-bootstrap`.
   Nothing's listening there yet, so you'll see a "this site can't be
   reached" page — **that's fine.** Copy the entire `code=` value
   from the URL bar.
4. Exchange the code for tokens via curl:
   ```bash
   curl -X POST https://oauth.workflowmax2.com/oauth/token \
     -H 'content-type: application/x-www-form-urlencoded' \
     -d 'grant_type=authorization_code' \
     -d 'client_id=<CLIENT_ID>' \
     -d 'client_secret=<CLIENT_SECRET>' \
     -d 'redirect_uri=http://localhost:8787/wfm/oauth-callback' \
     -d 'code=<PASTE_THE_CODE_HERE>'
   ```
5. The response includes `access_token`, `refresh_token`, `expires_in`
   (typically 1800 = 30 min), and possibly `id_token`. **Save the
   `refresh_token`.**

---

## 4. Populate `.env` for the importer

Create or extend `.env.local` (gitignored) at the repo root:

```
WFM_CLIENT_ID=<from-step-2>
WFM_CLIENT_SECRET=<from-step-2>
WFM_REFRESH_TOKEN=<from-step-3>
WFM_TENANT_ID=<from-step-2-or-decode-jwt>
WFM_OAUTH_TOKEN_URL=https://oauth.workflowmax2.com/oauth/token
WFM_API_BASE=https://api.workflowmax2.com
```

The api-client reads these on startup. **Do not commit `.env.local`** —
the repo's `.gitignore` already covers it; double-check before pushing.

---

## 5. Verify

After you've got those four values in `.env.local`, run:

```bash
node scripts/wfm/api-client.mjs --whoami
```

That round-trips the refresh token, prints the decoded JWT (so you can
sanity-check the tenant), and exits 0. If you get a 401 or a parsing
error, the most common causes are:
- `WFM_TENANT_ID` doesn't match what's actually in the JWT (the api
  client will print both)
- The `Authorization` / tenant header pair isn't quite right ❓ — see
  the gap callout below

---

## 6. Then: run the probe

Once `--whoami` works:

```bash
node scripts/wfm/probe.mjs
```

This hits one paginated `GET` per entity in §4 of the migration plan
(clients, contacts, leads, quotes, jobs, tasks, time, invoices, staff,
custom fields, documents) and writes a Markdown report to
`docs/wfm-api-probe-results.md`. Review the report — it's the input
to Phase 1 (schema sign-off).

---

## 7. Open gaps to confirm against the live portal

These are things public BlueRock docs didn't fully spell out. Once
you're inside the portal in step 2, please verify and ping back so I
can update this doc:

| Item | Why it matters |
|---|---|
| **Developer-portal URL** (`developer.workflowmax2.com` or in-app?) | The walkthrough above guesses both; pin the right one. |
| **Tenant header name** on `api.workflowmax2.com` (`xero-tenant-id` from the Xero era vs. `account-id` / `tenant-id` in the rebuild) | Every authenticated request needs it. The api-client tries `xero-tenant-id` first; if that 401s we'll fall through. |
| **PKCE required?** | Server-side flows work without; just confirm it's not enforced. |
| **Pagination parameter names** (`?page=N&pageSize=M` vs. cursor-based) | The api-client guesses `page` + `pageSize`; the probe will confirm or surface the right names. |
| **Document/attachment endpoint paths** | v2 docs mention nested endpoints under jobs / clients / leads / suppliers / POs but don't quote them. |

---

## 8. References

- BlueRock support — API authentication article:
  https://support.workflowmax.com/hc/en-us/articles/28754786654233-API-authentication
- v2 API docs (some pages render client-side, login may be required):
  https://api-docs.workflowmax.com/overview
- SwaggerHub OpenAPI 3 spec (gated behind login):
  https://app.swaggerhub.com/apis-docs/WorkflowMax-BlueRock/WorkflowMax-BlueRock-OpenAPI3/0.1
- Airbyte connector source (useful for endpoint inventory):
  https://docs.airbyte.com/integrations/sources/workflowmax
- Postman collection (legacy v1 XML — useful only for the older
  endpoints):
  https://www.postman.com/warped-meadow-691749/workflowmax/collection/8zx26yu
