// functions/settings/fake-names/index.js
//
// GET  /settings/fake-names — admin CRUD for the placeholder catalog.
// POST /settings/fake-names — add a new (kind, value) row.
//
// Read by /api/fake-names → window.Pipeline.fakeNames in client-side
// wizards. Each wizard step that has a `placeholderKind` config picks
// a random value from the matching kind every time the step renders,
// so opening the same wizard twice may show different examples — the
// point is to keep the placeholder text feeling fresh and a little fun.

import { all, run } from '../../lib/db.js';
import { layout, htmlResponse, html, escape } from '../../lib/layout.js';
import { redirectWithFlash, formBody, readFlash } from '../../lib/http.js';
import { hasRole } from '../../lib/auth.js';
import { settingsSubNav } from '../../lib/settings-subnav.js';
import { uuid, now } from '../../lib/ids.js';
import { FAKE_NAME_KINDS, FAKE_NAME_KIND_LABELS } from '../../lib/fake-names.js';

const KIND_SET = new Set(FAKE_NAME_KINDS);

export async function onRequestGet(context) {
  const { env, data, request } = context;
  const user = data?.user;
  if (!user) return new Response('Sign in required', { status: 401 });
  if (!hasRole(user, 'admin')) {
    return htmlResponse(layout('Fake names',
      '<section class="card"><h1>Fake names</h1><p>Admin only.</p></section>',
      { user }), { status: 403 });
  }

  const url = new URL(request.url);
  const rows = await all(env.DB,
    `SELECT id, kind, value, created_at
       FROM fake_names
      ORDER BY kind, value`, []);

  // Group by kind for the columns view.
  const grouped = {};
  for (const k of FAKE_NAME_KINDS) grouped[k] = [];
  for (const r of rows) {
    if (!grouped[r.kind]) grouped[r.kind] = [];
    grouped[r.kind].push(r);
  }

  const body = html`
    ${settingsSubNav('fake-names', true)}

    <section class="card" style="margin-top:1rem">
      <div class="card-header">
        <h1>Fake names</h1>
      </div>
      <p class="muted" style="margin-top:0">
        Wizard placeholders pull random examples from this catalog so
        empty inputs feel friendlier than "John Doe / Acme Corp". Edits
        propagate to every page within a minute (a 60-second
        cache-control on /api/fake-names).
      </p>

      <h2 style="margin-top:1rem">Add a name</h2>
      <form method="post" action="/settings/fake-names"
            style="display:flex;gap:0.5rem;flex-wrap:wrap;align-items:end;max-width:760px">
        <label style="flex:1;min-width:8rem">
          <span style="display:block;font-size:0.85rem;color:var(--fg-muted)">Kind</span>
          <select name="kind" required style="width:100%">
            ${FAKE_NAME_KINDS.map(k => html`
              <option value="${escape(k)}">${escape(FAKE_NAME_KIND_LABELS[k] || k)}</option>
            `)}
          </select>
        </label>
        <label style="flex:3;min-width:14rem">
          <span style="display:block;font-size:0.85rem;color:var(--fg-muted)">Value</span>
          <input type="text" name="value" required maxlength="200"
                 placeholder="e.g. Bob's Burgers"
                 style="width:100%;padding:0.4rem;border:1px solid var(--border);border-radius:4px">
        </label>
        <button type="submit" class="btn btn-sm primary">Add</button>
      </form>

      <h2 style="margin-top:1.5rem">Catalog (${rows.length} rows)</h2>
      ${FAKE_NAME_KINDS.map(kind => {
        const list = grouped[kind] || [];
        return html`
          <div style="margin-top:1rem">
            <h3 style="font-size:0.9rem;font-weight:600;color:var(--fg-muted);text-transform:uppercase;letter-spacing:0.05em;margin:0 0 0.4rem">
              ${escape(FAKE_NAME_KIND_LABELS[kind] || kind)} <span class="muted" style="text-transform:none;font-weight:400">(${list.length})</span>
            </h3>
            ${list.length === 0
              ? html`<p class="muted" style="font-size:0.85rem;margin:0">— none yet —</p>`
              : html`
                <ul style="list-style:none;padding:0;margin:0;display:flex;flex-wrap:wrap;gap:0.4rem">
                  ${list.map(r => html`
                    <li style="display:inline-flex;align-items:center;gap:0.3rem;padding:0.25rem 0.5rem;background:var(--bg-alt);border:1px solid var(--border);border-radius:999px;font-size:0.85rem">
                      <span>${escape(r.value)}</span>
                      <form method="post" action="/settings/fake-names/${escape(r.id)}/delete"
                            style="display:inline;margin:0"
                            onsubmit="return confirm('Remove &quot;${escape(r.value)}&quot;?');">
                        <button type="submit" class="btn-ghost-x" style="width:20px;height:20px;font-size:0.85rem"
                                title="Remove" aria-label="Remove ${escape(r.value)}">&times;</button>
                      </form>
                    </li>
                  `)}
                </ul>
              `}
          </div>
        `;
      })}
    </section>
  `;

  return htmlResponse(layout('Fake names', body, {
    user,
    activeNav: '/settings',
    flash: readFlash(url),
    breadcrumbs: [
      { label: 'Settings', href: '/settings' },
      { label: 'Fake names' },
    ],
  }));
}

export async function onRequestPost(context) {
  const { env, data, request } = context;
  const user = data?.user;
  if (!user || !hasRole(user, 'admin')) {
    return redirectWithFlash('/settings/fake-names', 'Admin only.', 'error');
  }

  const input = await formBody(request);
  const kind  = String(input.kind  || '').trim();
  const value = String(input.value || '').trim();

  if (!KIND_SET.has(kind)) {
    return redirectWithFlash('/settings/fake-names', `Unknown kind: ${kind}`, 'error');
  }
  if (!value) {
    return redirectWithFlash('/settings/fake-names', 'Value is required.', 'error');
  }
  if (value.length > 200) {
    return redirectWithFlash('/settings/fake-names', 'Value too long (max 200).', 'error');
  }

  try {
    await run(env.DB,
      `INSERT INTO fake_names (id, kind, value, created_at, updated_at, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [uuid(), kind, value, now(), now(), user.id]);
  } catch (e) {
    if (String(e?.message || '').includes('UNIQUE')) {
      return redirectWithFlash('/settings/fake-names',
        `"${value}" already exists for this kind.`, 'warn');
    }
    return redirectWithFlash('/settings/fake-names',
      `Add failed: ${e?.message || 'unknown error'}`, 'error');
  }

  return redirectWithFlash('/settings/fake-names', `Added "${value}".`);
}
