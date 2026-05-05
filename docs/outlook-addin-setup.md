# Outlook "Send to Claudia" add-in — setup

A ribbon button in Outlook that sends the current email's full MIME
to Claudia's drop-zone. One click → email lands in `claudia_documents`
→ Claudia categorizes it, cross-references against Pipeline, and you
can ask her about it.

Total setup: ~10 minutes. Three Cloudflare changes + one sideload in
Outlook.

## 1. Generate and set the shared secret

Pick any random string (32+ chars). On Mac/Linux:

```bash
openssl rand -hex 32
```

On Windows PowerShell:

```powershell
-join ((48..57) + (65..90) + (97..122) | Get-Random -Count 64 | % {[char]$_})
```

Copy the output. Set it as a Cloudflare Pages secret:

```bash
npx wrangler pages secret put OUTLOOK_ADDIN_SECRET --project-name=c-lars-pms
# paste the random string, hit enter
```

Then trigger a redeploy (secrets only take effect on next deploy):

```bash
git commit --allow-empty -m "deploy: pick up OUTLOOK_ADDIN_SECRET"
git push
```

## 2. Add the same secret to the add-in JS

Open `outlook-addin/commands.js`. Find the line:

```js
const SHARED_SECRET = 'REPLACE_ME_WITH_OUTLOOK_ADDIN_SECRET';
```

Replace `'REPLACE_ME_WITH_OUTLOOK_ADDIN_SECRET'` with your random
string (the same one you put in Cloudflare). Commit and push.

> **Security note:** the `commands.js` file is publicly hosted at
> `https://c-lars-pms.pages.dev/outlook-addin/commands.js`. Anyone
> who finds the URL can read the secret. The `/api/email-ingest`
> endpoint validates that the email involves one of your known
> addresses (see `WES_KNOWN_EMAILS` in `functions/api/email-ingest.js`)
> so a leaked secret can't be used to inject random unrelated emails,
> but the worst case is someone POSTs garbage emails involving your
> addresses until you rotate the secret.
>
> A v2 upgrade (using Office.js `roamingSettings` to store the secret
> per-user without baking it into JS) is on the followups list.

## 3. Bypass Cloudflare Access for the ingest endpoint

The Outlook add-in runs in a sandboxed iframe with no Cloudflare
Access cookie, so requests to `c-lars-pms.pages.dev` would normally
hit the SSO redirect. Add a bypass for one path:

1. Cloudflare dashboard → **Zero Trust** → **Access** → **Applications**
2. Find the **c-lars-pms** application (or whatever the Pipeline app
   is called). Click **Edit**.
3. Go to the **Policies** tab → **Add a policy**:
   - **Policy name:** `Email ingest bypass`
   - **Action:** **Service Auth** (or **Bypass** — see below)
   - **Configure rules:** select rule type **Path**, value
     `/api/email-ingest`. The path will need to be set in the
     application's "Path" field if your app is at the domain root;
     if it's already path-scoped, the policy applies within that
     scope.
4. Save.

   > **Bypass vs Service Auth:** "Bypass" lets the request through
   > without ANY identity check. "Service Auth" requires a service
   > token (extra header). For an MVP, **Bypass** is simpler — your
   > shared-secret check inside the Worker is the actual gate. If
   > you want belt-and-suspenders later, switch to Service Auth and
   > include the service-token headers in the Outlook add-in.

5. Test the bypass: from any browser (no SSO), hit
   `https://c-lars-pms.pages.dev/api/email-ingest` with `OPTIONS`
   method. You should get `204 No Content` (the CORS preflight),
   not a Cloudflare Access redirect HTML page.

## 4. Sideload the add-in in Outlook

Pick the path matching your Outlook:

### Outlook on the web (browser)

1. Open <https://outlook.office.com> (or your Outlook web)
2. Click any email to open it
3. In the message ribbon, click the **More actions** menu (the **...**)
4. Click **Get Add-ins**
5. In the dialog, sidebar → **My add-ins**
6. Scroll to **Custom add-ins** → **+ Add a custom add-in** → **Add from URL**
7. Paste: `https://c-lars-pms.pages.dev/outlook-addin/manifest.xml`
8. Click **OK** → **Install**

### Outlook for Windows (new Outlook)

Same flow as Outlook on the web — the new Outlook IS the web client
in a wrapper. Follow the steps above.

### Outlook for Windows (classic / old Outlook)

1. **File** → **Manage Add-ins** (opens a browser to the same dialog)
2. Follow steps 5-8 from the web flow above

### Outlook for Mac

1. Open Outlook → **Tools** → **Get Add-ins**
2. Same dialog as web → **My add-ins** → **+ Add a custom add-in** →
   **Add from URL**
3. Paste the manifest URL above

### If admin restrictions block sideloading

If you get an error about admin permissions, you may need to either:

- Ask your tenant admin to allow user-installed add-ins (Microsoft
  365 Admin Center → Settings → Org Settings → User-owned apps and
  services → "Let users access the Office Store")
- Or have the admin deploy the add-in centrally via Microsoft 365
  Admin Center → Settings → Integrated apps → Upload custom apps →
  Office Add-in → "Provide link to manifest file" → paste URL →
  assign to your account

## 5. Test it

1. Open any email in Outlook (with `wesyoakum@gmail.com` or
   `wes.yoakum@c-lars.com` somewhere in the From/To/Cc lines)
2. Look for the **Send to Claudia** button on the message ribbon
   (might be under a "Claudia" group)
3. Click it
4. A small notification should appear at the top of the email:
   - **"Sending to Claudia…"** (briefly)
   - then **"Sent to Claudia ✓ (email)"** (the category in parens)
5. Open <https://c-lars-pms.pages.dev/sandbox/assistant> — the
   email should appear in the Documents sidebar with the filename
   `<subject>.eml` and a category badge like `email` or `rfq`

If you get **"Failed: unauthorized"** — the SHARED_SECRET in
commands.js doesn't match the OUTLOOK_ADDIN_SECRET in Cloudflare.

If you get **"Failed: unknown_recipient"** — the email doesn't
involve any of your known addresses. Either it's the wrong email or
you need to add the address to `WES_KNOWN_EMAILS` in
`functions/api/email-ingest.js`.

If you get **"Failed: Mailbox API < 1.14"** — your Outlook build
predates `getAsFileAsync`. Run **File** → **Office Account** →
**Update Options** → **Update Now** and restart Outlook. Build
≥ 16.0.16xxx is required (most builds from 2023+).

If the Send button doesn't appear — sideload didn't take. Restart
Outlook (sometimes a re-launch is needed). On Outlook desktop, also
try **File** → **Office Account** → **Update Options** → **Update Now**.

## 6. Rotating the secret

If the secret leaks (or just on a schedule):

1. Generate a new random string (step 1)
2. Update `OUTLOOK_ADDIN_SECRET` via wrangler
3. Update `SHARED_SECRET` in `commands.js`
4. Commit + push
5. The next click of the button uses the new secret. Old secret stops
   working immediately for new requests; in-flight requests already
   POSTed are unaffected.

## Out of scope (today)

- **Per-user roaming token** instead of hard-coded shared secret.
  Would use `Office.context.roamingSettings` so the secret never
  appears in publicly-hosted JS.
- **Attachment-only mode.** Currently the entire MIME (incl.
  attachments) is sent. Could add a UI toggle to send subject + body
  + headers only, skipping large attachments.
- **Compose-mode integration.** Currently read-only. Could add a
  button in compose mode that lets Claudia draft a reply (would need
  ReadWriteItem permission + the chat surface).
- **Mobile Outlook.** Add-ins technically work on Outlook iOS/Android
  but UX is rough; sideloading is harder.
