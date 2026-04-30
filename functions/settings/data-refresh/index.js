// functions/settings/data-refresh/index.js
//
// GET  /settings/data-refresh — admin page with two paste-boxes
//   (account IDs to keep, opportunity IDs to keep) plus Preview
//   and Run buttons. Both buttons call sibling POST routes.
//
// Read-only on this route. Destructive action lives in
// /settings/data-refresh/execute, which requires a typed confirm.

import { layout, htmlResponse, html, escape } from '../../lib/layout.js';
import { readFlash } from '../../lib/http.js';
import { hasRole } from '../../lib/auth.js';
import { settingsSubNav } from '../../lib/settings-subnav.js';

export async function onRequestGet(context) {
  const { data, request } = context;
  const user = data?.user;
  if (!user) return new Response('Sign in required', { status: 401 });
  if (!hasRole(user, 'admin')) {
    return htmlResponse(layout('Data refresh',
      '<section class="card"><h1>Data refresh</h1><p>Admin only.</p></section>',
      { user }), { status: 403 });
  }

  const url = new URL(request.url);

  const body = html`
    ${settingsSubNav('data-refresh', true)}

    <section class="card" style="margin-top:1rem">
      <div class="card-header">
        <h1>Data refresh</h1>
      </div>
      <p class="muted" style="margin-top:0">
        Paste the IDs of the accounts and opportunities you want to
        keep. Everything else (in those two tables, plus their
        cascading children — quotes, jobs, change orders, line items,
        activities, documents, cost builds, contacts, addresses) gets
        deleted. System tables (users, settings, audit history,
        templates, fake names, AI Inbox) are untouched.
      </p>
      <p style="background:#fff8c5;border:1px solid #d4a72c;padding:0.5rem 0.7rem;border-radius:var(--radius);font-size:0.9em">
        <strong>Take a backup first.</strong> Run this from a terminal
        in the repo to snapshot the prod DB to a SQL file:
        <br>
        <code style="background:rgba(0,0,0,0.05);padding:0.1rem 0.3rem;border-radius:3px">npx wrangler d1 export c-lars-pms-db --remote --output=backup-${escape(new Date().toISOString().slice(0,10))}.sql</code>
        <br>
        The Run button in this UI does not take a backup for you.
      </p>

      <form id="refresh-form" style="margin-top:1rem">
        <label style="display:block;margin-bottom:0.6rem">
          <span style="display:block;font-weight:600;margin-bottom:0.2rem">Keep these account IDs</span>
          <span class="muted" style="display:block;font-size:0.82rem;margin-bottom:0.3rem">
            One per line, or comma-separated. The parent accounts of any kept opps below are auto-added — you don't have to repeat them here.
          </span>
          <textarea name="keep_account_ids" rows="6" style="width:100%;font-family:monospace;font-size:0.9rem;padding:0.5rem;border:1px solid var(--border);border-radius:4px"
            placeholder="e.g.&#10;5b3a8e1c-...&#10;d2f1c9a4-...&#10;7e0f2-..."></textarea>
        </label>

        <label style="display:block;margin-bottom:0.6rem">
          <span style="display:block;font-weight:600;margin-bottom:0.2rem">Keep these opportunity IDs</span>
          <span class="muted" style="display:block;font-size:0.82rem;margin-bottom:0.3rem">
            One per line, or comma-separated. Each kept opp brings its quotes / jobs / line items / activities / docs along automatically.
          </span>
          <textarea name="keep_opp_ids" rows="6" style="width:100%;font-family:monospace;font-size:0.9rem;padding:0.5rem;border:1px solid var(--border);border-radius:4px"
            placeholder="e.g.&#10;a1b2c3-...&#10;9e8d7-..."></textarea>
        </label>

        <div style="display:flex;gap:0.5rem;margin-top:0.5rem;flex-wrap:wrap">
          <button type="button" id="preview-btn" class="btn">Preview deletion</button>
          <button type="button" id="run-btn" class="btn danger" disabled>Run deletion</button>
        </div>
      </form>

      <div id="preview-out" style="margin-top:1rem"></div>
      <div id="run-out" style="margin-top:1rem"></div>
    </section>

    <script>
    (function () {
      var form = document.getElementById('refresh-form');
      var previewBtn = document.getElementById('preview-btn');
      var runBtn = document.getElementById('run-btn');
      var previewOut = document.getElementById('preview-out');
      var runOut = document.getElementById('run-out');
      var lastPlan = null;

      function gatherInput() {
        return {
          keep_account_ids: form.keep_account_ids.value || '',
          keep_opp_ids: form.keep_opp_ids.value || '',
        };
      }

      previewBtn.addEventListener('click', function () {
        previewOut.innerHTML = '<p class="muted">Computing…</p>';
        runBtn.disabled = true;
        lastPlan = null;
        fetch('/settings/data-refresh/preview', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(gatherInput()),
        }).then(function (r) { return r.json(); }).then(function (j) {
          if (!j.ok) {
            previewOut.innerHTML = '<p style="color:#cf222e">Preview failed: ' + (j.error || 'unknown') + '</p>';
            return;
          }
          lastPlan = j.plan;
          renderPreview(j.plan);
          // Only enable Run if there's actually something to delete and
          // no missing IDs were flagged.
          var anyMissing = (j.plan.missingAccountIds.length + j.plan.missingOppIds.length) > 0;
          var anyDeletes = (j.plan.deleteAccountIds.length + j.plan.deleteOppIds.length) > 0;
          runBtn.disabled = anyMissing || !anyDeletes;
        }).catch(function (err) {
          previewOut.innerHTML = '<p style="color:#cf222e">Preview failed: ' + (err && err.message || 'network error') + '</p>';
        });
      });

      runBtn.addEventListener('click', function () {
        if (!lastPlan) { alert('Run Preview first.'); return; }
        var msg = 'This will permanently delete:'
          + '\\n  ' + lastPlan.deleteAccountIds.length + ' account(s)'
          + '\\n  ' + lastPlan.deleteOppIds.length + ' opportunit(ies)'
          + '\\n  ' + lastPlan.deleteJobIds.length + ' job(s)'
          + '\\n  ' + lastPlan.deleteCoIds.length + ' change order(s)'
          + '\\n  + cascading children (quotes, line items, activities, docs, contacts, addresses)'
          + '\\n\\nHave you taken a backup with `wrangler d1 export`?';
        if (!confirm(msg)) return;
        var phrase = prompt('Type DELETE EVERYTHING NOT KEPT to confirm:');
        if (phrase !== 'DELETE EVERYTHING NOT KEPT') {
          alert('Cancelled.');
          return;
        }
        runOut.innerHTML = '<p class="muted">Running…</p>';
        runBtn.disabled = true;
        fetch('/settings/data-refresh/execute', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(Object.assign({}, gatherInput(), { confirm: 'DELETE EVERYTHING NOT KEPT' })),
        }).then(function (r) { return r.json(); }).then(function (j) {
          if (!j.ok) {
            runOut.innerHTML = '<p style="color:#cf222e">Run failed: ' + (j.error || 'unknown') + '</p>';
            runBtn.disabled = false;
            return;
          }
          runOut.innerHTML = '<p style="color:#1a7f37"><strong>Done.</strong> Deleted ' + j.deleted_count + ' rows total. ' +
            '<a href="/accounts">Go to Accounts</a> &middot; <a href="/opportunities">Go to Opportunities</a></p>';
        }).catch(function (err) {
          runOut.innerHTML = '<p style="color:#cf222e">Run failed: ' + (err && err.message || 'network error') + '</p>';
          runBtn.disabled = false;
        });
      });

      function renderPreview(plan) {
        function pluralize(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }
        var html = '<div style="border:1px solid var(--border);border-radius:var(--radius);padding:0.75rem 1rem;background:var(--bg-alt)">';
        html += '<h2 style="margin-top:0">Preview</h2>';

        if (plan.missingAccountIds.length || plan.missingOppIds.length) {
          html += '<p style="color:#cf222e"><strong>⚠ Some IDs in your keep-list don\\'t exist in the database. Fix these before running:</strong></p>';
          if (plan.missingAccountIds.length) {
            html += '<p style="font-size:0.85em">Missing account IDs: <code>' + plan.missingAccountIds.join(', ') + '</code></p>';
          }
          if (plan.missingOppIds.length) {
            html += '<p style="font-size:0.85em">Missing opportunity IDs: <code>' + plan.missingOppIds.join(', ') + '</code></p>';
          }
        }

        html += '<p><strong>Keeping</strong>: ' +
          pluralize(plan.extendedKeepAccountIds.length, 'account') +
          (plan.autoKeptAccountCount > 0
            ? ' <span class="muted" style="font-size:0.85em">(' + plan.autoKeptAccountCount + ' auto-added as parents of kept opps)</span>'
            : '') +
          ' &middot; ' + pluralize(plan.keepOppIds.length, 'opportunity') + '</p>';

        html += '<p><strong>Deleting</strong>:</p>';
        html += '<ul style="font-size:0.9em">';
        html += '<li>' + pluralize(plan.deleteAccountIds.length, 'account') + '</li>';
        html += '<li>' + pluralize(plan.deleteOppIds.length, 'opportunity') + '</li>';
        html += '<li>' + pluralize(plan.deleteJobIds.length, 'job') + '</li>';
        html += '<li>' + pluralize(plan.deleteCoIds.length, 'change order') + '</li>';
        html += '</ul>';

        var c = plan.cascadeCounts;
        var totalCascade = c.quotes + c.quote_lines + c.cost_builds + c.activities + c.documents + c.contacts + c.account_addresses;
        if (totalCascade > 0) {
          html += '<p><strong>Plus cascading children (FK CASCADE — auto-deleted)</strong>:</p>';
          html += '<ul style="font-size:0.9em">';
          if (c.quotes)            html += '<li>' + pluralize(c.quotes, 'quote') + '</li>';
          if (c.quote_lines)       html += '<li>' + pluralize(c.quote_lines, 'quote line') + '</li>';
          if (c.cost_builds)       html += '<li>' + pluralize(c.cost_builds, 'cost build') + '</li>';
          if (c.activities)        html += '<li>' + pluralize(c.activities, 'activity / task') + '</li>';
          if (c.documents)         html += '<li>' + pluralize(c.documents, 'document') + '</li>';
          if (c.contacts)          html += '<li>' + pluralize(c.contacts, 'contact') + '</li>';
          if (c.account_addresses) html += '<li>' + pluralize(c.account_addresses, 'account address') + '</li>';
          html += '</ul>';
        }
        html += '</div>';
        previewOut.innerHTML = html;
      }
    })();
    </script>
  `;

  return htmlResponse(layout('Data refresh', body, {
    user, activeNav: '/settings',
    flash: readFlash(url),
    breadcrumbs: [{ label: 'Settings', href: '/settings' }, { label: 'Data refresh' }],
  }));
}
