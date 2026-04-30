# WorkflowMax (BlueRock / WFM2) — OAuth setup walkthrough

**Status:** Phase 0 of the migration plan. Read this once, register the
app, paste the credentials into `.env.local`, then run the probe script.

**Last updated:** 2026-04-30 (post-spec confirmation)
**Sourced from:** the BlueRock auth article (`support.workflowmax.com/.../API-authentication`)
plus the OAS 3.0 reference at `api.workflowmax2.com`. Most of the items
flagged ❓ in the first draft of this doc are now confirmed; the few
remaining ❓s are gaps the live portal will resolve.

## Quick reference — confirmed facts

| Thing | Value |
|---|---|
| OAuth authorize URL | `https://oauth.workflowmax.com/oauth/authorize` (no "2") |
| OAuth token URL | `https://oauth.workflowmax.com/oauth/token` (no "2") |
| API base URL | `https://api.workflowmax2.com/` (with "2") |
| Required scopes | `openid profile email workflowmax offline_access` |
| Endpoint shape | `/{resource}.api/{action}` (legacy v1 paths, JSON responses) |
| Tenant header | `account_id: <Org ID>` |
| Org ID source | inside the access-token JWT (decode it, look for the org claim) |
| Access token TTL | 30 minutes |
| Refresh token TTL | 60 days, rotates on every use |
| Rate limits | 5 concurrent · 60/min · 5000/day |

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
2. **Open the developer portal.** The BlueRock auth article links to a
   "this can be created here" page that hosts the app registration —
   the exact URL isn't quoted in the public copy I have, but the link
   is clickable from inside the article at
   `https://support.workflowmax.com/hc/en-us/articles/28754786654233-API-authentication`.
   ❓ Once you click through, paste the URL back to me so I can lock
   it into this doc.
3. **Click "Create app" / "Register application"** (wording may vary).
4. Fill in the app details:
   - **App name:** `C-LARS Pipeline Migration` (or similar — only you
     see this)
   - **Description:** `Server-to-server integration for migrating WFM
     data into our internal CRM (Pipeline). Read-only access.`
   - **Redirect URI** (required for the auth-code flow): the auth article
     says this MUST be HTTPS. For the one-shot bootstrap we'll use a
     local dev URL — try `https://localhost:8787/wfm/oauth-callback`
     first; if BlueRock rejects localhost outright, fall back to a
     temporary Cloudflare Pages route on `https://pms.c-lars.com/wfm/oauth-callback`.
     This is where BlueRock returns the authorization code after consent.
     After the bootstrap, refresh-token-only flows use no redirect, so
     the URL only matters once.
   - **Scopes:** request **all five** —
     `openid profile email workflowmax offline_access`. The
     `openid email profile` trio is required by OpenID Connect; `workflowmax`
     is the actual API scope; `offline_access` is what gives you a
     refresh token (without it, you'd have to redo the consent every
     30 minutes).
   - **PKCE:** ❓ enable if offered. The auth article doesn't mention
     PKCE either way; server-side flows tolerate either. If the
     registration form requires it, the bootstrap step below needs
     a `code_challenge` — easy to add when we know.
5. **Save.** WFM will show you:
   - **Client ID** (public, paste into `.env.local`)
   - **Client Secret** (private — paste into `.env.local`, never commit)
6. **Don't worry about the tenant / Org ID.** Per BlueRock's auth
   article, the Org ID lives inside the access-token JWT — the
   api-client decodes it on every refresh and uses it automatically
   as the `account_id` header. If you DO see one displayed in the
   developer portal, copy it into `WFM_TENANT_ID` in `.env.local`
   so the script doesn't have to extract it (saves a tiny bit of
   work, also gives a clearer error message if the JWT shape changes).

---

## 3. Capture the refresh token (one-time consent)

Refresh tokens last 60 days and roll forward on every use, so this
step happens once per developer machine.

I'll write a one-shot helper later in Phase 0 once you confirm the
exact authorize / token URLs from your portal. Until then, the
manual fallback works:

1. Open this URL in your browser, replacing `<CLIENT_ID>` and
   `<REDIRECT_URI>` with yours (both URL-encoded). Note: `oauth.workflowmax.com`
   has **no "2"**.
   ```
   https://oauth.workflowmax.com/oauth/authorize
     ?response_type=code
     &client_id=<CLIENT_ID>
     &redirect_uri=<REDIRECT_URI>
     &scope=openid%20profile%20email%20workflowmax%20offline_access
     &state=phase0-bootstrap
     &prompt=consent
   ```
2. Sign in to WFM if prompted; click **Allow** when asked to grant
   the app access. Pick the C-LARS tenant if you're in multiple orgs.
3. The browser will be redirected to
   `<REDIRECT_URI>?code=<AUTH_CODE>&state=phase0-bootstrap`.
   If nothing's listening there, you'll see a "this site can't be
   reached" page — **that's fine.** Copy the entire `code=` value
   from the URL bar (just the `code` value, not the rest).
4. Exchange the code for tokens via curl. **Send the credentials in
   the body** (per BlueRock's note: "this is different to the
   WorkflowMax by Xero API, which passes this information via headers"):
   ```bash
   curl -X POST https://oauth.workflowmax.com/oauth/token \
     -H 'content-type: application/x-www-form-urlencoded' \
     -d 'grant_type=authorization_code' \
     -d 'client_id=<CLIENT_ID>' \
     -d 'client_secret=<CLIENT_SECRET>' \
     -d 'redirect_uri=<REDIRECT_URI>' \
     -d 'code=<PASTE_THE_CODE_HERE>'
   ```
5. The response includes `access_token`, `refresh_token`, `expires_in`
   (1800 = 30 min), `token_type: Bearer`, and likely `id_token` (since
   we requested `openid`). **Save the `refresh_token`** — you'll paste
   it into `.env.local`. Decode the `access_token` at jwt.io if you
   want to eyeball the org-ID claim.

---

## 4. Populate `.env` for the importer

Create or extend `.env.local` (gitignored) at the repo root. Only the
first three are strictly required — the rest already have correct
defaults baked into `scripts/wfm/api-client.mjs`:

```
WFM_CLIENT_ID=<from-step-2>
WFM_CLIENT_SECRET=<from-step-2>
WFM_REFRESH_TOKEN=<from-step-3>

# Optional — script auto-extracts from JWT if omitted:
# WFM_TENANT_ID=<org-id-from-jwt>

# Optional overrides (defaults shown):
# WFM_OAUTH_TOKEN_URL=https://oauth.workflowmax.com/oauth/token
# WFM_API_BASE=https://api.workflowmax2.com
# WFM_TENANT_HEADER_NAME=account_id
# WFM_SCOPES=openid profile email workflowmax offline_access
```

The api-client reads these on startup. **Do not commit `.env.local`** —
the repo's `.gitignore` already covers it; double-check before pushing.

---

## 5. Verify

After you've got those values in `.env.local`, run:

```bash
node scripts/wfm/api-client.mjs --whoami
```

That round-trips the refresh token, prints the decoded JWT (so you can
sanity-check the org ID), and exits 0. If you get a 401 or a parsing
error, the most common causes are:
- The refresh token has been used already (BlueRock invalidates it
  the moment a new one is issued — the script auto-rotates and
  rewrites `.env.local`, but if you ran the curl bootstrap and then
  ran something else against the same token before this script, the
  token is dead and you have to redo the consent flow).
- The redirect URI on the auth-code request didn't match the one
  registered in the app — BlueRock returns a vague "invalid_grant" in
  that case. Re-check the redirect string is identical.
- The JWT has no recognizable org-ID claim — `--whoami` prints the
  full payload; eyeball it for any field that looks like an org/tenant
  ID, then set `WFM_TENANT_ID` explicitly in `.env.local` and rerun.

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

## 7. Open gaps remaining

Most of the original gaps closed once the BlueRock auth article + OAS
3.0 spec became available. What's left:

| Item | Status / impact |
|---|---|
| **Developer-portal URL** | Still ❓ — the auth article has a clickable "this can be created here" link but the URL isn't in the public copy. Paste the URL once you've clicked it so I can lock it in. |
| **PKCE required?** | Still ❓ — auth article doesn't mention it. The bootstrap above omits PKCE; if registration insists on it, we'll add `code_challenge` + `code_verifier` to the curl command. |
| **Pagination parameter names** | Probably `?page=N&pageSize=M` (legacy v1 convention), but the OAS 3.0 spec didn't show the parameter list in what I have. The probe sends that pair and reports what came back; we'll confirm from `docs/wfm-api-probe-results.md`. |
| **Org ID claim name in JWT** | Confirmed by docs as "Org ID" but not the exact JWT claim name. The api-client tries `org_id`/`orgId`/`organization_id`/`tenant_id`/`tid` and falls back to a fuzzy match. `--whoami` shows the full payload so we can eyeball the right field. |
| **Per-resource document-endpoint coverage** | Confirmed: documents are nested under clients (`/client.api/documents/{uuid}`) and jobs (`/job.api/documents/{job_number}`). The probe walks both. The OAS spec also lists POST upload endpoints (`/client.api/document`, `/job.api/document`) — read-only probe doesn't hit those. |

---

## 8. References

- BlueRock support — API authentication article:
  https://support.workflowmax.com/hc/en-us/articles/28754786654233-API-authentication
  (the canonical source for the auth flow — sourced everything in §1
  of this doc from here)
- BlueRock v1 OAS 3.0 reference (live, no login required):
  https://api.workflowmax2.com/ — has the full endpoint list (Client,
  Job, Quote, Lead, Staff, Custom Field, etc.) plus schema definitions.
  Hosted at the same domain as the API itself; click "Export" to grab
  the OpenAPI JSON.
- v2 API docs (some pages render client-side, login may be required):
  https://api-docs.workflowmax.com/overview
- SwaggerHub OpenAPI 3 spec (gated behind login — superseded by the
  live `api.workflowmax2.com` reference above):
  https://app.swaggerhub.com/apis-docs/WorkflowMax-BlueRock/WorkflowMax-BlueRock-OpenAPI3/0.1
- Airbyte connector source (useful for endpoint inventory):
  https://docs.airbyte.com/integrations/sources/workflowmax
- Postman collection (legacy v1 XML — useful only for the older
  endpoints):
  https://www.postman.com/warped-meadow-691749/workflowmax/collection/8zx26yu
