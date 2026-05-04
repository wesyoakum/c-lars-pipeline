# Gmail OAuth setup for Claudia

One-time setup so Claudia can read your personal Gmail. Read-only —
no send, no modify, no delete. Total time: ~15 minutes.

## 1. Create a Google Cloud project

1. Go to <https://console.cloud.google.com/projectcreate>
2. Project name: `claudia-gmail` (or whatever)
3. Organization: leave blank (personal account)
4. Click **Create**

## 2. Enable the Gmail API

1. In the Cloud Console, go to **APIs & Services → Library**
2. Search for "Gmail API"
3. Click it, then **Enable**

## 3. Configure the OAuth consent screen

1. **APIs & Services → OAuth consent screen**
2. User Type: **External** (the only option for personal Google accounts)
3. App name: `Claudia (Pipeline)`
4. User support email: your Gmail address
5. Developer contact email: your Gmail address
6. **Save and Continue**
7. **Scopes** screen: click **Add or Remove Scopes**, search for:
   - `https://www.googleapis.com/auth/gmail.readonly`
   - `openid`, `email`, `profile`
   Add all four. **Update**, **Save and Continue**
8. **Test users** screen: **Add Users** → add your personal Gmail
   address (the one you want Claudia to read). **Save and Continue**
9. Leave the app in **Testing** mode (no need to publish). One catch:
   refresh tokens expire after **7 days** in Testing mode, so you'll
   need to reconnect from `/settings/claudia` once a week. Publishing
   the app removes the limit but requires Google verification, which
   is a hassle for personal use.

## 4. Create OAuth client credentials

1. **APIs & Services → Credentials**
2. **Create Credentials → OAuth client ID**
3. Application type: **Web application**
4. Name: `Pipeline (Cloudflare Pages)`
5. Authorized redirect URIs — add **both**:
   - `https://c-lars-pms.pages.dev/sandbox/assistant/gmail/callback` (production)
   - `http://localhost:8788/sandbox/assistant/gmail/callback` (local dev, optional)
6. **Create**
7. Copy the **Client ID** and **Client secret** from the dialog. Save
   them somewhere safe — the secret is only shown once (you can
   regenerate but it's annoying).

## 5. Set the secrets in Cloudflare Pages

From the project root:

```bash
npx wrangler pages secret put GMAIL_CLIENT_ID --project-name=c-lars-pms
# paste the client id, hit enter

npx wrangler pages secret put GMAIL_CLIENT_SECRET --project-name=c-lars-pms
# paste the client secret, hit enter
```

For local dev, also add to `.dev.vars`:

```
GMAIL_CLIENT_ID=<client id>
GMAIL_CLIENT_SECRET=<client secret>
```

(Don't commit `.dev.vars` — it's gitignored.)

## 6. Connect from the settings page

1. Visit `https://c-lars-pms.pages.dev/settings/claudia` (or local).
2. Find the "Gmail connection" card (between the permissions header
   and the toggle list).
3. Click **Connect Gmail**. Google's consent screen appears — sign in
   with your personal Gmail (the one you added as a test user), grant
   the gmail.readonly scope, click Allow.
4. You'll be redirected back to `/settings/claudia?gmail=connected`.
   The card now shows "Connected as <your-email>".

## 7. Test in the chat

Open `/sandbox/assistant` and ask:

- "Any unread Gmail today?"
- "Find emails from <some sender>"
- "Search my Gmail for RFQ"

Claudia uses `search_gmail` / `read_gmail_message` automatically.

## When refresh fails (every 7 days in Testing mode)

The settings card will show **"Connected, but last refresh failed."**
with the underlying error. Click **Reconnect** — it walks you through
the Google consent flow again and mints a fresh refresh token.

## Disconnecting

The settings card has a **Disconnect** button. That deletes the stored
tokens. Google's side of the connection isn't revoked automatically —
to clean up there too, visit
<https://myaccount.google.com/permissions>, find "Claudia (Pipeline)",
and remove access.

## Out of scope today

- Sending Gmail. Read-only by design.
- Outlook / Microsoft 365 email. Different OAuth flow (Microsoft
  Graph), separate setup, on hold per Wes.
- Attachment download. The tool surface lists attachment metadata
  (filename, size, mime, attachment_id) but doesn't download the
  bytes. Add later if needed.
