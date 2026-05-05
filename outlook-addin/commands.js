// outlook-addin/commands.js
//
// "Send to Claudia" function command for the Outlook ribbon button.
// When the user clicks the button:
//   1. Read the current message as a Base64-encoded EML via
//      getAsFileAsync (Mailbox 1.14+, ReadItem).
//   2. POST it to /api/email-ingest with the shared bearer token below.
//   3. Show a transient notification on the message ("Sent to Claudia
//      ✓" / "Failed: <reason>"). Dismisses itself after a few seconds.
//
// Auth: hard-coded shared secret. This file is publicly hosted at
// https://c-lars-pms.pages.dev/outlook-addin/commands.js so anyone
// who knows the URL can read the secret. For an MVP that's fine —
// the worst case is someone POSTs garbage to /api/email-ingest until
// Wes rotates OUTLOOK_ADDIN_SECRET. The endpoint also validates
// that the email involves one of Wes's known addresses (see
// WES_KNOWN_EMAILS in functions/api/email-ingest.js) so a leaked
// secret can't be used to inject arbitrary unrelated emails.
//
// To rotate: update OUTLOOK_ADDIN_SECRET via `wrangler pages secret
// put`, then update the constant below + deploy.

// ---------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------

// Replace with the value you set via:
//   npx wrangler pages secret put OUTLOOK_ADDIN_SECRET --project-name=c-lars-pms
// The same string must appear here AND in the Cloudflare Pages
// secret. If they don't match, every send fails 401.
const SHARED_SECRET = 'kBxSrFOLg62uhlU5py3EfRcoY4izJwT809Ite7NWajsvKnHXPmZGAVdbC1DqMQ';

const INGEST_ENDPOINT = 'https://c-lars-pms.pages.dev/api/email-ingest';

// ---------------------------------------------------------------
// Function command — invoked from the ribbon button.
// Office.js wires this up by name (matches FunctionName in manifest).
// ---------------------------------------------------------------

Office.onReady(() => {
  // No-op on load; the function command is registered automatically
  // via the manifest's <Action xsi:type="ExecuteFunction"> entry.
});

async function sendToClaudia(event) {
  try {
    const item = Office.context.mailbox.item;
    if (!item) {
      await showNotification('No message selected.', 'errorMessage');
      event.completed();
      return;
    }
    const subject = item.subject || '(no subject)';

    await showNotification('Sending to Claudia…', 'progressIndicator');

    // 1. Get the raw MIME bytes of this message as a base64 EML.
    const mimeContent = await getAsFileAsync(item);

    // 2. POST to the ingest endpoint.
    const safeFilename = (subject.replace(/[^\w\s.-]+/g, '_').slice(0, 80) || 'email') + '.eml';
    const res = await fetch(INGEST_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + SHARED_SECRET,
      },
      body: JSON.stringify({
        mime_base64: mimeContent,
        filename: safeFilename,
      }),
    });

    if (!res.ok) {
      let detail = '';
      try {
        const j = await res.json();
        detail = j?.error || j?.message || ('http ' + res.status);
      } catch (_) {
        detail = 'http ' + res.status;
      }
      await showNotification('Failed: ' + detail, 'errorMessage');
      event.completed();
      return;
    }

    let body;
    try { body = await res.json(); } catch { body = {}; }
    const cat = body?.category ? ' (' + body.category + ')' : '';
    await showNotification('Sent to Claudia ' + cat + ' ✓', 'informationalMessage');
  } catch (err) {
    console.error('[send-to-claudia] failed:', err);
    await showNotification('Failed: ' + (err?.message || String(err)), 'errorMessage');
  } finally {
    // Always call completed() so Outlook knows the function command
    // has finished. Without this the ribbon button stays in a
    // "loading" state.
    event.completed();
  }
}

// Office.js exposes the function command on the global window so the
// manifest's FunctionName="sendToClaudia" can resolve it.
window.sendToClaudia = sendToClaudia;

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

function getAsFileAsync(item) {
  return new Promise((resolve, reject) => {
    if (typeof item.getAsFileAsync !== 'function') {
      reject(new Error('Mailbox API < 1.14 — getAsFileAsync unavailable. Update Outlook.'));
      return;
    }
    item.getAsFileAsync((result) => {
      if (result.status !== Office.AsyncResultStatus.Succeeded) {
        reject(new Error('getAsFileAsync failed: ' + (result.error?.message || result.status)));
        return;
      }
      resolve(result.value); // base64-encoded EML
    });
  });
}

function showNotification(message, type) {
  // type: 'informationalMessage' | 'errorMessage' | 'progressIndicator'
  return new Promise((resolve) => {
    const item = Office.context.mailbox.item;
    if (!item || !item.notificationMessages) {
      // No place to render — swallow.
      resolve();
      return;
    }
    const NOTIF_KEY = 'claudia-send-status';
    const message64 = String(message).slice(0, 150); // Outlook caps notif text
    const opts = {
      type,
      message: message64,
    };
    if (type === 'informationalMessage') {
      opts.icon = 'Icon.16';
      opts.persistent = false; // dismiss with the message
    }
    item.notificationMessages.replaceAsync(NOTIF_KEY, opts, () => resolve());
  });
}
