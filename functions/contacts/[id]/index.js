// functions/contacts/[id]/index.js
//
// GET  /contacts/:id — detail page with inline click-to-edit fields
// POST /contacts/:id — full update (kept for backward compat / validation)

import { one, all, stmt, batch } from '../../lib/db.js';
import { auditStmt, diff } from '../../lib/audit.js';
import { validateContact } from '../../lib/validators.js';
import { now } from '../../lib/ids.js';
import { redirectWithFlash, formBody, readFlash } from '../../lib/http.js';
import { layout, htmlResponse, html, escape, raw } from '../../lib/layout.js';

const FIELDS = [
  'account_id',
  'first_name',
  'last_name',
  'title',
  'email',
  'phone',
  'mobile',
  'is_primary',
  'notes',
];

// ---- Inline-edit helpers (same pattern as opportunities) -----------------

function inlineText(field, value, opts = {}) {
  const display = value || opts.placeholder || '—';
  const displayClass = value ? '' : 'muted';
  return html`<span class="ie" data-field="${field}" data-type="text" ${opts.inputType ? `data-input-type="${opts.inputType}"` : ''}>
    <span class="ie-display ${displayClass}">${escape(display)}</span>
  </span>`;
}

function inlineTextarea(field, value, opts = {}) {
  const display = value || opts.placeholder || '—';
  const displayClass = value ? '' : 'muted';
  return html`<span class="ie" data-field="${field}" data-type="textarea">
    <span class="ie-display ${displayClass}">${escape(display)}</span>
    <span class="ie-raw" hidden>${escape(value ?? '')}</span>
  </span>`;
}

function inlineCheckbox(field, value) {
  return html`<span class="ie" data-field="${field}" data-type="checkbox">
    <span class="ie-display">
      ${value ? raw('<span class="pill pill-success">Yes</span>') : raw('<span class="muted">No</span>')}
    </span>
  </span>`;
}

// ---- GET handler — detail page with inline editing ----------------------

export async function onRequestGet(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const url = new URL(request.url);
  const contactId = params.id;

  const contact = await one(
    env.DB,
    `SELECT c.*, a.name AS account_name
       FROM contacts c
       LEFT JOIN accounts a ON a.id = c.account_id
      WHERE c.id = ?`,
    [contactId]
  );
  if (!contact) {
    return htmlResponse(
      layout('Contact not found',
        '<section class="card"><h1>Contact not found</h1><p><a href="/accounts">Back to accounts</a></p></section>',
        { user, env: data?.env, activeNav: '/accounts' }),
      { status: 404 }
    );
  }

  const displayName =
    [contact.first_name, contact.last_name].filter(Boolean).join(' ') || '(no name)';

  // Audit trail
  const events = await all(
    env.DB,
    `SELECT ae.event_type, ae.at, ae.summary, ae.changes_json,
            u.email AS user_email, u.display_name AS user_name
       FROM audit_events ae
       LEFT JOIN users u ON u.id = ae.user_id
      WHERE ae.entity_type = 'contact' AND ae.entity_id = ?
      ORDER BY ae.at DESC LIMIT 50`,
    [contactId]
  );

  const body = html`
    <section class="card" x-data="contactInline('${escape(contact.id)}')">
      <div class="card-header">
        <div>
          <h1 class="page-title">
            ${inlineText('first_name', contact.first_name, { placeholder: '(first)' })}
            ${inlineText('last_name', contact.last_name, { placeholder: '(last)' })}
          </h1>
          <p class="muted" style="margin:0.15rem 0 0">
            <a href="/accounts/${escape(contact.account_id)}">${escape(contact.account_name ?? '—')}</a>
            ${contact.is_primary ? raw(' &middot; <span class="pill pill-success">Primary</span>') : ''}
          </p>
        </div>
        <div class="header-actions">
          <a class="btn" href="/accounts/${escape(contact.account_id)}">Back to account</a>
          <form method="post" action="/contacts/${escape(contact.id)}/delete"
                onsubmit="return confirm('Delete contact ${escape(displayName)}?');"
                style="display:inline">
            <button type="submit" class="btn danger">Delete</button>
          </form>
        </div>
      </div>

      <div class="detail-grid">
        <div class="detail-pair">
          <span class="detail-label">Title</span>
          <span class="detail-value">${inlineText('title', contact.title, { placeholder: '—' })}</span>
        </div>
        <div class="detail-pair">
          <span class="detail-label">Email</span>
          <span class="detail-value">${inlineText('email', contact.email, { placeholder: '—', inputType: 'email' })}</span>
        </div>
        <div class="detail-pair">
          <span class="detail-label">Phone</span>
          <span class="detail-value">${inlineText('phone', contact.phone, { placeholder: '—', inputType: 'tel' })}</span>
        </div>
        <div class="detail-pair">
          <span class="detail-label">Mobile</span>
          <span class="detail-value">${inlineText('mobile', contact.mobile, { placeholder: '—', inputType: 'tel' })}</span>
        </div>
        <div class="detail-pair">
          <span class="detail-label">Primary contact</span>
          <span class="detail-value">${inlineCheckbox('is_primary', contact.is_primary)}</span>
        </div>
        <div class="detail-pair">
          <span class="detail-label">Created</span>
          <span class="detail-value muted">${escape(contact.created_at ?? '—')}</span>
        </div>
      </div>

      <div style="margin-top:0.75rem">
        <span class="detail-label">Notes</span>
        <div style="margin-top:0.25rem">
          ${inlineTextarea('notes', contact.notes, { placeholder: 'Click to add notes...' })}
        </div>
      </div>
    </section>

    ${events.length > 0 ? html`
    <section class="card">
      <h2>Activity</h2>
      <ul class="activity">
        ${raw(
          events.map(e => {
            const who = escape(e.user_name ?? e.user_email ?? 'system');
            const when = escape(formatTimestamp(e.at));
            const summary = escape(e.summary ?? e.event_type);
            const changes = renderChanges(e.changes_json);
            return `<li>
              <div class="activity-head">
                <strong>${who}</strong>
                <span class="activity-type">${escape(e.event_type)}</span>
                <span class="activity-when muted">${when}</span>
              </div>
              <div>${summary}</div>
              ${changes}
            </li>`;
          }).join('')
        )}
      </ul>
    </section>
    ` : ''}

    <script>
    function contactInline(contactId) {
      const patchUrl = '/contacts/' + contactId + '/patch';
      return {
        init() {
          this.$el.querySelectorAll('.ie').forEach(el => {
            el.addEventListener('click', (e) => {
              // Don't activate when clicking links inside ie-display
              if (e.target.tagName === 'A') return;
              this.activate(el);
            });
          });
        },
        activate(el) {
          if (el.querySelector('.ie-input')) return; // already active
          const field = el.dataset.field;
          const type = el.dataset.type;
          const display = el.querySelector('.ie-display');
          const rawEl = el.querySelector('.ie-raw');
          const currentValue = rawEl ? rawEl.textContent : (display.classList.contains('muted') ? '' : display.textContent.trim());

          let input;
          if (type === 'checkbox') {
            // Toggle immediately, no input needed
            const newVal = display.querySelector('.pill-success') ? 0 : 1;
            this.saveValue(el, field, newVal);
            return;
          } else if (type === 'textarea') {
            input = document.createElement('textarea');
            input.className = 'ie-input';
            input.rows = 3;
            input.value = currentValue;
            input.addEventListener('blur', () => this.save(el, input));
            input.addEventListener('keydown', (e) => {
              if (e.key === 'Escape') { this.deactivate(el, input); }
            });
          } else {
            input = document.createElement('input');
            input.type = el.dataset.inputType || 'text';
            input.className = 'ie-input';
            input.value = currentValue;
            input.addEventListener('blur', () => this.save(el, input));
            input.addEventListener('keydown', (e) => {
              if (e.key === 'Enter') { e.preventDefault(); this.save(el, input); }
              if (e.key === 'Escape') { this.deactivate(el, input); }
            });
          }

          display.style.display = 'none';
          el.appendChild(input);
          input.focus();
          if (input.select) input.select();
        },
        async save(el, input) {
          const field = el.dataset.field;
          const value = input.value;
          this.deactivate(el, input);
          await this.saveValue(el, field, value);
        },
        async saveValue(el, field, value) {
          el.classList.add('ie-saving');
          try {
            const res = await fetch(patchUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ field, value }),
            });
            const data = await res.json();
            if (!data.ok) {
              el.classList.add('ie-error');
              setTimeout(() => el.classList.remove('ie-error'), 2000);
              return;
            }
            // Update display
            const display = el.querySelector('.ie-display');
            const rawEl = el.querySelector('.ie-raw');
            if (field === 'is_primary') {
              display.innerHTML = data.value
                ? '<span class="pill pill-success">Yes</span>'
                : '<span class="muted">No</span>';
            } else {
              display.textContent = data.value || '\u2014';
              display.classList.toggle('muted', !data.value);
            }
            if (rawEl) rawEl.textContent = data.value ?? '';

            el.classList.add('ie-saved');
            setTimeout(() => el.classList.remove('ie-saved'), 1200);
          } catch (err) {
            el.classList.add('ie-error');
            setTimeout(() => el.classList.remove('ie-error'), 2000);
          } finally {
            el.classList.remove('ie-saving');
          }
        },
        deactivate(el, input) {
          if (input && input.parentNode === el) el.removeChild(input);
          const display = el.querySelector('.ie-display');
          if (display) display.style.display = '';
        },
      };
    }
    </script>
  `;

  return htmlResponse(
    layout(displayName, body, {
      user,
      env: data?.env,
      activeNav: '/accounts',
      flash: readFlash(url),
    })
  );
}

// ---- Helpers for audit rendering ----------------------------------------

function formatTimestamp(ts) {
  if (!ts) return '';
  return ts.replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

function renderChanges(changesJson) {
  if (!changesJson) return '';
  let changes;
  try { changes = JSON.parse(changesJson); } catch { return ''; }
  const keys = Object.keys(changes);
  if (keys.length === 0) return '';
  const rows = keys.map(k => {
    const c = changes[k];
    return `<tr><td><code>${escapeHtml(k)}</code></td><td class="muted">${escapeHtml(String(c.from ?? ''))}</td><td>${escapeHtml(String(c.to ?? ''))}</td></tr>`;
  }).join('');
  return `<table class="changes"><thead><tr><th>Field</th><th>From</th><th>To</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---- POST handler — full-form update (kept for backward compat) ---------

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const contactId = params.id;

  const before = await one(
    env.DB,
    `SELECT * FROM contacts WHERE id = ?`,
    [contactId]
  );
  if (!before) {
    return htmlResponse(
      layout('Not found', '<section class="card"><h1>Contact not found</h1></section>', {
        user, env: data?.env, activeNav: '/accounts',
      }),
      { status: 404 }
    );
  }

  const input = await formBody(request);
  const { ok, value, errors } = validateContact(input);
  if (!ok) {
    // On validation failure, redirect back to the detail page
    return redirectWithFlash(
      `/contacts/${contactId}`,
      `Validation error: ${Object.values(errors).join(', ')}`
    );
  }

  // If the user is moving the contact to a different account, sanity-check
  // that the target account exists so the FK error is friendly.
  if (value.account_id !== before.account_id) {
    const target = await one(env.DB, 'SELECT id FROM accounts WHERE id = ?', [value.account_id]);
    if (!target) {
      return redirectWithFlash(
        `/contacts/${contactId}`,
        'Account not found'
      );
    }
  }

  const ts = now();
  const after = { ...value };
  const changes = diff(before, after, FIELDS);

  const statements = [];

  // Clear any other primary on the (possibly new) account if this one is
  // being promoted. Demote on the old account too if we're moving away.
  if (value.is_primary) {
    statements.push(
      stmt(
        env.DB,
        `UPDATE contacts SET is_primary = 0, updated_at = ?
          WHERE account_id = ? AND id != ? AND is_primary = 1`,
        [ts, value.account_id, contactId]
      )
    );
  }

  statements.push(
    stmt(
      env.DB,
      `UPDATE contacts
          SET account_id = ?, first_name = ?, last_name = ?, title = ?,
              email = ?, phone = ?, mobile = ?, is_primary = ?,
              notes = ?, updated_at = ?
        WHERE id = ?`,
      [
        value.account_id,
        value.first_name,
        value.last_name,
        value.title,
        value.email,
        value.phone,
        value.mobile,
        value.is_primary,
        value.notes,
        ts,
        contactId,
      ]
    )
  );

  const displayName = [value.first_name, value.last_name].filter(Boolean).join(' ') || '(no name)';
  if (changes) {
    statements.push(
      auditStmt(env.DB, {
        entityType: 'contact',
        entityId: contactId,
        eventType: 'updated',
        user,
        summary: `Updated contact "${displayName}"`,
        changes,
      })
    );
  }

  await batch(env.DB, statements);

  return redirectWithFlash(
    `/accounts/${value.account_id}`,
    `Contact "${displayName}" updated.`
  );
}
