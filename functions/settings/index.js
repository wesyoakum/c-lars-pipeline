// functions/settings/index.js
//
// GET /settings — per-user preference page. Currently one toggle:
//   - Show discounts — controls whether the T3.2 discount UI is
//     rendered on quote pages (header discount row, per-line editor)
//     and on price-build pricing tabs. When off, the UI disappears
//     but any stored discount data is preserved and still applied to
//     totals / PDF generation.
//
// Reached via the gear icon in the site header. Not part of the top
// nav (no activeNav highlight).

import { layout, htmlResponse, html, raw, escape } from '../lib/layout.js';
import { readFlash } from '../lib/http.js';

export async function onRequestGet(context) {
  const { data, request } = context;
  const user = data?.user;
  const url = new URL(request.url);

  if (!user || !user.id) {
    return htmlResponse(
      layout('Settings', '<section class="card"><p>Not signed in.</p></section>', { user })
    );
  }

  const showDiscounts = user.show_discounts === 1 || user.show_discounts === true;

  const body = html`
    <section class="card">
      <div class="card-header">
        <h1>Settings</h1>
      </div>
      <p class="muted">
        Preferences here apply only to your account
        (<strong>${escape(user.display_name || user.email)}</strong>).
        Changes save automatically and take effect on your next page load.
      </p>

      <div class="settings-list">

        <div class="setting-row" x-data="settingToggle('show_discounts', ${showDiscounts ? 'true' : 'false'})">
          <div class="setting-label">
            <div class="setting-title">Show discount fields</div>
            <div class="setting-desc">
              Show the discount editor on quotes (header-level and
              per-line) and on price-build pricing tabs. Turn off to
              hide the fields if you don't use discounts — any stored
              discount data is preserved and still applied to totals
              and generated PDFs.
            </div>
          </div>
          <label class="toggle-switch" :class="{ 'toggle-switch--on': value }">
            <input type="checkbox" :checked="value" @change="save($event.target.checked)">
            <span class="toggle-slider"></span>
          </label>
        </div>

      </div>
    </section>

    <script>
    document.addEventListener('alpine:init', function() {
      Alpine.data('settingToggle', function(field, initial) {
        return {
          value: !!initial,
          saving: false,
          async save(next) {
            const prev = this.value;
            this.value = !!next;
            this.saving = true;
            try {
              const res = await fetch('/settings/patch', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ field: field, value: !!next ? 1 : 0 }),
              });
              const json = await res.json().catch(function() { return { ok: false }; });
              if (!json.ok) {
                // Revert on error
                this.value = prev;
                alert('Save failed: ' + (json.error || 'unknown error'));
              } else {
                // Reload so hidden/shown UI updates across the app.
                // Keep this tab on /settings.
                window.location.reload();
              }
            } catch (e) {
              this.value = prev;
              alert('Save failed: ' + e.message);
            } finally {
              this.saving = false;
            }
          },
        };
      });
    });
    </script>
  `;

  return htmlResponse(
    layout('Settings', body, {
      user,
      env: data?.env,
      flash: readFlash(url),
      breadcrumbs: [
        { label: 'PMS', href: '/' },
        { label: 'Settings' },
      ],
    })
  );
}
